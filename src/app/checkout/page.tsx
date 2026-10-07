import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, PackageX, TriangleAlert } from "lucide-react";
import { getPlans, getPaymentSettings } from "@/lib/catalog";
import { paymentAvailability } from "@/lib/payments";
import { isPurchasable } from "@/lib/catalog";
import { currentUser } from "@/lib/auth";
import Checkout from "@/components/checkout";
import { SiteHeader, SiteFooter, HelpWidget } from "@/components/site-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "确认订单", robots: { index: false, follow: false } };

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const query = await searchParams;
  const plans = await getPlans();
  const plan = query.plan ? plans.find((p) => p.id === query.plan) : plans[0];
  if (!plan) notFound();
  const settings = await getPaymentSettings();

  // 售罄与暂停接单都要在页面级挡住，而不是只在下单接口报错。
  // 独角数卡踩过"下架商品仍能进结算页"的坑：买家填完一单才被告知卖完了，
  // 体验和数据都很差。这里提前给出可理解的说明，并把人送回商品列表。
  const soldOut = !isPurchasable(plan);
  const paused = !settings.storeOpen;
  if (soldOut || paused) {
    return (
      <>
        <SiteHeader />
        <main className="page-main container">
          <div className="empty-state">
            {paused ? <TriangleAlert size={34} /> : <PackageX size={34} />}
            <h3>{paused ? "站点暂时停止接单" : "该套餐已售罄"}</h3>
            <p>
              {paused
                ? settings.pausedReason || "站点正在维护，请稍后再来。已创建的订单不受影响，可继续查询与支付。"
                : "这套套餐的可售份数已发完。可以选择其他套餐，或稍后再来看看。"}
            </p>
            <div className="result-actions">
              <Link className="button primary" href="/#plans">返回套餐列表</Link>
              <Link className="button outline" href="/orders">查询已有订单</Link>
            </div>
          </div>
          <div className="page-topline" style={{ marginTop: 18 }}>
            <Link className="back-link" href="/#plans"><ArrowLeft size={14} />返回充值套餐</Link>
          </div>
        </main>
        <SiteFooter />
        <HelpWidget />
      </>
    );
  }

  return (
    <>
      <SiteHeader />
      <Checkout
        plan={plan}
        signedIn={!!(await currentUser())}
        availability={paymentAvailability(settings)}
        exchangeRate={settings.exchangeRate}
        channelRates={{
          alipay: settings.alipayFeeRate,
          epay: settings.epayFeeRate,
          usdt: settings.usdtFeeRate,
          epusdt: settings.epusdtFeeRate,
          binance: settings.binanceFeeRate,
        }}
      />
      <SiteFooter />
      <HelpWidget />
    </>
  );
}
