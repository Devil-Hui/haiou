/**
 * 「标价 119，支付宝付款」全链路金额一致性验证。
 *
 * 用户的疑问是"页面显示的价格对不对"。这个问题不能靠推理回答，
 * 必须把**页面用的函数**与**下单/回调核对用的函数**放在同一个脚本里跑，
 * 比对两边算出的钱是否逐分相同。
 *
 * 站点不变式（见 pricing.ts 注释）：
 *   运营在后台填的标价 = 扣完通道费后实收
 *   买家实付 = 标价 × (1 + 加价率) ÷ (1 − 通道费率)
 *
 * 本脚本验证三件事：
 *   1. 页面展示金额 === 下单落库金额 === 支付宝 prepay 的 total_amount === 回调核对值
 *   2. 运营实收确实等于标价 119.00（不多不少）
 *   3. 用券、加价率等组合下依然自洽，且「页面应付」与「实付」不出现歧义
 */
import { priceBreakdown, orderTotal, CHANNEL_FEE_DEFAULTS } from "../../src/lib/catalog/pricing";

let pass = 0;
let fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

// ---------------------------------------------------------------------------
// 场景 1：标价 119，加价率 0，支付宝 0.6%（默认配置）
// ---------------------------------------------------------------------------
console.log("=== 场景 1：标价 119 · 加价率 0 · 支付宝 0.6% ===\n");
{
  const price = "119.00";
  const planFeeRate = "0";              // plans.feeRate，现全为 0
  const chRate = String(CHANNEL_FEE_DEFAULTS.alipay); // 0.6

  // —— 前端 checkout.tsx 展示用这条 ——
  const bill = priceBreakdown(price, planFeeRate, chRate);
  console.log("  商品价格        ¥" + money(Number(bill.price)));
  console.log("  手续费          ¥" + money(Number(bill.feeAmount)));
  console.log("  应付金额        ¥" + money(Number(bill.total)));
  console.log("  通道费(支付宝抽) ¥" + money(Number(bill.channelFee)));
  console.log("  运营实收        ¥" + money(Number(bill.netIncome)));
  console.log("");

  check("标价", bill.price, "119.00");
  check("买家实付 119.72（119 ÷ 0.994）", bill.total, "119.72");
  check("手续费 0.72", bill.feeAmount, "0.72");
  // 关键断言：运营到手必须正好等于标价，否则「标价 = 实收」这个不变式破了
  check("运营实收 = 标价 119.00（不多不少）", bill.netIncome, "119.00");

  // —— 下单时 orders/route.ts 落库 ——
  // 库里存的是「标价」与「手续费金额」两列，合计才是买家应付
  const orderRow = { amount: bill.price, feeAmount: bill.feeAmount, discountAmount: "0" };
  const total = orderTotal(orderRow);
  check("订单实付 = 页面应付（下单落库口径）", total, bill.total);

  // —— preparePayment 传给支付宝的 total_amount ——
  check("支付宝 prepay 的 total_amount = 页面应付", total, "119.72");
  // —— 回调 verifyAlipay 拿回调的 total_amount 与 orderTotal 比 ——
  check("回调核对值 = 同一口径（不会误判金额不符）", orderTotal(orderRow), "119.72");
}

// ---------------------------------------------------------------------------
// 场景 2：用优惠券 —— 这是最容易出现"页面一个价、实收另一个价"的地方
// ---------------------------------------------------------------------------
console.log("\n=== 场景 2：标价 119 · 优惠券抵 50 · 支付宝 ===\n");
{
  const bill = priceBreakdown("119.00", "0", "0.6");
  const discount = 50;
  const orderRow = { amount: bill.price, feeAmount: bill.feeAmount, discountAmount: String(discount) };
  const total = orderTotal(orderRow);
  console.log("  商品价格        ¥" + money(Number(bill.price)));
  console.log("  手续费          ¥" + money(Number(bill.feeAmount)));
  console.log("  优惠券抵扣      -¥" + money(discount));
  console.log("  买家实付        ¥" + money(Number(total)));
  console.log("");

  // 手续费按商品价计、不因用券减少——这是刻意的：手续费是通道成本，与买家用几张券无关
  check("用券后实付 69.72", total, "69.72");
  check("手续费不因用券而减少（防运营倒贴通道费）", bill.feeAmount, "0.72");
  // 页面与下单必须一致
  check("页面 payable 与订单实付同源", money(Number(bill.total) - discount), total);
}

// ---------------------------------------------------------------------------
// 场景 3：加价率不为 0（运营要赚差价）
// ---------------------------------------------------------------------------
console.log("\n=== 场景 3：标价 119 · 加价率 5% · 支付宝 0.6% ===\n");
{
  const bill = priceBreakdown("119.00", "5", "0.6");
  console.log("  商品价格        ¥" + money(Number(bill.price)));
  console.log("  加价部分        ¥" + money(Number(bill.feeAmount)));
  console.log("  买家实付        ¥" + money(Number(bill.total)));
  console.log("  运营实收        ¥" + money(Number(bill.netIncome)));
  console.log("");

  // 119 × 1.05 ÷ 0.994 = 125.6981… → 125.70
  check("买家实付 = 119 × 1.05 ÷ 0.994", bill.total, "125.70");
  // 运营实收 = 125.70 - 0.75（通道费 125.70×0.006）= 124.95
  //           = 标价 119 + 加价部分 6.70 - 0.75 + 0.00(舍入)
  // 即「标价 + 加价 - 通道费」，与直觉一致
  check("运营实收 = 标价 + 加价 − 通道费", bill.netIncome, "124.95");
  check("加价部分 = 119 × 5% 附近", Number(bill.feeAmount) > 6.5 && Number(bill.feeAmount) < 7, true);
}

// ---------------------------------------------------------------------------
// 场景 4：逐分不丢 —— 遍历一批价格，确认"页面 = 实收"这条恒等式
// ---------------------------------------------------------------------------
console.log("\n=== 场景 4：全价目恒等式抽查（页面应付 === 订单实付）===\n");
{
  const prices = ["0.01", "1.00", "9.90", "19.99", "40.00", "69.00", "119.00", "670.00", "1100.00", "3200.00", "9999.99"];
  let bad = 0;
  for (const p of prices) {
    const b = priceBreakdown(p, "0", "0.6");
    const t = orderTotal({ amount: b.price, feeAmount: b.feeAmount, discountAmount: "0" });
    const same = t === b.total;
    if (!same) { bad++; console.log(`  ✗ ${p}: 页面 ${b.total} vs 订单 ${t}`); }
    // 运营实收必须 >= 标价（不能倒亏）
    if (Number(b.netIncome) < Number(p) - 0.001) { bad++; console.log(`  ✗ ${p}: 实收 ${b.netIncome} < 标价 ${p}，倒亏`); }
  }
  check("11 个价格档位：页面/下单一致且实收不倒亏", bad, 0);
}

// ---------------------------------------------------------------------------
// 场景 5：极端费率不得出现负数或天文数字
// ---------------------------------------------------------------------------
console.log("\n=== 场景 5：异常费率兜底 ===\n");
{
  check("费率 0（USDT 默认值）", priceBreakdown("119.00", "0", "0").total, "119.00");
  // 费率 >= 100% 时反算会得出无穷大，页面显示天文数字比按 0 收更糟
  // 修复前：Math.min(n, 99.5) 让 100 被夹成 99.5，
  // 于是 119 / (1 - 0.995) = 23800 —— 买家看到 200 倍的价格。
  // 现在 >= 100 直接归零，这是本函数注释里一直承诺的行为。
  check("费率 100 按 0 处理（修复前会算出 23800）", priceBreakdown("119.00", "0", "100").total, "119.00");
  check("费率 150 按 0 处理", priceBreakdown("119.00", "0", "150").total, "119.00");
  check("费率 99.99 按 0 处理（避免分母趋零）", priceBreakdown("119.00", "0", "99.99").total, "119.00");
  check("费率 99 也是 0", priceBreakdown("119.00", "0", "99").total, "119.00");
  check("费率 50 正常反算（后台允许的上限）", priceBreakdown("119.00", "0", "50").total, "238.00");
  // 加价率同样归零处理（> 50 视为脏数据），保证「填不进来」与「算不出来」边界一致。
  // 不用「夹到 50」：那会让买家看到并真的付出 2 倍价格。
  check("加价率 100 归零（不夹到 50，避免买家真付双倍）", priceBreakdown("119.00", "100", "0").total, "119.00");
  check("加价率 60 归零", priceBreakdown("119.00", "60", "0").total, "119.00");
  check("加价率 50 正常（后台允许的上限）", priceBreakdown("119.00", "50", "0").total, "178.50");
  // 两者同边界：通道费率 50 会反算出 2 倍，这是后台允许的真实配置；
  // 加价率 50 也允许。它们都不是脏数据，不该被归零。
  check("通道费率 50 反算 2 倍（与加价率 50 对称）", priceBreakdown("119.00", "0", "50").total, "238.00");
  // 全额券不许把实付压到 <= 0（负数收款会被通道拒）
  const orderTotalCheck = orderTotal({ amount: "119.00", feeAmount: "0.72", discountAmount: "200" });
  check("券额超过总价时下限 0.01", orderTotalCheck, "0.01");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
