import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { checkPassword, clearLoginFailures, createSession, currentAdmin, destroySession, hashPassword, isLegacyHash, loginDelayMs, maskIdentity, rateLimitResult, recordLoginFailure, safeEqual, sameOrigin, sleep, strongAdminPassword, validAdminPassword, validAdminUsername } from "@/lib/auth";
import { ok, readJson, apiError, ErrorCode } from "@/lib/core";
import { logger } from "@/lib/core";
import { adminAccess } from "@/lib/admin/access";

const setupToken = () => process.env.ADMIN_SETUP_TOKEN;
const setupBlocked = () => !setupToken() && process.env.NODE_ENV === "production";

// Verified against whenever the account does not exist, so a missing or mismatched
// username costs the same scrypt work as a wrong password. Kills user enumeration.
const TIMING_EQUALIZER = hashPassword("haiou-admin-credential-equalizer");

// 闸门：ADMIN_ACCESS 未开启时整个后台不存在，接口也必须一样。
// 此前只有页面（layout / 登录页）查它，这个接口不查——登录页 404 而 POST /api/auth
// 照常工作，任何人都能对管理员口令做在线爆破，页面层的「默认关闭」被完全绕过。
// 与页面保持一致返回 404（403 等于确认「这里有个后台」）。
const gate = () => adminAccess().allowed;

export async function GET() {
  if (!gate()) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404);
  const [admin] = await db.select({ id: admins.id }).from(admins).limit(1);
  return ok({ needsSetup: !admin, setupTokenRequired: !!setupToken(), setupBlocked: setupBlocked() });
}

export async function POST(request: Request) {
  if (!gate()) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404);
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  const loginRl = rateLimitResult(request, "admin-login", 6);
  if (!loginRl.allowed) return apiError(ErrorCode.RATE_LIMITED, "尝试过于频繁，请一分钟后重试", 429, { "Retry-After": String(loginRl.retryAfterSec) });
  const body = await readJson(request);
  if (!body) return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  try {
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const [existing] = await db.select().from(admins).limit(1);
    if (body.action === "setup") {
      if (!validAdminUsername(username) || !strongAdminPassword(password, username)) return apiError(ErrorCode.VALIDATION_FAILED, "用户名需为 3–30 位字母、数字或下划线；密码至少 12 位，且不能是常见弱口令、重复字符或包含用户名", 400);
      if (existing) return apiError(ErrorCode.CONFLICT_STATE, "管理员已创建，请使用已有账号登录", 409);
      if (setupBlocked()) return apiError(ErrorCode.NOT_CONFIGURED, "部署未配置 ADMIN_SETUP_TOKEN，已拒绝初始化。请先在服务器设置该变量后重试。", 503);
      const expected = setupToken();
      if (expected) {
        // Surfaced in the server log, not the response: a short token still works (refusing it
        // could strand an operator mid-initialisation), but it should not pass silently.
        if (expected.length < 16) logger.warn("admin.setup_token_weak", { detail: "ADMIN_SETUP_TOKEN 少于 16 个字符，可被穷举，建议更换为随机长串" });
        const provided = Buffer.from(String(body.setupToken || ""));
        const target = Buffer.from(expected);
        if (provided.length !== target.length || !timingSafeEqual(provided, target)) {
          logger.warn("admin.setup_token_invalid", { username: maskIdentity(username) });
          return apiError(ErrorCode.AUTH_INVALID, "初始化令牌不正确", 403);
        }
      }
      const [created] = await db.insert(admins).values({ id: 1, username, passwordHash: hashPassword(password) }).onConflictDoNothing().returning({ id: admins.id });
      if (!created) return apiError(ErrorCode.CONFLICT_STATE, "管理员已初始化，请重新登录", 409);
      logger.audit("admin.setup_completed", { username: maskIdentity(username) });
      await createSession(created.id);
      return ok({ success: true });
    }
    if (body.action === "login") {
      const key = username.slice(0, 64).toLowerCase() || "unknown";
      const delay = loginDelayMs(key);
      if (delay) await sleep(delay);
      // Oversized or out-of-range input still costs one full scrypt pass, so response
      // cost never depends on how plausible the submitted credentials looked.
      const plausible = username.length <= 128 && validAdminPassword(password);
      const usernameMatches = plausible && !!existing && safeEqual(existing.username, username);
      const passwordMatches = await checkPassword(plausible ? password : "", usernameMatches ? existing!.passwordHash : TIMING_EQUALIZER);
      if (!existing || !usernameMatches || !passwordMatches) {
        recordLoginFailure(key);
        logger.warn("admin.login_failed", { username: maskIdentity(username) });
        return apiError(ErrorCode.AUTH_INVALID, "用户名或密码不正确", 401);
      }
      clearLoginFailures(key);
      // Transparent upgrade: hashes written before cost parameters were recorded still verify
      // under their legacy parameters, then are rewritten in the current format right here —
      // so a stronger cost rolls out without forcing anyone through a password reset.
      if (isLegacyHash(existing.passwordHash)) {
        await db.update(admins).set({ passwordHash: hashPassword(password) }).where(eq(admins.id, existing.id));
        logger.audit("admin.password_hash_upgraded", { username: maskIdentity(existing.username) });
      }
      logger.audit("admin.login_succeeded", { username: maskIdentity(existing.username) });
      await createSession(existing.id);
      return ok({ success: true });
    }
    return apiError(ErrorCode.VALIDATION_FAILED, "无效操作", 400);
  } catch (error) {
    // 不再静默吞掉异常：认证异常必须留痕，否则线上只能看到"服务不可用"而无从排查。
    logger.error("admin.auth_failed", { action: String(body.action ?? "unknown") }, error);
    return apiError(ErrorCode.INTERNAL, "认证服务暂时不可用，请稍后重试", 500);
  }
}

export async function DELETE(request: Request) {
  if (!gate()) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404);
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  await destroySession();
  return ok({ success: true });
}

// Separate from POST so credential rotation gets its own throttle bucket and its own error
// semantics, instead of sharing the login limiter with a very different risk profile.
export async function PATCH(request: Request) {
  if (!gate()) return apiError(ErrorCode.NOT_FOUND, "接口不存在", 404);
  if (!sameOrigin(request)) return apiError(ErrorCode.FORBIDDEN_ORIGIN, "请求来源无效", 403);
  {
    const rl = rateLimitResult(request, "admin-password", 5);
    if (!rl.allowed) return apiError(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后重试", 429, { "Retry-After": String(rl.retryAfterSec) });
  }
  const body = await readJson(request);
  if (!body) return apiError(ErrorCode.VALIDATION_FAILED, "请求内容无效", 400);
  try {
    const session = await currentAdmin();
    if (!session) return apiError(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const next = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!strongAdminPassword(next, session.username)) return apiError(ErrorCode.VALIDATION_FAILED, "新密码至少 12 位，且不能是常见弱口令、重复字符或包含用户名", 400);
    const [admin] = await db.select({ passwordHash: admins.passwordHash }).from(admins).where(eq(admins.id, session.id));
    if (!admin) return apiError(ErrorCode.AUTH_REQUIRED, "登录已失效，请重新登录", 401);
    // The current password is a second factor: a stolen session alone must not be enough to
    // take the account over by changing its credential.
    if (!current || !(await checkPassword(current, admin.passwordHash))) {
      logger.warn("admin.password_change_rejected", { username: maskIdentity(session.username) });
      return apiError(ErrorCode.AUTH_INVALID, "当前密码不正确", 401);
    }
    if (await checkPassword(next, admin.passwordHash)) return apiError(ErrorCode.VALIDATION_FAILED, "新密码不能与当前密码相同", 400);
    await db.update(admins).set({ passwordHash: hashPassword(next) }).where(eq(admins.id, session.id));
    // Overwrites the stored session digest, so every other signed-in device and stale tab is
    // signed out immediately — no extra table or column needed.
    await createSession(session.id);
    logger.audit("admin.password_changed", { username: maskIdentity(session.username) });
    return ok({ success: true });
  } catch (error) {
    // session 声明在 try 内，catch 中取不到；这里只记事件与异常，不猜主体。
    logger.error("admin.password_change_failed", {}, error);
    return apiError(ErrorCode.INTERNAL, "认证服务暂时不可用，请稍后重试", 500);
  }
}
