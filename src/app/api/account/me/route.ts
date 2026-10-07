import { NextResponse } from "next/server";
import { currentUser, rateLimitResult, sameOrigin } from "@/lib/auth";
import { listUserOrders } from "@/lib/catalog";
import { checkPassword, hashPassword, strongAdminPassword } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";

const NO_STORE = { "Cache-Control": "no-store" } as const;
// 个人中心响应含邮箱与订单数据，错误响应同样禁止被缓存。code 由调用点按语义传。
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status = 400, retryAfterSec?: number) =>
  apiError(code, error, status, retryAfterSec ? { ...NO_STORE, "Retry-After": String(retryAfterSec) } : NO_STORE);

// 个人中心数据。订单里含买家邮箱与金额，绝不能被任何中间缓存留存。
// 刻意不返回任何卡密/兑换内容：个人中心不展示这类信息。
export async function GET(request: Request) {
  {
    const rl = rateLimitResult(request, "user-me", 120);
    if (!rl.allowed) return fail(ErrorCode.RATE_LIMITED, "请求过于频繁，请稍后再试", 429, rl.retryAfterSec);
  }
  const user = await currentUser();
  if (!user) return fail(ErrorCode.AUTH_REQUIRED, "请先登录", 401);
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") || "").trim();
  // 分页上限与数据层（order-owner.listOrdersByOwner）一致：1000 页 × 10 条 = 1 万条。
  const page = Math.max(1, Math.min(1000, Math.floor(Number(url.searchParams.get("page")) || 1)));
  const orders = await listUserOrders(user.email, status, page);
  return NextResponse.json({ email: user.email, orders }, { headers: NO_STORE });
}

// 修改自己的密码。规则与管理员一致，且必须验证当前密码——
// 会话被窃时，仅凭"已登录"不足以改密码。
export async function PATCH(request: Request) {
  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "user-password", 5);
    if (!rl.allowed) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后再重试", 429, rl.retryAfterSec);
  }
  const user = await currentUser();
  if (!user) return fail(ErrorCode.AUTH_REQUIRED, "请先登录", 401);
  const body = await readJson(request);
  if (!body) return fail(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!strongAdminPassword(next, user.email.split("@")[0])) {
    return fail(ErrorCode.VALIDATION_FAILED, "新密码至少 12 位，且不能是常见弱口令、重复字符或包含邮箱前缀", 400);
  }
  const { db } = await import("@/db");
  const { users } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
  if (!row || !(await checkPassword(current, row.passwordHash))) return fail(ErrorCode.AUTH_INVALID, "当前密码不正确", 401);
  if (await checkPassword(next, row.passwordHash)) return fail(ErrorCode.VALIDATION_FAILED, "新密码不能与当前密码相同", 400);
  // 改密后清空会话摘要：所有设备立即失效，需要重新登录。这与管理员侧行为一致。
  await db.update(users).set({ passwordHash: hashPassword(next), sessionHash: null, sessionExpires: null }).where(eq(users.id, user.id));
  return NextResponse.json({ success: true, relogin: true }, { headers: NO_STORE });
}
