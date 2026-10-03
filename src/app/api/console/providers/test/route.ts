// /api/console/providers/test —— 提供商（API 中转）连通性实测。
//
// v4.9.12-local-r11 新增。设置页的「测试代理」测的是本网关出站 HTTP 代理；
// 本路径测的是上游提供商本身（Base URL + 凭据 + 模型目录可达性），补齐运维探针闭环。
//
// 契约：
// - POST { providerId }           → 按已保存配置实测（DB 真实凭据；openai/anthropic 自动取
//                                  账号池第一个启用密钥，池空回退 provider 级 apiKey）
// - POST { draft: {...} }         → 按表单草稿实测（不落库；新增/编辑悬浮窗「测试连接」按钮）
//   draft: { type, baseUrl?, apiKey?, anthropicVersion?, defaultHeaders? }
// - 响应 ok({ result })：
//   { ok, status, elapsedMs, target, type, authSource, authChecked,
//     modelsCount, sampleModels, error, testedAt }
//
// 探针语义（与适配器真实转发路径严格同源）：
// - openai     → GET {baseUrl}/models            （baseUrl 含 /v1，与 openaiStandard.callChat 同源）
// - anthropic  → GET {baseUrl}/v1/models         （baseUrl 不含 /v1，与 anthropicStandard 同源）
// - workbuddy  → GET {origin}                    （仅网络可达性；凭据体系复杂，authChecked=false）
//
// 安全面：仅控制台会话可用（requireSessionOr401）。draft 模式可探测任意 baseUrl，
// 与 /api/console/proxy/test 的信任级别一致（管理员会话 = 网关运维者）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { fetchWithProxy } from "@/lib/gateway/proxy/proxyAgent";
import { resolveWorkbuddyEndpoints } from "@/lib/gateway/providers/workbuddy";
import type { ProviderTestResult } from "@/lib/console/types";
import { persistTestResult } from "@/lib/gateway/console/providerTestStore";

export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 8000;
const SAMPLE_CAP = 8;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 从模型目录响应提取 {id} 列表（OpenAI / Anthropic 的 /models 均为 { data: [{id}] }） */
function extractModelIds(json: unknown): { count: number; sample: string[] } | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return { count: ids.length, sample: ids.slice(0, SAMPLE_CAP) };
}

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  let body: { providerId?: unknown; draft?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
  const draft = body.draft && typeof body.draft === "object" ? (body.draft as Record<string, unknown>) : null;

  if (!providerId && !draft) {
    return fail("缺少 providerId 或 draft（二选一）");
  }

  // ---- 解析目标配置 ----
  let type = "openai";
  let baseUrl = "";
  let apiKey = "";
  let anthropicVersion = "2023-06-01";
  let defaultHeaders: Record<string, string> = {};
  let authSource: ProviderTestResult["authSource"] = "none";
  let scopeProviderId: string | null = null;
  let providerRegion: unknown = undefined;

  if (providerId) {
    const provider = await db.provider.findUnique({ where: { id: providerId } });
    if (!provider) return fail(`提供商不存在：${providerId}`, 404);
    const cfg = (provider.config || {}) as Record<string, unknown>;
    type = provider.type;
    scopeProviderId = provider.id;
    providerRegion = cfg.region;
    baseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl : "";
    defaultHeaders = (cfg.defaultHeaders as Record<string, string>) || {};
    if (type === "anthropic") {
      anthropicVersion =
        typeof cfg.anthropicVersion === "string" && cfg.anthropicVersion ? cfg.anthropicVersion : "2023-06-01";
    }
    // 凭据解析：账号池第一个启用密钥优先（与 standardPool 调度一致），池空回退 provider 级
    const accounts = await db.account.findMany({
      where: { providerId, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    const poolKey = accounts
      .map((a) => {
        const creds = (a.credentials || {}) as Record<string, unknown>;
        return typeof creds.apiKey === "string" ? creds.apiKey.trim() : "";
      })
      .find((k) => k !== "");
    const providerKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
    if (poolKey) {
      apiKey = poolKey;
      authSource = "account-pool";
    } else if (providerKey) {
      apiKey = providerKey;
      authSource = "provider-key";
    }
  } else if (draft) {
    type = typeof draft.type === "string" && draft.type ? draft.type : "openai";
    baseUrl = typeof draft.baseUrl === "string" ? draft.baseUrl : "";
    apiKey = typeof draft.apiKey === "string" ? draft.apiKey.trim() : "";
    anthropicVersion =
      typeof draft.anthropicVersion === "string" && draft.anthropicVersion ? draft.anthropicVersion : "2023-06-01";
    defaultHeaders =
      draft.defaultHeaders && typeof draft.defaultHeaders === "object"
        ? (draft.defaultHeaders as Record<string, string>)
        : {};
    authSource = apiKey ? "draft" : "none";
  }

  // ---- 按 type 构造探针 ----
  const startedAt = Date.now();
  const testedAt = new Date().toISOString();

  try {
    let resp: Response | null = null;
    let target = "";
    let authChecked = true;

    if (type === "openai") {
      const base = trimSlash(baseUrl || "https://api.openai.com/v1");
      target = `${base}/models`;
      resp = await fetchWithProxy(
        target,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            Connection: "keep-alive",
            ...defaultHeaders,
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
        scopeProviderId ? { providerId: scopeProviderId } : null
      );
    } else if (type === "anthropic") {
      const base = trimSlash(baseUrl || "https://api.anthropic.com");
      target = `${base}/v1/models`;
      resp = await fetchWithProxy(
        target,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(apiKey ? { "x-api-key": apiKey } : {}),
            "anthropic-version": anthropicVersion,
            Connection: "keep-alive",
            ...defaultHeaders,
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
        scopeProviderId ? { providerId: scopeProviderId } : null
      );
    } else if (type === "workbuddy") {
      // workbuddy：凭据体系复杂（accessToken 刷新 + 端点表），仅做网络可达性探测。
      // 用配置区域对应的 origin（cn/intl 均有实测端点），任意 HTTP 响应即视为可达。
      const cfgRegion = providerId ? providerRegion : draft?.region;
      const ep = resolveWorkbuddyEndpoints(cfgRegion);
      target = ep.origin;
      authChecked = false;
      resp = await fetchWithProxy(
        target,
        {
          method: "GET",
          headers: { Accept: "text/html,application/json" },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
        scopeProviderId ? { providerId: scopeProviderId } : null
      );
    } else {
      return fail(`不支持的提供商类型：${type}`);
    }

    const elapsedMs = Date.now() - startedAt;
    const status = resp.status;

    // 2xx/3xx = 探针通过；401/403 = 网络可达但凭据无效（单独语义）；其余 = 失败
    const httpOk = status >= 200 && status < 400;
    let modelsCount: number | null = null;
    let sampleModels: string[] = [];
    let error: string | null = null;

    if (httpOk && authChecked) {
      try {
        const json = (await resp.json()) as unknown;
        const parsed = extractModelIds(json);
        if (parsed) {
          modelsCount = parsed.count;
          sampleModels = parsed.sample;
        }
      } catch {
        // 2xx 但非 JSON（某些兼容网关 /models 返回空体）→ 连通性仍算通过
      }
    } else if (!httpOk) {
      // 尽量读取上游错误体（截断），排障更有用
      let detail = "";
      try {
        const text = await resp.text();
        detail = text.slice(0, 220).replace(/\s+/g, " ").trim();
      } catch {
        /* 忽略读取失败 */
      }
      error =
        status === 401 || status === 403
          ? `凭据被拒绝（HTTP ${status}）${detail ? `：${detail}` : ""}`
          : `上游返回 HTTP ${status}${detail ? `：${detail}` : ""}`;
    }

    if (httpOk && !apiKey && authChecked) {
      error = "连通（匿名）—— 未配置任何 API Key，真实转发将失败";
    }

    const result: ProviderTestResult = {
      ok: httpOk,
      status,
      elapsedMs,
      target,
      type,
      authSource,
      authChecked,
      modelsCount,
      sampleModels,
      error,
      testedAt,
    };

    // 仅已保存配置的实测落库（draft 是未保存草稿，不产生持久状态）
    if (providerId) {
      await persistTestResult(providerId, result);
    }

    return ok({ result });
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const msg = e instanceof Error ? e.message : String(e);
    // 超时与连接类错误给出可操作的提示
    const hint = /timeout|aborted|TimeoutError/i.test(msg)
      ? `探测超时（>${PROBE_TIMEOUT_MS / 1000}s）—— 上游不可达或过慢`
      : /connect|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)
        ? "无法建立连接 —— 检查 Base URL 拼写 / 端口 / 防火墙"
        : msg;
    const failResult: ProviderTestResult = {
      ok: false,
      status: null,
      elapsedMs,
      target: baseUrl ? trimSlash(baseUrl) : "",
      type,
      authSource,
      authChecked: type !== "workbuddy",
      modelsCount: null,
      sampleModels: [],
      error: hint,
      testedAt,
    };
    if (providerId) {
      await persistTestResult(providerId, failResult);
    }
    return ok({ result: failResult });
  }
}
