// ---------------------------------------------------------------------------
// 支付网关统一契约
//
// 为什么要有这一层：
//   此前 usdt / alipay / epay 三条链路的"发起支付、验签回调、核对金额"各写各的，
//   加一种支付方式就要把三处逻辑各抄一遍。抄第三遍时最容易漏掉金额核对或幂等，
//   而漏掉任何一处都是真实资金事故。本文件把「一个支付方式需要做什么」固定下来，
//   新增方式只实现接口，网关之间的差异被限制在实现内部。
//
// 三条不可让步的约束（任何新网关都必须遵守）：
//   1. 金额一律以「字符串」比较，不用浮点数。0.1 + 0.2 !== 0.3 在资金场景不可接受。
//   2. verifyNotification 是唯一信任边界。签名不通过、金额不符、币种不符，一律拒绝。
//   3. createPayment 不得承诺幂等。同一笔订单可能因买家反复点击而多次调用，
//      幂等由订单侧的 transactionId 唯一约束兜底，网关只负责如实返回本次结果。
// ---------------------------------------------------------------------------

/** 金额：十进制字符串，单位为元。禁止用 number 承载金额。 */
export type Money = string;

/** 币种。用 ISO 4217 小写码；站内目前只有人民币与 USDT 两种。 */
export type Currency = "cny" | "usdt";

export type PaymentMethodCode = "usdt" | "alipay" | "epay" | "epusdt" | "binance" | "mock";

/** 下单时冻结的收款信息。金额与订单在服务端核对，不信任任何来自前端的数字。 */
export interface CreatePaymentInput {
  /** 本站订单号，兼作网关侧的商户订单号。 */
  orderCode: string;
  /** 实付金额（含手续费），已由订单侧算好。 */
  amount: Money;
  /** 币种。USDT 网关需要它来算折算与展示。 */
  currency: Currency;
  /** 商品名，用于收银台标题与账单描述。 */
  subject: string;
  /** 站点公网地址，用于拼回调地址。取自配置，不接受请求传入。 */
  siteUrl: string;
  /** 站内订单主键，仅用于日志关联，网关不需要理解它。 */
  orderId: string;
}

/**
 * 收银台跳转信息。
 * redirectUrl 为空表示该网关是"站内被动确认"型（如 USDT 转账），
 * 前端改为展示收款码与金额，由人工确认到账。
 */
export interface CreatePaymentResult {
  redirectUrl: string | null;
  /** 网关侧交易号。发起阶段拿不到时为 null，回调时会补上。 */
  tradeNo: string | null;
  /** 订单支付截止时间。网关不支持时为 null，由站内 expiresAt 兜底。 */
  expiresAt: Date | null;
  /** USDT 类网关需要展示的收款信息。 */
  wallet?: { address: string; amount: string; network: string; qrDataUrl?: string };
  /** 供后台排查的原始响应（已剔除敏感字段）。 */
  raw?: unknown;
}

/**
 * 归一化后的回调通知。
 * 各网关的字段名、状态值、金额单位都不同，统一在此收敛，
 * 上层订单逻辑只认这一个结构，不再出现 if (method === "alipay") 这类分支。
 */
export interface NormalizedNotification {
  /** 网关侧交易号。 */
  tradeNo: string;
  /** 商户订单号，对应 CreatePaymentInput.orderCode。 */
  orderCode: string;
  /** 网关确认收到的金额与币种，必须与订单实付一致，否则上层拒绝入账。 */
  amount: Money;
  currency: Currency;
  /** 归一化状态。 */
  status: "succeeded" | "failed" | "pending";
  /** 网关原始报文，原样留档用于对账与举证（已剔除密钥类字段）。 */
  raw: unknown;
}

export interface VerifyContext {
  /** 读取原始报文。用 Request 而非已解析对象，因为验签必须基于原始字节。 */
  readRawBody: () => Promise<string>;
  /** 附加信息：请求头、来源 IP。 */
  headers: Headers;
  clientIp: string | null;
}

export interface PaymentGateway {
  readonly code: PaymentMethodCode;
  readonly displayName: string;
  /** 是否支持主动查单。不支持的网关返回 null。 */
  readonly supportsQuery: boolean;

  /**
   * 配置是否就绪。未就绪的网关不会出现在前台可选项里——
   * 让买家选了一个必然失败的支付方式，比不显示它更糟。
   */
  isReady(): boolean;
  /** 缺失的配置项，用于后台明确提示运营去补什么。 */
  missingConfig(): string[];

  /**
   * 发起支付。
   *
   * `runtimeConfig` 是「环境变量优先、数据库兜底」合并后的网关配置。
   * 传进来而不是让实现自己读 process.env，是为了让后台填的值也能生效——
   * 否则「环境变量优先」就变成了「只有环境变量可用」，与本站约定不符。
   * 用不到的网关忽略该参数即可。
   */
  createPayment(input: CreatePaymentInput, runtimeConfig?: unknown): Promise<CreatePaymentResult>;

  /**
   * 验签并归一化。验签失败必须 throw，不要返回 null——
   * 「验签失败」和「签名有效但状态不是成功」是两种不同的事件，处置方式不同。
   */
  verifyNotification(ctx: VerifyContext): Promise<NormalizedNotification>;

  /**
   * 主动查单，用于回调丢失时的兜底与每日对账。
   *
   * 返回的 NormalizedNotification.amount 可能是空串：**查单接口通常不回金额**。
   * 调用方**不得**拿它做金额核对，金额必须以本地订单实付为准。
   * 契约里不强制非空，是为了不逼所有网关伪造一个金额出来。
   */
  queryStatus?(tradeNo: string, orderCode: string, runtimeConfig?: unknown): Promise<NormalizedNotification | null>;
}

// ---------------------------------------------------------------------------
// 金额工具
//
// 统一放这里，避免每个网关各写一份 parseFloat 逻辑。
// 内部用「分」做整数运算：把 "119.00" 拆成 11900 分，比较与加减都在整数域完成，
// 彻底避开浮点误差。最后再由 toMoney 还原成两位小数字符串。
// ---------------------------------------------------------------------------

/**
 * 把金额字符串安全解析成「分」。格式非法返回 null，绝不返回 NaN 参与运算。
 *
 * 小数位上限锁死 2 位：金额出现「分以下」的精度本身就是协议异常，
 * 静默截断会把 1.999 元当成 1.99 元，比直接判非法危险得多。
 */
export function toCents(value: string): number | null {
  const text = String(value).trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}
