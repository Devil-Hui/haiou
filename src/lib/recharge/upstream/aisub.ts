import type {
  UpstreamAdapter,
  UpstreamQueryResult,
  UpstreamSettings,
  UpstreamSubmitResult,
  UpstreamValidateResult,
} from "./types";
import { logger } from "@/lib/core";

// ---------------------------------------------------------------------------
// 上游适配器：自动充值渠道。
//
// ---------------------------------------------------------------------------
// 【本文件不含任何上游情报】—— 接口路径、字段名、套餐映射全部来自环境变量。
//
// 为什么这样设计（本文件唯一需要记住的事）：
//   上游的接口契约是**逆向对方前端 bundle 得到的私有情报**，不是公开 API。
//   写死在代码里 = 任何拿到这个仓库的人（clone、开源、被入侵后打包带走）
//   都知道你的上游是谁、接口怎么调、套餐怎么映射，于是可以**绕过本站
//   直接向你的上游提交**。你的站就少掉这部分流量，而且**完全察觉不到**
//   —— 上游不会为此通知你。
//
//   因此这里只保留**流程骨架**（校验 → 提交 → 轮询），所有"情报"外置到环境变量。
//   换一家上游不需要改代码，只需要换环境变量；对外分发源码时不含任何秘密。
//
// 必需环境变量（生产必须配齐；缺任意一项该渠道即不可用，**不设兜底**）：
//   UPSTREAM_RUNTIME_PATH     运行状态接口路径
//   UPSTREAM_VALIDATE_PATH    校验接口路径
//   UPSTREAM_SUBMIT_PATH      提交接口路径
//   UPSTREAM_QUERY_PATH       进度查询路径模板，{key} 会被替换为上游单号
//   UPSTREAM_PLAN_MAP         套餐映射，格式「上游planType:本站planId」逗号分隔
//   UPSTREAM_CDK_FIELD        校验/提交体里卡密的字段名
//   UPSTREAM_CREDENTIAL_FIELD 提交体里买家会话的字段名
//   UPSTREAM_VALIDATE_FIELD   校验结果里"是否有效"的字段名（默认 valid）
//   UPSTREAM_VALIDATE_VALUE   该字段的真值（默认 true）
//   UPSTREAM_PLAN_TYPE_FIELD  校验结果里套餐类型的字段名（默认 planType）
//   UPSTREAM_JOB_FIELD        提交结果里上游单号的字段名
//   UPSTREAM_BINDING_FIELD    提交结果里绑定标识的字段名
//   UPSTREAM_TASK_FIELD       查询结果里任务对象的字段名（默认 task）
//   UPSTREAM_TASK_*_FIELD     task 内的状态/进度/文案/结果字段名
//
// 本文件刻意**不给出这些值的示例**——示例值就是情报本身。
// 运维从上游处取到真实路径后填进 .env，不入库、不进代码、不进版本库。
//
// **没配就是「不可用」**，绝不默默连到别处，也绝不退化成 mock。
// mock 在生产是硬闸门（见 index.ts 与 payments/registry.ts 的双重保险）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 环境变量读取：全部集中在这里，且**缺失即不可用**。
//
// 为什么不给兜底默认值：兜底值等于把情报换个名字又写回代码里，
// 也会制造一种危险的假象——"看起来配好了，其实连的是错的路径"。
// 缺失时返回 null，由调用方转成"渠道不可用"，前台显示
// 「自动充值暂未开放，请使用下单购买或联系客服」，而不是静默假成功。
// ---------------------------------------------------------------------------

type PathSet = {
  runtime: string; validate: string; submit: string;
  /** 查询路径模板，{key} 会被替换为上游单号（已 URL 编码） */
  query: string;
};

/**
 * 启用该渠道前**必须**配齐的环境变量。
 *
 * 导出给后台接口做启用前校验。列在这里而不是让后台硬编码一份：
 * 两侧各写一份必然出现「加了新的必需变量却忘了加进校验」，
 * 表现为运营点「启用」成功、但前台报"暂不可用"，且没有任何线索指向缺配置。
 */
export const REQUIRED_UPSTREAM_ENV = [
  "UPSTREAM_RUNTIME_PATH",
  "UPSTREAM_VALIDATE_PATH",
  "UPSTREAM_SUBMIT_PATH",
  "UPSTREAM_QUERY_PATH",
  "UPSTREAM_PLAN_MAP",
  // 字段名同样属于契约，一并要求显式配置。默认值会把它写回源码，
  // 那等于「变量名换了、内容没换」，公开仓库时毫无保护作用。
  "UPSTREAM_CDK_FIELD",
  "UPSTREAM_SECRET_FIELD",
  "UPSTREAM_CREDENTIAL_FIELD",
  "UPSTREAM_VALIDATE_FIELD",
  "UPSTREAM_VALIDATE_VALUE",
  "UPSTREAM_PLAN_TYPE_FIELD",
  "UPSTREAM_JOB_FIELD",
  "UPSTREAM_BINDING_FIELD",
  "UPSTREAM_TASK_FIELD",
  "UPSTREAM_TASK_STATE_FIELD",
  "UPSTREAM_TASK_PROGRESS_FIELD",
  "UPSTREAM_TASK_VERIFY_FIELD",
  "UPSTREAM_TASK_MESSAGE_FIELD",
  "UPSTREAM_TASK_RESULT_FIELD",
] as const;

function readPathSet(): PathSet | null {
  const get = (k: string) => (process.env[k] || "").trim();
  const paths: PathSet = {
    runtime: get("UPSTREAM_RUNTIME_PATH"),
    validate: get("UPSTREAM_VALIDATE_PATH"),
    submit: get("UPSTREAM_SUBMIT_PATH"),
    query: get("UPSTREAM_QUERY_PATH"),
  };
  // 路径必须以 / 开头。缺前导斜杠会拼出 "https://hostapi/xxx" 这类地址，
  // 表现是 404 而不是报错，属于最难排查的一类失败。
  return Object.values(paths).every((p) => p.startsWith("/")) ? paths : null;
}

type PlanMap = { remoteToLocal: Map<string, string>; localToRemote: Map<string, string> };

function readPlanMap(): PlanMap | null {
  const raw = (process.env.UPSTREAM_PLAN_MAP || "").trim();
  if (!raw) return null;
  const remoteToLocal = new Map<string, string>();
  const localToRemote = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [remote, local] = pair.split(":").map((s) => s.trim());
    if (!remote || !local) continue;
    remoteToLocal.set(remote, local);
    localToRemote.set(local, remote);
  }
  return remoteToLocal.size ? { remoteToLocal, localToRemote } : null;
}

/** 面向买家的统一文案。三个方法共用，避免各写各的导致措辞不一。 */
const NOT_CONFIGURED = "上游渠道未完成配置，请联系客服";

/** 除路径与映射之外的全部字段名是否配齐。 */
function contractFieldsReady(): boolean {
  return REQUIRED_UPSTREAM_ENV.slice(5).every((key) => (process.env[key] || "").trim() !== "");
}

/**
 * 本站套餐能否走自动充值。
 *
 * 存在的理由：充值链路只在买家提交凭证时才检查上游映射，那时候钱已经收了。
 * 大批套餐（claude / grok / gemini 等）没有上游对应项，照旧能下单、能付款、
 * 能发卡密，买家付完钱才在提交页看到"该套餐暂不可用"，
 * 且卡密已在发货前扣掉 —— 只能走退款。
 *
 * 正确的拦截点是**下单前**：不卖就不会收钱。
 */
export function isRechargeablePlan(planId: string): boolean {
  return readPlanMap()?.localToRemote.has(planId) ?? false;
}

/** 对方进度数值 -> 买家看得懂的阶段文案。不透传对方原文。 */
function progressText(progress: number, verification?: string): string {
  if (verification) return verification;
  if (progress >= 95) return "正在完成最后一步";
  if (progress >= 80) return "正在开通会员权益";
  if (progress >= 40) return "正在与官方接口交互";
  if (progress > 0) return "已受理，正在排队";
  return "订单已提交，正在等待处理";
}

/**
 * 状态归一。**保守处理**：无法识别的状态一律当 processing（继续等），
 * 绝不因为不认识就误判为失败 —— 那会让本站单方面放弃一笔可能已扣款的任务。
 * 极端情况由超时逻辑兜底。
 */
function normalizeState(word: string): UpstreamQueryResult["state"] {
  const map: Record<string, UpstreamQueryResult["state"]> = {
    success: "succeeded", succeeded: "succeeded", ok: "succeeded",
    done: "succeeded", completed: "succeeded", finished: "succeeded",
    failed: "failed", fail: "failed", error: "failed",
    rejected: "failed", cancelled: "failed", canceled: "failed",
    pending: "processing", queued: "processing", processing: "processing",
    running: "processing", accepted: "accepted",
  };
  return map[word.toLowerCase()] || "processing";
}

export class AisubAdapter implements UpstreamAdapter {
  readonly name = "aisub";

  constructor(private readonly settings: UpstreamSettings) {}

  private url(path: string): string {
    const base = this.settings.baseUrl.replace(/\/+$/, "");
    if (!base) throw new Error("上游地址未配置");
    return base + path;
  }

  /**
   * 读一个「字段名」类环境变量。
   *
   * **刻意不给默认值。** 字段名是上游契约的一部分，给默认值等于把情报
   * 换个变量名继续写死在源码里 —— 公开仓库的人照样能读到，且更难被发现。
   * 缺配置时返回空串，上层据此判定「契约未配齐」并让该渠道不可用，
   * 绝不带着猜测的字段名去请求上游（那会提交一份必然失败的请求，
   * 表现为"对方突然不受理"，比明确报错难查得多）。
   */
  private static field(name: string): string {
    return (process.env[name] || "").trim();
  }

  /**
   * 带硬超时的 JSON 请求。
   *
   * 用 AbortController 而不是只靠 connect 超时：对方若接受连接却不返回响应，
   * 没有 Abort 的 fetch 会一直挂着，占着 worker 直到进程结束 —— 几个这样的请求
   * 就足以让整台机器的充值功能全部卡死。
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(this.url(path), {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(init.headers || {}) },
        cache: "no-store",
        // 禁掉自动跟随重定向：URL 守卫只校验了**首跳**地址（配置时看的是
        // 配置里的 base_url），若允许 follow，攻击者可以让一个"看似安全的域名"
        // 重定向到内网地址，绕过 SSRF 防护读取内网资源。一律不改写请求体地重试，
        // 重定向按错误处理。
        redirect: "error",
      });
      const text = await response.text();
      // 上游的错误响应不保证是 JSON（网关超时可能返回 HTML），
      // 直接 JSON.parse 会抛出并丢掉真正的错误信息。
      let data: unknown;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
      if (!response.ok) {
        const message =
          (data as { message?: string })?.message ||
          (data as { error?: string })?.error ||
          `HTTP ${response.status}`;
        throw new Error(message);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 读取对方是否还在接单。
   *
   * 必须**每次实时读、绝不缓存**：对方维护开关是会变的。缓存一旦写入，
   * 对方恢复接单后本站仍会拒绝，而用户看到的是"系统维护中"，
   * 根本不会想到是我们的缓存过期了。
   */
  async readRuntime(): Promise<{
    ok: boolean; maintenance: boolean; maintenanceMessage: string;
    maintenanceUpcoming: boolean; plans: Array<{ key: string; label: string }>;
  }> {
    const paths = readPathSet();
    if (!paths) return { ok: false, maintenance: false, maintenanceMessage: "上游契约未配置", maintenanceUpcoming: false, plans: [] };
    const data = await this.request<{
      ok?: boolean;
      site?: Record<string, unknown>;
      plans?: Array<{ key: string; label: string }>;
    }>(paths.runtime);
    const site = data.site || {};
    return {
      ok: data.ok !== false,
      maintenance: Boolean(site.maintenance) && !site.maintenanceBypass,
      maintenanceMessage: String(site.maintenanceMessage || "对方暂停接单，请稍后再试"),
      maintenanceUpcoming: Boolean(site.maintenanceUpcoming),
      plans: Array.isArray(data.plans) ? data.plans : [],
    };
  }

  /**
   * 校验卡密。不占用 —— 上游这个接口本身就只校验、不消耗。
   */
  async validate(input: { credential: string; planId: string; email: string }): Promise<UpstreamValidateResult> {
    const paths = readPathSet();
    const planMap = readPlanMap();
    const F = AisubAdapter.field.bind(AisubAdapter);
    if (!paths || !planMap || !contractFieldsReady()) return { ok: false, reason: NOT_CONFIGURED };

    const runtime = await this.readRuntime();
    if (runtime.maintenance) {
      // 买家能看到的"对方停止接单"不是本站故障，文案要说清是谁在维护。
      return { ok: false, reason: "当前接单渠道暂停服务，请稍后再试或联系客服" };
    }
    const expected = planMap.localToRemote.get(input.planId);
    if (!expected || !runtime.plans.some((plan) => plan.key === expected)) {
      return { ok: false, reason: "该套餐暂不可用，请联系客服确认" };
    }

    const data = await this.request<Record<string, unknown>>(paths.validate, {
      method: "POST",
      body: JSON.stringify({ [F("UPSTREAM_CDK_FIELD")]: input.credential }),
    });

    const validValue = F("UPSTREAM_VALIDATE_VALUE");
    if (String(data[F("UPSTREAM_VALIDATE_FIELD")] ?? "").toLowerCase() !== validValue.toLowerCase()) {
      // 不透传上游原文：它可能带站点名、域名或内部错误细节。给买家固定文案即可。
      return { ok: false, reason: "卡密无效或已被使用" };
    }

    // 对方回传的套餐必须与订单套餐一致，否则会出现"付 Plus 的钱充了 Pro"。
    // 必须在提交前拦住 —— 提交后钱已经花了。
    const actualType = typeof data[F("UPSTREAM_PLAN_TYPE_FIELD")] === "string"
      ? (data[F("UPSTREAM_PLAN_TYPE_FIELD")] as string)
      : "";
    if (actualType && actualType !== expected) {
      return { ok: false, reason: "卡密对应的套餐与订单套餐不一致，请联系客服处理" };
    }
    return { ok: true, secret: input.credential, sku: actualType || expected };
  }

  /**
   * 提交充值。
   *
   * 契约里 credential 是买家填的会话、secret 是校验阶段拿到的卡密 —— 正好对上，
   * 因此不必把买家的原始凭证再传一次。
   *
   * 幂等：上游 API **没有** idempotencyKey 参数，重复提交无法由上游拦截。
   * 本站侧靠 recharge.ts 的 transition CAS（状态未变才推进）保证同一订单只提交
   * 一次。这一点必须写进注释：一旦绕过状态机直接调本方法，上游会重复扣卡。
   */
  async submit(input: {
    credential: string; planId: string; email: string;
    sku?: string; idempotencyKey: string; secret?: string;
  }): Promise<UpstreamSubmitResult> {
    const paths = readPathSet();
    const F = AisubAdapter.field.bind(AisubAdapter);
    if (!paths || !contractFieldsReady()) return { ok: false, reason: NOT_CONFIGURED };

    const secret = input.secret;
    if (!secret) return { ok: false, reason: "缺少卡密，无法提交" };

    // 提交前再读一次运行状态。校验与提交之间可能跨越"对方开启维护"的那一刻，
    // 而对方在维护期间会直接禁用提交按钮 —— 我们若照发只会拿到一个无意义的 4xx。
    const runtime = await this.readRuntime();
    if (runtime.maintenance) {
      return { ok: false, reason: "当前接单渠道暂停服务，请稍后再试或联系客服" };
    }

    const data = await this.request<Record<string, unknown>>(paths.submit, {
      method: "POST",
      body: JSON.stringify({
        [F("UPSTREAM_SECRET_FIELD")]: secret,
        [F("UPSTREAM_CREDENTIAL_FIELD")]: input.credential,
      }),
    });

    const jobField = F("UPSTREAM_JOB_FIELD");
    const jobKey = typeof data[jobField] === "string" ? (data[jobField] as string) : "";
    if (!jobKey) return { ok: false, reason: "接单渠道未能受理，请稍后重试或联系客服" };

    // jobKey 标识着具体某笔任务，只入库与审计；此处只记前 12 位。
    logger.audit("upstream.submitted", {
      job: jobKey.slice(0, 12), plan: input.planId, idempotencyKey: input.idempotencyKey,
    });
    const bindField = F("UPSTREAM_BINDING_FIELD");
    return {
      ok: true,
      upstreamOrder: jobKey,
      binding: typeof data[bindField] === "string" ? (data[bindField] as string) : undefined,
    };
  }

  /**
   * 轮询进度。
   *
   * 对方也支持 WebSocket 实时推送，但轮询足够且省掉长连接依赖 ——
   * maintenance 定时任务每 5 分钟就会扫一次卡住的任务，1~2 分钟的反馈间隔
   * 由 pollIntervalSeconds 控制，不需要 WebSocket 那种常驻连接。
   */
  async query(input: { upstreamOrder: string; binding?: string }): Promise<UpstreamQueryResult> {
    const paths = readPathSet();
    const F = AisubAdapter.field.bind(AisubAdapter);
    if (!paths || !contractFieldsReady()) return { state: "not_found" };
    // {key} 必须 encodeURIComponent：上游单号含斜杠或特殊字符时直接拼接
    // 会改变路径结构，查询打到别的接口上，表现为"任务不存在"。
    const path = paths.query.replace("{key}", encodeURIComponent(input.upstreamOrder));

    try {
      const data = await this.request<Record<string, unknown>>(path);
      const task = data[F("UPSTREAM_TASK_FIELD")] as Record<string, unknown> | undefined;
      if (!task) return { state: "not_found" };

      const state = normalizeState(String(task[F("UPSTREAM_TASK_STATE_FIELD")] ?? ""));
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const message = state === "processing"
        ? progressText(
            Number(task[F("UPSTREAM_TASK_PROGRESS_FIELD")] ?? 0),
            str(task[F("UPSTREAM_TASK_VERIFY_FIELD")]),
          )
        : undefined;
      return {
        state, message,
        detail: str(task[F("UPSTREAM_TASK_RESULT_FIELD")])
          || str(task[F("UPSTREAM_TASK_MESSAGE_FIELD")])
          || str(task[F("UPSTREAM_TASK_VERIFY_FIELD")]),
      };
    } catch (error) {
      // 「查不到」与「查失败」必须分开：前者说明上游没这笔单（可能是刚提交、
      // 上游尚未落库），后者是网络或服务端问题。若把两者都当成 not_found，
      // 任务会被判为失败并转人工，而实际上它可能正在正常处理。
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP 404/.test(message)) return { state: "not_found" };
      logger.error("upstream.query_failed", { job: input.upstreamOrder.slice(0, 12) }, error);
      // 查失败不是终态：返回 processing 让状态机继续等待，由超时兜底。
      // 返回 failed 会把一次网络抖动变成"充值失败"，而钱可能已经付了。
      return { state: "processing", message: "正在同步对方处理进度" };
    }
  }
}
