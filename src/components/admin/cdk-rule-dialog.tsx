// 卡密规则编辑弹窗。
//
// 存在的理由：前缀、分组、主体长度都写死在代码里时，运营想按批次区分渠道
// （首批 PH 试水、正式版改 WH）就必须改代码发版，而卡密是长生命周期数据——
// 手里没卖完的卡会因为规则与校验不一致而立刻作废。
//
// 两条交互设计：
//   1. 改任何字段都实时重算样例卡。运营能直接看到买家会拿到什么，
//      不用靠猜——这是"设置项最容易配错"的地方。
//   2. 关闭历史兼容时给出明确警告。关掉它等于让所有换过前缀的存量卡作废，
//      是不可逆的资损动作，不能让人误点。
import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { CdkRuleEditor } from "./cdk-rule-editor";

type Rule = { prefix: string; bodyLength: number; groupSize: number; separator: string; acceptLegacy: boolean; sample?: string };

export default function RuleDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (msg: string) => void }) {
  const [rule, setRule] = useState<Rule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 打开即拉取当前规则。规则不在 URL 里传，避免运营误改别人的会话。
  const load = async () => {
    try {
      const current = await api<Rule>("/api/admin/cdk-rule");
      setRule(current); setLoaded(true);
    } catch (err) { setError(errorMessage(err)); }
  };
  if (!loaded && !error) void load();

  const patch = (next: Partial<Rule>) => setRule((prev) => (prev ? { ...prev, ...next } : prev));

  async function save() {
    if (!rule) return;
    setBusy(true); setError("");
    try {
      const result = await api<Rule>("/api/admin/cdk-rule", { method: "PATCH", body: JSON.stringify(rule) });
      onSaved(result.acceptLegacy
        ? `卡密规则已更新，新卡将以 ${result.prefix} 开头；已发出的旧卡仍可正常使用`
        : `卡密规则已更新，新卡将以 ${result.prefix} 开头；历史格式已关闭，换过前缀的旧卡将无法核销`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" role="dialog" aria-modal="true" aria-label="卡密规则" onClick={(e) => e.stopPropagation()}>
      <header className="modal-head"><h2>卡密规则</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18}/></button></header>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!rule ? <p className="table-sub">正在读取当前规则…</p> : <CdkRuleEditor rule={rule} onChange={patch}/>}
      <footer className="modal-foot">
        <button className="button ghost" onClick={onClose}>取消</button>
        <button className="button primary" onClick={save} disabled={busy || !rule}>{busy && <Loader2 size={14} className="spinner"/>}保存规则</button>
      </footer>
    </div>
  </div>;
}
