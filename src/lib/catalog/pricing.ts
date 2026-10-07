import type { Plan } from "@/db/schema";

// ---------------------------------------------------------------------------
// 金额计算：全站唯一的口径来源。
//
// 之前"实付 = amount"这件事散落在下单、支付页、回调验签三处各自算一遍，
// 是典型的"同一个规则写三遍"隐患。现在统一成两个函数，改价只改这里。
//
// 术语：
//   商品价 price   —— 套餐标价，来自 plans.price。**运营填多少，扣完通道费后实收多少。**
//   通道费 chFee   —— 支付通道向**商家**抽走的比例（支付宝 0.6%、USDT 链上费…）
//   加价率 feeRate —— 运营在此基础上额外向买家收的比例，即利润
//   实付 total     —— 买家实际要付的钱
//
// 【为什么必须反算，而不是"标价 × (1+费率)"]
// 直觉写法是「手续费 = 标价 × 费率，买家付标价 + 手续费」。但那样算，
// 运营在后台填 119、费率 1%，买家付 120.19，通道再从 120.19 里抽走 0.72，
// 运营实得 **119.47** —— 比填的数多 0.47，账永远对不上。
//
// 正确做法是从「实收 = 标价」这个不变式倒推：
//
//   设买家实付 T，运营到手 T × (1 - 通道费率) = 标价
//   → T = 标价 / (1 - 通道费率)
//
// 支付宝 0.6% 下，后台填 119 → 买家付 119.72 → 抽 0.72 → 实收 **119.00**。
// 严格对齐，运营不用心算，账目与后台标价始终一致。
//
// 【通道费率从哪来】
// 各通道的真实费率存在 payment_settings.fee_rate（后台可填，默认见
// CHANNEL_FEE_DEFAULTS），前端展示与下单锁定都用同一份，避免各处硬编码。
//
// 【为什么不能直接用 total 当订单金额】
// 回调核对必须用同一个函数重算。回调里拿到的 total_amount 是买家实付，
// 用同一函数从标价反算即可得到完全一致的字符串——但浮点反算在边界上
// 可能差一分，所以 orderTotal() 优先用订单已锁定的 fee_amount（见其注释）。
// ---------------------------------------------------------------------------

/**
 * 各通道默认费率（百分比）。运营可在后台改，这里只是首次读取时的兜底。
 *
 * 每个值的来源都经过核实（核实日期 2026-10-05）。费率会变，改前先查官方最新公示：
 *   支付宝  https://opendocs.alipay.com/b/03aia1（电脑网站支付费率）
 *   微信    《微信支付服务协议》https://pay.weixin.qq.com/（标准费率 0.6%）
 *   币安    https://www.binance.com/en/binance-pay（商家费率公示）
 *
 * ⚠️ 两条反直觉的事实，配置前务必读完：
 *
 * 1. 本项目**没有微信支付通道**。微信的 0.6% 之所以列在这里，是因为易支付
 *    （epay）收银台内含微信——买家在收银台里选微信时，钱由微信向你抽 0.6%，
 *    费率体现在 `epay` 这一层的通道费上。若要做**微信原生**通道（不经过
 *    易支付），需另接商户号 + APIv3 密钥 + 商户证书，签名 SHA256-RSA2048、
 *    回调需 AES-256-GCM 解密，与支付宝 RSA2 完全不同，无法复用现有适配层。
 *
 * 2. 支付宝的 0.6% 对应**电脑网站支付**，是本站用到的产品。网上常见的
 *    「花呗/信用卡另加 0.8%」是误传——0.8% 属于「收钱码」产品的贷记渠道，
 *    且在电脑网站支付下花呗与信用卡同样按 0.6% 计。唯一真正更贵的是
 *    **花呗分期**（3 期 1.80% / 6 期 4.50% / 12 期 7.50%，由商家承担）。
 *    本站未接花呗分期，若日后接入需按实际期数调高此值。
 *
 * usdt 为什么是 6 而不是 1：TRC20 的链上手续费是**固定约 1 USDT**，
 * 不是按金额的百分比。若按 1% 算，119 元的订单只收回 1.19 元成本，
 * 而真实链上费约 1 USDT ≈ 7.2 元，**每单倒贴 6 元**。
 * 6% 是按「1 USDT ÷ 7.2 ÷ 标价 120 元」折算的量级，仅供参考值 ——
 * 真实值随 USDT 汇率与标价变动，运营应在后台按自己的实际情况调。
 *
 * epay 为什么是 0：易支付是聚合收银台，**没有统一公开费率**——它按你与
 * 平台的签约合同收取，行业与渠道不同，从 0.6% 到 3% 都可能。这里填 0 表示
 * 「未知，按不抽成先行」，等拿到平台账单后回后台填真实值。若长期留 0，
 * 你会独自吃掉这层抽成。
 */
export const CHANNEL_FEE_DEFAULTS = {
  // 电脑网站支付，官方公示 0.60%（2026-10 核实）
  alipay: 0.6,
  // 聚合收银台，费率取决于你的签约合同 —— 首次留 0，拿到账单后回填
  epay: 0,
  usdt: 6,
  // 币安 Pay 的链上转账费由币安承担，商家侧通常 0 手续费。
  // 这里填 0 的语义是"通道不抽成"，不是"忘了填"——两者在账目上表现相同。
  binance: 0,
  // epusdt 自建收银台同理：链上费由你直接付给矿工/验证者，不经过平台，
  // 因此「通道」这一层不抽成。真实成本是你自己的钱包，与 usdt 通道的算法一致。
  epusdt: 0,
  mock: 0,
} as const;

export type ChannelKey = keyof typeof CHANNEL_FEE_DEFAULTS;

export type FeeBreakdown = {
  /** 商品价 = 运营实收（扣完通道费后） */
  price: string;
  /** 加价率（百分比，两位小数）—— 运营向买家额外收的比例 */
  feeRate: string;
  /** 通道费率（百分比）—— 支付通道向商家抽走的部分 */
  channelRate: string;
  /** 买家实付 = price / (1 - 通道费率) */
  total: string;
  /** 手续费 = total - price，买家多付的部分（含通道成本与利润） */
  feeAmount: string;
  /** 通道费 = total × 通道费率，运营要付给通道的 */
  channelFee: string;
  /** 运营实收 = total - channelFee，四舍五入到分 */
  netIncome: string;
};

/**
 * 百分比入参 → 小数，并封死会产出荒谬金额的输入。
 *
 * 为什么必须对「超出合法区间」直接归零，而不是夹到略小于 100 的值：
 * 反算公式是 `total = price / (1 - chRate)`。夹到 99.5 看着安全，
 * 但 119 / (1 - 0.995) = **23800**，而 99% 也有 11900 —— 都是买家完全无法接受的金额。
 *
 * 那为什么不夹到 50（后台允许的上限）再正常反算？因为那会让一个脏值
 * （误填、脏库、被手工改过）静默变成 50% 费率，买家看到 2 倍价格并真的付掉。
 * **归零的代价只是运营自己贴这一层通道费，但那种费率本身就不该存在**，
 * 而且归零后费率异常在使用处一眼可见（订单金额等于标价），不会被悄悄放过。
 *
 * 上限取 50 是为了与后台表单的校验区间完全一致：
 * 「后台能填的」与「这里算的」必须是同一个范围，否则用户会填进一个被静默截断的值。
 */
const MAX_RATE_PCT = 50;

const pct = (value: string | number | null | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 超出合法区间（>= 100 必然荒谬，> 50 属脏数据）一律归零
  if (n > MAX_RATE_PCT) return 0;
  return n / 100;
};

/**
 * 加价率的封顶。
 *
 * 与通道费率分开处理：加价率是**乘**上去的，不会像除法那样放大金额，
 * 但超过 50%（买家付双倍）虽不违法却极易被当成乱收费。同样归零处理，
 * 保证「填不进来」与「算不出来」是同一套边界。
 */
const markupPct = (value: string | number | null | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > MAX_RATE_PCT) return 0;
  return n / 100;
};

const money = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

/**
 * 从「运营实收」反算买家实付与各环节金额。
 *
 * channelRate 非法或 >= 100% 时按 0 处理：那种费率下反算会得出无穷大，
 * 让买家看到一个天文数字订单，比按 0 收更糟。
 */
export function priceBreakdown(
  price: string | number,
  feeRate: string | number | null | undefined,
  channelRate: string | number | null | undefined = 0,
): FeeBreakdown {
  const base = Number(price);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
  const rate = markupPct(feeRate);
  const chRate = pct(channelRate);

  // 买家实付 = 标价 × (1 + 加价率) / (1 - 通道费率)
  //
  // 两项的方向不能弄反，含义也不同：
  //   · 乘 (1 + 加价率)：加价率是运营**主动向买家多收的利润**，在标价之上加；
  //   · 除 (1 - 通道费率)：通道抽走的部分得有人出，从买家应付里反摊回来。
  //
  // 曾误写成"标价 / ((1 - 通道费率) × (1 + 加价率))"，结果标价 119 反而算出
  // 买家只付 118.53 —— 比标价还少，运营倒亏。加价率是加不是除。
  const total = Number(money((safeBase * (1 + rate)) / (1 - chRate)));
  const channelFee = Number(money(total * chRate));
  const netIncome = Number(money(total - channelFee));
  const feeAmount = Number(money(total - safeBase));

  return {
    price: money(safeBase),
    feeRate: String(feeRate ?? "0"),
    channelRate: String(channelRate ?? "0"),
    total: money(total),
    feeAmount: money(feeAmount),
    channelFee: money(channelFee),
    netIncome: money(netIncome),
  };
}

/**
 * 兼容旧调用：只按加价率算手续费（不扣通道费）。
 *
 * 保留是因为后台的「批量改价」预览等纯展示场景没有通道上下文，
 * 那些地方只是想让运营看到"标价 + 加价"的直观结果。
 * 凡是**涉及真实收款金额**的地方（下单、支付页、回调核对）必须用
 * priceBreakdown 的第三参数，否则算出的金额与通道实际抽走的对不上。
 */
export function calcFee(price: string | number, feeRate: string | number | null | undefined): string {
  const base = Number(price);
  const rate = pct(feeRate);
  if (!Number.isFinite(base) || base <= 0 || rate <= 0) return "0.00";
  return money(base * rate);
}

/**
 * 已落库的订单 → 买家实付金额。
 *
 *   实付 = 商品价 + 手续费 − 优惠券抵扣
 *
 * 手续费按商品价计（不因优惠券减少），因为它是支付通道成本，与买家用几张券无关；
 * 运营发券不会倒贴通道费。回调验签核对金额时必须用这个函数，
 * 绝不能直接用 amount —— 那样每一笔用券订单都会被判为金额不符。
 */
export function orderTotal(order: {
  amount: string | number;
  feeAmount?: string | number | null;
  discountAmount?: string | number | null;
}): string {
  const base = Number(order.amount);
  const fee = Number(order.feeAmount ?? 0);
  const discount = Number(order.discountAmount ?? 0);
  const safe = (n: number) => (Number.isFinite(n) ? n : 0);
  const total = safe(base) + safe(fee) - safe(discount);
  // 兜底不允许出现 <= 0 的实付：负数收款在任何支付通道都会被拒。
  return (total > 0 ? total : 0.01).toFixed(2);
}

/**
 * CNY → USDT。必须传入「实付金额」。
 * 保留 6 位小数（USDT 精度），并去掉尾随 0，避免买家按多余精度转账导致对不上账。
 */
export function toUsdt(cnyAmount: string | number, exchangeRate: string | number): string {
  const amount = Number(cnyAmount);
  const rate = Number(exchangeRate);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(rate) || rate <= 0) return "0.000000";
  return trimUsdt((amount / rate).toFixed(6));
}

function trimUsdt(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** 套餐是否可售：已上架 + 库存口径未耗尽。结算页与下单接口都要过这一关。 */
export function isPurchasable(plan: Pick<Plan, "active" | "delivery" | "stock"> & { stockInfo?: { remaining: number | null } | null }): boolean {
  if (!plan.active) return false;
  if (plan.delivery !== "cdk") return true;
  const remaining = plan.stockInfo?.remaining ?? null;
  return remaining === null || remaining > 0;
}

// ---------------------------------------------------------------------------
// 订单有效期
//
// 之前订单只有 status 一列，没有截止时间，带来两个实际问题：
//   1. 买家下单不付，订单永远停在 pending。后台列表越积越多，运营分不清
//      "还在等付款"和"早就放弃了"，筛选条件形同虚设。
//   2. 买家付款时订单可能已被人工取消，钱到了但单已关，只能进人工核对。
//
// 取 30 分钟的依据：覆盖绝大多数买家的付款动作（挑支付方式 → 输密码 → 回调），
// 又不至于让卡死的订单长期占用"待支付"这个有业务含义的状态。
// 定时任务与支付前置检查都读这一个常量，改这里即可全站生效。
// ---------------------------------------------------------------------------

/**
 * 可履约状态：这些状态下订单已收到钱（或本就是凭证换来的），可以交付。
 *
 * 为什么要有这个常量：此前"能不能发卡密"这件事在三个地方各写了一份字面量——
 * orders/[id]/delivery 的路由、reissueCardKeyForOrder 的守卫、以及充值侧的
 * ACTIVATABLE_ORDER_STATUS。三份只要有一份不同步，就会出现"钱收了、状态是
 * expired、买家拿不到卡、后台补发按钮也点不动"这种确定的钱损失路径，
 * 而所有代码都"看起来正确"。
 *
 * 判断标准只有一条：**钱已确认到账，或订单本身即凭证**。
 * - pending   ：未付款，不发。
 * - paid/processing/completed：正常履约中/已完成。
 * - expired   ：钱在过期之后才到（markPaid 会保留 expired 并转人工核对）。
 *              这类订单钱确实收到了，运营核对后放行是合理的，而拒绝交付
 *              等于让买家付了钱却什么也拿不到。
 * - cancelled ：买家主动取消。若钱已到账（received_after_cancel），
 *              同样不应在此处直接拒绝，交由运营处理。
 *
 * 注意：这里不判断"钱有没有到"，只判断"状态是否允许履约"。到账与否由
 * transactionId / paidAt 表达。
 */
export const FULFILLABLE_STATUSES = ["paid", "processing", "completed", "expired", "cancelled"] as const;

/**
 * 履约阻断状态：钱已经退回去了，绝不能再交付。
 *
 * 必须与 FULFILLABLE_STATUSES 分开而不是简单"不在白名单里"——因为
 * FULFILLABLE_STATUSES 是"允许履约"的正向清单，refunded 不在其中是理所当然的，
 * 但这个语义太隐晦：将来有人往白名单里加状态时，很可能顺手把 refunded 也加进去。
 * 显式列出阻断项，让"退款后还能不能领卡"这个问题有一个可搜索的答案。
 */
export const FULFILLMENT_BLOCKED_STATUSES = ["refunded"] as const;

/**
 * 卡密能否自动发放。
 *
 * 用户提的需求是"收款金额与网站定义的金额一致就自动发，不一致走手动"。这个判定
 * 必须只有一处实现，理由和 FULFILLABLE_STATUSES 一样：后台列表、订单编辑器、
 * 结果页三处各写一份，迟早有一处不同步，于是出现"按钮显示可发但点了报错"。
 *
 * 两个条件都要满足，缺一不可：
 *   1. **状态可履约** —— 未付款的订单绝不能发卡，否则白送。
 *   2. **金额已确认一致** —— 实付（含手续费、减券）必须等于订单应付。
 *      这正是"自动 vs 手动"的判据：钱对得上就自动发，对不上说明可能少付、
 *      券没核销、或回调金额异常，此时必须人工确认。
 *
 * 为什么要独立成函数而不是让调用方各自判断：金额比较是浮点敏感的，
 * 而"是否一致"这个结论会被写进审计日志与工单口径，必须稳定可复现。
 */
export function canAutoIssueCard(
  order: { status: string; amount: string; feeAmount: string | null; discountAmount: string | null },
  options: { paymentConfirmed?: boolean; receivedAmount?: string | number | null } = {},
): boolean {
  if (!(FULFILLABLE_STATUSES as readonly string[]).includes(order.status)) return false;
  if ((FULFILLMENT_BLOCKED_STATUSES as readonly string[]).includes(order.status)) return false;
  // 人工确认到账后才允许自动发：后台把 pending 改成 paid 时会带 confirmed，
  // 但仅凭状态无法区分"钱真的到了"与"有人直接改了状态"。
  if (order.status === "paid" && options.paymentConfirmed === false) return false;
  // 金额一致即可自动发。这里比的是「订单实付」与「订单实付」，是同一口径 ——
  // 真正的判据是**收款金额是否与网站定义金额一致**，而收款金额只有回调/人工
  // 确认时才知道，不在订单行里。因此调用方必须把实测收款额传进来：
  // received 为空表示"尚未核实到账"，一律走手动。
  const received = options.receivedAmount;
  if (received === undefined || received === null) return false;
  return moneyEquals(orderTotal(order), received);
}

/** 金额是否一致（按「分」比较，避开浮点误差）。两个参数都是「元」为单位的字符串。 */
export function moneyEquals(expected: string, received: string | number): boolean {
  const cents = (value: string | number) => {
    const text = String(value).trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) return null;
    const [w, f = ""] = text.split(".");
    return Number(w) * 100 + Number((f + "00").slice(0, 2));
  };
  const a = cents(expected), b = cents(received);
  if (a === null || b === null) return false;
  return a === b;
}


export const ORDER_TTL_MINUTES = 30;

/** 下单时刻的截止时间。 */
export function orderExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + ORDER_TTL_MINUTES * 60_000);
}

/** 订单是否已过支付截止时间。null 视为未过期（历史订单无截止列）。 */
export function isExpired(order: { status: string; expiresAt?: Date | null }, now: Date = new Date()): boolean {
  if (order.status !== "pending") return false;
  if (!order.expiresAt) return false;
  return order.expiresAt.getTime() <= now.getTime();
}
