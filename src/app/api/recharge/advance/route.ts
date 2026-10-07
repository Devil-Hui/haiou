import { NextResponse } from "next/server";
import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { orders, rechargeJobs } from "@/db/schema";
import { advanceJob } from "@/lib/recharge";
import { rateLimitResult, sameOrigin, digest, safeEqual } from "@/lib/auth";
import { readJson, ErrorCode, traceId } from "@/lib/core";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const fail = (error: string, status: number, code: string, retryAfterSec?: number) =>
  NextResponse.json({ error, code, traceId: traceId() }, {
    status,
    // 429 统一带 Retry-After（RFC 6585；GitHub/Stripe/Cloudflare 惯例）。传 retryAfterSec
    // 时用真实窗口剩余秒（rateLimitResult 提供），不传回落固定窗口保守值 60s。
    headers: status === 429 ? { ...NO_STORE, "Retry-After": String(retryAfterSec ?? 60) } : NO_STORE,
  });

/**
 * 显式推进一个充值任务。
 *
 * 为什么要单独开一个 POST：GET /api/recharge 是语义上只读的查询，
 * 此前却顺带调用 advanceJob 改状态。一个带副作用的"读"接口代价很实在：
 * 浏览器预取、爬虫、链接预览都会意外触发状态流转；而买家每 5 秒轮询一次，
 * 意味着并发窗口被反复命中（transition 的 CAS 能挡下重复写入，但每次失败
 * 都是一次无谓的 UPDATE 尝试 + 可能的日志噪音）。
 *
 * 现在职责分开：
 *   · 批量推进 —— maintenance 定时任务（每 5 分钟）；
 *   · 单个推进 —— 买家点"刷新进度"时显式调这里。
 *
 * 仍然要求归属校验：推进会触发上游调用，匿名者不应能驱动它。
 */
export async function POST(request: Request) {
  // 推进会触发上游调用，限流比查询更严。
  //
  // 配额按"前端 10 秒一轮询"倒推：单页 6 次/分；留出 3 倍余量给多标签页、
  // 网络重试与失败重放。上游真正被驱动的频率仍由 advanceJob 的 90 秒节流
  // 封顶（lastQueriedAt），所以这里的配额只防"有人拿脚本狂刷"，
  // 不会因为放宽而增加对 aisub 的压力。
  {
    const rl = rateLimitResult(request, "recharge-advance", 40);
    if (!rl.allowed) return fail("操作过于频繁，请稍后再试", 429, ErrorCode.RATE_LIMITED, rl.retryAfterSec);
  }
  if (!sameOrigin(request)) return fail("请求来源无效", 403, ErrorCode.VALIDATION_FAILED);
  const body = await readJson(request);
  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code || code.length > 40) return fail("请填写订单号", 400, ErrorCode.VALIDATION_FAILED);

  const [job] = await db
    .select({ id: rechargeJobs.id, email: rechargeJobs.email, orderCode: rechargeJobs.orderCode })
    .from(rechargeJobs)
    .where(or(eq(rechargeJobs.code, code), eq(rechargeJobs.orderCode, code)))
    .limit(1);
  if (!job) return fail("未找到该订单，请核对订单号", 404, ErrorCode.NOT_FOUND);

  // 归属校验：凭一次性取卡码，不依赖邮箱或登录态。
  //
  // 本站注册无邮箱所有权验证，因此"登录邮箱匹配"或"提供下单邮箱"都挡不住
  // 注册了他人邮箱的冒领者。取卡码是唯一攻击者拿不到的那一份信息。
  // 推进会触发上游调用，匿名者更不应能驱动它。
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || !job.orderCode) return fail("请提供取卡码以验证归属", 403, ErrorCode.AUTH_INVALID);
  const [owner] = await db
    .select({ hash: orders.deliveryTokenHash })
    .from(orders)
    .where(eq(orders.code, job.orderCode))
    .limit(1);
  if (!owner?.hash || !safeEqual(digest(token), owner.hash)) {
    return fail("取卡码不正确", 403, ErrorCode.AUTH_INVALID);
  }

  const r = await advanceJob(job.id);
  return NextResponse.json({ code, done: r.done, status: r.status }, { headers: NO_STORE });
}
