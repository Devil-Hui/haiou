import { NextResponse } from "next/server";
import { adminAccess } from "@/lib/admin/access";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { plans } from "@/db/schema";
import { currentAdmin, rateLimit, sameOrigin } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";
import { invalidatePlansCache } from "@/lib/catalog";
import { logger } from "@/lib/core";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status = 400) =>
  apiError(code, error, status, NO_STORE);

/**
 * 套餐批量操作。
 *
 * 逐条独立更新而不是拼一条批量 SQL：不同套餐可能落到不同的校验分支
 * （例如只改其中几个的价格），独立处理能让每条都走同一套校验，
 * 避免"一条非法导致整批静默跳过"这种查不出原因的行为。
 * 全部成功或全部不改——发现任一条不合法就整体拒绝，避免半成品状态。
 */
export async function PATCH(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  if (!rateLimit(request, "admin-bulk", 30)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  const admin = await currentAdmin();
  if (!admin) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
  const body = await readJson(request, 16384);
  if (!body) return fail(ErrorCode.VALIDATION_FAILED, "请求内容无效");

  const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) return fail(ErrorCode.VALIDATION_FAILED, "请先选择要操作的套餐");
  if (ids.length > 200) return fail(ErrorCode.VALIDATION_FAILED, "单次最多操作 200 个套餐");
  const action = String(body.action || "");

  const rows = await db.select().from(plans).where(inArray(plans.id, ids));
  if (rows.length !== ids.length) return fail(ErrorCode.NOT_FOUND, "部分套餐不存在，请刷新后重试", 404);

  const updates: Partial<typeof plans.$inferInsert> = {};
  if (action === "on" || action === "off") {
    updates.active = action === "on";
  } else if (action === "price") {
    // 批量调价用"设置固定价"而不是百分比：运营的心智是"这几款都卖 X 元"，
    // 百分比换算在后台无法预览，容易误操作。
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0.01 || price > 999999) return fail(ErrorCode.VALIDATION_FAILED, "价格需在 0.01 - 999999 元之间");
    updates.price = price.toFixed(2);
  } else if (action === "fee") {
    const fee = body.feeRate === "" || body.feeRate == null ? 0 : Number(body.feeRate);
    if (!Number.isFinite(fee) || fee < 0 || fee > 100 || Math.round(fee * 100) !== fee * 100) return fail(ErrorCode.VALIDATION_FAILED, "手续费率需为 0-100 的数字，最多两位小数");
    updates.feeRate = fee.toFixed(2);
  } else if (action === "stock") {
    const stock = body.stock === "" || body.stock == null ? null : Number(body.stock);
    if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 999999)) return fail(ErrorCode.VALIDATION_FAILED, "库存需为 0-999999 的整数，或留空表示不限");
    updates.stock = stock;
  } else if (action === "delivery") {
    const delivery = String(body.delivery || "");
    if (delivery !== "manual" && delivery !== "cdk") return fail(ErrorCode.VALIDATION_FAILED, "交付方式无效");
    updates.delivery = delivery;
  } else {
    return fail(ErrorCode.VALIDATION_FAILED, "未知操作");
  }

  await db.update(plans).set(updates).where(inArray(plans.id, ids));
  invalidatePlansCache();
  logger.audit("plan.bulk_updated", { action, count: ids.length, by: admin.username, ...(updates.price !== undefined ? { price: updates.price } : {}), ...(updates.stock !== undefined ? { stock: String(updates.stock) } : {}), ...(updates.feeRate !== undefined ? { feeRate: updates.feeRate } : {}), ...(updates.active !== undefined ? { active: updates.active } : {}), ...(updates.delivery !== undefined ? { delivery: updates.delivery } : {}) });
  return NextResponse.json({ success: true, count: ids.length }, { headers: { "Cache-Control": "no-store" } });
}
