"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, CheckCircle2, KeyRound, Loader2, RefreshCw, ReceiptText, ChevronRight } from "lucide-react";
import type { Order } from "@/db/schema";
import { api, errorMessage, formatDate } from "@/lib/client";
import { money, paymentLabel, statusLabels, periodLabel } from "@/lib/catalog/catalog";
import { BrandIcon } from "@/components/brand-icon";

// cardKeyCount 由订单列表接口用子查询附加：这一单已经发过几张卡密。
// 运营据此判断"是否已推送卡密"——它是一个**正交维度**，不是订单状态：
// 状态表达业务阶段（待付/已付/履约中/完成），卡密表达履约凭据是否已交付。
// 混进 statusFlow 会让状态机多出无意义的边，而两者本是独立事实。
export type AdminOrder = Omit<Order, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string; cardKeyCount?: number };

/** 该订单是否已发放过卡密（后台口径：发过就算，含已作废后重发）。 */
export const hasIssuedCard = (order: { cardKeyCount?: number }) => (order.cardKeyCount ?? 0) > 0;
export function useAdminData<T>(resource: string) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  // resource 变化（订单筛选/搜索/翻页）与 reload 都会重新拉取。把「进入加载态」放进微任务，
  // 既保证每次拉取都重置 loading 与 error，又不在 effect 体内同步 setState，避免级联渲染。
  useEffect(() => { const controller = new AbortController(); let active = true; queueMicrotask(() => { if (active) { setLoading(true); setError(""); } }); api<T>(`/api/admin/${resource}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); }).catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => { active = false; controller.abort(); }; }, [resource, revision]);
  return { data, error, loading, reload };
}
export function AdminHeading({ title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode }) { return <div className="admin-page-heading"><div><span className="section-kicker">HAIOU WORKSPACE</span><h1>{title}</h1><p>{subtitle}</p></div><div className="admin-heading-actions">{children}</div></div>; }
export function LoadingState({ error, retry }: { error?: string; retry?: () => void }) { return error ? <div className="empty-state"><ReceiptText size={30}/><h3>数据暂时未能加载</h3><p>{error}</p><div className="result-actions"><button className="button outline" onClick={retry}><RefreshCw size={14}/>重试</button><Link href="/admin-login" className="button soft">重新登录</Link></div></div> : <div className="loading-view" style={{ minHeight: 340 }}><Loader2 size={25} className="spinner"/><p>正在整理你的工作台…</p></div>; }
export function Toast({ message, onClose }: { message: string; onClose: () => void }) { useEffect(() => { if (!message) return; const timer = setTimeout(onClose, 3300); return () => clearTimeout(timer); }, [message, onClose]); return message ? <div className="success-toast" role="status"><CheckCircle2 size={17}/>{message}</div> : null; }
export function OrderStatus({ status }: { status: string }) { return <span className={`status-badge status-${status}`}>{statusLabels[status] || status}</span>; }
export function OrderTable({ orders, onEdit, compact = false, onIssue, issuingId }: { orders: AdminOrder[]; onEdit?: (order: AdminOrder) => void; compact?: boolean; onIssue?: (order: AdminOrder) => void; issuingId?: string }) {
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>订单 / 账号</th><th>订阅套餐</th><th>实付金额</th><th>支付方式</th><th>订单状态</th>{!compact && <th>创建时间</th>}<th>操作</th></tr></thead><tbody>{orders.map(order => {
    // 三个可执行动作，各自独立判断是否可用。放在行内右侧而不是藏进弹窗，
    // 是因为这三个都是高频运营动作（尤其"卡密没发出去"时的补发），
    // 每次都要点开弹窗再找按钮，出了线上问题根本来不及。
    const issued = hasIssuedCard(order);
    // 可发卡密 = 状态允许履约。未付款的订单绝不能出现在这里，否则白送。
    const canIssue = !!onIssue && ["paid", "processing", "completed", "expired", "cancelled"].includes(order.status);
    return <tr key={order.id}><td><span className="table-code">{order.code}</span><span className="table-sub">{order.email}</span></td><td><span className="table-brand"><BrandIcon brand={order.brand}/><span>{order.planName}<span className="table-sub">{order.period === "yearly" ? "全年订阅" : "月度订阅"} / {periodLabel(order.period)}</span></span></span></td><td>¥{money(order.amount)}</td><td>{paymentLabel(order.paymentMethod)}</td><td><OrderStatus status={order.status}/>{issued && <span className="issued-tag" title="该订单已发放过卡密">已推送卡密</span>}</td>{!compact && <td><span className="table-sub no-margin">{formatDate(order.createdAt)}</span></td>}<td><div className="row-actions">{canIssue && <button className="table-action" onClick={() => onIssue(order)} disabled={issuingId === order.id} title={issued ? "换发一张新卡密，旧码立即作废" : "按订单发放卡密"}>{issuingId === order.id ? <Loader2 size={12} className="spinner"/> : <KeyRound size={12}/>} {issued ? "补发卡密" : "发放卡密"}</button>}{onEdit ? <button className="table-action" onClick={() => onEdit(order)}>查看<ChevronRight size={12}/></button> : <Link className="table-action" href={`/admin/orders?q=${order.code}`}>详情<ArrowUpRight size={12}/></Link>}</div></td></tr>;
  })}</tbody></table>{orders.length === 0 && <div className="table-empty"><ReceiptText size={29} strokeWidth={1.4}/><h3>这里还没有订单</h3><p>新的订单会在这里出现。也可以调整筛选条件，找一找其他订单。</p></div>}</div>;
}
