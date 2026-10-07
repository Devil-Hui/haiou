// ---------------------------------------------------------------------------
// 支付配置解析层：环境变量优先，数据库兜底
//
// 【为什么要有这一层】
// 此前支付配置的来源是分裂的：私钥类走环境变量，AppID / 商户号 / 网关地址这类
// 走后台表单存数据库。这带来两个真实困扰：
//
//   1. **填了环境变量也不一定生效**。运营在 .env 里配好了 ALIPAY_PRIVATE_KEY，
//      打开后台一看支付宝还是"未就绪"，缺 AppID —— 于是他以为是密钥错了，
//      去反复换密钥。真相是另一半配置在数据库里，而那一半他还没填。
//   2. **换环境要重填一遍**。测试环境填过的 AppID、站点域名，上生产时不会跟着走，
//      于是"本地能跑、线上收不到钱"，而这类问题在部署当天才暴露。
//
// 现在改成一条规则：**环境变量是唯一事实来源，数据库只是 UI 里的可视化镜像**。
// 运营在 .env 填完密钥即可直接收款，后台页面退化为"看一眼当前状态"的地方；
// 仍然保留后台保存能力，用于临时改费率这类需要高频调整的值。
//
// 【优先级规则，逐字段】
//   环境变量有值 → 用环境变量
//   环境变量为空 → 用数据库里的值（老配置继续有效，不破坏现有部署）
//   两者都空   → 该通道判定为"未就绪"，前台不显示，后台明确列出缺什么
//
// 【开关的特殊处理】
// `*_ENABLED` 类开关不设"默认关"，而是**由凭据是否齐全自动推导**：
// 凭据齐了就是开的。这样"只在 .env 里填密钥、不进后台点任何开关"也能收款，
// 这正是本文件要解决的问题。若运营确实想临时关掉某通道，用
// `ALIPAY_ENABLED=false` 显式关闭即可——显式值永远优先于推导。
// ---------------------------------------------------------------------------

import type { PaymentSettings } from "@/db/schema";

/** 解析后的支付配置：与 PaymentSettings 同构，但可能来自环境变量。 */
export type ResolvedPayments = PaymentSettings;

/** 一条通道的就绪状态。 */
export type ChannelState = {
  /** 是否可收款。 */
  ready: boolean;
  /** 未就绪的原因，可直接展示给运营。 */
  reason: string;
  /** 缺失的环境变量名清单，供后台「缺什么」列表使用。 */
  missing: string[];
};

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSY = new Set(["0", "false", "no", "off", "disabled"]);

/**
 * 读一个环境变量。
 *
 * 刻意 trim：密钥从控制台、剪贴板、`.env` 手动编辑拿过来时几乎必然带上
 * 首尾空白或换行（尤其支付宝私钥是 PEM 多行）。不 trim 的话，
 * 「明明配了却验签失败」会重演支付宝回调 100% 丢单那个坑。
 */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

/** 显式开关：只有写了 true/false 族值才生效，其余（含未设置）返回 undefined。 */
function envFlag(name: string): boolean | undefined {
  const value = env(name)?.toLowerCase();
  if (!value) return undefined;
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return undefined;
}

/** 环境变量里的数字费率，非法或越界返回 undefined（交给数据库兜底）。 */
function envRate(name: string): number | undefined {
  const value = env(name);
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : undefined;
}

/** 首一个有值的候选。 */
function first(...values: Array<string | undefined>): string | undefined {
  for (const value of values) if (value) return value;
  return undefined;
}

/**
 * 站点公网地址。
 *
 * 支付宝与易支付都要用它拼 notify_url / return_url。多个变量名是因为不同
 * 部署方式习惯用不同的名字：Cloudflare / Vercel 侧给 NEXT_PUBLIC_SITE_URL，
 * 裸机部署侧习惯 SITE_URL 或 BASE_URL。全都接受，少一步"该设哪个"。
 */
function envSiteUrl(): string | undefined {
  const raw = first(env("SITE_URL"), env("NEXT_PUBLIC_SITE_URL"), env("BASE_URL"));
  if (!raw) return undefined;
  // 统一去掉末尾斜杠：拼 `${siteUrl}/api/...` 时双斜杠会让部分网关判签名原文不匹配。
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// 各通道的环境变量映射
// ---------------------------------------------------------------------------

export const ENV_KEYS = {
  alipay: [
    "ALIPAY_PRIVATE_KEY",
    "ALIPAY_APP_ID",
    "ALIPAY_SELLER_ID",
    "ALIPAY_PUBLIC_KEY",
    "SITE_URL",
  ],
  epay: ["EPAY_KEY", "EPAY_PID", "EPAY_URL"],
  binance: ["BINANCE_PAY_API_KEY", "BINANCE_PAY_SECRET", "BINANCE_PAY_MERCHANT_ID"],
  epusdt: ["EPUSDT_URL", "EPUSDT_TOKEN"],
  usdt: ["USDT_WALLET_ADDRESS"],
} as const;

/**
 * 从环境变量组装一份完整的支付配置。
 *
 * 返回值形状与数据库行同构，因此调用方（paymentAvailability / preparePayment /
 * 后台设置页）可以无差别使用，不需要在每个使用点都判断"这个值从哪来"。
 */
export function resolvePaymentsFromEnv(db: PaymentSettings | null | undefined): ResolvedPayments {
  // 先用 emptyRow 补齐缺失字段再读。
  //
  // 为什么要这一步：`db` 来自 `SELECT *`，理论上字段齐全，但实测有两条路径传进来的
  // 是**部分行**——后台的审计对比只 select 了费率三列。若直接 `base.epayUrl.replace()`，
  // 那种情况下就是 `undefined.replace()` 抛 TypeError，整个支付页 500。
  // 用 `?? ""` 逐个兜底会把同样的问题散落到十几个地方，因此在这里一次性补齐。
  const row = (db ?? {}) as Partial<PaymentSettings>;
  const base: PaymentSettings = { ...emptyRow(), ...row } as PaymentSettings;
  const envSite = envSiteUrl();

  // 文本类字段统一 trim 并转字符串：数据库 numeric 列在驱动层可能是字符串也可能是数字，
  // 而这里返回的类型是 string。直接透传会让调用方的正则校验遇到非字符串而抛错。
  const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value).trim());
  const rate = (value: unknown): string => text(value) || "0";

  // ---- 支付宝 ----
  const alipayPrivateKey = env("ALIPAY_PRIVATE_KEY");
  const alipayAppId = env("ALIPAY_APP_ID") ?? text(base.alipayAppId);
  // ALIPAY_PID 是部分部署习惯用的名字，两个都接受，少一步"该设哪个"。
  const alipaySellerId = env("ALIPAY_SELLER_ID") ?? env("ALIPAY_PID") ?? text(base.alipaySellerId);
  const alipayPublicKey = env("ALIPAY_PUBLIC_KEY") ?? text(base.alipayPublicKey);

  // ---- 易支付 ----
  const epayKey = env("EPAY_KEY");
  const epayPid = env("EPAY_PID") ?? text(base.epayPid);
  const epayUrl = (env("EPAY_URL") ?? text(base.epayUrl)).replace(/\/+$/, "");

  // ---- 币安支付 ----
  const binanceKey = env("BINANCE_PAY_API_KEY") ?? env("BINANCE_PAY_CERT_SN");
  const binanceSecret = env("BINANCE_PAY_SECRET");
  const binanceMerchantId = env("BINANCE_PAY_MERCHANT_ID") ?? text(base.binanceMerchantId);
  const binanceCurrency = (env("BINANCE_PAY_CURRENCY") ?? (text(base.binanceCurrency) || "USDT")).toUpperCase();

  // ---- epusdt（自建 USDT 收银台）----
  // 收银台地址与 PID 落库以便后台可视化，但 secret 只认环境变量。
  const epusdtUrl = (env("EPUSDT_URL") ?? text(base.epusdtUrl)).replace(/\/+$/, "");
  // BEpusdt 只有一个 API Token（无 PID + secret 双凭证），且收的链与币种
  // 合并成一个 trade_type 字段（形如 usdt.trc20）。
  const epusdtApiToken = env("EPUSDT_TOKEN");
  const epusdtTradeType = (env("EPUSDT_TRADE_TYPE") ?? (text(base.epusdtToken) || "usdt.trc20")).toLowerCase();

  // ---- USDT ----
  const walletAddress = (env("USDT_WALLET_ADDRESS") ?? text(base.walletAddress)).trim();
  const exchangeRate = env("USDT_EXCHANGE_RATE") ?? (text(base.exchangeRate) || "7.20");

  return {
    ...base,
    // 站点地址：环境变量优先。缺失时回落数据库，两处都没有则为空字符串，
    // 上层的 availability 判定会因此把支付宝判为未就绪——这是正确行为，
    // 因为没有公网地址就拼不出回调地址。
    siteUrl: envSite ?? text(base.siteUrl),
    alipayAppId,
    alipaySellerId,
    alipayPublicKey,
    alipayGateway: env("ALIPAY_GATEWAY") ?? (text(base.alipayGateway) || "https://openapi.alipay.com/gateway.do"),
    epayUrl,
    epayPid,
    walletAddress,
    exchangeRate,
    binanceMerchantId,
    binanceCurrency,
    epusdtUrl,
    epusdtToken: epusdtTradeType,
    // 费率：环境变量可覆盖，便于 CI / 灰度环境用不同费率而不必改库。
    alipayFeeRate: String(envRate("ALIPAY_FEE_RATE") ?? rate(base.alipayFeeRate)),
    epayFeeRate: String(envRate("EPAY_FEE_RATE") ?? rate(base.epayFeeRate)),
    usdtFeeRate: String(envRate("USDT_FEE_RATE") ?? rate(base.usdtFeeRate)),
    binanceFeeRate: String(envRate("BINANCE_PAY_FEE_RATE") ?? rate(base.binanceFeeRate)),
    epusdtFeeRate: String(envRate("EPUSDT_FEE_RATE") ?? rate(base.epusdtFeeRate)),
    // 开关：显式值 > 凭据推导 > 数据库值。推导规则见文件头注释。
    alipayEnabled: resolveEnabled("ALIPAY_ENABLED", () =>
      alipayCredsComplete({
        privateKey: alipayPrivateKey, appId: alipayAppId, sellerId: alipaySellerId,
        publicKey: alipayPublicKey, site: envSite ?? base.siteUrl,
      }), base.alipayEnabled),
    epayEnabled: resolveEnabled("EPAY_ENABLED", () => !!(epayKey && epayPid && /^https?:\/\//i.test(epayUrl)), base.epayEnabled),
    binanceEnabled: resolveEnabled("BINANCE_PAY_ENABLED", () => !!(binanceKey && binanceSecret && binanceMerchantId), base.binanceEnabled),
    usdtEnabled: resolveEnabled("USDT_ENABLED", () => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(walletAddress), base.usdtEnabled),
    epusdtEnabled: resolveEnabled("EPUSDT_ENABLED", () => !!(epusdtUrl && epusdtApiToken), base.epusdtEnabled),
  };
}

/** epusdt 的收银台地址、商户号与收款地址（API 内部要用，运行时单独取出）。 */
export function epusdtEndpoint(s: ResolvedPayments): { url: string; apiToken: string; tradeType: string; fiat: string; address?: string } {
  return {
    url: (process.env.EPUSDT_URL?.trim() || s.epusdtUrl).replace(/\/+$/, ""),
    // token 是鉴权凭证，只从环境变量读；数据库里不存。
    apiToken: process.env.EPUSDT_TOKEN?.trim() || "",
    tradeType: (process.env.EPUSDT_TRADE_TYPE?.trim() || s.epusdtToken || "usdt.trc20").toLowerCase(),
    fiat: "CNY",
    // 收款 TRC20 地址：**只认 EPUSDT_ADDRESS 环境变量**，不回退 walletAddress——
    // 那属于「USDT 直充」通道（站内展示收款码、人工确认），两者是不同通道、地址独立，
    // 混用会把 epusdt 的钱打进另一条通道路由，属于资金事故。地址必须显式配置。
    ...(process.env.EPUSDT_ADDRESS?.trim() ? { address: process.env.EPUSDT_ADDRESS.trim() } : {}),
  };
}

/**
 * 开关的三级判定：显式环境变量 > 凭据推导 > 数据库原值。
 *
 * 刻意允许"凭据齐全就自动开"：这是本文件存在的意义——运营只填 .env 就能收款，
 * 不必再登录后台点一次开关。而 `*_ENABLED=false` 永远压过推导结果，
 * 给临时停用留了后门。
 */
function resolveEnabled(flagName: string, derived: () => boolean, fallback: boolean): boolean {
  const explicit = envFlag(flagName);
  if (explicit !== undefined) return explicit;
  return derived() || fallback;
}

/** 空行占位：数据库还没初始化时也能安全地参与合并。 */
function emptyRow(): PaymentSettings {
  return {
    id: 1,
    usdtEnabled: false,
    walletAddress: "",
    exchangeRate: "7.20",
    alipayEnabled: false,
    alipayAppId: "",
    alipaySellerId: "",
    alipayPublicKey: "",
    alipayGateway: "https://openapi.alipay.com/gateway.do",
    siteUrl: "",
    storeOpen: true,
    pausedReason: "",
    epayEnabled: false,
    epayUrl: "",
    epayPid: "",
    binanceEnabled: false,
    binanceMerchantId: "",
    binanceCurrency: "USDT",
    epusdtEnabled: false,
    epusdtUrl: "",
    epusdtToken: "usdt.trc20",
    epusdtFeeRate: "0",
    alipayFeeRate: "0.60",
    epayFeeRate: "0",
    usdtFeeRate: "6.00",
    binanceFeeRate: "0",
  };
}

function alipayCredsComplete(c: { privateKey?: string; appId: string; sellerId: string; publicKey: string; site: string }): boolean {
  return !!(c.privateKey && /^\d{16}$/.test(c.appId) && /^\d{12,24}$/.test(c.sellerId) && c.publicKey.length > 64 && /^https?:\/\//i.test(c.site));
}

// ---------------------------------------------------------------------------
// 就绪度判定
//
// 这里是"通道能不能用"的唯一判定处。原先分散在 paymentAvailability、
// epayAvailability 与后台页面的 GatewayStatus 三处，三处的判断条件并不完全
// 相同——于是出现过后台显示"已开启"而前台说"未就绪"。现在统一收口。
// ---------------------------------------------------------------------------

export function alipayState(s: ResolvedPayments): ChannelState {
  const missing: string[] = [];
  if (!env("ALIPAY_PRIVATE_KEY")) missing.push("ALIPAY_PRIVATE_KEY");
  if (!/^\d{16}$/.test(s.alipayAppId)) missing.push("ALIPAY_APP_ID");
  if (!/^\d{12,24}$/.test(s.alipaySellerId)) missing.push("ALIPAY_SELLER_ID");
  if (s.alipayPublicKey.length < 64) missing.push("ALIPAY_PUBLIC_KEY");
  if (!/^https?:\/\//i.test(s.siteUrl)) missing.push("SITE_URL");
  if (missing.length) return { ready: false, reason: "配置未完成，缺少 " + missing.join("、"), missing };
  return { ready: true, reason: "", missing };
}

export function epayState(s: ResolvedPayments): ChannelState {
  const missing: string[] = [];
  if (!env("EPAY_KEY")) missing.push("EPAY_KEY");
  if (!/^\d+$/.test(s.epayPid)) missing.push("EPAY_PID");
  if (!/^https?:\/\/.+/i.test(s.epayUrl)) missing.push("EPAY_URL");
  if (missing.length) return { ready: false, reason: "配置未完成，缺少 " + missing.join("、"), missing };
  return { ready: true, reason: "", missing };
}

export function binanceState(s: ResolvedPayments): ChannelState {
  const missing: string[] = [];
  if (!env("BINANCE_PAY_API_KEY")) missing.push("BINANCE_PAY_API_KEY");
  if (!env("BINANCE_PAY_SECRET")) missing.push("BINANCE_PAY_SECRET");
  if (!/^\d{6,20}$/.test(s.binanceMerchantId)) missing.push("BINANCE_PAY_MERCHANT_ID");
  if (missing.length) return { ready: false, reason: "配置未完成，缺少 " + missing.join("、"), missing };
  return { ready: true, reason: "", missing };
}

export function epusdtState(s: ResolvedPayments): ChannelState {
  const missing: string[] = [];
  if (!env("EPUSDT_URL")) missing.push("EPUSDT_URL");
  if (!env("EPUSDT_TOKEN")) missing.push("EPUSDT_TOKEN");
  if (!/^https?:\/\//i.test(s.epusdtUrl) && !env("EPUSDT_URL")) missing.push("EPUSDT_URL");
  if (missing.length) return { ready: false, reason: "配置未完成，缺少 " + missing.join("、"), missing };
  return { ready: true, reason: "", missing };
}

export function usdtState(s: ResolvedPayments): ChannelState {
  const missing: string[] = [];
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s.walletAddress)) missing.push("USDT_WALLET_ADDRESS");
  if (missing.length) return { ready: false, reason: "配置未完成，缺少 " + missing.join("、"), missing };
  return { ready: true, reason: "", missing };
}

/**
 * 全部通道的就绪状态。供后台「通道就绪状态」面板直接渲染。
 * 前台不用这个——前台只看 availability 布尔值。
 */
export function allChannelStates(s: ResolvedPayments): Record<"alipay" | "epay" | "binance" | "epusdt" | "usdt", ChannelState> {
  return { alipay: alipayState(s), epay: epayState(s), binance: binanceState(s), epusdt: epusdtState(s), usdt: usdtState(s) };
}

/** 密级配置的"是否已配置"布尔值。**只回布尔值，绝不回显密钥本身。** */
export function secretPresence(): {
  alipayPrivateKey: boolean;
  epayKey: boolean;
  binanceApiKey: boolean;
  binanceSecret: boolean;
  epusdtToken: boolean;
  usdtWebhook: boolean;
} {
  return {
    alipayPrivateKey: !!env("ALIPAY_PRIVATE_KEY"),
    epayKey: !!env("EPAY_KEY"),
    binanceApiKey: !!env("BINANCE_PAY_API_KEY"),
    binanceSecret: !!env("BINANCE_PAY_SECRET"),
    epusdtToken: !!env("EPUSDT_TOKEN"),
    // USDT 监听回调要求至少 32 字符，短密钥等价于没有密钥。
    usdtWebhook: (env("USDT_WEBHOOK_SECRET")?.length ?? 0) >= 32,
  };
}
