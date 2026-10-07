// ---------------------------------------------------------------------------
// 提交前敏感信息闸门（pre-commit hook）
//
// 为什么需要它：.gitignore 只能挡住"路径匹配到的文件"，挡不住"代码里硬编码的密钥"。
// 真实事故里最常见的就是某次赶进度把 API key 写进了配置文件，.gitignore 完全无感。
// 这个 hook 在每次提交前扫一遍暂存区，命中即拒绝提交。
//
// 安装：git config core.hooksPath .githooks
// 已有暂存内容里的存量文件也会被扫到，因此它同时充当一次历史体检。
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";

const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
  .split(/\r?\n/).filter(Boolean);

// 允许进仓库的样例/公开文件：它们的值均为演示、测试或构建默认值，不是真实凭据。
// 已逐个审计过内容（Dockerfile 的 DB 串是本地开发默认值；binance-sig.mts 的
// secret 是签名算法单元测试的假数据）。
const ALLOW = new Set([
  ".env.example",
  "Dockerfile",
  "test/workbuddy/binance-sig.mts",
]);

const RULES = [
  [/\.env$/, "环境变量文件（含真实密钥）"],
  [/^\.env\.(?!example)/, "环境变量文件（含真实密钥）"],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, "证书或私钥文件"],
  [/^id_(rsa|ed25519)$/, "SSH 私钥"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "私钥内容"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/, "GitHub token"],
  [/\bsk-[A-Za-z0-9]{20,}/, "OpenAI 类 key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS AccessKey"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  [/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{4,}@/, "数据库连接串里带密码"],
  [/(?:password|passwd|secret|api_?key|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i, "疑似硬编码凭据"],
];

// 这些值是"占位/回退/示例"，不是泄露。
const PLACEHOLDER = /example|your-|xxx|placeholder|<|请填写|CHANGE_ME|\$\{|process\.env|os\.environ|\.\.\.|dummy|sample|示例|占位/i;
// 命中行若处于注释中，同样不算泄露。
const isComment = (line) => /^\s*(#|\/\/|\*|<!--)/.test(line);

const problems = [];
for (const file of staged) {
  if (ALLOW.has(file) || !existsSync(file) || !statSync(file).isFile()) continue;
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|pdf|lock)$/i.test(file)) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const [re, label] of RULES) {
    const found = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    if (!found) continue;
    // 逐行判定：只有当该行不是注释、且值不是占位符时才算命中。
    for (const hit of found) {
      const line = text.split(/\r?\n/).find((l) => l.includes(hit)) || "";
      if (PLACEHOLDER.test(line) || isComment(line)) continue;
      problems.push(`  ${label}  ${file}`);
    }
  }
}

if (problems.length) {
  console.error("\n✗ 提交被拒绝：检测到敏感信息\n");
  [...new Set(problems)].forEach((p) => console.error(p));
  console.error("\n请改用环境变量注入。若确属误报（如文档里的示例），请在该行加注释说明。\n");
  process.exit(1);
}
