// 浏览器端的卡密样例生成。
//
// 为什么单独存在：预览必须能在客户端算出来（改一个输入就立刻看到结果），
// 但绝不能因此复制一份生成算法——两份算法迟早漂移，届时"预览"就成了骗人的东西。
// 所以这里只做一件事：把浏览器里没有的 node:crypto 换成 Web Crypto，
// 其余字母表、分组、校验全部复用 @/lib/core 里那份唯一实现。
// 刻意从 @/lib/core/cdk-format 深引，**不能走 @/lib/core barrel**。
//
// barrel 会 export * 把 log-sink.ts 一起拉进来，而它 import 了 node:fs/promises
// —— 于是服务端模块进了浏览器 chunk，表现为 `next build` 直接失败：
//   Failed to write app endpoint /admin/(dashboard)/cdk/page
//   the chunking context does not support external modules (request: node:fs/promises)
//
// 这不是理论风险，是 `npm run build` 实际报出来的错。dev 模式不构建 chunk，
// 所以本地开发一切正常，只有生产构建才暴露。
import { formatCdk, type CdkRule } from "@/lib/core/cdk-format";

/** 浏览器端随机字节。优先用 Web Crypto；不可用时返回 null 而不是降级到 Math.random。 */
function randomBytes(n: number): Uint8Array | null {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return null;
  const buf = new Uint8Array(n);
  c.getRandomValues(buf);
  return buf;
}

/**
 * 生成一张样例卡。
 * 拿不到安全随机源时返回一个占位串并显式说明，而不是悄悄用 Math.random 糊弄——
 * 后者会让运营误以为预览是真的。
 */
export function newCdkPreview(rule: CdkRule): string {
  const bytes = randomBytes(Math.ceil((rule.bodyLength * 5) / 8));
  if (!bytes) return "（当前环境不支持安全随机数，无法生成预览样例）";
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let buffer = 0;
  let bits = 0;
  let raw = "";
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && raw.length < rule.bodyLength) {
      raw += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return formatCdk(raw, rule);
}
