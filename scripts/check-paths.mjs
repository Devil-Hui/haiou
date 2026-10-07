#!/usr/bin/env node
// 路径护栏
//
// 仓库里不允许出现任何"盘符 + 冒号 + 斜杠"形式的绝对路径，docker-compose 的卷
// 也不允许挂到宿主绝对路径。所有路径必须相对仓库根目录，这样项目整目录搬到
// 另一台机器、另一个盘符下依然能直接跑起来。
//
// 这类问题如果靠人工检查，会在"本机好好的、部署就找不到路"的时候才暴露，
// 所以做成一条可重复执行的命令：npm run check:paths
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// 用字符码拼出冒号，避免本文件里的说明文字自己命中这条规则。
// 盘符字母前面必须是行首或非字母数字：否则 "bin:/usr/bin" 这类 Unix 冒号分隔路径
// 会被误判成盘符路径（末尾的 n 后面正好跟着冒号和斜杠）。
const DRIVE = new RegExp("(?:^|[^A-Za-z0-9_])[A-Za-z]" + String.fromCharCode(58) + "[\\\\/](?![\\\\/])");

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".codebuddy", "data", "out", "artifacts"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".sh", ".yml", ".yaml", ".conf", ".service", ".timer", ".json", ".md"]);
const EXTENSIONLESS = new Set(["Dockerfile", ".dockerignore", ".gitignore"]);

const problems = [];
const note = (file, line, text, why) => problems.push(`${file}:${line}  ${why}\n    ${text.trim()}`);

function checkable(name) {
  return EXTENSIONLESS.has(name) || EXTENSIONS.has(name.slice(name.lastIndexOf(".")));
}

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!checkable(entry)) continue;
    const display = relative(ROOT, full).split("\\").join("/");
    readFileSync(full, "utf8").split(/\r?\n/).forEach((text, index) => {
      // 跳过 URL：https://example.com 里的 "s://" 会被排除在规则的负向前瞻之外，
      // 但像 file:// 这类写法仍应放过，所以这里再显式跳过含 :// 的行。
      if (text.includes("://")) return;
      if (DRIVE.test(text)) note(display, index + 1, text, "出现盘符绝对路径");
    });
  }
}

walk(ROOT);

// docker-compose 的卷：宿主一侧必须是相对路径或具名卷，不能是绝对路径
const compose = join(ROOT, "docker-compose.yml");
try {
  readFileSync(compose, "utf8").split(/\r?\n/).forEach((text, index) => {
    const match = /^\s*-\s*([^:]+):\s*(\/\S*)/.exec(text);
    if (match && match[1].trim().startsWith("/")) {
      note("docker-compose.yml", index + 1, text, "卷挂载使用了宿主绝对路径");
    }
  });
} catch { /* 没有 compose 文件时跳过这一项 */ }

if (problems.length) {
  console.error(`发现 ${problems.length} 处路径问题（路径必须相对仓库根目录）：\n`);
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log("路径检查通过：未发现盘符绝对路径，卷挂载均为相对路径。");
