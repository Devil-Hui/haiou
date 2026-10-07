import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteHeader, SiteFooter, HelpWidget } from "@/components/site-shell";

export const metadata: Metadata = { title: "订单中心", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function OrdersLayout({ children }: { children: ReactNode }) { return <><SiteHeader/>{children}<SiteFooter/><HelpWidget/></>; }
