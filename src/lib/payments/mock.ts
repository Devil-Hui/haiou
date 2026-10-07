// ---------------------------------------------------------------------------
// Mock 网关
//
// 存在的理由：支付链路最贵的 bug 永远出现在「真实回调」这一步，而真实回调需要
// 商户号、密钥、sandbox 账号。没有 mock 就只能等真实环境配好才敢碰这段代码，
// 于是这段代码长期无人验证。mock 让整条链路在本地就能端到端跑通。
//
// 它同时是 Binance 等新网关的对标实现：先照着 mock 把「发起 → 回调 → 核账 →
// 幂等」这条主线在本地验通，再把 createPayment 与 verifyNotification 换成
// 真实报文，订单层一行都不用动。
//
// 安全约束（与真实网关同级，不因为是 mock 就放松）：
//   · 仅在 NODE_ENV !== "production" 时注册，避免误上线收假钱。
//   · 回调走标准 HMAC 验签，密钥取自环境变量，缺失则拒绝。
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  NormalizedNotification,
  PaymentGateway,
  VerifyContext,
} from "./types";

const SECRET_ENV = "MOCK_PAY_SECRET";

function secret(): string {
  const value = process.env[SECRET_ENV];
  // 没有密钥就没有验签能力。mock 是用来验证安全链路的，不允许"默认放行"，
  // 否则真把它部署上去，等于开了一个任何人可伪造付款成功的后门。
  if (!value) throw new Error(`${SECRET_ENV} 未设置，无法启用 mock 网关`);
  return value;
}

/** 报文规范化后再签名，与验签时保持完全一致的构造顺序。 */
function canonical(fields: Record<string, string>): string {
  return Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
}

function sign(fields: Record<string, string>): string {
  return createHmac("sha256", secret()).update(canonical(fields)).digest("hex");
}

export const mockGateway: PaymentGateway = {
  code: "mock",
  displayName: "模拟支付（仅测试环境）",
  supportsQuery: true,

  isReady() {
    return !!process.env[SECRET_ENV];
  },

  missingConfig() {
    return process.env[SECRET_ENV] ? [] : [SECRET_ENV];
  },

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // 用订单号派生一个稳定交易号：同一笔订单反复点击得到同一个号，
    // 便于验证幂等路径，而不是每次造新号把幂等测试变成假测。
    const tradeNo = `mock_${input.orderCode}`;
    return {
      redirectUrl: `/checkout/mock?order=${encodeURIComponent(input.orderCode)}&trade=${encodeURIComponent(tradeNo)}&amount=${encodeURIComponent(input.amount)}`,
      tradeNo,
      // 15 分钟：与站内订单有效期一致，避免买家付款时订单已关闭。
      expiresAt: new Date(Date.now() + 15 * 60_000),
      raw: { orderCode: input.orderCode, amount: input.amount },
    };
  },

  async verifyNotification(ctx: VerifyContext): Promise<NormalizedNotification> {
    const raw = await ctx.readRawBody();
    const fields: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw).entries()) {
      // 出现同名参数一律拒绝，而不是"取第一个"。两种做法都能防住覆盖攻击，
      // 但静默取第一个会把攻击痕迹藏起来，日后无从排查；显式拒绝还能留下审计。
      // 与支付宝回调端点的既有行为保持一致。
      if (k in fields) throw new Error(`mock 回调出现重复参数：${k}`);
      fields[k] = v;
    }

    // 验签时必须把 sign 自身排除在待签名字段之外：签名是用"不含 sign 的字段集"
    // 算出来的，若把 sign 一起算进去就变成自引用，任何合法报文都会被判失败。
    const { sign: provided, ...payload } = fields;
    if (!provided) throw new Error("mock 回调缺少签名");
    const expected = sign(payload);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // 长度不同直接拒绝，不进 timingSafeEqual（长度不等会抛异常，
    // 把异常当鉴权结果，会让攻击面变成"靠异常信息猜测"）。
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("mock 回调验签失败");

    if (!fields.trade_no || !fields.out_trade_no || !fields.money) throw new Error("mock 回调缺少必填字段");
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(fields.money)) throw new Error("mock 回调金额格式非法");

    return {
      tradeNo: fields.trade_no,
      orderCode: fields.out_trade_no,
      amount: fields.money,
      currency: "cny",
      status:
        fields.trade_status === "TRADE_SUCCESS" ? "succeeded" : fields.trade_status === "TRADE_PENDING" ? "pending" : "failed",
      raw: fields,
    };
  },

  /**
   * 主动查单。真实网关返回的是网关侧独立数据，这里返回 null 表示"查不到"——
   * 刻意保留这条分支，免得接真实网关后才发现上层没处理 null。
   */
  async queryStatus(): Promise<NormalizedNotification | null> {
    return null;
  },
};

/**
 * 构造一笔合法回调报文。
 *
 * 放在网关实现里而不是测试文件里，是为了让「怎么签」与「怎么验」共用同一个
 * canonical()。测试自己拼报文极易与验签逻辑漂移，出现"测试通过但线上收不到钱"。
 * 调试时把 tradeStatus 改成 TRADE_PENDING 或 FAILED 即可覆盖另外两条分支。
 */
export function buildMockNotification(input: {
  orderCode: string;
  amount: string;
  tradeNo?: string;
  tradeStatus?: string;
}): string {
  const fields: Record<string, string> = {
    out_trade_no: input.orderCode,
    trade_no: input.tradeNo ?? `mock_${input.orderCode}`,
    money: input.amount,
    trade_status: input.tradeStatus ?? "TRADE_SUCCESS",
  };
  return new URLSearchParams({ ...fields, sign: sign(fields) }).toString();
}
