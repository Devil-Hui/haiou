// ---------------------------------------------------------------------------
// 币安支付证书：获取并缓存币安公钥
//
// 【为什么必须单独一个模块】
// 币安通知的验签用的是 **RSA-SHA256 + 币安公钥**，而请求签名用的是
// HMAC-SHA512 + 商户 Secret。两者不是同一套东西。公钥必须从币安的证书接口
// 现取，没有它就无法验签——于是"没做这个模块"表现为"所有通知都验签失败"，
// 而日志里只写一句 verify failed，怎么查都查不出原因。
//
// 【公钥从哪来，两条路】
//   1. `POST /binancepay/openapi/certificates`（走 HMAC 签名，推荐）
//      → 返回 certSerial（公钥 MD5）与 certPublic（Base64 公钥体）。
//   2. 后台手动把 certPublic 贴进环境变量 `BINANCE_PAY_PUBLIC_KEY`。
//      用于接口不可用时的兜底，也让运营在换密钥期间不必等接口恢复。
//
// 优先用环境变量：接口有网络延迟与频控，而验签必须在收到通知的瞬间完成，
// 不能让一条付款通知因为一次证书拉取超时而变成丢单。
// ---------------------------------------------------------------------------

import { call } from "./gateway-api";

type Certificate = { certSerial: string; certPublic: string };

let cache: { value: Certificate; expiresAt: number } | null = null;

/** 证书有效期 8 小时。留 1 小时余量，避免边界上拿着过期证书验签失败。 */
const TTL_MS = 7 * 60 * 60_000;

/** 补成 PEM。币安返回的是裸 Base64，不带 BEGIN/END 头。 */
function toPem(base64: string): string {
  const body = base64.replace(/\s/g, "");
  if (body.includes("-----BEGIN")) return body;
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

/**
 * 取币安公钥（PEM 形态）。
 * 拿不到就抛错——**绝不返回 null 让上层"跳过验签"**。
 * 那等于开一个后门：任何人 POST 一条伪造的付款通知就能把订单变成已支付。
 */
export async function binancePublicKeyPem(): Promise<string> {
  const fromEnv = process.env.BINANCE_PAY_PUBLIC_KEY?.trim();
  if (fromEnv) return toPem(fromEnv);

  const now = Date.now();
  if (cache && cache.expiresAt > now) return toPem(cache.value.certPublic);

  const list = await call("/binancepay/openapi/certificates", {});
  const first = Array.isArray(list) ? list[0] : null;
  if (!first?.certPublic) throw new Error("币安证书接口未返回公钥");
  cache = { value: { certSerial: String(first.certSerial ?? ""), certPublic: String(first.certPublic) }, expiresAt: now + TTL_MS };
  return toPem(cache.value.certPublic);
}
