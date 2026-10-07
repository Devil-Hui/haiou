import { ok, readJson, apiError, ErrorCode } from "@/lib/core";
import { isValidCdk, normalizeCdk } from "@/lib/core";
import { getCdkRule } from "@/lib/catalog/store";
import { redeemCardKey } from "@/lib/cdk";
import { rateLimitResult, sameOrigin, validEmail } from "@/lib/auth";
import { invalidatePlansCache } from "@/lib/catalog";
import { logger } from "@/lib/core";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  // 卡密本身是 80 bit 随机，但校验接口仍必须限流：没有它，这个接口就是一个
  // "哪些卡密是有效的"探测器，也能被拿去刷数据库。
  {
    const rl = rateLimitResult(request, "cdk-redeem", 10);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "尝试过于频繁，请一分钟后重试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }

  const body = await readJson(request);
  if (!body) return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);

  const code = String(body.code || "");
  const email = String(body.email || "").trim().toLowerCase();
  // 校验必须用「当前配置」的规则。若这里用默认规则，运营一旦改前缀，
  // 所有已售出但未核销的卡会立刻被判为无效——这是规则可配置化最容易踩的坑。
  const rule = await getCdkRule();
  if (!validEmail(email) || !isValidCdk(normalizeCdk(code), rule)) return apiError(ErrorCode.VALIDATION_FAILED, "请填写有效的卡密与账号邮箱", 400);

  try {
    const order = await redeemCardKey(code, email);
    // 不存在 / 已使用 / 已作废 一律同一句提示：区分它们等于把枚举结果告诉对方
    if (!order) {
      logger.audit("cdk.redeem_rejected", { reason: "unknown_used_or_revoked" });
      return apiError(ErrorCode.CONFLICT_STATE, "卡密无效或已被使用", 400);
    }
    invalidatePlansCache(); // 核销把卡密转为 used，卡密池 unused 计数随之变化
    logger.audit("cdk.redeemed", { order: order.code, plan: order.planName });
    return ok(order, 201);
  } catch (error) {
    // 事务已回滚，卡密退回未使用状态
    logger.error("cdk.redeem_failed", {}, error);
    return apiError(ErrorCode.INTERNAL, "卡密暂时无法核销，请稍后重试或联系客服", 409);
  }
}
