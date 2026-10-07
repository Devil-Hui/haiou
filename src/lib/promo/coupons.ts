import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { coupons, orders } from "@/db/schema";
import { digest } from "@/lib/auth";
import { normalizeCdk } from "@/lib/core";

// ---------------------------------------------------------------------------
// 优惠券校验与核销。
//
// 三条不可让步的规则：
//   1. 金额一律由服务端算。前端传来的"券码"只当作查找线索，绝不当作金额依据。
//   2. 抵扣后金额不得小于等于 0。券码不能把订单压成 0 元或负数。
//   3. 核销与下单必须在同一事务里完成，且用一条 SQL 自增计数，
//      否则并发下同一张限用券会被用两次——这是"每人限用 1 次"能否成立的前提。
//
// 4. 事务内的一切查询必须走**事务对象** tx，绝不能偷偷用模块级的 `db`。
//    `db` 会从连接池再拿一条连接；事务本身已经占着一条。DB_POOL_MAX=5 时，
//    5 个并发下单就会各自占着 1 条、再等第 2 条 —— 谁也等不到，全部挂到超时。
//    这种"自己等自己"的死锁在压测之外几乎不会复现，一上线大促就现形。
//    因此下面凡是要能跑在事务里的函数，都接受一个 executor 参数。
// ---------------------------------------------------------------------------

/** db 与事务对象都满足的最小面：只要能 select。 */
type Reader = Pick<typeof db, "select">;

export type CouponCheck =
  | { ok: true; discountAmount: string; minAmount: string; note: string }
  | { ok: false; reason: string };

export const normalizeCoupon = (code: string): string => normalizeCdk(code);

/**
 * 校验一张券能否用于当前订单。不写库，可安全地在下单前预检。
 *
 * `runner` 允许把校验放进下单事务里跑（传 tx）。不传则用 db —— 但调用方若
 * 已在事务中，**必须**传 tx，理由见文件头第 4 条。
 */
export async function checkCoupon(code: string, email: string, amount: string, runner: Reader = db): Promise<CouponCheck> {
  const normalized = normalizeCoupon(code);
  if (normalized.length < 6 || normalized.length > 32) return { ok: false, reason: "券码格式不正确" };

  const [coupon] = await runner.select().from(coupons).where(eq(coupons.codeHash, digest(normalized))).limit(1);
  if (!coupon) return { ok: false, reason: "券码不存在或已失效" };
  if (!coupon.active) return { ok: false, reason: "该券已停用" };
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) return { ok: false, reason: "该券已过期" };
  if (coupon.totalLimit !== null && coupon.usedCount >= coupon.totalLimit) return { ok: false, reason: "该券已被领完" };

  const base = Number(amount);
  if (!Number.isFinite(base)) return { ok: false, reason: "订单金额异常" };
  if (base < Number(coupon.minAmount)) {
    // 门槛是整数就别显示成 ¥500.00——对买家是噪音。
    const min = Number(coupon.minAmount);
    const text = Number.isInteger(min) ? String(min) : min.toFixed(2);
    return { ok: false, reason: `该券需满 ¥${text} 可用，当前订单未达到` };
  }
  // 抵扣不得把订单压到 0 或负数：按"最低支付 0.01 元"兜底。
  const discount = Math.min(Number(coupon.discountAmount), Math.max(0, base - 0.01));
  if (discount <= 0) return { ok: false, reason: "该券不适用于当前订单金额" };

  // 每人限用：这里只做**提示性**检查，权威判定在 consumeCoupon 的原子占用里。
  // 此前这里是唯一的判定——一个事务外的普通 SELECT，8 个并发请求会全部通过。
  // 保留它是为了让前端能提前拿到"你已用完"而不是等到下单才失败；
  // 但它绝不能作为是否放行的依据，这也是为什么占用那一步要独立再判一次。
  if (coupon.perUserLimit > 0) {
    const [used] = await runner
      .select({ value: count() })
      .from(orders)
      .where(and(eq(orders.email, email), eq(orders.couponCode, digest(normalized))));
    if (Number(used?.value ?? 0) >= coupon.perUserLimit) {
      return { ok: false, reason: `该券每个邮箱限用 ${coupon.perUserLimit} 次，你已用完` };
    }
  }

  return { ok: true, discountAmount: discount.toFixed(2), minAmount: String(coupon.minAmount), note: coupon.note };
}

/**
 * 原子占用一次使用次数。必须在下单事务内调用。
 *
 * 两件事必须同时判定，缺一不可：
 *   1. totalLimit（总次数）——用一条 `used_count = used_count + 1 ... and
 *      (total_limit is null or used_count < total_limit)` 完成，避免"读出来 +1
 *      再写回"的竞态。
 *   2. perUserLimit（每人限次）——此前它是在**事务外**的一个普通 SELECT
 *      （checkCoupon 里 count orders），8 个并发请求会在彼此订单落库前都读到 0，
 *      全部通过，一张"每人限用 1 张"的券被用 8 次。券的面额是钱。
 *      现在改为向 coupon_redemptions 插入一行，由 (coupon_id, email, nth) 唯一
 *      约束来判并发：撞键即代表该邮箱已用满，让数据库而不是应用来判。
 *
 * 两步在同一个事务里，订单插入失败会一并回滚占用，不会凭空消耗次数。
 */
// 只要求"能执行 SQL/insert"，因此 db 与事务对象都能传进来——事务对象的类型与
// db 不同，用 typeof db 会把事务挡在门外。
type SqlRunner = Pick<typeof db, "execute" | "insert" | "select">;

export async function consumeCoupon(tx: SqlRunner, code: string, email: string): Promise<boolean> {
  const hash = digest(normalizeCoupon(code));
  // 先原子占用「每人限次」，再占用「总次数」。顺序很关键：
  //
  // 反过来做会白扣总次数——先 used_count +1 再判每人限次，判失败时若不补偿，
  // total_limit 会被并发请求白白吃掉。实测 8 并发抢一张"每人限 1 次"的券时，
  // used_count 会变成 8 而实际只成交 1 单，运营看到"已用 8 次"却只收到 1 笔钱。
  //
  // 现在的顺序保证：每人限次占用不成功就直接返回，根本不碰 used_count。
  // 必须走 tx：用 db 会在事务内额外申请一条连接，连接池打满时形成自我死锁。
  const [coupon] = await tx
    .select({ id: coupons.id, perUserLimit: coupons.perUserLimit })
    .from(coupons)
    .where(eq(coupons.codeHash, hash))
    .limit(1);
  if (!coupon) return false;

  // per_user_limit 为 null 或 <= 0 表示不限每人次数。
  const perUser = Number(coupon.perUserLimit ?? 0);
  if (perUser > 0) {
    // 逐个尝试占用第 1..perUser 个槽位。带 nth 的唯一索引让这一步变成原子的：
    // 并发下只有一个请求能插入某个具体的 nth，其余全部撞键。
    // 这里不能用 count(*) 去算"这是第几次"——那正是刚被修掉的竞态。
    let claimed = false;
    for (let nth = 1; nth <= perUser && !claimed; nth++) {
      const r = await tx.execute(
        sql`
          insert into coupon_redemptions (coupon_id, email, nth)
          values (${coupon.id}, ${email.toLowerCase()}, ${nth})
          on conflict do nothing
          returning coupon_id
        `
      );
      claimed = ((r as { rows?: unknown[] } | null)?.rows?.length ?? 0) > 0;
    }
    // 撞键即代表该邮箱已用满。返回 false，事务回滚，不消耗总次数。
    if (!claimed) return false;
  }

  // 再原子占用总次数。total_limit 为 null 表示不限，此时条件不参与判断。
  const rows = await tx.execute(
    sql`
      update coupons
         set used_count = used_count + 1
       where code_hash = ${hash}
         and active = true
         and (total_limit is null or used_count < total_limit)
      returning id
    `
  );
  if (((rows as { rows?: unknown[] } | null)?.rows?.length ?? 0) === 0) return false;
  return true;
}
