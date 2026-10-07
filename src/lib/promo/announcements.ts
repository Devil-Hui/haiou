import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { announcements } from "@/db/schema";

// 公告是"读多写极少 + 改动必须立刻生效"的数据。
// 缓存 TTL 给得很短（30 秒）：运营改完公告后希望刷新页面就能看到，
// 但没必要让每个访客都打一次库。
const TTL_MS = 30_000;

export type PublicAnnouncement = {
  id: string;
  title: string;
  body: string;
  level: string;
  pinned: boolean;
  updatedAt: string;
};

let cache: { items: PublicAnnouncement[]; expires: number } | undefined;

/** 当前生效中的公告：active + 处于时间窗内，置顶优先、其次按更新时间倒序。 */
export async function listActiveAnnouncements(): Promise<PublicAnnouncement[]> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.items;
  const rows = await db
    .select({
      id: announcements.id,
      title: announcements.title,
      body: announcements.body,
      level: announcements.level,
      pinned: announcements.pinned,
      updatedAt: announcements.updatedAt,
    })
    .from(announcements)
    .where(and(
      eq(announcements.active, true),
      or(isNull(announcements.startsAt), lte(announcements.startsAt, new Date(now))),
      or(isNull(announcements.expiresAt), gte(announcements.expiresAt, new Date(now))),
    ))
    .orderBy(desc(announcements.pinned), desc(announcements.updatedAt))
    .limit(5);
  const items = rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
  cache = { items, expires: now + TTL_MS };
  return items;
}

export function invalidateAnnouncementsCache(): void {
  cache = undefined;
}
