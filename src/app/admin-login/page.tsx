import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Info, ShieldCheck, Terminal } from "lucide-react";
import { db } from "@/db";
import { admins } from "@/db/schema";
import { currentAdmin } from "@/lib/auth";
import AdminLogin from "@/components/admin/login";
import { adminAccess } from "@/lib/admin/access";
import { AuraMark } from "@/components/brand-icon";

// 管理员注册不在页面上提供：页面只保留登录。尚未初始化时展示服务端引导，
// 由运维在服务器上用 scripts/reset-admin.mjs（无管理员时自动创建）或 setup 接口完成。
// 生产环境默认关闭：未显式开启时返回 404 而非 403。
// 404 而不是 403 是刻意的——403 等于确认「这里有个后台」，
// 那就把隐藏路径的存在性也泄露了。
export const metadata: Metadata = { title: "管理控制台", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!adminAccess().allowed) notFound();
  if (await currentAdmin()) redirect("/admin");
  const [admin] = await db.select({ id: admins.id }).from(admins).limit(1);
  if (admin) return <AdminLogin/>;
  return <main className="login-page"><section className="login-art"><Link href="/" className="wordmark"><AuraMark/><span>aura<span className="wordmark-dot">.</span></span></Link><span className="section-kicker">SERVER-SIDE SETUP ONLY</span><h1>管理员不在页面上注册。</h1><p>为防止公开站点被陌生人抢先初始化，<br/>唯一管理员只能在服务器上创建。</p><span className="login-copyright">aura WORKSPACE · 为好服务，留一份从容。</span></section><section className="login-form-side"><Link className="back-link login-back" href="/"><ArrowLeft size={14}/>返回前台</Link><div className="login-form"><span className="dialog-icon"><Terminal size={22}/></span><span className="section-kicker">BOOTSTRAP ON THE SERVER</span><h2>尚未初始化管理员</h2><p className="muted">本页仅提供登录。请以运维身份在服务器上执行以下任一方式。</p><div className="notice"><Info size={16}/><div><strong>方式一（推荐）：初始化脚本</strong><br/>在项目根目录执行：<code>ADMIN_USERNAME=账号 ADMIN_NEW_PASSWORD=强密码 node scripts/reset-admin.mjs</code>。脚本读取 .env 中的 DATABASE_URL；无管理员时自动创建，已有管理员时为重置凭据。</div></div><div className="notice"><Info size={16}/><div><strong>方式二：初始化接口</strong><br/>设置环境变量 ADMIN_SETUP_TOKEN 后，向 <code>POST /api/auth</code> 发送 <code>{`{ "action": "setup", username, password, setupToken }`}</code>。生产环境未配置令牌时接口直接拒绝。</div></div><p className="login-security"><ShieldCheck size={12}/>初始化完成后，本页只提供登录入口</p></div></section></main>;
}

