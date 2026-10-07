import Home from "@/components/home";
import { SiteHeader, SiteFooter, HelpWidget } from "@/components/site-shell";
import { getPlans } from "@/lib/catalog";

export const dynamic = "force-dynamic";
export default async function HomePage() {
  const plans = await getPlans();
  return <><SiteHeader/><main><Home plans={plans}/></main><SiteFooter/><HelpWidget/></>;
}
