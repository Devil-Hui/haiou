"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, Loader2, Eye, EyeOff } from "lucide-react";
import { HaiouMark, BrandIcon } from "@/components/brand-icon";
import { api, errorMessage } from "@/lib/client";

// 登录组件只保留登录。管理员初始化不在页面上提供表单：由服务器上的
// scripts/reset-admin.mjs 或 setup 接口完成（见 /admin-login 未初始化时的指引页）。
export default function AdminLogin() {
  const router = useRouter();
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    setBusy(true);
    try { await api("/api/auth", { method: "POST", body: JSON.stringify({ action: "login", username, password }) }); router.push("/admin"); router.refresh(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  }
  return <main className="login-page"><section className="login-art"><Link href="/" className="wordmark"><HaiouMark/><span>haiou<span className="wordmark-dot">.</span></span></Link><span className="section-kicker">A CALMER WAY TO MANAGE.</span><h1>把繁琐留在身后，<br/>让每份灵感续航。</h1><p>简洁的工作台，清晰的每一笔订单。<br/>从这里开始，让好的服务成为日常。</p><div className="login-brands">{["chatgpt", "claude", "grok", "gemini"].map(brand => <span key={brand}><BrandIcon brand={brand}/></span>)}</div><span className="login-copyright">haiou WORKSPACE · 为好服务，留一份从容。</span></section><section className="login-form-side"><Link className="back-link login-back" href="/"><ArrowLeft size={14}/>返回前台</Link><form className="login-form" onSubmit={submit}><span className="dialog-icon"><LockKeyhole size={22}/></span><span className="section-kicker">WELCOME BACK</span><h2>欢迎回来。</h2><p className="muted">登录 haiou 管理控制台，今天也让服务更简单。</p><label className="field"><span className="field-label">管理员账号</span><input className="input" name="username" autoComplete="username" placeholder="3–30 位字母、数字或下划线" value={username} onChange={e => setUsername(e.target.value)} required pattern="[a-zA-Z0-9_-]{3,30}" minLength={3} maxLength={30}/></label><label className="field"><span className="field-label">登录密码</span><div style={{ position: "relative" }}><input className="input" style={{ paddingRight: 40 }} type={visible ? "text" : "password"} name="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 12 位，建议混合字母、数字与符号" required minLength={12} maxLength={128}/><button type="button" className="icon-button" aria-label={visible ? "隐藏密码" : "显示密码"} style={{ position: "absolute", right: 7, top: 8, color: "#a5b098" }} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={15}/> : <Eye size={15}/>}</button></div></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy} type="submit">{busy ? <Loader2 size={16} className="spinner"/> : null}{busy ? "正在安全验证…" : "登录管理控制台"}{!busy && <ArrowRight size={16}/>}</button><p className="login-security"><ShieldCheck size={12}/>加盐密码保护 · 24 小时安全会话</p></form></section></main>;
}
