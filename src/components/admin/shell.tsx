"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {LayoutDashboard, ReceiptText, Layers3, SlidersHorizontal, ArrowUpRight, LogOut, ShieldCheck, ChevronRight, Menu, X, Loader2, KeyRound, Megaphone, TicketPercent, Link2, Sparkles } from "lucide-react";
import { HaiouMark } from "@/components/brand-icon";
import { api, errorMessage } from "@/lib/client";

const navigation = [{ href: "/admin", name: "数据概览", icon: LayoutDashboard }, { href: "/admin/orders", name: "订单管理", icon: ReceiptText }, { href: "/admin/plans", name: "套餐管理", icon: Layers3 }, { href: "/admin/cdk", name: "卡密管理", icon: KeyRound }, { href: "/admin/coupons", name: "优惠券", icon: TicketPercent }, { href: "/admin/announcements", name: "公告设置", icon: Megaphone }, { href: "/admin/versions", name: "系统更新", icon: Sparkles }, { href: "/admin/payments", name: "支付配置", icon: SlidersHorizontal }, { href: "/admin/upstream", name: "上游对接", icon: Link2 }];

export default function AdminShell({ children, username, initialStoreOpen = true }: { children: ReactNode; username: string; initialStoreOpen?: boolean }) {
  const pathname = usePathname(); const router = useRouter();
  const [mobile, setMobile] = useState(false); const [loggingOut, setLoggingOut] = useState(false); const [error, setError] = useState(""); const [passwordOpen, setPasswordOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(initialStoreOpen); const [toggling, setToggling] = useState(false);
  // 暂停接单是最高频的运维动作（通道故障、收到滥用举报、库出问题），
  // 所以放在侧边栏随手可点，而不是藏进支付配置表单里。
  async function toggleStore() {
    const next = !storeOpen;
    setToggling(true); setError("");
    try {
      await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ action: "store", open: next }) });
      setStoreOpen(next);
    } catch (err) { setError(errorMessage(err)); }
    finally { setToggling(false); }
  }
  async function logout() { setLoggingOut(true); try { await api("/api/auth", { method: "DELETE" }); router.push("/admin-login"); router.refresh(); } catch (err) { setError(errorMessage(err)); setLoggingOut(false); } }
  return <div className="admin-layout"><aside className={`admin-sidebar ${mobile ? "mobile-open" : ""}`}><Link href="/admin" className="wordmark"><HaiouMark/><span>haiou<span className="wordmark-dot">.</span></span></Link><button className="mobile-sidebar-close icon-button" onClick={() => setMobile(false)} aria-label="关闭管理菜单"><X size={19}/></button><p className="admin-label">WORKSPACE / 管理控制台</p><nav className="admin-nav" aria-label="后台导航">{navigation.map(({ href, name, icon: Icon }) => <Link key={href} href={href} className={pathname === href ? "active" : ""} onClick={() => setMobile(false)}><Icon size={17} strokeWidth={1.6}/>{name}</Link>)}</nav><div className="sidebar-bottom"><div className={`store-switch ${storeOpen ? "open" : "paused"}`}><div className="store-switch-text"><span>{storeOpen ? "正在接单" : "已暂停接单"}</span><small>{storeOpen ? "买家可正常下单" : "前台仅可查单"}</small></div><button className={`switch ${storeOpen ? "on" : ""}`} role="switch" aria-checked={storeOpen} aria-label={storeOpen ? "暂停接单" : "恢复接单"} onClick={toggleStore} disabled={toggling}><span/></button></div><Link href="/" target="_blank"><ArrowUpRight size={15}/>查看前台网站</Link><button onClick={() => setPasswordOpen(true)}><KeyRound size={15}/>修改密码</button><button onClick={logout} disabled={loggingOut}>{loggingOut ? <Loader2 size={15} className="spinner"/> : <LogOut size={15}/>}退出登录</button><p className="sidebar-status"><ShieldCheck size={12}/>安全管理会话</p></div></aside><div className="admin-main"><header className="admin-topbar"><div style={{ display: "flex", alignItems: "center", gap: 10 }}><button className="admin-mobile-toggle icon-button" aria-label="打开管理菜单" onClick={() => setMobile(!mobile)}><Menu size={20}/></button><div className="admin-breadcrumb"><span>管理控制台</span><ChevronRight size={11}/><strong>{navigation.find(item => item.href === pathname)?.name || "数据概览"}</strong></div></div><div className="admin-account"><ShieldCheck size={13}/><span>管理员</span><span className="admin-avatar">{username.slice(0, 1)}</span><span>{username}</span></div></header><main className="admin-content">{error && <p className="inline-error" role="alert">{error}</p>}{children}</main>{passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)}/>}</div></div>;
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (next !== confirm) { setError("两次输入的新密码不一致"); return; }
    setBusy(true);
    try { await api("/api/auth", { method: "PATCH", body: JSON.stringify({ currentPassword: current, newPassword: next }) }); setDone(true); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}><form className="dialog" role="dialog" aria-modal="true" aria-labelledby="admin-password-title" onClick={e => e.stopPropagation()} onSubmit={submit}>
    <button type="button" className="modal-close icon-button" aria-label="关闭修改密码" onClick={onClose} disabled={busy}><X size={18}/></button>
    <span className="section-kicker">CREDENTIAL ROTATION</span>
    <h2 id="admin-password-title">{done ? "密码已更新" : "修改管理员密码"}</h2>
    <p className="dialog-subtitle">{done ? "其他设备与旧标签页的登录状态已全部失效，请使用新密码重新登录。" : "需要验证当前密码。新密码至少 12 位，不能是常见弱口令，也不能包含用户名。"}</p>
    {!done ? <>
      <label className="field"><span className="field-label">当前密码</span><input className="input" type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required maxLength={128}/></label>
      <label className="field"><span className="field-label">新密码</span><input className="input" type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" required minLength={10} maxLength={128}/></label>
      <label className="field"><span className="field-label">确认新密码</span><input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required minLength={10} maxLength={128}/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button outline" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy && <Loader2 size={14} className="spinner"/>}更新密码</button></div>
    </> : <div className="dialog-actions"><button type="button" className="button primary" onClick={onClose}>知道了</button></div>}
  </form></div>;
}
