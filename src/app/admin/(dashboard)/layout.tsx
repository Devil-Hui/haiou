import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentAdmin } from "@/lib/auth";
import { getPaymentSettings } from "@/lib/catalog";
import { adminAccess } from "@/lib/admin/access";
import AdminShell from "@/components/admin/shell";

// 服务端读一次接单状态传给侧边栏开关，避免客户端再发一轮请求才能渲染出正确状态。
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // 闸门在鉴权之前：未开启时连登录页都不该存在。
  if (!adminAccess().allowed) notFound();
  const admin = await currentAdmin();
  if (!admin) redirect("/admin-login");
  const settings = await getPaymentSettings();
  return <AdminShell username={admin.username} initialStoreOpen={settings.storeOpen}>{children}</AdminShell>;
}
