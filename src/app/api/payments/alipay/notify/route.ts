import { db } from "@/db";
import { orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { orderTotal } from "@/lib/catalog";
import { getPaymentSettings } from "@/lib/catalog";
import { markPaid, verifyAlipay, isApplied, needsManualReview } from "@/lib/payments";
import { recordTx, TxDetail, sanitizePayload, txStatusFor, txDetailFor } from "@/lib/payments/tx";
import { rateLimit } from "@/lib/auth";
import { logger } from "@/lib/core";

export async function POST(request: Request) {
  const settings = await getPaymentSettings();
  if (!settings.alipayPublicKey || !settings.alipayAppId || !settings.alipaySellerId) {
    logger.warn("alipay.notify_not_configured", {});
    return new Response("not_configured", { status: 503 });
  }
  // Throttled before any RSA work so an unauthenticated flood cannot burn CPU on signature
  // verification. Alipay retries failed notifications, and markPaid is idempotent, so a 429
  // here is safe: the real notification arrives again later.
  if (!rateLimit(request, "alipay-notify", 120)) return new Response("failure", { status: 429 });
  const raw = await request.text();
  if (raw.length > 32768) return new Response("failure", { status: 413 });
  const form = new URLSearchParams(raw);
  // 重复参数一律拒绝并留痕。攻击者会在签名参数之后追加同名键试图覆盖金额；
  // 静默取第一个虽也能防住，但会把攻击痕迹藏起来，日后无从排查。
  const duplicate = Array.from(form.keys()).find(key => form.getAll(key).length > 1);
  if (duplicate) {
    logger.audit("alipay.notify_duplicate_param", { param: duplicate });
    return new Response("failure", { status: 400 });
  }
  const params = Object.fromEntries(form.entries());
  // URLSearchParams 按 application/x-www-form-urlencoded 解码，会把 '+' 变成空格。
  // 而 sign 是 base64，字母表里就有 '+'——于是大约 2/3 的合法通知会拿到一个
  // 被空格污染的签名，verify 抛错被吞成"验签失败"。表现是间歇性、无法复现的
  // 丢单，日志里只有 notify_verify_failed，看不出真实原因。
  // 只有 sign 需要还原：其它字段按 form-urlencoded 解码才是网关的原意。
  if (typeof params.sign === "string" && params.sign.includes(" ")) {
    params.sign = params.sign.replace(/ /g, "+");
  }
  if (!verifyAlipay(params, settings)) {
    // 验签失败时连订单号都不可信，因此不写流水（流水需要 orderId 外键），
    // 只记审计日志：这类事件要靠日志发现，不属于任何一笔具体订单。
    logger.audit("alipay.notify_verify_failed", { order: params.out_trade_no || null, tradeNo: params.trade_no || null });
    return new Response("failure", { status: 400 });
  }
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.code, params.out_trade_no));
  if (!order) {
    logger.audit("alipay.notify_unknown_order", { order: params.out_trade_no || null });
    return new Response("failure", { status: 404 });
  }
  // 回调原文留档的统一出口。payload 经 sanitize 剔除签名等敏感字段后再落库。
  const writeNotifyTx = (status: "succeeded" | "failed" | "pending" | "rejected", detail?: string) =>
    recordTx({ orderId: order.id, gateway: "alipay", event: "notify", status, tradeNo: params.trade_no || null, amount: params.total_amount || null, currency: "cny", payload: sanitizePayload(params), detail });
  if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(params.trade_status)) {
    // 非成功终态同样留痕：TRADE_CLOSED（超时关闭）是需要运营回看的信号，
    // 不记就只剩一条没有上下文的日志。
    await writeNotifyTx(params.trade_status === "WAIT_BUYER_PAY" ? "pending" : "failed", TxDetail.gatewayRejected);
    return new Response("success");
  }
  if (!/^\d{10,80}$/.test(params.trade_no || "") || !/^\d{1,8}(\.\d{1,2})?$/.test(params.total_amount || "")) {
    await writeNotifyTx("rejected", TxDetail.malformedBody);
    return new Response("failure", { status: 400 });
  }
  try {
    // 金额核对必须用「实付」（商品价 + 手续费）。引入手续费后，拿商品价比对会让
    // 每一笔真实付款都被判为金额不符——这是加手续费时最容易踩的一处。
    const result = await markPaid(order.id, `alipay:${params.trade_no}`, "alipay", target => orderTotal(target) === Number(params.total_amount).toFixed(2));
    // 回调处理结果必须留痕：markPaid 的失败有多种成因，流水里的 detail 决定了
    // 它能不能被对账查询捞出来。
    await writeNotifyTx(txStatusFor(result), txDetailFor(result) || undefined);
    // 人工核对类结果（过期到账 / 取消后到账 / 重复扣款）必须被告警看到。
    // 这些都是真实资金问题，混在成功记录里就永远不会被发现。
    if (needsManualReview(result)) {
      logger.error("alipay.notify_needs_manual_review", {
        order: params.out_trade_no, tradeNo: params.trade_no, result, amount: params.total_amount,
      });
    } else {
      logger.audit("alipay.notify_processed", { order: params.out_trade_no, tradeNo: params.trade_no, result });
    }
    // 应答策略按"重投有没有意义"决定，而不是一律 success 或一律 failure：
    //   · 已入账/幂等/重复扣款 → success。钱已收到，重投只会重复插流水；
    //     重复扣款靠上面的 error 日志 + 流水去追人工退款，不需要网关重投。
    //   · 需要人工核对 → success 并已记 error。返回 failure 只会让支付宝
    //     在 24 小时内反复重投，每次都插一条 rejected，把表和日志刷爆。
    //   · 金额不符/订单不符/并发冲突 → failure。让网关重投是合理的，
    //     因为可能只是通知早于本地落库。
    const settled = isApplied(result) || needsManualReview(result);
    return new Response(settled ? "success" : "failure", { status: settled ? 200 : 400 });
  } catch (error) {
    // 此前这里是裸 catch{}，DB 抖动时只会回一个 409 而不留下任何痕迹。
    // 支付宝会持续重投，所以返回 failure 让它重试是安全的；关键是同时记下异常、
    // 并落一条流水——否则"约束冲突导致拒绝入账"这类事件在对账表里完全不存在，
    // 事后无法解释钱为什么没到账。
    logger.error("alipay.notify_failed", { order: params.out_trade_no, tradeNo: params.trade_no }, error);
    await writeNotifyTx("rejected", TxDetail.internalError).catch(() => undefined);
    return new Response("failure", { status: 409 });
  }
}
