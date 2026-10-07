import { NextResponse } from "next/server";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { adminAccess } from "@/lib/admin/access";
import { currentAdmin } from "@/lib/auth";
import { rateLimit, sameOrigin } from "@/lib/auth";
import { readJson, ErrorCode, apiError } from "@/lib/core";
import {
  listAllVersions,
  saveVersion,
  deleteVersion,
  retractVersion,
} from "@/lib/system-versions";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// guard() 把前置失败折叠成 { error, status }，这里按 status 反推错误码，避免
// 「HTTP 是 429 但 code 是 VALIDATION_FAILED」这种语义失真。此前 GET/POST 每处
// 都写 `g.status === 401 ? AUTH_REQUIRED : VALIDATION_FAILED`——限流 429、来源
// 403、闸门 404 全部被压成 VALIDATION_FAILED，前端按 code 分支时会把"被限流"
// 当成"请求不合法"。映射与 admin-api.ts 的 STATUS_TO_CODE 同源。
const GUARD_CODE: Record<number, (typeof ErrorCode)[keyof typeof ErrorCode]> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.AUTH_REQUIRED,
  403: ErrorCode.FORBIDDEN_ORIGIN,
  404: ErrorCode.NOT_FOUND,
  405: ErrorCode.METHOD_NOT_ALLOWED,
  409: ErrorCode.CONFLICT_STATE,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL,
};
const guardCode = (status: number) => GUARD_CODE[status] ?? ErrorCode.VALIDATION_FAILED;
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status: number) =>
  apiError(code, error, status, NO_STORE);

/** 后台版本管理。与其它后台接口同一套前置：闸门 -> 限流 -> 鉴权。 */
type Guard = { admin: { username: string } } | { error: string; status: number };

async function guard(request: Request, requireSameOrigin: boolean): Promise<Guard> {
  // 与其它后台路由一致：闸门判 adminAccess().allowed（此前误写成 !adminAccess()，
  // 对返回对象取真值恒为 false，等于闸门从未生效，生产把后台关了接口仍可达）。
  if (!adminAccess().allowed) return { error: "not found", status: 404 };
  if (!rateLimit(request, "admin-versions", 60)) {
    return { error: "操作过于频繁，请稍后再试", status: 429 };
  }
  if (requireSameOrigin && !sameOrigin(request)) {
    return { error: "请求来源无效", status: 403 };
  }
  const admin = await currentAdmin();
  if (!admin) return { error: "请先登录", status: 401 };
  return { admin: { username: admin.username } };
}

export async function GET(request: Request) {
  const g = await guard(request, false);
  if ("error" in g) {
    return fail(guardCode(g.status), g.error, g.status);
  }
  return NextResponse.json({ versions: await listAllVersions() }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const g = await guard(request, true);
  if ("error" in g) {
    return fail(guardCode(g.status), g.error, g.status);
  }
  const body = await readJson(request);
  const action = typeof body?.action === "string" ? body.action : "save";

  if (action === "delete") {
    const id = typeof body?.id === "string" ? body.id : "";
    const r = await deleteVersion(id, g.admin.username);
    return r.ok ? NextResponse.json({ success: true }, { headers: NO_STORE })
                : fail(ErrorCode.VALIDATION_FAILED, r.error, r.status ?? 400);
  }
  if (action === "retract") {
    const id = typeof body?.id === "string" ? body.id : "";
    const r = await retractVersion(id, g.admin.username);
    return r.ok ? NextResponse.json({ success: true }, { headers: NO_STORE })
                : fail(ErrorCode.VALIDATION_FAILED, r.error, r.status ?? 400);
  }

  const r = await saveVersion(
    {
      id: typeof body?.id === "string" && body.id ? body.id : undefined,
      version: typeof body?.version === "string" ? body.version : "",
      title: typeof body?.title === "string" ? body.title : "",
      changes: typeof body?.changes === "string" ? body.changes : "",
      level: typeof body?.level === "string" ? body.level : "minor",
      status: typeof body?.status === "string" ? body.status : "draft",
      scheduledFor: typeof body?.scheduledFor === "string" && body.scheduledFor ? body.scheduledFor : null,
    },
    g.admin.username,
  );
  return r.ok ? NextResponse.json({ success: true, id: r.id }, { headers: NO_STORE })
              : fail(ErrorCode.VALIDATION_FAILED, r.error, r.status ?? 400);
}
