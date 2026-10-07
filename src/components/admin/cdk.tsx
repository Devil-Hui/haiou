"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Ban, Copy, Download, KeyRound, Loader2, Plus, RefreshCw, Search, Settings2, X } from "lucide-react";
import type { Plan } from "@/db/schema";
import { api, errorMessage, formatDate } from "@/lib/client";
import { AdminHeading, LoadingState, Toast, useAdminData } from "./common";
import RuleDialog from "./cdk-rule-dialog";

type CardKey = { id: string; batch: string; planId: string; status: string; orderId: string | null; note: string; createdAt: string; usedAt: string | null };
type CdkList = { items: CardKey[]; total: number; page: number; pageSize: number; stock: { unused: number; used: number; revoked: number } };
type Generated = { batch: string; count: number; codes: string[] };
type Queried = { code: string; status: string; batch: string | null; planId: string | null; orderId: string | null; usedAt: string | null };

// 与 lib/cdk.ts 的 MAX_BATCH 保持一致，避免用户填了 500 却被服务端拒
const MAX_BATCH = 500;
const statusText: Record<string, string> = { unused: "未使用", used: "已使用", revoked: "已作废", invalid: "不存在" };

function downloadCsv(batch: string, codes: string[]) {
  const body = ["batch,code", ...codes.map(code => `${batch},${code}`)].join("\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${body}\n`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `haiou-cdk-${batch}.csv`; link.click();
  URL.revokeObjectURL(url);
}

export default function CardKeyManagement() {
  const plans = useAdminData<Plan[]>("plans");
  const [batch, setBatch] = useState(""); const [status, setStatus] = useState(""); const [page, setPage] = useState(1);
  const [data, setData] = useState<CdkList | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [revision, setRevision] = useState(0); const [toast, setToast] = useState(""); const [actionError, setActionError] = useState("");
  const [generatorOpen, setGeneratorOpen] = useState(false); const [queryOpen, setQueryOpen] = useState(false); const [ruleOpen, setRuleOpen] = useState(false);

  // Loading and error are reset by the handlers that trigger a refetch, never synchronously
  // inside the effect body — that would force a second render pass on every keystroke.
  const begin = () => { setError(""); setLoading(true); };
  const reload = useCallback(() => { setError(""); setLoading(true); setRevision(value => value + 1); }, []);
  const applyFilter = (next: { batch?: string; status?: string; page?: number }) => {
    begin();
    if (next.batch !== undefined) setBatch(next.batch);
    if (next.status !== undefined) setStatus(next.status);
    if (next.page !== undefined) setPage(next.page);
  };
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page) });
    if (batch.trim()) params.set("batch", batch.trim());
    if (status) params.set("status", status);
    api<CdkList>(`/api/admin/cdk?${params}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [batch, status, page, revision]);

  async function revoke(target: string) {
    if (!window.confirm(`确定要作废批次 ${target} 中仍未使用的卡密吗？已使用的不受影响，且此操作不可撤销。`)) return;
    setActionError("");
    try {
      const result = await api<{ revoked: number }>("/api/admin/cdk", { method: "PATCH", body: JSON.stringify({ batch: target }) });
      reload(); setToast(`批次 ${target} 已作废 ${result.revoked} 张未使用卡密`);
    } catch (err) { setActionError(errorMessage(err)); }
  }

  const stock = data?.stock ?? { unused: 0, used: 0, revoked: 0 };
  const pageSize = data?.pageSize ?? 20;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return <>
    <AdminHeading title="卡密管理" subtitle="批量生成、按需作废，让每一张卡密都有清晰的去向。">
      <button className="button outline small" onClick={() => setQueryOpen(true)}><Search size={14}/>查询卡密</button>
      <button className="button outline small" onClick={() => setRuleOpen(true)}><Settings2 size={14}/>卡密规则</button>
      <button className="button primary small" onClick={() => setGeneratorOpen(true)} disabled={!plans.data?.length}><Plus size={14}/>生成卡密</button>
      <button className="refresh-button" onClick={reload} aria-label="刷新卡密列表"><RefreshCw size={15} className={loading ? "spinner" : ""}/></button>
    </AdminHeading>

    <div className="notice" style={{ marginBottom: 23 }}><KeyRound size={16}/><div>卡密在数据库里只存摘要，明文仅在生成的这一次响应中出现。<strong>关闭弹窗后无法再次查看</strong>，请当场复制或导出 CSV。</div></div>

    <div className="filter-toolbar">
      <div className="status-filters">
        {[["", "全部"], ["unused", "未使用"], ["used", "已使用"], ["revoked", "已作废"]].map(([key, text]) => <button key={key} className={status === key ? "active" : ""} onClick={() => applyFilter({ status: key, page: 1 })}>{text}</button>)}
      </div>
      <input className="input" style={{ maxWidth: 220 }} value={batch} onChange={e => applyFilter({ batch: e.target.value, page: 1 })} placeholder="按批次号筛选" maxLength={60}/>
      <span className="summary-note">未使用 {stock.unused} · 已使用 {stock.used} · 已作废 {stock.revoked}</span>
    </div>

    {actionError && <p className="inline-error" role="alert">{actionError}</p>}

    {loading || error || !data ? <LoadingState error={error} retry={reload}/> : <div className="table-wrap"><table className="data-table"><thead><tr><th>批次</th><th>套餐</th><th>状态</th><th>关联订单</th><th>备注</th><th>生成时间</th><th>操作</th></tr></thead><tbody>{data.items.map(key => <tr key={key.id}><td><span className="table-code">{key.batch}</span><span className="table-sub">{key.batch === "online" ? "在线售卖实时发放" : "批量生成"}</span></td><td><span className="table-sub no-margin">{plans.data?.find(plan => plan.id === key.planId)?.name || key.planId}</span></td><td>{statusText[key.status] || key.status}</td><td><span className="table-sub no-margin">{key.orderId ? "已绑定订单" : "—"}</span></td><td><span className="table-sub no-margin">{key.note || "—"}</span></td><td><span className="table-sub no-margin">{formatDate(key.createdAt)}</span></td><td><button className="table-action" onClick={() => revoke(key.batch)} disabled={key.batch === "online"}><Ban size={12}/>作废批次</button></td></tr>)}</tbody></table>{data.items.length === 0 && <div className="table-empty"><KeyRound size={29} strokeWidth={1.4}/><h3>这里还没有卡密</h3><p>点击右上方生成卡密，创建第一批可用于兑换的卡密。</p></div>}</div>}

    {data && data.total > 0 && <div className="filter-toolbar"><span className="summary-note">第 {data.page} / {totalPages} 页 · 共 {data.total} 张</span><div className="status-filters"><button onClick={() => applyFilter({ page: Math.max(1, data.page - 1) })} disabled={data.page <= 1}>上一页</button><button onClick={() => applyFilter({ page: Math.min(totalPages, data.page + 1) })} disabled={data.page >= totalPages}>下一页</button></div></div>}

    {generatorOpen && <Generator plans={plans.data || []} onClose={() => setGeneratorOpen(false)} onDone={(result, count) => { setGeneratorOpen(false); reload(); setToast(`已生成 ${count} 张卡密，批次 ${result}`); }}/>}
    {queryOpen && <QueryDialog plans={plans.data || []} onClose={() => setQueryOpen(false)}/>}
    {ruleOpen && <RuleDialog onClose={() => setRuleOpen(false)} onSaved={(msg) => { setRuleOpen(false); reload(); setToast(msg); }}/>}
    <Toast message={toast} onClose={() => setToast("")}/>
  </>;
}

// 明文只出现一次，所以生成结果单独用一个弹窗承载，不允许"顺手关掉"
function Generator({ plans, onClose, onDone }: { plans: Plan[]; onClose: () => void; onDone: (batch: string, count: number) => void }) {
  const [planId, setPlanId] = useState(plans[0]?.id || ""); const [quantity, setQuantity] = useState(20); const [note, setNote] = useState(""); const [maxUses, setMaxUses] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [result, setResult] = useState<Generated | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const created = await api<Generated>("/api/admin/cdk", { method: "POST", body: JSON.stringify({ planId, quantity, note, maxUses }) });
      setResult(created);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function copyAll() { try { await navigator.clipboard.writeText(result?.codes.join("\n") || ""); } catch { setError("浏览器未授权剪贴板，请使用导出 CSV"); } }

  return <div className="modal-backdrop" onClick={() => !busy && !result && onClose()}><div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="cdk-generator-title" onClick={e => e.stopPropagation()}>
    <button type="button" className="modal-close icon-button" aria-label="关闭卡密生成" onClick={onClose}><X size={18}/></button>
    <span className="section-kicker">ISSUE WITH CARE</span>
    <h2 id="cdk-generator-title">{result ? "请立即保存这批卡密" : "生成一批卡密"}</h2>
    <p className="dialog-subtitle">{result ? "明文只展示这一次，关闭后无法再次查看。" : "生成后可在前台「兑换卡密」页使用，也可用于线下分发。"}</p>

    {!result ? <form onSubmit={submit}>
      <label className="field"><span className="field-label">所属套餐</span><select className="input" value={planId} onChange={e => setPlanId(e.target.value)} required>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.period === "yearly" ? "年度" : "月度"}</option>)}</select><p className="field-hint">兑换后会按该套餐生成一张已支付订单。</p></label>
      <div className="form-row">
        <label className="field"><span className="field-label">生成数量</span><input className="input" type="number" min={1} max={MAX_BATCH} step={1} value={quantity} onChange={e => setQuantity(Number(e.target.value))} required/><p className="field-hint">单次 1–{MAX_BATCH} 张。</p></label>
        <label className="field"><span className="field-label">每张可用次数（选填）</span><input className="input" type="number" min={1} max={1000} step={1} value={maxUses} onChange={e => setMaxUses(e.target.value)} placeholder="留空 = 只能用一次"/><p className="field-hint">填大于 1 即为「次卡」，同一张卡可反复核销到用尽为止。</p></label>
        <label className="field"><span className="field-label">批次备注（选填）</span><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="例如 双十一活动" maxLength={200}/><p className="field-hint">仅内部可见，便于日后对账。</p></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy || !planId}>{busy && <Loader2 size={14} className="spinner"/>}生成卡密</button></div>
    </form> : <>
      <div className="notice warning"><KeyRound size={16}/><div>批次 <strong>{result.batch}</strong> 共 {result.count} 张。请立刻复制或导出，关闭后服务端也无法再取回明文。</div></div>
      <label className="field"><span className="field-label">卡密明文（{result.count} 张）</span><textarea className="input" readOnly value={result.codes.join("\n")} style={{ fontFamily: "monospace", minHeight: 180 }}/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button outline" onClick={copyAll}><Copy size={14}/>复制全部</button><button type="button" className="button outline" onClick={() => downloadCsv(result.batch, result.codes)}><Download size={14}/>导出 CSV</button><button type="button" className="button primary" onClick={() => onDone(result.batch, result.count)}>我已保存</button></div>
    </>}
  </div></div>;
}

function QueryDialog({ plans, onClose }: { plans: Plan[]; onClose: () => void }) {
  const [input, setInput] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [items, setItems] = useState<Queried[] | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const codes = input.split(/[\s,]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
    if (!codes.length) { setError("请填写至少一个卡密"); setBusy(false); return; }
    try { setItems((await api<{ items: Queried[] }>("/api/admin/cdk", { method: "PATCH", body: JSON.stringify({ action: "query", codes }) })).items); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={onClose}><form className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="cdk-query-title" onClick={e => e.stopPropagation()} onSubmit={submit}>
    <button type="button" className="modal-close icon-button" aria-label="关闭卡密查询" onClick={onClose}><X size={18}/></button>
    <span className="section-kicker">TRACE A CARD</span>
    <h2 id="cdk-query-title">查询卡密状态</h2>
    <p className="dialog-subtitle">按卡密摘要精确匹配，一次最多 {MAX_BATCH} 张，用于核对买家反馈的卡密。</p>
    <label className="field"><span className="field-label">卡密（多个用空格或逗号分隔）</span><textarea className="input" value={input} onChange={e => setInput(e.target.value)} placeholder="A1B2-C3D4-E5F6-G7H8" style={{ fontFamily: "monospace", minHeight: 90 }}/><p className="field-hint">不区分大小写，中间的连字符可写可不写。</p></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    {items && <div className="table-wrap"><table className="data-table"><thead><tr><th>卡密</th><th>状态</th><th>套餐</th><th>批次</th><th>核销时间</th></tr></thead><tbody>{items.map(item => <tr key={item.code}><td><span className="table-code">{item.code}</span></td><td>{statusText[item.status] || item.status}</td><td><span className="table-sub no-margin">{plans.find(plan => plan.id === item.planId)?.name || "—"}</span></td><td><span className="table-sub no-margin">{item.batch || "—"}</span></td><td><span className="table-sub no-margin">{item.usedAt ? formatDate(item.usedAt) : "—"}</span></td></tr>)}</tbody></table></div>}
    <div className="dialog-actions"><button type="button" className="button outline" onClick={onClose}>关闭</button><button type="submit" className="button primary" disabled={busy}>{busy && <Loader2 size={14} className="spinner"/>}查询</button></div>
  </form></div>;
}
