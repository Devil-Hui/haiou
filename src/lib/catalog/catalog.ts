import type { Category, Plan } from "@/db/schema";

export type Brand = "chatgpt" | "claude" | "grok" | "gemini";
export const brands: Record<Brand, { name: string; company: string; description: string }> = {
  chatgpt: { name: "ChatGPT", company: "OPENAI", description: "你的全能 AI 灵感搭档" },
  claude: { name: "Claude", company: "ANTHROPIC", description: "深度思考，让好想法更进一步" },
  grok: { name: "Grok", company: "xAI", description: "探索实时信息，发现新鲜视角" },
  gemini: { name: "Gemini", company: "GOOGLE", description: "连接多元灵感，释放创造潜能" },
};

// ---------------------------------------------------------------------------
// 分类种子
//
// 四个品牌升级为一等实体的起点。id 沿用 brand 取值，因此 plans.brand 与
// categories.id 天然对齐：既有数据零迁移，也不会出现两套 ID 体系并存。
// 这里只提供「首次建库时的初始值」，之后分类由运营在后台维护，改这里不影响线上。
// ---------------------------------------------------------------------------
export const initialCategories: Category[] = (Object.keys(brands) as Brand[]).map((id, i) => ({
  id,
  name: brands[id].name,
  company: brands[id].company,
  description: brands[id].description,
  // 图标留空：分类图应由运营上传，避免把二进制素材写进代码仓库。
  image: null,
  sort: i,
  active: true,
}));

// ---------------------------------------------------------------------------
// 套餐种子
//
// 标价单位是人民币（CNY）。下单时按后台「CNY / USDT 汇率」折算成 USDT 收款，
// 页面也一律显示 ¥。
//
// 关于定价：早先这里用 USD_TO_CNY = 7.2 把美元官方价换算成人民币，
// 结果是 144 / 720 / 1440，比市场实际成交价（119 / 670 / 1100）高出
// 21% / 7% / 31%，在同品类里属于明显偏贵，会直接劝退转化。
// 因此改为直接写市场可成交的人民币价，汇率波动由运营在后台调「兑换汇率」处理，
// 不再由代码里的常量二次放大价差——定价与换算是两件事，混在一起必然出错。
// ---------------------------------------------------------------------------

// 新增档位只需往 seeds 里加一行：sort 按「同周期内的出现顺序」自动分配，
// 不用手工重排后续序号，也不会出现两档商品排序撞车。
type Seed = {
  id: string;
  brand: Brand;
  name: string;
  period: "monthly" | "yearly";
  price: string;
  originalPrice?: string | null;
  description?: string;
  features: string[];
  badge?: string | null;
  delivery: "manual" | "cdk";
  stock?: number | null;
  /** 手续费率（百分比）。缺省 0，即不收手续费。 */
  feeRate?: string;
};

const seeds: Seed[] = [
  // ---- ChatGPT：Plus 与两档 Pro，官方直冲、付款后自动发卡密 ----
  // 售价对齐市场实际成交价（Plus 119 / Pro 5X 670 / Pro 10X 1100），
  // 而不是按官方美元价乘一个固定汇率——那会让本站系统性偏贵 7%~31%。
  { id: "chatgpt-monthly", brand: "chatgpt", name: "ChatGPT Plus", period: "monthly", price: "119.00", originalPrice: "159.00", description: "官方直冲 · 会员购买", features: ["会员购买，付款后自动交付", "官方直充渠道", "Plus 个人订阅权益"], badge: "人气之选", delivery: "cdk" },
  { id: "chatgpt-pro-5x-monthly", brand: "chatgpt", name: "ChatGPT Pro 5X", period: "monthly", price: "670.00", description: "官方直冲 · 会员购买", features: ["会员购买，付款后自动交付", "官方直充渠道", "Pro 5X 更高使用额度"], delivery: "cdk" },
  { id: "chatgpt-pro-10x-monthly", brand: "chatgpt", name: "ChatGPT Pro 10X", period: "monthly", price: "1100.00", description: "官方直冲 · 会员购买", features: ["会员购买，付款后自动交付", "官方直充渠道", "Pro 10X 更高使用额度（原 20X）"], delivery: "cdk" },
  { id: "chatgpt-yearly", brand: "chatgpt", name: "ChatGPT Plus", period: "yearly", price: "1190.00", originalPrice: "1428.00", features: ["Plus 个人订阅权益", "更高的模型使用额度", "文件分析与图像创作"], badge: "人气之选", delivery: "manual" },
  // ---- 其余品牌维持人工代充，流程与价格均不变 ----
  { id: "claude-monthly", brand: "claude", name: "Claude Pro", period: "monthly", price: "139.00", originalPrice: "169.00", features: ["Pro 个人订阅权益", "长文本理解与深度分析", "写作、编程效率进阶"], delivery: "manual" },
  { id: "claude-yearly", brand: "claude", name: "Claude Pro", period: "yearly", price: "1499.00", originalPrice: "1668.00", features: ["Pro 个人订阅权益", "长文本理解与深度分析", "写作、编程效率进阶"], delivery: "manual" },
  { id: "grok-monthly", brand: "grok", name: "SuperGrok", period: "monthly", price: "159.00", originalPrice: "199.00", features: ["SuperGrok 订阅权益", "实时信息与智能问答", "图像生成与创意探索"], delivery: "manual" },
  { id: "grok-yearly", brand: "grok", name: "SuperGrok", period: "yearly", price: "1699.00", originalPrice: "1908.00", features: ["SuperGrok 订阅权益", "实时信息与智能问答", "图像生成与创意探索"], delivery: "manual" },
  { id: "gemini-monthly", brand: "gemini", name: "Google AI Pro", period: "monthly", price: "119.00", originalPrice: "149.00", features: ["Google AI Pro 订阅权益", "多模态理解与内容创作", "Google 生态智能协作"], badge: "高效推荐", delivery: "manual" },
  { id: "gemini-yearly", brand: "gemini", name: "Google AI Pro", period: "yearly", price: "1299.00", originalPrice: "1428.00", features: ["Google AI Pro 订阅权益", "多模态理解与内容创作", "Google 生态智能协作"], badge: "高效推荐", delivery: "manual" },
];

// 库存默认留空（不限）：真实库存由运营在 /admin/plans 按需设置，无需改代码。
export const initialPlans: Plan[] = (() => {
  const counters = { monthly: 0, yearly: 0 };
  return seeds.map((seed) => ({
    id: seed.id,
    brand: seed.brand,
    name: seed.name,
    description: seed.description ?? brands[seed.brand].description,
    period: seed.period,
    price: seed.price,
    originalPrice: seed.originalPrice ?? null,
    features: [...seed.features],
    badge: seed.badge ?? null,
    active: true,
    sort: counters[seed.period]++,
    stock: seed.stock ?? null,
    delivery: seed.delivery,
    feeRate: seed.feeRate ?? "0",
    // 图片与软删除时间不写进种子：新库不需要历史数据，运营在后台按需上传与删除。
    image: null,
    deletedAt: null,
  }));
})();

// 订单表里 payment_method 是自由文本，卡密兑换写入的是 "cdk"。过去各处都用
// `=== "usdt" ? ... : "支付宝"` 的二元判断，卡密订单会被显示成支付宝。统一从这里取。
// epay 此前漏在这里，导致两个后果：支付页标题直接渲染原始字符串 "epay"，
// 结果页的"支付方式"把易支付订单显示成"支付宝"（那边写的是
// usdt ? "USDT" : cdk ? "卡密兑换" : "支付宝" 的三目）。
// 买家付的是收银台，看到的却是支付宝 —— 对不上账。
export const paymentLabels: Record<string, string> = { usdt: "USDT（TRC20）", alipay: "支付宝", epay: "在线收银台", epusdt: "USDT 自建收银台", binance: "币安支付", cdk: "卡密兑换" };
export const paymentLabel = (method: string) => paymentLabels[method] || method;

// 这两张表是**白名单**，不是字典：只有 own key 才算合法状态。
// 因此它们用 Object.create(null) 初始化——对象字面量的原型是 Object.prototype，
// 于是 statusLabels["constructor"] / statusFlow["toString"] 会返回函数（真值），
// "?status=constructor" 这类查询就能混进白名单。配套的读法一律走 Object.hasOwn。
export const statusLabels: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, { pending: "待支付", paid: "已支付", processing: "充值中", completed: "已完成", cancelled: "已取消", expired: "已超时关闭", refunded: "已退款" });
// cancelled -> paid exists because money can arrive after a buyer cancels: the admin must be
// able to record it as "received, needs manual review" instead of editing the database.
//
// paid/processing/completed -> refunded 是**必须**的：发生退款或支付宝拒付时，
// 系统此前没有任何状态能表达这件事，唯一做法是把订单留在 paid —— 而交付闸门
// (orders/[id]/delivery) 依然放行，**退款后买家仍能领卡**。系统也分不清
// "已收款"与"已退款"。运营要么改数据库，要么就只能眼睁睁看着。
//
// refunded 是终态，不可再迁出（与 completed 一样），避免"退款后又变回已支付"
// 这种在资金语义上讲不通的状态。
//
// expired -> paid 同理，而且是**必须**的：订单过期后买家仍可能付款到账（钱是真的），
// 若状态机里没有这条边，过期订单会被永久锁死——后台连"标记为已收到款"都做不到，
// 只能去改数据库。这是过期清理上线后最容易踩的坑。
export const statusFlow: Record<string, string[]> = Object.assign(Object.create(null) as Record<string, string[]>, { pending: ["paid", "cancelled", "expired"], paid: ["processing", "completed", "refunded"], processing: ["completed", "refunded"], completed: ["refunded"], cancelled: ["paid"], expired: ["paid"], refunded: [] });
export const money = (value: string | number) => Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export const periodLabel = (period: string) => period === "yearly" ? "年" : "月";


// ---------------------------------------------------------------------------
// 商品标签：全站唯一的语义来源
//
// 此前前台首页、后台套餐列表、套餐编辑器各写一套标签文案与配色类名，
// 同一件事（"自动交付"）在三处的字符串和 class 都可能不同步——
// 改一次要动三个文件，漏一个就出现"后台写着自动交付、前台显示人工"这种矛盾。
//
// 现在收敛到一处：UI 只问"这个商品是什么状态"，由这里返回该显示什么。
// ---------------------------------------------------------------------------

export type PlanTagTone = "auto" | "manual" | "in" | "low" | "out" | "plain";

export interface PlanTag {
  tone: PlanTagTone;
  label: string;
}

/**
 * 生成某套餐的标签组。顺序固定：交付方式 → 库存。
 * 库存口径来自 isPurchasable 的同一套判断，避免"卡片显示有货但点进去买不了"。
 */
export function planTags(plan: {
  delivery: string;
  stock: number | null;
  stockInfo?: { remaining: number | null } | null;
}): PlanTag[] {
  const auto = plan.delivery === "cdk";
  const tags: PlanTag[] = [
    auto
      ? { tone: "auto", label: "自动交付" }
      : { tone: "manual", label: "人工交付" },
  ];
  // 人工交付不存在"库存"概念：卡是买家手上那张，站点不控制它的余量。
  if (!auto) return tags;
  const remaining = plan.stockInfo?.remaining ?? null;
  if (remaining === null) tags.push({ tone: "in", label: "现货供应" });
  else if (remaining <= 0) tags.push({ tone: "out", label: "已售罄" });
  else if (remaining <= LOW_STOCK) tags.push({ tone: "low", label: `仅剩 ${remaining} 份` });
  else tags.push({ tone: "in", label: `剩余 ${remaining} 份` });
  return tags;
}

/** 与后台库存预警阈值保持一致：低于此值即视为需要补货。 */
export const LOW_STOCK = 10;
