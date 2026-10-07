import { createSign, createVerify } from "node:crypto";
import QRCode from "qrcode";
import type { Order, PaymentSettings } from "@/db/schema";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { buildEpayUrl } from "./epay";
import { orderTotal, toUsdt } from "@/lib/catalog";
import { alipayState, allChannelStates, binanceState, epayState, epusdtState, epusdtEndpoint, usdtState } from "./config";
import { binanceGateway } from "./binance";
import { epusdtGateway } from "./epusdt";
import { recordTx } from "./tx";
import { sanitizePayload } from "./tx";

export const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/**
 * 支付宝通知的时间窗。
 *
 * 取 30 分钟是权衡：支付宝官方重投策略跨度到 24 小时，但真实支付通知几乎都是
 * 秒级到达，30 分钟足以覆盖全部正常情况，同时把历史通知重放的窗口压到最小。
 * 取太长（比如 24 小时）等于没有校验——重放者只要等一天就能绕过。
 */
export const ALIPAY_NOTIFY_WINDOW_MS = 30 * 60_000;

/**
 * 各通道是否可收款。
 *
 * 判定逻辑全部委托给 config.ts 的 *State 函数——那是唯一一处定义"什么算就绪"
 * 的地方。此前这段判断与 epayAvailability、后台 GatewayStatus 各写一套，
 * 三处的条件并不完全相同，于是出现过"后台显示已开启、前台却说未就绪"。
 * 现在改条件只需要改 config.ts 一处。
 *
 * 传入的 settings 应当来自 getPaymentSettings()（已做环境变量合并），
 * 因此这里不需要再关心值是从 .env 还是数据库来的。
 */
export function paymentAvailability(settings: PaymentSettings) {
  return {
    usdt: settings.usdtEnabled && usdtState(settings).ready,
    alipay: settings.alipayEnabled && alipayState(settings).ready,
    epay: settings.epayEnabled && epayState(settings).ready,
    epusdt: settings.epusdtEnabled && epusdtState(settings).ready,
    binance: settings.binanceEnabled && binanceState(settings).ready,
  };
}
function pem(key: string, type: "PRIVATE" | "PUBLIC") {
  const normalized = key.replace(/\\n/g, "\n").trim();
  if (normalized.includes("-----BEGIN")) return normalized;
  return `-----BEGIN ${type} KEY-----\n${normalized.replace(/\s/g, "").match(/.{1,64}/g)?.join("\n")}\n-----END ${type} KEY-----`;
}
/**
 * 构造待签名的原文。
 *
 * 支付宝官方规范（AbstractAlipaySignature#getSignContent）规定：
 * **sign 与 sign_type 都要剔除**，只对剩余的非空参数按 key 升序拼 "k=v&k=v"。
 *
 * 此前这里有个 omitType 开关，签名侧传 false（含 sign_type）、验签侧传 true
 * （剔除 sign_type）——两侧原文不是同一个集合。后果是支付宝发来的合法
 * 通知一定验签失败：钱到了、订单永远是 pending、买家拿不到卡密，
 * 而且按设计验签失败不写流水，连一条可供排查的记录都没有。
 *
 * 现在两侧统一走同一个函数，omitType 形参已删除——保留一个只会让下一个人
 * 以为"签名侧确实需要包含 sign_type"的开关。
 */
const canonical = (params: Record<string, string>) =>
  Object.keys(params)
    .filter(key => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join("&");

// 收款地址一旦冻结就不再变化，二维码因此是确定的：同一地址编码出的 PNG 完全相同。
// 缓存它，支付页刷新时省掉一次纯 CPU 的 PNG 编码和数 KB 的 base64 字符串分配。
// 键是钱包地址，条目数等于配置过的地址数（通常 1 个），内存有界。
const qrCache = new Map<string, string>();
async function qrDataUrl(wallet: string) {
  const cached = qrCache.get(wallet);
  if (cached) return cached;
  const dataUrl = await QRCode.toDataURL(wallet, { width: 240, margin: 1, color: { dark: "#344A2C", light: "#FFFFFF" } });
  // 钱包地址可以随时更换；超过 8 条就整体清空，缓存永远不会无界增长
  if (qrCache.size >= 8) qrCache.clear();
  qrCache.set(wallet, dataUrl);
  return dataUrl;
}

/**
 * 收款前的安全闸门：**只**拦住「生产环境用 mock 收款」这一件事。
 *
 * 这里刻意不做"通道是否就绪"的判断。通道就绪由下面的 paymentAvailability
 * 负责，它给出的是 { available: false, message } 这种优雅降级——买家看到
 * "通道维护中，订单已保存"，钱没丢、订单还在。这比抛错转 503 更合适。
 *
 * 曾经在这里调用 requireGateway()，是个工具错配，已移除，原因有两条：
 *   1. requireGateway 的语义是「取一个实现了 PaymentGateway 接口的实例」。
 *      而 usdt / alipay / epay 三条真实通道的实现是散在本文件与 epay.ts 里的
 *      过程式函数，并没有实现那个接口，因此 requireGateway 一律抛
 *      「未注册的支付方式」——等于把三条真实通道全部锁死，线上一分钱都收不到。
 *   2. 拿"取实例"当"安全闸门"用，会让"加一条支付通道"这件事从
 *      "写个函数"变成"先实现整个接口"，把门槛人为抬高。
 *
 * 生产禁用 mock 这条安全需求本身是真实的，必须保留，且必须是硬闸门：
 * mock 一旦上线就是"任何人都能伪造付款成功"的后门。
 */
function assertNotMockInProduction(method: string): void {
  if (method === "mock" && process.env.NODE_ENV === "production") {
    throw new Error("模拟支付在生产环境已被禁用，不可用于真实收款");
  }
}

export async function preparePayment(order: Order, settings: PaymentSettings) {
  // 硬闸门先行：生产环境禁止用 mock 收款。
  assertNotMockInProduction(order.paymentMethod);
  const availability = paymentAvailability(settings);
  const method = order.paymentMethod as "usdt" | "alipay" | "epay" | "epusdt" | "binance";
  if (!availability[method]) {
    // 通道未就绪时给出**具体缺什么**，而不是笼统的"尚未配置完成"。
    // 运营看到的是能直接照着做的清单，而不是一句需要他自己去猜的话。
    const states = allChannelStates(settings);
    const detail = states[method as keyof typeof states]?.reason;
    return { available: false, method, message: `该支付通道尚未配置完成${detail ? `（${detail}）` : ""}。你的订单已安全保存，请稍后重试，当前无需付款。` };
  }
  const total = orderTotal(order);
  if (method === "usdt") {
    // Freeze the receiver on first payment preparation. Never replace an existing receiver.
    const wallet = order.walletAddress || settings.walletAddress;
    if (!order.walletAddress) await db.update(orders).set({ walletAddress: wallet }).where(eq(orders.id, order.id));
    return { available: true, method, network: "TRON · TRC20", walletAddress: wallet, amount: order.usdtAmount, total, qrCode: await qrDataUrl(wallet) };
  }
  if (method === "epay") {
    return { available: true, method, total, checkoutUrl: buildEpayUrl(order, settings) };
  }
  if (method === "epusdt") {
    // 自建 USDT 收银台：钱直接进你自己的钱包，不需要企业资质，也没有平台抽成。
    // 订单不需要预锁 usdtAmount —— epusdt 内部按它自己的汇率折算，
    // 本站只传法币金额（orderTotal），回调也按法币金额核对，两侧同源。
    const result = await epusdtGateway.createPayment(
      {
        orderCode: order.code,
        amount: total,
        currency: "cny",
        subject: `aura ${order.planName}`,
        siteUrl: settings.siteUrl,
        orderId: order.id,
      },
      { ...epusdtEndpoint(settings), secret: process.env.EPUSDT_SECRET?.trim() || "" },
    );
    // 发起支付也要留痕：create 事件记跳转地址与 trade_id。
    // 客服排查"这单点了支付但没反应"时，这是第一条线索；
    // 丢单后也靠这个 trade_id 去 /pay/check-status 主动查单兜底。
    await recordTx({
      orderId: order.id, gateway: "epusdt", event: "create", status: "pending",
      tradeNo: result.tradeNo, amount: total, currency: "cny",
      payload: sanitizePayload({ redirectUrl: result.redirectUrl }),
    });
    return { available: true, method, total, checkoutUrl: result.redirectUrl };
  }
  if (method === "binance") {
    // 币安按 USDT 计价，而订单记的是人民币。折算必须用**下单时锁定**的
    // usdtAmount —— 汇率是下单那一刻定的，用当前汇率会让买家看到的价格
    // 与他实际需要付的钱不一致。
    const usdt = order.usdtAmount ?? toUsdt(total, settings.exchangeRate);
    const result = await binanceGateway.createPayment({
      orderCode: order.code,
      amount: usdt,
      currency: "usdt",
      subject: `aura ${order.planName}`,
      siteUrl: settings.siteUrl,
      orderId: order.id,
    });
    // 发起支付也要留痕：create 事件记跳转地址与 prepayId，
    // 客服排查"这单点了支付但没反应"时，这是第一条线索。
    await recordTx({
      orderId: order.id, gateway: "binance", event: "create", status: "pending",
      tradeNo: result.tradeNo, amount: usdt, currency: "usdt",
      payload: sanitizePayload({ redirectUrl: result.redirectUrl }),
    });
    if (!result.redirectUrl) {
      // 币安没给收银台地址就是创建失败。不能返回 available:true 让买家
      // 看到一个空按钮——那会变成"点了没反应"的客服工单。
      return { available: false, method, message: "币安收银台创建失败，请稍后重试或改用其它支付方式。订单已保存，当前无需付款。" };
    }
    return { available: true, method, total, usdtAmount: usdt, checkoutUrl: result.redirectUrl };
  }
  const siteUrl = settings.siteUrl.replace(/\/$/, "");
  const params: Record<string, string> = {
    app_id: settings.alipayAppId,
    method: "alipay.trade.page.pay",
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "),
    version: "1.0",
    notify_url: `${siteUrl}/api/payments/alipay/notify`,
    return_url: `${siteUrl}/orders/${order.id}/result`,
    // total_amount 必须是「实付」而不是商品价：含手续费，否则支付宝实收与订单金额对不上。
    biz_content: JSON.stringify({ out_trade_no: order.code, total_amount: total, subject: `aura ${order.planName}`, product_code: "FAST_INSTANT_TRADE_PAY" }),
  };
  params.sign = createSign("RSA-SHA256").update(canonical(params)).sign(pem(process.env.ALIPAY_PRIVATE_KEY!, "PRIVATE"), "base64");
  return { available: true, method, checkoutUrl: `${settings.alipayGateway}?${new URLSearchParams(params)}` };
}
export function verifyAlipay(params: Record<string, string>, settings: PaymentSettings) {
  if (!params.sign || params.sign_type !== "RSA2" || params.app_id !== settings.alipayAppId || params.seller_id !== settings.alipaySellerId) return false;
  // 时效校验：没有这一条，一份历史合法通知（备份、网关对账文件、任何一次抓包）
  // 都能被无限期重放。唯一的刹车是 orders.transaction_id，但对从未收到过回调、
  // 或由运营手工确认到账（后台不写 transactionId）的订单，那一列是 NULL，重放会
  // 把一笔发生在任意过去的付款"补"到今天，并覆盖 paid_at。
  // USDT 通道一直有 300 秒时间窗（usdt/confirm/route.ts），这里补齐。
  const notifyTime = Date.parse(params.notify_time || "");
  if (!Number.isFinite(notifyTime) || Math.abs(Date.now() - notifyTime) > ALIPAY_NOTIFY_WINDOW_MS) return false;
  try { return createVerify("RSA-SHA256").update(canonical(params)).verify(pem(settings.alipayPublicKey, "PUBLIC"), params.sign, "base64"); } catch { return false; }
}
/**
 * 入账结果。
 *
 * 此前 markPaid 返回 boolean，把四种**后果完全不同**的情况压成同一个 false，
 * 三个回调端点又统一翻译成 `TxDetail.amountMismatch`——那是给"伪造回调"用的
 * 告警分类。后果：重复扣款被记成伪造签名、过期到账被记成金额不符，
 * 真实问题淹没在误报里。现在每种情况有独立取值，调用方可以分别处置。
 */
export type MarkPaidResult =
  /** 成功入账，订单已推进为 paid。 */
  | "paid"
  /** 同一交易号重复通知，幂等命中，无需再做任何事。 */
  | "duplicate"
  /** 订单已用**另一个**交易号入账。这一笔钱无法自动归属，必须人工核对。 */
  | "duplicate_payment"
  /** 订单已过支付时限但收到了钱。钱已确认到账，订单仍需人工推进。 */
  | "received_after_expiry"
  /** 订单已取消后收到钱。同样需人工核对。 */
  | "received_after_cancel"
  /** 订单不存在，或支付方式与订单不符。 */
  | "order_mismatch"
  /** 金额、收款地址等业务校验不通过——这才是真正的"伪造/错付"。 */
  | "amount_mismatch"
  /** CAS 未命中：并发下订单状态刚被别的请求改掉，本次未落库。 */
  | "conflict";

/** 入账成功（含幂等命中）。用于"钱确实收到了"这一个判断。 */
export function isApplied(result: MarkPaidResult): boolean {
  return result === "paid" || result === "duplicate";
}

/** 需要人工介入核对的情况。 */
export function needsManualReview(result: MarkPaidResult): boolean {
  return result === "received_after_expiry" || result === "received_after_cancel" || result === "duplicate_payment";
}

export async function markPaid(id: string, transactionId: string, method: string, verify: (order: Order) => boolean): Promise<MarkPaidResult> {
  return db.transaction(async tx => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
    if (!order || order.paymentMethod !== method) return "order_mismatch";
    // 先判幂等再判金额：已经入过账的订单不该再被"金额不符"二次打扰，
    // 否则买家重复付款时会被误报成伪造回调。
    if (order.transactionId) {
      return order.transactionId === transactionId ? "duplicate" : "duplicate_payment";
    }
    if (!verify(order)) return "amount_mismatch";

    const now = new Date();
    // 过期判定必须与 pricing.isExpired 同源。此前这里自己写了一套且**不看
    // status**，导致 paid / expired / cdk 兑换单收到合法回调时 expired 恒为
    // true——"已付款被重复入账"与"过期订单收到钱"在流水里长得一模一样。
    const expired = order.status === "pending" && !!order.expiresAt && order.expiresAt.getTime() <= now.getTime();
    const afterCancel = order.status === "cancelled";
    // 卡密可能已按过期释放给下一位买家，因此过期/取消后到账**不自动置 paid**，
    // 转人工核对。但钱确实收到了，交易号与付款时刻必须落库。
    const note = expired
      ? "订单已过支付时限但收到款项，已转入人工核对队列，请勿重复付款。"
      : afterCancel
        ? "订单取消后收到付款，已转入人工核对队列，请勿重复付款。"
        : order.note;
    const applied = await tx
      .update(orders)
      .set({
        transactionId,
        status: ["pending", "cancelled"].includes(order.status) && !expired ? "paid" : order.status,
        // paidAt 与 note 都**仅在为空时写入**。此前是无条件覆盖：运营手工确认
        // 到账后再来一条合法回调，付款时刻会被改写成回调时刻，按 paid_at 做
        // 日结的报表会错；运营写的处理说明（如"已退款"）也会被静默销毁。
        paidAt: order.paidAt ?? now,
        note,
        updatedAt: now,
      })
      // CAS：只命中状态未变的行。行锁已经保证了串行化，这里是最后一道闸门。
      .where(and(eq(orders.id, id), eq(orders.status, order.status)));
    // 此前丢弃了 rowCount 无条件 return true，一旦 CAS 未命中就是静默吞款：
    // 状态没变、接口回 200、流水却记 succeeded。这里必须判。
    if (applied.rowCount !== 1) return "conflict";
    return expired ? "received_after_expiry" : afterCancel ? "received_after_cancel" : "paid";
  });
}

