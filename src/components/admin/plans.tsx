"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Pencil, Plus, RefreshCw, X, Layers3 } from "lucide-react";
import type { Plan } from "@/db/schema";
// 只取类型：PlanWithStock 带 stockInfo（可售/已发/池内），接口确实会返回这些字段。
// 用 import type 保证 db 不被打进客户端包。
import type { PlanWithStock } from "@/lib/catalog";
import { brands, money, periodLabel, planTags } from "@/lib/catalog/catalog";
import { api, errorMessage } from "@/lib/client";
import { BrandIcon } from "@/components/brand-icon";
import { AdminHeading, LoadingState, Toast, useAdminData } from "./common";

const emptyPlan: Plan = { id: "", brand: "chatgpt", name: "", description: "", period: "monthly", price: "129", originalPrice: null, features: [], badge: null, active: true, sort: 10, stock: null, delivery: "manual", feeRate: "0", image: null, deletedAt: null };
export default function PlanManagement() {
  const { data, loading, error, reload } = useAdminData<PlanWithStock[]>("plans");
  const [period, setPeriod] = useState(""); const [editing, setEditing] = useState<Plan | null>(null); const [toast, setToast] = useState(""); const [actionError, setActionError] = useState(""); const [busy, setBusy] = useState("");
  // 批量操作：套餐多起来后，逐个点上下架/改价会非常耗时。
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  async function toggle(plan: Plan) { setBusy(plan.id); setActionError(""); try { await api(`/api/admin/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify({ active: !plan.active }) }); reload(); setToast(plan.active ? "套餐已下架，历史订单不受影响" : "套餐已上架，前台现已可见"); } catch (err) { setActionError(errorMessage(err)); } finally { setBusy(""); } }
  const visible = (data ?? []).filter((p) => !period || p.period === period);
  const allSelected = visible.length > 0 && visible.every((p) => selected.includes(p.id));
  function toggleOne(id: string) { setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]); }
  function toggleAll() { setSelected(allSelected ? selected.filter((id) => !visible.some((p) => p.id === id)) : [...new Set([...selected, ...visible.map((p) => p.id)])]); }
  return <><AdminHeading title="套餐管理" subtitle="上下架、售价与库存都在这里改，改动只影响新订单。"><button className="button primary small" onClick={() => setEditing({ ...emptyPlan })}><Plus size={14}/>新增套餐</button><button className="refresh-button" onClick={reload} aria-label="刷新套餐"><RefreshCw size={15} className={loading ? "spinner" : ""}/></button></AdminHeading><div className="filter-toolbar"><div className="status-filters">{[["", "全部套餐"], ["monthly", "月度订阅"], ["yearly", "年度订阅"]].map(([key, text]) => <button key={key} className={period === key ? "active" : ""} onClick={() => { setPeriod(key); setSelected([]); }}>{text}</button>)}</div><label className="select-all"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={visible.length === 0}/>全选当前列表</label><span className="summary-note">{data?.filter(p => p.active).length || 0} 个已上架 · {data?.length || 0} 个套餐</span></div>{actionError && <p className="inline-error" role="alert">{actionError}</p>}{selected.length > 0 && <div className="bulk-bar"><span>已选 <strong>{selected.length}</strong> 个套餐</span><div className="bulk-actions"><button className="button soft small" onClick={() => setBulkOpen(true)}><Layers3 size={13}/>批量操作</button><button className="table-action" onClick={() => setSelected([])}>取消选择</button></div></div>}{loading || error || !data ? <LoadingState error={error} retry={reload}/> : <section className="admin-plans-grid">{data.filter(p => !period || p.period === period).map(plan => { const info = plan.stockInfo; const soldOut = plan.delivery === "cdk" && info.remaining !== null && info.remaining <= 0; const low = plan.delivery === "cdk" && info.remaining !== null && info.remaining > 0 && info.remaining <= 10; return <article key={plan.id} className={`admin-plan ${plan.brand} ${!plan.active ? "offline" : ""} ${soldOut ? "sold-out" : ""}`}><div className="admin-plan-top"><label className="plan-pick" title="选择用于批量操作"><input type="checkbox" checked={selected.includes(plan.id)} onChange={() => toggleOne(plan.id)} aria-label={`选择套餐 ${plan.name}`}/></label><span className="plan-logo"><BrandIcon brand={plan.brand}/></span><button className={`switch ${plan.active ? "on" : ""}`} role="switch" aria-checked={plan.active} aria-label={`${plan.active ? "下架" : "上架"}${plan.name}${periodLabel(plan.period)}付套餐`} onClick={() => toggle(plan)} disabled={busy === plan.id}><span/></button></div><h3>{plan.name}</h3><p>{plan.description}</p><div className="admin-plan-price">¥{money(plan.price)}<small>/ {periodLabel(plan.period)}</small></div><div className="admin-plan-tags">{planTags(plan).map(tag => <span key={tag.tone} className={"plan-tag " + tag.tone}>{tag.label}</span>)}{plan.delivery === "cdk" && <span className="plan-tag plain">已发 {info.issued} · 池内 {info.poolUnused}</span>}</div><div className="admin-plan-bottom"><span>{plan.active ? "已上架" : "已下架"} · 排序 {plan.sort}</span><button className="table-action" onClick={() => setEditing(plan)}><Pencil size={12}/>编辑套餐</button></div></article>; })}{data.filter(p => !period || p.period === period).length === 0 && <div className="empty-state"><Plus size={28}/><h3>创建你的第一个套餐</h3><p>点击右上方新增套餐，完善订阅信息后即可上架。</p></div>}</section>}{editing && <PlanEditor plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); setToast("套餐已保存，前台价格与权益已同步更新"); }}/>}{bulkOpen && <BulkDialog ids={selected} onClose={() => setBulkOpen(false)} onDone={(msg) => { setBulkOpen(false); setSelected([]); reload(); setToast(msg); }}/>}<Toast message={toast} onClose={() => setToast("")}/></>;
}
function BulkDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [action, setAction] = useState("on");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsValue = ["price", "fee", "stock"].includes(action);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const body: Record<string, unknown> = { ids, action };
      if (needsValue) body[action === "price" ? "price" : action === "fee" ? "feeRate" : "stock"] = value;
      await api("/api/admin/plans/bulk", { method: "PATCH", body: JSON.stringify(body) });
      onDone(`已批量更新 ${ids.length} 个套餐`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-title" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
      <button type="button" className="modal-close icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><X size={18}/></button>
      <span className="section-kicker">BULK UPDATE</span>
      <h2 id="bulk-title">批量操作 {ids.length} 个套餐</h2>
      <p className="dialog-subtitle">所有改动只影响新订单，历史订单保留原始价格与权益。</p>
      <label className="field"><span className="field-label">操作</span><select className="input" value={action} onChange={(e) => { setAction(e.target.value); setValue(""); }}>
        <option value="on">批量上架</option>
        <option value="off">批量下架</option>
        <option value="price">批量设置售价（元）</option>
        <option value="fee">批量设置手续费率（%）</option>
        <option value="stock">批量设置库存上限（留空 = 不限）</option>
        <option value="delivery">批量设置交付方式</option>
      </select></label>
      {action === "price" && <label className="field"><span className="field-label">售价</span><input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} min="0.01" step="0.01" required/></label>}
      {action === "fee" && <label className="field"><span className="field-label">手续费率</span><input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} min="0" max="100" step="0.01" required/></label>}
      {action === "stock" && <label className="field"><span className="field-label">库存上限</span><input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} min="0" placeholder="留空表示不限"/></label>}
      {action === "delivery" && <label className="field"><span className="field-label">交付方式</span><select className="input" value={value} onChange={(e) => setValue(e.target.value)} required><option value="">请选择</option><option value="manual">人工代充</option><option value="cdk">卡密交付</option></select></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy || (needsValue && action !== "stock" && !value) || (action === "delivery" && !value)}>{busy && <Loader2 size={14} className="spinner"/>}确认批量{action === "on" ? "上架" : action === "off" ? "下架" : "更新"}</button></div>
    </form>
  </div>;
}

function PlanEditor({ plan, onClose, onSaved }: { plan: Plan; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(plan); const [features, setFeatures] = useState(plan.features.join("\n")); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  function set<K extends keyof Plan>(key: K, value: Plan[K]) { setForm(previous => ({ ...previous, [key]: value })); }
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api(`/api/admin/plans${plan.id ? `/${plan.id}` : ""}`, { method: plan.id ? "PATCH" : "POST", body: JSON.stringify({ ...form, features: features.split("\n").map(f => f.trim()).filter(Boolean) }) }); onSaved(); } catch (err) { setError(errorMessage(err)); setBusy(false); } }
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}><form className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="plan-editor-title" onClick={e => e.stopPropagation()} onSubmit={submit}><button type="button" className="modal-close icon-button" aria-label="关闭套餐编辑" onClick={onClose} disabled={busy}><X size={18}/></button><span className="section-kicker">CURATE SOMETHING GOOD</span><h2 id="plan-editor-title">{plan.id ? "编辑订阅套餐" : "新增一份好订阅"}</h2><p className="dialog-subtitle">套餐变更仅影响新订单，已创建订单保留原始价格与内容。</p><div className="form-row"><label className="field"><span className="field-label">AI 品牌</span><select className="input" value={form.brand} onChange={e => set("brand", e.target.value)}>{Object.entries(brands).map(([key, value]) => <option key={key} value={key}>{value.name}</option>)}</select></label><label className="field"><span className="field-label">订阅周期</span><select className="input" value={form.period} onChange={e => set("period", e.target.value)}><option value="monthly">月度订阅</option><option value="yearly">年度订阅</option></select></label></div><label className="field"><span className="field-label">套餐名称</span><input className="input" value={form.name} onChange={e => set("name", e.target.value)} placeholder="例如 ChatGPT Plus" required maxLength={60}/></label><label className="field"><span className="field-label">一句话描述</span><input className="input" value={form.description} onChange={e => set("description", e.target.value)} placeholder="给这个套餐一个打动人心的介绍" required maxLength={100}/></label><div className="form-row"><label className="field"><span className="field-label">售价（CNY）</span><input className="input" type="number" value={form.price} onChange={e => set("price", e.target.value)} min="0.01" max="999999" step="0.01" required/></label><label className="field"><span className="field-label">划线价（选填）</span><input className="input" type="number" value={form.originalPrice || ""} onChange={e => set("originalPrice", e.target.value || null)} min={form.price} max="999999" step="0.01" placeholder="不低于售价"/></label></div><label className="field"><span className="field-label">手续费率（%，选填）</span><input className="input" type="number" value={form.feeRate ?? "0"} onChange={e => set("feeRate", e.target.value)} min="0" max="100" step="0.01"/><p className="field-hint">买家实付 = 售价 + 手续费。下单时按此费率计算并锁进订单，之后改费率不影响历史订单；留空为 0%。</p></label><label className="field"><span className="field-label">套餐权益（每行一条）</span><textarea className="input" value={features} onChange={e => setFeatures(e.target.value)} placeholder={"个人账号订阅权益\n更高的模型使用额度\n文件分析与内容创作"} required maxLength={808}/><p className="field-hint">建议填写 3 条，每条不超过 100 字；以品牌官方实际权益为准。</p></label><div className="form-row"><label className="field"><span className="field-label">推荐角标（选填）</span><input className="input" value={form.badge || ""} onChange={e => set("badge", e.target.value || null)} placeholder="例如 人气之选" maxLength={12}/></label><label className="field"><span className="field-label">显示排序</span><input className="input" type="number" value={form.sort} onChange={e => set("sort", Number(e.target.value))} min={0} max={999} step={1} required/></label></div><div className="form-row"><label className="field"><span className="field-label">交付方式</span><select className="input" value={form.delivery} onChange={e => set("delivery", e.target.value)}><option value="manual">人工代充（运营手动处理）</option><option value="cdk">卡密交付（付款后自动发放）</option></select><p className="field-hint">卡密交付在付款确认后实时生成卡密，明文只展示一次。</p></label><label className="field"><span className="field-label">库存上限（选填）</span><input className="input" type="number" value={form.stock ?? ""} onChange={e => set("stock", e.target.value === "" ? null : Number(e.target.value))} min={0} max={999999} step={1} placeholder="留空表示不限"/><p className="field-hint">仅对卡密交付生效，达到上限后停止发放。</p></label></div><label className="checkbox-label"><input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)}/><span>上架此套餐，在前台展示并允许下单</span></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy && <Loader2 size={14} className="spinner"/>}保存套餐</button></div></form></div>;
}
