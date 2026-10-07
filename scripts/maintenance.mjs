import "dotenv/config";

// 到期数据清理（订单过期 + 凭证抹除）。
//
// 两件事放在同一个任务里，因为它们是同一类问题的两面：
//   · 订单到期待关闭 —— 否则「待支付」列表越积越多，运营无法判断真实在跑的量。
//   · 凭证到期必抹除 —— schema 的设计承诺是「处理完成或超时后由清理任务抹掉」，
//     但这个任务此前根本不存在，导致买家的账号凭证（密文）一直留在库里。
//     凭证是最高敏感级的数据，承诺了自动抹除却没实现，等于给了攻击者更长的窗口。
//
// 分开跑没有意义：两者都是「到点即清」，且都要按批处理避免长时间持锁。
// 退出码：0 成功；1 失败（供调度器/cron 判定是否告警）。

try {
  const { runExpirySweep } = await import("../src/lib/orders/expiry.ts");
  const { purgeExpiredCredentials, sweepStalledRechargeJobs } = await import("../src/lib/recharge/recharge.ts");

  const orders = await runExpirySweep();
  const purged = await purgeExpiredCredentials();
  // 充值任务推进。此前 advanceJob 的唯一触发点是买家轮询与管理员手动点，
  // 意味着买家一关页面，任务就永久停在 validating/confirmed，timed_out 这个
  // 专门设计的"不知道结果"终态在生产上永远不会出现，上游订单也无人管。
  const advanced = await sweepStalledRechargeJobs();

  const log = (event, fields) =>
    console.log(
      `${new Date().toISOString()} level=info category=app event=${event} ` +
      Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" "),
    );
  log("order.expiry_sweep", { scanned: orders.scanned, expired: orders.expired });
  log("recharge.job_sweep", { advanced: advanced.advanced, timedOut: advanced.timedOut, failed: advanced.failed });
  if (purged > 0) log("recharge.credentials_purged", { count: purged });
  process.exit(0);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`${new Date().toISOString()} level=error category=app event=maintenance_failed err=${msg}`);
  process.exit(1);
}
