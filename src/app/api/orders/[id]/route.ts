import { NextResponse } from "next/server";
import { db } from "@/db";
import { orders, plans } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { sameOrigin, validUuid, rateLimitResult, digest, safeEqual } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  // Unauthenticated by design (the UUID is the credential), so throttle it: without this,
  // anyone can spray random UUIDs and make the process do a primary-key lookup per request.
  // 120/min is well above the 10-second polling of a handful of open payment pages.
  {
    const rl = rateLimitResult(request, "order-read", 120);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const { id } = await context.params;
  if (!validUuid(id)) return apiError(ErrorCode.NOT_FOUND, "订单不存在", 404);
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return apiError(ErrorCode.NOT_FOUND, "订单不存在", 404);
  // UUID is a private, unguessable capability link. Never expose full account emails here.
  const [local, domain] = order.email.split("@");
  // 交付方式由套餐决定，随订单一起下发，前端据此决定是否请求卡密（省掉无谓的请求）
  const [plan] = await db.select({ delivery: plans.delivery }).from(plans).where(eq(plans.id, order.planId));
  // 逐字段白名单，而不是 `...order` 展开整行。
  //
  // 本接口**无需鉴权**（UUID 即凭据），因此回什么就等于泄露什么。整行展开会把
  // deliveryTokenHash（取卡码的 sha256 摘要）与 couponCode 一并下发——前者正是
  // lib/cdk 里明文规定「绝不出现在对外响应」的那一列，与 redeemCardKey 只
  // returning 白名单字段的做法自相矛盾。摘要虽不可逆，但它把内部校验依据交到了
  // 客户端，且未来任何一次"顺手把整行 spread 出去"的改动都会静默泄露新列。
  // 白名单是显式契约：新增列默认不外泄，要外泄必须有人主动加一行。
  return NextResponse.json({
    id: order.id,
    code: order.code,
    planId: order.planId,
    planName: order.planName,
    brand: order.brand,
    period: order.period,
    amount: order.amount,
    feeAmount: order.feeAmount,
    discountAmount: order.discountAmount,
    status: order.status,
    paymentMethod: order.paymentMethod,
    usdtAmount: order.usdtAmount,
    note: order.note,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    delivery: plan?.delivery ?? "manual",
    email: `${local.slice(0, 2)}***@${domain}`,
  }, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
export async function PATCH(request: Request, context: Context) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "cancel", 10);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "操作过于频繁", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const { id } = await context.params;
  if (!validUuid(id)) return apiError(ErrorCode.NOT_FOUND, "订单不存在", 404);
  const body = await readJson(request);
  if (body?.action !== "cancel") return apiError(ErrorCode.VALIDATION_FAILED, "操作无效", 400);

  // ---- 归属校验：取消是写操作，必须与取卡/支付一样凭一次性取卡码 ----
  //
  // 此前这里只有 sameOrigin + validUuid 就直接 UPDATE：任何拿到订单 UUID 的人
  // 都能把**他人**的待支付订单直接取消。UUID 虽不可枚举，但它不是机密凭据——
  // 它出现在订单页 URL、Referer 头、浏览器历史、客服工单截图里，一旦泄露
  // 就能凭空取消对方的单（已付款的会取消不掉，但未付款的能被反复干扰）。
  //
  // 与 orders/[id]/delivery、payment、recharge 三处保持同一套判定：
  // 取卡码是攻击者拿不到的那一份信息（下单成功时展示一次，站内仅留摘要）。
  const token = (new URL(request.url).searchParams.get("token") || "").trim();
  const [owner] = await db.select({ hash: orders.deliveryTokenHash }).from(orders).where(eq(orders.id, id)).limit(1);
  if (!owner || !token || !owner.hash || !safeEqual(digest(token), owner.hash)) {
    return apiError(ErrorCode.AUTH_INVALID, "取卡码不正确，无法取消该订单", 403);
  }

  // canceledAt 与 status 在同一条 UPDATE 里落库：分开写会出现"状态已是 cancelled
  // 但取消时间为空"的窗口，客服查不到买家到底什么时候取消的。
  const [order] = await db.update(orders).set({ status: "cancelled", canceledAt: new Date(), updatedAt: new Date() }).where(and(eq(orders.id, id), eq(orders.status, "pending"))).returning({ id: orders.id });
  if (!order) return apiError(ErrorCode.CONFLICT_STATE, "仅待支付订单可以取消，请刷新订单状态", 409);
  return NextResponse.json({ success: true });
}
