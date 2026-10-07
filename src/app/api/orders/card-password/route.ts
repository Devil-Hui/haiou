import { NextResponse } from "next/server";
import { hashPassword, rateLimitResult, sameOrigin, strongAdminPassword, validEmail } from "@/lib/auth";
import { logger, readJson, apiError, ErrorCode } from "@/lib/core";
import { rewriteOwnerCardPassword, verifyOwnerCardPassword } from "@/lib/catalog";

// 忘记取卡密码 → 重置。
//
// 【为什么不需要邮件验证码】
// 本站没有任何邮件发送能力（依赖表里没有 SMTP / nodemailer / resend），
// 而「邮箱验证码重置」的前提是**你已经能证明自己拥有这个邮箱**。
// 本站注册同样没有邮箱所有权验证——任何人注册他人邮箱都能拿到账号。
// 因此「发验证码到购买邮箱」在这里**不构成任何额外的身份证明**：
// 攻击者注册 victim@x.com 之后，照样能让验证码发到 victim@x.com，
// 他收不到，但重置流程的门槛并没有因此变高。
//
// 【这里采用的证明方式】
// 「旧取卡密码」本身就是这个邮箱的账号级凭据，只有本人知道。
// 知道旧密码 = 证明是这个邮箱的主人，与 Dujiao 这类成熟发卡系统的做法一致
// （它们的访客凭据同样是 email + order_password）。
//
// 【安全基线】
//   · sameOrigin：挡跨站 CSRF，防止他人诱导 victim's 浏览器发起重置
//   · 限流 5次/分：scrypt 是内存硬计算，不限流等于开放 CPU 放大攻击
//   · 旧密码校验复用 verifyOwnerCardPassword —— 与查单同一套判定，
//     杜绝「查得到订单但重置失败」这类分裂
//   · 全程留痕：audit 记录成功与失败
const NO_STORE = { "Cache-Control": "no-store" } as const;
// 重置密码的响应同样必须 no-store。code 由调用点按语义传。
const fail = (code: (typeof ErrorCode)[keyof typeof ErrorCode], error: string, status = 400, retryAfterSec?: number) =>
  apiError(code, error, status, retryAfterSec ? { ...NO_STORE, "Retry-After": String(retryAfterSec) } : NO_STORE);

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "reset-card-password", 5);
    if (!rl.allowed) return fail(ErrorCode.RATE_LIMITED, "尝试过于频繁，请稍后再试", 429, rl.retryAfterSec);
  }
  const body = await readJson(request);
  if (!body) return fail(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);

  const email = String(body.email || "").trim().toLowerCase();
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");

  if (!validEmail(email)) return fail(ErrorCode.VALIDATION_FAILED, "购买邮箱格式不正确", 400);
  if (next.length < 12 || next.length > 128) return fail(ErrorCode.VALIDATION_FAILED, "新密码至少 12 位", 400);
  if (!strongAdminPassword(next, email.split("@")[0])) {
    return fail(ErrorCode.VALIDATION_FAILED, "新密码不能是常见弱口令、重复字符，也不能包含邮箱前缀", 400);
  }

  try {
    const owned = await verifyOwnerCardPassword(email, current);
    if (owned.length === 0) {
      // 与查单接口保持同一句文案：不区分「邮箱不存在」与「旧密码错」，
      // 否则攻击者可以用响应差异探测哪些邮箱在本站下过单。
      logger.audit("card_password_reset_failed", { email: `${email.slice(0, 2)}***` });
      return fail(ErrorCode.AUTH_INVALID, "购买邮箱或原密码不正确", 401);
    }

    // 改写该邮箱名下**所有**已设密码的订单：取卡密码是账号级凭据，
    // 不是每单一份。只改命中的那几笔会留下「有的单要新密码、有的单还要旧密码」
    // 的分裂状态，比不改更容易让用户困惑。
    const changed = await rewriteOwnerCardPassword(email, hashPassword(next));
    logger.audit("card_password_reset_ok", { email: `${email.slice(0, 2)}***`, changed });
    return NextResponse.json({ ok: true, changed }, { headers: NO_STORE });
  } catch {
    return fail(ErrorCode.INTERNAL, "重置失败，请稍后重试", 500);
  }
}