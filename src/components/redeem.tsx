"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Loader2, Mail, KeyRound, ShieldCheck } from "lucide-react";
import { api, saveRecent, saveDeliveryToken, errorMessage, type RecentOrder } from "@/lib/client";

export default function Redeem() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const order = await api<RecentOrder>("/api/cdk/redeem", { method: "POST", body: JSON.stringify({ code, email }) });
      saveRecent(order);
      // ⚠️ 必须存取卡码：核销生成的订单同样要走「提交充值 / 查进度」，
      // 而那三个接口一律以取卡码做归属校验（服务端只留 sha256，之后取不回明文）。
      // saveRecent() 会刻意剔除 deliveryToken（不让它进"最近订单"列表长期留存），
      // 所以这里要单独存一次——漏掉这段，卡密核销的用户会被 403 挡在充值门外，
      // 而核销正是本站的主营流程之一。
      if (order.deliveryToken) saveDeliveryToken(order.code, order.deliveryToken);
      router.push(`/orders/${order.id}/result`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return <main className="page-main container"><div className="page-topline"><Link className="back-link" href="/"><ArrowLeft size={14}/>返回首页</Link><span><ShieldCheck size={12}/>卡密即凭证 · 请勿泄露给他人</span></div><div className="page-title"><span className="section-kicker">REDEEM YOUR CARD.</span><h1>用卡密，兑换你的订阅。</h1><p>输入卡密与需要充值的账号邮箱，提交后即刻生成订单，随时查看充值进度。</p></div><form className="panel lookup-panel" onSubmit={submit}><div className="lookup-icon"><KeyRound size={25} strokeWidth={1.5}/></div><label className="field"><span className="field-label">兑换卡密</span><div className="input-icon"><KeyRound size={15}/><input className="input" name="cdk" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="例如 A1B2-C3D4-E5F6-G7H8" required maxLength={40} autoComplete="off"/></div><p className="field-hint">不区分大小写，中间的连字符可写可不写。</p></label><label className="field"><span className="field-label">充值账号邮箱</span><div className="input-icon"><Mail size={15}/><input className="input" name="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="填写需要升级的账号邮箱" required maxLength={254} autoComplete="email"/></div><p className="field-hint">请确认这是你要充值的账号，充值将作用于该账号。</p></label>{error && <p className="form-error" role="alert">{error}</p>}<button type="submit" className="button primary full" disabled={busy}>{busy ? <><Loader2 size={16} className="spinner"/>正在核销…</> : <>兑换并生成订单<ArrowRight size={16}/></>}</button><p className="summary-trust"><ShieldCheck size={11}/>核销后订单即刻生效，进度全程可查</p></form></main>;
}
