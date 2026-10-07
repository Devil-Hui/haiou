import { db } from "@/db";
import { plans, paymentSettings, cardKeys, categories, cdkSettings, upstreamConfig, type Plan, type PaymentSettings } from "@/db/schema";
import { initialPlans, initialCategories } from "./catalog";
import { ONLINE_BATCH } from "@/lib/cdk";
import { cacheDelete, cacheDeleteByPrefix, cacheGet, cacheSet } from "@/lib/core";
import { DEFAULT_CDK_RULE, normalizeCdkRule, type CdkRule } from "@/lib/core";
// 刻意深引而非走 "@/lib/payments" barrel：barrel 会把 payments.ts 拖进来，
// 而 payments.ts 反过来 import 本模块的 orderTotal —— 走 barrel 即形成循环依赖。
// config.ts 本身只依赖 db/schema 的类型，单独引用无此问题。
import { resolvePaymentsFromEnv } from "@/lib/payments/config";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

// 配置类数据读多写极少：缓存 60 秒，写操作时再显式失效（见 invalidate*）。
const PLANS_TTL_MS = 60_000;
const SETTINGS_TTL_MS = 60_000;

let initialized: Promise<void> | undefined;
export function ensureDefaults() {
  if (!initialized) {
    initialized = (async () => {
      // 顺序有依赖：分类必须先于套餐落库，否则 plans.brand 找不到对应分类。
      // categories.id 沿用 brand 取值（chatgpt/claude/grok/gemini），
      // 因此既有数据无需迁移，两套 ID 体系也不会并存。
      await db.insert(categories).values(initialCategories).onConflictDoNothing();
      await db.insert(plans).values(initialPlans).onConflictDoNothing();
      await db.insert(paymentSettings).values({ id: 1 }).onConflictDoNothing();
      await db.insert(cdkSettings).values({ id: 1 }).onConflictDoNothing();
      // upstream_config 同样是单例，必须一起播种。此前唯独漏了它，而
      // getUpstreamSettings() 并不经过 ensureDefaults —— 买家提交凭证是第一个
      // 到达的请求，此时表若为空就会读到 undefined。
      await db.insert(upstreamConfig).values({ id: 1 }).onConflictDoNothing();
    })().catch(error => { initialized = undefined; throw error; });
  }
  return initialized;
}

export type PlanStock = {
  /** 剩余可发数量：手工上限 − 已发放；手工上限为空则为 null（不限） */
  remaining: number | null;
  /** 已发放（在线售卖产生）的卡密数 */
  issued: number;
  /** 卡密池中尚未使用的数量（后台批量生成的那部分） */
  poolUnused: number;
};

export type PlanWithStock = Plan & { stockInfo: PlanStock };

// 卡密只存摘要、明文不落库，所以在线售卖只能实时生成并把明文当场返回；
// 卡密池（后台批量生成）则用于线下分发、买家回来核销。两条线的库存含义不同：
//   在线可售 = 手工上限 − 已发放（null 表示不限）
//   池内可用 = status = unused **且尚未绑定任何订单**
// 必须排除已绑订单的卡：那是"已售出、等买家核销"的卡，不是可再分发的库存。
// 补发场景会把已绑订单的卡重置为 unused，若不排除，池内可用会凭空多算一张。
async function cardKeyCounts() {
  const rows = await db
    .select({
      planId: cardKeys.planId,
      poolUnused: sql<number>`count(*) filter (where ${cardKeys.status} = 'unused' and ${cardKeys.orderId} is null)`.mapWith(Number),
      // 只数在线售卖发放的那一批。若按 status <> 'unused' 统计，后台批量生成后
      // 被买家核销的卡密也会被算进来，套餐的在线库存上限就被平白扣掉了。
      issued: sql<number>`count(*) filter (where ${cardKeys.batch} = ${ONLINE_BATCH})`.mapWith(Number),
    })
    .from(cardKeys)
    .groupBy(cardKeys.planId);
  return new Map(rows.map((row) => [row.planId, row]));
}

export async function getPlans(all = false): Promise<PlanWithStock[]> {
  const key = `plans:${all}`;
  const hit = cacheGet<PlanWithStock[]>(key);
  if (hit !== undefined) return hit;
  // 必须在查库之前播种：首次请求负责写入初始套餐与默认支付设置（见 README「启动与数据」）。
  // 缓存不能跳过这一步，否则新库上第一个请求会读到空表并把空结果缓存住。
  await ensureDefaults();
  // 软删除的套餐一律不返回。orders.plan_id 上有指向 plans.id 的外键且无 onDelete，
  // 硬删除会让「有历史订单的套餐」永远删不掉，因此删除只是打标记。
  //
  // all=true 是**后台**用的（含下架），这里必须**不**加 deletedAt 过滤：
  // 运营删错一个套餐后需要能看见它、能恢复。若这里也过滤，删除就成了单向操作——
  // 界面上再也找不到那个套餐，只能直连数据库改，而"恢复一个误删的套餐"恰恰是
  // 软删除相对硬删除唯一有价值的意义。等于把软删除退化成了隐藏。
  const visible = all
    ? undefined
    : and(eq(plans.active, true), isNull(plans.deletedAt));
  const rows = visible
    ? await db.select().from(plans).where(visible).orderBy(asc(plans.sort))
    : await db.select().from(plans).orderBy(asc(plans.sort));
  if (rows.length === 0) return [];
  const counts = await cardKeyCounts();
  const result = rows.map((row) => {
    const count = counts.get(row.id);
    const issued = count?.issued ?? 0;
    return {
      ...row,
      stockInfo: {
        issued,
        poolUnused: count?.poolUnused ?? 0,
        remaining: row.stock === null ? null : Math.max(0, row.stock - issued),
      },
    };
  });
  cacheSet(key, result, PLANS_TTL_MS);
  return result;
}

/**
 * 读取支付配置。
 *
 * **返回的是「环境变量优先、数据库兜底」合并后的结果**，不是数据库原始行。
 * 这一层合并是本次改造的核心：调用方（结算页、下单、支付准备、三个回调路由、
 * 后台设置页）全部只调这一个函数，因此只要在 .env 里填好密钥，
 * 五个入口会同时看到同一份配置——不需要"记得去后台再点一次开关"。
 *
 * 合并规则见 `@/lib/payments/config` 的文件头。数据库仍然是可写可查的：
 * 后台改费率即时生效，也作为环境变量缺失时的兜底，老部署不会因此失效。
 */
export async function getPaymentSettings() {
  const key = "settings";
  const hit = cacheGet<PaymentSettings>(key);
  if (hit !== undefined) return hit;
  await ensureDefaults();
  const [row] = await db.select().from(paymentSettings).where(eq(paymentSettings.id, 1));
  // 缓存合并后的结果而非原始行：环境变量在进程生命周期内不变，
  // 缓存住合并结果可以让 60 个/分钟的结算页请求省掉一次全表读。
  const settings = resolvePaymentsFromEnv(row);
  cacheSet(key, settings, SETTINGS_TTL_MS);
  return settings;
}

/** 数据库原始行，不做环境变量合并。后台"保存配置"时用它读旧值做审计对比。 */
export async function getPaymentSettingsRow(): Promise<PaymentSettings | undefined> {
  await ensureDefaults();
  const [row] = await db.select().from(paymentSettings).where(eq(paymentSettings.id, 1));
  return row;
}

// 失效逻辑统一在 @/lib/cache 里定义（数据层写入后自行调用），此处仅转出，
// 保持既有导入路径可用，且不产生第二份实现。
export { invalidatePlansCache } from "@/lib/core";

export function invalidateSettingsCache(): void {
  cacheDelete("settings");
}

/**
 * 读取当前卡密规则。
 *
 * 生成侧与校验侧都走这里，是"规则唯一来源"的落点。此前前缀写死在代码里，
 * 运营无法按批次区分渠道；现在改成配置后，改一次即全站生效。
 */
export async function getCdkRule(): Promise<CdkRule> {
  const key = "cdk-rule";
  const hit = cacheGet<CdkRule>(key);
  if (hit !== undefined) return hit;
  await ensureDefaults();
  const [row] = await db.select().from(cdkSettings).where(eq(cdkSettings.id, 1));
  const rule = normalizeCdkRule(row ?? DEFAULT_CDK_RULE);
  cacheSet(key, rule, SETTINGS_TTL_MS);
  return rule;
}

/** 运营在后台改完规则后调用，保证下一张卡立刻用新规则。 */
export function invalidateCdkRuleCache(): void {
  cacheDelete("cdk-rule");
}
