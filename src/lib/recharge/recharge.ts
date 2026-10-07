import { and, count, desc, eq, gte, isNotNull, lte, or, sql, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { orders, rechargeJobs, rechargeEvents, type RechargeJob } from "@/db/schema";
import { newOrderCode } from "@/lib/core";
import { getUpstream, getUpstreamSettings } from "./upstream";
import { credentialVaultReady, normalizeCredential, openCredential, sealCredential } from "./credential-vault";
import { logger } from "@/lib/core";

// ---------------------------------------------------------------------------
// 充值编排：把「校验 → 绑定 → 提交 → 轮询 → 终态」自动化。
//
// 关键设计（也是"自动化"真正的含义）：
//   · 买家只点一次提交，剩下的由服务端驱动；
//   · 每一步都幂等，重复调用不会重复扣卡（幂等键 = 本站订单号）；
//   · 凭证在"提交成功"后**立即抹除**，不给它第二次被使用的机会；
//   · 状态只能向前推进，终态不可回退（详见 assertTransition）。
// ---------------------------------------------------------------------------

// 四态设计（对外只暴露这四类，其余都是中间步骤）：
//   等待中 —— validating / confirmed / submitted / processing
//   成功   —— succeeded
//   失败   —— failed（明确被拒：凭证错、余额不足、上游返回失败）
//   超时   —— timed_out（上游长时间无结论，既不能算成功也不能算失败）
//
// 为什么超时必须独立成态而不是并入 failed：
//   两者的**运营动作完全不同**。failed 是上游明确拒绝，重试基本无意义，
//   应当退款或转人工；timed_out 是"不知道结果"，可能上游其实已经充好了，
//   盲目重试会重复扣款、误退款。混成一个状态，运营只能靠猜。
export const RECHARGE_STAGES = ["validating", "confirmed", "submitted", "processing", "succeeded", "failed", "timed_out"] as const;
export type RechargeStage = (typeof RECHARGE_STAGES)[number];

/** 对外四态。买家看到的是这个，不是内部步骤。 */
export type RechargeOutcome = "waiting" | "succeeded" | "failed" | "timed_out";

const OUTCOME_MAP: Record<RechargeStage, RechargeOutcome> = {
  validating: "waiting",
  confirmed: "waiting",
  submitted: "waiting",
  processing: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "timed_out",
};

export function outcomeOf(status: string): RechargeOutcome {
  return OUTCOME_MAP[status as RechargeStage] ?? "waiting";
}

/**
 * 判断任务是否已超时。
 *
 * 计时起点取「提交上游的时刻」而不是「创建时刻」：卡密校验可能磨掉一两分钟，
 * 从创建开始算会让慢速上游被误判超时。submittedAt 缺失时退回 createdAt，
 * 保证任何情况下都有一个可用的基准，不会因为字段为空而永不超时。
 *
 * 阈值同样取自上游配置（timeoutSeconds），不写死——不同上游的正常耗时差异很大，
 * 统一阈值必然对某些上游过紧、对另一些过松。
 */
export function isTimedOut(job: { status: string; createdAt: Date; submittedAt?: Date | null }, timeoutSeconds?: number): boolean {
  if (TERMINAL_STAGES.includes(job.status as RechargeStage)) return false;
  const budget = Number(timeoutSeconds);
  if (!Number.isFinite(budget) || budget <= 0) return false;
  const since = job.submittedAt ?? job.createdAt;
  return Date.now() - since.getTime() >= budget * 1000;
}

/** 终态：不再被任何自动流程推进。超时的也算终态，需要人工或重试任务显式重开。 */
export const TERMINAL_STAGES: RechargeStage[] = ["succeeded", "failed", "timed_out"];

// 允许的推进关系。任何不在表里的转移都会被拒绝，防止把已成功的单改回处理中。
// 超时可以从任意中间态进入——上游卡住时不能要求它必须先走到 processing。
const TRANSITIONS: Record<RechargeStage, RechargeStage[]> = {
  validating: ["confirmed", "failed", "timed_out"],
  confirmed: ["submitted", "failed", "timed_out"],
  submitted: ["processing", "succeeded", "failed", "timed_out"],
  processing: ["succeeded", "failed", "timed_out"],
  succeeded: [],
  failed: [],
  timed_out: [],
};

export function assertTransition(from: string, to: string) {
  if (from === to) return;
  const allowed = TRANSITIONS[from as RechargeStage];
  if (!allowed || !allowed.includes(to as RechargeStage)) {
    throw new Error(`非法的状态推进：${from} -> ${to}`);
  }
}

async function logEvent(jobId: string, stage: string, message = "") {
  await db.insert(rechargeEvents).values({ jobId, stage, message });
}

﻿export type SubmitInput = {
  /**
   * 已付款的本站订单号。
   *
   * 改造前这里收的是「卡密」，由买家手动粘贴。改为订单号后，卡密成为纯内部
   * 实现细节：付款成功即由系统自动绑定到订单，买家全程看不到、也不必复制粘贴。
   *
   * 顺带补上了一个业务漏洞：原实现只收 planId + email，**完全不验证付款**，
   * 任何人打开页面就能提交凭证白嫖上游。绑定订单后，未付款一律无法进入。
   */
  orderCode: string;
  /** 下单时填写的邮箱。必须与订单一致，作为第二重校验。 */
  email: string;
  /** 买家自己的账号登录态。 */
  credential: string;
};

/** 可进入自动充值的订单状态。已付款或已交付都算——买家可能几天后才提交凭证。 */
const ACTIVATABLE_ORDER_STATUS = new Set(["paid", "processing", "completed"]);

/**
 * 步骤 1：凭订单号受理任务。
 *
 * 校验顺序是有意为之，从便宜到昂贵：先查库拿订单，再比对邮箱，最后才解密凭证。
 * 这样大多数非法请求在第一道就返回，不会白白消耗加密与上游调用。
 */
export async function submitRecharge(input: SubmitInput) {
  const upstream = await getUpstream();
  if (!upstream.enabled) return { ok: false as const, reason: "自动充值功能暂未开放，请稍后再试或联系客服" };
  const settings = await getUpstreamSettings();

  const orderCode = input.orderCode.trim().toUpperCase();
  // 允许连字符：订单号格式由 newOrderCode 决定，但校验端不应与某个前缀耦合——
  // 将来改格式时，这里不需要跟着改，否则会连带拒绝掉所有历史订单。
  if (!/^[A-Z0-9-]{8,40}$/.test(orderCode)) return { ok: false as const, reason: "订单号格式不正确" };

  // ---- 订单必须真实存在且已付款 ----
  const [order] = await db
    .select({
      code: orders.code,
      planId: orders.planId,
      planName: orders.planName,
      email: orders.email,
      status: orders.status,
    })
    .from(orders)
    .where(eq(orders.code, orderCode))
    .limit(1);

  if (!order) return { ok: false as const, reason: "未找到该订单，请核对订单号" };
  // 邮箱比对用常量时间，避免通过响应时间差异枚举出"订单存在但邮箱不匹配"。
  if (!timingSafeEqualStr(order.email.toLowerCase(), input.email.trim().toLowerCase())) {
    logger.audit("recharge.email_mismatch", { order: orderCode });
    return { ok: false as const, reason: "订单号与邮箱不匹配" };
  }
  if (!ACTIVATABLE_ORDER_STATUS.has(order.status)) {
    logger.audit("recharge.order_not_paid", { order: orderCode, status: order.status });
    return { ok: false as const, reason: "该订单尚未完成付款，暂时无法提交充值信息" };
  }

  // ---- 幂等：同一订单只允许存在一个任务 ----
  //
  // 此前只挡"非终态任务"，于是任务一旦 succeeded，同一订单可以**再次提交凭证**
  // → 新建 job → 再调一次上游 submit → 第二次充值。一次付款换多次上游充值，
  // 直接让上游成本翻倍。
  //
  // 现在按订单维度一刀切：只要这个订单有过任何任务（含已失败的），就不再受理。
  // 失败重试请走运营流程（后台可以作废后重建），而不是让买家自助重试——
  // 因为"失败"的原因常常是凭证本身无效，重试只会重复消耗上游调用配额。
  //
  // 【为什么不能"先查后插"】买家双击提交、或两台设备同时提交时，两个请求都会
  // 查到"还没有任务"，然后各插一条 —— 同一笔订单向上游充两次。真正的兜底是
  // 数据库约束：`recharge_jobs_order_code_uniq`（部分唯一索引，见 schema.ts）。
  // 上面的查询只作为"给出准确提示文案"的快速路径，不是安全边界。
  const [existing] = await db
    .select({ code: rechargeJobs.code, status: rechargeJobs.status })
    .from(rechargeJobs)
    .where(eq(rechargeJobs.orderCode, orderCode))
    .limit(1);
  if (existing) {
    logger.audit("recharge.duplicate_submit_blocked", { order: orderCode, job: existing.code, status: existing.status });
    return {
      ok: false as const,
      reason: existing.status === "succeeded"
        ? "该订单已完成充值，如需再次充值请联系客服"
        : existing.status === "failed" || existing.status === "timed_out"
          ? "该订单的充值任务已结束但未成功，请联系客服处理"
          : "该订单已有进行中的充值任务，请勿重复提交",
      jobCode: existing.code,
    };
  }

  // ---- 每日限次：防止同一账号一天内反复消耗上游额度 ----
  // dailyLimitPerEmail 此前被后台校验、保存、展示，却**全项目无人读取**——
  // 一个看起来在生效、实际完全不生效的风控开关。现已真正接进下单路径。
  const dailyLimit = Number(settings?.dailyLimitPerEmail ?? 0);
  if (dailyLimit > 0) {
    // 按 UTC 自然日切分。跨时区运营时边界会略有偏差，但风控 purpose 下可接受：
    // 目的是"刷不走"，不是"精确到第 N 单"。
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [todayUsage] = await db
      .select({ value: count() })
      .from(rechargeJobs)
      .where(and(eq(rechargeJobs.email, order.email), gte(rechargeJobs.createdAt, startOfDay)));
    if (Number(todayUsage?.value ?? 0) >= dailyLimit) {
      logger.audit("recharge.daily_limit_blocked", { order: orderCode, email: order.email, limit: dailyLimit });
      return { ok: false as const, reason: "该账号今日提交次数已达上限，请明日再试或联系客服" };
    }
  }

  const credential = normalizeCredential(input.credential);
  if (!credential) return { ok: false as const, reason: "凭证格式不正确，请粘贴登录态 JSON 或以 eyJ 开头的 accessToken" };

  // 没有加密密钥就**不落库**，并给买家一句能看懂的话。
  // 直接让 sealCredential 抛错会变成裸 500——既不友好，也让排障失去线索。
  if (!credentialVaultReady()) {
    logger.error("recharge.vault_not_configured", {}, new Error("CREDENTIAL_KEY missing"));
    return { ok: false as const, reason: "服务配置不完整，请联系客服" };
  }

  const code = newOrderCode();
  const ttlMs = Math.max(1, settings?.credentialTtlMinutes ?? 30) * 60_000;
  // onConflictDoNothing 是这里的第二道闸：并发提交时两个请求都能通过上述查询，
  // 但只有一条能真正插入，另一条因唯一索引落空 → returning() 为空 → 拒绝。
  // 用"冲突即无返回"而不是"捕获 23505 异常"，是因为异常路径要区分
  // 唯一约束名、还要担心事务已回滚，而空返回值就是无歧义的失败信号。
  const inserted = await db.insert(rechargeJobs).values({
    code,
    orderCode,
    planId: order.planId,
    planName: order.planName,
    email: order.email,
    status: "validating",
    credentialCipher: sealCredential(credential),
    credentialExpiresAt: new Date(Date.now() + ttlMs),
  }).onConflictDoNothing().returning();
  const job = inserted[0];
  if (!job) {
    const [rival] = await db
      .select({ code: rechargeJobs.code, status: rechargeJobs.status })
      .from(rechargeJobs)
      .where(eq(rechargeJobs.orderCode, orderCode))
      .limit(1);
    logger.audit("recharge.concurrent_submit_blocked", { order: orderCode, job: rival?.code ?? null });
    return { ok: false as const, reason: "该订单已有进行中的充值任务，请勿重复提交", jobCode: rival?.code ?? null };
  }
  await logEvent(job.id, "validating", "已受理，正在校验账号");
  logger.audit("recharge.submitted", { order: orderCode, job: code, plan: order.planId });
  return { ok: true as const, job };
}


/**
 * 预检：确认「订单可激活 + 账号可用」，不落库、不创建任务。
 *
 * 与 submitRecharge 的区别只有一处——**不写任何数据**。但校验规则完全一致
 * （订单存在、已付款、邮箱归属、凭证可用），否则会出现"预检通过但提交失败"，
 * 那比没有预检更伤信任。
 *
 * 账号侧的可用性由上游适配器的 validate() 判定，它本来就是幂等的只读查询。
 * 这里额外把上游返回的 secret 直接丢弃——预检阶段没有任何理由持有它。
 */
export async function verifyCredentialForOrder(
  orderCode: string,
  email: string,
  credential: string,
): Promise<
  | { ok: true; data: { planName: string; account: string }; status?: undefined; code?: undefined; reason?: undefined }
  | { ok: false; reason: string; status: number; code: string; data?: undefined }
> {
  const upstream = await getUpstream();
  if (!upstream.enabled) return { ok: false, reason: "自动充值暂未开放，请使用下单购买或联系客服。", status: 503, code: "UPSTREAM_DISABLED" };

  if (!/^[A-Z0-9-]{8,40}$/.test(orderCode)) return { ok: false, reason: "订单号格式不正确", status: 400, code: "VALIDATION_FAILED" };

  const [order] = await db
    .select({ code: orders.code, planId: orders.planId, planName: orders.planName, email: orders.email, status: orders.status })
    .from(orders)
    .where(eq(orders.code, orderCode))
    .limit(1);
  if (!order) return { ok: false, reason: "未找到该订单，请核对订单号", status: 404, code: "NOT_FOUND" };
  if (!timingSafeEqualStr(order.email.toLowerCase(), email.toLowerCase())) {
    logger.audit("recharge.email_mismatch", { order: orderCode, stage: "verify" });
    return { ok: false, reason: "订单号与邮箱不匹配", status: 422, code: "VALIDATION_FAILED" };
  }
  if (!ACTIVATABLE_ORDER_STATUS.has(order.status)) {
    return { ok: false, reason: "该订单尚未完成付款，暂时无法提交充值信息", status: 422, code: "ORDER_NOT_PAID" };
  }

  const result = await upstream.adapter.validate({ credential, planId: order.planId, email: order.email });
  if (!result.ok) {
    logger.audit("recharge.verify_rejected", { order: orderCode, reason: result.reason || "unknown" });
    return { ok: false, reason: result.reason || "账号校验未通过", status: 422, code: "VALIDATION_FAILED" };
  }
  logger.audit("recharge.verify_passed", { order: orderCode, plan: order.planId });
  return { ok: true, data: { planName: order.planName, account: result.sku ?? "已识别" } };
}

/** 字符串常量时间比较。长度不同直接返回 false，不进入逐字节比较。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function advanceJob(jobId: string): Promise<{ done: boolean; status: string }> {
  const [job] = await db.select().from(rechargeJobs).where(eq(rechargeJobs.id, jobId)).limit(1);
  if (!job) return { done: true, status: "not_found" };
  // 用 TERMINAL_STAGES 判定，而不是写死两个状态：新增 timed_out 后
  // 漏改这里会让超时单被反复推进，状态机形同虚设。
  if (TERMINAL_STAGES.includes(job.status as RechargeStage)) return { done: true, status: job.status };

  // 超时判定放在任何上游调用之前。上游长时间无结论时继续轮询没有意义，
  // 而且每次轮询都在替一个可能已经死掉的任务续命。阈值取自上游配置，不写死。
  // 注意超时判定是**本地计算**，不受下面的节流影响：即使 90 秒内不再查上游，
  // 超过总时限的任务仍会被准点转人工，不会因为节流而永远挂着。
  const { timeoutSeconds, pollIntervalSeconds } = await getUpstreamSettings();
  if (isTimedOut(job, timeoutSeconds)) {
    // CAS 未命中时不写事件：此时任务已被别的请求推进（多半已到终态），
    // 再补一条 "timed_out" 会让买家看到一个与真实状态矛盾的进度。
    if (!await transition(job, "timed_out", { failureReason: "处理时间超出预期，已转为人工核实" })) {
      return { done: false, status: job.status };
    }
    await logEvent(job.id, "timed_out", "等待超时，已转人工核实");
    return { done: true, status: "timed_out" };
  }

  // ---- 查询节流：距上次调用上游不足 pollIntervalSeconds 时，本次直接跳过 ----
  //
  // 用一条带条件的 UPDATE 抢占，而不是"读出来比一比再写回"。后者在并发下失效：
  // 买家开两个标签页狂点刷新，两个请求会同时通过检查、同时打上游，
  // 节流等于没有。条件里带上 last_queried_at 的旧值，只有把时间戳推到现在的那一个
  // 才返回行，返回 0 行的一方直接跳过。
  //
  // 抢占在**调用之前**发生：宁可"这次查了但没查成"（下次窗口再来），
  // 也不能"两个请求都查成了"。前者浪费一次窗口，后者浪费对方的额度。
  if (pollIntervalSeconds > 0) {
    const cutoff = new Date(Date.now() - pollIntervalSeconds * 1000);
    const claimed = await db
      .update(rechargeJobs)
      .set({ lastQueriedAt: new Date() })
      .where(and(eq(rechargeJobs.id, jobId), or(isNull(rechargeJobs.lastQueriedAt), lt(rechargeJobs.lastQueriedAt, cutoff))))
      .returning({ id: rechargeJobs.id });
    if (claimed.length === 0) {
      // 窗口内已被别的触发点查过了。返回当前状态、不打事件——
      // 否则每次被跳过都写一条"上游处理中"，事件表会被刷新动作刷爆。
      return { done: false, status: job.status };
    }
  }

  const upstream = await getUpstream();
  if (!upstream.enabled) return { done: false, status: job.status };

  try {
    if (job.status === "validating") {
      const credential = readCredential(job);
      if (!credential) return failJob(job, "凭证已过期，请重新提交");
      const result = await upstream.adapter.validate({ credential, planId: job.planId, email: job.email });
      if (!result.ok) return failJob(job, result.reason || "账号校验未通过");
      // 暂存上游返回的兑换凭据（同样加密），供下一步提交使用。
      await db.update(rechargeJobs)
        .set({ secretCipher: result.secret ? sealCredential(result.secret) : null, updatedAt: new Date() })
        .where(eq(rechargeJobs.id, job.id));
      // CAS 未命中说明并发下已被别的请求推进过。此时不能再写事件——
      // recharge_events 是买家进度条的唯一事实来源，多写一条就会出现
      // "事件说已确认、DB 里却是另一个状态"的矛盾进度。
      if (!await transition(job, "confirmed")) return { done: false, status: job.status };
      await logEvent(job.id, "confirmed", "账号校验通过");
      return { done: false, status: "confirmed" };
    }

    if (job.status === "confirmed") {
      const credential = readCredential(job);
      const secret = job.secretCipher ? tryOpen(job.secretCipher) : undefined;
      if (!credential && !secret) return failJob(job, "凭证已过期，请重新提交");
      const submitted = await upstream.adapter.submit({
        credential: credential ?? "",
        planId: job.planId,
        email: job.email,
        idempotencyKey: job.code,
        secret: secret ?? undefined,
      });
      if (!submitted.ok || !submitted.upstreamOrder) return failJob(job, submitted.reason || "提交上游失败");
      // submittedAt 是超时计时的起点，必须在这一刻写入。
      //
      // CAS 未命中时**绝不能**继续往下走：抹除凭证与写"已提交"事件都建立在
      // "这次真的提交并落库了"之上。没落库就抹凭证，等于把买家凭证留在库里
      // 白白过期（安全上不致命，但任务会卡在 confirmed 直到超时）。
      // 上游 submit 已经发生，钱已经花出去——这正是幂等键必须放在最前面的原因。
      if (!await transition(job, "submitted", { upstreamOrder: submitted.upstreamOrder, upstreamBinding: submitted.binding ?? null, submittedAt: new Date() })) {
        logger.audit("recharge.submit_race_lost", { job: job.code, upstreamOrder: submitted.upstreamOrder });
        return { done: false, status: job.status };
      }
      // 提交成功即抹除两份密文：后续只靠上游单号推进，不再需要任何凭证。
      await db.update(rechargeJobs)
        .set({ credentialCipher: null, secretCipher: null, credentialExpiresAt: null })
        .where(eq(rechargeJobs.id, job.id));
      await logEvent(job.id, "submitted", "已提交，开始自动处理");
      return { done: false, status: "submitted" };
    }

    if (job.status === "submitted" || job.status === "processing") {
      if (!job.upstreamOrder) return failJob(job, "缺少上游单号");
      const result = await upstream.adapter.query({ upstreamOrder: job.upstreamOrder, binding: job.upstreamBinding ?? undefined });
      if (result.state === "succeeded") {
        // 竞态下最危险的一处：CAS 未命中却返回 done/succeeded，等于对买家
        // 谎报"充值完成"，而数据库里这一单可能仍停在 processing（甚至已被
        // 别的请求判为失败）。买家据此停止等待，钱却没到账。
        if (!await transition(job, "succeeded", { resultNote: sanitize(result.detail || result.message) })) {
          logger.audit("recharge.succeed_race_lost", { job: job.code, from: job.status });
          return { done: false, status: job.status };
        }
        await logEvent(job.id, "succeeded", "充值完成");
        return { done: true, status: "succeeded" };
      }
      if (result.state === "failed") {
        return failJob(job, sanitize(result.detail || result.message) || "上游处理失败");
      }
      if (job.status === "submitted") {
        if (!await transition(job, "processing")) return { done: false, status: job.status };
        await logEvent(job.id, "processing", "正在处理");
      }
      return { done: false, status: "processing" };
    }

    return { done: true, status: job.status };
  } catch (error) {
    logger.error("recharge.advance_failed", { job: job.code, status: job.status }, error);
    return { done: false, status: job.status };
  }
}

/**
 * 把充值任务的进展同步到订单状态。
 *
 * 为什么必须同步：订单与任务是两套状态机，词汇还不一样（订单有 completed/cancelled，
 * 任务有 succeeded/timed_out）。此前两者完全脱节，表现为自动充值已经 succeeded，
 * 后台订单却一直停在「已支付」——运营会以为还要手动处理，白做一遍；
 * 反过来失败时订单毫无变化，客服也看不出该订单出过问题。
 *
 * 口径：
 *   提交上游      -> 订单 processing（「充值中」，与既有标签语义一致）
 *   充值成功      -> 订单 completed
 *   失败 / 超时   -> 订单退回 paid 并附说明，钱已收到、需人工处理，
 *                   不能置为完成，也不能悄悄改成待支付。
 */
async function syncOrderStatus(job: RechargeJob, stage: RechargeStage) {
  if (!job.orderCode) return;
  const next = stage === "submitted" || stage === "processing" ? "processing"
    : stage === "succeeded" ? "completed"
    : stage === "failed" || stage === "timed_out" ? "paid"
    : null;
  if (!next) return;
  // 只在真正变化时写，避免每次轮询都产生一条无意义的 updated_at。
  const [row] = await db
    .select({ status: orders.status, paidAt: orders.paidAt })
    .from(orders)
    .where(eq(orders.code, job.orderCode))
    .limit(1);
  if (!row || row.status === next) return;
  await db
    .update(orders)
    .set({
      status: next,
      updatedAt: new Date(),
      // paidAt 绝不覆盖。它是"买家付款时刻"，由 cdk 兑换或 markPaid 写入；
      // 此前这里在 completed 时改写成 job.submittedAt（提交上游的时刻），
      // 两者相差可能几小时，任何按 paid_at 做日营收/对账的报表都会错。
      // completed 只表示"履约完成"，与付款时刻是两个独立事实。
    })
    .where(eq(orders.code, job.orderCode));
  logger.audit("recharge.order_synced", { order: job.orderCode, stage, orderStatus: next });
}

/**
 * 批量推进卡住的充值任务。
 *
 * 存在的理由：advanceJob 此前只有两个触发点——买家轮询进度页、运营手动点。
 * 买家一关页面，任务就永久停在 validating/confirmed：
 *   · timed_out 这个专门设计的"不知道结果"终态在生产上永远不出现；
 *   · 上游订单既没提交也没人管；
 *   · 买家的进度页会一直显示"充值中"，remainingSeconds 递减到 0 但状态不变。
 * recharge.ts 花了很大篇幅论证"超时必须独立成态"，而这条路径根本跑不到。
 *
 * 并发安全：靠 transition 内部的 CAS（status 未变才更新）。多个进程同时跑
 * 定时任务时，只有一个能把某个任务从 from 推到 to，其余拿到 false 直接跳过，
 * 不会产生重复的上游提交。
 */
export async function sweepStalledRechargeJobs(limit = 50) {
  // 只捞非终态任务；终态由 TERMINAL_STAGES 定义，这里与之保持同一判据。
  const pending = await db
    .select({ id: rechargeJobs.id })
    .from(rechargeJobs)
    .where(inArray(rechargeJobs.status, ["validating", "confirmed", "submitted", "processing"]))
    .limit(limit);
  const result = { scanned: pending.length, advanced: 0, timedOut: 0, failed: 0 };
  for (const row of pending) {
    try {
      const before = await db.select({ status: rechargeJobs.status }).from(rechargeJobs).where(eq(rechargeJobs.id, row.id)).limit(1);
      const prev = before[0]?.status;
      const r = await advanceJob(row.id);
      if (!r.done) result.advanced++;
      else if (r.status === "timed_out" && prev !== "timed_out") result.timedOut++;
      else if (r.status === "failed" && prev !== "failed") result.failed++;
    } catch (error) {
      // 单个任务失败不能中断整批：否则一个坏任务会让后面的任务永远得不到推进。
      logger.error("recharge.sweep_item_failed", { job: row.id }, error);
    }
  }
  if (result.advanced || result.timedOut || result.failed) {
    logger.audit("recharge.job_sweep", result);
  }
  return result;
}
async function transition(job: RechargeJob, to: RechargeStage, extra: Record<string, unknown> = {}) {
  assertTransition(job.status, to);
  const applied = await db
    .update(rechargeJobs)
    .set({ status: to, updatedAt: new Date(), attempts: job.attempts + 1, ...extra })
    .where(and(eq(rechargeJobs.id, job.id), eq(rechargeJobs.status, job.status)))
    .returning({ id: rechargeJobs.id });
  // CAS 未命中必须显式失败并返回。三个后果都是静默的：
  //   1. 并发下第二个请求 UPDATE 0 行，却照样执行下面的 syncOrderStatus，
  //      把订单状态也改了 —— 出现"任务还停在 confirmed，订单却已 succeeded"；
  //   2. 调用方随后 logEvent 照写，recharge_events 里出现幽灵事件，
  //      而 getPublicProgress 正是把 events 当作买家进度条的唯一事实来源；
  //   3. 任务其实没推进，但没人知道，下一次轮询还会再来一遍。
  // assertTransition 用的是**过期快照**，并发下必然通过，所以不能只靠它。
  if (applied.length !== 1) return false;
  // 订单联动放在任务写入之后：任务没写成功就不该改订单，避免两边状态不一致。
  await syncOrderStatus(job, to);
  return true;
}

async function failJob(job: RechargeJob, reason: string) {
  // CAS 未命中说明状态已被别的请求改过——很可能已经判为成功。
  // 此时写"失败"事件并返回 failed 会让买家看到与事实相反的结论。
  if (!await transition(job, "failed", { failureReason: sanitize(reason), credentialCipher: null, credentialExpiresAt: null })) {
    logger.audit("recharge.fail_race_lost", { code: job.code, from: job.status });
    return { done: false as const, status: job.status };
  }
  await logEvent(job.id, "failed", sanitize(reason));
  logger.audit("recharge.failed", { code: job.code, plan: job.planName });
  return { done: true as const, status: "failed" as const, reason: sanitize(reason) };
}

function readCredential(job: RechargeJob): string | null {
  if (!job.credentialCipher) return null;
  if (job.credentialExpiresAt && job.credentialExpiresAt.getTime() < Date.now()) return null;
  return tryOpen(job.credentialCipher);
}

/** 解密助手：任何解密失败都按"没有"处理，绝不把内部错误抛给买家。 */
function tryOpen(sealed: string): string | null {
  try {
    return openCredential(sealed);
  } catch {
    // 密钥不对或密文损坏：按凭证不可用处理，不抛给买家看内部错误。
    return null;
  }
}

/** 上游返回的文本不可信：去 HTML、去控制字符、限长，避免把上游页面/脚本带到前台。 */
export function sanitize(text: string | undefined | null): string {
  if (!text) return "";
  return String(text)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ---- 查询 ----

/** 面向买家的进度视图。**字段白名单**：这里返回什么，买家就看不到别的。 */
export async function getPublicProgress(code: string) {
  const [job] = await db.select().from(rechargeJobs).where(eq(rechargeJobs.code, code)).limit(1);
  if (!job) return null;
  const events = await db
    .select({ stage: rechargeEvents.stage, message: rechargeEvents.message, createdAt: rechargeEvents.createdAt })
    .from(rechargeEvents)
    .where(eq(rechargeEvents.jobId, job.id))
    .orderBy(desc(rechargeEvents.createdAt))
    .limit(20);
  const { timeoutSeconds } = await getUpstreamSettings();
  const outcome = outcomeOf(job.status);
  // 预计剩余秒数：只在等待中才有意义。给买家一个"还要等多久"，
  // 比让他反复刷新页面强得多——后者只会把压力转嫁到接口与数据库。
  const deadline = (job.submittedAt ?? job.createdAt).getTime() + timeoutSeconds * 1000;
  const remainingSeconds = outcome === "waiting" ? Math.max(0, Math.round((deadline - Date.now()) / 1000)) : 0;
  return {
    code: job.code,
    planName: job.planName,
    email: job.email,
    // status 给内部步骤（用于细粒度进度条），outcome 给对外四态（用于文案与配色）。
    // 两者并存，前端不必自己推导映射，避免各处推导不一致。
    status: job.status,
    outcome,
    done: TERMINAL_STAGES.includes(job.status as RechargeStage),
    remainingSeconds,
    resultNote: job.resultNote,
    // 超时也要把原因给买家看，否则他只会看到"处理中"然后永远不动。
    // 但内部备注（转人工）不外泄，这里给的是中性表述。
    failureReason: outcome === "failed" ? job.failureReason : outcome === "timed_out" ? "处理时间超出预期，已转人工核实，请稍候或联系客服" : "",
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    // 刻意不返回：upstreamOrder / upstreamBinding / credentialCipher / attempts
    events: events.map((e) => ({ stage: e.stage, message: e.message, at: e.createdAt.toISOString() })),
  };
}

/**
 * 清理过期凭证。
 * 这条是整个设计的兜底：即使某条链路异常没能走到"提交后抹除"，
 * 凭证也会在 TTL 到点后被抹掉，不会长期滞留。
 */
export async function purgeExpiredCredentials(): Promise<number> {
  const rows = await db
    .update(rechargeJobs)
    .set({ credentialCipher: null, secretCipher: null, credentialExpiresAt: null, updatedAt: new Date() })
    .where(and(
      isNotNull(rechargeJobs.credentialCipher),
      lte(rechargeJobs.credentialExpiresAt, new Date()),
    ))
    .returning({ id: rechargeJobs.id });
  if (rows.length) logger.audit("recharge.credentials_purged", { count: rows.length });
  return rows.length;
}
