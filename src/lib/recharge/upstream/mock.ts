import { createHash } from "node:crypto";
import type { UpstreamAdapter, UpstreamQueryResult, UpstreamSubmitResult, UpstreamValidateResult } from "./types";

// ---------------------------------------------------------------------------
// 本地模拟上游。
//
// 作用有三个：
//   1. 没有真实上游时也能把整条链路（提交 → 轮询 → 完成）跑通并验证；
//   2. 作为"上游协议"的活文档——新对接一家，照着这个形状实现 HttpAdapter 即可；
//   3. 故意实现了几种真实世界会遇到的失败：凭证无效、额度不足、处理失败、超时。
//
// 行为约定：凭证以 "eyJ" 或 "{" 开头视为合法；含 "fail" 视为处理失败；
// 含 "slow" 视为需要 5 次轮询才成功（用来验证前端进度条真的会动）。
// ---------------------------------------------------------------------------

type MockOrder = { order: string; binding: string; state: "accepted" | "processing" | "succeeded" | "failed"; polls: number; detail?: string };

// 内存态：进程重启即失效。对模拟上游来说恰好合适——它本就不该跨重启保留状态。
const orders = new Map<string, MockOrder>();
let counter = 0;

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

export const mockAdapter: UpstreamAdapter = {
  name: "mock",

  async validate({ credential, email }): Promise<UpstreamValidateResult> {
    if (!credential) return { ok: false, reason: "凭证不能为空" };
    if (!credential.startsWith("eyJ") && !credential.startsWith("{")) {
      return { ok: false, reason: "凭证格式不正确，请粘贴登录态 JSON 或以 eyJ 开头的 accessToken" };
    }
    if (credential.includes("invalid")) return { ok: false, reason: "该账号登录态已失效，请重新登录后获取" };
    if (credential.includes("poor")) return { ok: false, reason: "该账号当前订阅状态异常，请确认账号地区与登录态" };
    // 真实上游会在这里返回一个"可用的兑换凭据"给本站持有；此处用凭证派生值模拟。
    // 关键：把 fail / slow 标记透传进 secret，否则 query 阶段按 binding 判定失败时
    // 标记已经丢失，失败链路就测不到了。
    const markers = ["fail", "slow"].filter((m) => credential.includes(m));
    return {
      ok: true,
      secret: `mock-secret-${markers.join("-")}-${shortHash(credential)}`,
      sku: `sku-${shortHash(email)}`,
      faceValue: 100,
    };
  },

  async submit({ idempotencyKey, secret, credential }): Promise<UpstreamSubmitResult> {
    const binding = secret ?? `mock-secret-${shortHash(credential)}`;
    // 幂等：同一份兑换凭据重复提交必须返回同一单，否则上游会重复扣卡。
    for (const [order, row] of orders) {
      if (row.binding === binding) return { ok: true, upstreamOrder: order, binding: row.binding };
    }
    counter += 1;
    const upstreamOrder = `MOCK-${Date.now().toString(36)}-${counter}`;
    orders.set(upstreamOrder, { order: upstreamOrder, binding, state: "accepted", polls: 0 });
    void idempotencyKey;
    return { ok: true, upstreamOrder, binding };
  },

  async query({ upstreamOrder }): Promise<UpstreamQueryResult> {
    const row = orders.get(upstreamOrder);
    if (!row) return { state: "not_found", message: "上游未找到该任务" };
    row.polls += 1;
    if (row.polls < 2) return { state: "processing", message: "上游已受理，正在排队" };
    // 约定：凭证含 fail 的会失败；含 slow 的要多轮询才成功。
    if (row.binding.includes("fail")) {
      row.state = "failed";
      return { state: "failed", message: "上游处理失败", detail: "模拟失败：用于验证失败链路" };
    }
    if (!row.binding.includes("slow") && row.polls >= 3) {
      row.state = "succeeded";
      return { state: "succeeded", message: "充值完成" };
    }
    if (row.polls >= 6) {
      row.state = "succeeded";
      return { state: "succeeded", message: "充值完成" };
    }
    row.state = "processing";
    return { state: "processing", message: `上游处理中（${row.polls}/6）` };
  },

  async release({ upstreamOrder }): Promise<boolean> {
    return orders.delete(upstreamOrder);
  },
};
