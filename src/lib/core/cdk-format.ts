// 卡密的「格式与校验」——纯逻辑，不依赖任何运行时 API。
//
// 为什么要单独成文件：后台的规则编辑弹窗是客户端组件，需要在浏览器里
// 实时预览卡密长什么样。而生成卡密需要 node:crypto 的安全随机源，
// 那个文件无法进浏览器包。把两者拆开后，客户端只引用本文件，
// 服务端再从本文件取同一份实现——预览与实际生成共用一套规则，
// 不会出现"预览的格式"和"实际发出的格式"不一致。
//
// 本文件里的所有函数都是纯函数：同样输入必得同样输出，无副作用、无随机性。

/** 卡密字母表去掉 I / L / O / U：手抄时不会和 1 / 0 混淆。 */
export const CDK_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 加前缀之前发出的卡密固定 16 位。哈希已在库里，不能作废。 */
export const LEGACY_CDK_LENGTH = 16;

export const normalizeCdk = (value: string) => value.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");

export interface CdkRule {
  prefix: string;
  bodyLength: number;
  groupSize: number;
  separator: string;
  acceptLegacy: boolean;
}

export const DEFAULT_CDK_RULE: CdkRule = {
  prefix: "PH",
  bodyLength: 16,
  groupSize: 4,
  separator: "-",
  acceptLegacy: true,
};

/**
 * 规则规范化。DB 或用户输入都要过这里，非法值回落到默认而不是抛错——
 * 配置页不该因为一个手滑的数字就整个打不开。
 */
export function normalizeCdkRule(input: Partial<CdkRule> | null | undefined): CdkRule {
  const prefix = String(input?.prefix ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const bodyLength = Math.trunc(Number(input?.bodyLength));
  const groupSize = Math.trunc(Number(input?.groupSize));
  const sep = input?.separator;
  return {
    prefix: /^[0-9A-Z]{2,6}$/.test(prefix) ? prefix : DEFAULT_CDK_RULE.prefix,
    bodyLength: bodyLength >= 12 && bodyLength <= 24 ? bodyLength : DEFAULT_CDK_RULE.bodyLength,
    groupSize: groupSize >= 2 && groupSize <= 8 ? groupSize : DEFAULT_CDK_RULE.groupSize,
    separator: sep === "-" || sep === "_" || sep === " " ? sep : DEFAULT_CDK_RULE.separator,
    acceptLegacy: input?.acceptLegacy !== false,
  };
}

/**
 * 取随机主体（剥离前缀）。
 *
 * 前缀按「形状」识别而不是按具体字符串，因此运营改过前缀后，
 * 展示历史卡不会被切错位置。主体长度写进正则，是为了让切分错误直接导致
 * 整体不匹配——若用 [0-9A-Z]+ 任意长度，正则会在最短前缀处成功匹配而
 * 不再回溯，切分点随即错位（4 位前缀 + 16 位主体被切成 2+18）。
 */
export function cdkBody(value: string, rule: CdkRule = DEFAULT_CDK_RULE): string {
  const text = normalizeCdk(value);
  if (rule.prefix && text.startsWith(rule.prefix)) return text.slice(rule.prefix.length);
  const shaped = new RegExp(`^([0-9A-Z]{2,6}?)([0-9A-Z]{${rule.bodyLength}})$`).exec(text);
  return shaped ? shaped[2] : text;
}

/** 按分组美化显示。纯展示，不参与校验。 */
export function formatCdk(value: string, rule: CdkRule = DEFAULT_CDK_RULE): string {
  const head = rule.prefix ? rule.prefix + rule.separator : "";
  return head + (cdkBody(value, rule).match(new RegExp(`.{1,${rule.groupSize}}`, "g")) ?? []).join(rule.separator);
}

/**
 * 校验卡密是否合法。接受三种形状：
 *   1) 当前前缀 + 主体
 *   2) 无前缀的 16 位（加前缀之前发出的）
 *   3) 其它前缀 + 主体（运营改过前缀）
 *
 * 第 3 条是规则可配置化的关键：若只认当前前缀，运营把 PH 改成 WH 的那一刻，
 * 所有已售出但未核销的 PH 卡会集体失效——这些卡已经卖出去了。
 * 安全性不受影响：主体长度与字母表都严格校验，前缀不承载任何随机性。
 */
export function isValidCdk(value: string, rule: CdkRule = DEFAULT_CDK_RULE): boolean {
  const text = normalizeCdk(value);
  if (!text) return false;
  const allInAlphabet = (s: string) => [...s].every((c) => CDK_ALPHABET.includes(c));
  if (!rule.prefix) return text.length === rule.bodyLength && allInAlphabet(text);
  if (text.startsWith(rule.prefix)) {
    const body = text.slice(rule.prefix.length);
    return body.length === rule.bodyLength && allInAlphabet(body);
  }
  if (!rule.acceptLegacy) return false;
  if (text.length === LEGACY_CDK_LENGTH && allInAlphabet(text)) return true;
  const shaped = new RegExp(`^([0-9A-Z]{2,6}?)([0-9A-Z]{${rule.bodyLength}})$`).exec(text);
  return !!shaped && allInAlphabet(shaped[2]);
}
