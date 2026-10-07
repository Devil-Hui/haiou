import { NextResponse } from "next/server";
import { listPublicVersions, getVersionSummary } from "@/lib/system-versions";

// 前台公开接口：只返回已发布版本。
//
// 无需鉴权、无需限流：内容是"站点改了什么"，公开是设计意图。
// 但仍设 5 秒 CDN 缓存 —— 版本变动极低频（一天可能一次），
// 而首页每次渲染都要读一次。
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const body =
    mode === "summary"
      ? await getVersionSummary()
      : { versions: await listPublicVersions(10) };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=30" },
  });
}
