import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./cdk-shop.css";
import { NoticeBar } from "@/components/notice-bar";

export const metadata: Metadata = {
  title: { default: "aura · AI 能量补给站", template: "%s · aura" },
  description: "ChatGPT、Claude、Grok、Gemini 一站式 AI 订阅代充。简洁透明的套餐、灵活支付与全程可查询的订单，为每一份灵感持续补给能量。",
  robots: { index: true, follow: true },
};
export default function RootLayout({ children }: { children: ReactNode }) {
  // 公告条渲染在 header 之前：停售与公告属于"站点级状态"，应该在页面主内容之上。
  return <html lang="zh-CN"><body><NoticeBar/>{children}</body></html>;
}
