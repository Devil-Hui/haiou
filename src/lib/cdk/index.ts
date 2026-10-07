// cdk 模块的统一出口。
// 域外请只从 "@/lib/cdk" 引用；域内用相对路径互相引用，避免经由 barrel 形成循环。

export * from "./cdk";
