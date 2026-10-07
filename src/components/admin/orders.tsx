"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight, Download, Info, KeyRound, Loader2, RefreshCw, Search, X } from "lucide-react";
import { api, errorMessage, formatDate } from "@/lib/client";
import { money, paymentLabel, statusFlow, statusLabels } from "@/lib/catalog/catalog";
import { AdminHeading, LoadingState, OrderTable, Toast, useAdminData, type AdminOrder } from "./common";

type OrderList = { items: AdminOrder[]; total: number; page: number; pageSize: number };
export default function OrderManagement({ initialQuery = "", initialStatus = "" }: { initialQuery?: string; initialStatus?: string }) {
  const [status, setStatus] = useState(initialStatus); const [query, setQuery] = useState(initialQuery); const [search, setSearch] = useState(initialQuery); const [page, setPage] = useState(1); const [editing, setEditing] = useState<AdminOrder | null>(null);
  // 正在发放的订单 id：按钮内联 spinner，且防止重复点击（补发会作废旧码，连点两次
  // 会生成两张卡而只有一张有效，运营却以为两次都成功）。
  const [issuingId, setIssuingId] = useState(""); const [toast, setToast] = useState("");
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1); }, 300); return () => clearTimeout(timer); }, [query]);
  const { data, error, loading, reload } = useAdminData<OrderList>(`orders?${new URLSearchParams({ status, q: search, page: String(page) })}`);
  function exportCsv() {
    if (!data?.items.length) return;
    const rows = [["订单号", "账号邮箱", "套餐", "金额(CNY)", "支付方式", "状态", "创建时间"], ...data.items.map(order => [order.code, order.email, order.planName, order.amount, paymentLabel(order.paymentMethod), statusLabels[order.status], formatDate(order.createdAt)])];
    const escape = (text: string) => `"${(/^[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    const blob = new Blob(["\uFEFF" + rows.map(row => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = href; link.download = `haiou-orders-page-${page}.csv`; link.click(); URL.revokeObjectURL(href); setToast("本页订单已导出，请妥善保管账号数据");
  }

  // 行内「发放卡密 / 补发卡密」。
  //
  // 与弹窗里的 reissue 是同一个后端动作（PATCH { action: "reissue" }）——
  // 后端对"从未发过"会新建一张、对"已发过"会换码作废旧码，两种情况一次覆盖。
  // 放在列表行内而不是藏进弹窗，是因为它是最高频的救急操作：买家说没收到时，
  // 运营要的是在列表上直接看到并点下去，而不是先开弹窗、再找按钮、再确认。
  //
  // 关于"自动 vs 手动"：金额一致时买家在结果页会自动发卡，走到这一步说明
  // 自动发没发生或结果不对，因此这里一律是人工兜底，必须二次确认。
  async function issueCard(order: AdminOrder) {
    const already = (order.cardKeyCount ?? 0) > 0;
    const verb = already ? "补发" : "发放";
    const warn = already ? "\n\n补发会立即作废买家手上的旧卡密。" : "";
    if (!confirm("确认给订单 " + order.code + " " + verb + "卡密？" + warn + "\n\n卡密明文只显示这一次，请立即转交买家。此操作会记入审计日志。")) return;
    setIssuingId(order.id);
    try {
      const result = await api<{ code: string; replaced: boolean; superseded?: string[] }>("/api/admin/orders/" + order.id, { method: "PATCH", body: JSON.stringify({ action: "reissue", reason: "后台" + verb }) });
      setToast("已" + verb + "卡密 " + result.code);
      reload();
      setEditing(null);
    } catch (err) { setToast(errorMessage(err)); } finally { setIssuingId(""); }
  }
  return <><AdminHeading title="订单管理" subtitle="从付款到充值，每一步都井井有条。"><button className="button outline small" onClick={exportCsv} disabled={!data?.items.length || loading}><Download size={13}/>导出本页</button><button className="refresh-button" onClick={reload} aria-label="刷新订单"><RefreshCw size={15} className={loading ? "spinner" : ""}/></button></AdminHeading><div className="filter-toolbar"><div className="status-filters">{[["", "全部订单"], ...Object.entries(statusLabels)].map(([key, label]) => <button key={key} className={status === key ? "active" : ""} onClick={() => { setStatus(key); setPage(1); }}>{label}</button>)}</div><label className="search-box"><Search size={15}/><input aria-label="搜索订单号、邮箱或套餐" placeholder="搜索订单号、邮箱或套餐…" value={query} onChange={e => setQuery(e.target.value)} maxLength={100}/>{query && <button className="icon-button" onClick={() => setQuery("")} aria-label="清除搜索"><X size={12}/></button>}</label></div>{loading || error || !data ? <LoadingState error={error} retry={reload}/> : <section className="table-panel"><OrderTable orders={data.items} onEdit={setEditing} onIssue={issueCard} issuingId={issuingId}/><div className="pagination"><span>共 {data.total} 笔订单 · 每页 {data.pageSize} 条</span><div><button disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="上一页"><ChevronLeft size={13}/></button><span>{page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)} aria-label="下一页"><ChevronRight size={13}/></button></div></div></section>}{editing && <OrderEditor order={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); setToast("订单已更新，用户端将同步显示最新进度"); }}/>}<Toast message={toast} onClose={() => setToast("")}/></>;
}
function OrderEditor({ order, onClose, onSaved }: { order: AdminOrder; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(order.status); const [note, setNote] = useState(order.note); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [reissued, setReissued] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api(`/api/admin/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ status, note, confirmed }) }); onSaved(); } catch (err) { setError(errorMessage(err)); setBusy(false); } }
  // 补发：已付款但卡密丢失/未收到时重发一张。就地换码，旧码立即作废。
  // 必须与 FULFILLABLE_STATUSES（src/lib/catalog/pricing.ts）保持一致。
  // 此前写死 !["pending","cancelled"].includes(order.status)，于是 completed 订单
  // 会显示补发按钮——而服务端对 expired 又明确拒绝，点击必然报错。UI 与服务端
  // 两份白名单不一致，正是这类"按钮看得到但用不了"的直接原因。
  const canReissue = ["paid", "processing", "completed", "expired", "cancelled"].includes(order.status);
  async function reissue() {
    if (!confirm("确认补发卡密？\n\n补发会立即作废买家手上的旧卡密，换发一张新的。此操作会记入审计日志。")) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ code: string; replaced: boolean }>(`/api/admin/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ action: "reissue", reason: "后台补发" }) });
      setReissued(result.code);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}><form className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="edit-order-title" onClick={e => e.stopPropagation()} onSubmit={submit}><button type="button" className="modal-close icon-button" aria-label="关闭订单详情" onClick={onClose} disabled={busy}><X size={18}/></button><span className="section-kicker">ORDER DETAILS</span><h2 id="edit-order-title">每一笔订单，都认真对待。</h2><p className="dialog-subtitle">{order.code}</p><div className="summary-lines"><div className="summary-line"><span>充值套餐</span><span>{order.planName} / {order.period === "yearly" ? "年" : "月"}</span></div><div className="summary-line"><span>账号邮箱</span><span>{order.email}</span></div><div className="summary-line"><span>订单金额</span><span>¥{money(order.amount)}{order.usdtAmount && ` · ${order.usdtAmount} USDT`}</span></div><div className="summary-line"><span>支付方式</span><span>{paymentLabel(order.paymentMethod)}</span></div><div className="summary-line"><span>交易凭据</span><span>{order.transactionId || "尚无回调交易凭据"}</span></div><div className="summary-line"><span>创建时间</span><span>{formatDate(order.createdAt)}</span></div></div>
  {canReissue && <div className="reissue-box"><div className="reissue-head"><KeyRound size={14}/><strong>卡密补发</strong></div><p className="field-hint">买家已付款但卡密丢失、未收到或已核销未完成时，可换发一张。旧码会立即作废。</p>{reissued ? <div className="reissue-result"><span>新卡密（仅显示这一次，请立即转交买家）</span><code>{reissued}</code><div className="dialog-actions"><button type="button" className="button outline small" onClick={() => navigator.clipboard?.writeText(reissued)}>复制</button><button type="button" className="button outline small" onClick={() => setReissued(null)}>我已保存</button></div></div> : <button type="button" className="button outline small" onClick={reissue} disabled={busy}>{busy ? <Loader2 size={13} className="spinner"/> : <KeyRound size={13}/>}补发卡密</button>}</div>}<label className="field"><span className="field-label">订单状态</span><select className="input" value={status} onChange={e => { setStatus(e.target.value); setConfirmed(false); }}><option value={order.status}>{statusLabels[order.status]}（当前）</option>{statusFlow[order.status]?.map(item => <option key={item} value={item}>{statusLabels[item]}</option>)}</select><p className="field-hint">状态只允许向前推进，已完成订单不可回退。退款与售后请通过公告公布的联系方式联系客服处理，系统不提供自助退款入口。</p></label>{order.status === "pending" && status === "paid" && <><div className="notice warning"><Info size={15}/><span>手动确认支付会计入收入。请先在钱包或支付宝核对真实到账、金额及付款凭证，页面操作不能代替真实收款。</span></div><label className="checkbox-label"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>我已在实际收款账户中核实本订单付款。</span></label></>}{status === "completed" && order.status !== "completed" && <div className="notice" style={{ marginBottom: 19 }}><CheckCircle2 size={15}/><span>请确认账号订阅权益已实际到账，再将订单标记为已完成。</span></div>}<label className="field"><span className="field-label">处理说明（用户可见）</span><textarea className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="记录充值进度或向用户说明需要注意的事项…" maxLength={1000}/><p className="field-hint">请勿在备注中填写密码、密钥或其他敏感资料。</p></label>{error && <p className="form-error" role="alert">{error}</p>}<Link href={`/orders/${order.id}/result`} className="text-link" target="_blank" rel="noreferrer" style={{ fontSize: 10 }}>查看用户订单页面<ArrowUpRight size={12}/></Link><div className="dialog-actions"><button type="button" className="button outline" disabled={busy} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy && <Loader2 size={14} className="spinner"/>}保存订单变更</button></div></form></div>;
}
