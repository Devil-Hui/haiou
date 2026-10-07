import { createVerify } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { orderTotal, toUsdt } from "@/lib/catalog";
import { getPaymentSettings } from "@/lib/catalog";
import { binanceGateway, binanceTimestampFresh } from "@/lib/payments";
import { binancePublicKeyPem } from "@/lib/payments/binance-cert";
import { markPaid, isApplied, needsManualReview } from "@/lib/payments";
import { recordTx, TxDetail, sanitizePayload, txStatusFor, txDetailFor } from "@/lib/payments/tx";
import { rateLimit } from "@/lib/auth";
import { logger } from "@/lib/core";

// 币安支付异步通知。
//
// 【协议要求，违反任何一条都会丢单】
//   · 成功必须回 HTTP 200 且 body 为 "SUCCESS"
//   · 失败必须回 200 + {"returnCode":"FAIL"}，币安会重投最多 6 次
//   · 重投是幂等的：markPaid 的 transactionId 唯一约束保证重复通知不会重复入账
//
// 因此本路由**任何情况下都回 200**——把「HTTP 状态码」当作错误 signalling 会让
// 币安把一次真正的成功当成失败反复重投，而站内其实已经入账了。
// 真正的失败语义通过 body 的 returnCode 传递。
//
// 【验签为什么在解析之前】
// 币安用 RSA-SHA256 + 币安公钥签名，签名原文是 `timestamp\nnonce\n原始body\n`。
// 必须在拿到**原始字节**之后才能验：任何 JSON 反序列化再序列化都会改变字段顺序
// 与空格，签名立刻失效。因此这里先 text() 再验签，之后才交给网关做结构解析。

/** 构造待验签原文。首尾 \n 是官方规范的一部分，缺一个就验不过。 */
const signContent = (timestamp: string, nonce: string, body: string) => `${timestamp}\n${nonce}\n${body}\n`;

export async function POST(request: Request) {
  // 限流先行：未通过验签的请求不应该消耗 RSA 运算。
  // 币安会重投，因此 429 是安全的——真正的通知稍后会再来。
  if (!rateLimit(request, "binance-notify", 120)) return acknowledge(false, "rate limited");

  if (!binanceGateway.isReady()) {
    logger.warn("binance.notify_not_configured", {});
    return acknowledge(false, "not configured");
  }

  const timestamp = request.headers.get("binancepay-timestamp") || "";
  const nonce = request.headers.get("binancepay-nonce") || "";
  const signature = request.headers.get("binancepay-signature") || "";
  // 证书序列号（公钥 MD5）。不校验它也可以（签名本身已足够），
  // 但记录下来便于日后排查"是不是换了证书之后开始丢单"。
  const certSn = request.headers.get("binancepay-certificate-sn") || "";
  if (!/^\d{10,20}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !signature) {
    logger.audit("binance.notify_bad_headers", { certSn: certSn || null });
    return acknowledge(false, "bad headers");
  }
  // 时间窗：没有这一条，一份历史合法通知可以被无限期重放。
  if (!binanceTimestampFresh(timestamp)) {
    logger.audit("binance.notify_stale_timestamp", { certSn: certSn || null });
    return acknowledge(false, "stale timestamp");
  }

  const raw = await request.text();
  if (raw.length > 32768) return acknowledge(false, "payload too large");

  // ---- RSA-SHA256 验签 ----
  // 验签失败时不写流水：此时连订单号都不可信，而流水需要 orderId 外键。
  // 只记审计日志 —— 这类事件要靠日志发现，不属于任何一笔具体订单。
  let verified = false;
  try {
    const publicKey = await binancePublicKeyPem();
    const ok = createVerify("RSA-SHA256")
      .update(signContent(timestamp, nonce, raw), "utf8")
      .verify(publicKey, Buffer.from(signature, "base64"));
    verified = ok;
  } catch (error) {
    logger.error("binance.notify_verify_error", { certSn: certSn || null }, error);
    return acknowledge(false, "verify error");
  }
  if (!verified) {
    logger.audit("binance.notify_verify_failed", { certSn: certSn || null });
    return acknowledge(false, "verify failed");
  }

  // ---- 验签通过：交给网关做结构解析与字段校验 ----
  let notification;
  try {
    notification = await binanceGateway.verifyNotification({
      readRawBody: async () => raw,
      headers: request.headers,
      clientIp: null,
    });
  } catch (error) {
    logger.audit("binance.notify_bad_payload", { reason: (error as Error).message });
    return acknowledge(false, "bad payload");
  }

  const [order] = await db.select().from(orders).where(eq(orders.code, notification.orderCode));
  if (!order) {
    logger.audit("binance.notify_unknown_order", { order: notification.orderCode });
    // 币安在 24 小时无活动的订单会被自动关闭。若通知晚于本站订单清理，
    // 这里返回 SUCCESS 是对的：订单确实已不存在，重投也不会有不同结果。
    return acknowledge(false, "unknown order");
  }

  const writeNotifyTx = (status: "succeeded" | "failed" | "pending" | "rejected", detail?: string) =>
    recordTx({
      orderId: order.id, gateway: "binance", event: "notify", status,
      tradeNo: notification.tradeNo || null, amount: notification.amount || null,
      currency: "usdt", payload: sanitizePayload(notification.raw), detail,
    });

  // 非成功终态同样留痕：PAY_CLOSED（超时关单）是需要运营回看的信号，
  // 不记就只剩一条没有上下文的日志。
  if (notification.status !== "succeeded") {
    await writeNotifyTx(notification.status === "pending" ? "pending" : "failed", TxDetail.gatewayRejected);
    logger.audit("binance.notify_not_paid", { order: notification.orderCode, status: notification.status });
    return acknowledge(false, "not paid");
  }

  // ---- 金额核对 ----
  // 币安按 USDT 计价，而 orders 记的是人民币。核对必须两侧都换算到同一单位：
  //   本站应付人民币 → 按锁定汇率折成 USDT → 与币安上报的 USDT 比。
  // 直接拿人民币与 USDT 比是纯 bug（119 元 vs 16.5 USDT，永远不符）。
  // 汇率取下单时锁定的 usdtAmount 反推，而不是读当前汇率：
  // 买家按下单那一刻的汇率付款，事后汇率变了不该让他付第二遍。
  const settings = await getPaymentSettings();
  const expectedUsdt = order.usdtAmount ?? toUsdt(orderTotal(order), settings.exchangeRate);
  const received = Number(notification.amount);
  const expected = Number(expectedUsdt);
  if (!Number.isFinite(received) || Math.abs(received - expected) >= 0.01) {
    await writeNotifyTx("rejected", TxDetail.amountMismatch);
    logger.audit("binance.notify_amount_mismatch", { order: notification.orderCode, expectedUsdt, received: notification.amount });
    // 金额不符是真实的资金问题（少付/错付/伪造），必须让币安重投以便留下痕迹。
    return acknowledge(false, "amount mismatch");
  }

  const transactionId = `binance:${notification.tradeNo}`;
  try {
    const result = await markPaid(order.id, transactionId, "binance", (target) => {
      if (target.paymentMethod !== "binance") return false;
      const targetUsdt = target.usdtAmount ?? toUsdt(orderTotal(target), settings.exchangeRate);
      return Math.abs(Number(targetUsdt) - Number(expectedUsdt)) < 0.01;
    });
    await writeNotifyTx(txStatusFor(result), txDetailFor(result) || undefined);
    if (needsManualReview(result)) {
      // 过期到账 / 取消后到账 / 重复扣款都是真实资金问题，必须被告警看到。
      logger.error("binance.notify_needs_manual_review", { order: notification.orderCode, tradeNo: notification.tradeNo, result });
    } else {
      logger.audit("binance.notify_processed", { order: notification.orderCode, tradeNo: notification.tradeNo, result });
    }
    return acknowledge(isApplied(result) || needsManualReview(result), null);
  } catch (error) {
    // 返回 FAIL 让币安重投（最多 6 次）。markPaid 的异常通常是唯一约束冲突或
    // DB 抖动，重试有机会成功；不重投则钱到了但订单永远 pending。
    logger.error("binance.notify_failed", { order: notification.orderCode, tradeNo: notification.tradeNo }, error);
    await writeNotifyTx("rejected", TxDetail.internalError).catch(() => undefined);
    return acknowledge(false, "internal error");
  }
}

/**
 * 币安要求的应答格式。
 *
 * 无论成功失败都是 HTTP 200：状态码是给中间层看的，币安只看 body 里的
 * returnCode。用 4xx/5xx 表达失败会让币安把已成功的通知当失败处理。
 */
function acknowledge(success: boolean, message: string | null): Response {
  return new Response(JSON.stringify({ returnCode: success ? "SUCCESS" : "FAIL", returnMessage: message }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
