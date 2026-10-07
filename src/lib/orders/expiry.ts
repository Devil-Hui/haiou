// ---------------------------------------------------------------------------
// 过期订单清理
//
// 买家下单不付款很常见。没有清理时这些订单永远停在 pending，后台「待支付」里
// 混着大量早就放弃的单，运营无法判断哪些在真实流转，列表也越积越长。
//
// 处置选「过期」而不是「取消」，因为语义不同：expired 是系统判定买家没付、
// 订单自然失效；cancelled 是买家或运营主动取消。分开才能在数据层回答
// "这笔单是怎么结束的"。
//
// 并发安全：整段是一个带 CAS 的 UPDATE。买家恰好在扫描瞬间付款时，markPaid
// 持有行锁，二者必然串行化，不会把已付款的订单误判为过期。
// ---------------------------------------------------------------------------

import { db } from "@/db";
import { orders } from "@/db/schema";
import { logger } from "@/lib/core";
import { and, eq, inArray, lt } from "drizzle-orm";

const BATCH = 200;

export interface ExpireResult {
  scanned: number;
  expired: number;
}

export async function expireStaleOrders(now: Date = new Date()): Promise<ExpireResult> {
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "pending"), lt(orders.expiresAt, now)))
    .limit(BATCH);

  if (due.length === 0) return { scanned: 0, expired: 0 };

  const ids = due.map((row) => row.id);
  // CAS：只命中仍是 pending 且已过期的行。某单若在扫描后被付款或取消则不命中，
  // 因此不会把已付款的订单误判为过期。
  const updated = await db
    .update(orders)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(orders.status, "pending"), lt(orders.expiresAt, now), inArray(orders.id, ids)));

  const expired = updated.rowCount ?? 0;
  if (expired > 0) logger.audit("order.auto_expired", { count: expired });
  return { scanned: due.length, expired };
}

export async function runExpirySweep(): Promise<ExpireResult> {
  const total: ExpireResult = { scanned: 0, expired: 0 };
  for (let round = 0; round < 20; round++) {
    const result = await expireStaleOrders();
    total.scanned += result.scanned;
    total.expired += result.expired;
    if (result.scanned < BATCH) break;
  }
  return total;
}
