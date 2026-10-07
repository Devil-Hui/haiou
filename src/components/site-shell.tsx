"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ArrowUpRight, Search, Menu, X, MessageCircle, ArrowRight, ShieldCheck, Mail, Clock3 } from "lucide-react";
import { AuraMark } from "./brand-icon";

export function SiteHeader() {
  const pathname = usePathname();
  const [menu, setMenu] = useState(false);
  return <header className="site-header"><div className="header-inner"><Link href="/" className="wordmark" aria-label="aura 首页"><Image src="/images/logo.png" alt="aura" width={30} height={30} className="wordmark-logo" priority/><span>aura<span className="wordmark-dot">.</span></span><span className="logo-caption">AI 能量补给站</span></Link><nav className={`main-nav ${menu ? "is-open" : ""}`} aria-label="主导航"><Link className={pathname === "/" ? "nav-active" : ""} href="/" onClick={() => setMenu(false)}>首页</Link><Link href="/#plans" onClick={() => setMenu(false)}>充值套餐</Link><Link href="/#how-it-works" onClick={() => setMenu(false)}>充值流程</Link><Link href="/#faq" onClick={() => setMenu(false)}>常见问题</Link><Link className={pathname === "/recharge" ? "nav-active" : ""} href="/recharge" onClick={() => setMenu(false)}>自动充值</Link><Link className={pathname === "/redeem" ? "nav-active" : ""} href="/redeem" onClick={() => setMenu(false)}>卡密兑换</Link><span className="drawer-only"><Link href="/orders" onClick={() => setMenu(false)}>订单查询</Link><Link href="/me" onClick={() => setMenu(false)}>我的账户</Link></span></nav><div className="header-actions"><Link href="/orders" className="lookup-link"><Search size={15}/>订单查询</Link><Link href="/me" className="account-link">我的账户</Link><button className="mobile-menu icon-button" aria-label={menu ? "关闭菜单" : "打开菜单"} onClick={() => setMenu(!menu)}>{menu ? <X size={21}/> : <Menu size={21}/>}</button></div></div></header>;
  // 说明：管理后台不在前台暴露任何入口（与 Django admin 同思路——可访问但不外链）。
  // 运营通过 /admin 直接访问；该路径已由 robots.ts 与 noindex 响应头排除在搜索引擎之外。
}

export function SiteFooter() {
  return <footer className="site-footer"><div className="footer-inner"><div><Link href="/" className="wordmark footer-logo"><Image src="/images/logo.png" alt="aura" width={26} height={26} className="wordmark-logo"/><span>aura<span className="wordmark-dot">.</span></span></Link><p>为每一份灵感，持续补给能量。</p></div><div className="footer-links"><Link href="/#plans">充值套餐</Link><Link href="/orders">查询订单</Link><Link href="/legal">服务条款</Link><Link href="/legal#privacy">隐私政策</Link></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} aura. All rights reserved.</span><span>独立订阅代充服务 · 非品牌官方站点</span><span className="footer-online"><i/>让 AI 成为日常</span></div></footer>;
}

export function HelpWidget() {
  const [open, setOpen] = useState(false);
  return <><button className="help-fab" onClick={() => setOpen(true)} aria-label="打开订单帮助"><MessageCircle size={22}/><span>需要帮助</span></button>{open && <div className="modal-backdrop" onClick={() => setOpen(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭帮助" onClick={() => setOpen(false)}><X size={20}/></button><span className="dialog-icon"><MessageCircle size={26}/></span><p className="eyebrow">A LITTLE HELP</p><h2 id="help-title">让充值更简单一点。</h2><p className="muted">常见的订单问题，你可以在这里找到答案。</p><div className="help-topic"><Clock3 size={19}/><div><strong>已支付，但订单还没更新？</strong><p>支付确认可能需要一些时间。请勿重复付款，在订单详情页刷新支付状态。</p></div></div><div className="help-topic"><Mail size={19}/><div><strong>找不到我的订单？</strong><p>使用下单时的账号邮箱和订单号查询，也可查看当前浏览器保存的最近订单。</p></div></div><div className="help-topic"><ShieldCheck size={19}/><div><strong>账号安全提醒</strong><p>我们不会通过此网站索取你的账号密码、验证码或会话令牌。</p></div></div><Link className="button primary full" href="/orders" onClick={() => setOpen(false)}>查询我的订单<ArrowRight size={17}/></Link><Link className="text-link help-faq" href="/#faq" onClick={() => setOpen(false)}>查看所有常见问题 <ArrowUpRight size={15}/></Link></section></div>}</>;
}

export function Steps({ current = 1 }: { current?: number }) {
  return <div className="checkout-steps">{["确认订单", "选择支付", "充值结果"].map((name, i) => <div className={`checkout-step ${current >= i + 1 ? "active" : ""}`} key={name}><span>{current > i + 1 ? "✓" : `0${i + 1}`}</span><p>{name}</p>{i < 2 && <i/>}</div>)}</div>;
}
