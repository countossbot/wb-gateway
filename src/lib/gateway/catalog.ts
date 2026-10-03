// 上游模型目录元数据缓存（共享模块）—— 从 /v1/models 路由抽取，供网关路由与控制台 API 共用。
// v4.9.12-local-r9：新增 invalidateCatalogCache / catalogCacheSnapshot ——
// 控制台提供「刷新模型目录」入口（路由/提供商配置变更后立即可见，不必等 5min 新鲜期自然过期）。
//
// 目录元数据拉取策略（per provider）：
// - 模块级内存缓存：新鲜 TTL 5min；上游失败/超时时回退陈旧缓存（最长 30min），再退则无元数据
// - 超时 2.5s（目录接口不应拖慢鉴权主路径）；in-flight 去重防并发击穿
// - 仅对 type=openai / anthropic 的提供商尝试（GET {baseUrl}/models，Bearer / x-api-key）
// - 上游响应的未知字段（如真实 OpenAI 官方目录）原样不存在 → 该模型就不附元数据，语义无损
import { db } from "@/lib/db";
import { fetchWithProxy } from "@/lib/gateway/proxy/proxyAgent";

export interface UpstreamModelMeta {
  description?: string;
  context_window?: number | null;
  capabilities?: Record<string, boolean>;
}

export interface CatalogEntry {
  at: number;
  ok: boolean;
  /** 上游模型 id → 元数据（仅含至少一个扩展字段的条目） */
  meta: Map<string, UpstreamModelMeta>;
}

export const CATALOG_FRESH_MS = 5 * 60_000; // 新鲜期：直接用缓存
export const CATALOG_STALE_MS = 30 * 60_000; // 陈旧期：上游失败时可回退
const CATALOG_TIMEOUT_MS = 2_500;

// v4.9.12-local-r9：globalThis 共享存储 —— dev 模式下 Turbopack 按路由拆分模块图，
// 每个 route bundle 各有一份本模块实例（同 runtimeSettings.ts 的既知问题）。
// 把 catalogCache / catalogInflight 挂到 globalThis 上，同进程内所有模块实例
// （/v1/models 网关路由 ↔ 控制台失效 API）共享同一份状态；生产单实例模式行为零变化。
interface CatalogGlobalStore {
  __uagCatalogCache?: Map<string, CatalogEntry>;
  __uagCatalogInflight?: Map<string, Promise<CatalogEntry>>;
}
const gStore = globalThis as typeof globalThis & CatalogGlobalStore;
const catalogCache = (gStore.__uagCatalogCache ??= new Map<string, CatalogEntry>());
const catalogInflight = (gStore.__uagCatalogInflight ??= new Map<string, Promise<CatalogEntry>>());

function blankEntry(ok: boolean): CatalogEntry {
  return { at: Date.now(), ok, meta: new Map() };
}

/** 从上游目录响应条目提取扩展元数据（无任何扩展字段 → 不收录） */
function extractMeta(raw: unknown): UpstreamModelMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const meta: UpstreamModelMeta = {};
  if (typeof o.description === "string" && o.description.trim()) meta.description = o.description.trim();
  if (typeof o.context_window === "number" && Number.isFinite(o.context_window) && o.context_window > 0) {
    meta.context_window = o.context_window;
  }
  if (o.capabilities && typeof o.capabilities === "object" && !Array.isArray(o.capabilities)) {
    const caps: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o.capabilities as Record<string, unknown>)) {
      if (typeof v === "boolean") caps[k] = v;
    }
    if (Object.keys(caps).length > 0) meta.capabilities = caps;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/** 拉取单个 provider 的上游目录（带缓存 / 超时 / in-flight 去重；失败静默降级为无元数据） */
export async function loadCatalog(providerId: string): Promise<CatalogEntry> {
  const hit = catalogCache.get(providerId);
  if (hit && Date.now() - hit.at < (hit.ok ? CATALOG_FRESH_MS : CATALOG_STALE_MS / 6)) return hit;

  const existing = catalogInflight.get(providerId);
  if (existing) return existing;

  const task = (async (): Promise<CatalogEntry> => {
    try {
      const provider = await db.provider.findUnique({
        where: { id: providerId },
        select: { type: true, config: true, proxyOverride: true, enabled: true },
      });
      if (!provider || !provider.enabled) throw new Error("provider missing/disabled");
      const cfg = (provider.config as Record<string, unknown>) || {};
      let url: string;
      let headers: Record<string, string>;
      switch (provider.type) {
        case "openai": {
          url = `${String(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/models`;
          headers = { Accept: "application/json", Authorization: `Bearer ${String(cfg.apiKey || "")}` };
          break;
        }
        case "anthropic": {
          url = `${String(cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/models`;
          headers = {
            Accept: "application/json",
            "x-api-key": String(cfg.apiKey || ""),
            "anthropic-version": String(cfg.anthropicVersion || "2023-06-01"),
          };
          break;
        }
        default:
          throw new Error(`type ${provider.type} 无目录端点`);
      }
      const resp = await fetchWithProxy(
        url,
        { headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) },
        { providerId, providerOverride: provider.proxyOverride ?? undefined }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json().catch(() => ({}))) as {
        data?: Array<Record<string, unknown>>;
        models?: Array<Record<string, unknown>>;
      };
      const meta = new Map<string, UpstreamModelMeta>();
      for (const item of json.data || json.models || []) {
        if (typeof item?.id !== "string") continue;
        const m = extractMeta(item);
        if (m) meta.set(item.id, m);
      }
      const entry: CatalogEntry = { at: Date.now(), ok: true, meta };
      catalogCache.set(providerId, entry);
      return entry;
    } catch {
      // 上游失败：优先回退陈旧成功缓存（最长 30min），否则记一次短暂负缓存（30s）防抖
      const stale = catalogCache.get(providerId);
      const fallback = stale && stale.ok && Date.now() - stale.at < CATALOG_STALE_MS ? stale : blankEntry(false);
      catalogCache.set(providerId, fallback.ok ? fallback : fallback);
      return fallback;
    } finally {
      catalogInflight.delete(providerId);
    }
  })();

  catalogInflight.set(providerId, task);
  return task;
}

/** 手动失效目录缓存（v4.9.12-local-r9）。
 * @param providerId 省略时清空全部；in-flight 请求不受影响（完成后结果写入缓存属正常竞态，下次失效即可）。
 * @returns 清除的缓存条目数
 */
export function invalidateCatalogCache(providerId?: string): number {
  if (providerId) {
    return catalogCache.delete(providerId) ? 1 : 0;
  }
  const n = catalogCache.size;
  catalogCache.clear();
  return n;
}

/** 目录缓存快照（控制台观测用；per provider：是否成功 / 缓存年龄秒 / 收录元数据的模型数） */
export function catalogCacheSnapshot(): Array<{ providerId: string; ok: boolean; ageSec: number; metaModels: number }> {
  const now = Date.now();
  return Array.from(catalogCache.entries())
    .map(([providerId, e]) => ({
      providerId,
      ok: e.ok,
      ageSec: Math.max(0, Math.round((now - e.at) / 1000)),
      metaModels: e.meta.size,
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}
