"use client";

import { useEffect, useState } from "react";
import { Megaphone, TriangleAlert, CircleAlert, X } from "lucide-react";

type Notice = { id: string; title: string; body: string; level: string };
type Payload = { announcements: Notice[]; storeOpen: boolean; pausedReason: string };

/**
 * 全站公告条 + 暂停接单提示。
 *
 * 刻意做成"拉接口"而不是"服务端塞 props"：暂停接单是运营在后台点的，
 * 必须做到点了就生效，不依赖重新构建页面。5 秒短缓存由接口侧控制。
 */
export function NoticeBar() {
  const [data, setData] = useState<Payload | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/public/notice", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((value: Payload | null) => {
          if (active && value) setData(value);
        })
        .catch(() => {
          /* 公告拉取失败不该影响下单，静默忽略即可 */
        });
    load();
    // 60 秒兜底轮询：即使运营改了配置，访客停留期间也能看到停售/恢复。
    const timer = window.setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (!data) return null;
  const paused = !data.storeOpen;
  // 停售提示优先级最高：公告在下面，两条同时出现时都展示，但停售用强样式。
  const top = data.announcements.filter((item) => !dismissed.includes(item.id)).slice(0, paused ? 1 : 2);
  if (!paused && top.length === 0) return null;

  return (
    <div className="notice-stack">
      {paused && (
        <div className="site-notice danger" role="status">
          <TriangleAlert size={16} />
          <div>
            <strong>暂时停止接单</strong>
            <span>{data.pausedReason || "站点正在维护，请稍后再来。已创建的订单不受影响，可继续查询与支付。"}</span>
          </div>
        </div>
      )}
      {top.map((item) => {
        const Icon = item.level === "danger" ? CircleAlert : item.level === "warning" ? TriangleAlert : Megaphone;
        return (
          <div className={`site-notice ${item.level}`} key={item.id}>
            <Icon size={16} />
            <div>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </div>
            <button className="notice-close" aria-label={`关闭公告：${item.title}`} onClick={() => setDismissed((prev) => [...prev, item.id])}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
