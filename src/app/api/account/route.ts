import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { checkPassword, currentUser, hashPassword, strongAdminPassword } from "@/lib/auth";
import { rateLimitResult, sameOrigin } from "@/lib/auth";
import { apiError, ErrorCode, ok, readJson } from "@/lib/core";

// 普通用户账号：注册 / 登录 / 登出 / 当前会话。与管理员会话完全独立（独立 Cookie、独立表）。
// 下单与查单仍支持免注册邮箱方式，注册是可选项。

const COOKIE = "haiou_user";
const TTL_MS = 30 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const cookieOptions = (expires: Date) => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", expires });
// 邮箱不存在时也消耗一次 scrypt，使响应耗时与命中真实账号时一致，杜绝账号枚举。
const TIMING_EQUALIZER = hashPassword("haiou-user-credential-equalizer");

async function startSession(id: string) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + TTL_MS);
  await db.update(users).set({ sessionHash: digest(token), sessionExpires: expires }).where(eq(users.id, id));
  (await cookies()).set(COOKIE, token, cookieOptions(expires));
}

export async function GET() {
  // 与 /api/account/me 统一走 currentUser()。此前这里只比 session_hash，漏了
  // session_expires > now()：会话过期后前端仍显示已登录，点任意操作才 401 ——
  // 正是 lib/auth/auth.ts 注释声称要避免的"页面认为已登录、接口认为未登录"。
  // currentUser 还要求 token 形如 64 位 hex，顺带挡掉伪造的 cookie。
  try {
    const user = await currentUser();
    return ok({ user: user ? { email: user.email } : null });
  } catch { return ok({ user: null }); }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "user-auth", 8);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "操作过于频繁，请一分钟后重试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const body = await readJson(request);
  if (!body) return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!EMAIL_RE.test(email) || email.length > 254) return apiError(ErrorCode.VALIDATION_FAILED, "请输入有效的邮箱地址", 400);
  try {
    if (body.action === "register") {
      // 密码规则与管理员一致：至少 12 位，拒绝常见弱口令与包含邮箱前缀的组合
      if (!strongAdminPassword(password, email.split("@")[0])) return apiError(ErrorCode.VALIDATION_FAILED, "密码至少 12 位，且不能是常见弱口令、重复字符或包含邮箱前缀", 400);
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing) return apiError(ErrorCode.CONFLICT_STATE, "该邮箱已注册，请直接登录", 409);
      const [created] = await db.insert(users).values({ email, passwordHash: hashPassword(password) }).onConflictDoNothing().returning({ id: users.id });
      if (!created) return apiError(ErrorCode.CONFLICT_STATE, "该邮箱已注册，请直接登录", 409);
      await startSession(created.id);
      return ok({ user: { email } });
    }
    if (body.action === "login") {
      const [user] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, email)).limit(1);
      const matches = await checkPassword(password, user ? user.passwordHash : await TIMING_EQUALIZER);
      if (!user || !matches) return apiError(ErrorCode.AUTH_INVALID, "邮箱或密码不正确", 401);
      await startSession(user.id);
      return ok({ user: { email } });
    }
    return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  } catch { return apiError(ErrorCode.INTERNAL, "账户服务暂时不可用，请稍后重试", 500); }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  const store = (await cookies());
  const token = store.get(COOKIE)?.value;
  if (token) await db.update(users).set({ sessionHash: null, sessionExpires: null }).where(eq(users.sessionHash, digest(token)));
  store.set(COOKIE, "", { ...cookieOptions(new Date(0)), maxAge: 0 });
  return ok({ success: true });
}
