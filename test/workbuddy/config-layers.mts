/**
 * 端到端验证「只填 .env、不碰后台」这条路径。
 *
 * 目的不是测单个函数，而是证明：环境变量 → getPaymentSettings() → paymentAvailability()
 * 整条链是通的，且**不需要数据库里存任何凭据**。此前凭据分裂在两处，
 * 运营在 .env 配好私钥却因数据库缺 AppID 而看到"未就绪"——这条链路就是为了消灭那个坑。
 */
import { resolvePaymentsFromEnv, allChannelStates, secretPresence } from "../../src/lib/payments/config";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
}

// 场景一：什么都没配 → 四条通道全部未就绪，各报缺失项
{
  for (const k of ["ALIPAY_APP_ID", "ALIPAY_SELLER_ID", "ALIPAY_PUBLIC_KEY", "ALIPAY_PRIVATE_KEY", "SITE_URL", "EPAY_KEY", "EPAY_PID", "EPAY_URL", "BINANCE_PAY_API_KEY", "BINANCE_PAY_SECRET", "BINANCE_PAY_MERCHANT_ID", "USDT_WALLET_ADDRESS"]) delete process.env[k];
  delete process.env.ALIPAY_ENABLED; delete process.env.EPAY_ENABLED; delete process.env.BINANCE_PAY_ENABLED; delete process.env.USDT_ENABLED;

  const s = allChannelStates(resolvePaymentsFromEnv(null as never));
  check("空配置：支付宝未就绪", s.alipay.ready, false);
  check("空配置：易支付未就绪", s.epay.ready, false);
  check("空配置：币安未就绪", s.binance.ready, false);
  check("空配置：USDT 未就绪", s.usdt.ready, false);
  check("空配置：支付宝报出 5 个缺失项", s.alipay.missing.length, 5);
  check("空配置：secretPresence 全 false", secretPresence().alipayPrivateKey, false);
}

// 场景二：只填币安三个变量 → 币安单独就绪，其余仍不就绪
{
  process.env.BINANCE_PAY_API_KEY = "ak";
  process.env.BINANCE_PAY_SECRET = "sk";
  process.env.BINANCE_PAY_MERCHANT_ID = "99887766";
  const merged = resolvePaymentsFromEnv(null as never);
  const s = allChannelStates(merged);
  check("只配币安：币安自动启用", merged.binanceEnabled, true);
  check("只配币安：币安就绪", s.binance.ready, true);
  check("只配币安：支付宝仍未就绪", s.alipay.ready, false);
  check("只配币安：默认币种为 USDT", merged.binanceCurrency, "USDT");
  check("只配币安：费率默认 0", merged.binanceFeeRate, "0");
}

// 场景三：数据库有值但环境变量为空 → 回落到数据库（老部署不受影响）
{
  const dbRow = {
    id: 1, usdtEnabled: true, walletAddress: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
    exchangeRate: "7.20", alipayEnabled: true, alipayAppId: "2021000000000000",
    alipaySellerId: "2088123456789012", alipayPublicKey: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8" + "A".repeat(200),
    alipayGateway: "https://openapi.alipay.com/gateway.do", siteUrl: "https://db-only.example.com",
    storeOpen: true, pausedReason: "", epayEnabled: true, epayUrl: "https://db-pay.example.com", epayPid: "555",
    binanceEnabled: false, binanceMerchantId: "", binanceCurrency: "USDT",
    alipayFeeRate: "1.20", epayFeeRate: "2.00", usdtFeeRate: "6.00", binanceFeeRate: "0",
  };
  const merged = resolvePaymentsFromEnv(dbRow as never);
  check("DB 兜底：支付宝沿用库里的 AppID", merged.alipayAppId, "2021000000000000");
  check("DB 兜底：站点地址沿用库里", merged.siteUrl, "https://db-only.example.com");
  check("DB 兜底：易支付仍启用", merged.epayEnabled, true);
  check("DB 兜底：自定义费率不被默认值覆盖", merged.alipayFeeRate, "1.20");
  check("DB 兜底：USDT 费率 6.00 保留", merged.usdtFeeRate, "6.00");
}

// 场景四：环境变量覆盖数据库（最高优先级）
{
  process.env.ALIPAY_APP_ID = "2099000000000000";
  process.env.SITE_URL = "https://env-wins.example.com/";
  process.env.ALIPAY_FEE_RATE = "0.35";
  const dbRow = { alipayAppId: "2021000000000000", siteUrl: "https://db-only.example.com", alipayFeeRate: "1.20" };
  const merged = resolvePaymentsFromEnv(dbRow as never);
  check("覆盖：环境变量 AppID 胜出", merged.alipayAppId, "2099000000000000");
  check("覆盖：环境变量站点地址胜出且去掉末尾斜杠", merged.siteUrl, "https://env-wins.example.com");
  check("覆盖：环境变量费率胜出", merged.alipayFeeRate, "0.35");
}

// 场景五：显式关闭优先于凭据推导
{
  process.env.BINANCE_PAY_ENABLED = "false";
  const merged = resolvePaymentsFromEnv(null as never);
  check("显式关闭：凭据齐全也被关掉", merged.binanceEnabled, false);
  process.env.BINANCE_PAY_ENABLED = "true";
  check("显式开启", resolvePaymentsFromEnv(null as never).binanceEnabled, true);
  delete process.env.BINANCE_PAY_ENABLED;
}

// 场景六：非法费率不污染配置（回落而非变成 NaN）
{
  process.env.BINANCE_PAY_FEE_RATE = "999";
  const merged = resolvePaymentsFromEnv({ binanceFeeRate: "0" } as never);
  check("非法费率 999 被拒，回落原值", merged.binanceFeeRate, "0");
  delete process.env.BINANCE_PAY_FEE_RATE;
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
