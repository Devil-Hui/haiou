// auth 模块的统一出口。
// 域外请只从 "@/lib/auth" 引用；域内用相对路径互相引用，避免经由 barrel 形成循环。

export * from "./auth";
export * from "./password";
