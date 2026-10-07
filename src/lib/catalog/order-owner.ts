import { and, count, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { checkPassword } from "@/lib/auth";

// ---------------------------------------------------------------------------
// 订单归属：购买邮箱 与 激活邮箱
//
// 【两种邮箱，必须分开】
//   · 激活邮箱（orders.email）
//     买家在 ChatGPT / Claude 等平台注册的邮箱，即本次要充值的那个账号。
//     充值链路（submitRecharge）按它比对，交付闸门也按它判。
//   · 购买邮箱（orders.purchaseEmail）
//     买家在本站用于查询/管理订单的邮箱。可以与激活邮箱不同——
//     很多人注册本站用的是别名或工作邮箱，而充值用的是主邮箱。
//
// 【为什么不能只留一个】
// 个人中心按购买邮箱查，充值按激活邮箱查。两者在「B 邮箱注册、A 邮箱充值」时不相等，
// 共用一列的结果是：用户注册了、也付了钱，但个人中心显示 0 笔订单。
// 这是最伤信任的一类问题——不是显示错，是"看不到自己付过钱"。
//
// 【历史数据兼容】
// 改造前的订单没有 purchaseEmail（全为 NULL）。归属判定必须回退到 email，
// 否则上线瞬间所有老订单都会从个人中心消失。这类"加列"改动最常见的翻车点。
// ---------------------------------------------------------------------------

/**
 * 归属判定条件：某个邮箱是否拥有某订单。
 *
 * 命中条件是「购买邮箱相等」**或**「激活邮箱相等」**或**「历史订单（购买邮箱为空）」。
 *
 * 为什么激活邮箱也算命中：激活邮箱是买家在结算页主动填的、要充值的那个账号邮箱，
 * 买家本人完全知道它。把它纳入命中范围，才能做到你说的
 *「无论用购买邮箱还是激活邮箱，都能查到自己的全部订单」——
 * 实测确认过：若只认购买邮箱，一个用B 邮箱注册本站、用 A 邮箱充值的买家，
 * 拿A 邮箱来查会显示 0 笔，他会以为订单丢了。
 *
 * 这样做是否会引入越权？不会：
 *   · 订单详情页（/api/orders/[id]）的归属判定**不走这里**，它只认 UUID；
 *   · 取卡密、支付、充值进度三处的归属判定走的是各自的凭据
 *     （取卡码 / 取卡密码 / 订单号+取卡码），**不依赖邮箱**；
 *   · 因此"能列出某邮箱的订单"并不等于"能取走卡密"。
 *   · `/api/orders/auth`（凭密码查）即便被猜到邮箱，仍需 scrypt 校验的取卡密码。
 * 换句话说，订单列表是**弱信息**（订单号、套餐、金额、状态），
 * 真正的护栏始终在取卡环节，邮箱不承担授权职责。
 */
export function orderOwnedBy(email: string): SQL {
  return or(
    eq(orders.purchaseEmail, email),
    eq(orders.email, email),
    // 历史订单：没有购买邮箱，只能靠激活邮箱。上面已覆盖，这里保留 isNull 分支
    // 是为了让「未设购买邮箱」的老订单在该邮箱下也能命中（与上面同义，
    // 但显式写出能让意图在SQL 里自解释，避免后来人以为漏了 NULL 分支）。
    and(isNull(orders.purchaseEmail), eq(orders.email, email)),
  ) as SQL;
}

/** 归属判定 + 状态过滤，用于列表与计数。 */
export function orderOwnerFilter(email: string, status?: string): SQL | undefined {
  const owned = orderOwnedBy(email);
  return status ? and(owned, eq(orders.status, status)) : owned;
}

const USER_ORDER_STATUSES = ["pending", "paid", "processing", "completed", "cancelled", "expired", "refunded"] as const;

/** 可筛选的订单状态白名单。status 是自由文本列，未校验会把任意字符串送进查询条件。 */
export const allowedOrderStatus = (value: string): string | undefined =>
  value && (USER_ORDER_STATUSES as readonly string[]).includes(value) ? value : undefined;

const PAGE_SIZE = 10;

export type UserOrderRow = {
  id: string; code: string; planName: string; brand: string; period: string;
  amount: string; feeAmount: string; discountAmount: string;
  status: string; paymentMethod: string; note: string;
  createdAt: string; updatedAt: string;
  /** 订单是否可凭「购买邮箱 + 取卡密码」取卡。为 false 时只能凭一次性取卡码。 */
  passwordProtected: boolean;
};

/**
 * 按归属邮箱分页列出订单。
 *
 * 个人中心（登录态）与访客列表（邮箱+密码）**共用这一个函数** ——
 * 两者判定口径必须完全一致，否则会出现"登录后看不到、访客却能看到"的分裂。
 */
export async function listOrdersByOwner(
  email: string,
  status: string,
  page: number,
  options: { includeNote?: boolean } = {},
): Promise<{ items: UserOrderRow[]; total: number; page: number; pageSize: number; totalPages: number }> {
  // 分页上限收敛到 1000 页（每页 10 条 = 可翻 1 万条），与 admin 侧的分页上限方针一致：
  // offset = (page-1)*PAGE_SIZE 是廉价 DoS 旋钮，越界页会让数据库扫过海量行再丢弃。
  // 此前这里是 10000（10 万条），深分页扫描 + 首日期 DESC 排序的开销没必要保留。
  // 这里是数据层兜底，路由层也 clamp 到同一数值（见 account/me）。
  const safePage = Math.max(1, Math.min(1000, Math.floor(Number(page)) || 1));
  const where = orderOwnerFilter(email, allowedOrderStatus(status));
  const [rows, [total]] = await Promise.all([
    db.select({
      id: orders.id,
      code: orders.code,
      planName: orders.planName,
      brand: orders.brand,
      period: orders.period,
      amount: orders.amount,
      feeAmount: orders.feeAmount,
      // 缺这一列会让 orderTotal 的 discountAmount 落空（它是可选参数，缺失按 0 处理），
      // 于是用了券的订单在个人中心显示的「实付金额」比买家实际付的贵 ——
      // 而表头恰恰写着「实付金额」。支付页显示的是对的，两处对不上。
      discountAmount: orders.discountAmount,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      note: orders.note,
      // 是否设了取卡密码：只回布尔值，**绝不回显摘要**。
      cardPasswordHash: orders.cardPasswordHash,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
    })
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt))
      .limit(PAGE_SIZE)
      .offset((safePage - 1) * PAGE_SIZE),
    db.select({ value: count() }).from(orders).where(where),
  ]);
  // 在数据层就把 Date 转成 ISO 字符串：Server Component → Client Component 的边界上
  // Date 不能直接传（会变成 "[object Date]" 或触发序列化告警）。在这里统一收口，
  // 比让每个消费方各自 map 一遍更不容易漏。
  const items: UserOrderRow[] = rows.map((row) => ({
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
    // note 只给登录用户看：它是运营写给买家的内部说明，访客列表不暴露。
    note: options.includeNote ? row.note : "",
    passwordProtected: !!row.cardPasswordHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const totalPages = Math.max(1, Math.ceil(total.value / PAGE_SIZE));
  return { items, total: total.value, page: Math.min(safePage, totalPages), pageSize: PAGE_SIZE, totalPages };
}

// 单次密码校验的最大候选行数。scrypt 约 100ms/次，100 次≈10 秒，已经是
// 一个请求能接受的延迟上限；超过这个量的订单数应当引导用户走客服而不是硬算。
const MAX_PASSWORD_CHECK = 100;

/**
 * 用「邮箱 + 取卡密码」证明 ownership，返回命中的订单 id 集合。
 *
 * 与 `/api/orders/auth`（查历史）是**同一套判定**，必须抽成同一个函数：
 * 两处若各自实现，日后必然出现「查得到订单但重置密码失败」或反过来的分裂，
 * 而这种分裂极难在测试里发现——它们只在特定邮箱下才不一致。
 *
 * 逐笔 scrypt **串行**校验：并发 100 次会瞬间占满 libuv 线程池（默认 4），
 * 把整个服务的其它请求一起堵死。
 */
export async function verifyOwnerCardPassword(email: string, password: string): Promise<string[]> {
  if (!password || password.length > 128) return [];
  const candidates = await db
    .select({ id: orders.id, cardPasswordHash: orders.cardPasswordHash })
    .from(orders)
    .where(and(orderOwnedBy(email), sql`${orders.cardPasswordHash} is not null`))
    .orderBy(desc(orders.createdAt))
    .limit(MAX_PASSWORD_CHECK);
  const matched: string[] = [];
  for (const row of candidates) {
    if (await checkPassword(password, row.cardPasswordHash as string)) matched.push(row.id);
  }
  return matched;
}

/**
 * 把该邮箱名下**所有**已设取卡密码的订单，统一改写为新密码的摘要。
 *
 * 为什么是「全部」而不是仅限matched：取卡密码本质是这个邮箱的**账号级凭据**，
 * 不是每笔订单各自一份。若只改命中那几笔，用户会拿到「有的单用新密码、
 * 有的单还要旧密码」的分裂状态，比不改更困惑。校验在调用方已完成，
 * 这里只负责写。
 *
 * 不设密码的订单（历史数据、或登录用户免填）保持为 null，仍走一次性取卡码。
 */
export async function rewriteOwnerCardPassword(email: string, nextHash: string): Promise<number> {
  const updated = await db
    .update(orders)
    .set({ cardPasswordHash: nextHash, updatedAt: new Date() })
    .where(and(orderOwnedBy(email), sql`${orders.cardPasswordHash} is not null`))
    .returning({ id: orders.id });
  return updated.length;
}
