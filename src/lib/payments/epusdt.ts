// ---------------------------------------------------------------------------
// BEpusdt 自建 USDT 收银台适配器
//
// 【重要：软件叫 BEpusdt，不是 epusdt】
// 两者曾同源，但现已**完全独立运营**：原始 epusdt 项目已转手，与本项目再无联系。
// 它们的 API 完全不同，混用必然 404：
//   · BEpusdt（本文件实现）—— v03413/BEpusdt
//       创建 POST /api/v1/order/create-transaction
//       签名 MD5(canonical + api_token) 小写，签名放 body 的 signature 字段
//   · 原始 epusdt —— GMPay 接口 /payments/gmpay/v1/...，HMAC-SHA256，pid + secret_key
// 本站通道代码沿用 `epusdt` 这个叫法（业界与 Dujiao-Next 都这么叫），
// 但**实现对接的是 BEpusdt**。部署请认准 v03413/BEpusdt。
//
// 【为什么选它】
// 钱直接进你自己的钱包，不经过交易所 → **不需要企业 KYB 资质**（币安要），
// 也没有平台抽成。且它每分钟推送一次「等待支付」回调，等于给了一个心跳：
// 丢单不需要额外的查单接口，靠这个回调就能知道订单是否还在等。
//
// 【协议要点，取自 v03413/BEpusdt 官方文档】
//   · 创建  POST {BASE}/api/v1/order/create-transaction
//   · 签名  MD5(排序拼接串 + api_token)，小写 hex，放 body 的 signature 字段
//   · canonical：剔除 signature 与空值 → 参数名 ASCII 升序 → `k=v&k=v`（不 URL 编码）
//   · 字段  order_id / amount(法币) / fiat / trade_type(如 usdt.trc20) / address / name
//   · 回调  POST notify_url（JSON），必须回 HTTP 200 + body `ok`（大小写不敏感）
//   · 重试  2→4→8→16→32→64… 分钟，最多 10 次
//
// 【最容易踩的四个坑】
//   1. **amount 是法币金额**，不是 USDT 数量。传错会差 7 倍左右。
//   2. **api_token 直接拼在串尾，没有 & 分隔符**。多写一个 & 就全盘失败，
//      而网关只回一个笼统的错误码。
//   3. **trade_type 形如 `usdt.trc20`**，不是分开的 token + network 两个字段。
//   4. 回调里 `token` 字段是**币种名**（如 "USDT"），而 `address` 才是收款地址。
//      早期文档表述不一致，这里以「不依赖 token 字段做判断」为准。
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  NormalizedNotification,
  PaymentGateway,
  VerifyContext,
} from "./types";

/** 默认收款组合：USDT on TRON。与本站 USDT 直充通道同一条链。 */
export const EPUSDT_DEFAULT_TRADE_TYPE = "usdt.trc20";

/**
 * 回调时间窗。
 *
 * 取 20 分钟：覆盖 BEpusdt 的重试间隔前几轮（2/4/8/16 分钟），
 * 又不至于长到一份历史合法通知能被无限重放。取更长等于没有校验。
 */
export const EPUSDT_WEBHOOK_WINDOW_MS = 20 * 60_000;

/**
 * 运行时配置。由 preparePayment 注入（来自 config.ts「环境变量优先、数据库兜底」的合并结果）。
 *
 * 刻意不直接读 process.env：否则后台填的值会失效，与本站约定冲突。
 *
 * 注意只有 apiToken，**没有 pid**——BEpusdt 的鉴权完全靠 token。
 */
export type EpusdtConfig = { url: string; apiToken: string; tradeType: string; fiat: string; address?: string };

function require_(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} 未配置，无法调用 BEpusdt`);
  return text;
}

function baseUrl(cfg: EpusdtConfig): string {
  // 去掉末尾斜杠：后面要拼 /api/v1/...，多一个斜杠会变成 //api 被网关拒。
  return require_(cfg.url, "EPUSDT_URL").replace(/\/+$/, "");
}

/**
 * BEpusdt 签名：MD5(排序拼接串 + api_token)，小写。
 *
 * 四个细节错一个就全盘失败，而网关只回一个笼统的 code：
 *   1. 剔除 `signature` 自身（否则自引用，任何报文都验不过）；
 *   2. 空字符串 / null 不参与签名；
 *   3. **不 URL 编码**。notify_url 里带 `://` 与 `&` 是常态，编码了就与网关原文不同；
 *   4. **api_token 直接拼在串尾，中间没有 `&`**。这是最隐蔽的一条——
 *      绝大多数签名实现都会习惯性加 `&`，而这里加了就不对。
 */
export function signParams(params: Record<string, unknown>, apiToken: string): string {
  const canonical = Object.keys(params)
    .filter(key => key !== "signature")
    .filter(key => {
      const value = params[key];
      return value !== "" && value !== null && value !== undefined;
    })
    .sort()
    .map(key => `${key}=${String(params[key])}`)
    .join("&");
  return createHash("md5").update(canonical + apiToken, "utf8").digest("hex");
}

/** 定长比较，避免通过响应时间差异逐位猜签名。 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 创建订单的响应。
 *
 * 官方文档没有给出 create-transaction 的完整响应 schema，只说明它
 * 「直接返回收款地址和加密货币支付金额」。因此这里**同时接受两种形态**：
 * 数据直接在顶层，或包在 `data` 里。这是防御性的，不是偷懒——
 * 猜错字段名会导致"下单成功但前端拿不到跳转地址"，表现为买家点了没反应。
 */
interface CreateResponse {
  trade_id?: string;
  order_id?: string;
  address?: string;
  actual_amount?: number | string;
  amount?: number | string;
  /** 部分版本直接给收银台页地址 */
  payment_url?: string;
  cashier_url?: string;
  /** 包一层的形态 */
  data?: {
    trade_id?: string;
    address?: string;
    actual_amount?: number | string;
    payment_url?: string;
    cashier_url?: string;
  };
  [key: string]: unknown;
}

async function post<T>(cfg: EpusdtConfig, path: string, payload: Record<string, unknown>): Promise<T> {
  const url = `${baseUrl(cfg)}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // BEpusdt 签名放在 body 的 signature 字段里，不是请求头。
    body: JSON.stringify({ ...payload, signature: signParams(payload, require_(cfg.apiToken, "EPUSDT_TOKEN")) }),
    // 自建在自己服务器上，网络延迟不可控。不设超时的话，一个挂起的请求
    // 会一直占住订单的支付位面，买家看到的是"转圈到超时"。
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const text = await response.text();
  let json: T;
  try { json = JSON.parse(text) as T; } catch { throw new Error(`BEpusdt 返回非 JSON 响应（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(`BEpusdt ${path} HTTP ${response.status}：${text.slice(0, 200)}`);
  return json;
}

export const epusdtGateway: PaymentGateway = {
  code: "epusdt",
  displayName: "USDT 自建收银台（BEpusdt）",
  // BEpusdt 没有公开的订单查询接口，因此不支持主动查单。
  // 丢单兜底靠它每分钟推送的 status=1「等待支付」回调——那本身就是一个心跳。
  supportsQuery: false,

  // 网关级就绪判定只认环境变量（PaymentGateway 接口拿不到数据库配置）。
  // 对前端暴露的可用性由 config.ts 的 epusdtState() 判定，它读合并后的配置。
  isReady() {
    return !!(process.env.EPUSDT_URL?.trim() && process.env.EPUSDT_TOKEN?.trim());
  },

  missingConfig() {
    return ["EPUSDT_URL", "EPUSDT_TOKEN"].filter(key => !process.env[key]?.trim());
  },

  /**
   * 创建订单。
   *
   * amount 传**法币金额**（人民币），不是 USDT 数量——BEpusdt 内部按自己的汇率折算。
   * 这一点与币安相反（币安要 USDT），搞混会得到一个差 7 倍左右的订单。
   */
  async createPayment(input: CreatePaymentInput, runtimeConfig?: unknown): Promise<CreatePaymentResult> {
    const cfg = runtimeConfig as EpusdtConfig;
    const json = await post<CreateResponse>(cfg, "/api/v1/order/create-transaction", {
      order_id: input.orderCode,
      amount: Number(input.amount),
      fiat: (cfg.fiat || "CNY").toUpperCase(),
      trade_type: cfg.tradeType || EPUSDT_DEFAULT_TRADE_TYPE,
      // BEpusdt 无地址池时可显式指定收款地址（默认为空走自动分配）。
      // 地址来自配置（EPUSDT_ADDRESS 或数据库），钱直接进该 TRC20 钱包。
      ...(cfg.address ? { address: cfg.address } : {}),
      name: input.subject.slice(0, 100),
      notify_url: `${input.siteUrl.replace(/\/+$/, "")}/api/payments/epusdt/notify`,
      redirect_url: `${input.siteUrl.replace(/\/+$/, "")}/orders/${input.orderId}/result`,
    });

    // 顶层优先，其次 data —— 两种响应形态都兼容。
    const nested = json.data ?? {};
    const tradeId = String(json.trade_id ?? nested.trade_id ?? "");
    const paymentUrl = json.payment_url ?? json.cashier_url ?? nested.payment_url ?? nested.cashier_url ?? null;

    // 拿不到 trade_id 就无法幂等，也无法在回调里定位订单——必须当失败处理。
    if (!tradeId) throw new Error("BEpusdt 未返回 trade_id");

    return {
      // BEpusdt 的 create-transaction 是「地址独占」模式：它直接返回收款地址与
      // 应付数量，由本站渲染给买家。若同时给了收银台地址则优先跳过去。
      redirectUrl: paymentUrl,
      tradeNo: tradeId,
      expiresAt: null,
      raw: json,
    };
  },

  /**
   * 校验并归一化回调。
   *
   * 验签在路由层做（需要 api_token 且要基于原始 body），这里只管结构与字段。
   * 分层理由与其它网关一致：「消息是不是真的」与「消息说了什么」是两件事。
   */
  async verifyNotification(ctx: VerifyContext): Promise<NormalizedNotification> {
    const raw = await ctx.readRawBody();
    if (raw.length > 16384) throw new Error("BEpusdt 通知报文过大");
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw); } catch { throw new Error("BEpusdt 通知不是合法 JSON"); }

    const orderCode = String(event.order_id ?? "");
    // amount 是**法币**金额，actual_amount 才是链上实收的代币数量。
    // 核对订单必须用 amount：actual_amount 会随链上手续费浮动，拿它比订单必然不符。
    const amount = typeof event.amount === "number" ? event.amount.toFixed(2) : String(event.amount ?? "");
    const tradeNo = String(event.trade_id ?? "");
    if (!orderCode) throw new Error("BEpusdt 通知缺少 order_id");
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(amount)) throw new Error("BEpusdt 通知金额格式非法");

    return {
      // 部分版本的「等待支付」回调不带 trade_id，回落用 order_id 参与幂等键。
      tradeNo: tradeNo || orderCode,
      orderCode,
      amount,
      currency: "cny",
      status: normalizeStatus(event.status),
      raw: event,
    };
  },
};

/**
 * 状态归一化。
 * 1=等待支付（每分钟推送）2=支付成功 3=支付超时。
 * 1 映射成 pending 而非失败：它是正常心跳，不是异常。
 */
function normalizeStatus(status: unknown): NormalizedNotification["status"] {
  const value = Number(status);
  if (value === 2) return "succeeded";
  if (value === 3) return "failed";
  return "pending";
}

/**
 * 通知时间窗校验。
 *
 * 【必须传入回调报文里自带的时间戳，绝不能传 `Date.now()`】
 * 曾用 `epusdtTimestampFresh(String(Date.now()))` 调用：自己跟自己比，差值恒为 0
 * → 恒为真 → 一次也没拦住过任何东西，却让读代码的人以为防重放已经到位。
 * 当前 BEpusdt 通知里没有时间戳字段，调用方因此暂不调用本函数；
 * 将来协议补上时间戳字段时，必须传**报文里的值**，而不是本进程时钟。
 */
export function epusdtTimestampFresh(ts: string): boolean {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return false;
  return Math.abs(Date.now() - value) <= EPUSDT_WEBHOOK_WINDOW_MS;
}
