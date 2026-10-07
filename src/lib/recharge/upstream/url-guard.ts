import { isIP } from "node:net";

/**
 * 上游地址的安全校验。
 *
 * 为什么需要独立成模块：后台的 baseUrl 是**运营自由填写**的，而服务器会去
 * 访问它。仅校验"以 http(s) 开头"等于开了一个内网探测器 + 一条数据外泄管道：
 *   · http://169.254.169.254/latest/meta-data/  -> 读云厂商元数据（可拿到临时密钥）
 *   · http://127.0.0.1:5432 / 10.0.0.1:6379   -> 扫内网服务
 *   · https://attacker.example                  -> 每次调用都把 UPSTREAM_SECRET
 *                                                  与买家凭证发过去
 * 三条都是**同一个洞**：目标不受限制。
 *
 * 这里做两层：
 *   1. 协议只允许 https（http 仅在显式开关且非生产时放行，防内网明文嗅探）；
 *   2. 拒绝所有指向本机/私网/链路本地的字面量地址。
 *
 * ⚠ 已知残留：DNS 重绑定（域名先解析到公网、第二次解析到 127.0.0.1）无法在
 * 这个层面拦。要彻底封死需要自定义 undici lookup 固定解析结果，代价较大。
 * 当前的缓解是：真实上游地址由运营配置、且已记录审计日志，可事后追溯。
 */

export const UPSTREAM_URL_REJECTED =
  "上游地址不安全：必须是 https 公网地址，不能指向本机、内网或云元数据地址";

/** 云厂商元数据与常见内网目标。 */
const BLOCKED_HOSTS = new Set([
  "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  "metadata", "metadata.google.internal", "metadata.goog",
  "instance-data", "169.254.169.254",
]);

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  // 段数不足 4 也要处理：URL 会把 "1.2.3" 规范化成 "1.2.0.3"（即 1.2.0.3 是
  // 合法公网地址），但 "1.2" -> "0.1.0.2"、"127.1" -> "127.0.0.1" 都是内网。
  // 段数不对时按缺位补 0 处理，与 URL/inet 行为一致，避免"看起来不像 IPv4"
  // 就放行。
  while (p.length < 4) p.push(0);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true;                       // 本机 / 回环
  if (a === 10) return true;                                   // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16/12
  if (a === 192 && b === 168) return true;                     // 192.168/16
  if (a === 169 && b === 254) return true;                     // 169.254/16 链路本地
  if (a === 100 && b >= 64 && b <= 127) return true;            // 100.64/10 CGNAT
  if (a >= 224) return true;                                    // 组播 / 保留
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().split("%")[0];
  if (v === "::1" || v === "::") return true;
  // IPv4 映射/兼容写法必须一并判定，否则是绕过口子。
  // 注意：URL.hostname 对 `[::ffff:127.0.0.1]` 返回的是**不带方括号**的
  // "::ffff:127.0.0.1"，而 Node 的 isIP() 判它为 0（不是合法 IPv6 字面量），
  // 于是它会一路落到最后 return false —— 实测确认这是真实绕过。
  // 因此这里不能只依赖 isIP，必须自己识别 "::ffff:" 前缀与结尾的 IPv4。
  const mapped = v.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // 纯 IPv6 但内嵌 IPv4 段（::ffff:7f00:1 之类的十六进制写法）同样要拦
  if (/^::ffff:/i.test(v)) return true;
  if (/^f[cd]/.test(v)) return true;                             // fc00::/7 唯一本地
  if (/^fe[89ab]/.test(v)) return true;                         // fe80::/10 链路本地
  return false;
}

/** 字面量 IP 是否指向内网/本机。域名不做解析——见文件头的 DNS 重绑定说明。 */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(h)) return true;
  if (isIP(h) === 4) return isPrivateIPv4(h);
  if (isIP(h) === 6) return isPrivateIPv6(h);
  // isIP 认不出来、但长得像 IP 的东西（典型是 ::ffff:127.0.0.1 这类 IPv4 映射
  // 写法被 URL 规范化后变形）。宁可误杀：这里放过一个就等于开一个内网口子，
  // 而误杀的后果只是运营换一种地址写法。
  if (/^[0-9a-f:.]+$/.test(h) && h.includes(":")) return true;
  // 纯数字但点数不对（999.1.1.1 / 1.2.3）同样不是合法主机名
  if (/^[\d.]+$/.test(h)) return true;
  return false;
}

export function assertSafeUpstreamUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  const allowHttp = process.env.ADMIN_ALLOW_INSECURE_UPSTREAM === "1" && process.env.NODE_ENV !== "production";
  if (url.protocol !== "https:") {
    if (!(url.protocol === "http:" && allowHttp)) return false;
  }
  if (!url.hostname) return false;
  if (isPrivateAddress(url.hostname)) return false;
  // 用户名密码型 URL（https://user:pass@host）常被用来钓鱼，也会被日志记录
  if (url.username || url.password) return false;
  // 最后再对**规范化后的完整 URL** 复查一次：URL 会把 "127.1"、"0x7f.0.0.1"、
  // "①②⑦.0.0.1" 之类改写成点分十进制，只判 hostname 的原始形态会漏。
  const normalized = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(normalized) !== 0 && isPrivateAddress(normalized)) return false;
  return true;
}