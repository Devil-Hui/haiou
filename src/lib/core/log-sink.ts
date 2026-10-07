// ---------------------------------------------------------------------------
// 日志落盘：按类别分目录，各自独立保留期。
//
// 为什么不能只靠 journald：
//   1. journald 会轮转，历史排障（订单半年前到底发生了什么）查不到；
//   2. 审计与支付回调原文需要**长期留存**作为举证材料，和运行日志的保留诉求完全不同；
//   3. 2C2G 小盘上必须能精确控制"哪类日志可以丢、哪类绝不能丢"。
//
// 目录结构：
//   logs/app/      运行日志，按天轮转，保留 14 天
//   logs/error/    仅 error 级，保留 30 天（告警数据源）
//   logs/audit/    资金与权限变更，保留 365 天（举证与对账依据）
//   logs/payment/  支付回调原文，保留 180 天（dispute 时逐字比对）
//
// 三条硬约束：
//   1. 写盘前脱敏。落盘的文件会被备份、被运维拷走，签名与密钥一旦写进去
//      就等于二次泄露。实际由 logger 里的行级 redact() 负责（字段此时已拼成
//      字符串，逐字段处理反而更易漏）。
//   2. 永不抛错。日志设施出问题不能影响业务，必须吞掉并降级到 stdout。
//   3. 追加写、不阻塞。同步 writeFileSync 会拖慢事件循环，
//      在支付回调这种热路径上是不可接受的。
// 保留期：本模块只负责写，不负责删。裸机时代靠宿主机 logrotate（已随裸机部署移除）；
// 容器化部署下 HAIOU_LOG_DIR 指向应用数据卷，保留策略由运维按 compose 挂载决定。
// ---------------------------------------------------------------------------
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type LogCategory = "app" | "error" | "audit" | "payment";

/** 目录名与日志级别阈值。error 单独成类，便于接告警。 */
const ROUTES: Record<LogCategory, { min: number }> = {
  app: { min: 0 },
  error: { min: 40 },
  audit: { min: 0 },
  payment: { min: 0 },
};

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function root(): string {
  // 默认落在项目下的 logs/。生产用环境变量指到 /var/log/haiou 之类的独立分区，
  // 这样日志写满不会连带把数据库所在盘一起占满。
  return process.env.HAIOU_LOG_DIR || join(process.cwd(), "logs");
}

let dirReady: Promise<void> | null = null;
function ensureDir(category: LogCategory): Promise<void> {
  if (!dirReady) {
    const dirs = Object.keys(ROUTES) as LogCategory[];
    // 把本次的 Promise 存进局部变量：失败回调里只清"自己那一个"，
    // 否则并发写入可能已经建立了新Promise，被后来者误清成 null 而无限重建。
    const attempt: Promise<void> = Promise.all(dirs.map((c) => mkdir(join(root(), c), { recursive: true })))
      .then(() => undefined)
      .catch(() => {
        // 失败必须把缓存清掉。此前这里只 `.catch(() => undefined)` 吞掉异常，
        // 于是首个 mkdir 失败（磁盘满、权限不足、并发启动抢跑）之后，
        // dirReady 永远是一个「已兑现的空 Promise」，整个进程内日志再也不落盘，
        // 且没有任何告警——排障时才发现"日志文件是空的"，而故障早已发生。
        // 置回 null 让下一次写入重试 mkdir：目录是持久的，重试成功率很高。
        if (dirReady === attempt) dirReady = null;
      });
    dirReady = attempt;
  }
  return dirReady;
}

/** 按天轮转：文件名带日期，无需维护"上次写入是哪天"的状态。 */
function fileFor(category: LogCategory, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return join(root(), category, category + "-" + day + ".log");
}

/**
 * 追加一行到对应类别的文件。
 *
 * 刻意不 await 到调用方：日志写入不该拖慢业务。这里 catch 掉一切，
 * 写失败时退回 stderr，保证"日志系统挂了"这件事本身不会变成故障。
 */
export function writeLine(category: LogCategory, level: string, line: string): void {
  try {
    if (LEVELS[level] < ROUTES[category].min) return;
    const now = new Date();
    void ensureDir(category)
      .then(() => appendFile(fileFor(category, now), line + "\n", "utf8"))
      .catch((error) => { process.stderr.write("[logger] 落盘失败 " + String(error) + "\n"); });
  } catch (error) {
    process.stderr.write("[logger] " + String(error) + "\n");
  }
}
