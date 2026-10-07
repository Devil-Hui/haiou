"use client";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <main className="container loading-view"><RefreshCw size={31}/><h1 style={{ fontSize: 23, color: "#576e48" }}>稍作休息，马上回来。</h1><p>服务暂时遇到问题，请稍后重试。你的已保存订单不会丢失。</p><div className="result-actions"><button className="button primary" onClick={reset}>重新加载</button><Link className="button outline" href="/">返回首页</Link></div></main>; }
