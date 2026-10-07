export type ApiError = Error & { code?: string; status?: number; retryAfterSec?: number };

export async function api<T = Record<string, unknown>>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers }, cache: "no-store" });
  const data = await response.json().catch(() => ({ error: "服务暂时不可用，请稍后重试" }));
  if (!response.ok) {
    // 把后端带回来的 code 挂在 Error 上。此前只丢 message，调用方拿不到 code，
    // 于是后端精心区分的语义（AUTH_INVALID / VALIDATION_FAILED / SOLD_OUT …）
    // 在前端全貌化成一句 message，界面上无法据此走分支（比如"售罄"该引导换套餐，
    // "券码已用尽"该引导换券，而不是让买家反复重试同一个错误）。
    const err = new Error(data.error || "操作失败，请稍后重试") as ApiError;
    err.code = typeof data.code === "string" ? data.code : undefined;
    err.status = response.status;
    // 429：读取服务端 Retry-After（RFC 6585；后端已在 apiError / admin bad / recharge fail 统一注入）。
    // 与官方一致——客户端应在此窗口内不重试，而不是立即硬顶。挂到 err 上，errorMessage() 据此
    // 给出带秒数的友好提示，避免"到底要等多久"的困惑。
    if (response.status === 429) {
      const raw = response.headers.get("Retry-After") || response.headers.get("retry-after");
      const sec = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(sec) && sec > 0) err.retryAfterSec = sec;
    }
    throw err;
  }
  return data as T;
}
export type RecentOrder = {
  id: string;
  code: string;
  planName: string;
  brand: string;
  createdAt: string;
  /**
   * 一次性取卡码。**只在创建订单成功的那一次响应里出现**，服务端仅保留
   * sha256 摘要，之后无法再取出。因此前端必须立刻存进 localStorage ——
   * 否则买家刷新一次就永远取不到卡密。
   *
   * 它不会随 saveRecent 一起被长期留存：saveRecent 存进 recent 列表时应当
   * 剔除该字段（见 saveRecent），避免在 localStorage 里长期留一份凭据。
   */
  deliveryToken?: string;
};
export function saveRecent(order: RecentOrder) {
  // 取卡码单独存（saveDeliveryToken），**不**放进 recent 列表：
  // recent 列表会在浏览器里留很久，而取卡码是等同卡密的高价值凭据，
  // 不该在多处冗余留存。它只按订单号存一份，取用时按订单号取。
  const { deliveryToken: _omit, ...rest } = order;
  try {
    const recent = getRecent().filter(item => item.id !== order.id);
    localStorage.setItem("aura_recent_orders", JSON.stringify([rest, ...recent].slice(0, 6)));
  } catch { /* 隐私模式下写不进去 */ }
}
export function getRecent(): RecentOrder[] {
  try { const value = JSON.parse(localStorage.getItem("aura_recent_orders") || "[]"); return Array.isArray(value) ? value.filter(item => item && typeof item.id === "string" && typeof item.code === "string").slice(0, 6) : []; } catch { return []; }
}
export const errorMessage = (error: unknown) => {
  if (error instanceof Error) {
    // 429 限流：后端固定窗口默认 Retry-After 近 60s，给用户一个可操作的提示，
    // 而不是笼统的"操作失败"。与官方（Stripe/GitHub client 处理 429）口径一致。
    const apiErr = error as ApiError;
    if (apiErr.status === 429 && apiErr.retryAfterSec && apiErr.retryAfterSec > 0) {
      return `${error.message}（限流，约 ${apiErr.retryAfterSec} 秒后可重试）`;
    }
    return error.message;
  }
  return "请求失败，请稍后重试";
};
export const formatDate = (value: string | Date) => new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

// ---------------------------------------------------------------------------
// 一次性取卡码的本地存取
//
// 取卡码是买家取卡密的唯一凭证（服务端只存 sha256 摘要，无法找回）。它在下单
// 成功时展示一次，因此**必须由前端落盘**，否则买家刷新一次就永远取不到卡了。
//
// 为什么不用登录态代替：本站注册无邮箱所有权验证，"登录邮箱匹配"挡不住
// 注册了他人邮箱的冒领者。取卡码是唯一拿不到的那一份信息。
//
// 存哪：按订单号存，便于买家在"订单查询"页输入订单号后仍能取卡。
// 何时删：订单进入终态后即可清除，但它只在浏览器本地、不构成风险，留着
// 反而方便买家回头再看；因此**不自动删除**，改由买家自行清缓存。
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "aura_delivery_token_";

export function saveDeliveryToken(orderCode: string, token: string): void {
  if (!orderCode || !token) return;
  try { localStorage.setItem(TOKEN_PREFIX + orderCode, token); } catch { /* 隐私模式下写不进去 */ }
}

export function getDeliveryToken(orderCode: string): string {
  if (!orderCode) return "";
  try { return localStorage.getItem(TOKEN_PREFIX + orderCode) || ""; } catch { return ""; }
}

// ---------------------------------------------------------------------------
// 取卡密码的跨页交接
//
// 【绝不能再走 URL】此前订单查询页把取卡密码拼进链接：
//   /orders/<id>/result?pw=<取卡密码>
// URL 会被写进浏览器历史、会被 Nginx 记进 access.log、会随 Referer 发给第三方、
// 会出现在买家随手截的图里——而取卡密码是**账号级**凭据，凭它能查回该邮箱的
// 全部历史订单并领卡。这是本项目自己写下的「凭证不进 URL」禁令的直接违反。
//
// 改用 sessionStorage：只在当前标签页内有效，关掉即失效，不进历史、不进日志、
// 不进 Referer。这与"取卡码存 localStorage"并不矛盾——取卡码是**一次性**的
// （库中只有摘要、展示一次），而取卡密码是**长期有效**的账号级凭据，后者才需要
// 更保守的容器。
// ---------------------------------------------------------------------------

const PW_PREFIX = "aura_order_password_";

export function saveOrderPassword(orderId: string, password: string): void {
  if (!orderId || !password) return;
  try { sessionStorage.setItem(PW_PREFIX + orderId, password); } catch { /* 隐私模式下写不进去 */ }
}

export function getOrderPassword(orderId: string): string {
  if (!orderId) return "";
  try { return sessionStorage.getItem(PW_PREFIX + orderId) || ""; } catch { return ""; }
}
