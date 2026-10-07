"use client";

import { useState, type FormEvent } from "react";
import { Copy, Info, Loader2, LockKeyhole, Save, ShieldCheck } from "lucide-react";
import type { PaymentSettings } from "@/db/schema";
import { api, errorMessage } from "@/lib/client";
import { PaymentSymbol } from "@/components/checkout";
import { AdminHeading, LoadingState, Toast, useAdminData } from "./common";

/** 网关就绪状态。由服务端判定，前端不自行推导——否则两处逻辑会漂移。 */
type GatewayState = { code: string; name: string; ready: boolean; missing: string[]; disabledInProduction: boolean };
type Settings = PaymentSettings & {
  privateKeyConfigured: boolean;
  usdtWebhookConfigured: boolean;
  epayKeyConfigured: boolean;
  binanceKeyConfigured: boolean;
  binanceSecretConfigured: boolean;
  epusdtTokenConfigured: boolean;
  gateways: GatewayState[];
  /**
   * 四条通道的就绪判定结果（含缺失项清单），由服务端 config.ts 判定。
   * 前端不自行推导——此前三处各写一套判断，条件并不相同，
   * 于是出现过"后台显示已开启、前台却说未就绪"。
   */
  channels?: Partial<Record<"alipay" | "epay" | "epusdt" | "binance" | "usdt", { ready: boolean; reason: string; missing: string[] }>>;
};

/** 回调路径集中在此，避免三处手写各写错一次。 */
const CALLBACK_PATHS = {
  usdt: "/api/payments/usdt/confirm",
  alipay: "/api/payments/alipay/notify",
  epay: "/api/payments/epay/notify",
  binance: "/api/payments/binance/notify",
  epusdt: "/api/payments/epusdt/notify",
} as const;

export default function PaymentConfiguration() {
  const { data, error, loading, reload } = useAdminData<Settings>("settings");
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [toast, setToast] = useState("");
  const [storeBusy, setStoreBusy] = useState(false);

  // 服务端数据到达或刷新后把表单重置为最新值。这里用「渲染期调整」而非 effect：
  // data 身份一变就同步生效，省掉一次额外提交，也不会出现旧表单值闪一下再更新。
  const [seed, setSeed] = useState<Settings | null>(null);
  if (data && data !== seed) { setSeed(data); setForm(data); }

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((previous) => (previous ? { ...previous, [key]: value } : null));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setSaveError("");
    try {
      await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify(form) });
      setToast("支付配置已安全保存");
      reload();
    } catch (err) { setSaveError(errorMessage(err)); } finally { setBusy(false); }
  }

  // 全站接单开关是独立轻量动作：不该被「汇率/网关是否填好」绑住，
  // 也不该每次都提交整个支付配置表单。
  async function toggleStore() {
    if (!form) return;
    const next = !form.storeOpen;
    const reason = next ? "" : window.prompt("暂停接单的原因会展示给买家，请填写：", "支付通道维护中，请稍后再试");
    if (!next && reason === null) return;
    setStoreBusy(true); setSaveError("");
    try {
      await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ action: "store", open: next, reason: reason || "" }) });
      setToast(next ? "已恢复接单" : "已暂停接单，买家将看到你填写的暂停原因");
      reload();
    } catch (err) { setSaveError(errorMessage(err)); } finally { setStoreBusy(false); }
  }

  async function copy(path: string) {
    try {
      await navigator.clipboard.writeText(`${form?.siteUrl || window.location.origin}${path}`);
      setToast("回调地址已复制");
    } catch { setSaveError("浏览器未授权剪贴板，请手动复制回调路径"); }
  }

  return <>
    <AdminHeading title="支付配置" subtitle="简单的适配层，让每一笔资金都有清晰的来处。">
      {form && <button type="button" className={`button ${form.storeOpen ? "outline" : "primary"} small`} onClick={toggleStore} disabled={storeBusy}>
        {form.storeOpen ? "暂停接单" : "恢复接单"}
      </button>}
    </AdminHeading>

    {loading || error || !form ? <LoadingState error={error} retry={reload}/> : <form onSubmit={save}>
      <div className="notice" style={{ marginBottom: 14 }}>
        <Info size={16}/>
        <div><strong>配置以环境变量为准。</strong><br/>
        下面这些输入框填的是<strong>兜底值</strong>：只要服务器的 <code>.env</code> 里写了对应变量，这里的值就会被覆盖。
        所以最省事的做法是——<strong>只在 <code>.env</code> 填密钥，重启即生效，不必在本页点任何开关</strong>。
        需要高频调整的是「费率 / 汇率」这类值，留在本页改更方便。</div>
      </div>

      <div className="notice warning" style={{ marginBottom: 23 }}>
        <ShieldCheck size={16}/>
        <div>上线前请核对真实收款账户并完成小额联调。通道不会模拟支付成功。私钥与回调密钥只从服务器环境变量读取，不会入库、不会下发浏览器。</div>
      </div>

      {!form.storeOpen && <div className="notice danger" style={{ marginBottom: 23 }}>
        <Info size={16}/>
        <div>全站已暂停接单{form.pausedReason ? `：${form.pausedReason}` : ""}。已存在的订单仍可正常查单与到账确认。</div>
      </div>}

      <GatewayStatus gateways={form.gateways} />

      <div className="admin-config-grid">
        <UsdtPanel form={form} set={set} onCopy={copy} />
        <AlipayPanel form={form} set={set} onCopy={copy} />
        <EpayPanel form={form} set={set} onCopy={copy} />
        <EpusdtPanel form={form} set={set} onCopy={copy} />
        <BinancePanel form={form} set={set} onCopy={copy} />
      </div>

      {saveError && <p className="form-error" role="alert">{saveError}</p>}
      <div className="config-footer">
        <p>设置保存后对新支付请求生效，历史订单金额保持不变</p>
        <button className="button primary" type="submit" disabled={busy}>{busy ? <Loader2 size={15} className="spinner"/> : <Save size={15}/>}保存支付配置</button>
      </div>
    </form>}
    <Toast message={toast} onClose={() => setToast("")}/>
  </>;
}

type PanelProps = {
  form: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onCopy: (path: string) => void;
};

/**
 * 通道就绪状态。
 * 直接回答「哪个通道没配好、缺什么」，而不是让运营对着三个表单猜。
 * 密钥类缺口（如 ALIPAY_PRIVATE_KEY 未设置）也在这里可见。
 */
function GatewayStatus({ gateways }: { gateways?: GatewayState[] }) {
  if (!gateways?.length) return null;
  return <div className="notice gateway-status" style={{ marginBottom: 23 }}>
    <ShieldCheck size={16}/>
    <div>
      <strong>通道就绪状态</strong>
      <ul className="gateway-list">
        {gateways.map((g) => <li key={g.code}>
          <span className={g.ready ? "ok" : "off"}>{g.ready ? "可用" : g.disabledInProduction ? "生产已禁用" : "未就绪"}</span>
          <b>{g.name}</b>
          {!g.ready && g.missing.length > 0 && <em>缺：{g.missing.join("、")}</em>}
        </li>)}
      </ul>
      <p className="field-hint">未就绪的通道不会出现在买家可选的支付方式里——让买家选一个必然失败的选项，比不显示它更糟。</p>
    </div>
  </div>;
}

/** 回调地址行：复制按钮 + 明文路径。抽成组件避免三处重复同一段 JSX。 */
function CallbackCopy({ path, onCopy }: { path: string; onCopy: (path: string) => void }) {
  return <div className="config-env">
    <button type="button" className="table-action" onClick={() => onCopy(path)} aria-label={`复制回调地址 ${path}`}><Copy size={14}/></button>
    回调地址：<code>{path}</code>
  </div>;
}

/** 环境变量状态行：只显示是否已配置，绝不回显密钥本身。 */
function EnvStatus({ name, ok, on, off }: { name: string; ok: boolean; on: string; off: string }) {
  return <div className="config-env">
    <LockKeyhole size={13} style={{ display: "inline", marginRight: 5, verticalAlign: "middle" }}/>{name}：<code>{name}</code>
    <span className={ok ? "is-configured" : "not-configured"}>{ok ? on : off}</span>
  </div>;
}

function UsdtPanel({ form, set, onCopy }: PanelProps) {
  return <section className="panel">
    <div className="config-heading">
      <PaymentSymbol method="usdt"/>
      <div><h2>USDT 收款</h2><p>TRON 网络 · TRC20</p></div>
      <button type="button" className={`switch ${form.usdtEnabled ? "on" : ""}`} role="switch" aria-checked={form.usdtEnabled} aria-label="启用 USDT 支付" onClick={() => set("usdtEnabled", !form.usdtEnabled)}><span/></button>
    </div>
    <label className="field"><span className="field-label">TRC20 收款钱包地址</span>
      <input className="input" value={form.walletAddress} onChange={(e) => set("walletAddress", e.target.value)} placeholder="T 开头的 34 位 TRON 地址" maxLength={34}/>
      <p className="field-hint">请确认你拥有此地址。已生成收款信息的历史订单不会随钱包变更而更换地址。</p>
    </label>
    <label className="field"><span className="field-label">通道费率（%）</span>
  <input className="input" type="number" min="0" max="50" step="0.01" value={form.usdtFeeRate} onChange={(e) => set("usdtFeeRate", e.target.value)}/>
  <p className="field-hint">TRC20 链上手续费是固定的约 1 USDT，不是百分比。按你的套餐均价折算：链上费(元) ÷ 套餐价 × 100。填错会每单倒贴。</p></label>
  <label className="field"><span className="field-label">兑换汇率（1 USDT = ? CNY）</span>
      <input className="input" type="number" min="0.0001" max="1000" step="0.0001" value={form.exchangeRate} onChange={(e) => set("exchangeRate", e.target.value)} required/>
      <p className="field-hint">应付 USDT = 人民币价格 ÷ 汇率，精确至小数点后 6 位。汇率在下单时锁定。</p>
    </label>
    <EnvStatus name="USDT_WEBHOOK_SECRET" ok={form.usdtWebhookConfigured} on="已配置 · 可接收可信链上服务的签名事件" off="未配置 · 当前需管理员核实到账后人工确认"/>
    <div className="notice"><Info size={15}/><div><strong>链上确认接口已预留</strong><br/>本项目不运行链上索引器。接入自己的可信监听服务后，发送带 HMAC 签名的已确认转账事件。请勿仅凭前台“已付款”按钮更改支付状态。</div></div>
    <CallbackCopy path={CALLBACK_PATHS.usdt} onCopy={onCopy}/>
  </section>;
}

function AlipayPanel({ form, set, onCopy }: PanelProps) {
  return <section className="panel">
    <div className="config-heading">
      <PaymentSymbol method="alipay"/>
      <div><h2>支付宝</h2><p>RSA2 签名 · 页面跳转</p></div>
      <button type="button" className={`switch ${form.alipayEnabled ? "on" : ""}`} role="switch" aria-checked={form.alipayEnabled} aria-label="启用支付宝支付" onClick={() => set("alipayEnabled", !form.alipayEnabled)}><span/></button>
    </div>
    <label className="field"><span className="field-label">应用 AppID</span>
      <input className="input" value={form.alipayAppId} onChange={(e) => set("alipayAppId", e.target.value)} placeholder="2021xxxxxxxxxxxx"/>
      <p className="field-hint">开放平台应用的 AppID，与之绑定的应用已上线才可收款。</p>
    </label>
    <label className="field"><span className="field-label">卖家 PID</span>
      <input className="input" value={form.alipaySellerId} onChange={(e) => set("alipaySellerId", e.target.value)} placeholder="2088xxxxxxxxxxxx"/>
    </label>
    <label className="field"><span className="field-label">应用公钥（支付宝公钥）</span>
      <textarea className="input" rows={3} value={form.alipayPublicKey} onChange={(e) => set("alipayPublicKey", e.target.value)} placeholder="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A…"/>
      <p className="field-hint">用于校验回调签名，填错会导致付款成功但订单不更新。</p>
    </label>
    <label className="field"><span className="field-label">网关地址</span>
      <input className="input" value={form.alipayGateway} onChange={(e) => set("alipayGateway", e.target.value)} placeholder="https://openapi.alipay.com/gateway.do"/>
    </label>
    <label className="field"><span className="field-label">通道费率（%）</span>
  <input className="input" type="number" min="0" max="50" step="0.01" value={form.alipayFeeRate} onChange={(e) => set("alipayFeeRate", e.target.value)}/>
  <p className="field-hint">支付宝向商家抽取的比例。本站走<strong>电脑网站支付</strong>，官方标准 0.6%（2026-10 核实）。
    常见误区：0.8% 是<strong>收钱码</strong>产品的贷记渠道费率，本站不走收钱码；花呗/信用卡在电脑网站支付下同样按 0.6% 计。
    若日后开启<strong>花呗分期</strong>，费用由商家承担且远高于此（3 期 1.80% / 6 期 4.50% / 12 期 7.50%），需按实际期数调高。
    这里填多少，买家应付就按此反算，你到手仍是你填的套餐价。</p></label>
  <label className="field"><span className="field-label">站点公网地址</span>
      <input className="input" value={form.siteUrl} onChange={(e) => set("siteUrl", e.target.value)} placeholder="https://your-domain.com"/>
      <p className="field-hint">用于拼接支付回调与同步跳转地址，务必与实际域名一致且不带末尾斜杠。</p>
    </label>
    <EnvStatus name="ALIPAY_PRIVATE_KEY" ok={form.privateKeyConfigured} on="已配置" off="未配置 · 开启支付宝前必须设置"/>
    <CallbackCopy path={CALLBACK_PATHS.alipay} onCopy={onCopy}/>
  </section>;
}

function EpayPanel({ form, set, onCopy }: PanelProps) {
  return <section className="panel">
    <div className="config-heading">
      <PaymentSymbol method="epay"/>
      <div><h2>易支付收银台</h2><p>一次接入覆盖多种通道</p></div>
      <button type="button" className={`switch ${form.epayEnabled ? "on" : ""}`} role="switch" aria-checked={form.epayEnabled} aria-label="启用易支付收银台" onClick={() => set("epayEnabled", !form.epayEnabled)}><span/></button>
    </div>
    <label className="field"><span className="field-label">网关地址</span>
      <input className="input" value={form.epayUrl} onChange={(e) => set("epayUrl", e.target.value)} placeholder="https://pay.example.com"/>
    </label>
    <label className="field"><span className="field-label">商户 PID</span>
      <input className="input" value={form.epayPid} onChange={(e) => set("epayPid", e.target.value)} placeholder="10001"/>
    </label>
<label className="field"><span className="field-label">通道费率（%）</span>
  <input className="input" type="number" min="0" max="50" step="0.01" value={form.epayFeeRate} onChange={(e) => set("epayFeeRate", e.target.value)}/>
  <p className="field-hint">易支付按你与平台签约的费率填；<strong>没有统一公开费率</strong>，行业与渠道不同可能从 0.6% 到 3%。首次可留 0（不抽成），但这意味着<strong>你独自吃掉这层抽成</strong>——拿到首份平台账单后请回填真实值。</p></label>
      <EnvStatus name="EPAY_KEY" ok={form.epayKeyConfigured} on="已配置" off="未配置 · 开启收银台前必须设置"/>
    <div className="notice"><Info size={15}/><div>易支付是聚合收银台，一次接入即可覆盖支付宝、微信、QQ 钱包与部分 USDT 通道，省去为每家单独做原生接入。回调会先验签再核对金额，两项都通过才入账。</div></div>
    <CallbackCopy path={CALLBACK_PATHS.epay} onCopy={onCopy}/>
  </section>;
}

function BinancePanel({ form, set, onCopy }: PanelProps) {
  const state = form.channels?.binance;
  return <section className="panel">
    <div className="config-heading">
      <PaymentSymbol method="binance"/>
      <div><h2>币安支付</h2><p>Binance Pay · 加密货币</p></div>
      <button type="button" className={`switch ${form.binanceEnabled ? "on" : ""}`} role="switch" aria-checked={form.binanceEnabled} aria-label="启用币安支付" onClick={() => set("binanceEnabled", !form.binanceEnabled)}><span/></button>
    </div>
    {state && !state.ready && <div className="notice warning" style={{ marginBottom: 14 }}>
      <Info size={15}/>
      <div><strong>尚未就绪</strong><br/>缺少环境变量：<code>{state.missing.join("、") || "—"}</code>。填进服务器的 <code>.env</code> 并重启后即自动生效，无需再点开关。</div>
    </div>}
    <label className="field"><span className="field-label">商户号（Merchant ID）</span>
      <input className="input" value={form.binanceMerchantId} onChange={(e) => set("binanceMerchantId", e.target.value)} placeholder="1234567890" inputMode="numeric"/>
      <p className="field-hint">在币安商户平台获取。填在这里或环境变量 <code>BINANCE_PAY_MERCHANT_ID</code>，环境变量优先。</p>
    </label>
    <label className="field"><span className="field-label">收币种</span>
      <input className="input" value={form.binanceCurrency} onChange={(e) => set("binanceCurrency", e.target.value.toUpperCase())} placeholder="USDT" maxLength={10}/>
      <p className="field-hint">绝大多数商户选 USDT。改成其它币种前，请先在币安商户后台确认该币种对你已开通。</p>
    </label>
    <label className="field"><span className="field-label">通道费率（%）</span>
      <input className="input" type="number" min="0" max="50" step="0.01" value={form.binanceFeeRate} onChange={(e) => set("binanceFeeRate", e.target.value)}/>
      <p className="field-hint">币安 Pay 的链上手续费由币安承担，商家侧通常为 0。填 0 表示通道不抽成，不是「忘了填」。</p>
    </label>
    <EnvStatus name="BINANCE_PAY_API_KEY" ok={form.binanceKeyConfigured} on="已配置" off="未配置 · 开启前必须设置"/>
    <EnvStatus name="BINANCE_PAY_SECRET" ok={form.binanceSecretConfigured} on="已配置" off="未配置 · 开启前必须设置"/>
    <div className="notice"><Info size={15}/><div><strong>开通前提</strong><br/>币安已停止个人商户申请，需要企业主体（营业执照 + 法人实名）通过 KYB 审核；且<strong>不提供沙箱环境</strong>，只能用真实小额（0.1 USDT）验证。资金托管在币安交易所账户，非自托管。</div></div>
    <CallbackCopy path={CALLBACK_PATHS.binance} onCopy={onCopy}/>
  </section>;
}

function EpusdtPanel({ form, set, onCopy }: PanelProps) {
  const state = form.channels?.epusdt;
  return <section className="panel">
    <div className="config-heading">
      <PaymentSymbol method="epusdt"/>
      <div><h2>USDT 自建收银台</h2><p>epusdt · 自建 · 免企业资质</p></div>
      <button type="button" className={`switch ${form.epusdtEnabled ? "on" : ""}`} role="switch" aria-checked={form.epusdtEnabled} aria-label="启用自建 USDT 收银台" onClick={() => set("epusdtEnabled", !form.epusdtEnabled)}><span/></button>
    </div>
    {state && !state.ready && <div className="notice warning" style={{ marginBottom: 14 }}>
      <Info size={15}/>
      <div><strong>尚未就绪</strong><br/>缺少环境变量：<code>{state.missing.join("、") || "—"}</code>。填进服务器的 <code>.env</code> 并重启后即自动生效，无需再点开关。</div>
    </div>}
    <label className="field"><span className="field-label">收银台地址</span>
      <input className="input" value={form.epusdtUrl} onChange={(e) => set("epusdtUrl", e.target.value)} placeholder="https://pay.your-domain.com"/>
      <p className="field-hint">你自己部署的 epusdt 服务地址，<strong>结尾不要加斜杠</strong>。填在这里或环境变量 <code>EPUSDT_URL</code>，环境变量优先。</p>
    </label>
    <label className="field"><span className="field-label">收款币种与链</span>
      <input className="input" value={form.epusdtToken} onChange={(e) => set("epusdtToken", e.target.value.toLowerCase())} placeholder="usdt.trc20"/>
      <p className="field-hint">BEpusdt 用一个字段合写币种与链。常用值：<code>usdt.trc20</code>（TRON，默认）、<code>usdt.sol</code>、<code>usdc.base</code>、<code>usdt.bep20</code>。以 BEpusdt 后台「API 密钥」页可选项为准。</p>
    </label>
    <label className="field"><span className="field-label">通道费率（%）</span>
      <input className="input" type="number" min="0" max="50" step="0.01" value={form.epusdtFeeRate} onChange={(e) => set("epusdtFeeRate", e.target.value)}/>
      <p className="field-hint">自建收银台的「平台」这一层不抽成，这里填 0。真实成本是 TRC20 链上费（固定约 1 USDT），需要覆盖它就把费率按「链上费(元) ÷ 套餐价 × 100」折算，与 USDT 直充通道算法一致。</p>
    </label>
    <EnvStatus name="EPUSDT_TOKEN" ok={form.epusdtTokenConfigured} on="已配置" off="未配置 · 开启前必须设置"/>
    <div className="notice"><Info size={15}/><div><strong>为什么建议用这条通道</strong><br/>
    钱直接进你自己的钱包，<strong>不需要企业资质</strong>（币安要 KYB），也没有平台抽成；
    且每分钟推送一次「等待支付」回调，丢单时能看出订单是否还在等——本站 USDT 直充通道只能人工确认到账，这是本质差距。
    <br/><br/>注意：实际软件是 <strong>BEpusdt</strong>（<code>v03413/BEpusdt</code>），不是原始 epusdt，两者 API 完全不同。</div></div>
    <CallbackCopy path={CALLBACK_PATHS.epusdt} onCopy={onCopy}/>
  </section>;
}
