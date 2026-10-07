import { ok, apiError, ErrorCode } from "@/lib/core";
import { checkPassword, digest, rateLimitResult, sameOrigin, safeEqual, validUuid } from "@/lib/auth";
import { db } from "@/db";
import { orders, plans, cardKeys } from "@/db/schema";
import { eq } from "drizzle-orm";
import { issueCardKeyForOrder } from "@/lib/cdk";
import { invalidatePlansCache, FULFILLABLE_STATUSES, FULFILLMENT_BLOCKED_STATUSES } from "@/lib/catalog";
import { logger } from "@/lib/core";

// 卡密交付：买家付款后，在结果页首次打开时实时生成卡密并把明文返回一次。
// 再次请求只会得到 kind: "issued"，因为明文没有落库，服务端也拿不回来。
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  // 限流：真实窗口剩余秒写进 Retry-After，让买家知道大约要等多久。
  {
    const rl = rateLimitResult(request, "order-delivery", 20);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "请求过于频繁，请稍后重试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }

  const { id } = await context.params;
  if (!validUuid(id)) return apiError(ErrorCode.NOT_FOUND, "订单不存在", 404);

  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) return apiError(ErrorCode.NOT_FOUND, "订单不存在", 404);

  // 归属校验：**凭一次性取卡码，或下单时设置的取卡密码**。
  //
  // 为什么必须这样：取卡码是本项目最致命的攻击面——
  // 本站注册只需 email + password，**无任何邮箱所有权验证**。攻击者只要知道
  // 受害者邮箱（下单必填，等于半公开）就能注册该邮箱并拿到会话；之后
  // currentUser().email === order.email 成立，个人中心又把他名下全部历史订单
  // 列出来。若归属判定依赖邮箱/登录态，攻击者逐单即可取走所有卡密——
  // 一次注册 = 一次账号接管。
  //
  // 两条通过路径，缺一不可：
  //   1. **一次性取卡码**（原有行为，完全不变）：192 bit 随机，下单成功时展示一次。
  //   2. **取卡密码**（新增，可选）：买家下单时自己设置的，只有本人知道。
  //      密码用 scrypt 存储、scrypt 校验（异步，不阻塞事件循环），
  //      因此它比邮箱**更难被枚举**——邮箱是公开信息，密码不是。
  //
  // 注意：持卡码的人不必知道邮箱；持密码的人也不必知道卡码。二者独立。
  // 任一成立即放行，且两者都失败时统一返回同一句提示，不告诉对方"密码对了但卡码错了"。
  const token = (new URL(request.url).searchParams.get("token") || "").trim();
  const password = (new URL(request.url).searchParams.get("password") || "").trim();
  const hasToken = !!token && !!order.deliveryTokenHash && safeEqual(digest(token), order.deliveryTokenHash);
  // 密码校验是**昂贵操作**（scrypt 约 100ms），因此只在没有取卡码、且订单确实
  // 设了密码时才做。取卡码已通过或订单压根没设密码时，一次 scrypt 都不跑。
  let hasPassword = false;
  if (!hasToken && password && order.cardPasswordHash) {
    hasPassword = await checkPassword(password, order.cardPasswordHash);
    if (!hasPassword) {
      logger.audit("order.card_password_mismatch", { order: order.code });
    }
  }
  if (!hasToken && !hasPassword) {
    // 统一提示：不区分"卡码错"与"密码错"，避免逐位试探。
    // 凭据错误（取卡码/取卡密码不对）属于 AUTH_INVALID，不是 FORBIDDEN_ROLE——
    // 后者语义是"角色权限不足"（RBAC 场景）。若前端按 FORBIDDEN_ROLE 提示
    // "请用管理员账号登录"，会把访客引向完全错误的方向。状态码仍保持 403 不变。
    return apiError(ErrorCode.AUTH_INVALID, "取卡码或取卡密码不正确，无法领取卡密", 403);
  }

  // 未付款不发卡密。
  // 白名单来自 statusFlow 的可达终态，而不是各自硬编码——此前这里与
  // reissueCardKeyForOrder、ACTIVATABLE_ORDER_STATUS 各写一份，三处不一致
  // 导致"过期后到账"的订单：markPaid 正确地保留 expired 状态并转人工，
  // 但这里不放行 → 买家付了钱既拿不到卡、后台补发按钮也明确拒绝，只能人工改库。
  // 退款后绝不能继续交付。此前系统没有 refunded 状态，运营遇到退款/拒付时
  // 只能把订单留在 paid，于是交付闸门照常放行 —— **退款后买家仍能领卡**。
  if ((FULFILLMENT_BLOCKED_STATUSES as readonly string[]).includes(order.status)) return ok({ kind: "none" });
  if (!(FULFILLABLE_STATUSES as readonly string[]).includes(order.status)) return ok({ kind: "none" });

  // ---- 到账证据：状态白名单拦不住"压根没付钱"的订单 --------------------------
  //
  // 状态列无法区分这两种情况（它们的 status 都是 cancelled / expired）：
  //   · 买家下单后自助取消（或 30 分钟未付自动过期）→ **没付过钱**
  //   · 取消/过期之后钱才到账（markPaid 保留状态并转人工）→ **付过钱**
  // 白名单保留 expired/cancelled 正是为了放行第二种，所以必须在这里用
  // transactionId / paidAt 把关：**没有到账证据就绝不发卡**。
  // 少了这一条，任何人「下单 → 自助取消 → 凭取卡码领卡」即可零成本拿走全部卡密套餐。
  //
  // paidAt 与 transactionId 由 markPaid 写入（见 lib/payments/payments.ts），
  // 二者任一存在即为已收款；卡密兑换产生的订单在下面按 paymentMethod 单独处理。
  if (!order.transactionId && !order.paidAt) {
    logger.warn("cdk.delivery_blocked_unpaid", { order: order.code, status: order.status });
    return ok({ kind: "none" });
  }

  const [plan] = await db.select().from(plans).where(eq(plans.id, order.planId));
  if (!plan || plan.delivery !== "cdk") return ok({ kind: "none" });

  // 用卡密兑换出来的订单本身就是买家带来的凭证，不需要也不应该再发一张
  if (order.paymentMethod === "cdk") return ok({ kind: "none" });

  const [existing] = await db.select({ id: cardKeys.id }).from(cardKeys).where(eq(cardKeys.orderId, id)).limit(1);
  if (existing) return ok({ kind: "issued" });

  const result = await issueCardKeyForOrder(id, plan.id);
  if ("code" in result) {
    invalidatePlansCache(); // 在线发放会改变套餐"已发放"计数，库存口径随之变化
    logger.audit("cdk.issued_for_order", { order: order.code, plan: plan.id });
    return ok({ kind: "new", code: result.code, planName: plan.name });
  }
  // already_issued：并发下另一个请求刚发完这张订单的卡密，按"已发放"返回；
  // unavailable 不会走到这里（前面已校验过套餐存在且是卡密交付）。
  return ok({ kind: result.reason === "sold_out" ? "sold_out" : "issued" });
}
