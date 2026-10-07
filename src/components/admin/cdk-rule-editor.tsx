// 卡密规则编辑表单（被 RuleDialog 使用）。
//
// 关键点：样例卡必须用与线上生成**同一个** newCdk + 规范化逻辑在本地算出来，
// 而不是让后端返回一张再显示。否则"预览的格式"与"实际发出的格式"可能不一致，
// 运营改完规则才发现不对时，卡已经发出去了。
// 关键点：样例卡必须用与线上生成**同一个**格式化实现，不能复制一份算法。
//
// 这里刻意从 "@/lib/core/cdk-format" 而不是 barrel "@/lib/core" 引用：
// 后者会连带把 logger / cache / http 拖进浏览器包，而其中的 codes 还依赖
// node:crypto，客户端根本编译不过。cdk-format 是无运行时依赖的纯模块。
import { useRef, useState } from "react";
import { normalizeCdkRule } from "@/lib/core/cdk-format";
import { api } from "@/lib/client";
import { newCdkPreview } from "./cdk-rule-preview";

type Rule = { prefix: string; bodyLength: number; groupSize: number; separator: string; acceptLegacy: boolean; confirmOrphan?: number };

export function CdkRuleEditor({ rule, onChange }: { rule: Rule; onChange: (next: Partial<Rule>) => void }) {
  // 规范化后展示：非法输入立刻回落成安全值，运营能看见"系统会按什么执行"，
  // 而不是提交后才被告知无效。
  const effective = normalizeCdkRule(rule);
  const sample = newCdkPreview(effective);

  // 首次渲染拿到的就是服务端当前规则，也就是"存量卡密当初是按它发出来的"那份基线。
  // 破坏性变更必须跟基线比，而不是跟运营上一次输入比。
  const baseline = useRef(rule);
  // 已确认过的目标值：同一次改动不该反复弹窗。
  const confirmed = useRef<{ bodyLength?: number; legacyOff?: boolean }>({});
  const [checking, setChecking] = useState(false);

  // 破坏性变更（主体变短 / 关闭历史兼容）的两道闸门：
  //   1. 这里先弹窗说明影响面，并顺手取回"当前未核销卡密数"；
  //   2. 把这个数字原样带进请求体（confirmOrphan），服务端拿它与实时统计严格比对。
  // 之所以要 2：前端提示只是礼貌，真正的护栏必须在服务端——否则绕过界面直接打
  // PATCH 就能把已卖出的卡密批量作废。取消确认返回 null。
  async function approve(message: string): Promise<number | null> {
    if (!window.confirm(message)) return null;
    setChecking(true);
    try {
      const data = await api<{ stock?: { unused?: number } }>("/api/admin/cdk?status=unused&page=1");
      return Math.max(0, Number(data?.stock?.unused ?? 0));
    } catch {
      // 数量拿不到时不猜：照样提交，服务端会带着准确数字回 409，运营能看到确切影响面。
      return -1;
    } finally {
      setChecking(false);
    }
  }

  // 主体长度：输入过程中不打扰（每敲一个数字弹一次窗等于不可用），离开输入框再判断。
  //
  // 判定条件是 `next === before`（未变则放行），**不是** `next >= before`：
  // isValidCdk 的三条兼容分支全部锚定 rule.bodyLength，所以把 16 调大到 20 同样会
  // 让已发出的 PH+16 卡全部判非法。只拦"变小"是漏掉了另一半。
  // 而服务端守卫（admin-api 的 cdk-rule PATCH）拦的是**任何**变更 —— 两边必须一致，
  // 否则调大时前端不带 confirmOrphan、服务端 409 恒成立，运营永远改不了规则。
  function commitBodyLength() {
    const next = Number(rule.bodyLength);
    const before = Number(baseline.current.bodyLength);
    if (!Number.isInteger(next) || next === before || confirmed.current.bodyLength === next) return;
    void (async () => {
      const orphan = await approve(
        `主体长度从 ${before} 位改成 ${next} 位后，已发出的 ${before} 位卡密（含加前缀之前发出的 16 位旧卡）将无法核销。\n` +
        "这些卡已经卖出，未核销的部分会集体作废且无法恢复。确定继续吗？",
      );
      if (orphan === null) { onChange({ bodyLength: before }); return; }
      confirmed.current.bodyLength = next;
      onChange({ bodyLength: next, confirmOrphan: orphan < 0 ? undefined : orphan });
    })();
  }

  function toggleLegacy(next: boolean) {
    if (next || confirmed.current.legacyOff) { onChange({ acceptLegacy: next }); return; }
    void (async () => {
      const orphan = await approve(
        "关闭历史格式兼容后，所有换过前缀或无前缀的存量卡密将立即无法核销，且这个开关无法再打开。\n" +
        "未核销的部分会集体作废。确定继续吗？",
      );
      if (orphan === null) return;
      confirmed.current.legacyOff = true;
      onChange({ acceptLegacy: false, confirmOrphan: orphan < 0 ? undefined : orphan });
    })();
  }

  return <div className="rule-editor">
    <div className="field"><label htmlFor="cdk-prefix">卡密前缀</label>
      <input id="cdk-prefix" value={rule.prefix} maxLength={6} placeholder="PH"
        onChange={(e) => onChange({ prefix: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "") })}/>
      <p className="field-hint">仅字母与数字，2-6 位。改前缀不影响已发出的旧卡。</p>
    </div>
    <div className="field-row">
      <div className="field"><label htmlFor="cdk-body">主体长度</label>
        <input id="cdk-body" type="number" min={12} max={24} value={rule.bodyLength}
          onChange={(e) => onChange({ bodyLength: Number(e.target.value) })}
          onBlur={commitBodyLength}/>
        <p className="field-hint">12-24 位（随机强度随长度增加）。<strong>改小会作废存量卡密</strong>：校验规则锚定当前长度，改小后已发出的旧卡（含加前缀前的 16 位卡）一律无法核销，离开输入框时会二次确认。</p>
      </div>
      <div className="field"><label htmlFor="cdk-group">分组大小</label>
        <input id="cdk-group" type="number" min={2} max={8} value={rule.groupSize}
          onChange={(e) => onChange({ groupSize: Number(e.target.value) })}/>
        <p className="field-hint">仅影响展示排版。</p>
      </div>
    </div>
    <div className="field"><label htmlFor="cdk-sep">分隔符</label>
      <select id="cdk-sep" value={rule.separator} onChange={(e) => onChange({ separator: e.target.value })}>
        <option value="-">连字符 -</option><option value="_">下划线 _</option><option value=" ">空格</option>
      </select>
    </div>
    <div className="field">
      <label className="checkbox-row"><input type="checkbox" checked={rule.acceptLegacy}
        onChange={(e) => toggleLegacy(e.target.checked)}/>
        继续接受历史格式卡密（换过前缀或无前缀的旧卡）</label>
      <p className="field-hint"><strong>关闭会作废存量卡密</strong>：历史格式立即无法核销，且无法恢复。存量未清空前请保持开启；确实要关时会二次确认，并要求把受影响的未核销卡密数回填给服务端校验。</p>
      {checking && <p className="field-hint">正在核对未核销卡密数量…</p>}
    </div>
    <div className="rule-sample">
      <p>买家将拿到的卡密形如</p>
      <code>{sample}</code>
      <p className="field-hint">这是用当前设置在本地生成的真实样例，与实际发出的格式一致。</p>
    </div>
  </div>;
}
