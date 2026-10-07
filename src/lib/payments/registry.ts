import { db } from "@/db";
import { CHANNEL_FEE_DEFAULTS } from "@/lib/catalog/pricing";
import { paymentSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
// ---------------------------------------------------------------------------
// 网关注册表
//
// 唯一的装配入口。订单层与回调层只认这里返回的网关，不直接 import 具体实现——
// 这样"某网关没就绪"这个判断只存在于一处，不会出现"后台显示已开启、
// 前台却说未就绪"这类前后端不一致。
//
// 三条装配规则：
//   1. 生产环境绝不注册 mock。它一旦上线就是"任何人都能伪造付款成功"的后门，
//      因此这里做成硬闸门而不是配置开关——不给人忘记关的机会。
//   2. 未就绪的网关不返回。调用方拿到的列表天然就是"现在能用的支付方式"。
//   3. 未知网关代码要报错，不能静默返回 null。上层传错 code 属于编程错误，
//      静默失败会变成买家点了支付按钮没反应。
// ---------------------------------------------------------------------------

import type { PaymentGateway, PaymentMethodCode } from "./types";
import { mockGateway } from "./mock";
import { binanceGateway } from "./binance";
import { epusdtGateway } from "./epusdt";

/**
 * 已实现、待接入的网关在此登记。
 *
 * 币安支付已实现并注册：请求签名（HMAC-SHA512）与通知验签（RSA-SHA256 + 币安公钥）
 * 两套机制分别在 gateway-api.ts 与 binance-cert.ts，规格取自币安官方文档与
 * binance/binance-pay-signature-examples。
 *
 * 支付宝与易支付**刻意不在此表**：它们是过程式函数（preparePayment 里的内联分支
 * 与 buildEpayUrl / verifyEpay），没有实现 PaymentGateway 接口。这不是遗漏——
 * 历史上曾把 requireGateway() 当安全闸门用，结果三条真实通道全部锁死、线上
 * 一分钱收不到。新增网关时不要为了"进这张表"去重写既有通道：接口是给新通道用的。
 */
const GATEWAYS: PaymentGateway[] = [mockGateway, binanceGateway, epusdtGateway];

function enabled(): PaymentGateway[] {
  const inProduction = process.env.NODE_ENV === "production";
  return GATEWAYS.filter(gateway => {
    if (gateway.code === "mock" && inProduction) return false;
    return gateway.isReady();
  });
}

/** 当前可用的支付方式。已就绪过滤在前台与后台展示前统一走这里。 */
export function availableGateways(): PaymentGateway[] {
  return enabled();
}

/**
 * 按代码取网关。
 * 传了 mock 但环境不允许（生产环境）时，错误信息要能让人一眼看懂原因，
 * 否则运营会以为是密钥没配，反复检查无关的地方。
 */
export function requireGateway(code: string): PaymentGateway {
  const all = [...GATEWAYS, ...enabled()];
  const found = all.find(gateway => gateway.code === code);
  if (!found) throw new Error(`未注册的支付方式：${code}`);
  if (found.code === "mock" && process.env.NODE_ENV === "production") {
    throw new Error("模拟支付在生产环境已被禁用，不可用于真实收款");
  }
  if (!found.isReady()) {
    throw new Error(`支付方式「${found.displayName}」配置未完成：${found.missingConfig().join("、")}`);
  }
  return found;
}

/**
 * 后台用：列出全部网关及其就绪状态与缺失项。
 * 运营在这里一眼看到"哪个通道没配好、缺什么"，不用去翻日志。
 */
export function gatewayStatus(): Array<{
  code: PaymentMethodCode;
  name: string;
  ready: boolean;
  missing: string[];
  disabledInProduction: boolean;
}> {
  return GATEWAYS.map(gateway => ({
    code: gateway.code,
    name: gateway.displayName,
    ready: gateway.isReady(),
    missing: gateway.missingConfig(),
    disabledInProduction: gateway.code === "mock" && process.env.NODE_ENV === "production",
  }));
}


/**
 * 取某支付通道的费率（百分比），供金额反算用。
 *
 * 从 payment_settings 读，运营在后台可改。读不到时回落到
 * CHANNEL_FEE_DEFAULTS 的默认值，而不是按 0 处理——按 0 会让运营以为
 * 通道免费，实际每单被抽走 0.6%，账目慢慢对不上。
 *
 * 刻意做成 async：费率必须实时取，不能缓存。运营改费率后要立刻生效，
 * 而进行中的订单已锁定了 fee_amount，不受影响。
 */
export async function channelRateFor(
  method: string,
): Promise<{ alipay: number; epay: number; usdt: number; epusdt: number; binance: number; mock: number }> {
  const defaults = CHANNEL_FEE_DEFAULTS;
  try {
    const [row] = await db.select({
      alipay: paymentSettings.alipayFeeRate,
      epay: paymentSettings.epayFeeRate,
      usdt: paymentSettings.usdtFeeRate,
      binance: paymentSettings.binanceFeeRate,
      epusdt: paymentSettings.epusdtFeeRate,
    }).from(paymentSettings).where(eq(paymentSettings.id, 1)).limit(1);
    if (!row) return defaults;
    // 上限 50，与 pricing.ts 的 MAX_RATE_PCT 及后台表单校验三者一致。
    // 此前这里是 < 100，于是 99 会透传进反算，119 / (1-0.99) = 11900。
    // 越界不静默接受，而是回落到默认值——脏数据不该变成天价订单。
    const num = (v: unknown, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 50 ? n : d;
    };
    return {
      alipay: num(row.alipay, defaults.alipay),
      epay: num(row.epay, defaults.epay),
      usdt: num(row.usdt, defaults.usdt),
      binance: num(row.binance, defaults.binance),
      epusdt: num(row.epusdt, defaults.epusdt),
      mock: defaults.mock,
    };
  } catch {
    // 读不到配置不该让下单失败：退到默认值，运营仍能收款，只是费率可能不准。
    return defaults;
  }
}

/** 单个通道的费率便捷入口。 */
export async function channelRateOf(method: string): Promise<number> {
  const rates = await channelRateFor(method);
  if (method in rates) return rates[method as keyof typeof rates];
  return 0;
}
