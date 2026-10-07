import { NextResponse } from "next/server";
import { adminAccess } from "@/lib/admin/access";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { rechargeJobs, upstreamConfig } from "@/db/schema";
import { currentAdmin, rateLimit, sameOrigin } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";
import { invalidateUpstreamCache, saveUpstreamConfig, AisubAdapter, UPSTREAM_PROVIDERS } from "@/lib/recharge";
import { REQUIRED_UPSTREAM_ENV } from "@/lib/recharge/upstream/aisub";
import { assertSafeUpstreamUrl, UPSTREAM_URL_REJECTED } from "@/lib/recharge/upstream/url-guard";
import { advanceJob } from "@/lib/recharge";
import { logger } from "@/lib/core";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status = 400) =>
  apiError(code, error, status, NO_STORE);

/**
 * 上游配置与充值任务管理。
 *
 * 返回给后台的字段也是白名单：credentialCipher / secretCipher 绝不返回，
 * 连后台也不给——排障只需要知道"有没有凭证"，不需要看到凭证本身。
 */
export async function GET(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!rateLimit(request, "admin-api", 120)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  if (!(await currentAdmin())) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);

  const [config] = await db.select().from(upstreamConfig).where(eq(upstreamConfig.id, 1)).limit(1);
  const jobs = await db
    .select({
      id: rechargeJobs.id,
      code: rechargeJobs.code,
      planName: rechargeJobs.planName,
      email: rechargeJobs.email,
      status: rechargeJobs.status,
      upstreamOrder: rechargeJobs.upstreamOrder,
      // 只告知"是否还持有凭证"，不给内容。排查时这就够了。
      //
      // 此前这里写的是 `hasCredential: rechargeJobs.credentialCipher`，把**密文
      // 本体**查出来再在下面用 `!!` 转成布尔 —— 结果正确，但密文一度进了内存与
      // 中间对象；只要将来谁在中间多打一行日志或多加一次展开，它就出去了。
      // 凭证禁令的原则是"不取回"，不是"取回来再丢掉"，因此在 SQL 层就折叠掉。
      hasCredential: sql<boolean>`${rechargeJobs.credentialCipher} is not null`,
      resultNote: rechargeJobs.resultNote,
      failureReason: rechargeJobs.failureReason,
      createdAt: rechargeJobs.createdAt,
      updatedAt: rechargeJobs.updatedAt,
    })
    .from(rechargeJobs)
    .orderBy(desc(rechargeJobs.createdAt))
    .limit(100);

  return NextResponse.json({
    config: config
      ? {
          enabled: config.enabled,
          provider: config.provider,
          baseUrl: config.baseUrl,
          appId: config.appId,
          timeoutSeconds: config.timeoutSeconds,
          pollIntervalSeconds: config.pollIntervalSeconds,
          credentialTtlMinutes: config.credentialTtlMinutes,
          dailyLimitPerEmail: config.dailyLimitPerEmail,
        }
      : null,
    // 密钥只报告"配没配"，值永远不下发（包括给后台）。
    secretConfigured: !!process.env.UPSTREAM_SECRET,
    credentialKeyConfigured: !!process.env.CREDENTIAL_KEY,
    jobs: jobs.map((job) => ({
      ...job,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    })),
  }, { headers: NO_STORE });
}

export async function PATCH(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  if (!rateLimit(request, "admin-api", 60)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  const admin = await currentAdmin();
  if (!admin) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
  const body = await readJson(request);
  if (!body) return fail(ErrorCode.VALIDATION_FAILED, "请求内容无效");

  const action = String(body.action || "");

  // 手动推进某个任务：用于上游长时间无响应时人工催一下。
  if (action === "advance") {
    const id = String(body.id || "");
    if (!id) return fail(ErrorCode.NOT_FOUND, "任务不存在");
    const result = await advanceJob(id);
    logger.audit("recharge.manual_advance", { id, result: result.status, by: admin.username });
    return NextResponse.json({ success: true, status: result.status }, { headers: NO_STORE });
  }

  if (action !== "config") return fail(ErrorCode.VALIDATION_FAILED, "未知操作");

  const provider = String(body.provider || "mock");
  // 用 some 而非 includes：UPSTREAM_PROVIDERS 是 as const 元组，
  // 它的 includes 签名要求参数是字面量联合，传普通 string 会类型报错。
  if (!UPSTREAM_PROVIDERS.some((item) => item === provider)) return fail(ErrorCode.VALIDATION_FAILED, "上游类型无效");
  // 生产环境禁用 mock 上游。支付网关的 mock 早就有这道硬闸门
  // （registry.ts 的 assertNotMockInProduction），而上游侧此前**没有对等保护**：
  // 把 provider 切成 mock 并启用后，所有进行中的充值任务会在几次轮询后被
  // mockAdapter 无条件判为 succeeded，买家看到"充值完成"而账号从未开通。
  // 这是全站级的假成功，比任何单笔订单的问题都严重。
  // 这里做成硬闸门而非配置开关——不给人忘记关的机会。
  if (provider === "mock" && process.env.NODE_ENV === "production") {
    return fail(ErrorCode.UPSTREAM_DISABLED, "生产环境不允许使用模拟上游，会导致买家看到虚假的充值成功", 400);
  }
  const baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
  // 上游地址由运营自由填写，而服务器会去访问它。仅校验协议等于开了内网探测器
  // 与数据外泄管道（云元数据、内网服务、以及把 UPSTREAM_SECRET 与买家凭证
  // 发给攻击者的服务器）。详见 url-guard.ts 的说明。
  if (baseUrl && !assertSafeUpstreamUrl(baseUrl)) return fail(ErrorCode.VALIDATION_FAILED, UPSTREAM_URL_REJECTED);
  const timeoutSeconds = Number(body.timeoutSeconds ?? 900);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 86400) return fail(ErrorCode.VALIDATION_FAILED, "超时需在 30-86400 秒之间");
  const pollIntervalSeconds = Number(body.pollIntervalSeconds ?? 90);
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 30 || pollIntervalSeconds > 600) return fail(ErrorCode.VALIDATION_FAILED, "轮询间隔需在 30-600 秒之间（下限 30 秒是为了不把上游打成高频访问）");
  const credentialTtlMinutes = Number(body.credentialTtlMinutes ?? 30);
  if (!Number.isInteger(credentialTtlMinutes) || credentialTtlMinutes < 1 || credentialTtlMinutes > 1440) return fail(ErrorCode.VALIDATION_FAILED, "凭证保留时长需在 1-1440 分钟之间");
  const dailyLimitPerEmail = Number(body.dailyLimitPerEmail ?? 0);
  if (!Number.isInteger(dailyLimitPerEmail) || dailyLimitPerEmail < 0 || dailyLimitPerEmail > 999) return fail(ErrorCode.VALIDATION_FAILED, "单账号每日限次需为 0-999 的整数");
  const enabled = body.enabled === true;
  const appId = String(body.appId || "").trim();

  if (enabled && provider === "http") {
    if (!baseUrl) return fail(ErrorCode.VALIDATION_FAILED, "启用 HTTP 上游前请填写地址");
    if (!process.env.UPSTREAM_SECRET) return fail(ErrorCode.NOT_CONFIGURED, "请先在服务器配置 UPSTREAM_SECRET 再启用");
    if (!process.env.CREDENTIAL_KEY) return fail(ErrorCode.NOT_CONFIGURED, "请先在服务器配置 CREDENTIAL_KEY 再启用");
  }
  // aisub 走公开 HTTPS 接口 + 本站自带的加密凭证，不需要 UPSTREAM_SECRET
  // （那是通用 http 适配器的签名密钥）。这里只校验地址与连通性前置条件：
  // 启用前先探一次 runtime，对方停接单时不该让运营"启用成功"才发现不能用。
  //
  // 【为什么要先查契约环境变量】
  // 上游的接口路径与字段名是私有契约，全部来自服务器环境变量（不写进代码，
  // 否则任何拿到仓库的人都能绕过本站直接打上游）。因此**契约没配齐是最常见
  // 的启用失败原因**，而它在下面那次探测里表现为「地址不可用」——
  // 文案指向"地址错"，运营会去反复核对一个根本没问题的地址，越查越困惑。
  // 必须在探测之前就给出准确的提示。
  if (enabled && provider === "aisub") {
    if (!baseUrl) return fail(ErrorCode.VALIDATION_FAILED, "启用 aisub 上游前请填写对方地址");
    const missing = REQUIRED_UPSTREAM_ENV.filter((key) => !(process.env[key] || "").trim());
    if (missing.length) {
      return fail(ErrorCode.NOT_CONFIGURED, `服务器尚未配置上游契约，无法启用。请在 .env 中补齐：${missing.join("、")}（这些值属于上游私有接口信息，不入库、不进代码）`);
    }
    const probe = await new AisubAdapter({ provider: "aisub", baseUrl, appId, timeoutSeconds, pollIntervalSeconds }).readRuntime();
    if (!probe.ok) return fail(ErrorCode.UPSTREAM_FAILED, "对方地址不可用或返回异常，请确认地址正确");
    if (probe.maintenance) return fail(ErrorCode.UPSTREAM_DISABLED, `对方当前暂停接单（${probe.maintenanceMessage}），请等其恢复后再启用`);
    if (!probe.plans.length) return fail(ErrorCode.UPSTREAM_FAILED, "未能读取到对方套餐列表，请确认地址正确");
  }

  await saveUpstreamConfig({
    enabled, provider, baseUrl, appId,
    timeoutSeconds, pollIntervalSeconds, credentialTtlMinutes, dailyLimitPerEmail,
  });
  invalidateUpstreamCache();
  logger.audit("upstream.config_saved", { enabled, provider, by: admin.username });
  return NextResponse.json({ success: true }, { headers: NO_STORE });
}
