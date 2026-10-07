import { NextResponse } from "next/server";
import { adminAccess } from "@/lib/admin/access";
import { db } from "@/db";
import { announcements } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { currentAdmin, rateLimit, sameOrigin } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";
import { invalidateAnnouncementsCache } from "@/lib/promo";
import { logger } from "@/lib/core";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const bad = (error: string) => apiError(ErrorCode.VALIDATION_FAILED, error, 400, NO_STORE);
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status: number) =>
  apiError(code, error, status, NO_STORE);

// readJson 的返回值是宽松类型，这里统一收口：所有进入 SQL / 日志的字段都必须先过这一层，
// 否则一个 undefined 就会在 Drizzle 里变成类型错误，或在日志里写出 "undefined"。
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const bool = (value: unknown): boolean => value === true;
function optionalDate(value: unknown): Date | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(str(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function GET(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!rateLimit(request, "admin-api", 120)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  if (!(await currentAdmin())) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
  const rows = await db.select().from(announcements).orderBy(desc(announcements.pinned), desc(announcements.updatedAt)).limit(100);
  return NextResponse.json(rows, { headers: NO_STORE });
}

export async function POST(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  if (!rateLimit(request, "admin-api", 120)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  const admin = await currentAdmin();
  if (!admin) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
  const body = await readJson(request);
  if (!body) return bad("请求内容无效");

  const id = str(body.id);
  const title = str(body.title).trim();
  const content = str(body.body).trim();
  const level = str(body.level) || "info";
  const pinned = bool(body.pinned);
  const active = body.active !== false;

  if (!title || title.length > 60) return bad("标题需为 1-60 字");
  if (!content || content.length > 1000) return bad("正文需为 1-1000 字");
  if (level !== "info" && level !== "warning" && level !== "danger") return bad("级别无效");

  const startsAt = optionalDate(body.startsAt);
  const expiresAt = optionalDate(body.expiresAt);
  if (startsAt === undefined || expiresAt === undefined) return bad("生效或失效时间格式无效");
  // 失效早于生效 = 公告永远不会显示。这种错误必须在后台拦下并说明，
  // 否则运营会以为公告已发布，访客却永远看不到。
  if (startsAt && expiresAt && expiresAt <= startsAt) return bad("失效时间必须晚于生效时间");

  const values = { title, body: content, level, pinned, active, startsAt, expiresAt, updatedAt: new Date() };

  if (id) {
    await db.update(announcements).set(values).where(eq(announcements.id, id));
    invalidateAnnouncementsCache();
    logger.audit("announcement.updated", { id, level, pinned, active, by: admin.username });
    return NextResponse.json({ success: true, id }, { headers: NO_STORE });
  }
  const [created] = await db.insert(announcements).values(values).returning({ id: announcements.id });
  invalidateAnnouncementsCache();
  logger.audit("announcement.created", { id: created.id, level, pinned, active, by: admin.username });
  return NextResponse.json({ success: true, id: created.id }, { status: 201, headers: NO_STORE });
}

export async function PATCH(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  if (!rateLimit(request, "admin-api", 120)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  const admin = await currentAdmin();
  if (!admin) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
  const body = await readJson(request);
  if (!body) return bad("请求内容无效");
  const id = str(body.id);
  if (!id) return fail(ErrorCode.NOT_FOUND, "公告不存在", 404);
  if (str(body.action) !== "toggle") return bad("未知操作");

  const [row] = await db.select({ active: announcements.active }).from(announcements).where(eq(announcements.id, id));
  if (!row) return fail(ErrorCode.NOT_FOUND, "公告不存在", 404);
  const active = !row.active;
  await db.update(announcements).set({ active, updatedAt: new Date() }).where(eq(announcements.id, id));
  invalidateAnnouncementsCache();
  logger.audit("announcement.toggled", { id, active, by: admin.username });
  return NextResponse.json({ success: true, active }, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  if (!rateLimit(request, "admin-api", 120)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  const admin = await currentAdmin();
  if (!admin) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) return fail(ErrorCode.NOT_FOUND, "公告不存在", 404);
  await db.delete(announcements).where(eq(announcements.id, id));
  invalidateAnnouncementsCache();
  logger.audit("announcement.deleted", { id, by: admin.username });
  return NextResponse.json({ success: true }, { headers: NO_STORE });
}
