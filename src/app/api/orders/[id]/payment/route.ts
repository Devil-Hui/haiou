import { NextResponse } from "next/server";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getPaymentSettings, isExpired } from "@/lib/catalog";
import { preparePayment } from "@/lib/payments";
import { sameOrigin, validUuid, rateLimitResult, digest, safeEqual } from "@/lib/auth";
import { logger, apiError, ErrorCode } from "@/lib/core";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "prepare-payment", 30);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "请求过于频繁，请稍后重试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const { id } = await context.params;
  if (!validUuid(id)) return apiError(ErrorCode.NOT_FOUND, "订单不存在", 404);
  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return apiError(ErrorCode.NOT_FOUND, "订单不存在", 404);

// 归属校验：凭一次性取卡码，不依赖邮箱或登录态。
  //
  // 本站注册无邮箱所有权验证，因此"登录邮箱匹配"或"提供下单邮箱"都**不能**
  // 作为凭证：攻击者注册他人邮箱后两者都会成立，等于一次注册即可取走全部卡密。
  // 取卡码是唯一攻击者拿不到的那一份信息（只在下单成功时展示一次，站点仅留摘要）。
  const token = (new URL(request.url).searchParams.get("token") || "").trim();
  if (!token || !order.deliveryTokenHash || !safeEqual(digest(token), order.deliveryTokenHash)) {
    return apiError(ErrorCode.AUTH_INVALID, "请提供取卡码以验证归属", 403);
  }
  if (order.status !== "pending") return apiError(ErrorCode.CONFLICT_STATE, "该订单无需继续支付，请查看订单结果", 409);
  // 过期单必须在准备支付之前就拦下来。放任买家对着已过期订单付款，钱会真的到账，
  // 但订单不会转成已支付（markPaid 里按过期处理转人工），买家体验与对账都变差。
  // 这里给出明确的 410 而不是 409：语义上订单曾经存在、如今已失效。
  if (isExpired(order)) return apiError(ErrorCode.NOT_FOUND, "订单已超过支付时限，请重新下单", 410);
  try { return NextResponse.json(await preparePayment(order, await getPaymentSettings()), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { logger.error("order.payment_adapter_failed", { orderId: id }, error); return apiError(ErrorCode.UPSTREAM_FAILED, "支付配置校验失败，请稍后重试或联系管理员", 503); }
}
