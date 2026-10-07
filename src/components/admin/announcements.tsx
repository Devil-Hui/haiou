"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { AdminHeading, LoadingState, Toast, useAdminData } from "./common";

type Announcement = {
  id: string;
  title: string;
  body: string;
  level: string;
  active: boolean;
  pinned: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
};

const LEVELS: [string, string][] = [["info", "普通告知"], ["warning", "需要留意"], ["danger", "停售 / 故障"]];
const emptyDraft = { id: "", title: "", body: "", level: "info", pinned: false, active: true, startsAt: "", expiresAt: "" };

// 生效状态由这三个维度决定：是否启用、是否在时间窗内。运营最容易搞错的是时间窗，
// 所以列表直接把「已排期未生效 / 已过期」标出来，而不是让人自己推算。
function effectiveState(row: Announcement) {
  if (!row.active) return { text: "已停用", tone: "off" };
  const now = Date.now();
  if (row.startsAt && new Date(row.startsAt).getTime() > now) return { text: "已排期", tone: "wait" };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < now) return { text: "已过期", tone: "off" };
  return { text: "展示中", tone: "on" };
}

const toLocalInput = (value: string | null) => (value ? new Date(value).toISOString().slice(0, 16) : "");

export default function Announcements() {
  const { data, error, loading, reload } = useAdminData<Announcement[]>("announcements");
  const [draft, setDraft] = useState<typeof emptyDraft | null>(null);
  const [toast, setToast] = useState("");
  const [actionError, setActionError] = useState("");

  async function toggle(row: Announcement) {
    setActionError("");
    try {
      await api("/api/admin/announcements", { method: "PATCH", body: JSON.stringify({ id: row.id, action: "toggle" }) });
      reload();
      setToast(row.active ? "公告已停用，前台不再展示" : "公告已启用");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function remove(row: Announcement) {
    if (!confirm(`确定删除公告「${row.title}」？删除后不可恢复。`)) return;
    setActionError("");
    try {
      await api(`/api/admin/announcements?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      reload();
      setToast("公告已删除");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return <>
    <AdminHeading title="公告设置" subtitle="停售通知、维护说明、到账延迟都放这里，改完刷新前台即生效。">
      <button className="button primary small" onClick={() => setDraft({ ...emptyDraft })}><Plus size={14}/>发布公告</button>
      <button className="refresh-button" onClick={reload} aria-label="刷新公告"><RefreshCw size={15} className={loading ? "spinner" : ""}/></button>
    </AdminHeading>
    {actionError && <p className="inline-error" role="alert">{actionError}</p>}
    {loading || error || !data ? <LoadingState error={error} retry={reload}/> : data.length === 0
      ? <div className="empty-state"><Plus size={28}/><h3>还没有公告</h3><p>需要临时停售或发布维护说明时，用它替代改前端文案——不发版也能改。</p></div>
      : <section className="announce-list">{data.map((row) => {
        const state = effectiveState(row);
        return <article className={`announce-row ${row.level} ${state.tone === "off" ? "dim" : ""}`} key={row.id}>
          <div className="announce-main">
            <div className="announce-title"><strong>{row.title}</strong>
              <span className={`announce-level ${row.level}`}>{LEVELS.find(([k]) => k === row.level)?.[1]}</span>
              <span className={`announce-state ${state.tone}`}>{state.text}</span>
              {row.pinned && <span className="announce-pin">置顶</span>}
            </div>
            <p>{row.body}</p>
            {(row.startsAt || row.expiresAt) && <small>生效窗口：{toLocalInput(row.startsAt).replace("T", " ") || "立即"} 至 {toLocalInput(row.expiresAt).replace("T", " ") || "长期"}</small>}
          </div>
          <div className="announce-actions">
            <button className={`switch ${row.active ? "on" : ""}`} role="switch" aria-checked={row.active} aria-label={`${row.active ? "停用" : "启用"}公告 ${row.title}`} onClick={() => toggle(row)}><span/></button>
            <button className="table-action" onClick={() => setDraft({ id: row.id, title: row.title, body: row.body, level: row.level, pinned: row.pinned, active: row.active, startsAt: toLocalInput(row.startsAt), expiresAt: toLocalInput(row.expiresAt) })}><Pencil size={12}/>编辑</button>
            <button className="table-action danger" onClick={() => remove(row)}><X size={12}/>删除</button>
          </div>
        </article>;
      })}</section>}
    {draft && <AnnouncementEditor draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); reload(); setToast("公告已保存，前台将在 5 秒内生效"); }}/>}
    <Toast message={toast} onClose={() => setToast("")}/>
  </>;
}

function AnnouncementEditor({ draft, onClose, onSaved }: { draft: typeof emptyDraft; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof emptyDraft>(key: K, value: (typeof emptyDraft)[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      // datetime-local 给的是 "YYYY-MM-DDTHH:mm"，补上秒并转成服务器要的 ISO。
      const iso = (v: string) => (v ? new Date(v).toISOString() : null);
      await api("/api/admin/announcements", {
        method: "POST",
        body: JSON.stringify({ ...form, startsAt: iso(form.startsAt), expiresAt: iso(form.expiresAt) }),
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <form className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="announce-title" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
      <button type="button" className="modal-close icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><X size={18}/></button>
      <span className="section-kicker">BROADCAST</span>
      <h2 id="announce-title">{form.id ? "编辑公告" : "发布公告"}</h2>
      <p className="dialog-subtitle">公告展示在所有页面顶部。停售建议同时在「支付配置」里打开暂停接单，双重保险。</p>
      <label className="field"><span className="field-label">标题</span><input className="input" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={60} required placeholder="例如：今晚 23:00-24:00 系统维护"/></label>
      <label className="field"><span className="field-label">正文</span><textarea className="input" value={form.body} onChange={(e) => set("body", e.target.value)} maxLength={1000} required rows={3} placeholder="写清楚影响范围、预计恢复时间，以及买家该怎么做"/></label>
      <div className="form-row">
        <label className="field"><span className="field-label">级别</span><select className="input" value={form.level} onChange={(e) => set("level", e.target.value)}>{LEVELS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field"><span className="field-label">生效时间（选填）</span><input className="input" type="datetime-local" value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)}/><p className="field-hint">留空立即生效</p></label>
      </div>
      <label className="field"><span className="field-label">失效时间（选填）</span><input className="input" type="datetime-local" value={form.expiresAt} onChange={(e) => set("expiresAt", e.target.value)}/><p className="field-hint">留空长期有效；必须晚于生效时间</p></label>
      <label className="checkbox-label"><input type="checkbox" checked={form.pinned} onChange={(e) => set("pinned", e.target.checked)}/><span>置顶（排在最前，适合长期规则说明）</span></label>
      <label className="checkbox-label"><input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)}/><span>启用（关闭则前台不展示）</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button outline" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy && <Loader2 size={14} className="spinner"/>}保存公告</button></div>
    </form>
  </div>;
}
