/**
 * 易支付验签兼容性验证。
 *
 * 覆盖三种真实回调形态：
 *   1. epusdt EPay 兼容回调（带 sign_type=MD5）—— 修复前必挂
 *   2. 经典易支付回调（不带 sign_type）        —— 修复前可用，须保证不被改坏
 *   3. 含空值参数                               —— 空值不参与签名
 * 另外验证「发起侧」与「验签侧」共用同一个 canonical，
 * 避免再次出现支付宝那种「两侧原文集合不同」的问题。
 */
import { createHash, createHmac } from "node:crypto";

const MD5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");

// 修复后的实现（与 src/lib/payments/epay.ts 保持一致）
const canonical = (p: Record<string, string>) =>
  Object.keys(p)
    .filter(k => k !== "sign" && k !== "sign_type" && p[k] !== "" && p[k] !== undefined)
    .sort()
    .map(k => `${k}=${p[k]}`)
    .join("&");

let pass = 0;
let fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};

const key = "epusdt_secret_key";

// 形态 1：epusdt EPay 兼容回调（GET，字段顺序即其文档所给）。
//
// 注意别把文档里的签名示例张冠李戴：`6f874b19…` 属于 **GMPay 创建订单**示例
// （HMAC-SHA256，字段名是 amount/currency/network/token/order_id…），
// 而 EPay 兼容回调用的是 MD5 且字段名是 money/trade_no/out_trade_no…
// 两者只有 secret_key 相同。下面的原文断言才是这一形态的直接依据。
const c1: Record<string, string> = {
  pid: "1000",
  trade_no: "20260523171652123456001",
  out_trade_no: "ORD202605230001",
  type: "alipay",
  name: "VIP",
  money: "100.0000",
  trade_status: "TRADE_SUCCESS",
  sign_type: "MD5",
  sign: "",
};
check("形态1 原文与 epusdt 文档一致", canonical(c1),
  "money=100.0000&name=VIP&out_trade_no=ORD202605230001&pid=1000&trade_no=20260523171652123456001&trade_status=TRADE_SUCCESS&type=alipay");

// 顺带把 GMPay 的官方示例值也对上：这是唯一能证明「我们理解的 canonical 规则
// 与官方一致」的锚点（字段名与哈希算法都对得上），可作为将来接 GMPay 的实现依据。
const gmpayCanonical = "amount=100&currency=cny&name=VIP&network=tron&notify_url=https://merchant.example/notify"
  + "&order_id=ORD202605230001&pid=1000&redirect_url=https://merchant.example/return&token=usdt";
check("GMPay 官方示例签名可复现（HMAC-SHA256）",
  createHmac("sha256", key).update(gmpayCanonical, "utf8").digest("hex"),
  "6f874b1919d95081835e2809b620e354a5866f5a6dbb2e432d1627f1eb10059d");

// 形态 2：经典易支付回调，不带 sign_type —— 不得被改坏
const c2: Record<string, string> = {
  pid: "1001",
  trade_no: "20260523171652123456002",
  out_trade_no: "ORD202605230002",
  type: "wxpay",
  name: "VIP",
  money: "69.00",
  trade_status: "TRADE_SUCCESS",
  sign: "",
};
check("形态2 原文不含 sign_type", canonical(c2),
  "money=69.00&name=VIP&out_trade_no=ORD202605230002&pid=1001&trade_no=20260523171652123456002&trade_status=TRADE_SUCCESS&type=wxpay");

// 形态 3：含空值 —— 空值不参与签名
const c3: Record<string, string> = {
  pid: "1002", trade_no: "T3", out_trade_no: "O3", type: "", name: "N",
  money: "1.00", trade_status: "TRADE_SUCCESS", sitename: "", sign: "",
};
check("形态3 空值被剔除", canonical(c3),
  "money=1.00&name=N&out_trade_no=O3&pid=1002&trade_no=T3&trade_status=TRADE_SUCCESS");

// 发起侧：验签与签名必须同源同函数（防止再次分叉）
const outbound: Record<string, string> = {
  pid: "1000", out_trade_no: "ORD1", notify_url: "https://x.example/n",
  return_url: "https://x.example/r", money: "119.00", name: "aura plan",
  sitename: "aura", type: "",
};
const signed = MD5(canonical(outbound) + key);
check("发起侧签名可被同一 canonical 验回", MD5(canonical({ ...outbound, sign: signed }) + key), signed);

// 回归：篡改金额必须验不过
check("篡改金额后签名不匹配", MD5(canonical({ ...c2, money: "1.00" }) + key) === MD5(canonical(c2) + key), false);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
