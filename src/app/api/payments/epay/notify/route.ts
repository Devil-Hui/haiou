import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { getPaymentSettings } from "@/lib/catalog";
import { verifyEpay, isEpayPaid } from "@/lib/payments";
import { markPaid, isApplied, needsManualReview } from "@/lib/payments";
import { recordTx, TxDetail, sanitizePayload, txStatusFor, txDetailFor } from "@/lib/payments/tx";
import { orderTotal } from "@/lib/catalog";
import { rateLimit } from "@/lib/auth";
import { logger } from "@/lib/core";

// 易支付异步通知。
//
// 应答协议要求无论成功失败都输出 "success"，否则收银台会持续重试。这个取舍本身
// 没错，但此前它掩盖了两个真实问题：
//   1. markPaid 外面没有 try/catch。唯一约束冲突、DB 抖动都会变成未捕获异常 →
//      500 HTML。这类"约束生效了所以拒绝入账"的事件在对账表和日志里都不存在，
//      事后无法解释钱为什么没到账。
//   2. 验签失败的 reason 恒为 sign_mismatch。密钥轮换或收银台换签名算法时，
//      全量丢单也没有任何可聚合的信号。
// 现在两者都补上：异常落流水 + error 日志，验签失败细分原因。
export async function POST(request: Request) {
  if (!rateLimit(request, "epay-notify", 30)) return new NextResponse("fail", { status: 429 });

  // 报文大小上限，与支付宝/币安端点对齐（32KB）。
  // 此前只有本端点没有限制：限流挡的是**次数**，挡不住单次请求体把内存打满，
  // 而下面 JSON 分支的 request.json() 会把整个 body 一次性物化。
  // content-length 只作快速拒绝，未带该头（chunked）时由 text() 的长度检查兜底。
  if (Number(request.headers.get("content-length") || 0) > 32768) {
    logger.audit("epay.notify_too_large", {});
    return new NextResponse("success", { status: 200 });
  }

  let params: Record<string, string> = {};
  let sawDuplicate = false;
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      // 先按文本读取并限长，再解析：request.json() 无法在解析前中止。
      const raw = await request.text();
      if (raw.length > 32768) {
        logger.audit("epay.notify_too_large", {});
        return new NextResponse("success", { status: 200 });
      }
      const json = JSON.parse(raw);
      params = Object.fromEntries(Object.entries(json as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    } else {
      // 易支付默认是 application/x-www-form-urlencoded；也兼容 GET 查询串。
      const form = await request.formData().catch(() => null);
      if (form) {
        // 同名参数一律拒绝，与支付宝端点、mock 网关保持同一安全基线。
        // 此前 Object.fromEntries 静默取最后一个：改值必然改签名原文所以不构成
        // 绕过，但与另两条通道不一致，且将来谁"优化"成取第一个就立刻变成绕过。
        const seen = new Set<string>();
        let dup: string | null = null;
        for (const [k] of form.entries()) {
          if (seen.has(k)) { dup = k; break; }
          seen.add(k);
        }
        if (dup) { sawDuplicate = true; }
        else params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
      } else {
        params = Object.fromEntries(new URL(request.url).searchParams.entries());
      }
    }
  } catch {
    return new NextResponse("success", { status: 200 });
  }

  if (sawDuplicate) {
    logger.audit("epay.notify_duplicate_param", { order: params.out_trade_no || null });
    return new NextResponse("success", { status: 200 });
  }

  const settings = await getPaymentSettings();
  if (!verifyEpay(params, settings)) {
    // 细分原因。之前 reason 恒为 sign_mismatch，密钥轮换期间的"全量丢单"
    // 在告警里与"有人伪造回调"长得一模一样，无法分辨。
    const reason = !process.env.EPAY_KEY
      ? "key_missing"
      : params.pid !== settings.epayPid
        ? "pid_mismatch"
        : "sign_mismatch";
    logger.audit("epay.notify_invalid", { reason, order: params.out_trade_no || null });
    return new NextResponse("success", { status: 200 });
  }

  // 状态分派必须在验签之后。verifyEpay 此前内部就检查 trade_status，导致
  // TRADE_CLOSED（买家超时关单）被记成"伪造签名"，告警通道被正常流量污染，
  // 而这里那段"终态非成功也要留痕"的代码永远进不去。
  if (!isEpayPaid(params)) {
    const orderCode = params.out_trade_no;
    const [target] = await db.select({ id: orders.id }).from(orders).where(eq(orders.code, orderCode));
    if (target) {
      await recordTx({
        orderId: target.id, gateway: "epay", event: "notify", status: "failed",
        tradeNo: params.trade_no || null, amount: params.money || null, currency: "cny",
        payload: sanitizePayload(params), detail: TxDetail.gatewayRejected,
      });
    }
    logger.audit("epay.notify_not_paid", { order: orderCode, tradeStatus: params.trade_status || null });
    return new NextResponse("success", { status: 200 });
  }

  const orderCode = params.out_trade_no;
  const [order] = await db.select().from(orders).where(eq(orders.code, orderCode));
  if (!order) {
    logger.audit("epay.notify_unknown_order", { order: orderCode });
    return new NextResponse("success", { status: 200 });
  }

  // 回调原文留档的统一出口。易支付的 sign 字段会被 sanitize 剔除，不入库。
  const writeNotifyTx = (status: "succeeded" | "failed" | "pending" | "rejected", detail?: string) =>
    recordTx({ orderId: order.id, gateway: "epay", event: "notify", status, tradeNo: params.trade_no || null, amount: params.money || null, currency: "cny", payload: sanitizePayload(params), detail });

  // 金额必须按「实付」核对，且必须与 buildEpayUrl 收款时用的是同一个口径。
  // 此前 buildEpayUrl 用私藏的 amount+fee（不减券），这里用 orderTotal（含减券），
  // 于是所有用券订单"收了钱不认账"——且返回 success 让收银台永不重投。
  const expected = orderTotal(order);
  const received = Number(params.money);
  if (!Number.isFinite(received) || Math.abs(received - Number(expected)) >= 0.01) {
    // 金额不符必须留痕且要能被告警看到：这是最典型的"伪造回调"信号。
    await writeNotifyTx("rejected", TxDetail.amountMismatch);
    logger.audit("epay.notify_amount_mismatch", { order: orderCode, expected, received: params.money });
    return new NextResponse("success", { status: 200 });
  }

  const tradeNo = params.trade_no || `epay:${orderCode}`;
  try {
    const result = await markPaid(order.id, tradeNo, "epay", (o) => orderTotal(o) === expected && o.paymentMethod === "epay");
    await writeNotifyTx(txStatusFor(result), txDetailFor(result) || undefined);
    if (needsManualReview(result)) {
      // 过期到账 / 取消后到账 / 重复扣款：都是真实资金问题，必须被告警看到。
      // 不能记成 succeeded——那会让对账表里出现"干净的成功付款"挂在一条
      // 状态仍是 expired 的订单上，两边永远对不上且无人报警。
      logger.error("epay.notify_needs_manual_review", { order: orderCode, tradeNo, result, received: params.money });
    } else {
      logger.audit("epay.notify_processed", { order: orderCode, tradeNo, result });
    }
    return new NextResponse("success", { status: 200 });
  } catch (error) {
    // 此前没有 try/catch：唯一约束冲突（同一 trade_no 被报给第二个订单，正是
    // 幂等约束在生效）与任何 DB 抖动都会变成 500 HTML，重投多少次都是同样结果，
    // 形成无意义的重投风暴，且不留任何痕迹。
    logger.error("epay.notify_failed", { order: orderCode, tradeNo }, error);
    await writeNotifyTx("rejected", TxDetail.internalError).catch(() => undefined);
    return new NextResponse("success", { status: 200 });
  }
}
