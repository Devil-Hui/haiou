import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { markPaid, USDT_CONTRACT, isApplied, needsManualReview } from "@/lib/payments";
import { recordTx, TxDetail, sanitizePayload, txStatusFor, txDetailFor } from "@/lib/payments/tx";
import { validUuid } from "@/lib/auth";
import { logger, apiError, ErrorCode } from "@/lib/core";

const units = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, "0")); };

// Adapter boundary: only a trusted, external chain watcher may call this endpoint.
// The watcher must independently verify confirmed TRON USDT transfers and correlate
// them with orders. This application does NOT pretend to run a chain indexer.
export async function POST(request: Request) {
  const secret = process.env.USDT_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) return apiError(ErrorCode.UPSTREAM_DISABLED, "USDT 链上确认适配器未启用，请在核实到账后由管理员手动确认", 501);
  const timestamp = request.headers.get("x-aura-timestamp") || "";
  const signature = request.headers.get("x-aura-signature") || "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/i.test(signature)) return apiError(ErrorCode.AUTH_INVALID, "Invalid webhook credentials", 401);
  const raw = await request.text();
  if (raw.length > 8192) return apiError(ErrorCode.PAYLOAD_TOO_LARGE, "Payload too large", 413);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return apiError(ErrorCode.AUTH_INVALID, "Invalid signature", 401);
  try {
    const event = JSON.parse(raw);
    if (typeof event.orderId !== "string" || !validUuid(event.orderId) || !/^[a-f0-9]{64}$/i.test(event.transactionId || "") || event.confirmed !== true || event.network !== "TRON" || event.contract !== USDT_CONTRACT || typeof event.amount !== "string" || !/^\d{1,8}(\.\d{1,6})?$/.test(event.amount)) return apiError(ErrorCode.VALIDATION_FAILED, "Invalid confirmed transfer", 400);
    const result = await markPaid(event.orderId, `tron:${event.transactionId.toLowerCase()}`, "usdt", order => !!order.walletAddress && event.to === order.walletAddress && !!order.usdtAmount && units(event.amount) === units(order.usdtAmount));
    // 链上确认事件同样落流水：event 记 manual（外部观察者上报），
    // payload 保留链上回执字段，dispute 时可与链上记录逐字比对。
    //
    // 三个修正：
    //   1. amount 此前写死 null，但 event.amount 刚校验过、markPaid 刚拿它做过
    //      1e6 定点比对。USDT 是三条通道里唯一没有金额列的，流水表与订单表
    //      的"少付/多付"交叉核对能力在这里完全失效。
    //   2. tradeNo 此前记裸 txid，而 orders.transactionId 记 tron: 前缀，
    //      按 (gateway, trade_no) 反查时对不上。
    //   3. detail 此前非成功一律 amount_mismatch，掩盖了重复扣款等成因。
    await recordTx({
      orderId: event.orderId, gateway: "usdt", event: "manual",
      status: txStatusFor(result),
      tradeNo: `tron:${event.transactionId.toLowerCase()}`,
      amount: event.amount, currency: "usdt",
      payload: sanitizePayload(event),
      detail: txDetailFor(result) || TxDetail.manualConfirm,
    });
    if (needsManualReview(result)) {
      logger.error("usdt.confirm_needs_manual_review", { order: event.orderId, tx: event.transactionId, result, amount: event.amount });
    } else {
      logger.audit("usdt.confirm_processed", { order: event.orderId, tx: event.transactionId, result });
    }
    return NextResponse.json({ success: isApplied(result), result }, { status: isApplied(result) ? 200 : 400 });
  } catch (error) {
    // 此前是裸 catch{}：DB 抖动与"金额/收款地址不匹配"两种完全不同的情况
    // 都会返回同一个 409 且不留任何痕迹，线上无法区分是系统故障还是数据不符。
    logger.error("usdt.confirm_failed", {}, error);
    return apiError(ErrorCode.CONFLICT_STATE, "Transfer does not match or was already assigned to another order", 409);
  }
}
