import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { admins, users } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { logger } from "@/lib/core";
import { digest } from "./password";

// Credential primitives live in one Next-free module and are re-exported here so the
// existing `@/lib/auth` imports across routes and scripts keep working.
export * from "./password";

export const SESSION_COOKIE = "haiou_admin";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export async function currentAdmin() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const [admin] = await db.select({ id: admins.id, username: admins.username }).from(admins).where(and(eq(admins.sessionHash, digest(token)), gt(admins.sessionExpires, new Date())));
  return admin ?? null;
}

// ---- 普通用户会话 ----
// 与管理员会话完全独立：独立 Cookie（haiou_user）、独立表（users）、独立有效期。
// 放在这里而不是各自在路由里读，是为了让服务端组件（个人中心）与 API 用同一套判定，
// 不会出现"页面认为已登录、接口认为未登录"的割裂。
export const USER_COOKIE = "haiou_user";
export async function currentUser() {
  const token = (await cookies()).get(USER_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.sessionHash, digest(token)), gt(users.sessionExpires, new Date())));
  return user ?? null;
}

const sessionCookie = (expires: Date) => ({
  httpOnly: true,  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  expires,
});

export async function createSession(id: number) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await db.update(admins).set({ sessionHash: digest(token), sessionExpires: expires }).where(eq(admins.id, id));
  (await cookies()).set(SESSION_COOKIE, token, sessionCookie(expires));
}

// Revoke the stored session and clear the cookie even when it has already expired.
export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.update(admins).set({ sessionHash: null, sessionExpires: null }).where(eq(admins.sessionHash, digest(token)));
  store.set(SESSION_COOKIE, "", { ...sessionCookie(new Date(0)), maxAge: 0 });
}

// Browser write protection: reject explicitly cross-site requests via Fetch Metadata,
// then fall back to comparing Origin against the forwarded host.
export function sameOrigin(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0].trim();
  if (!host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

// Client identity used for throttling. Only hops written by trusted proxies are read, so a
// caller cannot rotate buckets by forging X-Forwarded-For. TRUSTED_PROXY_HOPS counts the
// proxies in front of the app (default 1 = the nearest one). The failure modes are not
// symmetric: too small merges callers into one stricter bucket, too large walks the reading
// back onto caller-supplied entries. Only raise it for a proxy chain you actually run.
//
// 0 是有意义的取值：应用直接对外、前面一个可信代理都没有。此时整条 X-Forwarded-For 都由
// 调用方自己书写，任何一个字节都可以换一个新桶，因此该取值下 XFF 被完全丢弃，只走兜底。
const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
const TRUSTED_HOPS = Number.isFinite(hops) ? Math.min(5, Math.max(0, hops)) : 1;

// 只接受形状合法的 IPv4 / IPv6 字面量。旧的 /^[0-9a-fA-F:.]{3,45}$/ 会放过 "..."、":::"、
// "abc" 这类垃圾串——攻击者每换一个垃圾串就造一个新桶，限流形同虚设。
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;
export const UNKNOWN_IP = "unknown";
function isAddress(value: string): boolean {
  // X-Forwarded-For 里的 IPv6 可能带方括号（[::1]），先剥掉再判形状。
  const text = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!text || text.length > 45) return false;
  if (IPV4.test(text)) return true;
  // 必须含冒号、且不能出现 ":::" 这种三连冒号（split 会把它切成两段空壳骗过计数）。
  if (!text.includes(":") || /:{3,}/.test(text)) return false;
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = (part: string) => part.split(":").filter(Boolean).map((group) =>
    group.includes(".") ? (IPV4.test(group) ? group : null) : IPV6_GROUP.test(group) ? group : null);
  const left = groups(halves[0]);
  const right = halves.length === 2 ? groups(halves[1]) : [];
  // IPv4 只允许出现在最后一段（::ffff:1.2.3.4 这类映射写法），其余位置出现点号即非法。
  if ([...left, ...right].includes(null)) return false;
  // "::" 至少要省略一段，所以两侧组数之和不超过 7；不带 "::" 时必须是满 8 组。
  return halves.length === 2 ? left.length + right.length <= 7 : left.length === 8;
}
export function clientIp(request: Request) {
  // 0 跳 = 应用直接对外，前面没有可信代理。X-Forwarded-For 完全由调用方书写，而且
  // 是链条型的（能塞进任意多段），把它留在键计算里等于给攻击者发桶的钥匙，因此
  // 整条链被丢弃，只走既有兜底来源。代价必须说清楚：没有可信代理时兜底头同样可
  // 伪造，这类部署只能靠"前面确实有反代（hops >= 1）"来保证限流键可信。
  if (TRUSTED_HOPS === 0) {
    const direct = (request.headers.get("x-real-ip") || "").trim();
    return isAddress(direct) ? direct : UNKNOWN_IP;
  }
  const chain = (request.headers.get("x-forwarded-for") || "").split(",").map(value => value.trim()).filter(Boolean);
  const index = chain.length - TRUSTED_HOPS;
  const candidate = index >= 0 ? chain[index] : (request.headers.get("x-real-ip") || "").trim();
  return isAddress(candidate) ? candidate : UNKNOWN_IP;
}

type Bucket = { count: number; until: number };
const buckets = new Map<string, Bucket>();
const SWEEP_INTERVAL_MS = 10000;
// 硬上限。此前唯一的约束是「size > 5000 才清扫」，而清扫只删已过期条目：只要新键的
// 增速快过过期速度，表就能一路涨到几十万条，限流器自己成了 OOM 的触发器。
// 到上限后不再接受新键，一律并入共享的溢出桶 —— 更严格，绝不会因此放过攻击者。
const MAX_BUCKETS = 20000;
const OVERFLOW_KEY = "__overflow__";
let bucketSweep = 0;
let failureSweep = 0;
let overflowWarned = false;
let failureOverflowWarned = false;

// 限流触达告警。去重键**只用 scope**，刻意不带 key(IP)：
//
// 告警要回答的问题是"**哪个接口**在被持续打爆"——这是 scope 级信号，运维排查时
// 要的是接口名，不是攻击者的 IP 清单。按 scope 去重还消除了一个真实攻击面：
// 若去重键含 IP，攻击者轮换 3 万个 IP 就能打满去重表、让告警量随 IP 数线性增长
// （实测 30000 个轮换 IP 打出 9999 条日志），既能刷爆磁盘/日志，又把正常用户的
// 告警挤掉——**可观测性被攻击者主动关闭**，比没有告警更危险。改用 scope 后，
// 告警量与被攻击的 IP 数完全无关：轮换多少 IP 都是 REJECT_ALERT_INTERVAL_MS 一条。
// 代价是单个用户手抖点多了也会记一条（同样 30 秒一条），噪音可接受——detail 文案
// 已写明"确认不是正常请求被打满"。
const REJECT_ALERT_INTERVAL_MS = 30 * 1000;
const alertState = new Map<string, number>();
function alertRejected(scope: string, key: string, count: number, now: number) {
  const last = alertState.get(scope);
  if (last !== undefined && now - last < REJECT_ALERT_INTERVAL_MS) return;
  alertState.set(scope, now);
  // IP 解析失败归到 UNKNOWN_IP 时，所有"取不到 IP"的请求共用一个桶——这跟"某个 IP
  // 被限流"是完全不同的故障：前者意味着**整站共用一个额度**（nginx 没下发 x-real-ip、
  // 或 TRUSTED_PROXY_HOPS 与实际代理层数不匹配），任何一个人打满就让全站同类请求一起
  // 被拒。实测直连应用（不带任何 IP 头）时第 9 次就 429，正是这个共享桶。必须用独立
  // 事件名，让运维一眼区分"有人打爆接口"与"IP 链路坏了要修配置"。
  if (key === UNKNOWN_IP) {
    logger.warn("ratelimit.unknown_ip_collision", {
      scope, count,
      detail: `限流取不到客户端 IP（归入共享桶 "${UNKNOWN_IP}"），当前 ${scope} 已被打满。` +
        `说明所有解析不出 IP 的请求共用一个额度，任一访客打满即导致全站同类请求被拒。` +
        `请检查反代是否下发 X-Real-IP（TRUSTED_PROXY_HOPS=${TRUSTED_HOPS}）——` +
        `hops 配置与实际代理层数不匹配是本告警最常见的原因。`,
    });
    return;
  }
  logger.warn("ratelimit.rejected", {
    scope, count,
    detail: `限流触达：${scope} 已拒绝第 ${count} 次进入窗口的请求。连续/高频触发多来自脚本或爆破，可检查对应 scope 的阈值与 TRUSTED_PROXY_HOPS 是否匹配，或确认不是正常请求被打满。`,
  });
}

// Sweeping is itself O(size), so it must not run on every request: doing that turns the
// amortised O(1) counter into an O(size)-per-request scan whenever the key count is high.
// Between sweeps the map only grows by the entries created inside one interval, which is
// bounded by the request rate, so the memory ceiling stays predictable — 并且由 MAX_BUCKETS
// 兜底：清扫只删已过期条目，删不动时（键增速快过过期）由溢出桶接管，表的规模不再增长。
function sweepBuckets(now: number) {
  if (buckets.size > 5000 && now - bucketSweep > SWEEP_INTERVAL_MS) {
    bucketSweep = now;
    for (const [k, value] of buckets) if (value.until < now) buckets.delete(k);
    // 告警去重表一并清扫：键是 scope（数量有界、不受 IP 枚举影响），但仍与
    // buckets 走同一次清扫，避免两张表各自维护生命周期而其中一张只增不减。
    for (const [k, at] of alertState) if (now - at >= REJECT_ALERT_INTERVAL_MS) alertState.delete(k);
  }
}

export type RateLimitVerdict = { allowed: boolean; retryAfterSec: number };

export function rateLimitKey(key: string, scope: string, limit = 10, windowMs = 60000): RateLimitVerdict {
  const now = Date.now();
  sweepBuckets(now);
  const overflowId = `${scope}:${OVERFLOW_KEY}`;
  let id = `${scope}:${key}`;
  const known = buckets.get(id);
  // 表已满且是新键时退化为共享桶：不再为陌生键分配内存，也不再给它单独的额度。
  if (!known && id !== overflowId && buckets.size >= MAX_BUCKETS) {
    id = overflowId;
    if (!overflowWarned) {
      overflowWarned = true;
      logger.warn("ratelimit.bucket_overflow", {
        scope, max: MAX_BUCKETS,
        detail: "限流桶表已满，新客户端键并入共享桶 __overflow__；请检查 TRUSTED_PROXY_HOPS 是否与真实代理层数一致",
      });
    }
  }
  const current = buckets.get(id);
  // 固定窗口。重置时刻恒为窗口结束的 until；Retry-After = ceil((until - now)/1000)。
  //
  // 两条路径都返回**同一个式子**，而不是"新窗口返回整个 windowMs"：
  //   · 新窗口时 until = now + windowMs，结果为 ceil(windowMs/1000)，仍是整数秒；
  //   · 命中既有窗口时就是真实剩余秒。
  // 这样返回值语义唯一（"距可重试还有多少秒"），不会因为某条分支图省事返回
  // "窗口总长"而在传入非整秒窗口时发出 `Retry-After: 1.5` —— RFC 6585 要求该头
  // 是整数秒，客户端 parseInt 会截断（1.5→1）导致提前重试。前端 client.ts 正是
  // Number.parseInt(raw,10)，所以这里必须自己先 ceil 好。
  if (!current || current.until < now) {
    const until = now + windowMs;
    buckets.set(id, { count: 1, until });
    return { allowed: true, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  current.count++;
  const allowed = current.count <= limit;
  if (!allowed) alertRejected(scope, key, current.count, now);
  return { allowed, retryAfterSec: Math.max(0, Math.ceil((current.until - now) / 1000)) };
}

/** 可直接消费剩余秒的结构化判定；`rateLimit()` 只取 `.allowed` 保持向后兼容。 */
export function rateLimitResult(request: Request, scope: string, limit = 10, windowMs = 60000): RateLimitVerdict {
  return rateLimitKey(clientIp(request), scope, limit, windowMs);
}

/** 布尔返回，35 处既有调用点无需改动。需要精确 Retry-After 时改用它上面的 Result。 */
export function rateLimit(request: Request, scope: string, limit = 10, windowMs = 60000) {
  return rateLimitResult(request, scope, limit, windowMs).allowed;
}

// Progressive backoff instead of a hard account lockout: repeated failures slow the
// response down but never shut a legitimate operator out of the console.
const FAILURE_WINDOW_MS = 30 * 60 * 1000;
const failures = new Map<string, { count: number; at: number }>();
// 与限流桶表同样的问题、同样的解法：这张表也曾只靠清扫收缩，能被枚举撑爆。
const MAX_FAILURES = 20000;

export function loginDelayMs(key: string) {
  const now = Date.now();
  // 写入端在表满时把新键并入溢出桶，读取端必须用同一套键，否则记住的失败次数
  // 会被读丢，退避形同不存在。
  const failure = failures.get(key) ?? failures.get(OVERFLOW_KEY);
  if (!failure || now - failure.at > FAILURE_WINDOW_MS) return 0;
  return failure.count < 3 ? 0 : Math.min(1500, (failure.count - 2) * 400);
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  if (failures.size > 5000 && now - failureSweep > SWEEP_INTERVAL_MS) {
    failureSweep = now;
    for (const [k, value] of failures) if (now - value.at > FAILURE_WINDOW_MS) failures.delete(k);
  }
  const known = failures.get(key);
  const id = !known && failures.size >= MAX_FAILURES ? OVERFLOW_KEY : key;
  if (id === OVERFLOW_KEY && !failureOverflowWarned) {
    failureOverflowWarned = true;
    logger.warn("ratelimit.failure_table_overflow", {
      max: MAX_FAILURES,
      detail: "登录失败记录表已满，新的失败计数并入共享溢出桶 __overflow__；可能是自动化爆破，也可能是正常用户名被大量枚举",
    });
  }
  const failure = failures.get(id);
  failures.set(id, { count: failure && now - failure.at <= FAILURE_WINDOW_MS ? failure.count + 1 : 1, at: now });
}

export const clearLoginFailures = (key: string) => { failures.delete(key); };

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const maskIdentity = (value: string) => (value.length > 2 ? `${value.slice(0, 2)}***` : "***");

export const validEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const validUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
