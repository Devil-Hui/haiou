"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CircleCheck, Copy, Clock3, X, RefreshCw, Loader2, Info, ShieldCheck, LockKeyhole, Wallet, ReceiptText, Ban } from "lucide-react";
import type { Order } from "@/db/schema";
import { api, errorMessage, formatDate, getDeliveryToken, getOrderPassword } from "@/lib/client";
import { money, paymentLabel, periodLabel, statusLabels } from "@/lib/catalog/catalog";
import { Steps } from "./site-shell";
import { orderTotal } from "@/lib/catalog/pricing";
import { PaymentSymbol } from "./checkout";
import CardDelivery from "./card-delivery";

type ClientOrder = Omit<Order, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string; delivery?: string };
type Payment = { available: boolean; method: string; message?: string; walletAddress?: string; network?: string; amount?: string; total?: string; qrCode?: string; checkoutUrl?: string; usdtAmount?: string };
/**
 * 跳转收银台的按钮文案与目标说明。
 *
 * 与结算页同理：这里曾用嵌套三元，加到第三条通道时已经很难看出条件挂对了没有。
 * 查表 + `??` 兜底后，新增通道漏配会直接显示"前往支付"这种泛化文案，
 * 而不会悄悄把币安按钮写成"前往支付宝官方收银台"（那是个会让买家误认收款方的 bug）。
 */
const CHECKOUT_LABEL: Record<string, string> = {
  epusdt: "前往 USDT 收银台",
  epay: "前往在线收银台",
  binance: "前往币安收银台",
};
const CHECKOUT_TARGET: Record<string, string> = {
  epusdt: "本站自建的 USDT 收银台",
  epay: "第三方收银台",
  binance: "币安官方收银台",
};

const stateCopy: Record<string, { title: string; description: string }> = {
  pending: { title: "你的订单，已准备就绪。", description: "还差最后一步。完成付款后，我们就会为你的 AI 续航。" },
  paid: { title: "付款已确认，灵感即将续航。", description: "已收到你的付款，订单正在等待处理，请勿重复支付。" },
  processing: { title: "正在充值，好事即将发生。", description: "你的订阅正在处理中，完成后这里会自动更新。" },
  completed: { title: "能量已满格，开始创造吧。", description: "你的订阅已充值完成，登录 AI 账号即可查看会员权益。" },
  cancelled: { title: "订单已取消，下次灵感见。", description: "此订单已停止处理，请勿继续转账。你可以重新选择喜欢的套餐。" },
};

/**
 * 取卡密码不再由 URL 传入（?pw= 会进历史、日志与 Referer，见 lib/client.ts 的说明）。
 * 改从 sessionStorage 读取：订单查询页跳转前写入，本页挂载后取出，
 * 只在当前标签页内有效，关闭即失效。取不到就当作"没有密码"，走取卡码那条路。
 */
export default function OrderView({ id, view }: { id: string; view: "payment" | "result" }) {
  const router = useRouter();
  const [order, setOrder] = useState<ClientOrder | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // 从 sessionStorage 读取访客跳转时写入的取卡密码（取代原 ?pw= URL 传参）。
  // 只在挂载初期读一次即可；sessionStorage 在关掉标签页前不会自己消失。
  const [password] = useState(() => (view === "result" ? getOrderPassword(id) : ""));
  const load = useCallback(async () => {
    setError(""); setLoading(true);
    try {
      const data = await api<ClientOrder>(`/api/orders/${id}`); setOrder(data);
      if (view === "payment") {
        if (data.status !== "pending") { router.replace(`/orders/${id}/result`); return; }
        // 支付准备接口按归属校验要求必须带取卡码（见 api/orders/[id]/payment/route.ts）。
        // 不传会 403，而这里的错误会顶掉整屏 → 买家永远看不到收款地址/收银台，流程直接断。
        setPayment(await api<Payment>(`/api/orders/${id}/payment?token=${encodeURIComponent(getDeliveryToken(data.code))}`, { method: "POST" }));
      }
    } catch (err) { setError(errorMessage(err)); } finally { setLoading(false); }
  }, [id, view, router]);
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) load(); }); return () => { active = false; }; }, [load]);
  useEffect(() => {
    // 只依赖"当前状态"决定要不要继续轮询；不把整个 order 放进依赖，
    // 否则每轮 10 秒轮询 setOrder 都会把它重置。终态（completed/cancelled）直接退出。
    const status = order?.status;
    if (!status || ["completed", "cancelled"].includes(status)) return;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try { const data = await api<ClientOrder>(`/api/orders/${id}`); setOrder(data); if (view === "payment" && data.status !== "pending") router.replace(`/orders/${id}/result`); } catch { /* Manual refresh remains available. */ }
    }, 10000);
    return () => clearInterval(timer);
  }, [id, order?.status, view, router]);
  async function refresh() {
    setChecking(true); setFeedback("");
    try { const data = await api<ClientOrder>(`/api/orders/${id}`); setOrder(data); if (view === "payment" && data.status !== "pending") router.replace(`/orders/${id}/result`); else setFeedback(data.status === "pending" ? "暂未收到付款确认。若已付款，请耐心等待确认，请勿重复支付。" : `已更新 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`); }
    catch (err) { setFeedback(errorMessage(err)); } finally { setChecking(false); }
  }
  async function cancel() {
    setCancelling(true);
    try {
      // 取消订单现在需要一次性取卡码（与服务端归属校验一致）。取卡码按**订单号**
      // 存在 localStorage，因此要先有order.code 才能取到——订单未加载出来时
      // 直接给出可理解的提示，而不是让服务端回一句 403。
      if (!order?.code) { setFeedback("订单信息尚未加载完成，请稍后重试"); setCancelOpen(false); return; }
      const token = getDeliveryToken(order.code);
      await api(`/api/orders/${id}?token=${encodeURIComponent(token)}`, { method: "PATCH", body: JSON.stringify({ action: "cancel" }) });
      setCancelOpen(false);
      if (view === "payment") router.replace(`/orders/${id}/result`); else await load();
    }
    catch (err) { setFeedback(errorMessage(err)); setCancelOpen(false); } finally { setCancelling(false); }
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); setTimeout(() => setCopied(""), 2200); } catch { setFeedback("当前浏览器未开放剪贴板权限，请长按或选中文字手动复制。"); }
  }
  if (loading) return <main className="container loading-view"><Loader2 size={26} className="spinner"/><p>正在读取你的订单…</p></main>;
  if (error || !order) return <main className="page-main container"><div className="empty-state"><ReceiptText size={32}/><h3>暂时无法读取订单</h3><p>{error || "请检查订单链接是否正确"}</p><div className="result-actions"><button className="button primary" onClick={load}>重新加载<RefreshCw size={15}/></button><Link href="/orders" className="button outline">重新查询订单</Link></div></div></main>;
  const copyInfo = stateCopy[order.status] || stateCopy.pending;
  return <main className="page-main container"><div className="page-topline"><Link href="/orders" className="back-link"><ArrowLeft size={14}/>返回订单查询</Link><span><ShieldCheck size={12}/>订单状态安全同步</span></div><Steps current={view === "payment" ? 2 : order.status === "pending" ? 2 : 3}/>{view === "payment" ? <><div className="page-title"><span className="section-kicker">ONE STEP CLOSER TO YOUR NEXT IDEA.</span><h1>安心支付，轻松续航。</h1><p>订单已创建，请使用你选择的方式完成付款。</p></div><section className="panel payment-panel"><div className="payment-head"><div style={{ display: "flex", alignItems: "center", gap: 12 }}><PaymentSymbol method={order.paymentMethod}/><h2>{paymentLabel(order.paymentMethod)}</h2></div><StatusBadge status={order.status}/></div>{payment?.available ? <><div className="pay-amount"><p>{order.paymentMethod === "usdt" ? "请确保实际到账金额为" : "订单实付金额"}</p><h2>{order.paymentMethod === "usdt" ? payment.amount : `¥${money(payment.total ?? orderTotal(order))}`}<small>{order.paymentMethod === "usdt" ? "USDT" : "CNY"}</small></h2>{order.paymentMethod === "usdt" && <span>对应人民币 ¥{money(payment.total ?? orderTotal(order))} · 下单汇率已锁定</span>}</div>{order.paymentMethod === "usdt" ? <>{payment.qrCode && <div className="qr-wrap">{
                // QR 是服务端 qrDataUrl() 返回的 data: URI（base64 位图），next/image 不支持
                // data: URL，只能用裸 <img>；宽高已显式给出避免 CLS。
                // eslint-disable-next-line @next/next/no-img-element -- data: URI 无法交给 next/image 优化
                <img src={payment.qrCode} width={178} height={178} alt="USDT TRC20 收款钱包地址二维码"/>
              }</div>}<div className="wallet-address"><label>TRON（TRC20）收款地址</label><div className="copy-field"><code>{payment.walletAddress}</code><button className="icon-button" onClick={() => copy(payment.walletAddress!, "wallet")} aria-label="复制收款地址">{copied === "wallet" ? <Check size={16}/> : <Copy size={16}/>}</button></div><button className="table-action" style={{ marginTop: 8 }} onClick={() => copy(payment.amount!, "amount")}>{copied === "amount" ? <Check size={12}/> : <Copy size={12}/>}复制精确金额</button></div><div className="notice warning"><Info size={15}/><span>仅支持 TRC20 网络，请勿使用 ERC20 / BEP20。二维码仅包含钱包地址，请手动填写完整金额，并额外预留网络手续费。链上转账无法撤回。</span></div></> : <div className="payment-actions"><a className="button primary full" href={payment.checkoutUrl} target="_blank" rel="noopener noreferrer">{CHECKOUT_LABEL[order.paymentMethod] ?? "前往支付"}<ArrowUpRight size={17}/></a><div className="notice"><LockKeyhole size={15}/><span>将在新窗口打开{CHECKOUT_TARGET[order.paymentMethod] ?? "支付页面"}。付款后请返回此页面，支付结果以服务端验签通知为准。{order.paymentMethod === "epusdt" && <>链上确认后订单会自动更新，无需人工核实到账。</>}{order.paymentMethod === "binance" && <>钱包余额下载后会发起链上确认，请等待一会儿再回到本页查状态。</>}</span></div></div>}<div className="payment-actions"><button className="button outline full" onClick={refresh} disabled={checking}>{checking ? <Loader2 size={15} className="spinner"/> : <RefreshCw size={15}/>}我已完成付款，查询状态</button>{feedback && <p className="query-feedback" role="status">{feedback}</p>}</div></> : <div className="payment-unconfigured"><span className="dialog-icon"><Wallet size={27}/></span><h3>收款通道准备中</h3><p>{payment?.message || "支付通道尚未就绪，请稍后再试。"}</p><div className="notice warning"><Info size={15}/><span>请不要向任何非本订单展示的地址付款。真实钱包或支付宝参数需由管理员在后台配置。</span></div><div className="payment-actions"><button className="button primary" onClick={load}><RefreshCw size={15}/>重新检查支付通道</button><Link href={`/orders/${id}/result`} className="button outline">查看已保存的订单<ArrowRight size={15}/></Link></div></div>}<div className="payment-meta"><div className="summary-line"><span>订单编号</span><span><button className="table-action no-margin" onClick={() => copy(order.code, "code")}>{order.code}{copied === "code" ? <Check size={11}/> : <Copy size={11}/>}</button></span></div><div className="summary-line"><span>所选套餐</span><span>{order.planName} / {periodLabel(order.period)}</span></div><div className="summary-line"><span>账号邮箱</span><span>{order.email}</span></div><div className="summary-line"><span>创建时间</span><span>{formatDate(order.createdAt)}</span></div></div><p className="summary-note" style={{ textAlign: "center", marginTop: 20 }}>支付方式已随订单锁定。如需更换，请取消未付款订单后重新下单。</p><button className="button full" style={{ marginTop: 7, fontSize: 10, color: "#a7ad99", height: 30 }} onClick={() => setCancelOpen(true)}>取消此订单</button></section></> : <>{order.delivery === "cdk" && <CardDelivery orderId={id} orderCode={order.code} password={password}/>}<section className="panel result-card"><div className="result-top"><div className={`result-mark ${order.status === "pending" ? "pending" : order.status === "cancelled" ? "cancelled" : ""}`}>{order.status === "cancelled" ? <Ban size={30} strokeWidth={1.5}/> : order.status === "completed" ? <CircleCheck size={33} strokeWidth={1.5}/> : <Clock3 size={32} strokeWidth={1.5}/>}</div><h1>{copyInfo.title}</h1><p>{copyInfo.description}</p></div>{order.status !== "cancelled" && <div className="timeline">{["订单创建", "支付确认", "充值处理中", "充值完成"].map((label, i) => { const current = ["pending", "paid", "processing", "completed"].indexOf(order.status); return <div key={label} className={`timeline-item ${i <= current ? "done" : ""}`}><span>{i <= current ? <Check size={12}/> : `0${i + 1}`}</span><p>{label}</p></div>; })}</div>}<div className="result-details"><div className="summary-line"><span>订单状态</span><StatusBadge status={order.status}/></div><div className="summary-line"><span>订单编号</span><span><button className="table-action" onClick={() => copy(order.code, "code")}>{order.code}{copied === "code" ? <Check size={11}/> : <Copy size={11}/>}</button></span></div><div className="summary-line"><span>充值套餐</span><span>{order.planName} / {order.period === "yearly" ? "全年订阅" : "月度订阅"}</span></div><div className="summary-line"><span>账号邮箱</span><span>{order.email}</span></div><div className="summary-line"><span>订单实付金额</span><span>¥{money(orderTotal(order))}{order.usdtAmount && ` / ${order.usdtAmount} USDT`}</span></div><div className="summary-line"><span>支付方式</span><span>{order.paymentMethod === "usdt" ? "USDT（TRC20）" : paymentLabel(order.paymentMethod)}</span></div><div className="summary-line"><span>下单时间</span><span>{formatDate(order.createdAt)}</span></div><div className="summary-line"><span>最后更新</span><span>{formatDate(order.updatedAt)}</span></div></div>{order.note && <div className="notice result-note"><Info size={15}/><div><strong>订单处理说明</strong><br/>{order.note}</div></div>}{feedback && <p className="query-feedback" style={{ marginTop: 18 }} role="status">{feedback}</p>}<div className="result-actions">{order.status === "pending" ? <><Link href={`/orders/${id}/payment`} className="button primary">继续支付<ArrowRight size={16}/></Link><button className="button outline" onClick={refresh} disabled={checking}><RefreshCw size={14} className={checking ? "spinner" : ""}/>刷新状态</button></> : <><Link href="/#plans" className="button primary">{order.status === "completed" ? "探索更多 AI 套餐" : "返回套餐首页"}<ArrowUpRight size={15}/></Link>{!["completed", "cancelled"].includes(order.status) && <button className="button outline" onClick={refresh} disabled={checking}><RefreshCw size={14} className={checking ? "spinner" : ""}/>刷新状态</button>}</>}</div>{order.status === "pending" && <button className="button full" style={{ fontSize: 10, color: "#a3ad97", marginTop: 7 }} onClick={() => setCancelOpen(true)}>取消未付款订单</button>}<p className="summary-trust"><ShieldCheck size={12}/>{["completed", "cancelled"].includes(order.status) ? "妥善保存订单号，方便后续查询" : "页面每 10 秒自动查询一次最新状态"}</p></section></>}{cancelOpen && <div className="modal-backdrop" onClick={() => !cancelling && setCancelOpen(false)}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭" disabled={cancelling} onClick={() => setCancelOpen(false)}><X size={18}/></button><span className="dialog-icon"><ReceiptText size={25}/></span><h2 id="cancel-title">确定取消此订单？</h2><p className="dialog-subtitle">取消后将无法继续支付此订单。如果你已转账或完成支付宝付款，请不要取消，等待支付确认即可。</p><div className="dialog-actions"><button className="button outline" disabled={cancelling} onClick={() => setCancelOpen(false)}>保留订单</button><button className="button danger" disabled={cancelling} onClick={cancel}>{cancelling && <Loader2 size={14} className="spinner"/>}我未付款，确认取消</button></div></section></div>}</main>;
}
export function StatusBadge({ status }: { status: string }) { return <span className={`status-badge status-${status}`}>{statusLabels[status] || status}</span>; }
