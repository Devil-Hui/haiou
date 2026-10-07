import { NextResponse } from "next/server";
import { adminAccess } from "@/lib/admin/access";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { coupons } from "@/db/schema";
import { currentAdmin, rateLimit, sameOrigin } from "@/lib/auth";
import { readJson, apiError, ErrorCode } from "@/lib/core";
import { digest } from "@/lib/auth";
import { newCdk, normalizeCdk } from "@/lib/core";

/** 券码规则：16 位无前缀。券与卡是两套凭据，不共用前缀。 */
const COUPON_RULE = { prefix: "", bodyLength: 16, groupSize: 4, separator: "-", acceptLegacy: true };
import { logger } from "@/lib/core";

const NO_STORE = { "Cache-Control": "no-store" } as const;
// 校验类错误统一 400 且带 code；fail 尾带 pid 或 auth 时按调用点给码。
const bad = (error: string) => apiError(ErrorCode.VALIDATION_FAILED, error, 400, NO_STORE);
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status: number) =>
  apiError(code, error, status, NO_STORE);

// 批量生成券码。与卡密同一原则：只存摘要，明文仅在本次响应返回一次。
export async function GET(request: Request) {
  // ADMIN_ACCESS 闸门。此前只有 /admin 页面查这个开关，API 侧一律放行 ——
  // 于是在「后台不对外」的生产环境里，这些接口依然可达。
  // 本路由不经过 admin-api 的 handle（那是 [resource] 专用），所以必须自己查。
  // 放在最前面，连鉴权与限流都不做：开关关闭时接口应当表现为「不存在」。
  if (!adminAccess().allowed) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404, NO_STORE);

  if (!rateLimit(request, "admin-api", 120)) return fail(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429);
  if (!(await currentAdmin())) return fail(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
  const rows = await db.select().from(coupons).orderBy(desc(coupons.createdAt)).limit(200);
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

  const action = String(body.action || "");

  if (action === "generate") {
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) return bad("单次生成数量需在 1-500 之间");
    const discount = Number(body.discountAmount);
    if (!Number.isFinite(discount) || discount <= 0 || discount > 999999) return bad("抵扣金额需大于 0 且不超过 999999");
    const minAmount = body.minAmount === "" || body.minAmount == null ? 0 : Number(body.minAmount);
    if (!Number.isFinite(minAmount) || minAmount < 0) return bad("使用门槛需为不小于 0 的数字");
    const totalLimit = body.totalLimit === "" || body.totalLimit == null ? null : Number(body.totalLimit);
    if (totalLimit !== null && (!Number.isInteger(totalLimit) || totalLimit < 1)) return bad("总次数上限需为正整数，或留空表示不限");
    const perUserLimit = body.perUserLimit === "" || body.perUserLimit == null ? 1 : Number(body.perUserLimit);
    if (!Number.isInteger(perUserLimit) || perUserLimit < 0 || perUserLimit > 1000) return bad("每人限用次数需为 0-1000 的整数");
    const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) return bad("过期时间格式无效");
    const note = String(body.note || "").trim().slice(0, 200);

    // 券码复用卡密的随机算法（同样的 80 bit 强度），但不带卡密前缀：
    // 券码与卡密是两套凭据，混用前缀会让买家分不清手上那张是券还是卡，
    // 也会让运营在排查时误判凭据类型。券码保持 16 位无前缀的经典形态。
    const codes = Array.from({ length: quantity }, () => newCdk(COUPON_RULE));
    await db.insert(coupons).values(
      codes.map((code) => ({
        codeHash: digest(normalizeCdk(code)),
        discountAmount: discount.toFixed(2),
        minAmount: minAmount.toFixed(2),
        totalLimit,
        perUserLimit,
        expiresAt,
        note,
      })),
    );
    logger.audit("coupon.generated", { count: quantity, discount: discount.toFixed(2), totalLimit, by: admin.username });
    // 明文只随这一次响应返回，库里没有也无法再取回。
    return NextResponse.json({ codes }, { status: 201, headers: NO_STORE });
  }

  if (action === "toggle" || action === "delete") {
    const id = String(body.id || "");
    if (!id) return bad("券码不存在");
    if (action === "delete") {
      // 已产生订单的券不能物理删除：删了会导致历史订单的券码变成"查无此券"。
      // 运营应改用停用。
      const [used] = await db.select({ id: coupons.id }).from(coupons).where(eq(coupons.id, id));
      if (!used) return fail(ErrorCode.NOT_FOUND, "券码不存在", 404);
      await db.delete(coupons).where(eq(coupons.id, id));
      logger.audit("coupon.deleted", { id, by: admin.username });
      return NextResponse.json({ success: true }, { headers: NO_STORE });
    }
    const [row] = await db.select({ active: coupons.active }).from(coupons).where(eq(coupons.id, id));
    if (!row) return fail(ErrorCode.NOT_FOUND, "券码不存在", 404);
    const active = !row.active;
    await db.update(coupons).set({ active }).where(eq(coupons.id, id));
    logger.audit("coupon.toggled", { id, active, by: admin.username });
    return NextResponse.json({ success: true, active }, { headers: NO_STORE });
  }

  return bad("未知操作");
}
