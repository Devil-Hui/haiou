import { db } from "@/db";
import { sql } from "drizzle-orm";
import { rateLimit } from "@/lib/auth";

export const dynamic = "force-dynamic";

// 全站唯一的「裸 429 出口」。其它所有限流都走 rateLimitResult + apiError/json，
// 统一注入 Retry-After（RFC 6585）——只有 health 此前用裸 Response.json，命中
// 限流时连重试等待信号都不给，成为限流行为里的一个不一致分支。这里补齐：
// 429 同样带 Retry-After + no-store（健康检查接口也不该被中间缓存留存结果）。
export async function GET(request: Request) {
  // Public and unauthenticated, so it must not become an open door to the database.
  // The ceiling is deliberately far above any real probe interval (600/min ≈ 10/s against a
  // typical 1/5s liveness check), so a healthy deployment can never be throttled into being
  // reported as unhealthy.
  if (!rateLimit(request, "health", 600)) {
    return Response.json({ ok: false }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
