import { createHash } from "node:crypto";
import type { Order, PaymentSettings } from "@/db/schema";
import { orderTotal } from "@/lib/catalog";

// ---------------------------------------------------------------------------
// 易支付（聚合收银台）适配
//
// 为什么加这个：支付宝原生接入要为每个通道各写一套签名与回调核对，而易支付把
// 支付宝 / 微信 / QQ 钱包 / USDT 等聚合成一个协议——对接一次即可上线多个通道，
// 这正是"收款没对上"最省力的解法。独角数卡的 34 个网关本质上也是这层封装。
//
// 安全约定（与支付宝私钥同一原则）：
//   - 签名密钥只从环境变量 EPAY_KEY 读，不入库、不下发浏览器。
//   - 金额以「实付」核对，不用商品价，避免少收手续费。
//   - 回调必须验签，且幂等由 markPaid 的事务 + transactionId 唯一约束保证。
// ---------------------------------------------------------------------------

const MD5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");

/**
 * 参与签名的参数按 key 字典序升序拼 k=v&k=v。
 *
 * **sign 与 sign_type 都要剔除**——这是易支付协议的明文规定：
 *   「将发送或接收到的所有参数按照参数名 ASCII 码从小到大排序(a-z)，
 *     sign、sign_type、和空值不参与签名」
 * （yi-zhifu 官方文档，以及 epusdt、TokenPay 等各家的实现均如此）
 *
 * 此前这里只剔除了 `sign`。本站在**发起**时不发 sign_type，所以自己算的签名是对的；
 * 但**回调**是网关发来的，epusdt 等实现会带 `sign_type=MD5`。
 * 于是验签原文里多出 `sign_type=MD5&` 这一段 → 算出的 MD5 必然不同
 * → 验签 100% 失败 → 钱到了、订单永远 pending、且因验签失败不写流水，
 * 事后连一条可供排查的记录都没有。
 *
 * 这类"发起侧对、接收侧错"的缺陷最难发现：签名逻辑看起来完全正常，
 * 只有真实网关回调时才暴露。因此发起与验签必须共用同一个 canonical。
 */
function canonical(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "" && params[key] !== undefined)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

export type EpayAvailability = { available: boolean; reason?: string };

export function epayAvailability(settings: PaymentSettings): EpayAvailability {
  if (!settings.epayEnabled) return { available: false, reason: "收银台通道未开启" };
  if (!/^https?:\/\/.+/i.test(settings.epayUrl)) return { available: false, reason: "收银台网关地址未配置或格式不正确" };
  if (!/^\d+$/.test(settings.epayPid)) return { available: false, reason: "收银台商户号未配置" };
  if (!process.env.EPAY_KEY) return { available: false, reason: "服务器未设置 EPAY_KEY 签名密钥" };
  return { available: true };
}

/** 构造跳转收银台的 URL。type 传空字符串由收银台自选通道，或指定 alipay/wxpay。 */
export function buildEpayUrl(order: Order, settings: PaymentSettings, type = ""): string {
  const key = process.env.EPAY_KEY!;
  const base = settings.epayUrl.replace(/\/+$/, "");
  const params: Record<string, string> = {
    pid: settings.epayPid,
    // out_trade_no 用我方订单号：回调按它定位订单，天然幂等且不依赖第三方单号。
    out_trade_no: order.code,
    notify_url: `${settings.siteUrl.replace(/\/$/, "")}/api/payments/epay/notify`,
    return_url: `${settings.siteUrl.replace(/\/$/, "")}/orders/${order.id}/result`,
    // 收银台展示的金额必须与回调核对、支付页展示用的是同一个口径（orderTotal）。
    money: orderTotal(order),
    name: `aura ${order.planName}`.slice(0, 100),
    sitename: "aura",
    type,
  };
  params.sign = MD5(canonical(params) + key);
  return `${base}/submit.php?${new URLSearchParams(params)}`;
}

/**
 * 回调验签：只管签名与商户号。
 *
 * 此前这里还检查 `trade_status !== "TRADE_SUCCESS"`，导致两个问题：
 *   1. 路由里那段"协议终态非成功也要留痕"的代码永远进不去（死代码）；
 *   2. TRADE_CLOSED（买家超时关单）是**正常业务事件**，却被判为验签失败，
 *      以 reason=sign_mismatch 落进 audit —— 告警通道被正常流量污染，
 *      同时 payment_transactions 里一条记录都没有，事后无法归因。
 * 状态判断已交还给路由按 trade_status 分派。
 */
export function verifyEpay(params: Record<string, string>, settings: PaymentSettings): boolean {
  const key = process.env.EPAY_KEY;
  if (!key || !params.sign) return false;
  if (params.pid !== settings.epayPid) return false;
  const expected = MD5(canonical(params) + key);
  // 定长比较，避免通过响应时间差异逐位猜签名。
  if (expected.length !== params.sign.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ params.sign.charCodeAt(i);
  return diff === 0;
}

/** 回调是否代表收款成功。TRADE_FINISHED 与 TRADE_SUCCESS 都算终态成功。 */
export function isEpayPaid(params: Record<string, string>): boolean {
  return /^(TRADE_SUCCESS|TRADE_FINISHED)$/.test(params.trade_status || "");
}

// orderTotalForEpay 已删除。
// 它是 amount + feeAmount，**不减 discountAmount**，而回调核对（epay/notify）
// 用的是 pricing.ts 的 orderTotal（= amount + fee - discount）。两个口径不一致
// 造成两个后果，都很严重：
//   1. 用了优惠券的订单：收银台按 119 收钱，回调拿 119 去比 69 → 判定金额不符
//      → 写一条 rejected/amount_mismatch → 然后返回 "success"，收银台认为已收款
//      永不重投。买家付了钱，订单永远 pending，无退款流程。
//   2. 同一笔订单，支付页显示"实付 ¥69"，点进收银台显示 ¥119 —— 买家看到 A
//      金额、被收 B 金额。
// 现在收银台与回调核对共用 pricing.orderTotal 这一个口径。
