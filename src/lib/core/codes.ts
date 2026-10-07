import { randomBytes } from "node:crypto";
import { CDK_ALPHABET, formatCdk, type CdkRule, DEFAULT_CDK_RULE } from "./cdk-format";

// 随机源相关（依赖 node:crypto，不能进浏览器包）。
// 格式与校验逻辑在 ./cdk-format，那是纯函数，客户端预览与服务端生成共用同一份。

// 订单号：AU + 日期 + 8 位十六进制。查询入口按该格式校验，改格式需同步改查询端。
export function newOrderCode() {
  return `AU${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * 生成卡密明文。
 *
 * 强度来自主体：bodyLength x 5 bit 随机（默认 16 -> 80 bit），远高于订单号的 32 bit。
 * 前缀是固定公开串，不消耗也不增加随机性，因此开放自定义前缀不影响抗枚举能力。
 * 校验接口另有速率限制，爆破不成立。
 */
export function newCdk(rule: CdkRule = DEFAULT_CDK_RULE): string {
  const bytes = randomBytes(Math.ceil((rule.bodyLength * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let raw = "";
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && raw.length < rule.bodyLength) {
      raw += CDK_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return formatCdk(raw, rule);
}

// 格式与校验从纯模块转出，保持既有导入路径可用，且不产生第二份实现。
export * from "./cdk-format";
