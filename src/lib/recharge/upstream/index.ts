import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { upstreamConfig } from "@/db/schema";
import { mockAdapter } from "./mock";
import { createHttpAdapter } from "./http";
import { AisubAdapter } from "./aisub";
import type { UpstreamAdapter } from "./types";

export * from "./types";
export { AisubAdapter } from "./aisub";

// 上游配置是单例且几乎不变，缓存 30 秒足够；后台改配置后最多半分钟生效。
let cached: { at: number; adapter: UpstreamAdapter; enabled: boolean } | undefined;
const TTL_MS = 30_000;

async function load() {
  const now = Date.now();
  if (cached && cached.at + TTL_MS > now) return cached;
  const [row] = await db.select().from(upstreamConfig).where(eq(upstreamConfig.id, 1)).limit(1);
  const settings = row ?? {
    provider: "mock", baseUrl: "", appId: "",
    timeoutSeconds: 900, pollIntervalSeconds: 90,
  };
  const enabled = row?.enabled ?? false;
  // 显式分支而不是拿 mock 兜底：未知 provider 静默退回 mock 意味着
  // 一次配置笔误（或 DB 被改写）就会让全站充值变成"假成功"。
  // 遇到不认识的上游，宁可整个渠道不可用，也不要假装它在正常工作。
  let adapter: UpstreamAdapter;
  if (settings.provider === "aisub") adapter = new AisubAdapter(settings);
  else if (settings.provider === "http") adapter = createHttpAdapter(settings);
  else if (settings.provider === "mock") {
    // mock 在生产必须不可用。接口层已拦，这里是第二道：防止 DB 被改写、
    // 或将来新增别的写入路径绕过接口校验。对齐支付侧 registry 的做法。
    if (process.env.NODE_ENV === "production") {
      return { at: now, adapter: mockAdapter, enabled: false };
    }
    adapter = mockAdapter;
  } else {
    return { at: now, adapter: mockAdapter, enabled: false };
  }
  cached = { at: now, adapter, enabled };
  return cached;
}

export function invalidateUpstreamCache() {
  cached = undefined;
}

/** 取当前启用的适配器。未启用时返回 null——调用方必须显式处理"没开"这种情况。 */
export async function getUpstream(): Promise<{ adapter: UpstreamAdapter; enabled: true } | { adapter: null; enabled: false }> {
  const { adapter, enabled } = await load();
  return enabled ? { adapter, enabled: true } : { adapter: null, enabled: false };
}

// 与 upstream_config 的 schema 默认值保持一致的单例兜底。
// 缺行时回落到默认值，而不是把 undefined 交给调用方：调用方普遍直接解构
// （recharge.ts 的 getPublicProgress / advanceJob），undefined 会抛 TypeError ——
// 买家侧进度接口 500；即便不解构，undefined 也会让 isTimedOut 恒 false，
// 上游卡住的任务永不超时，而 deadline 变 NaN 会让 remainingSeconds 序列化成 null，
// 进度条永远不动。
const FALLBACK_UPSTREAM = {
  id: 1, enabled: false, provider: "mock", baseUrl: "", appId: "",
  timeoutSeconds: 900, pollIntervalSeconds: 90,
  credentialTtlMinutes: 30, dailyLimitPerEmail: 5,
} as const;

export async function getUpstreamSettings() {
  const [row] = await db.select().from(upstreamConfig).where(eq(upstreamConfig.id, 1)).limit(1);
  return row ?? FALLBACK_UPSTREAM;
}

/** 后台保存配置后调用。 */
export async function saveUpstreamConfig(values: Partial<typeof upstreamConfig.$inferInsert>) {
  const [existing] = await db.select({ id: upstreamConfig.id }).from(upstreamConfig).where(eq(upstreamConfig.id, 1)).limit(1);
  if (existing) await db.update(upstreamConfig).set(values).where(eq(upstreamConfig.id, 1));
  else await db.insert(upstreamConfig).values({ id: 1, ...values });
  invalidateUpstreamCache();
}
