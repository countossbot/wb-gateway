// OpenCode Zen 提供商 —— 免费模型池 + 健康度路由 + Responses 适配 + 工具提示词降级 + 代理池轮换。
// 免费模型列表缓存：内存 1h + SQLite SystemSetting（原 KV OPENCODE_FREE_MODELS 语义）。
import { buildResponseHeaders } from "../../http/headers";
import { matchOpenCodeFamily } from "../../exchange/reasoning";
import { ModelHealthTracker, globalOpenCodeHealthTracker } from "./health";
import { deriveSessionAndFingerprint } from "./session";
import {
  buildResponsesPayload,
  renderResponsesUpstreamError,
  translateResponsesJsonToOpenAI,
  translateResponsesStreamToOpenAI,
} from "./responses";
import { fetchWithProxy, rotateProxyPool, type OutboundScope } from "../../proxy/proxyAgent";
import { db } from "@/lib/db";
import { getRuntimeSettings } from "../../config/runtimeSettings";
import type { ProviderAdapter, ProviderConfig, ChatPayload, CallOptions, BalanceResult } from "../../core/types";

export { ModelHealthTracker, globalOpenCodeHealthTracker } from "./health";
export { deriveSessionAndFingerprint } from "./session";
export { transformOpenAIMessagesToResponsesInput } from "./responses";

export const DEFAULT_FREE_MODELS = [
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "big-pickle",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4-flash-free",
];

export function isFreeModel(id: string | null | undefined): boolean {
  if (!id || typeof id !== "string") return false;
  const lower = id.toLowerCase().trim();
  return (
    lower.endsWith("-free") ||
    lower.includes("-contributor-free") ||
    lower.includes("-free-") ||
    lower === "big-pickle"
  );
}

/**
 * 工具调用提示词降级适配器（Polyfill）
 * 当上游免费模型不支持原生 OpenAI JSON Tools 时，自动将工具注入 System Prompt
 */
export function convertToolsToSystemPrompt(tools: Array<Record<string, unknown>>): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  let prompt =
    "\n\n[AVAILABLE TOOLS]\nYou have access to the following tools to assist the user. If you need to call a tool, reply with a markdown code block tagged json in this exact format:\n```json\n{\n  \"tool\": \"tool_name\",\n  \"arguments\": {\n    \"param\": \"value\"\n  }\n}\n```\n\nTools:\n";
  for (const t of tools) {
    const fn = (t.function as Record<string, unknown> | undefined) || (t as Record<string, unknown>);
    prompt += `- ${fn.name}: ${fn.description || "No description"}\n  Parameters: ${JSON.stringify(fn.parameters || {})}\n`;
  }
  return prompt;
}

let cachedFreeModels: string[] | null = null;
let cachedFreeModelsTimestamp = 0;
const MODELS_CACHE_TTL_MS = 3600 * 1000; // 1小时缓存

export class OpenCodeProvider implements ProviderAdapter {
  id: string;
  name: string;
  type = "opencode";
  config: Record<string, unknown>;
  currentProxyIndex = 0;

  constructor(config: ProviderConfig) {
    this.id = config.id || "opencode";
    this.name = config.name || "OpenCode Zen (Free Tier)";
    this.config = (config.config || {}) as Record<string, unknown>;

    // 实例初始化时异步预热拉取官方最新免费模型
    this.fetchOfficialFreeModels().catch(() => {});
  }

  get baseUrl(): string {
    const url = (this.config.baseUrl as string) || "https://opencode.ai/zen/v1";
    return url.replace(/\/$/, "");
  }

  // 提供商级代理池（覆盖全局）：provider.proxyOverride 字段（DB）→ config 透传
  private proxyScope(): OutboundScope {
    const override = (this.config.proxyOverride as string | undefined) ?? null;
    return { providerId: this.id, providerOverride: override };
  }

  // 代理池（原 OPENCODE_PROXY_URLS/PROXY_URL env 兼容 + config.proxyUrls + DB 覆盖）
  get proxyList(): string[] {
    const override = this.config.proxyOverride as string | undefined;
    if (override === "direct") return [];
    if (override) {
      return String(override)
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const raw =
      process.env.OPENCODE_PROXY_URLS ||
      (this.config.proxyUrls as string | undefined) ||
      process.env.PROXY_URL ||
      "";
    return String(raw)
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  sortModelsByHealth(models: string[]): string[] {
    return globalOpenCodeHealthTracker.sortModels(models);
  }

  isModelCooling(model: string): boolean {
    return globalOpenCodeHealthTracker.isCooling(model);
  }

  getModelHealth(model: string) {
    return globalOpenCodeHealthTracker.getOrCreate(model);
  }

  async fetchOfficialFreeModels(forceRefresh = false): Promise<string[]> {
    const now = Date.now();
    if (!forceRefresh && cachedFreeModels && now - cachedFreeModelsTimestamp < MODELS_CACHE_TTL_MS) {
      return cachedFreeModels;
    }

    // SQLite 缓存（原 KV OPENCODE_FREE_MODELS 语义；重启不丢）
    if (!forceRefresh) {
      try {
        const row = await db.systemSetting.findUnique({ where: { key: "opencode_free_models" } });
        const parsed = row?.value as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          cachedFreeModels = parsed as string[];
          cachedFreeModelsTimestamp = now;
          return parsed as string[];
        }
      } catch {
        /* noop */
      }
    }

    try {
      const resp = await fetchWithProxy(
        `${this.baseUrl}/models`,
        {
          headers: {
            "User-Agent": "opencode/1.18.30",
            "x-opencode-client": "cli",
          },
          signal: AbortSignal.timeout(6000),
        },
        this.proxyScope()
      );

      if (resp.ok) {
        const json = (await resp.json()) as { data?: Array<{ id: string }> };
        const models = (json.data || [])
          .map((m) => m.id)
          .filter(isFreeModel);

        if (models.length > 0) {
          const merged = Array.from(new Set([...models, ...DEFAULT_FREE_MODELS]));
          cachedFreeModels = merged;
          cachedFreeModelsTimestamp = now;
          try {
            await db.systemSetting.upsert({
              where: { key: "opencode_free_models" },
              create: { key: "opencode_free_models", value: merged as never },
              update: { value: merged as never },
            });
          } catch {
            /* noop */
          }
          console.log(`[OpenCode] Auto-synced ${merged.length} official free models from upstream`);
          return merged;
        }
      }
    } catch (err) {
      console.warn(
        `[OpenCode] Failed to fetch official models, falling back to cached/default:`,
        (err as Error).message
      );
    }

    cachedFreeModels = DEFAULT_FREE_MODELS;
    cachedFreeModelsTimestamp = now;
    return DEFAULT_FREE_MODELS;
  }

  getFreeModels(): string[] {
    return cachedFreeModels || DEFAULT_FREE_MODELS;
  }

  resolveModel(modelName: string | undefined): string {
    if (!modelName) return "mimo-v2.5-free";
    const target = modelName.trim();

    // 友好别名映射到官方实际免费模型 ID
    if (target === "muse-spark-1.3") return "muse-spark-1.3-contributor-free";
    if (target === "muse-spark-1.2") return "muse-spark-1.2-contributor-free";
    if (target === "mimo-v2.5") return "mimo-v2.5-free";
    if (target === "ling-3.0-flash-fin" || target === "ling-3.0-flash") return "ling-3.0-flash-fin-free";
    if (target === "nemotron-3-ultra") return "nemotron-3-ultra-free";
    if (target === "nemotron-3.5-lightning") return "nemotron-3.5-lightning-free";
    if (target === "deepseek-v4-flash") return "deepseek-v4-flash-free";

    if (isFreeModel(target)) return target;

    // 尝试添加 -free 后缀匹配官方已同步的免费模型
    const withFree = `${target}-free`;
    const known = this.getFreeModels();
    if (known.includes(withFree)) return withFree;

    return target;
  }

  async callChat(payload: ChatPayload, options: CallOptions = {}): Promise<Response> {
    const targetModel = this.resolveModel(payload.model);

    // 仅限免费模型：严格阻断任何非免费模型的调用，避免 401 鉴权崩溃
    if (!isFreeModel(targetModel)) {
      return new Response(
        JSON.stringify({
          error: {
            type: "InvalidModelError",
            message: `Model "${payload.model}" is not an OpenCode free tier model. OpenCode Zen provider strictly supports free models only.`,
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const adaptedPayload: ChatPayload = { ...payload, model: targetModel };

    // 自动适配：muse-spark 在 OpenCode Zen 后端仅部署于 /zen/v1/responses 端点
    // 家族判定收敛到 reasoning.matchOpenCodeFamily，不在本文件另写 includes。
    if (matchOpenCodeFamily(targetModel) === "muse-spark") {
      return this.callResponsesApi(adaptedPayload, options);
    }

    const fingerprint = await deriveSessionAndFingerprint(payload as never, options);
    const url = `${this.baseUrl}/chat/completions`;

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": fingerprint.userAgent,
      "x-opencode-version": fingerprint.version,
      "x-opencode-session": fingerprint.sessionId,
      "x-opencode-request": fingerprint.requestId,
      "x-opencode-client": "cli",
      Accept: payload.stream !== false ? "text/event-stream, application/json" : "application/json",
      Connection: "keep-alive",
      ...((this.config.defaultHeaders as Record<string, string>) || {}),
    };

    const maxAttempts = Math.max(1, Math.min(this.proxyList.length, 3));
    let lastResp: Response | null = null;
    let activePayload: Record<string, unknown> = adaptedPayload as Record<string, unknown>;
    let toolPolyfilled = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const startTime = Date.now();

      const resp = await fetchWithProxy(
        url,
        {
          method: "POST",
          headers: { ...baseHeaders, "x-opencode-request": crypto.randomUUID() },
          body: JSON.stringify(activePayload),
          signal: options.signal ?? undefined,
        },
        this.proxyScope()
      );

      const elapsed = Date.now() - startTime;

      if (resp.ok) {
        globalOpenCodeHealthTracker.recordSuccess(targetModel, elapsed);
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: buildResponseHeaders(resp.headers, {
            "X-Gateway-Account": "opencode-zen",
            "X-Gateway-Account-Id": "opencode-zen",
            "X-Gateway-Latency": `${elapsed}ms`,
            ...(this.proxyList.length > 0 ? { "X-Gateway-Proxy": "true" } : {}),
          }),
        });
      }

      const errText = await resp.text();
      const lowerErr = errText.toLowerCase();
      const isRateLimit =
        resp.status === 429 || lowerErr.includes("freeusagelimiterror") || lowerErr.includes("rate limit");

      if (isRateLimit) {
        globalOpenCodeHealthTracker.recordFailure(targetModel, resp.status, true);
        if (this.proxyList.length > 1 && attempt < maxAttempts - 1) {
          console.warn(
            `[OpenCode Proxy] IP rate limit hit on proxy #${this.currentProxyIndex}, rotating to next proxy...`
          );
          this.rotateProxy();
          continue;
        }
      } else {
        globalOpenCodeHealthTracker.recordFailure(targetModel, resp.status, false);
      }

      // Tool Use 兼容性降级补丁：若上游对原生 tools 报错 400，自动将 tools 转为 System Prompt 指令
      if (
        resp.status === 400 &&
        !toolPolyfilled &&
        activePayload.tools &&
        (lowerErr.includes("tools") || lowerErr.includes("parameter"))
      ) {
        console.warn(
          `[OpenCode Tools Polyfill] Model "${targetModel}" does not accept native tools, falling back to Prompt-based polyfill...`
        );
        toolPolyfilled = true;
        const toolPrompt = convertToolsToSystemPrompt(activePayload.tools as Array<Record<string, unknown>>);
        const polyfillMessages = [...((activePayload.messages as Array<Record<string, unknown>>) || [])];
        if (polyfillMessages.length > 0 && polyfillMessages[0].role === "system") {
          polyfillMessages[0] = {
            ...polyfillMessages[0],
            content: (polyfillMessages[0].content as string) + toolPrompt,
          };
        } else {
          polyfillMessages.unshift({ role: "system", content: toolPrompt });
        }
        const { tools, tool_choice, ...rest } = activePayload as Record<string, unknown>;
        activePayload = { ...rest, messages: polyfillMessages };
        continue;
      }

      lastResp = new Response(errText, {
        status: resp.status,
        headers: buildResponseHeaders(resp.headers, {
          "Content-Type": "application/json",
          "X-Gateway-Account": "opencode-zen",
          "X-Gateway-Account-Id": "opencode-zen",
        }),
      });
      break;
    }

    return lastResp as Response;
  }

  rotateProxy(): void {
    if (this.proxyList.length > 0) {
      this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxyList.length;
      rotateProxyPool(); // 同步全局代理池轮换指针（限流轮换全局语义）
    }
  }

  async callResponsesApi(payload: ChatPayload, options: CallOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/responses`;
    const fingerprint = await deriveSessionAndFingerprint(payload as never, options);

    // 别名归一收敛到 resolveModel（与 callChat 同一份映射），不另写 if 链。
    const targetModel = this.resolveModel(payload.model);

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": fingerprint.userAgent,
      "x-opencode-version": fingerprint.version,
      "x-opencode-session": fingerprint.sessionId,
      "x-opencode-request": fingerprint.requestId,
      "x-opencode-client": "cli",
      Accept: payload.stream !== false ? "text/event-stream, application/json" : "application/json",
      Connection: "keep-alive",
      ...((this.config.defaultHeaders as Record<string, string>) || {}),
    };

    const { responsesPayload, isStream } = buildResponsesPayload(payload as Record<string, unknown>, targetModel);

    const maxAttempts = Math.max(1, Math.min(this.proxyList.length, 3));
    let resp: Response | null = null;
    let elapsed = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const startTime = Date.now();

      resp = await fetchWithProxy(
        url,
        {
          method: "POST",
          headers: { ...baseHeaders, "x-opencode-request": crypto.randomUUID() },
          body: JSON.stringify(responsesPayload),
          signal: options.signal ?? undefined,
        },
        this.proxyScope()
      );

      elapsed = Date.now() - startTime;

      if (resp.ok) {
        globalOpenCodeHealthTracker.recordSuccess(targetModel, elapsed);
        break;
      }

      const isRateLimit = resp.status === 429;
      globalOpenCodeHealthTracker.recordFailure(targetModel, resp.status, isRateLimit);
      if (isRateLimit && this.proxyList.length > 1 && attempt < maxAttempts - 1) {
        console.warn(`[OpenCode Proxy] IP rate limit hit on responses, rotating to next proxy...`);
        this.rotateProxy();
        continue;
      }
      break;
    }

    if (!(resp as Response).ok) return renderResponsesUpstreamError(resp as Response);

    if (!isStream) {
      return translateResponsesJsonToOpenAI(await (resp as Response).json(), {
        model: payload.model,
        elapsed,
        upstreamHeaders: (resp as Response).headers,
      });
    }

    return translateResponsesStreamToOpenAI((resp as Response).body as ReadableStream<Uint8Array>, {
      elapsed,
      upstreamHeaders: (resp as Response).headers,
      signal: options.signal ?? null,
    });
  }

  async getBalance(): Promise<BalanceResult> {
    return {
      success: true,
      balance: "∞ (Free Tier)",
      total: "∞",
      unit: "次",
      accounts_count: 1,
      proxies_count: this.proxyList.length,
      current_proxy: this.proxyList.length > 0 ? "(configured)" : "direct",
      health_status: globalOpenCodeHealthTracker.getSummary(),
      extra: "OpenCode Zen (Auto-Synced Free Models with Health-Scored Dynamic Routing & Proxy Cycling)",
    };
  }

  async onSchedule(): Promise<void> {
    // 定时触发：从 OpenCode 官方 API 自动同步最新的免费模型库
    try {
      await this.fetchOfficialFreeModels(true);
    } catch (e) {
      console.error("[OpenCode] Cron model sync failed:", (e as Error).message);
    }
  }
}

// 保留原 transport 导出语义（代理解析已全局化到 proxy/proxyAgent.ts）
export { parseProxyList } from "../../proxy/proxyAgent";
