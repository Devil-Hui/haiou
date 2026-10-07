"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, CircleUserRound, KeyRound, Loader2, LogOut, Package, ReceiptText, ShieldCheck } from "lucide-react";
import { money, paymentLabel, periodLabel, statusLabels } from "@/lib/catalog/catalog";
import { orderTotal } from "@/lib/catalog/pricing";
import { api, errorMessage } from "@/lib/client";

type Order = {
  id: string; code: string; planName: string; brand: string; period: string;
  amount: string; feeAmount: string;
  // 缺这个字段时 orderTotal 会把券抵扣当成 0，个人中心显示的实付金额就会偏大。
  discountAmount?: string; status: string; paymentMethod: string; note: string; createdAt: string; updatedAt: string;
};
type Props = {
  email: string;
  status: string;
  orders: { items: Order[]; total: number; page: number; pageSize: number };
};

const FILTERS = ["", "pending", "paid", "processing", "completed", "cancelled"] as const;

export default function AccountCenter({ email, status, orders }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);

  const totalPages = Math.max(1, Math.ceil(orders.total / orders.pageSize));
  // 翻页时保留当前筛选，否则点下一页会跳回"全部"，这是订单列表最常见的体验 bug。
  const href = (next: { status?: string; page?: number }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    if (s) params.set("status", s);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const qs = params.toString();
    return qs ? `/me?${qs}` : "/me";
  };

  async function logout() {
    setBusy(true);
    try { await api("/api/account", { method: "DELETE" }); router.push("/"); router.refresh(); }
    catch (err) { setActionError(errorMessage(err)); setBusy(false); }
  }

  return <main className="page-main container">
    <div className="page-topline"><span><ShieldCheck size={12}/>仅你可见的个人中心</span></div>
    <div className="page-title">
      <span className="section-kicker">ONE ACCOUNT, EVERYTHING TRACKED.</span>
      <h1>我的账户。</h1>
      <p>在这里查看全部订单与已发放的卡密。</p>
    </div>

    <div className="account-grid">
      <section className="panel">
        <h2 className="panel-heading"><CircleUserRound size={18}/>账户信息</h2>
        <div className="summary-lines">
          <div className="summary-line"><span>登录邮箱</span><span>{email}</span></div>
          <div className="summary-line"><span>累计订单</span><span>{orders.total} 笔</span></div>
        </div>
        <div className="payment-actions">
          <Link className="button outline full" href="/orders"><ReceiptText size={15}/>按订单号查单</Link>
          <button className="button outline full" onClick={() => setPasswordOpen(true)}><KeyRound size={15}/>修改密码</button>
          <button className="button outline full" onClick={logout} disabled={busy}>{busy ? <Loader2 size={15} className="spinner"/> : <LogOut size={15}/>}退出登录</button>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-heading"><Package size={18}/>我的兑换</h2>
        <p className="muted">本站采用自动交付，你下的每一单都会在订单结果页显示可用的兑换内容。请在打开时及时保存，兑换码只展示一次。</p>
        <div className="payment-actions" style={{ marginTop: 14 }}>
          <Link className="button outline full" href="/#plans">去逛套餐</Link>
          <Link className="button outline full" href="/orders">查看全部订单</Link>
        </div>
        <p className="summary-note" style={{ marginTop: 12 }}>如需帮助，请使用页面右下角的客服入口。</p>
      </section>
    </div>

    <section className="panel" style={{ marginTop: 20 }}>
      <div className="admin-panel-header"><h2>我的订单</h2><span>共 {orders.total} 笔</span></div>
      <div className="filter-toolbar">
        {FILTERS.map((key) => (
          <Link key={key || "all"} className={`status-chip ${status === key ? "active" : ""}`} href={href({ status: key })}>
            {key === "" ? "全部" : statusLabels[key]}
          </Link>
        ))}
      </div>

      {actionError && <p className="inline-error" role="alert">{actionError}</p>}
      {orders.items.length === 0
        ? <div className="empty-state"><ReceiptText size={28}/><h3>没有符合条件的订单</h3><p>换个筛选条件，或去挑一个套餐。</p><Link className="button primary" href="/#plans">去逛套餐</Link></div>
        : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>订单 / 套餐</th><th>实付金额</th><th>支付方式</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>{orders.items.map((order) => <tr key={order.id}>
              <td><span className="table-code">{order.code}</span><span className="table-sub">{order.planName} · {periodLabel(order.period)}付</span></td>
              <td>¥{money(orderTotal(order))}{Number(order.feeAmount) > 0 && <span className="table-sub">含手续费 ¥{money(order.feeAmount)}</span>}</td>
              <td>{paymentLabel(order.paymentMethod)}</td>
              <td><span className={`status-badge status-${order.status}`}>{statusLabels[order.status] || order.status}</span></td>
              <td><span className="table-sub no-margin">{new Date(order.createdAt).toLocaleDateString("zh-CN")}</span></td>
              <td><Link className="table-action" href={`/orders/${order.id}/result`}>详情<ArrowUpRight size={12}/></Link></td>
            </tr>)}</tbody>
          </table></div>}

      {totalPages > 1 && <div className="filter-toolbar">
        <span className="summary-note">第 {orders.page} / {totalPages} 页</span>
        <div className="status-filters">
          <Link className="table-action" href={href({ page: orders.page - 1 })}>上一页</Link>
          <Link className="table-action" href={href({ page: orders.page + 1 })}>下一页</Link>
        </div>
      </div>}
    </section>

    {passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)}/>}
  </main>;
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (next !== confirm) { setError("两次输入的新密码不一致"); return; }
    setBusy(true);
    try {
      await api("/api/account/me", { method: "PATCH", body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      setDone(true);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="user-password-title" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
      <span className="section-kicker">CREDENTIAL ROTATION</span>
      <h2 id="user-password-title">{done ? "密码已更新" : "修改登录密码"}</h2>
      <p className="dialog-subtitle">{done ? "所有设备已退出，请用新密码重新登录。" : "需要验证当前密码。新密码至少 12 位，不能是常见弱口令或包含邮箱前缀。"}</p>
      {!done ? <>
        <label className="field"><span className="field-label">当前密码</span><input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required maxLength={128}/></label>
        <label className="field"><span className="field-label">新密码</span><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={128}/></label>
        <label className="field"><span className="field-label">确认新密码</span><input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={128}/></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy && <Loader2 size={14} className="spinner"/>}更新密码</button></div>
      </> : <div className="dialog-actions"><button type="button" className="button primary" onClick={() => { onClose(); router.push("/register"); }}>去重新登录</button></div>}
    </form>
  </div>;
}
