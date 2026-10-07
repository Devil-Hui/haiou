"use client";

import { useEffect, useState } from "react";
import { Copy, Download, Loader2, Plus, RefreshCw, TicketPercent, Trash2, X } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { AdminHeading, LoadingState, Toast, useAdminData } from "./common";

type Coupon = {
  id: string; discountAmount: string; minAmount: string; totalLimit: number | null;
  perUserLimit: number; usedCount: number; expiresAt: string | null; active: boolean; note: string; createdAt: string;
};

const emptyDraft = { quantity: "10", discountAmount: "", minAmount: "", totalLimit: "", perUserLimit: "1", expiresAt: "", note: "" };

export default function Coupons() {
  const { data, error, loading, reload } = useAdminData<Coupon[]>("coupons");
  const [draft, setDraft] = useState<typeof emptyDraft | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [toast, setToast] = useState("");
  const [actionError, setActionError] = useState("");
  // 「当前时间」放进 state，而不是在渲染体里直接调 Date.now()。
  // 后者在每次重渲染时都可能得到不同结果，会让"已过期"标签闪烁不定；
  // 放进 state 后渲染是纯函数，每分钟由定时器统一推进一次即可。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  async function toggle(row: Coupon) {
    setActionError("");
    try {
      await api("/api/admin/coupons", { method: "POST", body: JSON.stringify({ action: "toggle", id: row.id }) });
      reload();
      setToast(row.active ? "已停用，买家无法再使用" : "已启用");
    } catch (err) { setActionError(errorMessage(err)); }
  }

  async function remove(row: Coupon) {
    if (!confirm("确定删除这张券？已用它下过的订单会变成「券码已失效」，建议改为停用。")) return;
    setActionError("");
    try {
      await api("/api/admin/coupons", { method: "POST", body: JSON.stringify({ action: "delete", id: row.id }) });
      reload();
      setToast("券已删除");
    } catch (err) { setActionError(errorMessage(err)); }
  }

  function download() {
    if (!codes?.length) return;
    const blob = new Blob(["﻿" + codes.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `coupons-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click(); URL.revokeObjectURL(url);
  }

  return <>
    <AdminHeading title="优惠券" subtitle="批量生成面额券；明文只在生成时显示一次，请立即导出保存。">
      <button className="button primary small" onClick={() => setDraft({ ...emptyDraft })}><Plus size={14}/>生成券码</button>
      <button className="refresh-button" onClick={reload} aria-label="刷新优惠券"><RefreshCw size={15} className={loading ? "spinner" : ""}/></button>
    </AdminHeading>
    {actionError && <p className="inline-error" role="alert">{actionError}</p>}
    {loading || error || !data ? <LoadingState error={error} retry={reload}/> : data.length === 0
      ? <div className="empty-state"><TicketPercent size={28}/><h3>还没有优惠券</h3><p>生成一批面额券，用于活动、老客回馈或降低首单门槛。</p></div>
      : <div className="table-wrap"><table className="data-table">
          <thead><tr><th>面额 / 门槛</th><th>使用情况</th><th>有效期</th><th>状态</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>{data.map((row) => {
            const expired = row.expiresAt ? new Date(row.expiresAt).getTime() < now : false;
            const soldOut = row.totalLimit !== null && row.usedCount >= row.totalLimit;
            return <tr key={row.id}>
              <td><span className="table-code">减 ¥{row.discountAmount}</span><span className="table-sub">{Number(row.minAmount) > 0 ? `满 ¥${row.minAmount} 可用` : "无门槛"}</span></td>
              <td><span className="table-sub no-margin">{row.usedCount}{row.totalLimit !== null ? ` / ${row.totalLimit}` : " / 不限"}</span><span className="table-sub">每人限 {row.perUserLimit === 0 ? "不限" : `${row.perUserLimit} 次`}</span></td>
              <td><span className="table-sub no-margin">{row.expiresAt ? new Date(row.expiresAt).toLocaleDateString("zh-CN") : "长期有效"}</span></td>
              <td><span className={`status-badge ${expired || soldOut || !row.active ? "cancelled" : "completed"}`}>{!row.active ? "已停用" : expired ? "已过期" : soldOut ? "已领完" : "可用"}</span></td>
              <td><span className="table-sub no-margin">{row.note || "—"}</span></td>
              <td>
                <button className={`switch ${row.active ? "on" : ""}`} role="switch" aria-checked={row.active} aria-label={`${row.active ? "停用" : "启用"}该券`} onClick={() => toggle(row)}><span/></button>
                <button className="table-action danger" onClick={() => remove(row)}><Trash2 size={12}/>删除</button>
              </td>
            </tr>;
          })}</tbody>
        </table></div>}

    {draft && <CouponEditor draft={draft} onClose={() => setDraft(null)} onSaved={(list) => { setDraft(null); setCodes(list); reload(); }}/>}
    {codes && <CodeViewer codes={codes} onClose={() => setCodes(null)} onDownload={download}/>}
    <Toast message={toast} onClose={() => setToast("")}/>
  </>;
}

function CouponEditor({ draft, onClose, onSaved }: { draft: typeof emptyDraft; onClose: () => void; onSaved: (codes: string[]) => void }) {
  const [form, setForm] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof emptyDraft, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const result = await api<{ codes: string[] }>("/api/admin/coupons", {
        method: "POST",
        body: JSON.stringify({ action: "generate", ...form, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null }),
      });
      onSaved(result.codes);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <form className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="coupon-title" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
      <button type="button" className="modal-close icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><X size={18}/></button>
      <span className="section-kicker">COUPON BATCH</span>
      <h2 id="coupon-title">批量生成优惠券</h2>
      <p className="dialog-subtitle">券码明文只在生成后显示一次，库里只存摘要。请生成后立即导出保存。</p>
      <div className="form-row">
        <label className="field"><span className="field-label">抵扣金额（元）</span><input className="input" type="number" value={form.discountAmount} onChange={(e) => set("discountAmount", e.target.value)} min="0.01" step="0.01" required placeholder="例如 20"/></label>
        <label className="field"><span className="field-label">使用门槛（选填）</span><input className="input" type="number" value={form.minAmount} onChange={(e) => set("minAmount", e.target.value)} min="0" step="0.01" placeholder="0 表示无门槛"/></label>
      </div>
      <div className="form-row">
        <label className="field"><span className="field-label">生成数量</span><input className="input" type="number" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} min="1" max="500" required/></label>
        <label className="field"><span className="field-label">每人限用次数</span><input className="input" type="number" value={form.perUserLimit} onChange={(e) => set("perUserLimit", e.target.value)} min="0" max="1000" required/><p className="field-hint">0 表示不限</p></label>
      </div>
      <div className="form-row">
        <label className="field"><span className="field-label">总次数上限（选填）</span><input className="input" type="number" value={form.totalLimit} onChange={(e) => set("totalLimit", e.target.value)} min="1" placeholder="留空表示不限"/></label>
        <label className="field"><span className="field-label">过期时间（选填）</span><input className="input" type="datetime-local" value={form.expiresAt} onChange={(e) => set("expiresAt", e.target.value)}/></label>
      </div>
      <label className="field"><span className="field-label">备注（选填）</span><input className="input" value={form.note} onChange={(e) => set("note", e.target.value)} maxLength={200} placeholder="例如：双十一活动专属"/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy && <Loader2 size={14} className="spinner"/>}生成</button></div>
    </form>
  </div>;
}

function CodeViewer({ codes, onClose, onDownload }: { codes: string[]; onClose: () => void; onDownload: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copyAll() {
    try { await navigator.clipboard.writeText(codes.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* 浏览器未授权时用户可手动选中复制 */ }
  }
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="code-title" onClick={(e) => e.stopPropagation()}>
      <span className="section-kicker">COPY NOW</span>
      <h2 id="code-title">券码已生成（仅显示这一次）</h2>
      <p className="dialog-subtitle">共 {codes.length} 张。关闭后无法再次查看，请先复制或导出保存。</p>
      <textarea className="input code-box" readOnly value={codes.join("\n")} rows={8} />
      <div className="dialog-actions">
        <button type="button" className="button outline" onClick={copyAll}>{copied ? "已复制" : <><Copy size={14}/>复制全部</>}</button>
        <button type="button" className="button outline" onClick={onDownload}><Download size={14}/>导出文件</button>
        <button type="button" className="button primary" onClick={onClose}>我已保存</button>
      </div>
    </div>
  </div>;
}
