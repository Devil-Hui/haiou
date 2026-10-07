"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { api } from "@/lib/client";
import type { PublicVersion } from "@/lib/system-versions";

/**
 * 前台系统更新提示。
 *
 * 放在公告条下方而不是独立页面：版本更新是"顺便告诉买家一句"，
 * 不该占首页篇幅。展开才看完整变更列表。
 *
 * 数据来自 /api/public/versions（5 秒 CDN 缓存 + 服务端 5 分钟 TTL），
 * 所以对首页渲染几乎无开销。
 */
export function UpdateNotice() {
  const [list, setList] = useState<PublicVersion[] | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string>("");

  useEffect(() => {
    let alive = true;
    api<{ versions: PublicVersion[] }>("/api/public/versions")
      .then(r => { if (alive) setList(r.versions ?? []); })
      .catch(() => { /* 更新提示不是核心功能，取不到就静默隐藏 */ });
    return () => { alive = false; };
  }, []);

  // dismissed 存已关闭的版本号，这样发布新版本后提示会重新出现，
  // 而不是被一次关闭永久隐藏。
  const latest = list?.[0];
  if (!latest || dismissed === latest.version) return null;

  return <div className="update-notice">
    <div className="update-notice-bar">
      <Sparkles size={15}/>
      <span>
        <strong>v{latest.version}</strong> {latest.title}
      </span>
      {list && list.length > 1 && <span className="muted">共 {list.length} 条更新</span>}
      <button className="table-action" onClick={() => setOpen(v => !v)}>{open ? "收起" : "查看变更"}</button>
      <button className="icon-button" aria-label="关闭更新提示" onClick={() => setDismissed(latest.version)}><X size={15}/></button>
    </div>
    {open && <ul className="update-notice-list">
      {(list ?? []).map(v => <li key={v.version}>
        <span className={"update-level " + v.level}>{v.level === "critical" ? "重要" : v.level === "major" ? "新增" : "更新"}</span>
        <div>
          <strong>v{v.version} {v.title}</strong>
          {v.changes.length > 0 && <ul>{v.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          <time dateTime={v.publishedAt}>{new Date(v.publishedAt).toLocaleDateString("zh-CN")}</time>
        </div>
      </li>)}
    </ul>}
  </div>;
}
