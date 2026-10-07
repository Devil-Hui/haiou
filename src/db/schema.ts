import { pgTable, uuid, text, integer, numeric, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  brand: text("brand").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  period: text("period").notNull().default("monthly"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  originalPrice: numeric("original_price", { precision: 10, scale: 2 }),
  features: jsonb("features").$type<string[]>().notNull(),
  badge: text("badge"),
  active: boolean("active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  // 在线售卖的发放上限；null 表示不限。只对 delivery = "cdk" 的商品生效
  stock: integer("stock"),
  // "manual" = 人工代充（既有流程），"cdk" = 付款后实时发放卡密
  delivery: text("delivery").notNull().default("manual"),
  // 手续费率（百分比，允许两位小数，0-100）。下单时按它算出手续费金额并锁进订单，
  // 之后运营改费率不会影响历史订单。参照独角数卡的做法放在商品级，
  // 这样贵重档位可以单独设 0% 促销，而不必全站统一。
  feeRate: numeric("fee_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  // 套餐主图。后台上传，路径存站内相对路径（如 /uploads/plans/xxx.png），
  // 绝存绝对路径或外链——外链会在对方站点挂掉后变成一片破图。
  image: text("image"),
  // 软删除。orders.plan_id 上有指向 plans.id 的外键且无 onDelete，
  // 硬删除会让"有历史订单的套餐"永远删不掉（后台一点删除就报外键错误）。
  // 改为软删除：数据保留、订单可追溯，列表按 deletedAt 过滤即可。
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// 优惠券每人限用占用表
//
// 为什么需要这张表：coupons.perUserLimit 此前是「查 orders 表里该邮箱用该券的
// 次数」，一个**事务外的普通 SELECT**。8 个并发下单请求（限流正好是 8/分/IP）
// 会在彼此的订单落库前都读到 count=0 → 全部通过 → **一张"每人限用 1 张"的券
// 被用 8 次**。券的面额是钱，这是直接的资金损失。
//
// 正确的做法是把"占用"变成一次可原子判定的写入：主键 (coupon_id, email) 保证
// 同一邮箱对同一张券只能占有一行，per_user_limit > 1 时由 nth 次插入承担。
// 这与 coupons.used_count 用「一条带条件的 UPDATE」解决 totalLimit 是同一个
// 思路——让数据库来判并发，而不是让应用先读后写。
// ---------------------------------------------------------------------------

export const couponRedemptions = pgTable("coupon_redemptions", {
  // 合成主键：同一邮箱对同一张券只占一行（per_user_limit = 1 的情形）。
  // per_user_limit > 1 时改用下面的 (coupon_id, email, nth) 唯一约束。
  couponId: uuid("coupon_id").notNull().references(() => coupons.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  // 第几次占用（从 1 开始）。per_user_limit = 1 时恒为 1。
  nth: integer("nth").notNull().default(1),
  orderCode: text("order_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // 一次核销的判定完全依赖这个唯一约束：插入撞上就说明该邮箱已用满。
  uniqueIndex("coupon_redemptions_once_key").on(table.couponId, table.email, table.nth),
  index("coupon_redemptions_email_idx").on(table.email),
]);
// ---------------------------------------------------------------------------
// 分类（四个品牌升级为一等实体）
//
// 之前 brand 只是 plans 上一个自由文本，取值靠 TypeScript 的 Brand 联合类型约束。
// 这在"只有四个固定品牌"时够用，但一旦要支持运营在后台新增分类、给分类配图、
// 调整顺序，就无处安放——而这正是可视化套餐设计器的前提。
//
// 关键设计：categories.id 直接沿用原来的 brand 取值（chatgpt/claude/grok/gemini），
// 因此 plans.brand 与 categories.id 天然对齐，不需要迁移任何历史数据，
// 也不会出现"两套 ID 体系并存"的双源真相。
// ---------------------------------------------------------------------------

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  company: text("company").notNull().default(""),
  description: text("description").notNull().default(""),
  // 分类图标/配图，站内相对路径。
  image: text("image"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
}, table => [
  // 前台每次渲染都要"取启用的分类并按 sort 排序"，组合索引让它走 Index Only Scan。
  index("categories_active_sort_idx").on(table.active, table.sort),
]);

export type Category = typeof categories.$inferSelect;

// ---------------------------------------------------------------------------
// 卡密规则（单例）
//
// 为什么要把它变成配置而不是写死在代码里：
//   运营会在不同批次使用不同前缀（首批 PH 试水、正式版改成 WH 以便区分渠道）。
//   若前缀写死，每换一次就得改代码并发版，而卡密是长生命周期的数据——
//   改规则时如果不能兼容已发出的旧卡密，运营手里没卖完的卡会立刻全部作废。
//
// 因此规则分两部分，缺一不可：
//   · prefix 等「新规则」：只影响此后生成的卡密。
//   · acceptLegacy 等「兼容策略」：决定改造前发出的无前缀卡密是否继续可用。
// 两者分离，改前缀不会波及存量；关掉兼容开关则是一次有意识的破坏性动作，
// 运营能主动选择，而不是被动承受。
//
// 安全说明：前缀是公开信息，不影响卡密强度。卡密熵全部来自 body，
// 与前缀无关，因此开放自定义前缀不会削弱暴力破解的难度。
// ---------------------------------------------------------------------------

export const cdkSettings = pgTable("cdk_settings", {
  id: integer("id").primaryKey().default(1),
  // 卡密前缀。仅允许 A-Z 与 0-9，长度 2-6。默认 PH。
  prefix: text("prefix").notNull().default("PH"),
  // 前缀之后的随机主体长度。16 × 5bit = 80 bit 随机，是全站强度最高的凭据。
  bodyLength: integer("body_length").notNull().default(16),
  // 展示时的分组大小与分隔符，只影响给人看的排版，不影响校验。
  groupSize: integer("group_size").notNull().default(4),
  separator: text("separator").notNull().default("-"),
  // 是否继续接受「无前缀」的旧格式卡密。存量未清空前必须为 true。
  acceptLegacy: boolean("accept_legacy").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  planId: text("plan_id").notNull().references(() => plans.id),
  planName: text("plan_name").notNull(),
  brand: text("brand").notNull(),
  period: text("period").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  // 手续费金额：下单时按当时的商品费率算出并锁定。买家实付 = amount + feeAmount。
  // 单独存列而不是每次现算，是为了让"这笔订单当初收多少手续费"可追溯——
  // 费率改版后，历史订单的手续费不会被新规则改写。
  feeAmount: numeric("fee_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  // 优惠券抵扣金额，与手续费一样在下单时锁定。0 表示未使用。
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  // 下单时使用的券码摘要。存摘要而非明文，与卡密同一原则：拖库拿不到可用券码。
  couponCode: text("coupon_code"),
  // ---- 两种邮箱：必须分开存，否则「个人中心」永远看不到访客期的订单 ----
  //
  // `email` = **激活邮箱**：买家在 ChatGPT / Claude 等平台注册的邮箱，
  //   即本次要充值的那个账号。它是充值链路的归属凭据（submitRecharge 按它比对）。
  //   结算页文案已明确要求「填写需要升级的账号邮箱」。
  //
  // `purchaseEmail` = **购买邮箱**：买家在本网站用于查询/管理订单的邮箱，
  //   可以与激活邮箱相同（多数情况），也可以不同（用别名/工作邮箱注册本站）。
  //
  // 为什么必须新增一列而不能复用 email：个人中心按购买邮箱查，而充值按激活邮箱查，
  // 两者在「用户用 B 邮箱注册本站、用 A 邮箱充值」时不相等。共用一列时
  // 个人中心会显示 0 笔订单——这不是显示问题，是用户看不到自己付过钱。
  //
  // 历史订单没有这一列（null），查询时必须用 `purchaseEmail = email OR purchaseEmail IS NULL`
  // 兼容回退，否则上线瞬间所有老订单都会从个人中心消失。
  purchaseEmail: text("purchase_email"),
  // ---- 取卡密码摘要 ----
  //
  // 访客下单时可选设置一个「取卡密码」，之后凭「购买邮箱 + 该密码」即可查历史、发卡，
  // 不必注册本站账号。用 scrypt（与账号密码同一强度），**永不存明文**。
  //
  // 为什么是订单级而不是用户级：多数访客只买过一次，让他为了查一次订单去注册
  // 账号是纯粹的流失点。订单级密码不需要注册、不需要邮箱验证，落地成本最低。
  //
  // 为 null 表示买家未设置 → 只能凭一次性取卡码取卡（保持原有行为不变）。
  cardPasswordHash: text("card_password_hash"),
  email: text("email").notNull(),
  paymentMethod: text("payment_method").notNull(),
  usdtAmount: numeric("usdt_amount", { precision: 14, scale: 6 }),
  walletAddress: text("wallet_address"),
  status: text("status").notNull().default("pending"),
  transactionId: text("transaction_id").unique(),
  // 一次性取卡码的摘要。买家付款后可见，凭「订单号 + 取卡码」取卡密。
  //
  // 为什么必须有（这是本项目最致命的攻击面）：
  // 本站注册只需 email + password，**无任何邮箱所有权验证**。于是攻击者只要
  // 知道受害者邮箱（下单必填，等于半公开），就能注册该邮箱并拿到会话；
  // 之后 currentUser().email === order.email 成立，个人中心又会把他名下
  // 全部历史订单列出来。若归属判定只依赖邮箱，攻击者即可逐单取走所有卡密 ——
  // 一次注册 = 一次账号接管。
  //
  // 取卡码是**攻击者拿不到**的那一份信息：它只在下单成功时展示一次，站点
  // 不再保存明文（只有 sha256 摘要）。知道订单号、知道邮箱都没用。
  // 买家自己的路径不受影响：首次下单时前端会把它存到 localStorage。
  deliveryTokenHash: text("delivery_token_hash"),
  note: text("note").notNull().default(""),
  // ---- 订单生命周期（P1-3）----
  // 之前订单只有 status 一个自由文本，没有任何时间标记，导致三个问题：
  //   1. 支付超时无法自动关闭，买家不付的订单永远停在 pending，列表越积越多；
  //   2. 对账时无法回答"这笔到底什么时候付的款"；
  //   3. 客服看到"已取消"订单查不到取消时间，只能靠猜。
  // 三列各自只写一次（创建/支付/取消时），读时可独立筛选，不依赖 status 反推。
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // 过期清理任务按「状态 + 截止时间」扫描到期未付订单。缺这个索引就是全表扫描，
  // 而它每天都要跑一次，订单量上万时代价明显。
  index("orders_pending_expires_idx").on(table.expiresAt).where(sql`status = 'pending'`),
  // 后台列表默认按创建时间倒序翻页、概览取最近 5 单、7 日区间统计都走这个索引。
  // 没有它，这几条查询是"全表扫描 + 排序"，复杂度 O(n log n)；有了是 O(log n + k)。
  index("orders_created_at_idx").on(table.createdAt.desc()),
  // 个人中心与访客列表都按购买邮箱查；充值与交付闸门仍按激活邮箱（email）查。
  // 两条路径都是热路径，各自建索引避免全表扫。
  index("orders_purchase_email_idx").on(table.purchaseEmail),
  // 兼容回退用：历史订单 purchaseEmail 为 null，查询条件是
  // `purchase_email = ? OR purchase_email IS NULL`，需要能只扫 NULL 那一部分。
  index("orders_purchase_email_null_idx").on(table.purchaseEmail).where(sql`purchase_email IS NULL`),
  // 按状态筛选是后台最常用的视图之一。单列 status 索引仍需排序，
  // 组合索引让"过滤 + 排序 + 分页"一次索引扫描完成。
  index("orders_status_created_at_idx").on(table.status, table.createdAt.desc()),
]);

export const cardKeys = pgTable("card_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  // 只存摘要：数据库被拖库时拿不到任何可用卡密。代价是生成后只能展示一次，
  // 所以生成接口当场返回明文，列表接口永远看不到。
  codeHash: text("code_hash").notNull().unique(),
  batch: text("batch").notNull(),
  planId: text("plan_id").notNull().references(() => plans.id),
  status: text("status").notNull().default("unused"),
  // 次卡模式：总可用次数。1 = 只能用一次（默认，即普通卡密）；>1 = 同一张卡可反复核销。
  //
  // maxUses = null **不是**「不限次」，而与 1 等价：核销侧一律按 `row.maxUses ?? 1`
  // 判定（lib/cdk 的 redeemCardKey），后台文案也写着"留空表示一次性卡密"。
  //
  // 为什么 null 不能解释成不限次：card_keys_order_id_key 让 order_id 唯一，
  // 一张卡第 2 次核销必然要再绑一个订单 → 撞唯一约束 → 事务回滚 → 卡密退回
  // unused → 永远核销不了。这与 issueVersion / transaction_id 那段死循环同类。
  // 真要做"不限次"必须先改归属模型（归属只认首次核销、后续订单挂到别处），
  // 那是独立需求；不要顺手把 null 当成"无限"来实现。
  maxUses: integer("max_uses"),
  usedTimes: integer("used_times").notNull().default(0),
  orderId: uuid("order_id"),
  // 发放轮次。补发时 +1。
  //
  // 为什么必须有：核销时写入的 orders.transaction_id 形如 cdk:<cardId>，
  // 而 orders.transaction_id 上有唯一约束。补发是「就地换码」（同一行 card_keys.id
  // 不变，只换 codeHash 并把 used_times 归零），于是新码核销时算出的
  // transaction_id 与第一次**完全相同** → 撞唯一索引 → 语句抛错 → 整个事务回滚
  // → 卡密退回 unused。这是个死循环：重试多少次都撞同一行，永远核销不了。
  //
  // 把轮次纳入 transaction_id 后，每次补发产生一个全新的交易号，历史记录也不会
  // 被覆盖，对账时能看出"这是第几轮发放"。
  issueVersion: integer("issue_version").notNull().default(1),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp("used_at", { withTimezone: true }),
}, table => [
  index("card_keys_batch_idx").on(table.batch),   // 按批次作废与筛选
  index("card_keys_status_idx").on(table.status), // 库存统计（未使用数量）
  // 首页每次渲染都要按 plan_id 汇总库存（getPlans -> cardKeyCounts），在线发放时还要按
  // (plan_id, batch) 数已发数量。前者是无 WHERE 的全表聚合，本身 O(n)，普通索引帮不上；
  // 只有把 status 也放进索引，PostgreSQL 才能走 Index Only Scan 免去回表（2 万行实测
  // 3.8ms、堆访问 50 次）。三列同时满足两种用法，因此不必再单独建 (plan_id, batch)。
  index("card_keys_plan_id_batch_idx").on(table.planId, table.batch, table.status),
  // 一张订单最多持有一张卡密：在线发放时用唯一约束保证「只发一次」，
  // 并发请求只会有一条插入成功，其余落到 onConflictDoNothing。
  uniqueIndex("card_keys_order_id_key").on(table.orderId),
]);

export const paymentSettings = pgTable("payment_settings", {
  id: integer("id").primaryKey().default(1),
  usdtEnabled: boolean("usdt_enabled").notNull().default(false),
  walletAddress: text("wallet_address").notNull().default(""),
  exchangeRate: numeric("exchange_rate", { precision: 10, scale: 4 }).notNull().default("7.20"),
  alipayEnabled: boolean("alipay_enabled").notNull().default(false),
  alipayAppId: text("alipay_app_id").notNull().default(""),
  alipaySellerId: text("alipay_seller_id").notNull().default(""),
  alipayPublicKey: text("alipay_public_key").notNull().default(""),
  alipayGateway: text("alipay_gateway").notNull().default("https://openapi.alipay.com/gateway.do"),
  siteUrl: text("site_url").notNull().default(""),
  // ---- 全站接单开关 ----
  // 维护、支付通道故障、收到滥用举报时，一键停止新下单。已存在的订单不受影响，
  // 仍可正常查单与到账确认（否则买家付了钱却查不到单，比暂停更糟）。
  storeOpen: boolean("store_open").notNull().default(true),
  // 暂停时展示给买家的原因。留空则用默认文案，避免出现"暂停了但没说为什么"。
  pausedReason: text("paused_reason").notNull().default(""),
  // ---- 易支付（聚合收银台）----
  // 一次对接即可覆盖支付宝 / 微信 / QQ 钱包 / USDT 等通道，省去为每家单独做原生接入。
  // 密钥与签名 MD5 私钥只放环境变量 EPAY_KEY，与支付宝私钥同一原则：不入库、不下发浏览器。
  epayEnabled: boolean("epay_enabled").notNull().default(false),
  epayUrl: text("epay_url").notNull().default(""),
  epayPid: text("epay_pid").notNull().default(""),
  // ---- 币安支付（Binance Pay）----
  // 商户号入库，API Key / Secret 只认环境变量（与支付宝私钥、易支付密钥同一原则）。
  // 币安要求商家资质（KYB，需企业主体），个人账号开通不了 —— 选它之前要知道这个前提。
  binanceEnabled: boolean("binance_enabled").notNull().default(false),
  binanceMerchantId: text("binance_merchant_id").notNull().default(""),
  // 收哪种稳定币。绝大多数商户选 USDT；字段留着是因为币安支持多币种，
  // 硬编码成 USDT 会在想换币种时逼着改代码。
  binanceCurrency: text("binance_currency").notNull().default("USDT"),
  // ---- epusdt（自建 USDT 收银台）----
  // 与币安的关键区别：**不需要企业资质**。它是你自己部署的一个服务，
  // 钱直接进你自己的 TRC20 钱包，不经过任何交易所，因此没有 KYB 门槛。
  // secret_key 只认环境变量（与其它通道同一原则）：它等价于收银台的提款权限，
  // 泄露等于任何人都能伪造"已收款"通知。
  epusdtEnabled: boolean("epusdt_enabled").notNull().default(false),
  // 收银台地址与商户号独立于易支付存：两者是**不同的网关**、不同的密钥算法
  // （易支付 MD5，epusdt HMAC-SHA256）。复用同一列会导致两个通道只能开一个。
  epusdtUrl: text("epusdt_url").notNull().default(""),
  // 收的币种与链，BEpusdt 用一个字段合写，形如 usdt.trc20 / usdc.base / sol。
  // 默认 usdt.trc20 —— 与本站 USDT 直充通道同一条链，买家不必学两套网络。
  epusdtToken: text("epusdt_token").notNull().default("usdt.trc20"),
  // ---- 通道费率（百分比）----
  //
  // 支付通道向**商家**抽走的比例。运营在后台填的套餐价是"扣完这一层之后
  // 实收多少"，所以买家应付必须反算：实付 = 标价 / (1 - 通道费率)。
  // 不做这层换算的话，运营填 119、支付宝抽 0.6%，实际到手 118.29，
  // 每单都差 7 分，账目与后台标价长期对不上。
  //
  // 与 plans.feeRate（加价率，向买家额外收的部分 = 利润）是两回事：
  //   channelRate = 成本，运营承担
  //   feeRate     = 利润，向买家收
  alipayFeeRate: numeric("alipay_fee_rate", { precision: 5, scale: 2 }).notNull().default("0.60"),
  epayFeeRate: numeric("epay_fee_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  // 默认 6.00 而不是 1.00：TRC20 链上费是**固定约 1 USDT**，不按金额比例收。
  // 按 1% 算，119 元订单只收回 1.19 元，而真实链上费约 7.2 元，每单倒贴 6 元。
  // 曾经这里写 1.00，而 pricing.ts 的兜底值是 6 —— 新建库落到 1.00，
  // 于是「代码里的 6」与「库里的 1」长期不一致，且没有任何症状。
  usdtFeeRate: numeric("usdt_fee_rate", { precision: 5, scale: 2 }).notNull().default("6.00"),
  // 币安 Pay 商家侧手续费通常为 0（链上转账费由币安承担），因此默认 0。
  binanceFeeRate: numeric("binance_fee_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  // epusdt 同理：「通道」这一层不抽成，钱直接进你自己的钱包。
  // 真实成本是链上费，与 usdt_fee_rate 用同一套折算逻辑，不是 0。
  epusdtFeeRate: numeric("epusdt_fee_rate", { precision: 5, scale: 2 }).notNull().default("0"),
});

export const admins = pgTable("admins", {
  id: integer("id").primaryKey().default(1),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  sessionHash: text("session_hash"),
  sessionExpires: timestamp("session_expires", { withTimezone: true }),
});

// 普通用户账号（可选）：注册 / 登录后便于查询本人订单。下单仍支持免注册的邮箱查单。
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  sessionHash: text("session_hash"),
  sessionExpires: timestamp("session_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 公告：停售通知、系统维护、到账延迟说明都走这里，而不是写死在页面文案里。
// 运营需要能在不发版的情况下改一句话，这在支付站点是刚需。
// ---------------------------------------------------------------------------
// 系统更新（版本发布记录）
//
// 与 announcements 分开的理由：语义不同。公告是"运营说的话"（停售、促销、故障），
// 系统更新是"软件变了"——有版本号、有变更条目、有预约发布时间，发布后长期可查。
// 混在一张表里会导致公告列表被版本记录刷屏，或反过来漏掉版本更新。
// ---------------------------------------------------------------------------
export const systemVersions = pgTable("system_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  // 语义化版本，如 1.2.0。唯一约束防重复发布同一版本号。
  version: text("version").notNull().unique(),
  // 一句话标题，如"新增易支付通道"。前台列表的主标题。
  title: text("title").notNull(),
  // 变更条目，每行一条。前台按行渲染成列表。
  changes: text("changes").notNull().default(""),
  // 重要程度：minor=常规修复 / major=新增功能 / critical=需要买家留意（如订单延迟）
  level: text("level").notNull().default("minor"),
  // 预约发布时间：运营可以提前写好，到点自动对前台可见。
  //
  // 为什么需要：发版窗口往往在流量低谷（凌晨），文案要提前准备。
  // scheduledFor 只能配 draft/scheduled 状态，配了就表示"到点自动发布"。
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  // 实际发布时间。前台按它排序，且用它判断"是否已发布"。
  publishedAt: timestamp("published_at", { withTimezone: true }),
  // draft=草稿（前台不可见）/ scheduled=已预约（到点自动发布）/ published=已发布
  // 保留 published 而不是靠 publishedAt 是否为空来推断，是为了让"撤回"成为可能：
  // 已发布的版本改成 draft 就等于撤回，但 publishedAt 留着，能看到原本的发布时间。
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // 前台每次渲染取"已发布 + 按时间倒序"，这个索引让它走 Index Only Scan。
  index("system_versions_status_published_idx").on(table.status, table.publishedAt),
  // 定时任务扫描"到点该自动发布"的记录。
  index("system_versions_scheduled_idx").on(table.status, table.scheduledFor),
]);

export const announcements = pgTable("announcements", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  // info=普通告知 / warning=需要留意 / danger=停售或故障。前台按此决定强调程度。
  level: text("level").notNull().default("info"),
  active: boolean("active").notNull().default(true),
  // 置顶的公告排在最前，且不受时间窗影响（用于长期有效的规则说明）。
  pinned: boolean("pinned").notNull().default(false),
  // 生效与失效时间：留空表示长期有效。首页只取"当前处于生效窗口内"的公告。
  startsAt: timestamp("starts_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // 前台每次渲染都要"取生效中的公告并按置顶+时间排序"，这个组合索引让它走 Index Only Scan。
  index("announcements_active_pinned_created_idx").on(table.active, table.pinned, table.createdAt.desc()),
]);

// ---------------------------------------------------------------------------
// 上游卡密/充值系统对接
//
// 设计目标（对标同类卡密站的后台自动化，但前台不暴露卡密概念）：
//   1. 买家前台只看到「选择套餐 → 提交凭证 → 确认 → 等待处理」四步，
//      看不到"卡密 / 上游 / 绑定"这些词，也拿不到任何上游单号。
//   2. 上游交互全部发生在服务端。凭证是敏感数据，因此：
//        · 只存密文（AES-256-GCM），密钥来自环境变量，不入库；
//        · 带 expires_at，处理完成或超时后由清理任务抹掉；
//        · 任何接口都不返回该字段，连后台列表也不返回。
//   3. 上游单号与本站订单号分离：前台只看到本站订单号，
//      防止买家拿着上游单号去上游侧查询或二次利用。
// ---------------------------------------------------------------------------

// 上游连接与策略配置（单例）。密钥只存环境变量，这里只放非敏感的地址与开关。
export const upstreamConfig = pgTable("upstream_config", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  // "mock" = 本地模拟上游（开发/自测）；"http" = 真实 HTTP 上游
  provider: text("provider").notNull().default("mock"),
  baseUrl: text("base_url").notNull().default(""),
  // 上游接口鉴权用的 AppId / 密钥。密钥本身建议放环境变量，此字段仅在
  // 上游要求「按站点区分」时存非敏感标识。
  appId: text("app_id").notNull().default(""),
  // 提交后多久未完成就判定失败并自动退回（秒）
  timeoutSeconds: integer("timeout_seconds").notNull().default(900),
  // 轮询间隔（秒）。上游一般有频率限制，别设太小。
  // 默认 90 秒：充值通常 1~3 分钟，10 秒一次纯属浪费——既烧自己的请求配额，
  // 也把对方推成"异常高频访问"。90 秒足够让进度条看起来是活的。
  pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(90),
  // 凭证保留时长（分钟）。到点自动抹掉，与"处理完立即抹"取更早者。
  credentialTtlMinutes: integer("credential_ttl_minutes").notNull().default(30),
  // 单账号每日限次，防刷。0 = 不限。
  dailyLimitPerEmail: integer("daily_limit_per_email").notNull().default(5),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 充值任务：一次「买家提交 → 上游执行」的完整链路。
export const rechargeJobs = pgTable("recharge_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  // 本站订单号（对外唯一标识，前台只看得到这个）
  code: text("code").notNull().unique(),
  // 关联的已付款订单号。自动充值必须绑定真实订单，否则任何人都能白嫖上游。
  // 留空仅用于改造前的人工任务；新流程一律必填。
  orderCode: text("order_code"),
  planId: text("plan_id").notNull(),
  planName: text("plan_name").notNull(),
  email: text("email").notNull(),
  // 状态机：validating → confirmed → submitted → processing → succeeded / failed / timed_out
  status: text("status").notNull().default("validating"),
  // 提交上游的时刻。超时的计时起点必须是它而不是 createdAt：
  // 卡密校验可能耗时一两分钟，从创建开始算会把慢速上游误判为超时。
  // 缺失时回落到 createdAt，保证任何情况下都有可用基准。
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  // 上游侧单号。只在后台可见，任何面向买家的接口都不返回。
  upstreamOrder: text("upstream_order"),
  // 上游卡密/凭证的绑定标识（用于对账），同样不外泄。
  upstreamBinding: text("upstream_binding"),
  // 凭证密文。绝不出现在任何接口响应里；处理完成或过期即抹。
  credentialCipher: text("credential_cipher"),
  // 校验阶段上游返回的"可用兑换凭据"密文。校验与提交分两步走，需要暂存；
  // 同样加密、同样在提交后立即抹除。
  secretCipher: text("secret_cipher"),
  credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
  // 上一次**真正调用上游**的时刻。查询节流的依据：距今不足 pollIntervalSeconds
  // 时本次不再打上游。
  //
  // 为什么需要：advanceJob 有三个触发点（买家点刷新、maintenance 定时任务、
  // 运营手动催一下）。没有这个字段时任何一次触发都会真查上游——买家狂点刷新
  // 就能在几分钟内打出几十次请求，既烧自己的配额，也把对方推成"异常高频访问"。
  // 有了它，同一任务在一个窗口内只查一次，其余触发直接返回当前状态。
  lastQueriedAt: timestamp("last_queried_at", { withTimezone: true }),
  // 处理完成后写给买家看的说明（已脱敏）
  resultNote: text("result_note").notNull().default(""),
  failureReason: text("failure_reason").notNull().default(""),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // 一单一任务：这是「一次付款只换一次上游充值」唯一的数据库级保证。
  // 代码里的"先查后插"拦不住并发——两个请求同时查到"还没有任务"，就各插一条，
  // 于是一笔订单把上游打了两次，成本翻倍，且事后没有任何日志能发现。
  // order_code 可空（仅改造前的人工任务留空），故用部分唯一索引只约束非空值。
  uniqueIndex("recharge_jobs_order_code_uniq").on(table.orderCode).where(sql`${table.orderCode} is not null`),
  // 前台进度查询与后台列表都按订单号/状态检索；后台按状态捞待处理任务。
  index("recharge_jobs_status_created_idx").on(table.status, table.createdAt.desc()),
  // 到期未完成的凭证需要被清理任务扫出来，按 expires_at 建索引。
  index("recharge_jobs_credential_expires_idx").on(table.credentialExpiresAt),
]);

// 状态变更流水：给买家看的进度条与排障都靠它，且是唯一的对外事实来源。
export const rechargeEvents = pgTable("recharge_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").notNull().references(() => rechargeJobs.id, { onDelete: "cascade" }),
  // 对外可见的状态标签（submitted / processing / succeeded ...）
  stage: text("stage").notNull(),
  message: text("message").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("recharge_events_job_created_idx").on(table.jobId, table.createdAt),
]);

export type Plan = typeof plans.$inferSelect;
export type Order = typeof orders.$inferSelect;

// ---------------------------------------------------------------------------
// 支付流水（P1-2）
//
// 为什么必须有这张表。此前支付信息只落在 orders.transaction_id 一个字段上，
// 带来三个无法绕开的问题：
//   1. 对账 impossible —— 只能知道"某笔订单收了钱"，无法回答"今天支付宝通道
//      总共收了多少钱、成功率多少、验签失败了几次"。
//   2. 举证 impossible —— 买家发起 dispute 时拿不出网关原始报文。
//   3. 排障 impossible —— 回调验签失败只留一行日志，进程一滚就没了。
//
// 设计取舍：
//   · **只追加、不更新、不删除**。每次事件插一行，因此 (gateway, trade_no) 上
//     故意不建唯一约束：网关在失败时会重投同一笔通知，这些重复行不是脏数据，
//     而是"网关重试了几次"这一事实本身，对账时正好用得上。
//     订单级的幂等由 orders.transaction_id 的唯一约束保证，与本表职责不同。
//   · payload 存网关原始报文（已剔除密钥类字段），是举证与复现的唯一依据。
//   · detail 用固定短语记录"为什么没成功"，让失败原因可聚合统计，
//     而不是散落在日志文本里无法检索。
// ---------------------------------------------------------------------------

export const paymentTransactions = pgTable("payment_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  // 关联订单用级联删除：订单本身被清理时流水一并消失，不留孤儿行。
  // 真实业务里订单很少被物理删除（默认是软删除/状态推进），因此这个代价很低。
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  // 网关代码：usdt / alipay / epay / binance / mock。与 registry 的 code 一致。
  gateway: text("gateway").notNull(),
  // 事件类型：
  //   create  —— 发起支付（下单时写入，含跳转地址与首次拿到的 trade_no）
  //   notify  —— 收到回调（成功、验签失败、金额不符都写）
  //   query   —— 主动查单结果（回调丢失时的兜底）
  //   manual  —— 人工确认（USDT 这类无回调通道的方式）
  event: text("event").notNull(),
  // 网关侧交易号。发起阶段可能还没有，此时为 null。
  tradeNo: text("trade_no"),
  // 网关声称收到的金额。留 null 表示这次事件没有金额信息（如验签失败）。
  // 与 orders.amount 比对即可发现"付了 1 元却下了一单 1440 元"这类攻击。
  amount: numeric("amount", { precision: 12, scale: 2 }),
  currency: text("currency"),
  // 归一化状态：succeeded / failed / pending / rejected
  // rejected 专指"请求本身不合法"（验签失败、金额不符），与"付款失败"区分开。
  status: text("status").notNull(),
  // 网关原始报文留档。密钥、私钥、签名一律不写入。
  payload: jsonb("payload"),
  // 失败原因的固定短语，便于 group by 统计。成功时为空串。
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // 对账主查询：按网关 + 时间窗聚合金额与成功率。
  index("payment_tx_gateway_created_idx").on(table.gateway, table.createdAt),
  // 单笔订单的全部流水（客服排查"这笔到底发生了什么"）。
  index("payment_tx_order_created_idx").on(table.orderId, table.createdAt),
  // 按网关交易号反查（买家提供流水号时的第一查询）。
  index("payment_tx_trade_no_idx").on(table.gateway, table.tradeNo),
]);

export type PaymentSettings = typeof paymentSettings.$inferSelect;
export type Announcement = typeof announcements.$inferSelect;

// ---------------------------------------------------------------------------
// 优惠券
//
// 设计取舍：
//   · 券码只存摘要（同卡密），列表永远看不到明文，生成时一次性给出。
//     否则库里躺着一堆可被直接使用的折扣码，拖库即等于送钱。
//   · 折扣以「金额」而非「比例」落库到订单（discountAmount），下单那一刻锁定。
//     之后改券规则不影响历史订单，这是与手续费同一条原则。
//   · 使用次数分两层：perUserLimit（每人限用）需要靠 orders 里的券码回查统计，
//     totalLimit 为空表示不限次数。
// ---------------------------------------------------------------------------
export const coupons = pgTable("coupons", {
  id: uuid("id").defaultRandom().primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  // 面额：满 减/折扣统一折算成"减多少元"。折扣券在创建时就算成金额，省得下单时再算比例。
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).notNull(),
  // 满多少可用。为 0 表示无门槛。放在服务端校验，不信任前端传来的金额。
  minAmount: numeric("min_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  totalLimit: integer("total_limit"),
  perUserLimit: integer("per_user_limit").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  // null = 不限；过期时间过后前台不可再用
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // 下单时按 code_hash 精确匹配，走唯一索引；后台列表按启用/过期筛选走这个组合索引。
  index("coupons_active_expires_idx").on(table.active, table.expiresAt),
]);

export type Coupon = typeof coupons.$inferSelect;
export type RechargeJob = typeof rechargeJobs.$inferSelect;
export type UpstreamConfig = typeof upstreamConfig.$inferSelect;
