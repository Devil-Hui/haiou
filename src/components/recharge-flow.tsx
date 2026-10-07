"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Ban, Check, CircleCheck, Clock3, Copy, KeyRound, Loader2, Search, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { api, errorMessage, getDeliveryToken } from "@/lib/client";
import type { PlanWithStock } from "@/lib/catalog";

/**
 * 自动充值流程（四步向导；前台彻底不出现「卡密」概念，也绝不暴露上游是谁）。
 *
 * 与目标站的关键差异：
 *   目标站第一步是「输入 CDK 卡密」——它的卡密是买家自己持有的凭证。
 *   本站是卖方：卡密在付款成功时由系统自动绑定到订单（见 issueCardKeyForOrder），
 *   买家全程看不到、也不必复制粘贴。因此第一步改为「填写订单号」，
 *   服务端凭订单号解析出已付款订单并校验邮箱归属，卡密只存在于服务端。
 *
 * 这同时补掉了一个业务漏洞：改造前本接口只收 planId + email，不校验付款，
 * 任何人打开页面就能提交凭证白嫖上游。现在未付款订单一律无法进入。
 *
 * 前端可见字段只有三个：订单号、账号邮箱、账号登录态（买家自己的）。
 */

type Plan = Pick<PlanWithStock, "id" | "name" | "brand" | "price" | "description" | "period" | "feeRate" | "stockInfo">;

type Progress = {
  code: string;
  planName: string;
  status: string;
  /** 对外四态：waiting / succeeded / failed / timed_out。由服务端判定，前端不自行推导。 */
  outcome: "waiting" | "succeeded" | "failed" | "timed_out";
  done: boolean;
  remainingSeconds: number;
  resultNote: string;
  failureReason: string;
  updatedAt: string;
  events: { stage: string; message: string; at: string }[];
};

const STEPS = ["填写订单号", "填写凭证", "确认信息", "等待处理"];

// 对外的状态文案。这里是唯一决定"买家看到什么"的地方，
// 上游的原始状态词一律不直接透出。
const STATUS_TEXT: Record<string, string> = {
  validating: "正在验证账号",
  confirmed: "账号验证通过",
  submitted: "已提交，正在排队",
  processing: "正在处理",
  succeeded: "充值完成",
  failed: "处理失败",
  timed_out: "处理超时",
};
const STATUS_HINT: Record<string, string> = {
  validating: "正在校验账号登录态，请稍候",
  confirmed: "校验通过，即将提交",
  submitted: "已进入处理队列",
  processing: "正在处理，通常约 1 分钟完成，请勿关闭页面",
  succeeded: "充值已完成",
  failed: "可查看下方原因后重试",
  timed_out: "处理时间超出预期，已转人工核实。期间请勿重复提交，以免重复扣款。",
};

export default function RechargeFlow({ plans, enabled }: { plans: Plan[]; enabled: boolean }) {
  const [tab, setTab] = useState<"submit" | "query" | "batch">("submit");
  const [step, setStep] = useState(0);
  // orderCode = 买家输入的订单号（进入流程用）；code = 受理后生成的任务号（查进度用）。
  // 两者不是一回事：订单号是买家付款后已持有的凭证，任务号是本站受理后生成的。
  const [orderCode, setOrderCode] = useState("");
  const [planId, setPlanId] = useState(plans[0]?.id || "");
  const [email, setEmail] = useState("");
  const [email2, setEmail2] = useState("");
  const [credential, setCredential] = useState("");
  const [code, setCode] = useState("");
  const [batchInput, setBatchInput] = useState("");
  const [batchResult, setBatchResult] = useState<{ code: string; state: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifyState, setVerifyState] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<number | null>(null);
  const clearPolling = () => { if (timer.current !== null) { clearInterval(timer.current); timer.current = null; } };

  const plan = plans.find((p) => p.id === planId);

  // 轮询只在"等待处理"阶段开启，到终态立刻停——不空转，也不给上游压力。
  //
  // 每一拍同时做两件事：推进任务 + 读进度。缺了推进，买家就得干等
  // maintenance 定时任务的 5 分钟间隔——页面上进度条 5 秒一跳却始终停在
  // "已提交"，看着像卡死。advance 是 POST（带副作用），所以与只读的查询
  // 分开两个请求，语义清晰且能被浏览器预取安全地跳过。
  useEffect(() => {
    if (step !== 3 || !code) return;
    let alive = true;
    const tick = async () => {
      // ⚠️ 取卡码是按**订单号**存的（checkout 下单时 saveDeliveryToken(order.code, ...)），
      // 而这里的 code 在提交后是**任务号**（recharge_jobs.code），两者不是一回事。
      // 用任务号去查 token 恒为空 → 进度接口 403 → 被下面的 catch 静默吞掉 →
      // 页面永远停在"已提交，正在排队"并每 10 秒空转。
      // 进度查询入口（queryOne）没有 orderCode，此时 code 本身就是订单号，故回退到 code。
      const token = getDeliveryToken(orderCode || code);
      try {
        // 推进失败（限流、上游抖动、任务已在推进中）都不该中断轮询：
        // 下一拍还会试，读进度仍然有效。
        await fetch("/api/recharge/advance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, token }),
        });
      } catch { /* 忽略，下一拍重试 */ }
      try {
        const data = await api<Progress>(`/api/recharge?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`);
        if (!alive) return;
        setProgress(data);
        // 用服务端给出的 done 判定终止，避免前端硬编码状态列表而漏掉新增的终态（如超时）。
        if (data.done) { clearPolling(); return; }
      } catch { /* 单次失败不终止轮询，下一拍重试 */ }
    };
    tick();
    // 10 秒一拍，不是 5 秒。
    //
    // 服务端 advanceJob 内部有 90 秒查询节流（lastQueriedAt），所以真正的推进
    // 频率上限就是 90 秒一次——5 秒轮询里 17/18 次的推进请求都会被节流直接
    // 返回当前状态，白跑一遍还占用 advance 的限流配额（20 次/分）。
    // 改成 10 秒后是 6 次/分，既让 90 秒节流窗口内稳定命中 1 次推进，
    // 也给限流留出足够余量（用户在两个标签页看同一单也不会撞 429）。
    timer.current = window.setInterval(tick, 10000);
    return () => { alive = false; if (timer.current) window.clearInterval(timer.current); };
    // 依赖里带上 orderCode：tick 用 `orderCode || code` 取取卡码（见 tick 内注释），
    // 提交后 orderCode 是订单号、code 是任务号，两者都要参与要不要重启轮询的判定。
  }, [step, code, orderCode]);


  /**
   * 预检：在进入确认页之前先问一次上游「这个账号能不能充」。
   *
   * 不预检的后果是：买家一路填到第 4 步才发现登录态失效/账号有 TEAM，
   * 白等一轮。预检把失败提前到第 2 步，且此步不落库、不占配额。
   */
  async function verifyBeforeConfirm() {
    setBusy(true); setError("");
    try {
      await api("/api/recharge", { method: "POST", body: JSON.stringify({ action: "verify", orderCode, email, credential, token: getDeliveryToken(orderCode) }) });
      setVerifyState("ok");
      setStep(2);
    } catch (err) {
      setVerifyState("fail");
      setError(errorMessage(err));
    } finally { setBusy(false); }
  }

  async function submitAll() {
    setBusy(true); setError("");
    try {
      // 服务端对提交接口做取卡码归属校验（防他人订单被冒名充值），
      // 取卡码按订单号存，这里必须一并带上。
      const created = await api<{ code: string }>("/api/recharge", {
        method: "POST",
        body: JSON.stringify({ orderCode, email, credential, token: getDeliveryToken(orderCode) }),
      });
      setCode(created.code);
      setStep(3);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  async function queryOne(target?: string) {
    const value = (target ?? code).trim().toUpperCase();
    if (!value) { setError("请填写订单号"); return; }
    setBusy(true); setError("");
    try {
      const data = await api<Progress>(`/api/recharge?code=${encodeURIComponent(value)}&token=${encodeURIComponent(getDeliveryToken(value))}`);
      setProgress(data); setCode(value); setStep(3);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  async function queryBatch() {
    const codes = [...new Set(batchInput.split(/[\s,]+/).map((v) => v.trim().toUpperCase()).filter(Boolean))].slice(0, 50);
    if (!codes.length) { setError("请输入至少一个订单号"); return; }
    setBusy(true); setError("");
    try {
      const results = await Promise.all(codes.map(async (c) => {
        try {
          const data = await api<Progress>(`/api/recharge?code=${encodeURIComponent(c)}&token=${encodeURIComponent(getDeliveryToken(c))}`);
          return { code: c, state: data.status };
        } catch { return { code: c, state: "not_found" }; }
      }));
      setBatchResult(results);
    } finally { setBusy(false); }
  }

  // 四态派生。刻意不逐个判断 status：新增终态时只改服务端 outcomeOf，
  // 前端这里自动跟上，不会再出现"某个状态没文案、图标也不对"的漏网情况。
  const outcome = progress?.outcome ?? "waiting";
  const done = outcome === "succeeded";
  const failed = outcome === "failed";
  const timedOut = outcome === "timed_out";

  return <main className="page-main container">
    <div className="page-topline"><span><ShieldCheck size={12}/>凭证加密提交 · 全程可查</span></div>
    <div className="page-title">
      <span className="section-kicker">AUTOMATED RECHARGE</span>
      <h1>自动充值</h1>
      <p>提交账号登录态，系统自动完成充值，通常约 1 分钟。</p>
    </div>

    {!enabled && <div className="notice warning" style={{ marginBottom: 18 }}><TriangleAlert size={16}/><div>自动充值当前未开放，请使用下单购买或联系客服。</div></div>}

    <div className="rc-tabs">
      {([["submit", "提交充值"], ["query", "进度查询"], ["batch", "批量查询"]] as const).map(([key, label]) => (
        <button key={key} className={tab === key ? "active" : ""} onClick={() => { setTab(key); setError(""); }}>{label}</button>
      ))}
    </div>

    {tab === "submit" && <>
      <ol className="rc-steps">{STEPS.map((name, i) => (
        <li key={name} className={i === step ? "active" : i < step ? "done" : ""}><span>{i < step ? <Check size={12}/> : `0${i + 1}`}</span><p>{name}</p></li>
      ))}</ol>

      <section className="panel rc-panel">
        {step === 0 && <>
          <h2 className="panel-heading"><Zap size={18}/>第 1 步 · 填写订单号</h2>
          <p className="field-hint" style={{ marginBottom: 14 }}>输入付款后收到的订单号。提交前不会占用任何资源，也不会产生扣费。</p>
          <label className="field"><span className="field-label">订单号</span>
            <input className="input" value={orderCode} onChange={(e) => setOrderCode(e.target.value.toUpperCase())} placeholder="AU20260101XXXXXXXX" maxLength={40} autoComplete="off"/>
            <p className="field-hint">订单号需与下单时填写的邮箱一致。找不到订单号？可在「订单查询」用下单邮箱找回。</p>
          </label>
          <div className="dialog-actions">
            <button className="button primary full" disabled={!orderCode || orderCode.length < 8} onClick={() => { setError(""); setStep(1); }}>下一步，填写凭证<ArrowRight size={16}/></button>
          </div>
        </>}

        {step === 1 && <>
          <h2 className="panel-heading"><KeyRound size={18}/>第 2 步 · 填写凭证</h2>
          <label className="field"><span className="field-label">账号邮箱</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="该账号注册的邮箱" required maxLength={254}/></label>
          <label className="field"><span className="field-label">账号登录态</span><textarea className="input" value={credential} onChange={(e) => setCredential(e.target.value)} rows={4} placeholder="在目标站打开会话接口，全选复制后粘贴到此处；也支持直接粘贴以 eyJ 开头的 accessToken" required maxLength={8000}/><p className="field-hint">提交后立即加密保存，直连上游成功后自动清除；处理完成后建议重新登录以刷新凭证。</p></label>
          <div className="notice"><ShieldCheck size={16}/><div><strong>凭证只在本次订单的页面提交。</strong><br/>请勿发送给他人。充值完成后建议重新登录目标站以刷新登录态。<br/><span style={{ opacity: .85 }}>提交后，登录态将加密保存并自动用于完成充值；本站不留存明文，处理完成即清除。</span></div></div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions"><button className="button outline" onClick={() => setStep(0)}>上一步</button><button className="button primary" disabled={!email || credential.length < 8} onClick={() => { setVerifyState("idle"); verifyBeforeConfirm(); }}>下一步，确认信息<ArrowRight size={16}/></button></div>
        </>}

        {step === 2 && <>
          <h2 className="panel-heading"><Search size={18}/>第 3 步 · 确认信息</h2>
          <div className="summary-lines">
            <div className="summary-line"><span>订单号</span><span><code>{orderCode}</code></span></div>
            <div className="summary-line"><span>账号邮箱</span><span>{email}</span></div>
            <div className="summary-line"><span>处理方式</span><span>自动化处理</span></div>
          </div>
          <div className="notice"><ShieldCheck size={16}/><div>确认后订单进入自动处理队列，登录态将加密保存并自动用于完成充值，本站不留存明文、处理完成即清除。处理失败时不会重复扣费，可直接重试。</div></div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions"><button className="button outline" onClick={() => setStep(1)} disabled={busy}>上一步</button><button className="button primary" onClick={submitAll} disabled={busy}>{busy ? <Loader2 size={15} className="spinner"/> : null}确认提交并自动处理</button></div>
        </>}

        {step === 3 && <div className="rc-progress">
          <h2 className={`panel-heading ${timedOut ? "is-timeout" : ""}`}>{done ? <CircleCheck size={18}/> : failed ? <Ban size={18}/> : timedOut ? <Clock3 size={18}/> : <Loader2 size={18} className="spinner"/>}{STATUS_TEXT[progress?.status || "submitted"] || "处理中"}</h2>
          <p className="muted">{STATUS_HINT[progress?.status || "submitted"]}</p>
          <div className="summary-lines">
            {/* 这里必须展示**订单号**而不是任务号：买家要抄走它去「进度查询」页复查，
                而进度查询是按订单号取取卡码的。展示任务号会让买家抄走一个查不到的号。 */}
            <div className="summary-line"><span>订单号</span><span><code>{orderCode || code}</code> <button className="table-action" onClick={() => { navigator.clipboard?.writeText(orderCode || code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? <Check size={12}/> : <Copy size={12}/>}复制</button></span></div>
            <div className="summary-line"><span>充值套餐</span><span>{progress?.planName || plan?.name}</span></div>
            <div className="summary-line"><span>当前状态</span><span>{STATUS_TEXT[progress?.status || ""] || "排队中"}</span></div>
            {(failed || timedOut) && progress?.failureReason && <div className="summary-line"><span>{failed ? "失败原因" : "超时说明"}</span><span>{progress.failureReason}</span></div>}
            {!done && !failed && !timedOut && progress && progress.remainingSeconds > 0 && <div className="summary-line"><span>预计剩余</span><span>约 {Math.ceil(progress.remainingSeconds / 60)} 分钟</span></div>}
            {done && progress?.resultNote && <div className="summary-line"><span>结果</span><span>{progress.resultNote}</span></div>}
          </div>
          {!done && !failed && !timedOut && <div className="rc-timeline">{(progress?.events || []).slice().reverse().map((e, i) => <div key={`${e.at}-${i}`}><Clock3 size={12}/><span>{STATUS_TEXT[e.stage] || e.stage}</span>{e.message && <em>{e.message}</em>}</div>)}</div>}
          <p className="summary-note">进度每 10 秒自动刷新，请勿关闭页面；也可以记录订单号后在「进度查询」中随时查看。</p>
          <div className="dialog-actions">
            <Link className="button primary" href="/#plans">继续充值下一单</Link>
            {/* 同样用订单号，任务号在订单列表里查不到。 */}
            {progress && <Link className="button outline" href={`/orders?q=${orderCode || code}`}>查看订单记录</Link>}
          </div>
        </div>}
      </section>
    </>}

    {tab === "query" && <section className="panel rc-panel">
      <h2 className="panel-heading"><Search size={18}/>进度查询</h2>
      <p className="field-hint" style={{ marginBottom: 12 }}>输入提交后获得的订单号，即可查看当前状态。</p>
      <div className="rc-inline"><input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="订单号" maxLength={40}/><button className="button primary" onClick={() => queryOne()} disabled={busy}>{busy ? <Loader2 size={15} className="spinner"/> : "查询进度"}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {progress && <div className="rc-result"><div className="summary-line"><span>状态</span><span>{STATUS_TEXT[progress.status] || progress.status}</span></div><div className="summary-line"><span>套餐</span><span>{progress.planName}</span></div>{progress.failureReason && <div className="summary-line"><span>原因</span><span>{progress.failureReason}</span></div>}</div>}
    </section>}

    {tab === "batch" && <section className="panel rc-panel">
      <h2 className="panel-heading"><Search size={18}/>批量查询</h2>
      <p className="field-hint" style={{ marginBottom: 12 }}>每行一个订单号，一次最多 50 个，重复的会自动合并。</p>
      <textarea className="input" value={batchInput} onChange={(e) => setBatchInput(e.target.value)} rows={5} placeholder={`${"AU2026010100000AAAA\nAU2026010100000BBBB"}`}/>
      <button className="button primary full" style={{ marginTop: 12 }} onClick={queryBatch} disabled={busy}>{busy ? <Loader2 size={15} className="spinner"/> : "批量查询"}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      {batchResult && <ul className="rc-batch">{batchResult.map((r) => <li key={r.code}><code>{r.code}</code><span className={`rc-state ${r.state}`}>{r.state === "not_found" ? "未找到" : STATUS_TEXT[r.state] || r.state}</span></li>)}</ul>}
    </section>}
  </main>;
}
