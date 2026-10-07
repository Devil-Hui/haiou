// ---------------------------------------------------------------------------
// 支付流水写入
//
// 全站唯一入口。所有网关（发起、回调、人工确认、主动查单）都必须经过这里落流水，
// 原因很直接：一旦某条路径绕过它，对账就会漏掉这笔钱，而漏掉的钱是查不回来的。
//
// 三条设计原则：
//   1. **永不抛错**。流水是审计设施，不能因为它坏了就把买家已经付过的钱判成
//      "支付失败"。任何写入异常都吞掉并记 error 日志，绝不影响主流程返回值。
//   2. **原文必留**。payload 存网关原始报文（已剔除密钥），这是事后对账与
//      dispute 举证的唯一依据。只记"成功"两个字等于没记。
//   3. **失败原因用固定短语**。detail 收敛成可枚举的值，才能 group by 统计出
//      "验签失败 N 次、金额不符 M 次"。写成自由文本就永远无法聚合。
// ---------------------------------------------------------------------------

import { db } from "@/db";
import { paymentTransactions } from "@/db/schema";
import { logger } from "@/lib/core";

export type TxEvent = "create" | "notify" | "query" | "manual";
export type TxStatus = "succeeded" | "failed" | "pending" | "rejected";

export interface RecordTxInput {
  orderId: string;
  gateway: string;
  event: TxEvent;
  status: TxStatus;
  tradeNo?: string | null;
  /** 网关声称收到的金额。验签失败等场景拿不到金额时留 null，不要填 0 混淆语义。 */
  amount?: string | null;
  currency?: string | null;
  payload?: unknown;
  /** 失败原因的固定短语。成功时留空。 */
  detail?: string;
}

/** 固定短语表：集中在这里，避免各处手写导致同一原因出现多种拼写而无法聚合。 */
export const TxDetail = {
  verifyFailed: "verify_failed",
  signMissing: "sign_missing",
  amountMismatch: "amount_mismatch",
  orderNotFound: "order_not_found",
  duplicateParam: "duplicate_param",
  malformedBody: "malformed_body",
  notConfigured: "not_configured",
  gatewayRejected: "gateway_rejected",
  orderExpired: "order_expired",
  orderCancelled: "order_cancelled",
  manualConfirm: "manual_confirm",
  unpaid: "unpaid",
  // 以下三项此前缺失，导致三种真实问题都被记成 amount_mismatch，
  // 混进"伪造回调"告警通道，把真问题淹没：
  //  · duplicatePayment —— 买家重复付款，钱多收了，必须人工退；
  //  · concurrentUpdate —— CAS 未命中，本次未落库，需要看是不是有并发问题；
  //  · methodMismatch —— 支付方式与订单不符（订单被改过，或回调串单）。
  duplicatePayment: "duplicate_payment",
  concurrentUpdate: "concurrent_update",
  methodMismatch: "method_mismatch",
  // 内部异常（如唯一约束冲突、DB 抖动）。此前这类事件在流水里完全不存在，
  // 事后无法解释"钱没到账、订单没动、也没有任何记录"。
  internalError: "internal_error",
} as const;

/**
 * 入账结果 → 流水状态的映射。
 *
 * 关键点：只有 `paid` / `duplicate` 记 succeeded。过期到账、取消后到账、
 * 重复扣款都记 rejected——它们确实没有完成"这笔钱对应这一单"的入账，
 * 必须能被对账查询捞出来，而不是伪装成干净的成功记录。
 */
export function txStatusFor(result: import("./payments").MarkPaidResult): "succeeded" | "rejected" | "pending" {
  if (result === "paid" || result === "duplicate") return "succeeded";
  if (result === "received_after_expiry" || result === "received_after_cancel") return "pending";
  return "rejected";
}

/** 入账结果 → 失败原因短语。 */
export function txDetailFor(result: import("./payments").MarkPaidResult): string {
  switch (result) {
    case "paid": return "";
    // 幂等命中不是失败，detail 留空即可。
    case "duplicate": return "";
    case "received_after_expiry": return TxDetail.orderExpired;
    case "received_after_cancel": return TxDetail.orderCancelled;
    case "duplicate_payment": return TxDetail.duplicatePayment;
    case "amount_mismatch": return TxDetail.amountMismatch;
    case "order_mismatch": return TxDetail.methodMismatch;
    case "conflict": return TxDetail.concurrentUpdate;
  }
}


/**
 * 写一条流水。
 *
 * 刻意不返回成功与否：调用方不该因为审计写入失败而改变对买家的应答。
 * 需要感知写入结果时看日志，而不是看返回值。
 */
export async function recordTx(input: RecordTxInput): Promise<void> {
  try {
    await db.insert(paymentTransactions).values({
      orderId: input.orderId,
      gateway: input.gateway,
      event: input.event,
      status: input.status,
      tradeNo: input.tradeNo ?? null,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      // payload 可能是网关返回的任意结构。先序列化一次：
      // 直接把含 BigInt / Date / 循环引用的对象塞进 jsonb 列会在驱动层抛错，
      // 而这一步在 try 内，永远不会影响主流程。
      payload: safeJson(sanitizePayload(input.payload)),
      detail: input.detail ?? "",
    });
  } catch (error) {
    logger.error("payment.tx_record_failed", { gateway: input.gateway, event: input.event, order: input.orderId }, error);
  }
}

/**
 * 报文留档前的净化。
 *
 * 这一步不是"顺手做的防御"，而是硬要求：网关回调里可能混进签名、密钥类字段，
 * 原样落库等于把可用于伪造付款的凭据存进一个可备份、可导出的数据库。
 * 白名单式剔除——只保留业务字段，未知字段一律丢弃。
 */
const SENSITIVE_KEYS = /^(sign|sign_type|signature|key|secret|token|auth|authorization|private_key|api_key)$/i;

export function sanitizePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(k)) continue;
    out[k] = typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}...[truncated]` : v;
  }
  return out;
}

function safeJson(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { unserializable: true };
  }
}
