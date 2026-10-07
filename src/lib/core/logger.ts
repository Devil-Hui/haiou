import { writeLine } from "./log-sink";

// 结构化日志。
//
// 规范（调用方遵守，格式细节收敛在这里）：
//   1. 一行一条事件，字段用 key=value，便于 journald 采集与 grep。
//   2. 每个事件必须有稳定的 event 名（如 order.status_changed），字段随事件增补；
//      不要把一整句话塞进 message——那是无法聚合的 unstructured 日志。
//   3. 级别只表达「是否需要人介入」：error=需要排查，warn=降级/风险，info=常规事实。
//   4. category=audit 的事件涉及资金或权限变更（订单状态、支付配置、卡密、登录），
//      这类必须落审计，字段里只放可追溯的事实。
//   5. 密钥、口令、令牌、卡密明文、私钥一律不记录；需要标识主体时用脱敏值。
//
// 环境变量 AURA_LOG_LEVEL 可调级别（debug|info|warn|error），默认 info。
//
// 落盘：同时写 stdout（供 journald/systemd 采集）与按类别分层的文件。
// 两份都要有——stdout 便于 tail -f 与容器采集，文件便于长期留存与按类排查。
// 目录结构与保留期见 ./log-sink.ts 的头部说明。

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, string | number | boolean | null | undefined>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.AURA_LOG_LEVEL || "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

// 值里可能带空格（套餐名、错误信息），加引号保证一行一条、可被简单解析器还原。
function fmtValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const text = typeof value === "string" ? value : String(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function emit(level: LogLevel, category: "app" | "audit" | "payment", event: string, fields?: Fields, err?: unknown) {
  if (LEVELS[level] < threshold()) return;
  const parts = [new Date().toISOString(), `level=${level}`, `category=${category}`, `event=${event}`];
  for (const [key, value] of Object.entries(fields ?? {})) {
    // err 只允许一个来源：显式传入的异常优先，避免同一行出现两个 err= 让解析器歧义。
    if (key === "err" && err !== undefined) continue;
    parts.push(`${key}=${fmtValue(value)}`);
  }
  if (err instanceof Error) {
    parts.push(`err=${fmtValue(err.message)}`);
    if (level === "error" && err.stack) {
      parts.push(`stack=${fmtValue(err.stack.split("\n").slice(0, 4).join(" | "))}`);
    }
  } else if (err !== undefined) {
    parts.push(`err=${fmtValue(String(err))}`);
  }
  const line = parts.join(" ");
  // stdout 与落盘统一脱敏：journald / 容器日志同样会被备份与外发，只脱敏文件是不够的。
  const safe = redact(line);
  if (level === "error" || level === "warn") console.error(safe);
  else console.log(safe);

  // 落盘。app 级按级别再分流：只有 error 进 logs/error/，
  // 这样「需要人介入」的日志可单独接告警，不用从海量 info 里筛。
  const target: "app" | "error" | "audit" | "payment" = category === "app" && level === "error" ? "error" : category;
  writeLine(target, level, safe);
}

/**
 * 落盘前的最后一道脱敏。
 * emit 里已经过滤掉与 err 重复的 sign 类字段，但行内仍可能出现
 * 形如 sign=abc123 的片段（来自错误信息本身）。这里做一次文本级兜底，
 * 宁可多脱一点，也不能让签名类内容落进会被备份的文件。
 *
 * 【关键词表覆盖充值链路】
 * `session` 与 `cdk` 是自动充值链路上游提交体的字段名
 * （见 upstream/aisub.ts 的 `{ cdk, session }`），与买家的账号凭证等价。
 * 原表只列了 sign/token/secret 一类，一次误打 `session=eyJ...` 就会
 * 明文落进 logs/ 并随备份流转——而这两个字段恰好是全站最敏感的数据。
 * **新增任何"会传给第三方的凭据"字段时，必须同步加进这个表。**
 *
 * 【为什么关键词两边都要允许前后缀】
 * 原正则写作 `\b(password)=`：`\b` 要求前面是非单词字符，于是
 * `cardPassword=xxx`、`deliveryToken=xxx`、`X-Session: xxx` 全部漏网——
 * 而这几个恰恰是本系统里最敏感的三个字段（取卡密码哈希的输入、一次性取卡码、
 * 买家的账号登录态）。日志是会被备份、被外发、被贴到工单里的，
 * 漏一个字段名就等于把一类凭据整体暴露。
 *
 * 【为什么还要按"值的形状"再兜一层】
 * 关键词表只能覆盖**已知**字段名。买家的账号登录态是 JWT，形状高度特征化
 * （`eyJ....eyJ....签名`），无论它藏在哪个字段、哪一句堆栈里都该被抹掉。
 * 这两层是互补的：关键词管"叫什么"，形状管"长什么样"。
 */
const SENSITIVE_CORE = "sign|signature|token|secret|api[_-]?key|private[_-]?key|password|passwd|pwd|session|cdk|card|credential|cookie|authorization";

/**
 * 字段名：允许 camelCase / snake_case / kebab-case 的组成部分。
 * 例：`cardPassword`、`delivery_token`、`X-Session`、`apiKey` 全部命中。
 * 后置的 `"?'?` 允许 JSON 形式的 `"deliveryTokenHash": "..."`（栈堆里常出现）。
 */
const SENSITIVE_NAME = `[\\w.-]*(?:${SENSITIVE_CORE})[\\w.-]*["']?`;

// 覆盖两种常见形态：
//   1. `key=value`（本项目的日志格式）
//   2. `"key": value` 或 `'key': value`（Error.stack / 被 JSON.stringify 的原始报文）
// 分隔符允许两侧各有可选的引号与空白，避免 `"deliveryTokenHash": "..."`
// 因键后紧跟一个 `"` 而漏掉——那是真实存在过的遗漏（见上方注释）。
const REDACT_RE = new RegExp(
  `("?${SENSITIVE_NAME})("?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;}]*)`,
  "gi",
);

// JWT：header.payload.signature，三段都是 base64url。
// 覆盖不到"被截断的"或"无签名段的"，但那两种本身也不可用，风险可忽略。
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;

function redact(line: string): string {
  return line
    .replace(REDACT_RE, (_match, name: string, sep: string) => `${name}${sep}[redacted]`)
    .replace(JWT_RE, "[redacted-jwt]");
}

export const logger = {
  /** 资金或权限相关的事实：订单状态、支付配置、卡密、登录。落审计，可 grep。 */
  audit: (event: string, fields?: Fields) => emit("info", "audit", event, fields),
  debug: (event: string, fields?: Fields) => emit("debug", "app", event, fields),
  info: (event: string, fields?: Fields) => emit("info", "app", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", "app", event, fields),
  error: (event: string, fields?: Fields, err?: unknown) => emit("error", "app", event, fields, err),
  /**
   * 支付回调原文。单独成类是为了单独设保留期（180 天）——
   * dispute 时需要拿它与网关记录逐字比对，混在运行日志里会被轮转掉。
   */
  payment: (event: string, fields?: Fields) => emit("info", "payment", event, fields),
};
