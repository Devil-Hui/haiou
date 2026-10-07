/**
 * 支付网关契约与安全属性回归测试（常驻）。
 *
 * 为什么要有这个文件：mock 网关的验签、金额精度、生产硬闸门这些是
 * "坏了不会立刻报错"的属性——验签写错时回调全被拒，金额解析放宽时
 * 1.999 会被当成 1.99。上一轮是靠一次性脚本验证的，脚本删掉后就没人再验，
 * 属于典型的"验证过一次就以为永远正确"。
 *
 * 它同时是 buildMockNotification 的唯一消费者——没有它，
 * 「构造合法回调报文」这个能力就是伪需求。
 *
 * 运行：RUN_PAY_TEST=1 npx tsx scripts/pay-gateway.test.mjs
 * 不需要数据库，不产生任何真实支付。
 */
import { mockGateway, buildMockNotification } from "../src/lib/payments/mock.ts";
import { toCents } from "../src/lib/payments/types.ts";
import { requireGateway, gatewayStatus, availableGateways } from "../src/lib/payments/registry.ts";

process.env.MOCK_PAY_SECRET = process.env.MOCK_PAY_SECRET || "test-secret";

let pass = 0, fail = 0;
const ck = (name, ok, extra) => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || !extra ? "" : "  -> " + extra));
  ok ? pass++ : fail++;
};
const verify = async (body) =>
  mockGateway.verifyNotification({ readRawBody: async () => body, headers: new Headers(), clientIp: null });

// ---- 合法回调 ----
const good = buildMockNotification({ orderCode: "TEST123", amount: "119.00" });
try {
  const n = await verify(good);
  ck("合法回调验签通过", n.tradeNo.startsWith("mock_") && n.amount === "119.00", n.tradeNo);
} catch (e) { ck("合法回调验签通过", false, e.message); }

// ---- 篡改金额：签名应失效 ----
try {
  await verify(good.replace("119.00", "1.00"));
  ck("篡改金额被拒", false, "居然通过了");
} catch { ck("篡改金额被拒", true); }

// ---- 移除签名 ----
try {
  const body = new URLSearchParams(good); body.delete("sign");
  await verify(body.toString());
  ck("缺少签名被拒", false, "居然通过了");
} catch { ck("缺少签名被拒", true); }

// ---- 参数污染：重复键必须显式拒绝 ----
try {
  // 字段名必须是 money：mock 协议里的金额字段就叫 money（与支付宝的
  // total_amount、易支付的 money 一致）。写成 amount 会变成"新增一个字段"，
  // 那测的是验签而不是参数污染，断言会因错误的原因通过。
  const body = new URLSearchParams(good); body.append("money", "0.01");
  await verify(body.toString());
  ck("重复参数被显式拒绝", false, "居然通过了");
} catch (e) { ck("重复参数被显式拒绝", /重复参数/.test(e.message), e.message); }

// ---- 金额精度：分以下必须判非法 ----
ck("金额 1.999 判非法", toCents("1.999") === null);
ck("金额 119.00 解析为 11900 分", toCents("119.00") === 11900);
ck("金额 0.01 解析正确", toCents("0.01") === 1);
ck("负数金额判非法", toCents("-1.00") === null);
ck("非数字判非法", toCents("abc") === null);

// ---- 生产环境硬闸门 ----
const prev = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
ck("生产环境禁用 mock（闸门必须生效）", (() => { try { requireGateway("mock"); return false; } catch { return true; } })());
ck("未注册的支付方式报错", (() => { try { requireGateway("nonexistent"); return false; } catch { return true; } })());
// 两个受众必须看到不同的信息，这正是分层过滤的意义：
//   买家侧 availableGateways() —— 绝不能出现 mock，否则等于对外暴露模拟付款；
//   管理员侧 gatewayStatus()   —— 应当看到「存在但被生产禁用」，否则运营会
//                                以为是密钥没配，反复检查无关的地方。
ck("买家侧列表不含 mock（生产）", !availableGateways().some((g) => g.code === "mock"));
ck("管理员侧可见 mock 但标记为生产禁用", gatewayStatus().some((g) => g.code === "mock" && g.disabledInProduction));
process.env.NODE_ENV = prev;

// ---- 回归防线：真实通道不得被网关闸门误锁 ----
// 曾经把 requireGateway() 当作支付前置闸门用在 preparePayment 里，而三条真实
// 通道并未实现 PaymentGateway 接口，于是 requireGateway 一律抛"未注册"，
// 线上一分钱都收不到。这个断言就是为了让同类回归当场暴露。
process.env.MOCK_PAY_SECRET = process.env.MOCK_PAY_SECRET || "test-secret";
const { preparePayment } = await import("../src/lib/payments/payments.ts");
const fakeSettings = {
  id: 1, siteUrl: "https://x.test", walletAddress: "", exchangeRate: "7.2",
  alipayAppId: "", alipaySellerId: "", alipayPublicKey: "", alipayPrivateKey: "",
  epayPid: "", epayGatewayUrl: "", feeRate: "0",
};
const fakeOrder = (method) => ({
  id: "00000000-0000-4000-8000-000000000000", code: "T1", planId: "p", planName: "p",
  brand: "chatgpt", period: "monthly", amount: "119.00", feeAmount: "0.00",
  discountAmount: "0.00", email: "t@e.com", paymentMethod: method, status: "pending",
  note: "", transactionId: null, walletAddress: null, usdtAmount: null,
  createdAt: new Date(), updatedAt: new Date(), expiresAt: null, paidAt: null, canceledAt: null,
});
for (const m of ["usdt", "alipay", "epay"]) {
  try {
    const r = await preparePayment(fakeOrder(m), fakeSettings);
    ck("真实通道 " + m + " 不被闸门误锁（应优雅降级而非抛错）", r.available === false);
  } catch (e) { ck("真实通道 " + m + " 不被闸门误锁（应优雅降级而非抛错）", false, e.message); }
}
process.env.NODE_ENV = "production";
try { await preparePayment(fakeOrder("mock"), fakeSettings); ck("生产环境 mock 仍被硬闸门拦住", false, "未被拦截"); }
catch { ck("生产环境 mock 仍被硬闸门拦住", true); }
process.env.NODE_ENV = prev;

console.log("\n通过 " + pass + " / 失败 " + fail);
if (fail > 0) process.exit(1);
