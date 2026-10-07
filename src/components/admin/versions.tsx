// 本组件用了 useState / useEffect / useCallback，必须是客户端组件。
// 缺这一行时它会被当服务端模块编译，渲染时 hooks 直接抛错 → 后台"系统更新"整页不可用。
"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Check, Megaphone, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { AdminHeading, LoadingState, Toast, useAdminData } from "./common";
import type { VersionDraft, VersionLevel, VersionStatus } from "@/lib/system-versions";

const LEVEL_LABEL: Record<VersionLevel, string> = {
  minor: "常规更新",
  major: "新增功能",
  critical: "重要变更",
};
const STATUS_LABEL: Record<VersionStatus, string> = {
  draft: "草稿",
  scheduled: "已预约",
  published: "已发布",
};

const empty = { id: "", version: "", title: "", changes: "", level: "minor" as VersionLevel, status: "draft" as VersionStatus, scheduledFor: "" };

export function SystemVersions() {
  // useAdminData 自带 /api/admin/ 前缀，这里只传资源名。
  // 传完整路径会拼成 /api/admin//api/admin/versions，落到 [resource] 通配后 404。
  const { data, error, loading, reload } = useAdminData<{ versions: VersionDraft[] }>("versions");
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const open = useCallback((v?: VersionDraft) => {
    setForm(v ? {
      id: v.id, version: v.version, title: v.title, changes: v.changes,
      level: v.level, status: v.status,
      // datetime-local 要的是本地时间且不带时区后缀，直接给 ISO 会被判为非法。
      scheduledFor: v.scheduledFor ? new Date(v.scheduledFor).toISOString().slice(0, 16) : "",
    } : empty);
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { action: "save", ...form };
      if (!form.scheduledFor) delete body.scheduledFor;
      const r = await api<{ success: boolean }>("/api/admin/versions", { method: "POST", body: JSON.stringify(body) });
      setToast({ kind: "ok", text: r.success ? "已保存" : "保存失败" });
      setForm(empty);
      reload();
    } catch (e) {
      setToast({ kind: "err", text: errorMessage(e) });
    } finally { setBusy(false); }
  }, [form, reload]);

  const act = useCallback(async (action: string, id: string) => {
    try {
      await api("/api/admin/versions", { method: "POST", body: JSON.stringify({ action, id }) });
      reload();
    } catch (e) { setToast({ kind: "err", text: errorMessage(e) }); }
  }, [reload]);

  if (loading && !data) return <LoadingState/>;
  if (error) return <LoadingState error={error} retry={reload}/>;
  const versions = data?.versions ?? [];

  return <>
    <AdminHeading title="系统更新" subtitle="发布版本记录，前台访客可见。预约发布会在到点后自动对前台公开。"/>
    {toast && <Toast message={toast.text} onClose={() => setToast(null)}/>}

    <section className="admin-panel">
      <div className="admin-panel-header"><h2>{form.id ? "编辑版本" : "新建版本"}</h2></div>
      <div className="config-content">
        <div className="form-row">
          <label className="field"><span className="field-label">版本号</span>
            <input className="input" value={form.version} placeholder="1.0.0" onChange={e => setForm({ ...form, version: e.target.value })}/>
            <p className="field-hint">三段数字。发布后不可重复使用。</p></label>
          <label className="field"><span className="field-label">标题</span>
            <input className="input" value={form.title} placeholder="新增易支付收银台" onChange={e => setForm({ ...form, title: e.target.value })}/></label>
        </div>
        <label className="field"><span className="field-label">变更内容（每行一条）</span>
          <textarea className="input" rows={4} value={form.changes} onChange={e => setForm({ ...form, changes: e.target.value })}
            placeholder={"修复订单重复入账\n新增易支付收银台"}/></label>
        <div className="form-row">
          <label className="field"><span className="field-label">重要程度</span>
            <select className="input" value={form.level} onChange={e => setForm({ ...form, level: e.target.value as VersionLevel })}>
              {Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          <label className="field"><span className="field-label">状态</span>
            <select className="input" value={form.status} onChange={e => setForm({ ...form, status: e.target.value as VersionStatus })}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          {form.status === "scheduled" && <label className="field"><span className="field-label">预约发布时间</span>
            <input className="input" type="datetime-local" value={form.scheduledFor} onChange={e => setForm({ ...form, scheduledFor: e.target.value })}/>
            <p className="field-hint">到点后前台自动可见，精确到分钟由访客访问触发，最迟 5 分钟内（定时任务）。</p></label>}
        </div>
        <div className="config-footer">
          <button className="button" onClick={() => setForm(empty)}>清空</button>
          <button className="button primary" onClick={save} disabled={busy}>{busy ? "保存中…" : form.id ? "保存修改" : "创建"}</button>
        </div>
      </div>
    </section>

    <section className="admin-panel">
      <div className="admin-panel-header"><h2>版本记录（{versions.length}）</h2></div>
      {versions.length === 0 ? <p className="config-footer">还没有版本记录。发布后前台首页会显示更新提示。</p>
        : <div className="table-panel"><table className="data-table"><thead><tr>
          <th>版本</th><th>标题</th><th>重要程度</th><th>状态</th><th>时间</th><th>操作</th>
        </tr></thead><tbody>
          {versions.map(v => <tr key={v.id}>
            <td><code>{v.version}</code></td>
            <td>{v.title}</td>
            <td>{LEVEL_LABEL[v.level]}</td>
            <td><span className={`status-badge ${v.status}`}>{STATUS_LABEL[v.status]}</span></td>
            <td>{v.status === "scheduled" && v.scheduledFor
              ? <span className="muted"><CalendarClock size={12}/> {new Date(v.scheduledFor).toLocaleString("zh-CN")}</span>
              : v.publishedAt ? new Date(v.publishedAt).toLocaleDateString("zh-CN") : "—"}</td>
            <td className="row-actions">
              <button className="table-action" onClick={() => open(v)}><Pencil size={13}/> 编辑</button>
              {v.status === "published" && <button className="table-action" onClick={() => act("retract", v.id)}><RotateCcw size={13}/> 撤回</button>}
              {v.status === "draft" && <button className="table-action" onClick={() => act("delete", v.id)}><Trash2 size={13}/> 删除</button>}
            </td>
          </tr>)}
        </tbody></table></div>}
    </section>
  </>;
}
