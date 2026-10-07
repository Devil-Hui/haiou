import { NextResponse } from "next/server";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { rateLimitResult, sameOrigin, validEmail } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "lookup", 8);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "查询过于频繁，请一分钟后重试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const body = await readJson(request);
  if (!body) return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  try {
    const code = String(body.code || "").trim().toUpperCase();
    const email = String(body.email || "").trim().toLowerCase();
    if (!validEmail(email) || !/^AU\d{8}[A-F0-9]{8}$/.test(code)) return apiError(ErrorCode.VALIDATION_FAILED, "请填写有效的订单号及下单邮箱", 400);
    const [order] = await db.select({ id: orders.id, code: orders.code, planName: orders.planName, brand: orders.brand, createdAt: orders.createdAt }).from(orders).where(and(eq(orders.code, code), eq(orders.email, email)));
    if (!order) return apiError(ErrorCode.NOT_FOUND, "未找到匹配订单，请确认订单号和账号邮箱是否正确", 404);
    return NextResponse.json(order, { headers: { "Cache-Control": "no-store" } });
  } catch { return apiError(ErrorCode.INTERNAL, "查询失败，请稍后重试", 500); }
}
