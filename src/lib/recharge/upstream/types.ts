import type { UpstreamConfig } from "@/db/schema";

// ---------------------------------------------------------------------------
// 上游适配器契约
//
// 为什么要抽象一层：真实上游（易支付类卡密站 / 官方接口）的字段名各不相同，
// 而本站的订单状态机不该被它们牵动。适配器把差异全部收敛在这一层，
// 上游换一家只改适配器，不动订单逻辑。
//
// 契约里的每个方法都只做一件事，编排（何时调用、失败怎么办）交给 recharge.ts。
// ---------------------------------------------------------------------------

/** 上游统一返回的状态。刻意做窄：只保留本站需要区分的几种。 */
export type UpstreamState =
  | "accepted"      // 已受理，开始处理
  | "processing"    // 处理中
  | "succeeded"     // 成功
  | "failed"        // 失败（原因见 message）
  | "not_found";    // 上游查不到该单

export type UpstreamValidateResult = {
  ok: boolean;
  /** 失败时给买家看的简短原因（不含上游内部细节） */
  reason?: string;
  /** 上游侧的卡密/凭证明文，由本站持有并转交，**不会**返回给前端 */
  secret?: string;
  /** 上游套餐标识，提交时要带回 */
  sku?: string;
  /** 可选的面值，用于展示"可用余额"等 */
  faceValue?: number;
};

export type UpstreamSubmitResult = {
  ok: boolean;
  reason?: string;
  /** 上游单号：只入库、只在后台可见 */
  upstreamOrder?: string;
  /** 绑定标识：用于对账，只入库 */
  binding?: string;
};

export type UpstreamQueryResult = {
  state: UpstreamState;
  /** 脱敏后的进度说明，可直接展示给买家 */
  message?: string;
  /** 上游返回的最终结果说明，需先过一遍脱敏 */
  detail?: string;
};

export interface UpstreamAdapter {
  readonly name: string;
  /** 校验买家提交的凭证/兑换码是否可用。不占用。 */
  validate(input: { credential: string; planId: string; email: string }): Promise<UpstreamValidateResult>;
  /** 提交充值任务。真实实现需带上幂等键，避免上游重复扣卡。 */
  submit(input: {
    credential: string;
    planId: string;
    email: string;
    sku?: string;
    /** 幂等键：用本站订单号。上游若不支持，适配器内部自行处理去重。 */
    idempotencyKey: string;
    /** 校验阶段拿到的可用兑换凭据。校验与提交分两步时用它，避免把买家原始凭证再传一次。 */
    secret?: string;
  }): Promise<UpstreamSubmitResult>;
  /** 查询进度。 */
  query(input: { upstreamOrder: string; binding?: string }): Promise<UpstreamQueryResult>;
  /** 放弃/退款。失败且不可重试时调用。 */
  release?(input: { upstreamOrder: string; binding?: string; reason: string }): Promise<boolean>;
}

// ---- 内部辅助：把配置转成适配器需要的最小形态，避免适配器直接依赖 db ----
export type UpstreamSettings = Pick<
  UpstreamConfig,
  "provider" | "baseUrl" | "appId" | "timeoutSeconds" | "pollIntervalSeconds"
>;

/**
 * 可选上游类型。集中在这里，后台接口、前端下拉与工厂装配共用一份。
 * 新增一家上游必须同时改这三处，否则会出现"后台能选但工厂不认"——
 * 表现为保存成功却一直走 mock，而没有任何报错。
 */
export const UPSTREAM_PROVIDERS = ["mock", "http", "aisub"] as const;
export type UpstreamProvider = (typeof UPSTREAM_PROVIDERS)[number];
