// 进程内只读缓存（read-through TTL）。
//
// 用途：本站「读多写极少」的配置（套餐目录、支付设置）几乎在每次页面渲染都被读取，
// 而它们只在管理员编辑时变化。把它们缓存在进程内的 Map 里，能显著减少回查 PostgreSQL
// 的次数——这对 2C4G 的单实例部署尤其划算：既降低了数据库压力，又不必引入 Redis
// 这类会额外吃掉本就有限内存的中间件。
//
// 失效策略：写操作显式清除对应键 + 兜底 TTL 双保险。任一触发即视为过期，不会长期脏读。
// 单实例前提下进程内 Map 足够；一旦扩展到多实例，登录退避与限流也要迁出进程内存，
// 那时本缓存应替换为集中式缓存（如 Redis），否则各实例会读到不同的旧配置。

type Entry = { value: unknown; expires: number };

const store = new Map<string, Entry>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

export function cacheDeleteByPrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

// ---- 套餐缓存的失效约定 ----
// 放在这里而不是 store.ts，是为了让**数据层自己**能在写入后清缓存。
// 之前失效只写在路由里，任何绕过路由的调用（脚本、后台补发、将来的 worker）
// 都会漏掉失效，导致前台库存显示过期——隐蔽且难查。
// cache.ts 不依赖任何业务模块，因此 cdk.ts 等数据层可放心引用，不构成循环依赖。
export function invalidatePlansCache(): void {
  cacheDeleteByPrefix("plans:");
}
