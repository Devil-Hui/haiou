// ---------------------------------------------------------------------------
// Binance Pay 适配器
//
// 【为什么选它，以及它的真实代价】
// 优势：无需大陆备案、无需 PCI、秒级到账、费率低，覆盖 2 亿+ 币安用户。
// 代价（必须先知道，否则会白申请）：
//   1. **必须企业主体（KYB）**。币安已停止个人商户申请，需营业执照 + 法人实名。
//      没有企业主体就直接跳过这条通道，别在这上面耗时间。
//   2. **不提供沙箱环境**。没有测试密钥，验证方式只能是真实小额转账（0.1 USDT）。
//   3. 资金托管在币安交易所账户，非自托管。合规或风控视角要先评估这一点。
//
// 【协议要点，全部来自币安官方文档】
//   · REST 基址  https://bpay.binanceapi.com
//   · 请求签名  HMAC-SHA512(secret, `${ts}\n${nonce}\n${body}\n`)，大写 hex
//   · 必备请求头 BinancePay-Timestamp / -Nonce / -Certificate-SN（= API Key）/ -Signature
//   · Webhook  RSA-SHA256 验签，**不是** HMAC —— 公钥另行获取，见 binance-cert.ts
//   · Webhook 必须回 HTTP 200 + body "SUCCESS"，否则币安最多重投 6 次
//
// 【为什么签名与验签是两套算法】
// 请求是我们用 API Secret 签名给对方，证明"我是谁"；通知是对方用私钥签给我们，
// 证明"这条消息真的来自币安"。若用同一套算法，任何持有商户 Secret 的人都能伪造
// 付款成功通知 —— 那就是一个可无限提现的后门。
// ---------------------------------------------------------------------------

import type {
  CreatePaymentInput,
  CreatePaymentResult,
  NormalizedNotification,
  PaymentGateway,
  VerifyContext,
} from "./types";
import { call } from "./gateway-api";

/**
 * 通知时间窗。
 *
 * 取 300 秒（5 分钟）与 USDT 通道一致。注意币安的重投策略最长会持续较长时间，
 * 所以不能像支付宝那样一收到就无条件拒——但也不能放到 24 小时，
 * 那等于没有校验：一份历史合法通知被重放就能把任意订单补成已支付。
 */
export const BINANCE_WEBHOOK_WINDOW_MS = 300_000;

/** 归一化币安返回的状态。终态只有 PAY_SUCCESS；PAY_CLOSED 是超时关单。 */
function normalizeStatus(bizStatus: unknown): NormalizedNotification["status"] {
  if (bizStatus === "PAY_SUCCESS") return "succeeded";
  // PAY_CLOSED 与其它网关的 TRADE_CLOSED 同性质：买家超时关单，是正常业务事件，
  // 不该被记成"伪造回调"，否则告警通道会被正常流量污染。
  if (bizStatus === "PAY_CLOSED") return "failed";
  return "pending";
}

export const binanceGateway: PaymentGateway = {
  code: "binance",
  displayName: "币安支付（Binance Pay）",
  supportsQuery: true,

  isReady() {
    return !!(process.env.BINANCE_PAY_API_KEY?.trim() && process.env.BINANCE_PAY_SECRET?.trim() && process.env.BINANCE_PAY_MERCHANT_ID?.trim());
  },

  missingConfig() {
    return ["BINANCE_PAY_API_KEY", "BINANCE_PAY_SECRET", "BINANCE_PAY_MERCHANT_ID"].filter(key => !process.env[key]?.trim());
  },

  /**
   * 创建收银台订单。
   *
   * merchantTradeNo 用本站订单号（newOrderCode 生成的形态：字母数字，32 位内），
   * 而不是 uuid —— 币安对该字段有字符集与长度限制。
   * 同一 merchantTradeNo 重复提交是幂等的，天然防住买家反复点"去支付"。
   */
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const data = await call("/binancepay/openapi/v2/order", {
      env: { terminalType: "WEB" },
      merchantTradeNo: input.orderCode,
      orderAmount: input.amount,
      currency: "USDT",
      goods: {
        goodsType: "01",
        goodsCategory: "D000",
        referenceGoodsId: input.orderCode,
        goodsName: input.subject.slice(0, 100),
      },
    });
    return {
      // orderUrl 是币安托管的收银台页，qrCode 是同一笔单的静态二维码。
      // 两者都可用：桌面端跳页、移动端扫码，站长任选其一。
      redirectUrl: data?.orderUrl ?? null,
      tradeNo: data?.prepayId ?? null,
      // 币安对未支付订单有自动关单时限，但那是币安侧行为，本站的支付截止
      // 仍以 orders.expires_at 为准（30 分钟）。留 null 表示不用网关的时限。
      expiresAt: null,
      raw: data,
    };
  },

  /**
   * 校验并归一化 Webhook 通知的**结构**。
   *
   * 验签不在这里做——它需要币安公钥，由路由层在读取原始 body 之前完成。
   * 这样分层与其它网关一致：「消息是不是真的」和「消息说了什么」是两件事。
   * 两者混在一起会让人误以为只做了一半，而漏验签的后果是任意人可伪造付款成功。
   */
  async verifyNotification(ctx: VerifyContext): Promise<NormalizedNotification> {
    const raw = await ctx.readRawBody();
    if (raw.length > 32768) throw new Error("币安通知报文过大");
    let event: { data?: string; bizStatus?: string; bizType?: string };
    try { event = JSON.parse(raw); } catch { throw new Error("币安通知不是合法 JSON"); }
    if (event.bizType !== "PAY") throw new Error("币安通知类型不是支付");
    // data 是一段**字符串化**的 JSON，需要二次解析。这是官方结构；
    // 曾有实现直接当对象用，表现为"通知收到了但订单永远不更新"。
    let detail: Record<string, unknown>;
    try { detail = JSON.parse(String(event.data ?? "{}")); } catch { throw new Error("币安通知 data 字段解析失败"); }

    const tradeNo = String(detail.transactionId ?? "");
    const orderCode = String(detail.merchantTradeNo ?? "");
    const amount = String(detail.totalFee ?? "");
    if (!/^M_[A-Z0-9]+$/.test(tradeNo)) throw new Error("币安通知缺少合法交易号");
    if (!orderCode) throw new Error("币安通知缺少商户订单号");
    // 币安金额带 8 位小数（内部以 1e-8 定点记账），不能按 2 位校验。
    if (!/^\d{1,12}(\.\d{1,8})?$/.test(amount)) throw new Error("币安通知金额格式非法");

    return {
      tradeNo,
      orderCode,
      amount,
      // 币安 Pay 站内只用 USDT 计价，回调金额单位与 orders.usdtAmount 同为 USDT。
      currency: "usdt",
      status: normalizeStatus(event.bizStatus),
      raw: { ...detail, bizStatus: event.bizStatus },
    };
  },

  /** 主动查单。回调丢失时的兜底，币安侧按 merchantTradeNo 查。 */
  async queryStatus(_tradeNo: string, orderCode: string): Promise<NormalizedNotification | null> {
    const data = await call("/binancepay/openapi/v2/order/query", { merchantTradeNo: orderCode });
    if (!data) return null;
    return {
      tradeNo: String(data.transactionId ?? ""),
      orderCode,
      amount: String(data.orderAmount ?? ""),
      currency: "usdt",
      status: normalizeStatus(data.status),
      raw: data,
    };
  },
};

/** 通知时间窗校验。与金额口径一样，属于「这条通知值不值得信」的判断。 */
export function binanceTimestampFresh(ts: string): boolean {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return false;
  return Math.abs(Date.now() - value) <= BINANCE_WEBHOOK_WINDOW_MS;
}

/** 上面的常量在归一化函数里用到，单独导出以避免文件内重复定义。 */
export const BINANCE_SUCCESS_STATUS = "PAY_SUCCESS";
