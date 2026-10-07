"use client";

import { useEffect, useState } from "react";
import { Copy, Check, Download, KeyRound, ShieldCheck } from "lucide-react";
import { api, getDeliveryToken } from "@/lib/client";

type Delivery =
  | { kind: "none" }
  | { kind: "issued" }
  | { kind: "sold_out" }
  | { kind: "new"; code: string; planName: string };

// 卡密只存摘要，明文不落库，所以服务端只在「首次发放」这一次能把它交出来。
// 之后任何一次请求都拿不到，界面上就必须明确告诉买家：现在不保存，以后就没有了。
//
// 【两种取卡凭据】
//   · 一次性取卡码：下单成功时展示一次，存在 localStorage（按订单号索引）
//   · 取卡密码  ：访客下单时自己设置的，从 sessionStorage 传入（原 ?pw= URL 传参已废弃，
//     见 lib/client.ts——密码进 URL 会落到历史、access.log、Referer 与截图里）。
// 两者服务端都接受（orders/[id]/delivery），任一通过即可发放。
export default function CardDelivery({ orderId, orderCode, password }: { orderId: string; orderCode?: string; password?: string }) {
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    // 取卡码是下单时存入 localStorage 的，按订单号取出来。
    // 缺码时**不发请求**（连 403 都不用打），直接按"无卡密"渲染。
    const token = orderCode ? getDeliveryToken(orderCode) : "";
    if (!token && !password) return () => { active = false; };
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (password) params.set("password", password);
    api<Delivery>(`/api/orders/${orderId}/delivery?${params}`, { method: "POST" })
      .then((data) => { if (active) setDelivery(data); })
      .catch(() => { if (active) setDelivery({ kind: "none" }); });
    return () => { active = false; };
  }, [orderId, orderCode, password]);

  if (!delivery || delivery.kind === "none") return null;

  if (delivery.kind === "issued") {
    return <div className="delivery-box"><div className="notice warning"><ShieldCheck size={15}/><span>该订单的卡密此前已发放。出于安全考虑，卡密不会重复展示；如需找回请联系客服核对订单。</span></div></div>;
  }

  if (delivery.kind === "sold_out") {
    return <div className="delivery-box"><div className="notice warning"><ShieldCheck size={15}/><span>该套餐的卡密库存已发放完毕，本次未能自动生成。你的订单已记录，我们会尽快人工处理，请凭订单号联系客服。</span></div></div>;
  }

  const code = delivery.code;
  const planName = delivery.planName;
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2200); } catch { /* 剪贴板不可用时保留手动复制 */ }
  }
  function download() {
    const rows = [["卡密", "套餐"], [code, planName]];
    const escape = (text: string) => `"${text.replace(/"/g, '""')}"`;
    const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `haiou-cdk-${code}.csv`;
    link.click();
    URL.revokeObjectURL(href);
  }

  return <div className="delivery-box"><h2 className="panel-heading"><KeyRound size={18}/>你的卡密</h2><div className="result-details"><div className="summary-line"><span>兑换卡密</span><span className="table-code">{code}</span></div><div className="summary-line"><span>适用套餐</span><span>{planName}</span></div></div><div className="notice warning"><ShieldCheck size={15}/><span>卡密即凭证，请勿泄露给他人。它只展示这一次，离开或刷新后将无法再次查看，请先复制或导出保存。</span></div><div className="result-actions"><button type="button" className="button outline" onClick={copy}>{copied ? <><Check size={14}/>已复制</> : <><Copy size={14}/>复制卡密</>}</button><button type="button" className="button soft" onClick={download}><Download size={13}/>导出 CSV</button></div></div>;
}
