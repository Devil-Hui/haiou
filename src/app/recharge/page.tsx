import type { Metadata } from "next";
import { getPlans } from "@/lib/catalog";
import { getUpstream } from "@/lib/recharge";
import RechargeFlow from "@/components/recharge-flow";
import { SiteHeader, SiteFooter, HelpWidget } from "@/components/site-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "自动充值", robots: { index: true, follow: true } };

export default async function RechargePage() {
  const [plans, upstream] = await Promise.all([getPlans(), getUpstream()]);
  // 只传"能不能用"这个布尔值给前端，具体地址、密钥、上游状态一律不下发。
  return <><SiteHeader/><RechargeFlow plans={plans} enabled={upstream.enabled}/><SiteFooter/><HelpWidget/></>;
}
