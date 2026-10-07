import { NextResponse } from "next/server";
import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { orders, rechargeJobs } from "@/db/schema";
import { getPaymentSettings } from "@/lib/catalog";
import { getPublicProgress, submitRecharge } from "@/lib/recharge";
import { rateLimitResult, sameOrigin, validEmail, digest, safeEqual } from "@/lib/auth";
import { readJson } from "@/lib/core";
import { ErrorCode, traceId, apiOk } from "@/lib/core";
import { verifyCredentialForOrder } from "@/lib/recharge";
import { normalizeCredential } from "@/lib/recharge/credential-vault";
import { getUpstream } from "@/lib/recharge";

// 自动充值的对外接口。
//
// 数据隐藏的三条硬规则（贯穿本文件）：
//   1. 响应字段白名单：返回给浏览器的对象都显式列出，绝不 `...spread` 数据库行。
//      上游单号、绑定标识、密文、尝试次数都不在白名单里，因此不可能被泄露。
//   2. 凭证只出现在"提交"这一个请求的 body 里，入库前加密，绝不回显。
//   3. 错误信息一律走"买家能理解"的口径；上游原始错误只进服务端日志。

const NO_STORE = { "Cache-Control": "no-store" } as const;
/**
 * 本路由的错误出口。与 @/lib/core 的 fail 同形，但额外强制带上 code 与 traceId：
 * 充值链路的错误排查强依赖 traceId（用户截图 -> 日志行），没有它就只能靠时间戳猜。
 * error 字段保持不变，现有前端读法不受影响。
 */
const fail = (error: string, status = 400, code?: string, retryAfterSec?: number) => {
  const id = traceId();
  // 429 统一带 Retry-After（RFC 6585；GitHub/Stripe/Cloudflare 惯例）：传 retryAfterSec
  // 时用**真实窗口剩余秒**（由 rateLimitResult 提供，语义同 GitHub 的 X-RateLimit-Reset
  // 换算）；不传则回落固定窗口保守值 60s（固定窗口最大等待 = 一个窗口）。
  const headers =
    status === 429
      ? { ...NO_STORE, "X-Trace-Id": id, "Retry-After": String(retryAfterSec ?? 60) }
      : { ...NO_STORE, "X-Trace-Id": id };
  return NextResponse.json({ error, ...(code ? { code } : {}), traceId: id }, { status, headers });
};

const CREDENTIAL_MAX = 8000;

/** 提交充值：校验账号 → 受理。只返回本站订单号，绝不返回上游任何信息。 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("请求来源无效", 403, ErrorCode.FORBIDDEN_ORIGIN);
  // 限流：拿真实窗口剩余秒写进 Retry-After（语义同 GitHub X-RateLimit-Reset），
  // 买家能知道自己大约要等多久，而不是盲目等满一分钟。
  {
    const rl = rateLimitResult(request, "recharge-submit", 5);
    if (!rl.allowed) return fail("提交过于频繁，请几分钟后再试", 429, ErrorCode.RATE_LIMITED, rl.retryAfterSec);
  }

  const settings = await getPaymentSettings();
  if (!settings.storeOpen) return fail("站点暂时停止接单，请稍后再来。", 503, ErrorCode.STORE_CLOSED);
  const upstream = await getUpstream();
  if (!upstream.enabled) return fail("自动充值暂未开放，请使用下单购买或联系客服。", 503, ErrorCode.UPSTREAM_DISABLED);

  const body = await readJson(request);
  if (!body) return fail("请求内容无效", 400, ErrorCode.VALIDATION_FAILED);

  // ---- 预检：买家点了「下一步」就调这里，拿到的是即时的账号可行性反馈。
  // 为什么要在提交前做：提交会创建任务、锁定套餐、开始消耗上游配额，
  // 不可逆。若账号本身有问题（登录态失效、地区不符、已有 TEAM），
  // 让买家走到第 4 步才发现，等于浪费他的时间也浪费上游的额度。
  // 这一步不落库、不创建任务，纯粹是「先看一眼」。
  if (String(body.action || "") === "verify") {
    {
      const rl = rateLimitResult(request, "recharge-verify", 10);
      if (!rl.allowed) return fail("校验过于频繁，请稍后再试", 429, ErrorCode.RATE_LIMITED, rl.retryAfterSec);
    }
    const orderCodeIn = String(body.orderCode || "").trim().toUpperCase();
    const emailIn = String(body.email || "").trim().toLowerCase();
    const credentialIn = normalizeCredential(String(body.credential || ""));
    if (!validEmail(emailIn)) return fail("请填写有效的账号邮箱", 400, ErrorCode.VALIDATION_FAILED);
    if (!credentialIn) return fail("凭证格式无法识别。请在目标站打开会话接口，复制整段 JSON；也可直接粘贴以 eyJ 开头的 accessToken 或完整 Cookie 串。", 400, ErrorCode.VALIDATION_FAILED);
    // 预检虽然不落库，但它回显「订单号 + 邮箱 + 账号」是否匹配一个已付款订单这一事实，
    // 相当于一个低成本的存在性 oracle：
    //   如不要求取卡码，攻击者只要知道「订单号 + 激活邮箱」就能慢枚举某笔订单的
    //   付款状态、以及该 AI 账号能否在本站被充值。订单号不是机密（进 URL/截图）、
    //   激活邮箱是该订单要充值的账号（半公开），两者都不足以当归属凭据。
    // 因此预检同样强制取卡码，口径与正式提交（下方第 98 行）一致。
    // 此前这里写的是 `if (tokenIn) { ... }` —— token 为空时整段校验被跳过，
    // 与正式提交的强制要求不一致。前端恒传 getDeliveryToken(orderCode)，不受影响。
    const tokenIn = String(body.token || "").trim();
    if (!tokenIn) return fail("请提供取卡码以验证归属", 403, ErrorCode.AUTH_INVALID);
    const [ownerIn] = await db
      .select({ hash: orders.deliveryTokenHash })
      .from(orders)
      .where(eq(orders.code, orderCodeIn))
      .limit(1);
    if (!ownerIn?.hash || !safeEqual(digest(tokenIn), ownerIn.hash)) {
      return fail("取卡码不正确", 403, ErrorCode.AUTH_INVALID);
    }
    const check = await verifyCredentialForOrder(orderCodeIn, emailIn, credentialIn);
    if (!check.ok) return fail(check.reason, check.status, check.code);
    return apiOk({ verified: true, ...check.data });
  }

  const orderCode = String(body.orderCode || "").trim().toUpperCase();
  const email = String(body.email || "").trim().toLowerCase();
  const credential = String(body.credential || "").trim();
  const token = String(body.token || "").trim();
  if (!validEmail(email)) return fail("请填写有效的账号邮箱", 400, ErrorCode.VALIDATION_FAILED);
  if (credential.length < 8 || credential.length > CREDENTIAL_MAX) return fail("请填写账号登录态", 400, ErrorCode.VALIDATION_FAILED);

  // ---- 归属校验：与 GET /api/recharge、POST /api/recharge/advance 同一套判定 ------
  //
  // 这是全站唯一一个「会真实消耗上游成本、会把订单推到 completed」的写接口，
  // 因此**必须**和另外两处一样凭一次性取卡码判定归属，不能只认「订单号 + 邮箱」。
  //
  // 只认邮箱为什么不够：本站注册不做邮箱所有权验证，攻击者用受害者邮箱注册后
  // 即可登录，再经「我的账户」拿到完整订单号（订单号不是机密），
  // 就能把受害者已付款订单的充值开到**攻击者自己的账号**上；
  // 即便上游未启用，也会先建一个任务，使幂等规则挡住受害者本人再来提交
  //（变成不可逆的服务阻断）。
  //
  // 这里复用与 GET 完全相同的比较方式（常量时间 + sha256 比对），
  // 失败文案也保持一致，避免用响应差异去枚举订单是否存在。
  if (!token) return fail("请提供取卡码以验证归属", 403, ErrorCode.AUTH_INVALID);
  const [owner] = await db
    .select({ hash: orders.deliveryTokenHash })
    .from(orders)
    .where(eq(orders.code, orderCode))
    .limit(1);
  if (!owner?.hash || !safeEqual(digest(token), owner.hash)) {
    return fail("取卡码不正确", 403, ErrorCode.AUTH_INVALID);
  }

  // 订单的存在性、付款状态与邮箱归属全部在服务端校验，前端不参与判断。
  // 买家视角只有「订单号 + 邮箱 + 自己的账号登录态」三项，全程无任何卡密字段。
  const created = await submitRecharge({ orderCode, email, credential });
  if (!created.ok) return fail(created.reason, 422, created.reason.includes("付款") ? ErrorCode.ORDER_NOT_PAID : created.reason.includes("已有进行中") ? ErrorCode.ALREADY_SUBMITTED : ErrorCode.VALIDATION_FAILED);

  // 白名单：只回这三个字段。
  return NextResponse.json(
    { code: created.job.code, status: created.job.status, planName: created.job.planName },
    { status: 201, headers: NO_STORE },
  );
}

/** 查进度。查询本身会触发一次推进——自动化就发生在这里，买家无需点任何按钮。 */
export async function GET(request: Request) {
  {
    const rl = rateLimitResult(request, "recharge-query", 30);
    if (!rl.allowed) return fail("查询过于频繁，请稍后再试", 429, ErrorCode.RATE_LIMITED, rl.retryAfterSec);
  }
  const code = (new URL(request.url).searchParams.get("code") || "").trim().toUpperCase();
  if (!code || code.length > 40) return fail("请填写订单号", 400, ErrorCode.VALIDATION_FAILED);

  // 订单号与任务号都能查。买家手上只有付款后的订单号，让他再抄一遍受理后生成的
  // 任务号既多余又容易输错。这里用 or() 同时匹配两者。
  const [job] = await db
    .select({
      id: rechargeJobs.id,
      // 取卡码摘要在 orders 表上（recharge_jobs 没有这一列），因此带出
      // orderCode 供后续到 orders 表比对取卡码。
      status: rechargeJobs.status,
      code: rechargeJobs.code,
      orderCode: rechargeJobs.orderCode,
      email: rechargeJobs.email,
    })
    .from(rechargeJobs)
    .where(or(eq(rechargeJobs.code, code), eq(rechargeJobs.orderCode, code)))
    .limit(1);
  if (!job) return fail("未找到该订单，请核对订单号", 404, ErrorCode.NOT_FOUND);

// 归属校验：凭一次性取卡码，不依赖邮箱或登录态。
  //
  // 本站注册无邮箱所有权验证，因此"登录邮箱匹配"或"提供下单邮箱"都**不能**
  // 作为凭证：攻击者注册他人邮箱后两者都会成立，等于一次注册即可取走全部卡密。
  // 取卡码是唯一攻击者拿不到的那一份信息（只在下单成功时展示一次，站点仅留摘要）。
  const token = (new URL(request.url).searchParams.get("token") || "").trim();
  if (!token || !job.orderCode) return fail("请提供取卡码以验证归属", 403, ErrorCode.AUTH_INVALID);
  const [owner] = await db
    .select({ hash: orders.deliveryTokenHash })
    .from(orders)
    .where(eq(orders.code, job.orderCode))
    .limit(1);
  if (!owner?.hash || !safeEqual(digest(token), owner.hash)) {
    return fail("取卡码不正确", 403, ErrorCode.AUTH_INVALID);
  }

  // 终态判定用 TERMINAL_STAGES 的口径：这里显式列出三个终态（含超时），
  // 与 recharge.ts 的状态机保持一致；漏掉 timed_out 会让已超时的任务被反复推。
  //
  // 推进动作已移到 POST /api/recharge/{code}/advance，不再挂在 GET 上。
  // 一个语义上"只读"的接口带状态推进副作用，有两个实际代价：
  //   1. 前端每次刷新都在改数据，并发窗口被反复命中；
  //   2. 预取、爬虫、浏览器预加载都会意外触发状态流转。
  // 现在由 maintenance 定时任务负责批量推进，页面上的"刷新"按钮显式调
  // advance，两者职责分开。

  // 后续按任务的真实 code 取视图：传入的可能是订单号。
  const view = await getPublicProgress(job.code);
  if (!view) return fail("未找到该订单，请核对订单号", 404, ErrorCode.NOT_FOUND);

  // 白名单：逐字段列出。
  // outcome / done / remainingSeconds 必须显式放行——白名单不会自动带上新字段，
  // 漏掉它们会让前端拿不到四态，退回按内部步骤猜文案。
  return NextResponse.json({
    code: view.code,
    planName: view.planName,
    status: view.status,
    outcome: view.outcome,
    done: view.done,
    remainingSeconds: view.remainingSeconds,
    resultNote: view.resultNote,
    failureReason: view.failureReason,
    updatedAt: view.updatedAt,
    events: view.events,
  }, { headers: NO_STORE });
}
