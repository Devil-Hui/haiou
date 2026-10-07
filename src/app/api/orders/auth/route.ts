import { NextResponse } from "next/server";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { desc } from "drizzle-orm";
import { rateLimitResult, sameOrigin, validEmail } from "@/lib/auth";
import { logger, readJson, apiError, ErrorCode } from "@/lib/core";
import { orderOwnedBy, verifyOwnerCardPassword } from "@/lib/catalog";

// 访客凭「购买邮箱 + 取卡密码」查询历史订单。
//
// 【为什么必须校验密码，不能只凭邮箱】
// 本站注册无邮箱所有权验证，而激活邮箱是结算页必填项，等于半公开信息。
// 只凭邮箱返回订单列表，等于把「猜邮箱 → 拿到他人订单号与套餐」变成零门槛操作。
// 密码是买家自己设的，只有本人知道，且用 scrypt 存储与校验，暴力枚举不可行。
//
// 【与登录态的关系】
// 登录用户走 /me（凭会话），访客走这里（凭邮箱+密码）。两者归到**同一个**
// 判定口径（orderOwnedBy），确保"登录后看到的"与"凭密码看到的"永远是同一批订单。
//
// 【本接口不返回卡密明文】
// 卡密仍走 POST /orders/[id]/delivery 单独领取，那里才做密码/取卡码校验。
// 这里只回答"有哪些卡、状态如何"——列表泄露与取卡是两个独立的授权动作。
const NO_STORE = { "Cache-Control": "no-store" } as const;
// fail 统一带 no-store，但 code 须按调用点分开给（来源/限流/校验/凭据不同语义）。
// 只保留一个接受 code 的变体，避免每个调用点都重复传 NO_STORE。
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status = 400, retryAfterSec?: number) =>
  apiError(code, error, status, retryAfterSec ? { ...NO_STORE, "Retry-After": String(retryAfterSec) } : NO_STORE);

// 列表最多返回多少笔。与 verifyOwnerCardPassword 内部的上限一致——
// 密码校验是串行 scrypt，列表再长也无意义，只会让单次请求等更久。
const MAX_CHECK = 100;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  // 限流要紧：密码校验走 scrypt，不限流的话一个脚本就能把 CPU 打满——
  // 这是密码接口特有的放大面，普通查询接口不需要这么紧。
  // 用 rateLimitResult 拿真实窗口剩余秒，写进 Retry-After（语义同 GitHub X-RateLimit-Reset）。
  {
    const rl = rateLimitResult(request, "guest-order-auth", 10);
    if (!rl.allowed) return fail(ErrorCode.RATE_LIMITED, "尝试过于频繁，请稍后再试", 429, rl.retryAfterSec);
  }
  const body = await readJson(request);
  if (!body) return fail(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!validEmail(email) || password.length < 1 || password.length > 128) return fail(ErrorCode.VALIDATION_FAILED, "请填写购买邮箱与取卡密码", 400);

  try {
    const candidates = await db
      .select({
        id: orders.id,
        code: orders.code,
        planName: orders.planName,
        brand: orders.brand,
        period: orders.period,
        amount: orders.amount,
        feeAmount: orders.feeAmount,
        discountAmount: orders.discountAmount,
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .where(orderOwnedBy(email))
      .orderBy(desc(orders.createdAt))
      .limit(MAX_CHECK);

    // 逐笔 scrypt 校验，**串行**而非 Promise.all：并发 100 次会瞬间占满
    // libuv 线程池（默认 4），把整个服务的其它请求一起堵死。
    // 判定逻辑本身抽在 verifyOwnerCardPassword 里，与密码重置共用同一实现。
    const owned = new Set(await verifyOwnerCardPassword(email, password));
    const matched = candidates.filter((row) => owned.has(row.id));

    if (matched.length === 0) {
      // 不区分「邮箱不存在」与「密码错」，避免用响应差异探测哪些邮箱下过单。
      logger.audit("guest_order_auth_failed", { email: `${email.slice(0, 2)}***` });
      return fail(ErrorCode.AUTH_INVALID, "购买邮箱或取卡密码不正确", 401);
    }

    logger.audit("guest_order_auth_ok", { matched: matched.length, email: `${email.slice(0, 2)}***` });
    return NextResponse.json(
      {
        items: matched.map((row) => ({
          id: row.id,
          code: row.code,
          planName: row.planName,
          brand: row.brand,
          period: row.period,
          amount: row.amount,
          feeAmount: row.feeAmount,
          discountAmount: row.discountAmount,
          status: row.status,
          paymentMethod: row.paymentMethod,
          // 命中的订单必然设了密码，因此取卡时可用本密码（无需取卡码）。
          canUsePassword: true,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
      { headers: NO_STORE },
    );
  } catch {
    return fail(ErrorCode.INTERNAL, "查询失败，请稍后重试", 500);
  }
}
