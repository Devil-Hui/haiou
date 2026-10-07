import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listUserOrders } from "@/lib/catalog";
import AccountCenter from "@/components/account-center";
import { SiteHeader, SiteFooter, HelpWidget } from "@/components/site-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "个人中心", robots: { index: false, follow: false } };

// 服务端先判定登录态：未登录直接送去登录页，而不是渲染一个空壳再让客户端跳。
// 这样刷新、深链、分享链接三种情况行为一致。
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/register?next=/me");
  const query = await searchParams;
  const status = (query.status || "").trim();
  const page = Math.max(1, Math.min(10000, Math.floor(Number(query.page) || 1)));
  // 刻意不查询也不返回任何卡密数据：个人中心不展示卡密信息或其入口。
  const orders = await listUserOrders(user.email, status, page);
  return <><SiteHeader/><AccountCenter email={user.email} status={status} orders={orders}/><SiteFooter/><HelpWidget/></>;
}
