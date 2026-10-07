"use client";

import { useState } from "react";
import { Link2, Loader2, Play, RefreshCw, Save, Server, ShieldCheck, X } from "lucide-react";
import { api, errorMessage, formatDate } from "@/lib/client";
import { AdminHeading, LoadingState, Toast, useAdminData } from "./common";

type Job = {
  id: string; code: string; planName: string; email: string; status: string;
  upstreamOrder: string | null; hasCredential: boolean; resultNote: string; failureReason: string;
  createdAt: string; updatedAt: string;
};
type Payload = {
  config: {
    enabled: boolean; provider: string; baseUrl: string; appId: string;
    timeoutSeconds: number; pollIntervalSeconds: number;
    credentialTtlMinutes: number; dailyLimitPerEmail: number;
  } | null;
  secretConfigured: boolean;
  credentialKeyConfigured: boolean;
  jobs: Job[];
};

const STATUS_TEXT: Record<string, string> = {
  validating: "校验中", confirmed: "待提交", submitted: "已提交",
  processing: "处理中", succeeded: "已完成", failed: "已失败",
  // 超时是独立终态，语义上不同于失败：失败=上游明确拒绝，超时=上游没给结论。
  // 运营处置方式不同（一个可重试，一个需先核实是否已到账），文案必须区分开。
  timed_out: "已超时",
};

export default function UpstreamSettings() {
  const { data, error, loading, reload } = useAdminData<Payload>("upstream");
  const [form, setForm] = useState<Payload["config"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [actionError, setActionError] = useState("");

  const cfg = form ?? data?.config ?? null;
  const set = <K extends keyof NonNullable<Payload["config"]>>(key: K, value: NonNullable<Payload["config"]>[K]) =>
    setForm({ ...(form ?? data?.config ?? ({} as NonNullable<Payload["config"]>)), [key]: value });

  async function save() {
    if (!cfg) return;
    setBusy(true); setActionError("");
    try {
      await api("/api/admin/upstream", { method: "PATCH", body: JSON.stringify({ action: "config", ...cfg }) });
      setForm(null);
      reload();
      setToast("上游配置已保存");
    } catch (err) { setActionError(errorMessage(err)); } finally { setBusy(false); }
  }

  async function advance(id: string) {
    setActionError("");
    try {
      await api("/api/admin/upstream", { method: "PATCH", body: JSON.stringify({ action: "advance", id }) });
      reload();
      setToast("已手动推进一次");
    } catch (err) { setActionError(errorMessage(err)); }
  }

  return <>
    <AdminHeading title="上游对接" subtitle="自动充值的上游连接与策略。密钥只从服务器环境变量读取，这里不显示也不保存任何密钥。">
      <button className="refresh-button" onClick={reload} aria-label="刷新"><RefreshCw size={15} className={loading ? "spinner" : ""}/></button>
    </AdminHeading>
    {actionError && <p className="inline-error" role="alert">{actionError}</p>}
    {loading || error || !data ? <LoadingState error={error} retry={reload}/> : !cfg ? <div className="empty-state"><Server size={28}/><h3>尚未初始化</h3><p>保存一次配置后即可启用。</p></div> : <>
      <section className="panel" style={{ marginBottom: 20 }}>
        <div className="admin-panel-header"><h2>连接与策略</h2><span>可配置 · 默认关闭</span></div>
        <div className="form-row" style={{ marginTop: 14 }}>
          <label className="field"><span className="field-label">上游类型</span><select className="input" value={cfg.provider} onChange={(e) => set("provider", e.target.value)}><option value="mock">本地模拟（开发自测）</option><option value="http">HTTP 上游</option><option value="aisub">卡密站 A（当前使用）</option></select><p className="field-hint">模拟上游不产生任何真实充值，用于验证链路。</p></label>
          <label className="field"><span className="field-label">上游地址</span><input className="input" value={cfg.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://upstream.example.com" maxLength={200}/><p className="field-hint">站点根地址，不含具体接口路径</p></label>
        </div>
        <div className="form-row">
          <label className="field"><span className="field-label">App Id</span><input className="input" value={cfg.appId} onChange={(e) => set("appId", e.target.value)} maxLength={64}/></label>
          <label className="field"><span className="field-label">签名密钥</span><div className="config-env"><ShieldCheck size={13}/><code>UPSTREAM_SECRET</code><span className={data.secretConfigured ? "is-configured" : "not-configured"}>{data.secretConfigured ? "服务器已配置" : "未配置"}</span></div></label>
        </div>
        <div className="form-row">
          <label className="field"><span className="field-label">请求超时（秒）</span><input className="input" type="number" value={cfg.timeoutSeconds} onChange={(e) => set("timeoutSeconds", Number(e.target.value))} min={30} max={86400}/></label>
          <label className="field"><span className="field-label">轮询间隔（秒）</span><input className="input" type="number" value={cfg.pollIntervalSeconds} onChange={(e) => set("pollIntervalSeconds", Number(e.target.value))} min={3} max={600}/><p className="field-hint">上游一般有频率限制，别设太小</p></label>
        </div>
        <div className="form-row">
          <label className="field"><span className="field-label">凭证保留时长（分钟）</span><input className="input" type="number" value={cfg.credentialTtlMinutes} onChange={(e) => set("credentialTtlMinutes", Number(e.target.value))} min={1} max={1440}/><p className="field-hint">到点自动抹除；提交上游成功后会立即抹除</p></label>
          <label className="field"><span className="field-label">凭证加密密钥</span><div className="config-env"><ShieldCheck size={13}/><code>CREDENTIAL_KEY</code><span className={data.credentialKeyConfigured ? "is-configured" : "not-configured"}>{data.credentialKeyConfigured ? "服务器已配置" : "未配置"}</span></div></label>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={cfg.enabled} onChange={(e) => set("enabled", e.target.checked)}/><span>启用自动充值（关闭后前台入口自动隐藏并拒绝提交）</span></label>
        <div className="dialog-actions" style={{ marginTop: 16 }}><button className="button primary" onClick={save} disabled={busy}>{busy ? <Loader2 size={14} className="spinner"/> : <Save size={14}/>}保存配置</button></div>
      </section>

      <section className="table-panel">
        <div className="admin-panel-header"><h2>充值任务</h2><span>最近 {data.jobs.length} 条</span></div>
        {data.jobs.length === 0 ? <div className="empty-state"><Play size={26}/><h3>还没有任务</h3><p>买家在前台提交后会自动出现在这里。</p></div> : <div className="table-wrap"><table className="data-table">
          <thead><tr><th>订单号</th><th>套餐 / 账号</th><th>状态</th><th>上游</th><th>凭证</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>{data.jobs.map((job) => <tr key={job.id}>
            <td><span className="table-code">{job.code}</span></td>
            <td><span className="table-sub no-margin">{job.planName}</span><span className="table-sub">{job.email}</span></td>
            <td><span className={`status-badge ${job.status === "succeeded" ? "completed" : (job.status === "failed" || job.status === "timed_out") ? "cancelled" : "pending"}`}>{STATUS_TEXT[job.status] || job.status}</span>{job.failureReason && <span className="table-sub">{job.failureReason}</span>}</td>
            <td><span className="table-sub no-margin">{job.upstreamOrder || "—"}</span></td>
            <td><span className="table-sub no-margin">{job.hasCredential ? "仍持有（将自动清除）" : "已清除"}</span></td>
            <td><span className="table-sub no-margin">{formatDate(job.createdAt)}</span></td>
            <td>{!["succeeded", "failed", "timed_out"].includes(job.status) && <button className="table-action" onClick={() => advance(job.id)}><Play size={12}/>推进</button>}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </>}
    <Toast message={toast} onClose={() => setToast("")}/>
  </>;
}
