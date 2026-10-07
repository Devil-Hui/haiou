// ---------------------------------------------------------------------------
// 币安支付 REST 传输层
//
// 单独抽出来的原因：请求签名与证书拉取都要用同一套签名实现。
// 若各写一份，迟早会出现「创建订单用一个签名、查证书用另一个」，
// 而这类不一致只在其中一路径上暴露——表现为某一类请求稳定失败，
// 极难从代码上看出来。
//
// 本模块只负责「把带签名的请求发出去并解析响应」，不含任何业务语义。
// ---------------------------------------------------------------------------

import { createHmac, randomBytes } from "node:crypto";

export const BINANCE_BASE_URL = "https://bpay.binanceapi.com";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未设置，无法调用币安支付`);
  return value;
}

/** 毫秒时间戳。币安要求 Unix 毫秒，传秒会被判参数错误。 */
const timestamp = () => String(Date.now());

/** 32 字节随机 ASCII 串，满足官方对 nonce 的形态要求。 */
const nonce = () => randomBytes(24).toString("base64url").slice(0, 32);

/**
 * 请求签名：HMAC-SHA512(secret, `${timestamp}\n${nonce}\n${body}\n`)，输出大写 hex。
 *
 * 首尾两个 `\n` 是官方规范的一部分，少一个都能生成一个「格式合法但完全错误」的
 * 签名。这类错误的返回信息非常笼统，排查时几乎不可能想到换行符。
 * 改这个函数前请先对照 `binance/binance-pay-signature-examples`。
 */
export function signRequest(body: string, ts: string, np: string, secret: string): string {
  return createHmac("sha512", secret)
    .update(`${ts}\n${np}\n${body}\n`, "utf8")
    .digest("hex")
    .toUpperCase();
}

/** 币安业务返回码。`000000` 为成功，其余为失败。 */
const SUCCESS_CODE = "000000";

/**
 * 带签名的 POST。成功时返回 `data` 段。
 *
 * 失败时把币安自己的 `code` 与 `message` 一并抛出：把它们吞成"通道不可用"，
 * 运营就永远分不清是签名错、参数错还是币安侧故障。
 */
export async function call(path: string, payload: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify(payload);
  const ts = timestamp();
  const np = nonce();
  const response = await fetch(`${BINANCE_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "BinancePay-Timestamp": ts,
      "BinancePay-Nonce": np,
      "BinancePay-Certificate-SN": env("BINANCE_PAY_API_KEY"),
      "BinancePay-Signature": signRequest(body, ts, np, env("BINANCE_PAY_SECRET")),
    },
    body,
    // 币安网关对超时敏感。fetch 默认无超时，一个挂起的请求会一直占住
    // 订单的支付位面，买家看到的是"转圈到超时"而不是明确报错。
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`币安返回了非 JSON 响应（HTTP ${response.status}）`); }
  if (!response.ok || json?.code !== SUCCESS_CODE) {
    throw new Error(`币安接口 ${path} 返回 ${json?.code ?? response.status}：${json?.message ?? text.slice(0, 200)}`);
  }
  return json.data ?? {};
}
