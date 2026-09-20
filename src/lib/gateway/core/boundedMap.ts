// v3.9.3：有界 Map —— LRU 驱逐 + 可选 TTL，防无上限内存增长（打爆场景：扫描攻击、
// 动态代理池、外部 providerId 枚举等）。全仓无上限 Map 的统一治理点。
//
// 设计：
//   - 继承 Map，调用方零迁移成本（set/get/delete/has/forEach 全兼容）
//   - LRU：set 重插到尾部（最新），get 触摸重排；容量超限从头部驱逐（最久未用）
//   - TTL（可选）：记录条目最后活跃时刻；sweep() 惰性清除过期条目（调用方在低频
//     路径顺带调用，如登录失败计数每次失败时清扫一次），避免模块级 setInterval 泄漏
//   - onEvict 钩子：驱逐/清扫时回调（dispatcherCache 用它 close() 连接池，防泄漏）
//     clear() 同样触发 onEvict（invalidateProxyDispatchers 语义保持）
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly maxEntries: number;
  private readonly ttlMs: number | null;
  private readonly onEvict: ((key: K, value: V) => void) | null;
  // 条目最后活跃时刻（仅 ttlMs 启用时维护；与 Map 条目同键空间）
  private readonly lastAccess: Map<K, number> | null;

  constructor(options?: {
    maxEntries?: number;
    ttlMs?: number | null;
    onEvict?: ((key: K, value: V) => void) | null;
  }) {
    super();
    this.maxEntries = Math.max(1, options?.maxEntries ?? 1000);
    this.ttlMs = options?.ttlMs ?? null;
    this.onEvict = options?.onEvict ?? null;
    this.lastAccess = this.ttlMs ? new Map<K, number>() : null;
  }

  /** LRU + TTL 检查；驱逐时回调 onEvict（连接池 close 等资源释放语义） */
  private evictToLimit(): void {
    // 头部最旧优先驱逐（Map 保持插入序，get/set 触摸会移到尾部）
    while (this.size > this.maxEntries) {
      const oldestKey = super.keys().next().value as K | undefined;
      if (oldestKey === undefined) break;
      const value = super.get(oldestKey) as V;
      super.delete(oldestKey);
      this.lastAccess?.delete(oldestKey);
      try {
        this.onEvict?.(oldestKey, value);
      } catch {
        /* onEvict 失败不影响驱逐（资源兜底由调用方语义保证） */
      }
    }
  }

  set(key: K, value: V): this {
    if (super.has(key)) super.delete(key); // 重插 = 触摸到尾部（LRU）
    super.set(key, value);
    this.lastAccess?.set(key, Date.now());
    this.evictToLimit();
    return this;
  }

  get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key) as V;
    // LRU 触摸：移到尾部
    super.delete(key);
    super.set(key, value);
    this.lastAccess?.set(key, Date.now());
    return value;
  }

  has(key: K): boolean {
    return super.has(key);
  }

  delete(key: K): boolean {
    this.lastAccess?.delete(key);
    return super.delete(key);
  }

  clear(): void {
    if (this.onEvict) {
      for (const [k, v] of this) {
        try {
          this.onEvict?.(k, v);
        } catch {
          /* noop */
        }
      }
    }
    this.lastAccess?.clear();
    super.clear();
  }

  /**
   * TTL 惰性清扫：删除超过 ttlMs 未活跃的条目（onEvict 触发）。
   * 由调用方在低频路径顺带调用（如登录失败计数），避免模块级定时器。
   * 返回清除的条目数。
   */
  sweep(now = Date.now()): number {
    if (!this.ttlMs || !this.lastAccess) return 0;
    const expired: K[] = [];
    for (const [k, at] of this.lastAccess) {
      if (now - at > this.ttlMs) expired.push(k);
    }
    for (const k of expired) {
      const value = super.get(k) as V;
      super.delete(k);
      this.lastAccess.delete(k);
      try {
        this.onEvict?.(k, value);
      } catch {
        /* noop */
      }
    }
    return expired.length;
  }
}
