// ---------------------------------------------------------------------------
// 错误码与响应形态
//
// 改造前的问题（22 个路由、133 处错误响应）：
//   1. 只有中文文案，没有机器可读码。前端要分支只能 match 中文句子，
//      改一次文案就静默失效——这类 bug 极难发现，因为不报错，只是行为变了。
//   2. 响应形态两套并存：一处 {error: "文案"}，另一处 {error: {...}}。
//   3. 没有 traceId。用户发来一张报错截图，客服无法把它对应到具体日志行，
//      只能靠时间戳猜——2C2G 上日志量大时基本等于无法排查。
//
// 本模块提供三样东西：
//   · ErrorCode 枚举：稳定的机器可读码，语义与文案解耦
//   · traceId：每个请求一个，出现在响应与日志里，两边可对齐
//   · apiError()：统一构造错误响应
//
// 向后兼容：响应里保留 error 字符串字段，只是**新增** code 与 traceId，
// 现有前端读 error 的逻辑不受影响，不需要同步改动。
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import { json } from "./http";

/**
 * 错误码命名规则：CATEGORY_REASON。
 *
 * 分类前缀让前端能先按大类分支（要不要弹登录框、要不要提示稍后重试），
 * 原因后缀让排查能精确定位。二者都稳定，不随文案变化。
 *
 * 【选码纪律 —— 这条比枚举本身重要】
 *
 * 1. 凭据不对（取卡码错、密码错、令牌失效）→ 一律 `AUTH_INVALID`。
 *    **不要**用 `VALIDATION_FAILED`：那是"请求体不合法"，语义完全不同。
 *    也不要在这里用 `FORBIDDEN_ROLE`（见下）。
 * 2. `FORBIDDEN_ROLE` 专指 RBAC 场景的角色权限不足。本项目目前**没有角色体系**，
 *    因此它暂无任何使用点，是为将来引入"管理员/普通用户"分层预留的。
 *    在那之前，任何权限拒绝都应落`AUTH_INVALID`（凭据）或
 *    `FORBIDDEN_ORIGIN`（来源/CSRF），而不是它。
 * 3. 状态码用 `CODE_STATUS` 的默认值，除非该接口有历史约定需要保持
 *    （如 webhook 保持 501/410）。对外 HTTP 状态不因换码而改变。
 */
export const ErrorCode = {
  // 认证与授权
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_INVALID: "AUTH_INVALID",
  FORBIDDEN_ORIGIN: "FORBIDDEN_ORIGIN",
  FORBIDDEN_ROLE: "FORBIDDEN_ROLE",

  // 请求本身
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // 状态冲突
  CONFLICT_STATE: "CONFLICT_STATE",
  ORDER_NOT_PAID: "ORDER_NOT_PAID",
  ALREADY_SUBMITTED: "ALREADY_SUBMITTED",
  SOLD_OUT: "SOLD_OUT",
  NO_STOCK: "NO_STOCK",

  // 限流
  RATE_LIMITED: "RATE_LIMITED",

  // 业务开关与外部依赖
  STORE_CLOSED: "STORE_CLOSED",
  UPSTREAM_DISABLED: "UPSTREAM_DISABLED",
  UPSTREAM_FAILED: "UPSTREAM_FAILED",
  NOT_CONFIGURED: "NOT_CONFIGURED",

  // 兜底
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 → 默认 HTTP 状态。调用方可覆盖，但默认值保证同类错误的语义一致。 */
export const CODE_STATUS: Record<ErrorCodeValue, number> = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  FORBIDDEN_ORIGIN: 403,
  FORBIDDEN_ROLE: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  CONFLICT_STATE: 409,
  ORDER_NOT_PAID: 422,
  ALREADY_SUBMITTED: 409,
  SOLD_OUT: 409,
  NO_STOCK: 409,
  RATE_LIMITED: 429,
  STORE_CLOSED: 503,
  UPSTREAM_DISABLED: 503,
  UPSTREAM_FAILED: 502,
  NOT_CONFIGURED: 503,
  INTERNAL: 500,
};

/**
 * 当前请求的 traceId。
 *
 * 此前这里是一个模块级变量 `let current`，进程内**永不重置**：模块一旦被加载，
 * 首个请求生成 id 后，之后所有请求（乃至所有用户）拿到的都是同一个值。
 * 那种情况下"用户截图里的 traceId"根本对齐不到任何一行日志——功能等于不存在，
 * 而且比没有更糟：它看起来能用，排查时会把人引向错误的行。
 *
 * 现在每次调用生成一个新值。代价是**同一个响应内必须只调用一次并复用**
 * （响应体与 X-Trace-Id 头要指向同一个 id），因此 fail / apiError / apiOk
 * 都已改为先取一次再复用。
 *
 * 为什么不用 AsyncLocalStorage 做真正的"每请求一个"：Next.js 的 middleware
 * 跑在 Edge runtime，它的 AsyncLocalStorage 不会传播进 Node 侧的 route
 * handler，跨运行时上下文在这里不成立；而在每个路由里手工包一层又会污染
 * 全部 20+ 个路由文件的签名。按响应取值已能保证"一个响应 = 一个可追溯的
 * id"，这正是这个字段的用途。
 *
 * 若将来确实需要把一次请求内的多处日志串起来，应改为在 Node 层中间件
 * （instrumentation hook）里建立上下文，而不是在这里缓存全局变量。
 */
export function traceId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * 构造统一的错误响应。
 *
 * @param code    机器可读码，稳定的分支依据
 * @param message 面向用户的中文文案（可改，不会破坏前端逻辑）
 * @param status  覆盖默认状态码；不传则用 CODE_STATUS 里的标准值
 * @param headers 额外响应头。**禁缓存不是靠它**——底层 json() 已无条件注入
 *                Cache-Control: no-store，这里传同名字段只会覆盖成别的值。
 *                因此仅在需要追加非缓存类头（如 CDN-Cache-Control）时才传。
 */
export function apiError(
  code: ErrorCodeValue,
  message: string,
  status?: number,
  headers: Record<string, string> = {},
) {
  // 只取一次：响应体与 X-Trace-Id 头必须指向同一个 id，否则两边对不上，
  // 比"未响应"更容易让人误解。
  const id = traceId();
  const outStatus = status ?? CODE_STATUS[code];
  // 限流响应统一带 Retry-After（RFC 6585 + IETF rate-limit 草案；GitHub、Stripe、
  // Cloudflare 的 429 均带此头），让客户端/网关知道最早可重试时刻，避免裸 429
  // 被立即无限重试。固定窗口是就近开窗口，最早重置点为当前窗口结束，取 60s
  // （默认窗口 1 分钟）是业界通行的保守近似。调用方如需传递 real 剩余秒数，
  // 显式传 Retry-After 覆盖即可。
  const finalHeaders =
    outStatus === 429 && !headers["Retry-After"] && !headers["retry-after"]
      ? { "Retry-After": "60", ...headers }
      : headers;
  return json(
    { error: message, code, traceId: id },
    { status: outStatus, headers: { "X-Trace-Id": id, ...finalHeaders } },
  );
}

/**
 * 成功响应也带上 traceId。
 * 用户截图里的成功记录同样需要能与日志对齐——排查"钱扣了但没到账"时，
 * 光有失败 traceId 不够，成功那一步的 traceId 才是关键。
 */
export function apiOk(data: unknown, status = 200) {
  const id = traceId();
  return json({ ...(data as object), traceId: id }, { status, headers: { "X-Trace-Id": id } });
}
