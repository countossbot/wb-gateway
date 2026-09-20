// 路由与故障转移 —— 模型解析、候选遍历、故障转移（cooldown/retry 经 scheduler.classify 判定）。
// 转译细节在 ./transform.ts 与 ./stream.ts，本模块只做编排。
import { corsHeadersFor } from "../http/headers";
import { parseReasoningIntent, applyReasoningToPayload } from "./reasoning";
import { isModelLevelError } from "../core/scheduler";
import { hasCallChat, hasCallMessages, wantsStreamedChat } from "../core/contract";
import { runFailover, type FailOutcome } from "../core/failover";
import { transformAnthropicToOpenAI, HttpError } from "./transform";
import { streamOpenAIToAnthropic, formatOpenAIToAnthropicJson, aggregateOpenAIToChatJson, passthroughUsageTee, passthroughUsageFromJson, type StreamUsageReport } from "./stream";
import { recordRequestLog } from "../config/requestLog";
import type { ProviderFleet } from "../core/fleet";
import type { GatewayConfig, RouteCandidateConfig } from "../core/types";

export interface DispatchParams {
  protocol: "anthropic" | "openai";
  model: string;
  body: Record<string, unknown>;
  fleet: ProviderFleet;
  config: GatewayConfig;
  request: Request;
  /** v3.0.4：调用方密钥名（虚拟密钥名 / Master Admin / Cron Trigger）——落请求日志，供密钥维度统计 */
  apiKeyName?: string | null;
}

/**
 * Deep Exchange Module:
 * 单一深度接口，封装完整的协议探测、跨协议转译、指纹清洗、优先级回退与流式输出
 */
export async function dispatchExchange(params: DispatchParams): Promise<Response> {
  const { protocol, model, body, fleet, config, request, apiKeyName } = params;
  const startedAt = Date.now();
  const isAnthropic = protocol === "anthropic";
  const routes = config.routes || {};

  // 记账（请求日志）：无论成败都落库，字段含模型/命中提供商/耗时/状态码/Token
  // v3.0.2：usage 支持（上游精确优先，估算兑底）；流式路径延迟到流结束时落库
  let loggedProvider: string | null = null;
  let loggedAccount: string | null = null;
  let loggedStatus = 0;
  let logWritten = false;
  let logDeferred = false; // v3.0.2：流式转译路径延迟到流结束时落库（拿精确 usage）
  // v3.0.8：最近一次候选失败摘要（仅当最终响应为错误时才写入日志 error 字段）
  let lastFailError: string | null = null;
  const writeLog = (status: number, usage?: StreamUsageReport, error?: string | null) => {
    if (logWritten) return; // 防重复（流式回调与竞态收尾双保险）
    logWritten = true;
    loggedStatus = status;
    recordRequestLog({
      model,
      protocol,
      providerId: loggedProvider,
      accountId: loggedAccount,
      durationMs: Date.now() - startedAt,
      status,
      stream: body.stream === true,
      inputTokens: usage && usage.inputTokens > 0 ? usage.inputTokens : null,
      outputTokens: usage && usage.outputTokens > 0 ? usage.outputTokens : null,
      cachedTokens: usage && usage.cachedTokens > 0 ? usage.cachedTokens : null,
      // v3.0.4：调用方密钥名（密钥维度统计/审计）
      apiKeyName: apiKeyName ?? null,
      // v3.0.3/v3.9.3：usage 来源标记 —— 优先 source（upstreamUsageFrame/estimated/unknown），
      // 映射到 usageExact 布尔列（true=上游精确 / false=估算 / null=未记录），旧列向后兼容不删除；
      // 旧调用方未带 source 时回退 upstreamExact 布尔（兼容过渡）。
      usageExact: usage
        ? usage.source
          ? usage.source === "upstreamUsageFrame"
            ? true
            : usage.source === "estimated"
              ? false
              : null
          : (usage.upstreamExact ?? null)
        : null,
      // v3.0.8：失败原因（审计/排障；成功路径为 null）
      error: status >= 400 ? (error ?? lastFailError) ?? null : null,
    }).catch(() => {});
  };
  const finishLog = (status: number, error?: string | null) => {
    writeLog(status, undefined, error);
    return status;
  };

  /** v3.0.8：从上游错误响应体提取人可读摘要（JSON error.message 优先，原文兑底，截断 300 字符） */
  const summarizeUpstreamError = (text: string, max = 300): string => {
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      const msg = typeof j.error === "string" ? j.error : j.error?.message || j.message;
      if (msg) return msg.slice(0, max);
    } catch {
      /* 非 JSON，用原文 */
    }
    return text.slice(0, max);
  };

  // 共享解析推理强度与干净模型名
  const reasoningIntent = parseReasoningIntent({ model, body: body as never });
  const cleanModel = reasoningIntent.cleanModel || "deepseek-v4.1-flash";
  const candidates: RouteCandidateConfig[] | undefined = routes[model] || routes[cleanModel];

  // 路由模糊回退已改为显式 opt-in（issue #04）。
  // 仅当 routes 中存在精确匹配时才使用配置的路由，否则返回 404 错误并提供可用模型建议。
  if (!candidates || candidates.length === 0) {
    const availableModels = Object.keys(routes || {});
    finishLog(404, `No route configured for model "${model}"`);
    return new Response(
      JSON.stringify({
        error: {
          message:
            `No route configured for model "${model}". ` +
            `Available models: ${availableModels.length > 0 ? availableModels.join(", ") : "(none)"}. ` +
            `To use this model, please add an explicit route in the configuration.`,
        },
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
      }
    );
  }

  // 候选级故障转移收敛到 runFailover：循环、分类、耗尽收尾
  // 由驱动器统一处理；单个候选的「试一次」（取 provider → 调上游 → 成功渲染 / 失败收口）见 attempt。
  const response = await runFailover<RouteCandidateConfig>(candidates, {
    onRetryable: async (candidate, action, fail: FailOutcome) => {
      console.warn(
        `[Fallback] Provider "${candidate.provider}" (${candidate.model}) returned ${fail.status}${
          action === "cooldown" ? " [cooldown]" : ""
        }, retrying next candidate...`
      );
    },
    renderExhausted: ({ lastError }) => {
      finishLog(502, `All providers for model "${model}" failed. Last error: ${lastError ? lastError.message : "none"}`);
      return new Response(
        JSON.stringify({
          error: {
            message: `All available providers for model "${model}" failed. Last error: ${
              lastError ? lastError.message : "none"
            }`,
          },
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
        }
      );
    },
    attempt: async (candidate, candidateIndex) => {
      const provider = fleet.getProvider(candidate.provider);
      if (!provider) {
        // 明确报错：路由指向了不可用的 provider，而不是静默跳过。
        // 区分两种情况：配置中存在但被禁用（提示启用）vs 配置中根本不存在（提示补建）。
        const configured = (config.providers || []).find(
          (p) => p && p.id === candidate.provider
        );
        if (configured && configured.enabled === false) {
          console.error(
            `[Exchange] Route candidate "${candidate.provider}" is disabled (enabled=false), skipped by fleet`
          );
          throw new Error(
            `Provider "${candidate.provider}" is disabled. Enable it in the console (API 中转) to serve requests.`
          );
        }
        console.error(
          `[Exchange] Route candidate "${candidate.provider}" not found in provider fleet`
        );
        throw new Error(`Provider "${candidate.provider}" not configured`);
      }
      loggedProvider = candidate.provider;

      // 能力探针（contract.ts）：原生 Anthropic 上游走 callMessages，其余走 callChat；
      // 是否强制流由 adapter 以 forceStream 声明。绝不 switch provider.type。
      const nativeAnthropic = hasCallMessages(provider);
      let upstreamRes: Response | null = null;

      try {
        if (isAnthropic && nativeAnthropic) {
          const anthropicPayload = applyReasoningToPayload(
            { ...body, model: candidate.model },
            reasoningIntent,
            "anthropic",
            candidate.model
          );
          upstreamRes = await provider.callMessages!(anthropicPayload, {
            signal: request?.signal,
            request,
          });
        } else if (hasCallChat(provider)) {
          let openaiPayload: Record<string, unknown>;
          try {
            openaiPayload = isAnthropic
              ? transformAnthropicToOpenAI(
                  body as never,
                  candidate.model,
                  config,
                  reasoningIntent
                )
              : { ...body, model: candidate.model };
          } catch (err) {
            // 参数校验失败（400 / 404）：直接返回，不进行故障转移
            if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
              finishLog(err.status, err.message);
              return {
                done: new Response(
                  JSON.stringify({ error: { message: err.message } }),
                  {
                    status: err.status,
                    headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
                  }
                ),
              };
            }
            throw err;
          }
          applyReasoningToPayload(openaiPayload, reasoningIntent, provider.type, candidate.model);
          if (wantsStreamedChat(provider)) {
            openaiPayload.stream = true;
          }
          upstreamRes = await provider.callChat!(openaiPayload as never, {
            signal: request?.signal,
            request,
          });
        } else {
          throw new Error(
            `Provider "${candidate.provider}" implements neither callChat nor callMessages`
          );
        }
      } catch (err) {
        // 上游抛出的客户端错误（400 / 404）：直接返回，不进行故障转移
        if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
          finishLog(err.status, err.message);
          return {
            done: new Response(JSON.stringify({ error: { message: err.message } }), {
              status: err.status,
              headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
            }),
          };
        }
        console.warn(
          `[Fallback] Provider "${candidate.provider}" failed: ${(err as Error).message}, retrying next candidate...`
        );
        throw err;
      }

      if (upstreamRes && upstreamRes.ok) {
        const hitAccount =
          upstreamRes.headers.get("x-gateway-account") || "default";
        loggedAccount = hitAccount;
        const isFallback = candidateIndex > 0;
        const debugHeaders = {
          "X-Gateway-Account": hitAccount,
          "X-Gateway-Model": candidate.model,
          "X-Gateway-Fallback": isFallback ? "true" : "false",
        };

        if (isAnthropic && !nativeAnthropic) {
          if (body.stream === true) {
            // v3.0.2：流式路径延迟落库 —— 转译器在流结束时回调精确 usage
            //（上游 SSE usage 帧优先；异常断流/客户端中断时 finally 兜底也会回调）
            logDeferred = true; // 挑战收尾兑底：不能在流结束前抢落无 usage 日志
            return {
              done: streamOpenAIToAnthropic(
                upstreamRes,
                model,
                request?.signal ?? null,
                debugHeaders,
                {
                  request,
                  onUsage: (usage) => writeLog(200, usage),
                }
              ),
            };
          }
          return {
            done: await formatOpenAIToAnthropicJson(upstreamRes, model, debugHeaders, request, (usage) =>
              writeLog(200, usage)
            ),
          };
        }

        // v3.0.3：透传分支（OpenAI 协议透传 / Anthropic 原生上游）的轻量 usage 统计：
        //   - SSE 响应：passthroughUsageTee 旁路扫描 usage 帧（响应字节不变，流结束/中断时回调落库）
        //   - JSON 响应：缓冲解析顶层 usage（精确）或按正文字符估算（与转译路径口径一致）
        //   - 其他 content-type（罕见）：维持旧行为直接落库
        // 分支以响应实际 content-type 判定（而非客户端 stream 意图）：
        // forceStream 提供商（workbuddy/qwenweb）与上游默认流式的场景下，非流式请求也会收到 SSE。
        const contentType = (upstreamRes.headers.get("content-type") || "").toLowerCase();
        const passthroughHeaders = {
          ...corsHeadersFor(request),
          ...(contentType ? { "Content-Type": contentType } : {}),
          ...debugHeaders,
        };
        if (contentType.includes("text/event-stream") && upstreamRes.body) {
          logDeferred = true; // 流结束时由 tee/聚合回调落库（收尾兑底不抢先）
          const onUsage = (usage: StreamUsageReport) => writeLog(200, usage);
          // v3.2.1 修复：客户端要 JSON（stream !== true）但上游 forceStream 返回 SSE ——
          // 聚合为标准 chat.completion JSON（OpenAI 协议分支；Anthropic 协议非流式
          // 已在上文 formatOpenAIToAnthropicJson 覆盖，原生上游 SSE 仅发生在
          // 客户端明确要流的场景，维持透传）
          if (!isAnthropic && body.stream !== true) {
            return {
              done: await aggregateOpenAIToChatJson(
                upstreamRes,
                model,
                debugHeaders,
                request ?? null,
                onUsage
              ),
            };
          }
          const teedBody = passthroughUsageTee(upstreamRes.body, onUsage);
          return {
            done: new Response(teedBody, {
              status: 200,
              headers: passthroughHeaders,
            }),
          };
        }
        if (contentType.includes("application/json") && upstreamRes.body) {
          const text = await upstreamRes.text();
          writeLog(200, passthroughUsageFromJson(text) ?? undefined);
          return {
            done: new Response(text, {
              status: 200,
              headers: passthroughHeaders,
            }),
          };
        }

        finishLog(200);
        return {
          done: new Response(upstreamRes.body, {
            status: 200,
            headers: passthroughHeaders,
          }),
        };
      }

      if (upstreamRes) {
        const status = upstreamRes.status;
        const errText = await upstreamRes.text();
        // v3.0.8：记录失败摘要（若后续候选成功则被成功日志覆盖，不会误写）
        lastFailError = `${candidate.provider}: ${summarizeUpstreamError(errText)}`;
        // 尝试解析 JSON 以进行结构化错误码判定；分类本身由驱动器经 classify 完成
        let parsedErrJson: Record<string, unknown> | null = null;
        try {
          parsedErrJson = JSON.parse(errText);
        } catch {
          /* noop */
        }
        // 模型身份级错误（上游说「此模型不可用」）且后面还有不同模型的候选：
        // 对当前模型判 fatal 没有意义，强制切换，让备用模型接管。
        const laterModelsDiffer =
          (status === 400 || status === 404) &&
          isModelLevelError(errText) &&
          candidates.slice(candidateIndex + 1).some((c) => c.model !== candidate.model);
        if (laterModelsDiffer) {
          console.warn(
            `[Fallback] Provider "${candidate.provider}" model "${candidate.model}" unavailable, failing over to a different model...`
          );
        }
        return {
          fail: {
            status,
            text: errText,
            json: parsedErrJson,
            ...(laterModelsDiffer ? { force: "retry" as const } : {}),
            response: new Response(errText, {
              status: status,
              headers: {
                "Content-Type": "application/json",
                ...corsHeadersFor(request),
              },
            }),
          },
        };
      }

      throw new Error(`Provider "${candidate.provider}" returned an empty response`);
    },
  });

  // 兑底：非延迟场景（透传/非流式/错误路径）若尚未落库则立即落；
  // 流式延迟路径由 onUsage 回调负责（其 finally 必然触发，不会遇漏）
  // v3.0.8：错误响应携带最近失败摘要（fail 路径已存 lastFailError）
  if (!loggedStatus && !logDeferred) finishLog(response.status);
  return response;
}
