"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, ArrowLeft, ArrowRight, Mail, Loader2, LockKeyhole, ReceiptText, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { api, getRecent, saveRecent, errorMessage, saveOrderPassword, type RecentOrder } from "@/lib/client";
import { money, paymentLabel, periodLabel, statusLabels } from "@/lib/catalog/catalog";
import { orderTotal } from "@/lib/catalog/pricing";
import { BrandIcon } from "./brand-icon";

/** 访客订单列表的一行。与 /api/orders/list 的白名单字段一一对应。 */
type AuthOrder = {
  id: string; code: string; planName: string; brand: string; period: string;
  amount: string; feeAmount: string; discountAmount: string;
  status: string; paymentMethod: string; canUsePassword: boolean;
  createdAt: string; updatedAt: string;
};

/**
 * 访客凭「购买邮箱 + 取卡密码」查历史。
 *
 * 刻意**不提供"只输入邮箱就返回订单"的入口**：本站注册无邮箱所有权验证，
 * 激活邮箱又是下单必填、等于半公开的信息。只凭邮箱返回列表 = 任何人都能
 * 猜邮箱捞走他人订单号与消费记录。密码是买家自己设的，只有本人知道。
 */

export default function OrderLookup() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [recent, setRecent] = useState<RecentOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 「凭购买邮箱 + 取卡密码查看历史订单」——访客版。
  // 与上面的单笔查询并存：单笔查询用于「订单号 + 激活邮箱」，
  // 这里用于「我只记得购买邮箱和当时设的密码」，可看到全部历史与卡密状态。
  const [listEmail, setListEmail] = useState("");
  const [listPassword, setListPassword] = useState("");
  const [list, setList] = useState<AuthOrder[] | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");

  // localStorage 只存在于浏览器，必须挂载后再读，否则与服务端渲染的输出不一致。
  // 放进微任务，避免在 effect 体内同步 setState。
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) setRecent(getRecent()); }); return () => { active = false; }; }, []);

  // 密码留在 state 里仅用于本次会话内的发卡请求；不写 localStorage。
  // localStorage 里的东西任何脚本都能读，而取卡密码的强度正是本设计的护栏。
  const queryByPassword = useCallback(async (targetEmail: string, targetPassword: string) => {
    if (!targetEmail || !targetPassword) return;
    setListBusy(true); setListError("");
    try {
      const data = await api<{ items: AuthOrder[] }>("/api/orders/auth", { method: "POST", body: JSON.stringify({ email: targetEmail, password: targetPassword }) });
      setList(data.items);
    } catch (err) { setListError(errorMessage(err)); setList(null); }
    finally { setListBusy(false); }
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { const order = await api<RecentOrder>("/api/orders/lookup", { method: "POST", body: JSON.stringify({ code, email }) }); saveRecent(order); router.push(`/orders/${order.id}/result`); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  function submitList(event: FormEvent) {
    event.preventDefault();
    void queryByPassword(listEmail.trim().toLowerCase(), listPassword);
  }

  return <main className="page-main container">
    <div className="page-topline"><Link className="back-link" href="/"><ArrowLeft size={14}/>返回首页</Link><span><LockKeyhole size={12}/>你的订单，仅你可见</span></div>
    <div className="page-title"><span className="section-kicker">EVERY STEP, IN SIGHT.</span><h1>你的订阅，进展如何？</h1><p>输入订单号与下单邮箱，随时查看充值进度。</p></div>

    <form className="panel lookup-panel" onSubmit={submit}>
      <div className="lookup-icon"><Search size={25} strokeWidth={1.5}/></div>
      <label className="field"><span className="field-label">订单号</span><div className="input-icon"><ReceiptText size={15}/><input className="input" name="orderCode" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="以 AU 开头的订单号" required maxLength={40} autoComplete="off"/></div></label>
      <label className="field"><span className="field-label">账号邮箱</span><div className="input-icon"><Mail size={15}/><input className="input" name="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="填写下单时使用的账号邮箱" required maxLength={254} autoComplete="email"/></div><p className="field-hint">为保护你的隐私，订单号与邮箱必须匹配。</p></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button primary full" disabled={busy}>{busy ? <><Loader2 size={16} className="spinner"/>正在查询…</> : <>查询订单<ArrowRight size={16}/></>}</button>
      <p className="summary-trust"><LockKeyhole size={11}/>不登录，也能安心管理你的订单</p>
    </form>

{/* ---- 凭购买邮箱 + 取卡密码查看历史订单（访客）---- */}
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="admin-panel-header"><h2>凭取卡密码查看历史订单</h2>{list && <span>共 {list.length} 笔</span>}</div>
      <form onSubmit={submitList}>
        <div className="form-row">
          <label className="field"><span className="field-label">购买邮箱</span><div className="input-icon"><Mail size={15}/><input className="input" type="email" value={listEmail} onChange={e => setListEmail(e.target.value)} placeholder="下单时填写的购买邮箱" autoComplete="email" maxLength={254} required/></div></label>
          <label className="field"><span className="field-label">取卡密码</span><input className="input" type="password" value={listPassword} onChange={e => setListPassword(e.target.value)} placeholder="下单时设置的取卡密码" autoComplete="current-password" maxLength={128} required/></label>
        </div>
        <button type="submit" className="button primary full" disabled={listBusy || !listEmail.trim() || !listPassword}>{listBusy ? <Loader2 size={15} className="spinner"/> : <Search size={15}/>}查看我的订单</button>
      </form>

      <p className="field-hint" style={{ marginTop: 10 }}>仅在下单时设置过「取卡密码」的订单可用此方式查看。没设过的话，请用上方的「订单号 + 邮箱」查询单笔订单。</p>

      {listError && <p className="form-error" role="alert" style={{ marginTop: 12 }}>{listError}</p>}

      {list && <>
        {list.length === 0
          ? <div className="empty-state"><ReceiptText size={28}/><h3>没有匹配的订单</h3><p>请确认购买邮箱与取卡密码是否与下单时一致。</p></div>
          : <div className="table-wrap" style={{ marginTop: 14 }}><table className="data-table">
              <thead><tr><th>订单 / 套餐</th><th>实付金额</th><th>支付方式</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
              <tbody>{list.map(order => <tr key={order.id}>
                <td><span className="table-code">{order.code}</span><span className="table-sub">{order.planName} · {periodLabel(order.period)}付</span></td>
                <td>¥{money(orderTotal(order))}</td>
                <td>{paymentLabel(order.paymentMethod)}</td>
                <td><span className={`status-badge status-${order.status}`}>{statusLabels[order.status] || order.status}</span></td>
                <td><span className="table-sub no-margin">{new Date(order.createdAt).toLocaleDateString("zh-CN")}</span></td>
                <td>
                  {/* 取卡密码**绝不能**进 URL（历史 / access.log / Referer / 截图）。
                      改为写进 sessionStorage 再跳转：只在当前标签页有效，关掉即失效。 */}
                  <button
                    type="button"
                    className="table-action"
                    onClick={() => { saveOrderPassword(order.id, listPassword); router.push(`/orders/${order.id}/result`); }}
                  >详情 / 领卡<ArrowRight size={12}/></button>
                </td>
              </tr>)}</tbody>
            </table></div>}
        <p className="summary-note" style={{ textAlign: "center", marginTop: 14 }}>卡密明文只在订单详情页首次领取时展示一次，请及时保存。</p>
      </>}
    </section>

    {recent.length > 0 && <section className="recent-orders">
      <div className="recent-heading"><h3>最近的订单</h3><button className="table-action" onClick={() => { try { localStorage.removeItem("aura_recent_orders"); } catch {} setRecent([]); }}><Trash2 size={12}/>清除本地记录</button></div>
      {recent.map(order => <Link key={order.id} href={`/orders/${order.id}/result`} className={`recent-order ${order.brand}`}><span className="plan-logo"><BrandIcon brand={order.brand}/></span><div><h4>{order.planName}</h4><p>{order.code}</p></div><ArrowUpRightIcon/></Link>)}
      <p className="summary-note" style={{ textAlign: "center", marginTop: 14 }}>仅展示当前浏览器保存的订单，请勿分享订单详情链接。</p>
    </section>}
  </main>;
}
function ArrowUpRightIcon() { return <ArrowRight size={16}/>; }