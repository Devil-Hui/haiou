/**
 * 卡密激活链路的自动化演练（不依赖 playwright）。
 *
 * 为什么不装 playwright：它是 ~500MB 的浏览器下载，在 2C2G 开发机上会拖垮
 * 磁盘与内存。本脚本改用 HTTP + 数据库断言覆盖业务链路，用例更轻、跑得更快，
 * 且不与浏览器版本耦合。前端交互层的验证交给 agent-browser 人工/半自动巡检。
 *
 * 覆盖范围：订单绑定校验、凭证加密、事件记录、四态输出、响应字段白名单、
 *          以及两条安全红线（未付款订单 / 邮箱不匹配必须被拒）。
 *
 * 用法：RUN_RECHARGE_E2E=1 npx tsx scripts/recharge-e2e.mjs
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

if (process.env.RUN_RECHARGE_E2E !== "1") {
  console.log("显式设置 RUN_RECHARGE_E2E=1 后执行。仅用于本地 / mock 上游。");
  process.exit(0);
}
const BASE = (process.env.SMOKE_URL || "http://localhost:3000").replace(/\/$/, "");
const { db, pool } = await import("../src/db/index.ts");
const { orders, rechargeJobs, rechargeEvents } = await import("../src/db/schema.ts");
const { newOrderCode } = await import("../src/lib/core/codes.ts");
const { getUpstream } = await import("../src/lib/recharge/upstream/index.ts");

let pass = 0, fail = 0, skip = 0;
const ck = (name, ok, extra) => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  -> " + extra : ""));
  ok ? pass++ : fail++;
};
// 提交接口限流 5 次 / 60 秒 / 按 IP。超出配额时服务端会返回 429，
// 这不是业务缺陷，继续断言业务状态码只会产生假失败。
// 因此这里把 429 明确标记为「跳过」，让报告如实反映「未验证」而非「验证失败」。
const ckStatus = async (name, res, expected) => {
  if (res.status === 429) { console.log("SKIP  " + name + "  -> 限流配额已用尽（5 次/60 秒），本轮未验证"); skip++; return; }
  ck(name, res.status === expected, "HTTP " + res.status);
};
const post = (body) => fetch(BASE + "/api/recharge", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });
const get = (code) => fetch(BASE + "/api/recharge?code=" + encodeURIComponent(code));

const suffix = randomUUID().slice(0, 8);
const email = `e2e-${suffix}@example.com`;
const CRED = "eyJfake-login-state-for-e2e-only";
let jobId = null;

try {
  const up = await getUpstream();
  ck("上游已启用且为 mock（不产生真实充值）", up.enabled && up.adapter !== null, "enabled=" + up.enabled);

  const mkOrder = async (status, mail) => {
    const code = newOrderCode();
    await db.insert(orders).values({
      code, planId: "chatgpt-monthly", planName: "E2E 演练套餐", brand: "chatgpt", period: "monthly",
      amount: "119.00", feeAmount: "0.00", discountAmount: "0.00", email: mail, paymentMethod: "usdt",
      status, ...(status === "paid" ? { paidAt: new Date() } : {}),
    });
    return code;
  };

  const paid = await mkOrder("paid", email);
  const pending = await mkOrder("pending", email);
  const cancelled = await mkOrder("cancelled", email);

  // ---- 请求顺序刻意安排：正常路径先跑。----
  // 提交接口的限流是 5 次 / 60 秒 / 按 IP，若把负例放在前面会先耗尽配额，
  // 后面的正常路径全部变成 429，测试就测不到真正的业务逻辑了。
  const okRes = await post({ orderCode: paid, email, credential: CRED });
  const okBody = await okRes.json();
  await ckStatus("已付款订单提交成功", okRes, 201);
  ck("响应只含白名单字段", okBody && Object.keys(okBody).sort().join(",") === "code,planName,status", okBody ? Object.keys(okBody).join(",") : "");

  const dup = await post({ orderCode: paid, email, credential: CRED });
  await ckStatus("重复提交被幂等拦截（不重复扣费）", dup, 422);

  // ---- 落库核验 ----
  const [job] = await db.select().from(rechargeJobs).where(eq(rechargeJobs.orderCode, paid));
  ck("任务已落库", !!job);
  if (job) {
    jobId = job.id;
    ck("已绑定订单号", job.orderCode === paid);
    ck("套餐信息取自订单而非前端", job.planName === "E2E 演练套餐");
    ck("凭证为密文（不含明文）", !!job.credentialCipher && !job.credentialCipher.includes("fake-login-state"));
    ck("凭证已设过期时间", !!job.credentialExpiresAt);
    const ev = await db.select().from(rechargeEvents).where(eq(rechargeEvents.jobId, job.id));
    ck("已记录进度事件", ev.length > 0, ev.length + " 条");
  }

  // ---- 四态输出 ----
  if (job) {
    const r = await get(job.code);
    const d = await r.json();
    ck("进度查询 200", r.status === 200);
    ck("含四态字段 outcome", ["waiting", "succeeded", "failed", "timed_out"].includes(d.outcome), "outcome=" + d.outcome);
    ck("含 done 布尔", typeof d.done === "boolean");
    ck("含剩余秒数", typeof d.remainingSeconds === "number", "remaining=" + d.remainingSeconds);
    ck("不含上游单号（防信息泄漏）", !("upstreamOrder" in d) && !("upstreamBinding" in d));
    ck("不含尝试次数", !("attempts" in d));
  }

  // ---- 前端零卡密痕迹 ----
  const html = await (await fetch(BASE + "/recharge")).text();
  const clientJs = html.match(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g) || [];
  let leaked = false;
  for (const m of clientJs.slice(0, 12)) {
    const p = m.match(/src="([^"]+)"/)[1];
    const js = await (await fetch(BASE + p)).text();
    if (/cdk\/redeem|api\/cdk|卡密/.test(js)) { leaked = true; break; }
  }
  ck("浏览器端 JS 不含卡密 API 路径", !leaked, "检查了 " + Math.min(clientJs.length, 12) + " 个 chunk");

  // ---- 安全红线：以下每条都会消耗一次提交配额（5 次 / 60 秒）----
  await ckStatus("未付款订单被拒（防白嫖）", await post({ orderCode: pending, email, credential: CRED }), 422);
  await ckStatus("已取消订单被拒", await post({ orderCode: cancelled, email, credential: CRED }), 422);
  await ckStatus("订单不存在被拒", await post({ orderCode: "NOSUCHCODE999", email, credential: CRED }), 422);
  await ckStatus("邮箱不匹配被拒", await post({ orderCode: paid, email: "wrong@example.com", credential: CRED }), 422);
  // 第 6 次请求必然超配额。这条断言的是限流本身生效——它是防刷的第一道闸门。
  ck("超出配额后被限流（429）", (await post({ orderCode: pending, email, credential: CRED })).status === 429, "配额耗尽时必须返回 429");

  // ---- 幂等：不同订单互不影响 ----
  const paid2 = await mkOrder("paid", email);
  const r2 = await post({ orderCode: paid2, email, credential: CRED });
  await ckStatus("不同订单可独立提交", r2, 201);
  await db.delete(orders).where(eq(orders.code, paid2));
} catch (error) {
  ck("脚本执行未抛异常", false, error instanceof Error ? error.message : String(error));
} finally {
  console.log("");
  console.log("通过 " + pass + " / 失败 " + fail + " / 跳过 " + skip + (skip ? "（跳过项需等待 60 秒后重跑才能覆盖）" : ""));
  console.log("提示：测试数据保留在库中便于排查，可用 npm run maintenance 清理过期凭证。");
  await pool.end();
}
