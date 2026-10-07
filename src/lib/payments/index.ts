// payments 模块的统一出口。
// 域外请只从 "@/lib/payments" 引用；域内用相对路径互相引用，避免经由 barrel 形成循环。
//
// 注意 binance-cert 与 gateway-api **不在此导出**：前者只在币安回调路由里用，
// 后者只在 binance.ts 内部用。放进 barrel 会让所有引用方（含浏览器可达的组件）
// 都被拖进一份带 node:crypto 依赖的传输层。

export * from "./payments";
export * from "./epay";
export * from "./types";
export * from "./mock";
export * from "./registry";
export * from "./config";
export * from "./binance";
export * from "./epusdt";
