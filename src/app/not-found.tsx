import Link from "next/link";
import { ArrowLeft, Sparkles } from "lucide-react";
import { SiteHeader, SiteFooter } from "@/components/site-shell";
export default function NotFound() { return <><SiteHeader/><main className="page-main container"><div className="empty-state" style={{ margin: "55px auto", maxWidth: 630 }}><Sparkles size={35}/><span className="section-kicker">404 · A LITTLE DETOUR</span><h3>这份灵感，暂时不在这里。</h3><p>页面可能已移动，或你选择的套餐已经下架。<br/>回到首页，发现其他好用的 AI 订阅。</p><Link href="/" className="button primary"><ArrowLeft size={15}/>返回首页</Link></div></main><SiteFooter/></>; }
