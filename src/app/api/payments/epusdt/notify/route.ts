import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { orderTotal } from "@/lib/catalog";
import { epusdtGateway, signParams, safeEqualHex } from "@/lib/payments";
import { markPaid, isApplied, needsManualReview } from "@/lib/payments";
import { recordTx, TxDetail, sanitizePayload, txStatusFor, txDetailFor } from "@/lib/payments/tx";
import { rateLimit } from "@/lib/auth";
import { logger } from "@/lib/core";

// epusdt 异步通知。
//
// 【协议要求，取自 BEpusdt 官方文档】
//   · 支付成功回调：必须回 HTTP 200 + body `ok`（大小写不敏感）
//   · 失败会按 2→4→8→16→32→64… 分钟指数退避重投，最多 10 次
//   · 「等待支付」与「支付超时」回调：只要 HTTP 200 就算成功，不重试
// 所以本路由所有分支都必须显式给出应答体，不能靠框架默认返回。
//
// 【验签为什么必须在读 body 之后、解析之前】
// HMAC 是对**原始字节**算的。任何 JSON 反序列化再序列化都会改变字段顺序与空格，
// 签名立刻失效。因此先 text() 存原文，验签用原文，解析用 JSON.parse 结果——
// 两份数据各司其职，不要图省事只用其中一份。

export async function POST(request: Request) {
  // 限流先行：未验签的请求不该消耗 HMAC 计算。
  // epusdt 会重投，因此 429 安全——真正的通知稍后会再来。
  if (!rateLimit(request, "epusdt-notify", 120)) return acknowledge(false);

  if (!epusdtGateway.isReady()) {
    logger.warn("epusdt.notify_not_configured", {});
    return acknowledge(false);
  }

  const raw = await request.text();
  if (raw.length > 16384) return acknowledge(false);

  // ---- 验签 ----
  // 失败时不写流水：此时连订单号都不可信，而流水需要 orderId 外键。
  // 只记审计日志——这类事件要靠日志发现，不属于任何一笔具体订单。
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.audit("epusdt.notify_bad_payload", {});
    return acknowledge(false);
  }

  const provided = typeof payload.signature === "string" ? payload.signature : "";
  if (!provided) {
    logger.audit("epusdt.notify_sign_missing", { order: typeof payload.order_id === "string" ? payload.order_id : null });
    return acknowledge(false);
  }
  // BEpusdt 只有一个 API Token，没有 PID+secret 的双凭证结构。
  const token = process.env.EPUSDT_TOKEN?.trim();
  if (!token || !safeEqualHex(signParams(payload, token), provided)) {
    logger.audit("epusdt.notify_verify_failed", { order: typeof payload.order_id === "string" ? payload.order_id : null });
    return acknowledge(false);
  }

  // ---- 绑定本站 token，防止跨站重放 ----
  // 纯 Bearer 式 token 无法区分"哪个商户"，因此要求回调里带上本站订单前缀。
  // 本站订单号恒以 AU 开头（见 core/codes.ts 的 newOrderCode），不满足的直接拒。
  // 这拦不住知道 token 的攻击者伪造金额，但能挡住"把 A 站的合法通知原样
  // 重放给 B 站"这类低成本跨站注入。
  const orderId = typeof payload.order_id === "string" ? payload.order_id : "";
  if (!/^AU\d{8}[0-9A-F]{8}$/.test(orderId)) {
    logger.audit("epusdt.notify_foreign_order", { order: orderId || null });
    return acknowledge(false);
  }

  // ---- 重放防护 ----
  //
  // epusdt 回调**不带**任何时间戳字段，因此无法做时间窗校验。
  // 此前这里写的是 `epusdtTimestampFresh(String(Date.now()))`：拿"当前时刻"
  // 和"当前时刻"比，差值恒为 0 → 恒为真 → 一次也不会拦截。
  // 假防线比没有防线更危险：读代码的人会以为重放已被挡住，从而不再补真的防护，
  // 而告警里也永远不会出现 notify_stale 这条线索。已删除。
  //
  // 真正的重放兜底在下面 markPaid 里：orders.transaction_id 有唯一约束，
  // 同一个 trade_id 二次入账会被识别为 duplicate，不会重复记一笔钱。
  // 这是**幂等**而非**防重放**，但它保证了重放的后果是"无事发生"，这才是关键。

  // ---- 结构解析（字段校验交给网关）----
  let notification;
  try {
    notification = await epusdtGateway.verifyNotification({
      readRawBody: async () => raw,
      headers: request.headers,
      clientIp: null,
    });
  } catch (error) {
    logger.audit("epusdt.notify_bad_payload", { reason: (error as Error).message });
    return acknowledge(false);
  }

  const [order] = await db.select().from(orders).where(eq(orders.code, notification.orderCode));
  if (!order) {
    // 订单不存在（已被清理）。返回 success 是对的：重投也不会有不同结果，
    // 而返回 fail 只会让 epusdt 白白重投若干次。
    logger.audit("epusdt.notify_unknown_order", { order: notification.orderCode });
    return acknowledge(true);
  }

  const writeNotifyTx = (status: "succeeded" | "failed" | "pending" | "rejected", detail?: string) =>
    recordTx({
      orderId: order.id, gateway: "epusdt", event: "notify", status,
      tradeNo: notification.tradeNo || null, amount: notification.amount || null,
      currency: "cny", payload: sanitizePayload(notification.raw), detail,
    });

  // 非成功终态同样留痕：已过期是需要运营回看的信号，不记就只剩一条无上下文的日志。
  if (notification.status !== "succeeded") {
    await writeNotifyTx(notification.status === "pending" ? "pending" : "failed", TxDetail.gatewayRejected);
    logger.audit("epusdt.notify_not_paid", { order: notification.orderCode, status: notification.status });
    // 已过期是终态，重投无意义，答 success 让它停；等待支付则答 fail 让它继续重试。
    return acknowledge(notification.status === "pending");
  }

  // ---- 金额核对 ----
  // epusdt 的 amount 是**法币**金额，与 orderTotal 同一口径，可直接比。
  // （这里的 amount 来自 order_id 关联到的本地订单，与主动查单不同——查单不返回金额。）
  const expected = orderTotal(order);
  const received = Number(notification.amount);
  if (!Number.isFinite(received) || Math.abs(received - Number(expected)) >= 0.01) {
    await writeNotifyTx("rejected", TxDetail.amountMismatch);
    logger.audit("epusdt.notify_amount_mismatch", { order: notification.orderCode, expected, received: notification.amount });
    // 金额不符是真实资金问题（少付/错付），必须让网关重投以留下痕迹。
    return acknowledge(false);
  }

  const transactionId = `epusdt:${notification.tradeNo}`;
  try {
    const result = await markPaid(order.id, transactionId, "epusdt", (target) => {
      // paymentMethod 必须复核：订单的支付方式是下单时锁定的，
      // 一条 epusdt 通知不能把一个"支付宝待付"订单变成已支付。
      if (target.paymentMethod !== "epusdt") return false;
      return Math.abs(Number(orderTotal(target)) - Number(expected)) < 0.01;
    });
    await writeNotifyTx(txStatusFor(result), txDetailFor(result) || undefined);
    if (needsManualReview(result)) {
      // 过期到账 / 取消后到账 / 重复扣款都是真实资金问题，必须被告警看到。
      logger.error("epusdt.notify_needs_manual_review", { order: notification.orderCode, tradeNo: notification.tradeNo, result });
    } else {
      logger.audit("epusdt.notify_processed", { order: notification.orderCode, tradeNo: notification.tradeNo, result });
    }
    // 已入账 / 幂等 / 重复扣款 → 成功应答（钱已收到，重投只会重复插流水）。
    // 需要人工核对 → 也应答成功，否则网关会在数小时内反复重投刷爆表和日志。
    return acknowledge(isApplied(result) || needsManualReview(result));
  } catch (error) {
    // 返回 fail 让 epusdt 重投。markPaid 的异常通常是唯一约束冲突或 DB 抖动，
    // 重试有机会成功；不重投则钱到了但订单永远 pending。
    logger.error("epusdt.notify_failed", { order: notification.orderCode, tradeNo: notification.tradeNo }, error);
    await writeNotifyTx("rejected", TxDetail.internalError).catch(() => undefined);
    return acknowledge(false);
  }
}

/**
 * epusdt 要求的应答格式。
 *
 * 成功体必须是 `ok` 或 `success`（大小写不敏感），失败则必须非 200。
 * 刻意不返回 JSON：网关是按纯文本匹配的，返回 JSON 会被判失败并持续重投。
 */
function acknowledge(success: boolean): Response {
  // 必须是纯文本 `ok`；返回 JSON 会被判定失败并持续重投。
  return new Response(success ? "ok" : "fail", {
    status: success ? 200 : 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
