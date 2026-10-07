import type { Metadata } from "next";
import Redeem from "@/components/redeem";
import { SiteHeader, SiteFooter, HelpWidget } from "@/components/site-shell";

// 核销页带私密凭证，不进索引、不带 referrer，与订单页口径一致
export const metadata: Metadata = { title: "卡密兑换", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function RedeemPage() {
  return <><SiteHeader/><Redeem/><SiteFooter/><HelpWidget/></>;
}
