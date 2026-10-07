import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { systemVersions } from "@/db/schema";
import { logger } from "@/lib/core";
import { cacheGet, cacheSet, cacheDelete } from "@/lib/core/cache";

// ---------------------------------------------------------------------------
// 系统更新（版本发布记录）
//
// 职责边界：本模块管"版本记录与前台可见性"，不管代码发布本身。
// 代码发布由 deploy.sh 在服务器上做（rsync + 原子软链切换），
// 版本记录是发布之后的**对外沟通**。
//
// 为什么要"预约发布"：发版窗口通常在凌晨（流量低谷、支付通道压力小），
// 但文案要提前写、提前审。scheduledFor 让运营提前准备，到点自动可见。
//
// 缓存：前台每次渲染都要取"最新已发布版本"，变动极少（一天可能一次），
// 5 分钟 TTL。写操作后必须 invalidate，否则新版本要等 5 分钟才出现——
// 那会让运营以为"发布没生效"而反复点击。
// ---------------------------------------------------------------------------

const CACHE_KEY = "system-versions";
const CACHE_TTL_MS = 5 * 60_000;

export type VersionLevel = "minor" | "major" | "critical";
export type VersionStatus = "draft" | "scheduled" | "published";

export interface PublicVersion {
  version: string;
  title: string;
  changes: string[];
  level: VersionLevel;
  publishedAt: string;
}

export interface VersionDraft {
  id: string;
  version: string;
  title: string;
  changes: string;
  level: VersionLevel;
  status: VersionStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const LEVELS: readonly string[] = ["minor", "major", "critical"];
const STATUSES: readonly string[] = ["draft", "scheduled", "published"];

const isLevel = (v: unknown): v is VersionLevel => typeof v === "string" && LEVELS.includes(v);
const isStatus = (v: unknown): v is VersionStatus => typeof v === "string" && STATUSES.includes(v);

/** 变更条目按行拆开，去掉空行与首尾空白。空内容返回空数组而不是 [""]。 */
function parseChanges(raw: string): string[] {
  return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 50);
}

/**
 * 发布到点检查：把 scheduled 且已到时间的记录改为 published。
 *
 * 进程里没有常驻定时器能精确在某一秒醒来，所以走两条路（都调本函数，幂等）：
 *   a) 前台渲染时顺带检查（懒发布）——零额外成本；
 *   b) 定时任务每 5 分钟扫一次（scripts/maintenance.mjs 经 cron 跑，继承自维护任务）——准时，不依赖流量。
 * 两条路都覆盖，所以服务器刚重启、定时任务还没跑时，访客访问也会触发发布。
 */
export async function publishDueVersions(): Promise<number> {
  const now = new Date();
  const due = await db
    .select({ id: systemVersions.id, version: systemVersions.version })
    .from(systemVersions)
    .where(and(eq(systemVersions.status, "scheduled"), lte(systemVersions.scheduledFor, now)))
    .limit(50);
  if (due.length === 0) return 0;
  const updated = await db
    .update(systemVersions)
    .set({ status: "published", publishedAt: now, updatedAt: now })
    .where(inArray(systemVersions.id, due.map(d => d.id)))
    .returning({ id: systemVersions.id });
  cacheDelete(CACHE_KEY);
  // 审计字段只接受标量，数组要 join —— logger 的字段类型是 Record<string, string|number|boolean|null>。
  logger.audit("system_versions.published", {
    count: updated.length,
    versions: due.map(d => d.version).join(","),
  });
  return updated.length;
}

/**
 * 前台读取：已发布的版本，按发布时间倒序。
 *
 * 只返回 published。draft 与 scheduled 是内部状态，对外一律不可见——
 * 草稿写错字、预约时间设错，前台都不该看到。
 */
export async function listPublicVersions(limit = 10): Promise<PublicVersion[]> {
  const hit = cacheGet<PublicVersion[]>(CACHE_KEY);
  if (hit !== undefined) return hit.slice(0, limit);
  // 顺带处理"到点自动发布"：定时任务没跑时，访客访问也能保证前台不是旧版本。
  await publishDueVersions();
  const rows = await db
    .select({
      version: systemVersions.version,
      title: systemVersions.title,
      changes: systemVersions.changes,
      level: systemVersions.level,
      publishedAt: systemVersions.publishedAt,
    })
    .from(systemVersions)
    .where(eq(systemVersions.status, "published"))
    .orderBy(desc(systemVersions.publishedAt))
    .limit(limit);
  const out: PublicVersion[] = rows.map(r => ({
    version: r.version,
    title: r.title,
    changes: parseChanges(r.changes),
    level: isLevel(r.level) ? r.level : "minor",
    publishedAt: (r.publishedAt ?? new Date()).toISOString(),
  }));
  cacheSet(CACHE_KEY, out, CACHE_TTL_MS);
  return out;
}

/** 前台汇总：计数 + 最新一条。首页只展示"有更新"而不铺开整个列表。 */
export async function getVersionSummary(): Promise<{ count: number; latest: PublicVersion | null }> {
  const list = await listPublicVersions(10);
  return { count: list.length, latest: list[0] ?? null };
}

/** 后台读取：全部版本，含草稿与已预约，按更新时间倒序。 */
export async function listAllVersions(): Promise<VersionDraft[]> {
  const rows = await db.select().from(systemVersions).orderBy(desc(systemVersions.updatedAt)).limit(200);
  return rows.map(r => ({
    id: r.id,
    version: r.version,
    title: r.title,
    changes: r.changes,
    level: isLevel(r.level) ? r.level : "minor",
    status: isStatus(r.status) ? r.status : "draft",
    scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export type SaveVersionInput = {
  id?: string;
  version: string;
  title: string;
  changes: string;
  level: string;
  status: string;
  scheduledFor: string | null;
};

export type SaveResult = { ok: true; id: string } | { ok: false; error: string; status?: number };

/**
 * 新建或更新一条版本记录。
 *
 * 校验放在服务端而不是只靠前端表单：任何人都能直接 POST /api/admin/versions。
 */
export async function saveVersion(input: SaveVersionInput, admin: string): Promise<SaveResult> {
  const version = input.version.trim();
  const title = input.title.trim();
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) {
    return { ok: false, error: "版本号格式应为 1.2.0 这样的三段数字", status: 400 };
  }
  if (title.length < 2 || title.length > 80) {
    return { ok: false, error: "标题需在 2 到 80 字之间", status: 400 };
  }
  if (!isLevel(input.level)) return { ok: false, error: "重要程度取值无效", status: 400 };
  if (!isStatus(input.status)) return { ok: false, error: "状态取值无效", status: 400 };
  const changes = input.changes.slice(0, 4000);
  if (input.status !== "draft" && parseChanges(changes).length === 0) {
    return { ok: false, error: "发布或预约前请至少写一条变更内容", status: 400 };
  }

  const now = new Date();
  // scheduled 必须带时间，否则这条记录永远不会被发布：publishDueVersions 的
  // 条件是 lte(scheduledFor, now)，而 NULL 比较结果为 NULL，条件不成立。
  let scheduledFor: Date | null = null;
  if (input.status === "scheduled") {
    const parsed = input.scheduledFor ? new Date(input.scheduledFor) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      return { ok: false, error: "预约发布必须指定有效时间", status: 400 };
    }
    scheduledFor = parsed;
  }

  if (input.id) {
    const [existing] = await db.select().from(systemVersions).where(eq(systemVersions.id, input.id)).limit(1);
    if (!existing) return { ok: false, error: "版本记录不存在", status: 404 };
    // 版本号唯一：改号时先查一次给出可读提示，而不是把数据库 unique 违反抛给前端。
    if (existing.version !== version) {
      const [dup] = await db.select({ id: systemVersions.id }).from(systemVersions).where(eq(systemVersions.version, version)).limit(1);
      if (dup) return { ok: false, error: `版本号 ${version} 已被另一条记录使用`, status: 409 };
    }
    await db
      .update(systemVersions)
      .set({
        version,
        title,
        changes,
        level: input.level,
        status: input.status,
        scheduledFor,
        // 改回 draft 叫"撤回"。此时不清 publishedAt —— 那样会丢失"原本何时发布"，
        // 而运营需要知道这条曾经对外发过。后续再次发布时也不会覆盖原时间。
        publishedAt: input.status === "published" ? existing.publishedAt ?? now : existing.publishedAt,
        updatedAt: now,
      })
      .where(eq(systemVersions.id, input.id));
    cacheDelete(CACHE_KEY);
    logger.audit("system_versions.updated", { version, status: input.status, by: admin });
    return { ok: true, id: input.id };
  }

  const [dup] = await db.select({ id: systemVersions.id }).from(systemVersions).where(eq(systemVersions.version, version)).limit(1);
  if (dup) return { ok: false, error: `版本号 ${version} 已存在`, status: 409 };

  const [created] = await db
    .insert(systemVersions)
    .values({
      version,
      title,
      changes,
      level: input.level,
      status: input.status,
      scheduledFor,
      // 立即发布时写入发布时间；预约与草稿留空，等 publishDueVersions 补。
      publishedAt: input.status === "published" ? now : null,
    })
    .returning({ id: systemVersions.id });
  cacheDelete(CACHE_KEY);
  logger.audit("system_versions.created", { version, status: input.status, by: admin });
  return { ok: true, id: created.id };
}

/** 删除。只允许删草稿 —— 已发布或已预约的记录删掉等于让买家看过的更新凭空消失。 */
export async function deleteVersion(id: string, admin: string): Promise<SaveResult> {
  const [row] = await db.select().from(systemVersions).where(eq(systemVersions.id, id)).limit(1);
  if (!row) return { ok: false, error: "版本记录不存在", status: 404 };
  if (row.status !== "draft") {
    return { ok: false, error: "只能删除草稿。已发布或已预约的记录请改为草稿（等于撤回）", status: 409 };
  }
  await db.delete(systemVersions).where(eq(systemVersions.id, id));
  cacheDelete(CACHE_KEY);
  logger.audit("system_versions.deleted", { version: row.version, by: admin });
  return { ok: true, id };
}

/** 撤回：已发布的版本改回 draft，前台立即不再显示，但保留 publishedAt 记录。 */
export async function retractVersion(id: string, admin: string): Promise<SaveResult> {
  const [row] = await db.select().from(systemVersions).where(eq(systemVersions.id, id)).limit(1);
  if (!row) return { ok: false, error: "版本记录不存在", status: 404 };
  await db
    .update(systemVersions)
    .set({ status: "draft", updatedAt: new Date() })
    .where(eq(systemVersions.id, id));
  cacheDelete(CACHE_KEY);
  logger.audit("system_versions.retracted", { version: row.version, by: admin });
  return { ok: true, id };
}
