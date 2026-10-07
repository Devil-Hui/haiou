import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { plans, orders, paymentSettings, cdkSettings, cardKeys, type Plan } from "@/db/schema";
import { and, or, eq, ilike, desc, count, sql, gte, inArray } from "drizzle-orm";
import { currentAdmin, rateLimitResult, sameOrigin, validUuid } from "@/lib/auth";
import { adminAccess } from "@/lib/admin/access";
import { getPlans, getPaymentSettings, invalidatePlansCache, invalidateSettingsCache, getCdkRule, invalidateCdkRuleCache, FULFILLABLE_STATUSES } from "@/lib/catalog";
import { newCdk, normalizeCdkRule } from "@/lib/core";
import { availableGateways, gatewayStatus } from "@/lib/payments/registry";
import { allChannelStates, secretPresence } from "@/lib/payments/config";
import { statusLabels, statusFlow } from "@/lib/catalog";
import { json, readJson, traceId, ErrorCode, type ErrorCodeValue } from "@/lib/core";
import { logger } from "@/lib/core";
import { generateCardKeys, listCardKeys, MAX_BATCH, queryCardKeys, reissueCardKeyForOrder, revokeBatch, ONLINE_BATCH, ONLINE_BATCH_REVOKE_ERROR } from "@/lib/cdk";

type Context = { params: Promise<{ resource: string; id?: string }> };
// Admin payloads carry customer emails and payment configuration: never let a browser,
// proxy or shared cache retain them.
const noReferrer = { "Referrer-Policy": "no-referrer" };

// 后台订单列表/概览的**逐字段白名单**。
//
// 故意不含：`deliveryTokenHash`（买家取卡码摘要）、`cardPasswordHash`（买家账号级
// 取卡密码摘要）、`walletAddress`（收款地址对后台无意义）。三者的泄露都会建立
// "订单 ↔ 密码摘要 ↔ 取卡码摘要"的关联，成为日后任何一次别的泄露拼出完整攻击链
// 的基座。白名单是"不该出现在任何对外契约里"的硬边界，不因当前客户端是后台设备就放松。
//
// 字段键名与 DB 列名一致，保证与旧版整行下发的响应契约向后兼容。
const ADMIN_ORDER_COLUMNS = {
  id: orders.id,
  code: orders.code,
  planId: orders.planId,
  planName: orders.planName,
  brand: orders.brand,
  period: orders.period,
  amount: orders.amount,
  feeAmount: orders.feeAmount,
  discountAmount: orders.discountAmount,
  couponCode: orders.couponCode,
  purchaseEmail: orders.purchaseEmail,
  email: orders.email,
  paymentMethod: orders.paymentMethod,
  usdtAmount: orders.usdtAmount,
  status: orders.status,
  transactionId: orders.transactionId,
  note: orders.note,
  expiresAt: orders.expiresAt,
  paidAt: orders.paidAt,
  canceledAt: orders.canceledAt,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
} as const;

/**
 * 通用后台 CRUD 的错误出口。
 *
 * 【为什么 code 由 status 推导，而不是每个调用点自己传】
 * 本文件是 `/api/admin/[resource]` 的通用处理器，56 处错误分散在几十个资源里。
 * 逐个改调用点既容易漏，也会让同一类错误（404 不存在）在不同资源上得到不同码。
 * 而这里的 status 与语义是**一一对应**的（见下），由 status 反推 code 既完备又不会漏。
 *
 * 副作用：新增调用点只要传对 HTTP 状态，就自动拿到正确的 code，不需要额外记忆。
 */
const STATUS_TO_CODE: Record<number, ErrorCodeValue> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.AUTH_REQUIRED,
  403: ErrorCode.FORBIDDEN_ORIGIN,
  404: ErrorCode.NOT_FOUND,
  405: ErrorCode.METHOD_NOT_ALLOWED,
  409: ErrorCode.CONFLICT_STATE,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL,
};

const bad = (error: string, status = 400, retryAfterSec?: number) => {
  const id = traceId();
  // 与 core/api-error.ts 同一惯例：429 统一带 Retry-After（RFC 6585；GitHub/Stripe/
  // Cloudflare 的限流响应均带此头），让客户端知道最早可重试时刻，避免裸 429 被无限重试。
  // 传 retryAfterSec 时用**真实窗口剩余秒**（rateLimitResult 提供，语义同 GitHub 的
  // X-RateLimit-Reset 换算）；不传则回落保守的整窗 60s（固定窗口最大等待 = 一个窗口）。
  const retryAfter: string | undefined =
    status === 429 ? String(retryAfterSec ?? 60) : undefined;
  const headers: Record<string, string> =
    status === 429 && retryAfter ? { ...noReferrer, "X-Trace-Id": id, "Retry-After": retryAfter } : { ...noReferrer, "X-Trace-Id": id };
  return json(
    { error, code: STATUS_TO_CODE[status] ?? ErrorCode.VALIDATION_FAILED, traceId: id },
    { status, headers },
  );
};
// 成功响应同样带 traceId：排查"后台点了保存但没生效"时，成功那一步的 id 才是关键。
//
// ⚠️ 只在 data 是**纯对象**时才注入：本文件的 ok() 会被传入数组
// （如 `ok(await getPlans(true))` 返回套餐数组）。若无条件 `{...data}` 展开，
// 数组会被摊成 {0:..., 1:...} 的索引对象，后端响应结构直接被破坏。
// 数组与标量原样返回，traceId 只走响应头 X-Trace-Id（同样可对齐日志）。
const ok = (data: unknown, status = 200) => {
  const id = traceId();
  const isPlainObject = typeof data === "object" && data !== null && !Array.isArray(data);
  return json(
    isPlainObject ? { ...(data as object), traceId: id } : data,
    { status, headers: { ...noReferrer, "X-Trace-Id": id } },
  );
};
const paidCondition = sql`${orders.status} in ('paid', 'processing', 'completed')`;
// 低于该值即在概览里提示补货，避免运营刷单失败后才发现没库存。
const LOW_STOCK_THRESHOLD = 10;

/**
 * 后台列表页码收敛。
 *
 * 上限从 100000 降到 500：offset = (page-1)*PAGE_SIZE，100000 页意味着让
 * PostgreSQL 扫过 150 万行再丢掉——一个 `?page=99999` 就能把单次查询拖到秒级，
 * 而它只需要管理员会话。500 页 × 15 条 = 7500 单，对一个单实例 2C4G 的站点
 * 已经远超日常运营需要（真有更多量，该做的是加筛选条件而不是无限翻页）。
 *
 * 非法值（NaN / 负数 / 小数 / 字符串）一律回落到第 1 页，与前台口径一致。
 */
const ADMIN_MAX_PAGE = 500;
const adminPage = (raw: string | null): number => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(ADMIN_MAX_PAGE, n) : 1;
};

async function handle(request: Request, context: Context) {
  // 闸门放在所有判断之前。ADMIN_ACCESS 此前只有后台 layout 与登录页在查，
  // /api/admin/* 与 /api/auth 完全不查——页面 404 而接口照常应答，「入口隐蔽」与
  // 「生产默认关闭」这两层纵深防御等于不存在，会话 cookie 一旦泄露就能直接打接口。
  // 语义与页面保持一致：返回 404 而不是 403（403 等于确认「这里有个后台」）。
  if (!adminAccess().allowed) return bad("接口不存在", 404);
  // Throttle and origin-check next: a request that is going to be rejected must not cost
  // a database round trip on the session lookup.
  // 单次取判定结果（同时拿到 allowed 与真实剩余秒）；写成
  // `rateLimit(...).allowed` 再调一次求秒会让窗口计数 +1，那是自伤式双计。
  {
    const rl = rateLimitResult(request, "admin-api", 120);
    if (!rl.allowed) return bad("操作过于频繁，请稍后重试", 429, rl.retryAfterSec);
  }
  if (request.method !== "GET" && !sameOrigin(request)) return bad("请求来源无效", 403);
  const admin = await currentAdmin();
  if (!admin) return bad("登录已失效，请重新登录", 401);
  const { resource, id } = await context.params;
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      if (resource === "overview") {
        // 只统计「驱动日常动作」的口径：待跟进付款、待完成充值、今日确认收入、卡密可售存量。
        // 刻意不算累计收入/累计订单/完成率/品牌占比——这些数字不产生待办，看板不做冗余指标。
        const [totals] = await db.select({ pending: sql<number>`count(*) filter (where ${orders.status} = 'pending')`.mapWith(Number), processing: sql<number>`count(*) filter (where ${orders.status} in ('paid', 'processing'))`.mapWith(Number), cancelled: sql<number>`count(*) filter (where ${orders.status} = 'cancelled')`.mapWith(Number) }).from(orders);
        const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
        // 「今日确认收入」此前有三处口径错误，运营看到的数字与实际到账都对不上：
        //   1. 求和列用 orders.amount（纯商品价）—— 不含手续费、不减优惠券。
        //      手续费加价的意义被抹掉；打折反而让"收入"虚增（商品价没降）。
        //      正确口径与 orderTotal 一致：amount + fee_amount - discount_amount。
        //   2. 时间窗用 createdAt —— 昨天下单今天付款的订单不进今天，
        //      而这恰恰是最常见的情形（尤其大额订单跨夜付款）。
        //      schema 特意加了 paidAt 就是为了"对账按付款时刻统计"，这里却没用。
        //   3. paidCondition 不含 expired/cancelled，于是"过期后到账"的钱不进这个数，
        //      运营会以为钱没到账，实际上钱到了（已转入人工核对）。
        const [today] = await db.select({ revenue: sql<string>`coalesce(sum(case when ${paidCondition} then ${orders.amount} + ${orders.feeAmount} - ${orders.discountAmount} else 0 end), 0)`, count: sql<number>`count(*) filter (where ${paidCondition})`.mapWith(Number) }).from(orders).where(gte(orders.createdAt, todayStart));
        // 单独统计"钱已到账但订单状态还没推进"的部分：这些订单不在 paidCondition 里，
        // 却真的收到了钱。不单列出来，运营就无法解释"钱在哪"，而 markPaid 已经把它们
        // 记成 needsManualReview 的 error 日志了 —— 两边对不上会让人怀疑漏单。
        const [stranded] = await db.select({ count: sql<number>`count(*)`.mapWith(Number), amount: sql<string>`coalesce(sum(${orders.amount} + ${orders.feeAmount} - ${orders.discountAmount}), 0)` }).from(orders).where(and(sql`${orders.transactionId} is not null`, sql`${orders.paidAt} is not null`, sql`${orders.status} not in ('paid','processing','completed')`));
        // 可售存量直接复用 getPlans 的口径（在线可售 = 手工上限 − 已发放），不另写一套算法。
        const planRows = await getPlans(true);
        const sellable = planRows.filter((plan) => plan.delivery === "cdk" && plan.active);
        const lowStock = sellable
          .map((plan) => ({ id: plan.id, name: plan.name, remaining: plan.stockInfo.remaining }))
          .filter((item) => item.remaining !== null && item.remaining <= LOW_STOCK_THRESHOLD)
          .sort((a, b) => (a.remaining ?? 0) - (b.remaining ?? 0));
        const stockTotal = sellable.reduce((sum, plan) => sum + (plan.stockInfo.remaining ?? Number.POSITIVE_INFINITY), 0);
        // 逐字段白名单，**不能** `db.select()` 整行 + `{...item}` 下发。
        // orders 表里有 `deliveryTokenHash`（买家取卡码摘要）与 `cardPasswordHash`
        // （买家账号级取卡密码摘要）。前者是跨邮箱冒领的唯一天然屏障，后者能支撑
        // 离线字典攻击——两者**只是摘要不是明文**，但一旦两个都被拖走，"订单↔密码
        // 摘要↔取卡码摘要"的关联就彻底建立，之后任何一趟别的泄露都能拼成完整攻击链。
        // 白名单是"不该出现在任何对外契约里"的硬边界，不因当前客户端是后台就放松。
        const recent = await db
          .select(ADMIN_ORDER_COLUMNS)
          .from(orders)
          .orderBy(desc(orders.createdAt))
          .limit(8);
        return ok({
          pending: totals.pending,
          processing: totals.processing,
          cancelled: totals.cancelled,
          todayRevenue: Number(today.revenue),
          todayPaid: today.count,
          // 「钱已到账但订单状态未推进」：过期后到账、取消后到账、重复扣款三类。
          // 它们不在 paidCondition 里，所以不进 todayRevenue —— 运营必须能
          // 在看板上单独看到这批钱，否则"钱到了但看板没这笔"看起来就像漏单。
          strandedCount: stranded.count,
          strandedAmount: Number(stranded.amount),
          sellableCount: sellable.length,
          lowStock,
          // 任一上限留空（不限）时不存在"总可售份数"，用 null 表示而非给出误导性数字。
          stockTotal: Number.isFinite(stockTotal) ? stockTotal : null,
          recent,
        });
      }
      if (resource === "orders") {
        const status = url.searchParams.get("status"); const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
        const page = adminPage(url.searchParams.get("page"));
        // Backslash is PostgreSQL's default LIKE escape character, so a % or _ an operator
        // types is matched literally instead of silently turning the search into "list all".
        const like = q ? `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%` : "";
        // 白名单判定必须用 Object.hasOwn：statusLabels 虽然已改成 Object.create(null)，
        // 但真值判断（statusLabels[status] ?）本身仍依赖「查不到就是 undefined」，
        // 一旦有人把它改回对象字面量，?status=constructor 就会命中 Object.prototype
        // 上的键，把非白名单值当成合法状态去查库。
        const statusAllowed = !!status && Object.hasOwn(statusLabels, status);
        const condition = and(statusAllowed ? eq(orders.status, status) : undefined, like ? or(ilike(orders.code, like), ilike(orders.email, like), ilike(orders.planName, like)) : undefined);
        const [total] = await db.select({ value: count() }).from(orders).where(condition);
        // 逐字段投影（白名单），理由同上：orders 含 deliveryTokenHash / cardPasswordHash，
        // 绝不能用整行 `{...item}` 下发。
        const items = await db
          .select(ADMIN_ORDER_COLUMNS)
          .from(orders)
          .where(condition)
          .orderBy(desc(orders.createdAt))
          .limit(15)
          .offset((page - 1) * 15);
        // 卡密发放数用**第二次查询**在应用层合并，而不是 SQL 子查询或 join：
        //   · join 会因 card_keys.order_id 的一对多复制订单行，破坏 limit/offset
        //     的分页语义（同一订单出现多次、总数对不上）；
        //   · 子查询踩过一个隐蔽的坑：drizzle 的 sql 模板会把 ${orders.id} 渲染成
        //     裸的 "id"（它认为该列已在作用域内），而子查询的 FROM 是 card_keys，
        //     于是 "id" 落到 ck.id 上，条件变成 ck.order_id = ck.id —— 恒不匹配、
        //     恒返回 0，且**不报任何错**，表现只是"已推送卡密"标记永不出现。
        //     给 orders 起别名也无效，实测仍渲染为 "id"。
        // 15 条/页 + 一次走 card_keys_order_id_key 索引的聚合，成本可忽略，
        // 而换来的是可预测的语义 —— 这个交换是划算的。
        const ids = items.map((item) => item.id);
        const cardCounts = ids.length
          ? await db
              .select({ orderId: cardKeys.orderId, value: count() })
              .from(cardKeys)
              .where(inArray(cardKeys.orderId, ids))
              .groupBy(cardKeys.orderId)
          : [];
        const cardCountByOrder = new Map(cardCounts.map((row) => [row.orderId, Number(row.value)]));
        return ok({
          items: items.map((item) => ({ ...item, cardKeyCount: cardCountByOrder.get(item.id) ?? 0 })),
          total: total.value,
          page,
          pageSize: 15,
        });
      }
      if (resource === "plans") return ok(await getPlans(true));
      if (resource === "alerts") {
        // 库存预警：把"需要补货"的套餐集中成一个出口。
        // 现阶段只提供数据出口（前端已展示），后续接邮件/Telegram 时不必再改查询逻辑。
        const rows = await getPlans(true);
        const sellable = rows.filter((plan) => plan.delivery === "cdk" && plan.active);
        const low = sellable
          .map((plan) => ({ id: plan.id, name: plan.name, remaining: plan.stockInfo.remaining }))
          .filter((item) => item.remaining !== null && item.remaining <= LOW_STOCK_THRESHOLD)
          .sort((a, b) => (a.remaining ?? 0) - (b.remaining ?? 0));
        return ok({ threshold: LOW_STOCK_THRESHOLD, low, sellableCount: sellable.length });
      }
      if (resource === "cdk") {
        const page = adminPage(url.searchParams.get("page"));
        return ok(await listCardKeys({
          batch: (url.searchParams.get("batch") || "").trim().slice(0, 60) || undefined,
          status: (url.searchParams.get("status") || "").trim(),
          page,
        }));
      }
      if (resource === "settings") {
        // getPaymentSettings() 返回的是「环境变量优先、数据库兜底」合并后的结果，
        // 因此这个响应展示的就是**当前真实生效**的配置，而不是数据库里存了什么。
        // 运营在这里看到的"缺什么"与前台"通道未开启"的提示来自同一份判定。
        const merged = await getPaymentSettings();
        const secrets = secretPresence();
        return ok({
          ...merged,
          // 只回布尔值，绝不回显密钥本身。四个通道的密钥都在环境变量里，
          // 前端只需要知道"配了没有"。
          privateKeyConfigured: secrets.alipayPrivateKey,
          usdtWebhookConfigured: secrets.usdtWebhook,
          epayKeyConfigured: secrets.epayKey,
          binanceKeyConfigured: secrets.binanceApiKey,
          binanceSecretConfigured: secrets.binanceSecret,
          epusdtTokenConfigured: secrets.epusdtToken,
          // 网关就绪状态：让后台直接回答"哪个通道没配好、缺什么"，
          // 而不是让运营对着表单猜。缺配置项在这一屏就能看到。
          gateways: gatewayStatus(),
          channels: allChannelStates(merged),
          mockAvailable: availableGateways().some(g => g.code === "mock"),
        });
      }
      return bad("接口不存在", 404);
    }
    const body = await readJson(request, 16384);
    if (!body) return bad("请求内容无效", 400);
    if (resource === "orders" && id && request.method === "PATCH") {
      if (!validUuid(id)) return bad("订单不存在", 404);
      // ---- 卡密补发必须放在状态推进之前判断 ----
      // 此前它被写在一个同条件的第二个 if 里，而前一个分支已经 return，
      // 导致补发功能永远不可达：运营点「补发卡密」会拿到 200 却什么都没发生，
      // 买家永远收不到新卡。这是资金链路上最恶劣的静默失败。
      if (body.action === "reissue") {
        const [target] = await db.select().from(orders).where(eq(orders.id, id));
        if (!target) return bad("订单不存在", 404);
        if (!(FULFILLABLE_STATUSES as readonly string[]).includes(target.status)) {
          return bad("订单尚未收款，无需补发卡密");
        }
        const reason = String(body.reason || "").trim().slice(0, 100) || "买家反馈未收到";
        const result = await reissueCardKeyForOrder(target.id, target.planId, reason);
        // 并发补发：另一个请求刚换过码。此时不能返回 200 + 一个码——那个码可能
        // 已被覆盖，运营会把它发给买家，而审计日志会显示两次都成功。
        if (result.conflict) return bad("该订单正在被其它请求补发，请刷新后重试", 409);
        if (!result.code) return bad("补发失败：该订单已有其他进行中的卡密，请稍后重试", 409);
        invalidatePlansCache();
        // 明文只随这一次响应返回，与首次发放同一原则。
        logger.audit("cdk.reissued", {
          order: target.code,
          replaced: result.replaced,
          plan: target.planId,
          reason,
          // 因补发而作废的旧订单号。运营需要知道哪些单被自动取消，
          // 否则会出现"买家说他还有一张卡"这种无从查证的争议。
          supersededCount: result.superseded?.length ?? 0,
          by: admin.username,
        });
        return ok({ success: true, code: result.code, replaced: result.replaced, superseded: result.superseded });
      }
      const [order] = await db.select().from(orders).where(eq(orders.id, id));
      if (!order) return bad("订单不存在", 404);
      const status = typeof body.status === "string" ? body.status : order.status;
      if (!Object.hasOwn(statusLabels, status) || (status !== order.status && !statusFlow[order.status]?.includes(status))) return bad("不允许此状态变更，请按订单流程操作", 409);
      const note = String(body.note ?? order.note).trim();
      if (note.length > 1000) return bad("处理说明不能超过 1000 字");
      // 确认闸门必须覆盖**所有**进入 paid 的路径。此前只判 pending -> paid，而
      // statusFlow 里进入 paid 有三条边：pending->paid、cancelled->paid、expired->paid。
      // 后两条恰好就是运营处理「迟到付款」的唯一路径，却不需要任何到账确认、
      // 也不写 transactionId —— 于是一个过期未付款的订单可以被直接改成 paid，
      // 买家随后在结果页就真的领到卡密。改为「任何进入 paid 都必须确认」。
      if (status === "paid" && order.status !== "paid" && body.confirmed !== true) {
        return bad("请先核对真实收款，并勾选人工确认到账");
      }
      // 状态推进时同步写生命周期时间戳，否则会出现「状态是 paid 但 paid_at 为空」
      // 这种自相矛盾的行——对账按时间窗口统计时会把它漏掉。
      // 各时间戳只写一次（首次进入该状态），重复推进不覆盖原始时刻。
      const lifeStamp =
        status === "paid" && !order.paidAt ? { paidAt: new Date() }
        : status === "cancelled" && !order.canceledAt ? { canceledAt: new Date() }
        : {};
      const [updated] = await db.update(orders).set({ status, note, updatedAt: new Date(), ...lifeStamp }).where(and(eq(orders.id, id), eq(orders.status, order.status))).returning();
      if (!updated) return bad("订单状态刚刚发生变化，请刷新后重试", 409);
      // Money-relevant transition. The row only keeps updated_at, which cannot answer
      // "who moved this order to paid, and with what confirmation". One greppable line:
      //   journalctl -u haiou | grep 'category=audit'
      if (status !== order.status) {
        logger.audit("order.status_changed", {
          order: updated.code,
          from: order.status,
          to: status,
          amount: updated.amount,
          method: updated.paymentMethod,
          confirmed: body.confirmed === true,
          by: admin.username,
        });
      }
      return ok(updated);
    }

    if (resource === "plans" && ["POST", "PATCH"].includes(request.method)) {
      if (request.method === "PATCH" && !id) return bad("套餐不存在", 404);
      const [existing] = id ? await db.select().from(plans).where(eq(plans.id, id)) : [];
      if (id && !existing) return bad("套餐不存在", 404);
      const input = { ...existing, ...body };
      if (!["chatgpt", "claude", "grok", "gemini"].includes(input.brand) || !["monthly", "yearly"].includes(input.period)) return bad("套餐品牌或周期无效");
      const name = String(input.name || "").trim(); const description = String(input.description || "").trim(); const price = Number(input.price);
      if (!name || name.length > 60 || !description || description.length > 100 || !Number.isFinite(price) || price < 0.01 || price > 999999) return bad("请填写有效套餐名称、描述和价格（0.01–999999 元）");
      if (!Array.isArray(input.features) || input.features.length < 1 || input.features.length > 8 || input.features.some((f: unknown) => typeof f !== "string" || !f.trim() || f.length > 100)) return bad("请填写 1–8 条套餐权益，每条不超过 100 字");
      const original = input.originalPrice === "" || input.originalPrice == null ? null : Number(input.originalPrice);
      if (original !== null && (!Number.isFinite(original) || original < price || original > 999999)) return bad("划线价不得低于售价，最高 999999 元");
      const badge = String(input.badge || "").trim(); if (badge.length > 12) return bad("角标最多 12 字");
      const sort = Number(input.sort) || 0; if (!Number.isInteger(sort) || sort < 0 || sort > 999) return bad("排序需为 0–999 的整数");
      // 库存上限只对卡密交付的商品生效，留空表示不限。表单可能提交空字符串，所以先按 unknown 处理
      const stockInput: unknown = input.stock;
      const stock = stockInput === "" || stockInput == null ? null : Number(stockInput);
      if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 999999)) return bad("库存上限需为 0–999999 的整数，留空表示不限");
      const delivery = String(input.delivery || "manual");
      if (!["manual", "cdk"].includes(delivery)) return bad("交付方式无效");
      // 手续费率：百分比，最多两位小数，0-100。留空视为 0（不收手续费）。
      // 定价相关字段一律由服务端校验并规范化，前端传什么都以此为准。
      const feeInput: unknown = input.feeRate;
      const feeNumber = feeInput === "" || feeInput == null ? 0 : Number(feeInput);
      if (!Number.isFinite(feeNumber) || feeNumber < 0 || feeNumber > 100 || Math.round(feeNumber * 100) !== feeNumber * 100) return bad("手续费率需为 0-100 的数字，最多两位小数");
      // image 走白名单校验：只接受站内相对路径。绝不允许管理员填外链或绝对路径——
      // 外链会在对方站点挂掉后变成一片破图，绝对路径则会在换域名后全部失效。
      const rawImage = typeof input.image === "string" ? input.image.trim() : "";
      if (rawImage && !/^\/uploads\/plans\/[A-Za-z0-9._-]+$/.test(rawImage)) return bad("套餐图片路径不合法");
      const values: Omit<Plan, "id"> = { brand: input.brand, name, description, period: input.period, price: price.toFixed(2), originalPrice: original === null ? null : original.toFixed(2), features: input.features.map((f: string) => f.trim()), badge: badge || null, active: input.active !== false, sort, stock, delivery, feeRate: feeNumber.toFixed(2), image: rawImage || null, deletedAt: null };
      const [result] = id ? await db.update(plans).set(values).where(eq(plans.id, id)).returning() : await db.insert(plans).values({ ...values, id: randomUUID() }).returning();
      invalidatePlansCache();

      // 套餐是资金与库存的载体：改价 / 改库存上限 / 改交付方式 / 改费率都会立刻影响

      // 买家实付与可售份数，而 plans 行除了 updatedAt 之外什么都不留。批量路径

      // /api/admin/plans/bulk 有 plan.bulk_updated，单条路径却没有 —— 同一件事有审计

      // 和没审计两条路径，"谁在什么时候把 Plus 从 119 改成 99"无处可查。

      // before 取自库里读出的旧行，after 取自规范化后的落库值（result），都不是前端

      // 提交的原始 body：前端可能送字符串/空串，落库值才是事实。

      const before = existing

        ? { price: existing.price, stock: existing.stock, active: existing.active, delivery: existing.delivery, feeRate: existing.feeRate }

        : { price: null, stock: null, active: null, delivery: null, feeRate: null };

      logger.audit(id ? "plan.updated" : "plan.created", {

        plan: result.id,

        price_before: before.price, price_after: result.price,

        stock_before: before.stock, stock_after: result.stock,

        active_before: before.active, active_after: result.active,

        delivery_before: before.delivery, delivery_after: result.delivery,

        feeRate_before: before.feeRate, feeRate_after: result.feeRate,

        by: admin.username,

      });

      return ok(result, id ? 200 : 201);
    }
    if (resource === "settings" && request.method === "PATCH") {
      // 全站接单开关：独立成一个轻量动作，且必须放在下面那堆支付校验之前——
      // 「临时停止接单」是高频运维操作，不该被"汇率/网关是否填好"绑住，
      // 也不该每次都提交整个支付配置表单。
      if (String(body.action || "") === "store") {
        const open = body.open === true;
        const reason = String(body.reason || "").trim().slice(0, 200);
        await db.update(paymentSettings).set({ storeOpen: open, pausedReason: open ? "" : reason }).where(eq(paymentSettings.id, 1));
        invalidateSettingsCache();
        logger.audit("store.toggled", { open, reasonProvided: !!reason, by: admin.username });
        return ok({ success: true, storeOpen: open });
      }
      const rate = Number(body.exchangeRate); if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return bad("汇率需大于 0 且不超过 1000");
      // 通道费率校验。四条通道的费率含义相同（支付通道向商家抽走的比例），
      // 但由运营分别填写，因为支付宝是百分比、易支付按签约、USDT 要按链上费折算。
      // 上限 50：再高反算出的买家应付会明显脱离套餐价，既不合理也会招投诉。
      const readFee = (raw: unknown, fallback: number) => {
        if (raw === undefined || raw === null || raw === "") return fallback;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 50) throw new Error("RATE");
        return n;
      };
      let alipayFee: number, epayFee: number, usdtFee: number, binanceFee: number, epusdtFee: number;
      try {
        alipayFee = readFee(body.alipayFeeRate, 0.6);
        epayFee = readFee(body.epayFeeRate, 0);
        usdtFee = readFee(body.usdtFeeRate, 6);
        binanceFee = readFee(body.binanceFeeRate, 0);
        epusdtFee = readFee(body.epusdtFeeRate, 0);
      } catch {
        return bad("通道费率需在 0 到 50 之间（百分比）");
      }

      // ---- 凭据字段：环境变量优先，表单值作为兜底写回数据库 ----
      //
      // 此前这里是「表单填什么就存什么，缺一样就拒绝保存」。加上环境变量优先之后，
      // 运营完全可以在 .env 里配好密钥、从而不碰这些输入框——但**表单里原有的值
      // 不能因此被清空**：那些值是环境变量缺失时的兜底（老部署依赖它）。
      // 因此下面用 `envX ?? formX` 参与校验与落库，而不是只认表单。
      const secrets = secretPresence();
      const envOf = (name: string) => (process.env[name]?.trim() || undefined);

      const wallet = envOf("USDT_WALLET_ADDRESS") ?? String(body.walletAddress || "").trim();
      if (wallet && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(wallet)) return bad("请填写有效的 TRON 钱包地址（T 开头，共 34 位）");
      const gateway = envOf("ALIPAY_GATEWAY") ?? String(body.alipayGateway || "");
      if (!["https://openapi.alipay.com/gateway.do", "https://openapi-sandbox.dl.alipaydev.com/gateway.do"].includes(gateway)) return bad("仅支持支付宝官方生产或沙箱网关");
      const appId = envOf("ALIPAY_APP_ID") ?? String(body.alipayAppId || "").trim();
      const sellerId = envOf("ALIPAY_SELLER_ID") ?? String(body.alipaySellerId || "").trim();
      const publicKey = envOf("ALIPAY_PUBLIC_KEY") ?? String(body.alipayPublicKey || "").trim();
      const siteUrl = (envOf("SITE_URL") ?? String(body.siteUrl || "").trim()).replace(/\/$/, "");
      if (appId && !/^\d{16}$/.test(appId)) return bad("支付宝 App ID 应为 16 位数字");
      if (sellerId && !/^\d{12,24}$/.test(sellerId)) return bad("请填写正确的支付宝商户 PID");
      if (publicKey.length > 8192) return bad("支付宝公钥长度异常");
      if (siteUrl) { try { const parsed = new URL(siteUrl); if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return bad("站点地址应为 HTTPS 域名，不含路径，例如 https://your-domain.com"); } catch { return bad("请填写有效站点域名"); } }
      if (body.alipayEnabled && (!appId || !sellerId || !publicKey || !siteUrl || !secrets.alipayPrivateKey)) return bad("启用支付宝需要 App ID、商户 PID、公钥、站点域名，并在服务器设置 ALIPAY_PRIVATE_KEY");
      // 易支付（聚合收银台）：地址与商户号入库，签名密钥只认环境变量。
      const epayUrl = (envOf("EPAY_URL") ?? String(body.epayUrl || "").trim()).replace(/\/+$/, "");
      const epayPid = envOf("EPAY_PID") ?? String(body.epayPid || "").trim();
      const epayEnabled = body.epayEnabled === true;
      if (epayUrl && !/^https?:\/\/[^\s]+$/i.test(epayUrl)) return bad("收银台网关地址需以 http(s):// 开头");
      if (epayPid && !/^\d+$/.test(epayPid)) return bad("收银台商户 PID 需为纯数字");
      if (epayEnabled && (!epayUrl || !epayPid || !secrets.epayKey)) return bad("开启收银台前请填写网关地址与商户 PID，并在服务器设置 EPAY_KEY 签名密钥");
      // epusdt（自建 USDT 收银台）：地址与 PID 入库，secret_key 只认环境变量。
      // secret_key 等价于收银台的提款权限，泄露等于任何人都能伪造"已收款"通知，
      // 因此与其它密钥同一原则：只从环境变量读，不入库、不下发浏览器。
      const epusdtUrl = (envOf("EPUSDT_URL") ?? String(body.epusdtUrl || "").trim()).replace(/\/+$/, "");
      const epusdtEnabled = body.epusdtEnabled === true;
      if (epusdtUrl && !/^https?:\/\/[^\s]+$/i.test(epusdtUrl)) return bad("自建收银台地址需以 http(s):// 开头");
      if (epusdtEnabled && (!epusdtUrl || !secrets.epusdtToken)) {
        return bad("开启自建收银台前请填写网关地址，并在服务器设置 EPUSDT_TOKEN 签名密钥");
      }
      // 币安支付：商户号入库，API Key / Secret 只认环境变量。
      const binanceMerchantId = envOf("BINANCE_PAY_MERCHANT_ID") ?? String(body.binanceMerchantId || "").trim();
      const binanceEnabled = body.binanceEnabled === true;
      if (binanceMerchantId && !/^\d{6,20}$/.test(binanceMerchantId)) return bad("币安商户号应为 6~20 位数字");
      if (binanceEnabled && (!binanceMerchantId || !secrets.binanceApiKey || !secrets.binanceSecret)) {
        return bad("开启币安支付需要商户号，并在服务器设置 BINANCE_PAY_API_KEY 与 BINANCE_PAY_SECRET");
      }
      await getPaymentSettings();
      await db.update(paymentSettings).set({
        usdtEnabled: body.usdtEnabled === true,
        walletAddress: wallet,
        exchangeRate: rate.toFixed(4),
        alipayEnabled: body.alipayEnabled === true,
        alipayAppId: appId,
        alipaySellerId: sellerId,
        alipayPublicKey: publicKey,
        alipayGateway: gateway,
        siteUrl,
        epayEnabled,
        epayUrl,
        epayPid,
        epusdtEnabled,
        epusdtUrl,
        epusdtToken: String(body.epusdtToken || "usdt.trc20").trim().toLowerCase().slice(0, 20) || "usdt.trc20",
        epusdtFeeRate: epusdtFee.toFixed(2),
        binanceEnabled,
        binanceMerchantId,
        binanceCurrency: String(body.binanceCurrency || "USDT").trim().toUpperCase().slice(0, 10) || "USDT",
        alipayFeeRate: alipayFee.toFixed(2),
        epayFeeRate: epayFee.toFixed(2),
        usdtFeeRate: usdtFee.toFixed(2),
        binanceFeeRate: binanceFee.toFixed(2),
      }).where(eq(paymentSettings.id, 1));
      invalidateSettingsCache();
      // Where the money goes is at least as important to trace as an order status change.
      // The public key and the private key are deliberately never written to logs.
      logger.audit("settings.saved", {
        usdt: body.usdtEnabled === true,
        alipay: body.alipayEnabled === true,
        epay: epayEnabled,
        epusdt: epusdtEnabled,
        binance: binanceEnabled,
        wallet: wallet || "none",
        exchangeRate: rate.toFixed(4),
        gateway,
        siteUrl: siteUrl || "none",
        by: admin.username,
      });
      return ok({ success: true });
    }
    if (resource === "cdk-rule") {
      // 卡密规则是「生成规则」的唯一来源。改它必须连带：
      //   1) 规范化并校验，避免运营把前缀设成 0 位或把主体长度设到不安全值；
      //   2) 失效缓存，让下一张卡立刻用新规则；
      //   3) 保留 acceptLegacy，让已售出未核销的旧卡不因改前缀而作废。
      if (request.method === "GET") return ok(await getCdkRule());
      if (request.method === "PATCH") {
        const current = await getCdkRule();
        // acceptLegacy 的默认是"保持原值"而不是"保持 true"：
        // 运营显式关掉后再提交其它字段，不应被悄悄改回来。
        const next = normalizeCdkRule({
          prefix: body.prefix === undefined ? current.prefix : String(body.prefix),
          bodyLength: body.bodyLength === undefined ? current.bodyLength : Number(body.bodyLength),
          groupSize: body.groupSize === undefined ? current.groupSize : Number(body.groupSize),
          separator: body.separator === undefined ? current.separator : String(body.separator),
          acceptLegacy: body.acceptLegacy === undefined ? current.acceptLegacy : body.acceptLegacy === true,
        });
        // 规范化会静默回落默认值，因此要回读比对，把"被回落"当成错误报给运营，
        // 否则他以为设成了 30 位主体、实际只有 16 位，这种静默失败最难发现。
        if (body.prefix !== undefined && next.prefix !== String(body.prefix).toUpperCase().replace(/[^0-9A-Z]/g, "")) {
          return bad("卡密前缀只能包含字母与数字，长度 2-6 位");
        }
        if (body.bodyLength !== undefined && next.bodyLength !== Number(body.bodyLength)) {
          return bad("卡密主体长度需在 12-24 位之间");
        }
        // ---- 破坏性变更保护 ----
        // isValidCdk 的三条兼容分支全部锚定 rule.bodyLength：运营把 16 改成 20，所有已发出的
        // PH+16 卡（归一化 18 字符）三条分支会同时判非法，存量未核销卡集体作废；关闭
        // acceptLegacy 同理。而这两种操作此前只是一个数字字段/一个复选框，没有确认、没有
        // 影响面数字，误点即资损且不可逆。
        // 因此：先把「会作废多少张未核销卡」算出来，若不为 0 就要求请求原样带回这个数字
        // （confirmOrphan）。严格相等比较——字符串 "5"、少填、多数都会被 409 挡回去。
        // bodyLength 发生**任何**变更都要确认，不只是变小。
        // 依据是 isValidCdk 的三条兼容分支全都锚定 rule.bodyLength：
        //   · startsWith(前缀) 分支要求 body 长 == rule.bodyLength；
        //   · legacy 分支要求总长 == LEGACY_CDK_LENGTH(16)；
        //   · shaped 正则按 bodyLength 拼出精确长度。
        // 于是把 16 调成 20 时，已发出的 PH+16（归一化 18 字符）三条分支
        // 同时判非法 —— 无论调大还是调小，存量卡都会集体作废。
        // 早先只拦"变小"，是漏掉了调大这一半，同样是静默作废全部在手卡密。
        const changesBody = next.bodyLength !== current.bodyLength;
        const dropsLegacy = current.acceptLegacy && !next.acceptLegacy;
        let orphaned = 0;
        if (changesBody || dropsLegacy) {
          const [row] = await db.select({ value: count() }).from(cardKeys).where(eq(cardKeys.status, "unused"));
          orphaned = Number(row?.value ?? 0);
          if (orphaned > 0 && body.confirmOrphan !== orphaned) {
            return bad(`该变更将作废 ${orphaned} 张未核销卡密，请以 confirmOrphan: ${orphaned} 重新提交`, 409);
          }
        }
        await db.update(cdkSettings).set({ ...next, updatedAt: new Date() }).where(eq(cdkSettings.id, 1));
        invalidateCdkRuleCache();
        // 立刻生成一张样例卡给运营看效果，比让他猜格式对不对更可靠。
        const sample = newCdk(next);
        logger.audit("cdk.rule_changed", { prefix: next.prefix, bodyLength: next.bodyLength, acceptLegacy: next.acceptLegacy, changesBody, dropsLegacy, orphanedCards: orphaned, by: admin.username });
        return ok({ ...next, sample });
      }
      return bad("不支持的操作", 405);
    }

    if (resource === "cdk" && request.method === "POST") {
      const planId = String(body.planId || "");
      const [plan] = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, planId));
      if (!plan) return bad("请选择有效的套餐");
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BATCH) return bad(`单次生成数量需在 1–${MAX_BATCH} 之间`);
      const note = String(body.note ?? "").trim().slice(0, 200);
      // 次卡：一次生成可核销多次的卡。留空 = 只能用一次（默认）。
      const maxUsesRaw = body.maxUses === "" || body.maxUses == null ? null : Number(body.maxUses);
      if (maxUsesRaw !== null && (!Number.isInteger(maxUsesRaw) || maxUsesRaw < 1 || maxUsesRaw > 1000)) return bad("可用次数需为 1-1000 的整数，或留空表示一次性卡密");
      const result = await generateCardKeys(plan.id, quantity, note, maxUsesRaw);
      invalidatePlansCache(); // 批量生成会改变卡密池 unused 计数
      // 明文只随这一次响应返回，之后无法再取回
      logger.audit("cdk.batch_generated", { batch: result.batch, count: result.count, plan: plan.id, by: admin.username });
      return ok(result, 201);
    }
    if (resource === "cdk" && request.method === "PATCH") {
      if (String(body.action || "") === "query") {
        const codes = Array.isArray(body.codes) ? body.codes.map(String) : [];
        if (codes.length < 1 || codes.length > MAX_BATCH) return bad(`批量查询一次最多 ${MAX_BATCH} 张卡密`);
        const items = await queryCardKeys(codes);
        logger.audit("cdk.batch_queried", { count: items.length, by: admin.username });
        return ok({ items });
      }
      // 长度上限与列表筛选的 slice(0, 60) 对齐，避免把任意长度的串送进 where。
      const batch = String(body.batch || "").trim().slice(0, 60);
      if (!batch) return bad("请指定要作废的批次");
      // 在线售卖批次必须在服务端拒绝（数据层 revokeBatch 也有一道，见 lib/cdk）。
      // 409 而不是 400：这不是参数写错，而是一个语义上不被允许的目标。
      if (batch === ONLINE_BATCH) return bad(ONLINE_BATCH_REVOKE_ERROR, 409);
      const revoked = await revokeBatch(batch);
      invalidatePlansCache(); // 作废会改变卡密池 unused 计数，套餐库存口径随之变化
      logger.audit("cdk.batch_revoked", { batch, count: revoked, by: admin.username });
      return ok({ revoked });
    }
    return bad("接口不存在", 404);
  } catch (error) {
    logger.error("admin.request_failed", { resource, method: request.method }, error);
    return bad("操作失败，请检查数据或稍后重试", 500);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
