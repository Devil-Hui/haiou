"use client";

import Link from "next/link";
import { ArrowUpRight, CircleCheck, Clock3, PackageOpen, RefreshCw, TriangleAlert, Wallet } from "lucide-react";
import { money } from "@/lib/catalog/catalog";
import { AdminHeading, LoadingState, OrderTable, useAdminData, type AdminOrder } from "./common";

type Overview = {
  pending: number;
  processing: number;
  cancelled: number;
  todayRevenue: number;
  todayPaid: number;
  // 钱已到账但订单状态未推进（过期后到账 / 取消后到账 / 重复扣款）。
  strandedCount: number;
  strandedAmount: number;
  sellableCount: number;
  stockTotal: number | null;
  lowStock: { id: string; name: string; remaining: number | null }[];
  recent: AdminOrder[];
};

export default function Overview() {
  const { data, error, loading, reload } = useAdminData<Overview>("overview");
  return <><AdminHeading title="今天要处理什么" subtitle="只列出需要你动手的事，看板不做无用的累计数字。"><button className="refresh-button" onClick={reload} aria-label="刷新概览"><RefreshCw size={15} className={loading ? "spinner" : ""}/></button></AdminHeading>
    {loading || error || !data ? <LoadingState error={error} retry={reload}/> : <>
      <section className="stat-grid">
        <article className="stat-card">
          <div className="stat-top"><span>待完成充值</span><span className="stat-icon"><Clock3 size={17} strokeWidth={1.7}/></span></div>
          <strong>{data.processing}</strong>
          <p>已收款、等待充值到账的订单</p>
          {data.processing > 0 && <Link className="stat-action" href="/admin/orders?status=processing">去处理<ArrowUpRight size={12}/></Link>}
        </article>
        <article className="stat-card">
          <div className="stat-top"><span>待支付订单</span><span className="stat-icon"><Wallet size={17} strokeWidth={1.7}/></span></div>
          <strong>{data.pending}</strong>
          <p>买家已下单，尚未确认到账</p>
          {data.pending > 0 && <Link className="stat-action" href="/admin/orders?status=pending">去核对<ArrowUpRight size={12}/></Link>}
        </article>
        <article className="stat-card">
          <div className="stat-top"><span>今日确认收入</span><span className="stat-icon"><CircleCheck size={17} strokeWidth={1.7}/></span></div>
          <strong>¥{money(data.todayRevenue)}</strong>
          <p>{data.todayPaid} 笔已收款{data.cancelled > 0 ? ` · 今日取消 ${data.cancelled} 笔` : ""}</p>
        </article>
        {data.strandedCount > 0 && <article className="stat-card warn">
          <div className="stat-top"><span>待人工核对收款</span><span className="stat-icon"><TriangleAlert size={17} strokeWidth={1.7}/></span></div>
          <strong>¥{money(data.strandedAmount)}</strong>
          <p>{data.strandedCount} 笔已到账但订单状态未推进，需人工确认后放行</p>
          <Link className="stat-action" href="/admin/orders?status=expired">去处理<ArrowUpRight size={12}/></Link>
        </article>}
        <article className={`stat-card ${data.lowStock.length > 0 ? "warn" : ""}`}>
          <div className="stat-top"><span>卡密可售库存</span><span className="stat-icon">{data.lowStock.length > 0 ? <TriangleAlert size={17} strokeWidth={1.7}/> : <PackageOpen size={17} strokeWidth={1.7}/>}</span></div>
          <strong>{data.stockTotal === null ? "不限" : data.stockTotal}</strong>
          <p>{data.sellableCount} 个自动交付套餐{data.lowStock.length > 0 ? ` · ${data.lowStock.length} 个需补货` : " · 库存充足"}</p>
          <Link className="stat-action" href="/admin/plans">管理库存<ArrowUpRight size={12}/></Link>
        </article>
      </section>

      {data.lowStock.length > 0 && <section className="panel low-stock-panel">
        <div className="admin-panel-header"><h2>需要补货</h2><span>可售份数 ≤ 10 的套餐</span></div>
        <ul className="low-stock-list">{data.lowStock.map((item) => <li key={item.id}>
          <span className="low-stock-name">{item.name}</span>
          <span className={`low-stock-count ${(item.remaining ?? 0) <= 0 ? "out" : ""}`}>{item.remaining === null ? "不限" : item.remaining <= 0 ? "已售罄" : `剩 ${item.remaining} 份`}</span>
          <Link className="table-action" href="/admin/plans">调整<ArrowUpRight size={12}/></Link>
        </li>)}</ul>
      </section>}

      <section className="table-panel">
        <div className="admin-panel-header"><h2>最新订单</h2><Link href="/admin/orders" className="table-action">查看全部<ArrowUpRight size={13}/></Link></div>
        <OrderTable orders={data.recent}/>
      </section>
    </>}</>;
}
