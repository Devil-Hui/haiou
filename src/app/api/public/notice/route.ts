import { NextResponse } from "next/server";
import { listActiveAnnouncements } from "@/lib/promo";
import { getPaymentSettings } from "@/lib/catalog";

// 前台公告 + 接单状态。单独开一个轻量接口而不是塞进页面 props，
// 目的是让「暂停接单」这条信息有一条独立、可被前端随时拉取的通道：
// 运营在后台一点，前台下一帧就变，不需要重新发版。
export const dynamic = "force-dynamic";

export async function GET() {
  const [items, settings] = await Promise.all([listActiveAnnouncements(), getPaymentSettings()]);
  return NextResponse.json(
    { announcements: items, storeOpen: settings.storeOpen, pausedReason: settings.pausedReason },
    // 公告与接单状态是运营可改的公共信息，交给 CDN 短缓存；5 秒足够，
    // 既让高并发下的压力落到 CDN，又不会把运营的紧急停售拖住。
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=5, stale-while-revalidate=30" } },
  );
}
