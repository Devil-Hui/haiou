/**
 * BEpusdt 签名与状态归一化验证。
 *
 * 关键锚点是 **BEpusdt 官方文档给出的签名示例**：`1cd4b52df5587cfb1968b0c0c6e156cd`。
 * 把它复现出来，才能证明"我们理解的 canonical 规则与官方一致"，而不只是"自己验自己"。
 * 单测自己验自己毫无意义——实现与参考同源同函数时，错了也会通过。
 */
import { createHash } from "node:crypto";
import {
  signParams,
  safeEqualHex,
  epusdtTimestampFresh,
  EPUSDT_WEBHOOK_WINDOW_MS,
  EPUSDT_DEFAULT_TRADE_TYPE,
} from "../../src/lib/payments/epusdt";

let pass = 0;
let fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};

// ---- 1. 官方示例签名（最强断言）----
// 文档原文：参数 order_id/amount/notify_url/redirect_url，token=epusdt_password_xasddawqe
// 期望签名：1cd4b52df5587cfb1968b0c0c6e156cd
const official = {
  order_id: "20220201030210321",
  amount: 42,
  notify_url: "http://example.com/notify",
  redirect_url: "http://example.com/redirect",
};
check("官方示例签名可复现（MD5 + token 直连串尾）",
  signParams(official, "epusdt_password_xasddawqe"),
  "1cd4b52df5587cfb1968b0c0c6e156cd");

// ---- 2. token 拼接方式：绝不能有 & ----
// 这是最容易错的一条：几乎所有签名实现都会习惯性加 &key=，
// 而 BEpusdt 是直接拼接。加了就不对，且网关只回笼统错误码。
const canonicalNoToken = "amount=42&notify_url=http://example.com/notify&order_id=20220201030210321&redirect_url=http://example.com/redirect";
check("token 直接拼在串尾（无分隔符）",
  signParams(official, "epusdt_password_xasddawqe"),
  createHash("md5").update(canonicalNoToken + "epusdt_password_xasddawqe", "utf8").digest("hex"));
check("若误加 & 分隔符则签名不同（故此实现不能那样写）",
  createHash("md5").update(canonicalNoToken + "&epusdt_password_xasddawqe", "utf8").digest("hex") !== "1cd4b52df5587cfb1968b0c0c6e156cd",
  true);

// ---- 3. 签名覆盖全部字段 ----
for (const key of Object.keys(official)) {
  check(`篡改 ${key} 会改变签名`,
    signParams({ ...official, [key]: "TAMPERED" }, "epusdt_password_xasddawqe")
    !== signParams(official, "epusdt_password_xasddawqe"), true);
}

// ---- 4. 关键排除规则 ----
check("剔除 signature 自身（否则自引用）",
  signParams({ ...official, signature: "abc" }, "t"), signParams(official, "t"));
check("空字符串不参与签名",
  signParams({ ...official, name: "" }, "t"), signParams({ ...official, name: undefined }, "t"));
check("null 不参与签名",
  signParams({ ...official, name: null } as never, "t"), signParams({ ...official, name: undefined }, "t"));
check("token 变则签名变", signParams(official, "other") !== signParams(official, "t"), true);

// ---- 5. 不做 URL 编码 ----
// notify_url 带 :// 与 & 是常态。编码了就与网关原文不同，
// 而表现是"参数错误"，几乎不可能联想到是编码问题。
const withQuery = { ...official, notify_url: "http://e.com/n?a=1&b=2" };
check("URL 不被编码",
  signParams(withQuery, "t"),
  createHash("md5").update(
    "amount=42&notify_url=http://e.com/n?a=1&b=2&order_id=20220201030210321&redirect_url=http://example.com/redirect" + "t",
    "utf8").digest("hex"));

// ---- 6. 金额归一 ----
// 文档说 amount=0 属"地址独占模式"且 0 不是空值，因此 0 必须参与签名。
// 若把 0 当空值剔除，同一个请求在两种模式下的签名会撞车。
check("amount=0 参与签名（地址独占模式，不是空值）",
  signParams({ ...official, amount: 0 }, "t") !== signParams({ ...official, amount: "" }, "t"), true);
check("数字 42 与字符串 '42' 签名相同（归一）",
  signParams({ ...official, amount: "42" }, "t"), signParams(official, "t"));

// ---- 7. 定长比较 ----
check("safeEqualHex 相同串通过", safeEqualHex("1cd4b52d", "1cd4b52d"), true);
check("safeEqualHex 长度不同拒绝", safeEqualHex("1cd4b52d", "1cd4b52df5"), false);
check("safeEqualHex 内容不同拒绝", safeEqualHex("1cd4b52d", "1cd4b52e"), false);

// ---- 8. 时间窗 ----
check("当前时刻在窗口内", epusdtTimestampFresh(String(Date.now())), true);
check("18 分钟前在窗口内（覆盖前几轮重试）", epusdtTimestampFresh(String(Date.now() - 18 * 60_000)), true);
check("超过窗口拒绝（防重放）", epusdtTimestampFresh(String(Date.now() - (EPUSDT_WEBHOOK_WINDOW_MS + 60_000))), false);
check("非数字拒绝", epusdtTimestampFresh("abc"), false);
check("0 拒绝", epusdtTimestampFresh("0"), false);

// ---- 9. 默认 trade_type ----
// 必须是 usdt.trc20：与本站 USDT 直充通道同一条链，买家不必学两套网络。
check("默认 trade_type", EPUSDT_DEFAULT_TRADE_TYPE, "usdt.trc20");

// ---- 10. 幂等：同一份报文反复验签结果稳定 ----
check("签名可重复（确定性）", signParams(official, "t"), signParams(official, "t"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
