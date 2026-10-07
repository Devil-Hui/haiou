import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "管理控制台", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default function AdminLayout({ children }: { children: ReactNode }) { return children; }
