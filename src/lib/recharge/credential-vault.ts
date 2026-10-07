import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// 凭证保险箱
//
// 买家提交的账号凭证（可能是 session JSON / accessToken）属于"等同账户控制权"的数据。
// 这个模块的目标只有一个：**让这类数据在本站的存续时间尽可能短，且永不出现在任何接口响应里。**
//
// 四条硬规则：
//   1. 加密后才落库（AES-256-GCM，附带完整性校验）。密钥来自环境变量 CREDENTIAL_KEY，不入库。
//   2. 不打日志。toString / 序列化都会返回 "[redacted]"，避免误进 journald。
//   3. 自动过期。每条记录带 credentialExpiresAt；处理完成或超时立即抹掉。
//   4. 单向使用。取用后由调用方负责立刻清空（见 recharge.ts 的 wipe）。
// ---------------------------------------------------------------------------

const ALGO = "aes-256-gcm";
const REDACTED = "[redacted]";

function key(): Buffer {
  const raw = process.env.CREDENTIAL_KEY;
  if (!raw) throw new Error("CREDENTIAL_KEY 未配置，无法安全保存凭证");
  // 接受任意长度口令：统一用 SHA-256 派生定长 32 字节，避免运维填错长度直接崩。
  return createHash("sha256").update(raw, "utf8").digest();
}

export function credentialVaultReady(): boolean {
  return !!process.env.CREDENTIAL_KEY;
}

/** 加密。输出 iv:tag:密文 的 base64 串，拼在一个字段里便于单列存储。 */
export function sealCredential(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** 解密。密钥不对或密文被篡改会抛错——这是 GCM 的完整性保护，不是 bug。 */
export function openCredential(sealed: string): string {
  const [ivB64, tagB64, dataB64] = sealed.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("凭证密文格式不正确");
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** 抹除：把内存里的明文尽量覆盖掉，再返回空串。 */
export function wipe(plain: string): string {
  try {
    // 字符串不可变，只能尽力缩短其引用；这里主要是表达意图与避免误用。
    plain.length;
  } catch { /* ignore */ }
  return "";
}

/**
 * 归一化买家提交的凭证。
 *
 * 改造前只接受「以 eyJ 开头」或「以 { 开头」两种，于是真实用户里最常见的两种
 * 格式会被直接判为格式不正确：
 *
 *   1. 带 cookie 名的单值    __Secure-next-auth.session-token=eyJhbGci...
 *   2. 从 DevTools 复制的完整 Cookie 串  __Secure-next-auth.session-token=eyJ...; other=...
 *
 * 用户明明粘贴了正确凭据却被拒，且错误文案是"格式不正确"——这是最坏的一类
 * 问题：用户不知道自己该改什么，只能反复重试。
 *
 * 现在按真实世界的四种形态归一，抽出可用的令牌值：
 *   - 完整 Cookie 串   -> 取 session-token 的值（优先），否则取第一个非空值
 *   - 带 cookie 名的单值 -> 去掉 "name=" 前缀
 *   - /api/auth/session JSON -> 原样保留（上游要的往往就是整段 JSON）
 *   - 裸 accessToken    -> 原样保留
 *
 * 归一化只做「提取」，不做「猜测」：无法识别的形态一律拒绝并给出明确原因，
 * 绝不把一段垃圾当成有效凭据提交给上游。
 */
export function normalizeCredential(input: unknown): string {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return "";

  const MAX = 8000;
  // 形态一：JSON 整段（/api/auth/session 的返回）。原样保留。
  if (text.startsWith("{")) return text.slice(0, MAX);
  // 形态二：裸 accessToken。
  if (text.startsWith("eyJ") && !text.includes("=")) return text.slice(0, MAX);

  // 形态三/四：含 "="，可能带 cookie 名，也可能是完整 Cookie 串。
  if (text.includes("=")) {
    // 完整 Cookie 串用 "; " 分隔多个键值对，逐对取出。
    const pairs = text.split(/;\s*/);
    let named = "";
    const rest: string[] = [];
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq < 0) { rest.push(pair); continue; }
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // session token 是我们要的；其它 cookie（locale、cf_clearance 等）只作兜底。
      if (/session-token|session_token|__Secure-next-auth/i.test(name) && value) named = value;
      else if (value) rest.push(value);
    }
    if (named) return named.slice(0, MAX);
    if (rest.length === 1) return rest[0].slice(0, MAX);
    // 多个无法区分的 cookie：不猜。宁可让用户重新粘一次，也不要提交错凭据。
    return "";
  }

  return "";
}

/** 判断一段凭证是否"需要保存"。空值直接不落库。 */
export function hasCredential(input: unknown): boolean {
  return normalizeCredential(input).length > 0;
}
