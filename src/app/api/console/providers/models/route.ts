// GET /api/console/providers/models?providerId=xxx[&refresh=1] —— 上游模型目录（供路由候选下拉实时选择）。
// 拉取策略按提供商类型：
// - openai      ：GET {baseUrl}/models（Bearer）→ 上游实时（source: "upstream"）
// - anthropic   ：GET {baseUrl}/models（x-api-key + anthropic-version）→ 上游实时
// - workbuddy   ：GET /v3/config 实时拉取（CN www.workbuddy.ai / INTL copilot.tencent.com，
//                 CLI 凭证 Bearer；失败如实报错，不降级内置预设）
// 上游拉取失败 / 超时（8s）→ 返回错误响应（不再降级内置目录）。
// 内存缓存 60s（refresh=1 强制穿透）——表单反复打开不重复打上游。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { fetchWithProxy } from "@/lib/gateway/proxy/proxyAgent";
import { WorkBuddyProvider } from "@/lib/gateway/providers/workbuddy";
import type { UpstreamModelDetail } from "@/lib/gateway/core/types";

export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;

interface ModelsPayload {
  providerId: string;
  source: "upstream";
  models: string[];
  /** v4.7.1：与 models 一一对应的元数据（workbuddy 上游响应；其他类型缺省） */
  details?: UpstreamModelDetail[];
  /** 上游全量模型数（含 CLI 白名单外旧模型），仅与 modelsCount 不同时有意义 */
  allCount?: number;
  modelsCount: number;
  fetchedAt: number;
  cached: boolean;
  upstreamUrl?: string;
}

// providerId → { payload, at }
const cache = new Map<string, { payload: ModelsPayload; at: number }>();

// ---- 不支持上游目录的类型：明确失败（不再回退内置预设） ----
// v4.8.x：模型目录只来自上游实时拉取；内置 DEFAULT_ROUTES 预设不再作为下拉数据源。
function unsupportedType(type: string): never {
  throw new Error(`provider type "${type}" 无上游模型目录端点（模型列表仅来自实时拉取）`);
}

// ---- 上游实时拉取（openai / anthropic） ----
async function fetchUpstreamModels(
  type: string,
  cfg: Record<string, unknown>,
  providerId: string,
  proxyOverride: string | null
): Promise<{ models: string[]; url: string }> {
  let url: string;
  let headers: Record<string, string> = { Accept: "application/json" };
  switch (type) {
    case "openai": {
      url = `${((cfg.baseUrl as string) || "https://api.openai.com/v1").replace(/\/$/, "")}/models`;
      headers = {
        ...headers,
        Authorization: `Bearer ${(cfg.apiKey as string) || ""}`,
        ...((cfg.defaultHeaders as Record<string, string>) || {}),
      };
      break;
    }
    case "anthropic": {
      url = `${((cfg.baseUrl as string) || "https://api.anthropic.com").replace(/\/$/, "")}/models`;
      headers = {
        ...headers,
        "x-api-key": (cfg.apiKey as string) || "",
        "anthropic-version": (cfg.anthropicVersion as string) || "2023-06-01",
      };
      break;
    }
    default:
      throw new Error(`provider type "${type}" 无上游列表端点`);
  }
  const resp = await fetchWithProxy(
    url,
    { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    { providerId, providerOverride: proxyOverride ?? undefined }
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = (await resp.json().catch(() => ({}))) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
  const models = (json.data || json.models || []).map((m) => m.id).filter((x): x is string => !!x);
  return { models, url };
}

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const providerId = request.nextUrl.searchParams.get("providerId");
  if (!providerId) return fail("缺少 providerId 参数");
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";

  // 缓存命中（未过期且非强制刷新）
  const hit = cache.get(providerId);
  if (hit && !forceRefresh && Date.now() - hit.at < CACHE_TTL_MS) {
    return ok({ ...hit.payload, cached: true });
  }

  const provider = await db.provider.findUnique({ where: { id: providerId } });
  if (!provider) return fail(`提供商「${providerId}」不存在`);
  const type = provider.type;
  const cfg = { ...((provider.config as Record<string, unknown>) || {}) };

  let payload: ModelsPayload;
  try {
  if (type === "workbuddy") {
    // WorkBuddy：/v3/config 实时拉取；失败如实报错（不再降级内置目录）。
    try {
      const adapter = new WorkBuddyProvider({ id: provider.id, name: provider.name, type: provider.type, config: cfg });
      const { models, details, url, allCount } = await adapter.listUpstreamModels();
      payload = {
        providerId,
        source: "upstream",
        models,
        details,
        ...(typeof allCount === "number" ? { allCount } : {}),
        modelsCount: models.length,
        fetchedAt: Date.now(),
        cached: false,
        upstreamUrl: url,
      };
    } catch (e) {
      // 上游失败 → 如实抛出，由下方统一转为错误响应（不降级内置目录）
      throw new Error(`WorkBuddy 模型目录拉取失败：${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (type === "openai" || type === "anthropic") {
    try {
      const { models, url } = await fetchUpstreamModels(type, cfg, providerId, provider.proxyOverride ?? null);
      payload = {
        providerId,
        source: "upstream",
        models,
        modelsCount: models.length,
        fetchedAt: Date.now(),
        cached: false,
        upstreamUrl: url,
      };
    } catch (e) {
      // 上游失败 → 如实抛出，由下方统一转为错误响应（不降级内置目录）
      throw new Error(`上游模型目录拉取失败：${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    unsupportedType(type);
  }

  } catch (e) {
    // 上游不可用 / 类型不支持 → 明确失败，不回退内置目录
    return fail(e instanceof Error ? e.message : String(e), 502);
  }

  cache.set(providerId, { payload, at: Date.now() });
  return ok(payload);
}
