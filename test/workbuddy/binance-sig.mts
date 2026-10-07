import { signRequest } from "../../src/lib/payments/gateway-api";
import { createHmac } from "node:crypto";

// 用官方文档的算法手写一份做交叉验证。
// 单测自己验自己毫无意义——若实现与手写参考同源同函数，
// 错了也会"通过"。这里刻意独立重写一遍算法作为第二实现。
const reference = (body: string, ts: string, np: string, secret: string) =>
  createHmac("sha512", secret)
    .update(ts + "\n" + np + "\n" + body + "\n")
    .digest("hex")
    .toUpperCase();

const cases = [
  { body: '{"merchantTradeNo":"A1B2C3"}', ts: "1700000000000", np: "abcdefghijklmnopqrstuvwxyz123456", secret: "s3cr3t" },
  { body: "{}", ts: "1234567890123", np: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", secret: "" },
  { body: '{"a":1,"b":"中文"}', ts: "9999999999999", np: "nonce-with-32-chars-abcdefg", secret: "another-secret-key" },
];

let pass = 0;
for (const c of cases) {
  const ours = signRequest(c.body, c.ts, c.np, c.secret);
  const ref = reference(c.body, c.ts, c.np, c.secret);
  const ok = ours === ref;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  body=${c.body.slice(0, 24)}  sig=${ours.slice(0, 24)}...`);
}

// 反向断言：改动任一要素都必须导致签名变化。
// 币安对这三个字段都参与签名，少任何一个都会 400 —— 而报错信息不提示缺哪个。
const base = signRequest("{}", "1", "n", "k");
const negatives = [
  ["少首尾换行", signRequest("{}", "1", "n", "k") !== (await import("node:crypto")).createHmac("sha512", "k").update("1\nn\n{}").digest("hex").toUpperCase()],
  ["body 变一个字节", signRequest("{ }", "1", "n", "k") !== base],
  ["timestamp 变", signRequest("{}", "2", "n", "k") !== base],
  ["nonce 变", signRequest("{}", "1", "m", "k") !== base],
  ["secret 变", signRequest("{}", "1", "n", "j") !== base],
] as const;

let negPass = 0;
for (const [label, ok] of negatives) {
  if (ok) negPass++;
  console.log(`${ok ? "PASS" : "FAIL"}  负例：${label}`);
}

console.log(`\n正例 ${pass}/${cases.length} · 负例 ${negPass}/${negatives.length}`);
if (pass !== cases.length || negPass !== negatives.length) process.exit(1);
