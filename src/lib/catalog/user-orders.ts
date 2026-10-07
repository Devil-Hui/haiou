import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { listOrdersByOwner } from "./order-owner";

// 买家的「我的订单」与「我的卡密」。
//
// 归属判定与访客列表**共用 order-owner.ts 的 orderOwnedBy()**：登录用户与访客
// 必须看到完全相同的订单集合，否则会出现"登录后看不到自己买过的单"这种分裂。
// 历史背景：此前这里直接 `eq(orders.email, user.email)`，而 orders.email 是
// **激活邮箱**；买家若用另一个邮箱注册本站，个人中心就永远是 0 笔。
// 现在归属判定改为「购买邮箱相等，或（历史订单）激活邮箱相等」。

/** 列出某个邮箱名下的订单。includeNote=true 时返回运营处理说明（仅登录用户）。 */
export async function listUserOrders(email: string, status: string, page: number) {
  return listOrdersByOwner(email, status, page, { includeNote: true });
}

/**
 * 取一行订单，并判定它是否属于该邮箱。
 *
 * 归属判定直接在 SQL 里做，与 orderOwnedBy 完全同源（不重述条件）——
 * 这类"同一口径写两遍"的地方正是日后漂移的起点。
 */
export async function findOwnedOrder(email: string, orderId: string) {
  const [row] = await db
    .select({
      id: orders.id,
      code: orders.code,
      planId: orders.planId,
      planName: orders.planName,
      status: orders.status,
      // 只取判归属必需的列：deliveryTokenHash / cardPasswordHash 绝不能外泄。
      email: orders.email,
      purchaseEmail: orders.purchaseEmail,
      deliveryTokenHash: orders.deliveryTokenHash,
      cardPasswordHash: orders.cardPasswordHash,
    })
    .from(orders)
    .where(and(
      eq(orders.id, orderId),
      or(
        eq(orders.purchaseEmail, email),
        and(isNull(orders.purchaseEmail), eq(orders.email, email)),
      ),
    ))
    .limit(1);
  return row ?? null;
}
