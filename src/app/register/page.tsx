"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, CircleUserRound, Info, KeyRound, Loader2, LogOut, Mail, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "@/lib/client";

// 普通用户：注册 / 登录 / 修改密码。与管理员后台无关（管理员在服务端初始化）。
//
// 【四种模式，而不是两种】
// `claim`（绑定已有订单）是新增的第三种：访客下单时会设置一个「取卡密码」。
// 他后来想注册账号，但**不知道自己的订单挂在哪个邮箱下** —— 可能是激活邮箱，
// 也可能是他注册本站用的另一个邮箱。强迫他先登录去试邮箱是死路。
// `claim` 让他用「购买邮箱 + 取卡密码」直接证明 ownership，从而把已有订单绑到新账号上。
//
// `reset`（重置取卡密码）是第四种：忘记取卡密码时的自助恢复。
// 之所以不用「邮箱验证码」，是因为本站注册同样没有邮箱所有权验证 ——
// 攻击者能注册他人邮箱，验证码照样发得到那个邮箱，重置门槛并没有因此变高。
// 真正的凭据是旧取卡密码本身。这个取舍在 /api/orders/card-password 里有完整说明。
//
// 【两种邮箱，页面上必须说清】
//   · 购买邮箱 = 本站的账号邮箱，也是查订单的凭据
//   · 激活邮箱 = 买家在 ChatGPT / Claude 注册、要充值的那个账号邮箱
// 二者可以不同。个人中心按「任一邮箱命中」返回订单，因此无论买家记的是哪个都能找到。
export default function RegisterPage() {
  const [mode, setMode] = useState<"register" | "login" | "claim" | "reset">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orderPassword, setOrderPassword] = useState("");
  const [newCardPassword, setNewCardPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [checking, setChecking] = useState(true);
  // 登录后要能回到用户原本想去的地方：/me 未登录会带 ?next=/me 跳回来，
  // 少了这一段，登录成功后会被留在注册页，得再点一次"我的账户"。
  const [next] = useState(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") || "/me" : "/me"));

  useEffect(() => {
    api<{ user: { email: string } | null }>("/api/account").then(data => setUser(data.user)).catch(() => {}).finally(() => setChecking(false));
  }, []);

  function switchMode(next: "register" | "login" | "claim" | "reset") {
    setMode(next); setError(""); setNotice("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    // 绑定已有订单：先用「购买邮箱 + 取卡密码」验证 ownership，
    // 验证通过才进入设置密码这一步。顺序反了会让任何人都能尝试占用他人订单。
    if (mode === "claim") {
      if (!orderPassword) { setError("请填写下单时设置的取卡密码"); return; }
      setBusy(true);
      try {
        const found = await api<{ items: unknown[] }>("/api/orders/auth", { method: "POST", body: JSON.stringify({ email, password: orderPassword }) });
        if (!found.items?.length) { setError("未找到该邮箱下用此密码保护的订单"); return; }
        setNotice(`已验证，找到 ${found.items.length} 笔订单。现在为这个邮箱设置登录密码。`);
        setMode("register");
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      return;
    }
    // 忘记取卡密码：本人拿原密码来换一个新的。这里**不需要邮箱验证码**——
    // 本站注册同样没有邮箱所有权验证，「发验证码到购买邮箱」并不构成额外的
    // 身份证明（旧密码才是这个邮箱的账号级凭据）。详见接口内的说明。
    if (mode === "reset") {
      if (!orderPassword) { setError("请填写下单时设置的取卡密码"); return; }
      if (!newCardPassword) { setError("请填写新的取卡密码"); return; }
      if (newCardPassword === orderPassword) { setError("新密码不能与原密码相同"); return; }
      setBusy(true);
      try {
        const done = await api<{ ok: boolean; changed: number }>("/api/orders/card-password", { method: "POST", body: JSON.stringify({ email, currentPassword: orderPassword, newPassword: newCardPassword }) });
        setNotice(`重置成功，该邮箱下${done.changed} 笔订单的取卡密码已一并更新。现在可以用新密码查全部历史订单、领取卡密。`);
        setOrderPassword(""); setNewCardPassword("");
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      return;
    }
    setBusy(true);
    try {
      const data = await api<{ user: { email: string } }>("/api/account", { method: "POST", body: JSON.stringify({ action: mode, email, password }) });
      setUser(data.user); setPassword("");
      if (data.user) { window.location.href = next; return; }
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  async function logout() {
    try { await api("/api/account", { method: "DELETE" }); } finally { setUser(null); }
  }

  return <main className="page-main container">
    <div className="page-topline"><Link href="/" className="back-link"><ArrowLeft size={14}/>返回首页</Link><span><ShieldCheck size={12}/>密码加盐存储 · 仅用于订单便捷查询</span></div>
    <div className="page-title">
      <span className="section-kicker">ONE ACCOUNT, EVERYTHING TRACKED.</span>
      <h1>{mode === "register" ? "创建你的账户。" : mode === "claim" ? "已有订单，绑定账户。" : mode === "reset" ? "重置取卡密码。" : "欢迎回来。"}</h1>
      <p>{mode === "claim" ? "用下单时的取卡密码验证，把已有订单归到这个邮箱名下。" : mode === "reset" ? "拿下单时的取卡密码换一个新的。校验通过后，该邮箱下所有订单会一起更新为新密码。" : "注册后可凭邮箱快速管理全部订单。不注册也完全可以下单——访客凭取卡密码同样能查。"}</p>
    </div>

    <section className="panel" style={{ maxWidth: 470, margin: "auto" }}>
      {checking ? <p className="muted" style={{ textAlign: "center" }}>加载中…</p>
      : user ? <>
        <h2 className="panel-heading"><CircleUserRound size={18}/>已登录</h2>
        <div className="summary-lines"><div className="summary-line"><span>当前账户</span><span>{user.email}</span></div></div>
        <div className="payment-actions"><Link className="button primary full" href="/me">前往我的订单</Link><Link className="button outline full" href="/orders">按订单号查单</Link><button className="button outline full" onClick={logout}><LogOut size={15}/>退出登录</button></div>
      </> : <>
        <form onSubmit={submit}>
          <h2 className="panel-heading">{mode === "login" ? <Mail size={18}/> : <KeyRound size={18}/>}{mode === "register" ? "设置登录密码" : mode === "claim" ? "验证已有订单" : mode === "reset" ? "验证身份" : "账户登录"}</h2>

          <label className="field">
            <span className="field-label">{mode === "claim" || mode === "reset" ? "下单时的购买邮箱" : "邮箱"}<span className="required">*</span></span>
            <div className="input-icon"><Mail size={15}/><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="你下单或注册时使用的邮箱" autoComplete="email" required maxLength={254}/></div>
          </label>

          {mode === "claim" || mode === "reset" ? <>
            <label className="field">
              <span className="field-label">取卡密码<span className="required">*</span></span>
              <input className="input" type="password" value={orderPassword} onChange={e => setOrderPassword(e.target.value)} placeholder="下单时设置的取卡密码" autoComplete="current-password" required maxLength={128}/>
              <p className="field-hint">{mode === "claim" ? "这就是你当时用来查订单、发卡的密码。验证通过后即可为这个邮箱设置登录密码。" : "用于确认你是这个邮箱的主人。完全想不起来的话，请联系页面右下角客服协助核实。"}</p>
            </label>
            {mode === "reset" && <label className="field">
              <span className="field-label">新的取卡密码<span className="required">*</span></span>
              <input className="input" type="password" value={newCardPassword} onChange={e => setNewCardPassword(e.target.value)} placeholder="至少 12 位，建议混合字母、数字与符号" autoComplete="new-password" required minLength={12} maxLength={128}/>
              <p className="field-hint">重置后，该邮箱下所有订单统一改用这个新密码——不会出现「有的单要新密码、有的单还要旧密码」。</p>
            </label>}
            {notice && <p className="coupon-ok" role="status">{notice}</p>}
          </> : <>
            <label className="field">
              <span className="field-label">{mode === "register" ? "设置密码" : "密码"}<span className="required">*</span></span>
              <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="至少 12 位，建议混合字母、数字与符号"
                autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={12} maxLength={128}/>
              {mode === "register" && <p className="field-hint">这是你以后登录本站用的密码，与下单时的「取卡密码」是两回事，可以不同。</p>}
            </label>
            {mode === "register" && <div className="notice"><Info size={16}/><div><strong>两种邮箱，别混淆：</strong><br/>· <strong>购买邮箱</strong>：就是当前这个，用于登录与查询订单。<br/>· <strong>激活邮箱</strong>：你在 ChatGPT / Claude 等平台注册的、要充值的那个账号邮箱，下单时单独填写。<br/>两者可以不同，个人中心两种都能查到。</div></div>}
          </>}

          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button primary full" disabled={busy}>{busy && <Loader2 className="spinner" size={15}/>}{mode === "register" ? "创建账户" : mode === "claim" ? "验证并继续" : mode === "reset" ? "重置取卡密码" : "登录"}</button>
        </form>

        <div className="dialog-actions" style={{ marginTop: 10, flexWrap: "wrap" }}>
          {mode !== "register" && <button type="button" className="button full" style={{ fontSize: 11, color: "#91a080" }} onClick={() => switchMode("register")}>没有账号？新注册</button>}
          {mode !== "login" && <button type="button" className="button full" style={{ fontSize: 11, color: "#91a080" }} onClick={() => switchMode("login")}>已有账号？去登录</button>}
          {mode !== "claim" && <button type="button" className="button full" style={{ fontSize: 11, color: "#91a080" }} onClick={() => switchMode("claim")}>买过但没账号？绑定已有订单</button>}
          {mode !== "reset" && <button type="button" className="button full" style={{ fontSize: 11, color: "#91a080" }} onClick={() => switchMode("reset")}>忘记取卡密码？重置</button>}
        </div>

        {/* 忘记密码的分流。站点未接入邮件发送，无法自助重置账号密码；
            与其留一个点了没反应的按钮，不如把两条真实可行的路都指出来 ——
            这是"网页友好"里最要紧的一环。 */}
        <p className="summary-note" style={{ marginTop: 16, textAlign: "center" }}>
          登录密码忘了且记不清取卡密码？请联系页面右下角客服协助核实身份后重置。
        </p>
      </>}
    </section>
  </main>;
}
