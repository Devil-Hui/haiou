"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, ShieldCheck, Mail, Info, Check, Loader2, LockKeyhole, Wallet } from "lucide-react";
import type { Plan } from "@/db/schema";
import { BrandIcon } from "./brand-icon";
import { Steps } from "./site-shell";
import { money, periodLabel } from "@/lib/catalog/catalog";
import { priceBreakdown, toUsdt, CHANNEL_FEE_DEFAULTS } from "@/lib/catalog/pricing";
import { api, errorMessage, saveRecent, type RecentOrder, saveDeliveryToken } from "@/lib/client";

export function PaymentSymbol({ method }: { method: string }) { return <span className={`payment-symbol ${method}`}>{method === "usdt" || method === "epusdt" ? "₮" : method === "binance" ? "B" : method === "cdk" ? "卡" : "支"}</span>; }

/** 可选支付方式。顺序即结算页展示顺序：先国内熟悉的，再聚合与加密的。 */
const METHODS = ["alipay", "usdt", "epusdt", "epay", "binance"] as const;
type Method = (typeof METHODS)[number];

/**
 * 通道文案集中在这里，而不是散在 JSX 的嵌套三元里。
 *
 * 加一条通道时曾经需要在同一行里塞进第四层三元，条件一旦写错位置
 * （例如把 usdt 的说明挂到 epay 上）是完全看不出来的——它们都渲染正常。
 * 改成查表后，"某条通道没有文案"会直接显示成 undefined 而被立刻发现。
 */
const METHOD_LABEL: Record<Method, string> = {
  alipay: "支付宝",
  usdt: "USDT",
  epusdt: "USDT 自建收银台",
  epay: "在线收银台",
  binance: "币安支付",
};

/** 通道副标题。USDT 需要显示参考汇率，其余是固定文案。 */
function methodHint(item: Method, exchangeRate: string): string {
  if (item === "usdt") return `TRC20 网络 · 参考汇率 1 USDT ≈ ¥${money(exchangeRate)}`;
  if (item === "epusdt") return "自建收银台 · 链上支付，订单即时确认";
  if (item === "epay") return "聚合收银台，一次支持多种支付方式";
  if (item === "binance") return "Binance Pay · 币安账户直接付款";
  return "熟悉的支付方式，安全便捷";
}

/** 付款前的须知。USDT 与币安都是加密支付，提示必须说清网络与不可撤销。 */
function payNotice(method: Method, payable: number, exchangeRate: string): string {
  if (method === "usdt") return `请仅使用 TRON（TRC20）网络转账，预计需支付 ${toUsdt(payable, exchangeRate)} USDT。订单创建后会锁定汇率与金额，请以支付页显示为准。`;
  if (method === "epusdt") return "创建订单后将跳转本站自建的 USDT 收银台，按页面显示的链与地址付款。链上确认后订单会自动更新，无需人工核实。";
  if (method === "epay") return "创建订单后将跳转第三方聚合收银台完成付款，本站不接触你的支付账户信息。";
  if (method === "binance") return "创建订单后将跳转币安官方收银台，用币安 App 扫码或直接支付，支持 USDT 等多种加密货币。链上转账一经确认不可撤销。";
  return "创建订单后将前往支付页，通过支付宝官方收银台完成付款，本站不会获取你的支付宝账户信息。";
}

export default function Checkout({ plan, availability, exchangeRate, channelRates, signedIn = false }: { plan: Plan; availability: { usdt: boolean; alipay: boolean; epay?: boolean; epusdt?: boolean; binance?: boolean }; exchangeRate: string; channelRates: { alipay: string; epay: string; usdt: string; epusdt?: string; binance?: string }; signedIn?: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [method, setMethod] = useState<Method>("alipay");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 买家看到的手续费与实付，必须与服务端算出来的完全一致——用同一个函数，
  // 不在这里另写一份算术。前端算的只用于展示，真正的入账金额以订单落库为准。
  // 展示口径必须与下单一致，且**必须按当前所选通道算**。
  // 此前固定用支付宝费率，于是选 USDT 时页面显示 119.72、下单却按 1% 收 120.20
  // ——买家看到的和实际扣的不一样，这是可以直接引发投诉与平台判违规的。
  //
  // 更严重的一处：这里曾读 CHANNEL_FEE_DEFAULTS（编译进 JS 的常量），
  // 而下单读数据库里的真实费率。运营在后台改完费率，前端还按旧常量显示，
  // 于是「后台设的收到金额」与「买家看到的金额」长期不一致。
  // 现在由 page.tsx 把 payment_settings 的三个费率原样传下来，
  // 前端算与下单算同源同函数，运营改完后台立刻两边一起变。
  const rate = channelRates?.[method] ?? CHANNEL_FEE_DEFAULTS[method] ?? 0;
  const bill = priceBreakdown(plan.price, plan.feeRate, rate);
  // 优惠券：只把"券码"传下去，抵扣金额一律由服务端算。前端存的 discount 仅用于即时展示，
  // 真正入账的金额以下单接口落库的 discountAmount 为准。
  // ---- 取卡密码与购买邮箱 ----
  // 购买邮箱默认与激活邮箱相同；单独拆出来是为了支持「注册邮箱 ≠ 充值邮箱」。
  //
  // 取卡密码对**访客必填**：付款后除了一次性取卡码（只展示一次）之外，
  // 它是唯一的找回途径。已登录用户则免填——会话本身就是凭据。
  // 服务端会再校验一次，这里先挡住，避免走到提交后才发现没过。
  const [purchaseEmail, setPurchaseEmail] = useState("");
  const [cardPassword, setCardPassword] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [coupon, setCoupon] = useState<{ valid: boolean; discountAmount?: string; reason?: string; note?: string } | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);

  const discount = coupon?.valid ? Number(coupon.discountAmount || 0) : 0;
  const payable = Math.max(0.01, Number(bill.total) - discount);
  // 只展示已就绪的通道。此前 epay 用 `item !== "epay" || availability.epay` 特判，
  // 而支付宝/USDT 未就绪时**仍然显示**（带"待配置"角标）——买家可以选一条必然
  // 失败的支付方式，付不了钱还拿不到提示。统一改成过滤掉全部未就绪通道。
  //
  // 一条都没就绪时必须显式拦住：否则下面 method 的初值 "alipay" 会让页面
  // 渲染出一个"已选中但列表里根本没有该选项"的状态，且提交按钮仍可点。
  const availableMethods = METHODS.filter(item => availability[item]);
  const noneReady = availableMethods.length === 0;

  async function applyCoupon() {
    if (!couponCode.trim()) return;
    setCouponBusy(true);
    try {
      const result = await api<{ valid: boolean; discountAmount?: string; reason?: string; note?: string }>("/api/coupons/check", {
        method: "POST",
        body: JSON.stringify({ code: couponCode, email, amount: bill.total }),
      });
      setCoupon(result);
    } catch (err) {
      setCoupon({ valid: false, reason: errorMessage(err) });
    } finally {
      setCouponBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (step === 1) {
      if (email.trim().toLowerCase() !== confirmation.trim().toLowerCase()) { setError("两次填写的账号邮箱不一致，请核对后重试"); return; }
      if (!accepted) { setError("请先阅读并同意服务条款"); return; }
      setStep(2); window.scrollTo({ top: 90, behavior: "smooth" }); return;
    }
    // 服务端会再校验一次（以防绕过前端直接调接口），这里先挡住明显的无效提交，
    // 避免创建出一个注定无法支付的订单、污染后台的待支付列表。
    if (noneReady) { setError("收款通道尚未配置完成，暂时无法创建订单。请稍后重试。"); return; }
    // 访客必须设取卡密码。不在前端挡的话，用户要走完整个下单流程
    // 才被服务端驳回，而此时他已经填完所有信息了。
    if (!signedIn && !cardPassword.trim()) {
      setError("请先设置取卡密码，这是你付款后查回订单与领取卡密的唯一凭据"); return;
    }
    setBusy(true);
    try {
      const order = await api<RecentOrder>("/api/orders", { method: "POST", body: JSON.stringify({ planId: plan.id, email, purchaseEmail, cardPassword, accepted, paymentMethod: method, couponCode: coupon?.valid ? couponCode : "" }) });
      // 取卡码只在此刻返回一次（服务端只留 sha256 摘要），必须立刻落盘，
      // 否则买家刷新之后就再也取不到卡密了。
      if (order.deliveryToken) saveDeliveryToken(order.code, order.deliveryToken);
      saveRecent(order); router.push(`/orders/${order.id}/payment`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }
  return <main className="page-main container"><div className="page-topline"><Link href="/#plans" className="back-link"><ArrowLeft size={14}/>返回充值套餐</Link><span><ShieldCheck size={12}/>安心下单 · 信息加密传输</span></div><Steps current={step}/><div className="page-title"><span className="section-kicker">A LITTLE UPGRADE. A LOT MORE POSSIBLE.</span><h1>{step === 1 ? "给你的 AI，续上能量。" : "选择一种，更顺手的支付。"}</h1><p>{step === 1 ? "确认你的订阅套餐，剩下的交给我们。" : "订单金额公开透明，支付状态全程可查。"}</p></div><div className="checkout-grid"><form className="panel" onSubmit={submit}>{step === 1 ? <><h2 className="panel-heading"><Mail size={18}/>填写充值账号</h2><label className="field"><span className="field-label">账号邮箱<span className="required">*</span></span><div className="input-icon"><Mail size={15}/><input className="input" type="email" name="email" autoComplete="email" placeholder="输入需要升级的账号邮箱" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254}/></div><p className="field-hint">请使用你在 {plan.brand === "chatgpt" ? "ChatGPT" : plan.brand === "claude" ? "Claude" : plan.brand === "grok" ? "Grok" : "Google"} 注册的邮箱，该邮箱也用于查询订单。</p></label><label className="field"><span className="field-label">再次确认邮箱<span className="required">*</span></span><input className="input" type="email" name="confirmEmail" autoComplete="off" placeholder="再次填写，避免充错账号" value={confirmation} onChange={e => setConfirmation(e.target.value)} required maxLength={254}/></label><div className="form-row">
            <label className="field"><span className="field-label">取卡密码{signedIn ? "（选填）" : ""}<span className="required">{signedIn ? "" : "*"}</span></span><input className="input" type="password" value={cardPassword} onChange={e => setCardPassword(e.target.value)} placeholder={signedIn ? "已登录，可留空" : "至少 12 位，建议混合字母、数字与符号"} autoComplete="new-password" maxLength={128}/><p className="field-hint">{signedIn ? "已登录的订单用会话即可查询与领取，通常不必设置；设置后也可在未登录的设备上用「购买邮箱 + 密码」查。" : "这是你付款后查回订单、领取卡密的唯一凭据。请务必记住——它与一次性取卡码不同，取卡码只展示一次，密码可以随时用来查全部历史订单。"}</p></label>
          </div><div className="field"><span className="field-label">购买邮箱（选填）</span><input className="input" type="email" value={purchaseEmail} onChange={e => setPurchaseEmail(e.target.value)} placeholder={email || "默认与上方账号邮箱相同"} autoComplete="email" maxLength={254}/><p className="field-hint">用于在本站查询与管理这笔订单。若你注册本站用的邮箱与上方充值的账号邮箱不同，请在此填写注册邮箱。</p></div><div className="notice"><ShieldCheck size={16}/><div><strong>只需邮箱，不需要账号密码。</strong><br/>请确认账号地区符合所选订阅的官方要求。本站不会收集你的密码、验证码或会话令牌。</div></div><label className="checkbox-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} required/><span>我已确认账号与套餐信息，并阅读同意 <Link href="/legal" target="_blank">服务条款</Link> 和 <Link href="/legal#privacy" target="_blank">隐私政策</Link>。</span></label></> : <><h2 className="panel-heading"><Wallet size={18}/>选择支付方式</h2><div className="payment-options">{availableMethods.map(item => <button type="button" role="radio" aria-checked={method === item} className={`payment-option ${method === item ? "selected" : ""}`} key={item} onClick={() => setMethod(item)}><PaymentSymbol method={item}/><div><h3>{METHOD_LABEL[item]}</h3><p>{methodHint(item, exchangeRate)}</p></div><span className="radio-dot"/></button>)}</div>{noneReady ? <div className="notice warning"><Info size={16}/><div><strong>收款通道尚未配置完成，暂时无法下单付款。</strong><br/>你的订单信息不会丢失。请稍后再试，或联系站点客服了解开通进度。当前不会扣费。</div></div> : <div className="notice"><Info size={16}/><div>{payNotice(method, payable, exchangeRate)}</div></div>}<div className="summary-lines" style={{ marginBlock: 21 }}>
          <div className="summary-line"><span>商品价格</span><span>¥{money(bill.price)}</span></div>
          {/* 手续费必须显式列出。买家付的金额比商品价高，不说清楚就是"乱收费"，
              客服会收到投诉，平台也可能判违规。金额全部由服务端同一函数算出，
              这里的数字与下单锁定的一致。 */}
          {Number(bill.feeAmount) > 0 && <div className="summary-line"><span>手续费</span><span>¥{money(bill.feeAmount)}</span></div>}
          <div className="summary-line"><span>应付金额</span><span><strong>¥{money(bill.total)}</strong></span></div><div className="summary-line"><span>充值账号</span><span>{email}</span></div><div className="summary-line"><span>充值说明</span><span>{plan.delivery === "cdk" ? "付款确认后自动发放卡密" : "付款确认后安排人工处理"}</span></div>{method === "usdt" && <div className="summary-line"><span>预计支付</span><span>{toUsdt(payable, exchangeRate)} USDT</span></div>}</div></>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy || (step === 2 && noneReady)} type="submit">{busy ? <><Loader2 className="spinner" size={17}/>正在创建订单…</> : <>{step === 1 ? "继续，选择支付方式" : noneReady ? "收款通道配置中，暂不可下单" : "创建订单并前往支付"}{step === 1 && <ArrowRight size={17}/>}</>}</button>{step === 2 && <button className="button full" style={{ marginTop: 8, fontSize: 11, color: "#91a080" }} type="button" onClick={() => { setStep(1); setError(""); }} disabled={busy}><ArrowLeft size={13}/>返回修改账号信息</button>}</form><aside className="order-summary"><div className={`panel ${plan.brand}`}><h2 className="panel-heading">你的订阅计划</h2><div className="summary-plan"><span className="plan-logo"><BrandIcon brand={plan.brand}/></span><div><h3>{plan.name}</h3><p>{plan.period === "yearly" ? "全年订阅 · 12 个月" : "月度订阅 · 1 个月"} / 个人账号</p></div></div><ul className="plan-features" style={{ marginBottom: 23 }}>{plan.features.map(item => <li key={item}><Check size={14}/>{item}</li>)}</ul><div className="summary-lines"><div className="summary-line"><span>套餐价格</span><span>¥{money(bill.price)} / {periodLabel(plan.period)}</span></div><div className="summary-line"><span>手续费</span><span>{Number(bill.feeAmount) > 0 ? `¥${money(bill.feeAmount)}（费率 ${Number(bill.feeRate)}%）` : "¥0"}</span></div>{discount > 0 && <div className="summary-line discount"><span>优惠券抵扣</span><span>−¥{money(discount)}</span></div>}<div className="summary-line"><span>充值方式</span><span>{plan.delivery === "cdk" ? "付款后自动发卡密" : "个人账号直充"}</span></div></div><label className="coupon-field"><span className="field-label">优惠券（选填）</span><div className="coupon-input"><input className="input" value={couponCode} onChange={(e) => { setCouponCode(e.target.value.toUpperCase()); setCoupon(null); }} placeholder="输入券码" maxLength={32} autoComplete="off"/><button type="button" className="button outline small" onClick={applyCoupon} disabled={couponBusy || !couponCode.trim()}>{couponBusy ? <Loader2 size={13} className="spinner"/> : "验证"}</button></div>{coupon && <p className={coupon.valid ? "coupon-ok" : "coupon-bad"}>{coupon.valid ? `已抵扣 ¥${money(coupon.discountAmount || "0")}${coupon.note ? ` · ${coupon.note}` : ""}` : coupon.reason}</p>}</label><div className="summary-total"><span>实付金额</span><strong><small>¥</small>{money(payable)}</strong></div><p className="summary-note">{discount > 0 ? "优惠券与手续费在下单时锁定，之后调整规则不影响本订单。" : Number(bill.feeAmount) > 0 ? "手续费在下单时锁定，之后调整费率不影响本订单。" : "价格已包含代充服务费用，无隐藏收费。"}<br/>数字订阅权益以品牌官方实际提供为准。</p></div><p className="summary-trust"><LockKeyhole size={12}/>隐私保护 · 安全支付 · 订单可追踪</p></aside></div></main>;
}
