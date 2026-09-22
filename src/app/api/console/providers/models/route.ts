// GET /api/console/providers/models?providerId=xxx[&refresh=1] —— 上游模型目录（供路由候选下拉实时选择）。
// 拉取策略按提供商类型：
// - openai      ：GET {baseUrl}/models（Bearer）→ 上游实时（source: "upstream"）
// - anthropic   ：GET {baseUrl}/models（x-api-key + anthropic-version）→ 上游实时
// - opencode    ：GET {baseUrl}/models（CLI UA 公开接口）→ 上游实时
// - workbuddy/qwenweb ：上游无公开列表端点（/v2/models 等路径实测 404）→ derived 推导目录：
//   DB 路由候选（该 provider 在用）∪ DEFAULT_ROUTES 静态预设（原项目实测基线）
// 上游拉取失败 / 超时（8s）→ 自动降级 derived，响应带 fallbackReason 透明化。
// 内存缓存 60s（refresh=1 强制穿透）——表单反复打开不重复打上游。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { fetchWithProxy } from "@/lib/gateway/proxy/proxyAgent";
import { DEFAULT_ROUTES } from "@/lib/gateway/config/configService";
import { WorkBuddyProvider, type UpstreamModelDetail } from "@/lib/gateway/providers/workbuddy";

export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;

interface ModelsPayload {
  providerId: string;
  source: "upstream" | "derived";
  models: string[];
  modelsCount: number;
  fetchedAt: number;
  cached: boolean;
  fallbackReason?: string;
  upstreamUrl?: string;
  details: UpstreamModelDetail[];
  allCount: number;
}

// providerId → { payload, at }
const cache = new Map<string, { payload: ModelsPayload; at: number }>();

// ---- derived：DB 路由候选 ∪ DEFAULT_ROUTES 预设 ----
async function derivedModels(providerId: string): Promise<string[]> {
  const fromDb = await db.routeCandidate.findMany({
    where: { providerId },
    select: { model: true, enabled: true, sortOrder: true },
    orderBy: { sortOrder: "asc" },
  });
  const preset: string[] = [];
  for (const cands of Object.values(DEFAULT_ROUTES)) {
    for (const c of cands) {
      if (c.provider === providerId && !preset.includes(c.model)) preset.push(c.model);
    }
  }
  const merged: string[] = [];
  for (const m of [...fromDb.map((r) => r.model), ...preset]) {
    if (m && !merged.includes(m)) merged.push(m);
  }
  return merged;
}

// ---- 上游实时拉取（openai / anthropic / opencode） ----
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
    case "opencode": {
      url = `${((cfg.baseUrl as string) || "https://opencode.ai/zen/v1").replace(/\/$/, "")}/models`;
      headers = { ...headers, "User-Agent": "opencode/1.18.30", "x-opencode-client": "cli" };
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
  if (type === "workbuddy") {
    try {
      const adapter = new WorkBuddyProvider({ id: provider.id, name: provider.name, type: provider.type, config: cfg });
      const result = await adapter.listUpstreamModels();
      payload = { providerId, source: "upstream", models: result.models, modelsCount: result.models.length, fetchedAt: Date.now(), cached: false, upstreamUrl: result.url, details: result.details, allCount: result.allCount };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const models = await derivedModels(providerId);
      payload = { providerId, source: "derived", models, modelsCount: models.length, fetchedAt: Date.now(), cached: false, fallbackReason: reason, details: [], allCount: models.length };
    }
  } else if (type === "openai" || type === "anthropic" || type === "opencode") {
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
        details: [],
        allCount: models.length,
      };
    } catch (e) {
      // 上游失败 → derived 降级（透明化原因，前端仍可下拉/手动输入）
      const reason = e instanceof Error ? e.message : String(e);
      const models = await derivedModels(providerId);
      payload = {
        providerId,
        source: "derived",
        models,
        modelsCount: models.length,
        fetchedAt: Date.now(),
        cached: false,
        fallbackReason: "上游拉取失败（" + reason + "），已降级为已知目录",
        details: [],
        allCount: models.length,
      };
    }
  } else {
    // workbuddy / qwenweb：无上游列表端点，直接 derived
    const models = await derivedModels(providerId);
    payload = {
      providerId,
      source: "derived",
      models,
      modelsCount: models.length,
      fetchedAt: Date.now(),
      cached: false,
      fallbackReason: "该提供商类型上游无公开模型列表端点，目录来自当前路由配置与内置预设",
      details: [],
      allCount: models.length,
    };
  }

  cache.set(providerId, { payload, at: Date.now() });
  return ok(payload);
}
