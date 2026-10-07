import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { cardKeys, orders, plans } from "@/db/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { ONLINE_BATCH } from "@/lib/cdk";
import { getPaymentSettings } from "@/lib/catalog";
import { channelRateOf } from "@/lib/payments/registry";
import { orderExpiry, priceBreakdown, toUsdt } from "@/lib/catalog";
import { checkCoupon, consumeCoupon, normalizeCoupon } from "@/lib/promo";
import { digest, strongAdminPassword, hashPassword } from "@/lib/auth";
import { rateLimitResult, sameOrigin, validEmail, currentUser } from "@/lib/auth";
import { readJson, newOrderCode, logger, apiError, json, traceId, ErrorCode } from "@/lib/core";
import type { ErrorCodeValue } from "@/lib/core";
import { getUpstreamSettings } from "@/lib/recharge/upstream";
import { isRechargeablePlan } from "@/lib/recharge/upstream/aisub";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  // 限流：失败时把真实窗口剩余秒写进 Retry-After（语义同 GitHub X-RateLimit-Reset），
  // 让买家知道"大约还要等多久"，而不是一律猜 60 秒盲目重试。
  {
    const rl = rateLimitResult(request, "create-order", 8);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "下单频率过快，请一分钟后再试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const body = await readJson(request);
  if (!body) return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  try {
    // 暂停接单是最外层的闸门：先看开关，再看订单内容。已有订单的买家仍可查单与完成
    // 到账确认——只挡新单，否则等于把钱收了却不给履约。
    const settings = await getPaymentSettings();
    if (!settings.storeOpen) {
      // 503 是会被缓存的响应（浏览器 / CDN / 部分代理）。当前 Nginx 的
      // `location ^~ /api/` 已强制下发 no-store，故生产部署下不会真的被缓存；
      // 但应用层不应依赖反向代理的兜底——直连 Node、换部署方式或将来加一层
      // CDN 时这条就会失效。因此这里显式经 json()（默认注入 no-store）。
      //
      // 更直接的理由：同路由其它错误都带 code 与 traceId，唯独这条没有，
      // 客服拿到"停止接单"的截图无法对齐到任何一行日志。
      //
      // 不用 apiError 的原因：它只输出 {error, code, traceId}，放不下 paused 这个
      // 业务字段。这里显式用 json() 构造，既保住 paused（保留向前兼容，
      // 当前前端实际从 /api/public/notice 的 storeOpen 派生暂停态，未读此字段），
      // 又把 code / traceId / no-store 补齐。
      const id = traceId();
      return json(
        {
          error: settings.pausedReason || "站点暂时停止接单，请稍后再来。已有订单不受影响，可继续查询与支付。",
          code: ErrorCode.STORE_CLOSED,
          traceId: id,
          paused: true,
        },
        { status: 503, headers: { "X-Trace-Id": id } },
      );
    }

    const email = String(body.email || "").trim().toLowerCase();
    const paymentMethod = String(body.paymentMethod || "");
    if (!validEmail(email) || !["usdt", "alipay", "epay", "epusdt", "binance"].includes(paymentMethod) || body.accepted !== true || typeof body.planId !== "string") return apiError(ErrorCode.VALIDATION_FAILED, "请检查账号邮箱、支付方式并同意服务条款", 400);

    // ---- 购买邮箱与取卡密码 ----
    //
    // `email`（上面的）是**激活邮箱**：买家在 ChatGPT 等平台注册的、要充值的那个账号。
    // `purchaseEmail` 是买家在本站用于查订单的邮箱，默认与激活邮箱相同；
    // 不同的话，个人中心按购买邮箱也能看到这笔单。
    //
    // `cardPassword` 是**取卡密码**：凭「购买邮箱 + 该密码」即可查历史、发卡，
    // 不必注册本站账号—— 这与 Dujiao（shop.aisub.online 同源系统）的
    // `email + order_password` 访客模型完全一致。
    //
    // 【访客必填、登录用户免填】
    // 访客没有账号，付款后除了一次性取卡码（只展示一次、错过即丢）之外
    // 再无任何找回途径。若这里允许留空，等于默认把绝大多数访客推进
    //「付了钱却再也查不回订单」的处境。登录用户则完全不需要它——
    // 会话本身就是凭据，凭会话可查全部历史、凭取卡码可领卡。
    //
    // 强度用 scrypt（与账号密码同一套），与 strongAdminPassword 同一强度下限，
    // 摘要永不外泄。
    const account = await currentUser();
    const purchaseEmail = String(body.purchaseEmail || "").trim().toLowerCase() || email;
    if (!validEmail(purchaseEmail)) return apiError(ErrorCode.VALIDATION_FAILED, "购买邮箱格式不正确", 400);
    const rawPassword = typeof body.cardPassword === "string" ? body.cardPassword.trim() : "";
    if (!account && !rawPassword) {
      return apiError(ErrorCode.VALIDATION_FAILED, "请设置取卡密码：凭「购买邮箱 + 取卡密码」即可随时查回订单与领取卡密，无需注册账号", 400);
    }
    if (rawPassword && !strongAdminPassword(rawPassword, purchaseEmail.split("@")[0])) {
      return apiError(ErrorCode.VALIDATION_FAILED, "取卡密码至少 12 位，且不能是常见弱口令、重复字符或包含邮箱前缀", 400);
    }
    // 上游是否启用。只有启用时才需要拦住"没有上游映射"的套餐：
    // 上游关闭时全站本来就无法自动充值，此时拦不拦没有区别，
    // 拦了反而会让运营在还没配好上游时连测试单都下不了。
    const upstreamEnabled = (await getUpstreamSettings()).enabled;

    // 必须连 deletedAt 一起判。只判 active 的话，软删除（打标记隐藏）过的套餐
    // 仍然能被直接 POST 下单——运营在后台"删掉"了一个套餐，买家只要记得它的 id
    // 就能下单，前台看不见不等于接口拦住。
    const [plan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.id, body.planId), isNull(plans.deletedAt)));
    if (!plan) return apiError(ErrorCode.NOT_FOUND, "该套餐不存在，请重新选择", 400);
    // 下架与售罄必须在服务端拦住。首页按钮已禁用，但接口要自己判断——任何人都能直接
    // POST 绕过前端。Dujiao 也踩过"下架商品仍可购买"这个坑，这里逐条给出原因。
    if (!plan.active) return apiError(ErrorCode.SOLD_OUT, "该套餐已下架，请选择其他套餐", 400);
    // 售罄**不在**这里判，而是在下单事务内按 card_keys 实时计数判（见下方 created）。
    // 此前这里调 isPurchasable(plan)：plan 是裸查出来的 plans 行，没有 stockInfo 字段，
    // remaining 恒为 null → 恒返回 true → 限量套餐可以被无限下单收款。
    // 缓存口径（getPlans 的 remaining，60 秒 TTL）同样不能用于扣减决策：
    // 两个买家同时读到"还剩 1 份"会一起下单成功。
    // 能否自动充值，必须在下单前拦。
    //
    // 此前这里不管，于是 claude / grok / gemini 六个套餐 + chatgpt-yearly
    // 全都能下单、能付款、能发卡密——但上游 aisub 根本没有这些套餐，
    // 买家付完钱到提交页才看到"该套餐暂不可用"，而卡密已经发了、系统已经扣了，
    // 只能走退款。8/10 个套餐都是这样。
    //
    // 拦截点必须在服务端：前端把按钮禁用只是体验，任何人都能直接 POST 绕过。
    if (upstreamEnabled && !isRechargeablePlan(plan.id)) {
      return apiError(ErrorCode.NOT_CONFIGURED, "该套餐暂不支持自动充值，请联系客服处理", 400);
    }
    if (paymentMethod === "usdt" && !settings.usdtEnabled) return apiError(ErrorCode.NOT_CONFIGURED, "USDT 收款通道未开启，请选择其他支付方式", 400);
    if (paymentMethod === "alipay" && !settings.alipayEnabled) return apiError(ErrorCode.NOT_CONFIGURED, "支付宝收款通道未开启，请选择其他支付方式", 400);
    if (paymentMethod === "epay" && !settings.epayEnabled) return apiError(ErrorCode.NOT_CONFIGURED, "收银台通道未开启，请选择其他支付方式", 400);
    if (paymentMethod === "epusdt" && !settings.epusdtEnabled) return apiError(ErrorCode.NOT_CONFIGURED, "USDT 自建收银台通道未开启，请选择其他支付方式", 400);
    if (paymentMethod === "binance" && !settings.binanceEnabled) return apiError(ErrorCode.NOT_CONFIGURED, "币安支付通道未开启，请选择其他支付方式", 400);

    // 手续费与实付一次算清。USDT 换算必须用实付，否则会少收手续费。
    // 传通道费率：运营填的标价是"扣完通道费后实收"，买家应付由系统反算。
    // 不传这一项会按标价直收，运营每单被通道抽走 0.6% 却毫无察觉。
    const bill = priceBreakdown(plan.price, plan.feeRate, await channelRateOf(paymentMethod));

    // 优惠券：在事务里校验 + 占用 + 建单，保证"限用次数"在并发下不会被突破。
    // 券码只当作查找线索，抵扣金额由服务端算完写进订单，之后改券规则不影响历史订单。
    const couponCode = String(body.couponCode || "").trim();
    // 显式声明返回类型：错误分支必须带自己的错误码，靠 TS 从多个 return 里推断
    // 会得到"可能 undefined"的 code，进而让下面的 apiError 挑不到码。
    type CreateOutcome =
      | { error: string; code: ErrorCodeValue }
      | { order: { id: string; code: string; deliveryToken: string }; total: string };
    const created = await db.transaction(async (tx): Promise<CreateOutcome> => {
      // 库存的真实口径是 card_keys 里 online 批次的张数（每下一单发一张）。
      // 必须在**事务内**数：事务外的查询与这里的 INSERT 不在同一快照里，
      // 并发下单时各自都数到"还差一张"，限量套餐就会被超卖。
      if (plan.delivery === "cdk" && plan.stock !== null) {
        const [issued] = await tx
          .select({ n: count() })
          .from(cardKeys)
          .where(and(eq(cardKeys.planId, plan.id), eq(cardKeys.batch, ONLINE_BATCH)));
        if (Number(issued?.n ?? 0) >= plan.stock) {
          return { error: "该套餐卡密已售罄，请选择其他套餐", code: ErrorCode.SOLD_OUT };
        }
      }
      let discount = "0.00";
      let couponHash: string | null = null;
      if (couponCode) {
        // 传 tx：事务内绝不能退回模块级的 db（连接池自我死锁，见 coupons.ts 文件头第 4 条）。
        const check = await checkCoupon(couponCode, email, bill.total, tx);
        if (!check.ok) return { error: check.reason, code: ErrorCode.CONFLICT_STATE };
        const ok = await consumeCoupon(tx, couponCode, email);
        // 校验通过但占用失败 = 并发下刚被别人用光，必须拒绝而不是 silently 忽略。
        // 现在这一句同时覆盖两种并发：总次数用光，或**该邮箱的每人限次**用光。
        if (!ok) return { error: "该券刚刚被用完，请移除券码或换一张", code: ErrorCode.CONFLICT_STATE };
        discount = check.discountAmount;
        couponHash = digest(normalizeCoupon(couponCode));
      }
      // 手续费按"券后金额"计还是按商品价计？按商品价计：手续费是支付通道成本，
      // 与买家用了多少券无关。这样运营不会因为发券而倒贴手续费。
      const total = (Number(bill.total) - Number(discount)).toFixed(2);
      // 取卡码用 192 bit 随机。一次失败可让买家重来，但暴力枚举不可能。
      const deliveryToken = randomBytes(24).toString("base64url");
      if (Number(total) <= 0) return { error: "优惠券抵扣后金额需大于 0", code: ErrorCode.VALIDATION_FAILED };
      const [row] = await tx.insert(orders).values({
        // 一次性取卡码：买家凭「订单号 + 取卡码」取卡密。只存 sha256 摘要，
        // 明文仅此一次返回，之后站点无法再取出（与卡密明文同一原则）。
        deliveryTokenHash: digest(deliveryToken),
        code: newOrderCode(),
        planId: plan.id, planName: plan.name, brand: plan.brand, period: plan.period,
        amount: bill.price, feeAmount: bill.feeAmount, discountAmount: discount, couponCode: couponHash,
        email, paymentMethod,
        // 购买邮箱与取卡密码摘要。留空则 purchaseEmail 回落激活邮箱（=原行为），
        // cardPasswordHash 为 null 表示只能用一次性取卡码取卡。
        purchaseEmail,
        cardPasswordHash: rawPassword ? hashPassword(rawPassword) : null,
        // usdtAmount 只对「本站直接给 USDT 收款地址」的两条通道有意义：
        // usdt（TRC20 直充）与 binance（按 USDT 计价）。
        // epusdt 刻意**不写**：它接收的是法币金额并在自己的侧折算，
        // 本站回调也按 orderTotal 核对，两侧同源。写一个本站并不使用的
        // usdtAmount 反而会让人误以为该值参与 epusdt 的金额核对。
        usdtAmount: (paymentMethod === "usdt" || paymentMethod === "binance") ? toUsdt(total, settings.exchangeRate) : null,
        walletAddress: paymentMethod === "usdt" ? settings.walletAddress || null : null,
        // 下单即冻结支付截止时间。买家不付时订单由清理任务关闭，
        // 不会永远占着"待支付"这个有业务含义的状态。
        expiresAt: orderExpiry(),
      }).returning({ id: orders.id, code: orders.code });
      // 取卡码的明文只在这里出现一次：库里只有摘要，返回后本站再也取不出来。
      // 前端必须立刻存下来（localStorage），否则买家刷新后就取不到卡密了。
      return { order: { ...row, deliveryToken }, total };
    });
    // 错误码必须逐分支带出来：把"售罄"也归并成 CONFLICT_STATE 的话，
    // 前端会提示"请稍后重试"，买家于是反复重试一个永远不成功的套餐。
    if ("error" in created) return apiError(created.code, created.error ?? "订单未能创建，请稍后重试", 400);

    // The payload contains the private order link: keep it out of any intermediate cache.
    return NextResponse.json(created.order, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("order.creation_failed", {}, error);
    return apiError(ErrorCode.INTERNAL, "订单暂时未能创建，请稍后重试", 500);
  }
}
