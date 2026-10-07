// catalog 模块的统一出口。
// 域外请只从 "@/lib/catalog" 引用；域内用相对路径互相引用，避免经由 barrel 形成循环。

export * from "./catalog";
export * from "./pricing";
export * from "./store";
// 订单归属判定（购买邮箱 vs 激活邮箱）与其分页列表。
// 登录用户与访客共用同一口径，必须从这里统一导出，避免两处各写一遍。
export * from "./order-owner";
export * from "./user-orders";
