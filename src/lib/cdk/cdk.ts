// ---------------------------------------------------------------------------
// 缓存失效的边界
//
// 本文件负责写数据，**不在 db.transaction 回调内部**调用 invalidatePlansCache()。
// 事务尚未 COMMIT 就清缓存，清得太早反而制造竞态：并发读者可能在提交后立刻
// cacheSet 回**旧值**，而失效已经发生过了 —— 之后 60 秒（PLANS_TTL_MS）内没人再清，
// remaining = stock - issued 会一直脏下去，有上限的 cdk 套餐在这段时间内可被超卖。
//
// 因此事务内的写入（核销 / 在线发放 / 补发）都不在此失效，由调用方在拿到
// **已提交**的结果后各调一次：admin-api、api/cdk/redeem、api/orders/[id]/delivery。
// 下方 generateCardKeys 与 revokeBatch 不在事务里，仍可在本文件直接失效。
// ---------------------------------------------------------------------------

import { and, count, desc, eq, inArray, like, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { cardKeys, orders, plans } from "@/db/schema";
import { digest } from "@/lib/auth";
import { newCdk, newOrderCode, normalizeCdk } from "@/lib/core";
import { invalidatePlansCache } from "@/lib/core";
import { getCdkRule } from "@/lib/catalog/store";

export const MAX_BATCH = 500;

// 在线售卖发放的卡密统一落在这一批名下，用于和后台批量生成的卡密池区分：
// 只有这一批计入套餐的在线库存上限。
export const ONLINE_BATCH = "online";

// 作废 online 批次时对外统一的说明（数据层与路由层共用同一句，避免两处措辞不一）。
export const ONLINE_BATCH_REVOKE_ERROR = "在线售卖批次（online）不可批量作废：其中的卡密都已售出并绑定订单，只等买家回来核销，一次误操作会让全站已付款的买家同时拿不到卡，且不可撤销。请按订单逐单处理。";

// 批次号的随机部分必须是 4 字节。此前只有 2 字节 = 65536 种，同一天生成 200 批
// 的撞号概率约 26%（20 批约 0.3%）。撞号不是"多了一批卡"这么轻：
// revokeBatch / listCardKeys 都按 batch 整体过滤，两批共用一个号时
// **作废 A 批会连带作废 B 批**，把买家已付款、尚未核销的卡一起废掉。
export function newBatch() {
  return `B${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

// 批次号唯一性在这里保证，**而不是靠数据库唯一索引**：card_keys 里一个批次对应
// N 行（generateCardKeys 一次插入最多 MAX_BATCH 行，batch 值完全相同），
// 给 batch 建唯一索引会让"一次生成 20 张"直接撞约束，批量生成整体不可用。
// 先查后插 + 撞号重试。残留风险是并发下的 check-then-insert 竞态，
// 但 4 字节随机（32 bit）下两人撞同一批号的概率已可忽略。
const BATCH_ATTEMPTS = 3;
async function uniqueBatch(): Promise<string> {
  for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
    const candidate = newBatch();
    const [taken] = await db.select({ id: cardKeys.id }).from(cardKeys).where(eq(cardKeys.batch, candidate)).limit(1);
    if (!taken) return candidate;
  }
  // 3 次都撞号说明该批次号空间已被占满（4 字节随机下几乎不可能）。
  // 宁可让这一次生成失败并报错，也不能悄悄复用别人的批次号 ——
  // 复用会让人为把它作废时连带作废另一批已售出的卡。
  throw new Error("BATCH_NO_AVAILABLE");
}

// 只把摘要写库，明文随本次返回值一次性交出。数据库被拖库时拿不到任何可用卡密——
// 代价是生成之后无法再回看，所以调用方必须当场展示或导出。
export async function generateCardKeys(planId: string, quantity: number, note: string, maxUses: number | null = null) {
  const size = Math.min(Math.max(Math.trunc(quantity) || 0, 1), MAX_BATCH);
  const batch = await uniqueBatch();
  // 规则从配置读：运营改前缀后，下一张卡立刻生效，不必改代码。
  const rule = await getCdkRule();
  const created = Array.from({ length: size }, () => newCdk(rule));
  await db.insert(cardKeys).values(
    created.map((code) => ({ codeHash: digest(normalizeCdk(code)), batch, planId, status: "unused", maxUses, note })),
  );
  // 批量生成改变了池内可用量 → 库存口径变化。
  invalidatePlansCache();
  return { batch, count: size, codes: created, rule };
}

// 单条 UPDATE 带状态条件完成"抢占"：并发下只有一条请求能成功，
// 不存在"先 SELECT 判断再 UPDATE"那种一码两用的竞态。
// 后续任何失败都靠抛错触发事务回滚，卡密会退回未使用状态。
//
// 次卡（maxUses > 1）不能复用同一条件：它核销后仍应保持"可用"，
// 只是次数用掉一次。因此这里用一条带条件的 UPDATE 完成"占一次"，
// 次数用尽时才把状态置为 used。
export async function redeemCardKey(code: string, email: string) {
  const hash = digest(normalizeCdk(code));
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: cardKeys.id, maxUses: cardKeys.maxUses, usedTimes: cardKeys.usedTimes })
      .from(cardKeys)
      .where(and(eq(cardKeys.codeHash, hash), eq(cardKeys.status, "unused")))
      .limit(1);
    if (!row) return null;
    const times = Number(row.usedTimes ?? 0);
    const max = row.maxUses ?? 1;
    if (times >= max) return null;

    // 条件里带上 used_times < max：并发下两个请求同时读到 times=0 时，
    // 只有一条能把 used_times 推到 1，另一条不满足条件而落空。
    const [claimed] = await tx
      .update(cardKeys)
      .set({ usedTimes: times + 1, status: times + 1 >= max ? "used" : "unused", usedAt: new Date() })
      .where(and(
        eq(cardKeys.id, row.id),
        eq(cardKeys.usedTimes, times),
        sql`${cardKeys.usedTimes} < ${max}`,
      ))
      .returning({ id: cardKeys.id, planId: cardKeys.planId, issueVersion: cardKeys.issueVersion });
    if (!claimed) return null;

    const [plan] = await tx.select().from(plans).where(eq(plans.id, claimed.planId));
    // 卡密卖出去之后套餐下架不应作废它，只有套餐被真正删除才需要人工介入
    if (!plan) throw new Error("PLAN_MISSING");

    // transactionId 上有唯一约束，必须同时区分「发放轮次」与「核销次序」：
    //   · 核销次序：次卡的每一次核销都会生成一张新订单，用同一个值会撞唯一约束；
    //   · 发放轮次：补发是就地换码（card_keys.id 不变），若不含轮次，补发后核销
    //     算出的值与第一次完全相同 → 撞唯一约束 → 事务回滚 → 卡密退回 unused，
    //     形成"重试多少次都核销不了"的死循环。
    // 缺了任何一半，补发功能都会 100% 失效。
    const transactionId = `${claimed.id}:v${claimed.issueVersion}` + (max > 1 ? `#${times + 1}` : "");

    // 取卡码（归属凭证）必须在核销时就生成。
    //
    // 此前 redeemCardKey 完全没写 delivery_token_hash，于是核销产生的订单
    // 归属凭证为空。而 POST /api/recharge（提交凭证）、POST /api/recharge/advance
    // （买家刷新进度）、GET /api/recharge（查进度）三处都以取卡码做归属校验，
    // 校验失败一律 403 "取卡码不正确" —— **卡密核销的用户完全无法提交充值**。
    //
    // 讽刺的是这条路径正是本站的主营流程：卖卡密给下游，下游核销后提交账号充值。
    // 付款下单的用户有 token（/api/orders 返回），核销的用户没有。
    const deliveryToken = randomBytes(24).toString("hex");

    const [order] = await tx
      .insert(orders)
      .values({
        code: newOrderCode(),
        planId: plan.id,
        planName: plan.name,
        brand: plan.brand,
        period: plan.period,
        amount: plan.price,
        email,
        paymentMethod: "cdk",
        // 卡密本身即已付款凭证，订单直接落在"已支付"，运营只需完成充值环节
        status: "paid",
        transactionId,
        // 卡密兑换不存在"待支付"阶段，因此不设支付截止时间；
        // 但付款时刻必须写，否则对账时这一类订单的 paid_at 全为空。
        paidAt: new Date(),
        note: "卡密兑换，已支付，等待人工充值。",
        deliveryTokenHash: digest(deliveryToken),
      })
      .returning({
        id: orders.id, code: orders.code, planName: orders.planName,
        brand: orders.brand, createdAt: orders.createdAt,
        // 刻意不 returning deliveryTokenHash：路由会把返回值原样 JSON 响应给买家，
        // 摘要泄出去等于把取卡码的校验依据交到对方手上（虽然它是 SHA256，
        // 但没有任何理由让内部字段出现在对外响应里）。
      });

    // 只在「第一次核销」时把卡密绑到订单上。
    // order_id 上有唯一索引，一张次卡会核销出多笔订单，若每次都回填必然撞唯一约束；
    // 因此次卡的归属以首次核销的订单为准，后续核销只累加次数。
    if (times === 0) await tx.update(cardKeys).set({ orderId: order.id }).where(eq(cardKeys.id, claimed.id));
    // 缓存失效不在事务内做（见文件头）：清得太早会让并发读者在提交后立刻
    // cacheSet 回旧值，之后 60 秒内没人再清，有上限的套餐会被超卖。
    // 由调用方在拿到已提交的结果后各调一次。
    //
    // deliveryToken 明文只随这一次返回交出（库里只有摘要），与首次发卡同一原则。
    // 调用方（POST /api/cdk/redeem）必须把它回给下游买家，否则对方拿不到取卡码，
    // 后续提交充值会被 403 "取卡码不正确" 拦住。
    return { ...order, deliveryToken };
  });
}

// 在线售卖：实时生成一张卡密并直接绑定到订单，明文只随本次返回值交出（不落库）。
// 卡密池取不到明文，所以在线售卖不能从池里发，只能现生成。返回值 null 表示已发放过。
export type IssueResult = { code: string } | { reason: "already_issued" | "sold_out" | "unavailable" };

export async function issueCardKeyForOrder(orderId: string, planId: string): Promise<IssueResult> {
  // 规则从配置读，保证与运营在后台设定的前缀一致。
  const code = newCdk(await getCdkRule());
  return db.transaction(async (tx) => {
    // ---- 收钱闸门（纵深防御）------------------------------------------------
    //
    // 前台领取路由已判过一次到账证据；这里再判一次，是为了覆盖**后台补发**这条路径
    //（admin-api.ts 的 reissue 共用本函数，而它只校验了状态白名单）。
    // 同一套判定只在一个地方实现容易漏，所以推进到数据层：只要进入本函数就必须有钱。
    //
    // 锁订单行：与下面的套餐行锁保持一致的加锁顺序（orders → plans），避免交叉死锁。
    const [orderRow] = await tx
      .select({ paymentMethod: orders.paymentMethod, transactionId: orders.transactionId, paidAt: orders.paidAt })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!orderRow) return { reason: "unavailable" };
    // 卡密兑换生成的订单本身就是买家带来的凭证，不参与在线发卡。
    if (orderRow.paymentMethod === "cdk") return { reason: "unavailable" };
    if (!orderRow.transactionId && !orderRow.paidAt) return { reason: "unavailable" };

    // 锁住套餐行，把同一套餐的并发发放串行化。不锁的话两个请求可能同时读到
    // "还能再发 1 张" 然后一起放行，手工库存上限就被突破了。
    const [plan] = await tx.select({ stock: plans.stock, delivery: plans.delivery }).from(plans).where(eq(plans.id, planId)).for("update");
    if (!plan || plan.delivery !== "cdk") return { reason: "unavailable" };
    if (plan.stock !== null) {
      const [issued] = await tx.select({ value: count() }).from(cardKeys).where(and(eq(cardKeys.planId, planId), eq(cardKeys.batch, ONLINE_BATCH)));
      if (Number(issued?.value ?? 0) >= plan.stock) return { reason: "sold_out" };
    }
    const [created] = await tx
      .insert(cardKeys)
      .values({
        codeHash: digest(normalizeCdk(code)),
        batch: ONLINE_BATCH,
        planId,
        status: "used",
        orderId,
        usedAt: new Date(),
        note: "在线售卖实时发放",
      })
      // order_id 上的唯一索引保证一张订单只发一张；并发的第二个请求落到这里返回空。
      .onConflictDoNothing()
      .returning({ id: cardKeys.id });
    // 返回原因而不是简单的 null：调用方据此区分"已发过"和"售罄"，不必再查一次库。
    if (!created) return { reason: "already_issued" } as const;
    // 缓存失效不在事务内做（见文件头）：清得太早会让并发读者在提交后立刻
    // cacheSet 回旧值，之后 60 秒内没人再清，有上限的套餐会被超卖。
    // 由调用方在拿到已提交的结果后各调一次。
    return { code };
  });
}

/**
 * 卡密补发。
 *
 * 适用场景：买家已付款但卡密丢失、没收到、已核销但订单未完成，需要再给一张。
 *
 * 关键设计：**就地换码，不新增行**。card_keys.order_id 上有唯一索引，
 * 一张订单只能持有一张卡；补发若插新行必然撞约束。就地把 codeHash 换成新码，
 * 语义上也更准确——旧码立即失效（买家手上的旧码作废），新码可用。
 *
 * 幂等：同一订单重复补发会换出新码，旧码随之作废，不会出现"两个都能用"。
 */
export async function reissueCardKeyForOrder(orderId: string, planId: string, reason: string) {
  // 补发同样走当前规则：运营改前缀后补发的卡与新生成的卡外观一致，
  // 不会出现"同一天两批卡长得不一样"让买家困惑。
  const code = newCdk(await getCdkRule());
  const now = new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: cardKeys.id, planId: cardKeys.planId, issueVersion: cardKeys.issueVersion, status: cardKeys.status })
      .from(cardKeys)
      .where(eq(cardKeys.orderId, orderId))
      .limit(1);

    if (existing) {
      // 已绑过订单：换码并重置为可用。order_id 保持不变，归属依然清晰。
      //
      // 三处修正：
      //  1. issueVersion + 1，并参与 transaction_id 的构造。否则新码核销时算出的
      //     transaction_id 与第一次完全相同 → 撞 orders.transaction_id 唯一索引 →
      //     事务回滚 → 卡密退回 unused → 死循环，重试多少次都无法核销。
      //  2. UPDATE 带 status 条件做 CAS。此前两个并发补发都会返回 200 + 一个码，
      //     但只有一个有效，运营会把已作废的码发给买家，而审计日志显示两次都成功。
      //  3. note 改为追加而非覆盖，保留"历史上被核销过几次"这一事实。
      //     此前 usedTimes/usedAt/note 全被覆盖，这个事实从数据层彻底消失。
      const updated = await tx
        .update(cardKeys)
        .set({
          codeHash: digest(normalizeCdk(code)),
          planId,
          status: "unused",
          usedTimes: 0,
          usedAt: null,
          issueVersion: existing.issueVersion + 1,
          note: `补发：${reason}`.slice(0, 200),
        })
        .where(eq(cardKeys.id, existing.id))
        .returning({ id: cardKeys.id });
      // 并发补发：只有一个能改成功。另一个必须明确失败，不能拿着一个已被覆盖的
      // 码返回成功——那会让运营把废码发给买家。
      if (updated.length !== 1) return { code: null, replaced: true, conflict: true };
      // 补发后旧卡已归零，若这张卡此前已被核销过，那张由它产生的订单仍然处于
      // paid/processing/completed，买家用新码核销会**再生成一张同样可履约的订单**
      // （ACTIVATABLE_ORDER_STATUS 判定只看订单状态）。一次付款换两次上游充值。
      // 这里把该卡关联的旧订单显式作废，并留下痕迹供运营追溯。
      //
      // 作用域必须是「这张卡派生出来的订单」，用 transactionId 前缀精确匹配：
      //   redeemCardKey 写入的形如 `${cardId}:v${issueVersion}`（次卡再追加 `#n`），
      //   因此 `${cardId}:` 前缀恰好覆盖这张卡的**所有发放轮次**上的全部核销订单。
      //
      // 此前这里按 `planId + paymentMethod='cdk'` 过滤，即**按套餐维度批量取消**：
      // 给 A 买家补发一张卡，会把同套餐下所有其他买家的在途订单一并置为 cancelled
      // （含已付款、正在充值的订单）。补发是运营的单点操作，破坏面却是整个套餐 ——
      // 且这些订单已被 `syncOrderStatus` 推给上游，回滚不掉真实扣费。
      const superseded = await tx
        .update(orders)
        .set({
          status: "cancelled",
          canceledAt: now,
          updatedAt: now,
          note: "卡密补发，本订单已作废并由新卡重新生成。请勿重复提交。",
        })
        .where(and(
          like(orders.transactionId, `${existing.id}:%`),
          // 只作废还没有走到终态的；已 completed 的是真交付过，上游已扣费，
          // 静默取消会掩盖"确实充值了两次"这个事实，那需要人工退上游。
          inArray(orders.status, ["pending", "paid", "processing"]),
        ))
        .returning({ code: orders.code });
      return { code, replaced: true, conflict: false, superseded: superseded.map((o) => o.code) };
    }

    // 从未发过卡：直接新建一张绑定该订单。
    const [created] = await tx
      .insert(cardKeys)
      .values({
        codeHash: digest(normalizeCdk(code)),
        batch: ONLINE_BATCH,
        planId,
        status: "unused",
        orderId,
        note: `补发：${reason}`.slice(0, 200),
      })
      .onConflictDoNothing()
      .returning({ id: cardKeys.id });
    if (!created) return { code: null, replaced: false };
    // 缓存失效不在事务内做（见文件头）：清得太早会让并发读者在提交后立刻
    // cacheSet 回旧值，之后 60 秒内没人再清，有上限的套餐会被超卖。
    // 由调用方（admin-api）在拿到已提交的结果后调用。
    void now;
    return { code, replaced: false };
  });
}

export async function revokeBatch(batch: string) {
  // 前端把按钮置灰只是界面约束，API 必须自己拒绝 —— 否则一次误操作或 CSRF
  // 就能把全站"已补发、买家还没核销"的卡一次性作废，而 revokeBatch 只改 status、
  // 没有恢复路径。
  if (batch === ONLINE_BATCH) throw new Error(ONLINE_BATCH_REVOKE_ERROR);
  const revoked = await db
    .update(cardKeys)
    .set({ status: "revoked" })
    .where(and(eq(cardKeys.batch, batch), eq(cardKeys.status, "unused")))
    .returning({ id: cardKeys.id });
  // 作废会减少池内可用量。
  if (revoked.length) invalidatePlansCache();
  return revoked.length;
}

// 列表不返回任何明文信息（库里也没有），只给状态与归属，够运营排障用
export async function listCardKeys(options: { batch?: string; status?: string; page: number }) {
  // 页码在数据层再收敛一次：offset = (page-1)*20，传入一个越界页会让数据库
  // 扫过海量行再丢掉。路由层已 clamp，这里是不依赖调用方的兜底。
  const page = Math.max(1, Math.min(500, Math.floor(Number(options.page)) || 1));
  const statuses = ["unused", "used", "revoked"];
  const condition = and(
    options.batch ? eq(cardKeys.batch, options.batch) : undefined,
    options.status && statuses.includes(options.status) ? eq(cardKeys.status, options.status) : undefined,
  );
  const [total] = await db.select({ value: count() }).from(cardKeys).where(condition);
  const items = await db
    .select({
      id: cardKeys.id,
      batch: cardKeys.batch,
      planId: cardKeys.planId,
      status: cardKeys.status,
      orderId: cardKeys.orderId,
      note: cardKeys.note,
      createdAt: cardKeys.createdAt,
      usedAt: cardKeys.usedAt,
    })
    .from(cardKeys)
    .where(condition)
    .orderBy(desc(cardKeys.createdAt))
    .limit(20)
    .offset((page - 1) * 20);

  // 库存按状态汇总，用于「当前库存：N」这类展示，避免前端自己拉全表去数
  const grouped = await db.select({ status: cardKeys.status, value: count() }).from(cardKeys).groupBy(cardKeys.status);
  const stock = { unused: 0, used: 0, revoked: 0 };
  for (const row of grouped) if (row.status in stock) stock[row.status as keyof typeof stock] = Number(row.value);

  return { items, total: total.value, page, pageSize: 20, stock };
}

// 批量查状态：卡密只存摘要，但摘要是确定性的，所以按 code_hash 精确匹配即可，
// 不需要明文。单次上限与生成上限一致。
export async function queryCardKeys(codes: string[]) {
  const hashes = [...new Set(codes.map((code) => digest(normalizeCdk(code))))].slice(0, MAX_BATCH);
  const rows = await db
    .select({
      codeHash: cardKeys.codeHash,
      batch: cardKeys.batch,
      planId: cardKeys.planId,
      status: cardKeys.status,
      orderId: cardKeys.orderId,
      usedAt: cardKeys.usedAt,
    })
    .from(cardKeys)
    .where(inArray(cardKeys.codeHash, hashes));
  const found = new Map(rows.map((row) => [row.codeHash, row]));
  return codes.slice(0, MAX_BATCH).map((code) => {
    const row = found.get(digest(normalizeCdk(code)));
    return {
      code,
      status: row?.status ?? "invalid",
      batch: row?.batch ?? null,
      planId: row?.planId ?? null,
      orderId: row?.orderId ?? null,
      usedAt: row?.usedAt ?? null,
    };
  });
}
