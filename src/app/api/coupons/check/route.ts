import { NextResponse } from "next/server";
import { rateLimitResult, sameOrigin, validEmail } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";
import { checkCoupon } from "@/lib/promo";

// 优惠券预检：让买家在提交订单前就看到能减多少、为什么不能用。
// 只读不写，因此限流可以放宽一点；真正的扣减发生在下单事务里。
export async function POST(request: Request) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "coupon-check", 20);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "尝试过于频繁，请稍后再试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const body = await readJson(request);
  if (!body) return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  const code = String(body.code || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const amount = Number(body.amount);
  if (!code) return apiError(ErrorCode.VALIDATION_FAILED, "请输入券码", 400);
  if (!validEmail(email)) return apiError(ErrorCode.VALIDATION_FAILED, "请先填写有效的账号邮箱", 400);
  if (!Number.isFinite(amount) || amount <= 0) return apiError(ErrorCode.VALIDATION_FAILED, "订单金额异常", 400);

  const result = await checkCoupon(code, email, amount.toFixed(2));
  if (!result.ok) return NextResponse.json({ valid: false, reason: result.reason }, { status: 200 });
  return NextResponse.json(
    { valid: true, discountAmount: result.discountAmount, note: result.note },
    { headers: { "Cache-Control": "no-store" } },
  );
}
