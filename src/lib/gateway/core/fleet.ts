// Provider Fleet —— 提供商实例池（单例复用、余额短缓存、批量任务）。
import { createProvider } from "../providers/index";
import { hasGetBalance, hasOnSchedule, hasDailyCheckin, hasTokenRefresh } from "./contract";
import { BoundedMap } from "./boundedMap";
import type { GatewayConfig, ProviderAdapter, BalanceResult } from "./types";

// 余额短缓存：providerId -> { at, value }（进程级，与 fleet 同生命周期语义）
// v3.9.3：BoundedMap 有界化（上限 1000；providerId 为有限配置集合，正常业务永不触顶，驱逐直接丢弃）
const balanceCache = new BoundedMap<string, { at: number; value: BalanceResult }>({ maxEntries: 1000 });
const BALANCE_TTL_MS = 60 * 1000;
const BALANCE_ERROR_TTL_MS = 10 * 1000;

export class ProviderFleet {
  config: GatewayConfig;
  private instances = new Map<string, ProviderAdapter>();

  constructor(config: GatewayConfig) {
    this.config = config;

    const providerConfigs = config.providers || [];
    for (const pConf of providerConfigs) {
      if (pConf.enabled !== false) {
        const instance = createProvider(pConf);
        if (instance) {
          this.instances.set(pConf.id, instance);
        }
      }
    }
  }

  getProvider(id: string): ProviderAdapter | null {
    return this.instances.get(id) || null;
  }

  getAllActive(): ProviderAdapter[] {
    return Array.from(this.instances.values());
  }

  get activeCount(): number {
    return this.instances.size;
  }

  // 统一余额查询（短 TTL 缓存：/v1/usage 被 CC-Switch 高频轮询，/admin/api/status 被控制台轮询，
  // 每次都打上游等于拿用户配额做心跳。成功 60s / 失败 10s；仅展示用途，路由与鉴权不受影响）
  async getBalance(targetId: string | null = null): Promise<BalanceResult> {
    const providerId = targetId || this.config.usage_provider_id || "workbuddy";
    const now = Date.now();
    const hit = balanceCache.get(providerId);
    if (hit && now - hit.at < (hit.value.success ? BALANCE_TTL_MS : BALANCE_ERROR_TTL_MS)) {
      return hit.value;
    }
    const provider = this.getProvider(providerId);
    if (!provider || !hasGetBalance(provider)) {
      // v4.1.2 修复：无提供商/无余额能力时 accounts_count 明确为 0 —— 此前缺字段时
      // /admin/api/status 的 `|| 1` 兑底会把空库误报为「1 个账号」，与 accounts: [] 矛盾
      return { success: false, balance: 0, total: 0, unit: "积分", accounts_count: 0, accounts: [] };
    }
    try {
      const res = await provider.getBalance();
      const value: BalanceResult = {
        success: !!res.success,
        balance: res.balance ?? 0,
        total: res.total ?? 0,
        unit: res.unit || "积分",
        accounts_count: res.accounts_count || 1,
        accounts: res.accounts || [],
        ...(res.extra ? { extra: res.extra } : {}),
      };
      balanceCache.set(providerId, { at: now, value });
      return value;
    } catch (e) {
      const value: BalanceResult = {
        success: false,
        balance: 0,
        total: 0,
        unit: "积分",
        accounts_count: 0,
        accounts: [],
        error: (e as Error).message,
      };
      balanceCache.set(providerId, { at: now, value });
      return value;
    }
  }

  // 批量触发定时调度（保活与签到）
  async runScheduledTasks(): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    for (const provider of this.getAllActive()) {
      if (hasOnSchedule(provider)) {
        tasks.push(
          provider.onSchedule().catch((err) =>
            console.error(`[Fleet] Scheduled task failed for ${provider.id}:`, err)
          )
        );
      }
    }
    await Promise.allSettled(tasks);
  }

  // 批量执行签到（v4.1.0：only 传非空数组时只对白名单内提供商签到；仍要求 hasDailyCheckin 能力探针通过）
  async runDailyCheckins(only?: string[]): Promise<Array<{ provider: string; res?: unknown; error?: string }>> {
    const results: Array<{ provider: string; res?: unknown; error?: string }> = [];
    const scope = Array.isArray(only) && only.length > 0 ? new Set(only) : null;
    for (const provider of this.getAllActive()) {
      if (scope && !scope.has(provider.id)) continue;
      if (hasDailyCheckin(provider)) {
        try {
          const res = await provider.doDailyCheckin();
          results.push({ provider: provider.id, res });
        } catch (e) {
          results.push({ provider: provider.id, error: (e as Error).message });
        }
      }
    }
    return results;
  }

  // 批量刷新 Token
  async refreshAllTokens(): Promise<Array<{ provider: string; refreshed: boolean; count?: number; error?: string }>> {
    const results: Array<{ provider: string; refreshed: boolean; count?: number; error?: string }> = [];
    for (const provider of this.getAllActive()) {
      if (hasTokenRefresh(provider)) {
        try {
          const res = await provider.refreshAccessToken();
          const refreshed = Array.isArray(res) ? res.length > 0 : !!res;
          results.push({
            provider: provider.id,
            refreshed,
            count: Array.isArray(res) ? res.length : 1,
          });
        } catch (e) {
          results.push({ provider: provider.id, refreshed: false, error: (e as Error).message });
        }
      }
    }
    return results;
  }
}

let cachedFleet: ProviderFleet | null = null;
let cachedFleetConfigRef: GatewayConfig | null = null;
let cachedFleetVersion: number | undefined = undefined;

// 单例获取 Fleet，复用 Provider 实例减少无谓的对象重新分配。
// 判等优先用 config_version：getConfig 每次刷新会产生新对象（内容不变），
// 按引用判等会导致 provider 实例每分钟重建一次（含各 adapter 构造开销）。
// saveConfig 每次写入必 bump 版本，所以版本号相等即配置未变；无版本号时回退引用判等。
export function getProviderFleet(config: GatewayConfig): ProviderFleet {
  const version = config?.config_version;
  const same =
    cachedFleet &&
    (version !== undefined
      ? cachedFleetVersion === version
      : cachedFleetConfigRef === config);
  if (same) {
    return cachedFleet as ProviderFleet;
  }
  cachedFleet = new ProviderFleet(config);
  cachedFleetConfigRef = config;
  cachedFleetVersion = version;
  return cachedFleet;
}

// 余额缓存失效（签到/手动刷新后由管理端调用，让下一次余额查询穿透到上游）
export function invalidateBalanceCache(): void {
  balanceCache.clear();
}

// 测试隔离
export function resetFleetForTest(): void {
  cachedFleet = null;
  cachedFleetConfigRef = null;
  cachedFleetVersion = undefined;
  balanceCache.clear();
}
