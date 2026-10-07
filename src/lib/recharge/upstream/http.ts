import type { UpstreamAdapter, UpstreamQueryResult, UpstreamSettings, UpstreamSubmitResult, UpstreamValidateResult } from "./types";
import { logger } from "@/lib/core";

// ---------------------------------------------------------------------------
// 通用 HTTP 上游适配器。
//
// 真实上游的字段名千差万别，但流程都是「校验 → 提交 → 查询」。
// 这里用一份**字段映射表**把上游的 JSON 归一化成本站的契约，
// 接一家新上游通常只需要改 FIELD_MAP 与状态映射，不必重写流程。
//
// 三条务实约束：
//   1. 所有请求都带幂等键（本站订单号），并设置硬超时——上游卡住不能拖垮本站。
//   2. 凭证只在请求体里出现，且不进日志（logger 对字段值做统一处理）。
//   3. 上游返回的 detail 一律视为不可信文本，交给上层脱敏后再展示。
// ---------------------------------------------------------------------------

type FieldMap = {
  /** 取凭证/兑换码 */
  secret: string;
  /** 取邮箱 */
  email: string;
  /** 取邮箱（备用路径） */
  emailAlt?: string;
  /** 取套餐标识 */
  sku: string;
  /** 取订单号 */
  order: string;
  /** 取绑定标识 */
  binding: string;
  /** 取状态 */
  state: string;
  /** 取说明 */
  message: string;
  /** 取错误原因 */
  reason: string;
  /** 取成功与否 */
  success: string;
};

const DEFAULT_MAP: FieldMap = {
  secret: "card", email: "email", emailAlt: "contact", sku: "product", order: "order_id",
  binding: "bind_id", state: "status", message: "msg", reason: "error", success: "code",
};

const pick = (source: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
};

// 把上游五花八门的状态词归一。宁可保守：无法识别就当 processing（继续等），
// 绝不能因为不认识就误判为失败——那会让本站单方面放弃一笔可能已扣款的任务。
const STATE_MAP: Record<string, UpstreamQueryResult["state"]> = {
  accepted: "accepted", created: "accepted", pending: "processing", queued: "processing",
  processing: "processing", running: "processing", doing: "processing", working: "processing",
  success: "succeeded", succeeded: "succeeded", ok: "succeeded", done: "succeeded", completed: "succeeded",
  fail: "failed", failed: "failed", error: "failed", rejected: "failed", cancelled: "failed", canceled: "failed",
};

export function createHttpAdapter(settings: UpstreamSettings, map: Partial<FieldMap> = {}): UpstreamAdapter {
  const f: FieldMap = { ...DEFAULT_MAP, ...map };
  const base = settings.baseUrl.replace(/\/+$/, "");
  const secretKey = () => process.env.UPSTREAM_SECRET || "";

  async function call<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    if (!/^https?:\/\//i.test(base)) throw new Error("上游地址未配置或格式不正确");
    // 硬超时：上游不响应时 本站不能被拖住。Node 的 fetch 支持 AbortSignal。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(5, settings.timeoutSeconds) * 1000);
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 签名放请求头而非 query，避免凭证出现在网关/代理日志里。
          "X-Upstream-Key": secretKey(),
          "X-App-Id": settings.appId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: "no-store",
        // 不跟随重定向（理由同 aisub.ts）：URL 守卫只校验首跳地址，
        // 允许 follow 会把"看似安全的域名"重定向进内网，绕过 SSRF 防护。
        redirect: "error",
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "http",

    async validate({ credential, planId, email }): Promise<UpstreamValidateResult> {
      try {
        const raw = await call<Record<string, unknown>>("/api/validate", { [f.secret]: credential, [f.sku]: planId, [f.email]: email });
        if (pick(raw, [f.success]) === "fail" || raw.success === false) {
          return { ok: false, reason: pick(raw, [f.reason, f.message]) || "上游校验未通过" };
        }
        return {
          ok: true,
          secret: pick(raw, [f.secret]) || credential,
          sku: pick(raw, [f.sku]) || planId,
        };
      } catch (error) {
        logger.error("upstream.validate_failed", {}, error);
        return { ok: false, reason: "上游校验暂时不可用，请稍后再试" };
      }
    },

    async submit({ credential, planId, email, sku, idempotencyKey }): Promise<UpstreamSubmitResult> {
      try {
        const raw = await call<Record<string, unknown>>("/api/submit", {
          [f.secret]: credential, [f.sku]: sku || planId, [f.email]: email, idempotency_key: idempotencyKey,
        });
        if (pick(raw, [f.success]) === "fail" || raw.success === false) {
          return { ok: false, reason: pick(raw, [f.reason, f.message]) || "上游提交失败" };
        }
        const upstreamOrder = pick(raw, [f.order]);
        if (!upstreamOrder) return { ok: false, reason: "上游未返回订单号" };
        return { ok: true, upstreamOrder, binding: pick(raw, [f.binding]) || undefined };
      } catch (error) {
        logger.error("upstream.submit_failed", {}, error);
        return { ok: false, reason: "上游提交失败，请稍后重试或联系客服" };
      }
    },

    async query({ upstreamOrder }): Promise<UpstreamQueryResult> {
      try {
        const raw = await call<Record<string, unknown>>("/api/query", { [f.order]: upstreamOrder });
        const stateWord = pick(raw, [f.state]).toLowerCase();
        const state = STATE_MAP[stateWord] ?? "processing";
        return { state, message: pick(raw, [f.message]), detail: pick(raw, [f.reason, f.message]) };
      } catch (error) {
        // 查询失败不等于任务失败。返回 processing 让 本站继续等，
        // 由超时逻辑兜底——避免把"网络抖动"误判成"充值失败"。
        logger.error("upstream.query_failed", { upstreamOrder: "***" }, error);
        return { state: "processing", message: "等待上游响应" };
      }
    },

    async release({ upstreamOrder, reason }): Promise<boolean> {
      try {
        await call("/api/release", { [f.order]: upstreamOrder, [f.reason]: reason });
        return true;
      } catch (error) {
        logger.error("upstream.release_failed", {}, error);
        return false;
      }
    },
  };
}
