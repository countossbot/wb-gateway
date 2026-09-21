// POST /v1/responses —— OpenAI Responses API 协议入口（Codex CLI / Responses SDK）。
// 内部转译为 Chat Completions 调用上游（转译层 src/lib/gateway/responses/*），
// 复用既有调度链路：路由解析 → 候选故障转移 → 协议转译 → 记账/配额/鉴权全等价。
//
// 守卫语义（明确的 400 只用于「客户端可自行修复且有替代路径」的错误）：
//   - previous_response_id → 400（无服务端会话状态；替代路径 = 回放完整 input 历史）
//   - item_reference → 400（同上，translate 层抛出）
//   - input 缺失/空 → 400
//   - 错误密钥 → 401（鉴权层）
// 客户端无法避免的默认行为（web_search 等服务端工具、历史回放的悬空/孤儿调用）→ 降级而非拒绝。
import { NextRequest } from "next/server";
import { requireGatewayAuth, jsonResponse } from "@/lib/gateway/http/routeHelpers";
import { dispatchExchange } from "@/lib/gateway/exchange/exchange";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { corsHeadersFor, corsPreflightResponse } from "@/lib/gateway/http/headers";
import {
  GATEWAY_MAX_BODY_BYTES,
  PayloadTooLargeError,
  contentLengthTooLarge,
  readJsonBodyWithLimit,
  tooLargeResponse,
} from "@/lib/gateway/http/bodyGuard";
import { authorizeModelForPrincipal } from "@/lib/gateway/auth/auth";
import { enforceVirtualKeyQuota } from "@/lib/gateway/auth/quota";
import { HttpError } from "@/lib/gateway/exchange/transform";
import { translateResponsesRequest } from "@/lib/gateway/responses/translate";
import {
  chatCompletionToResponsesResponse,
  chatSseToResponsesStream,
  chatJsonToResponsesStream,
  responsesSseHeaders,
  type ResponseEchoContext,
} from "@/lib/gateway/responses/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // ---- 入口防护 1/3：Content-Length 超限直接 413（不读 body，内存零占用） ----
  if (contentLengthTooLarge(request, GATEWAY_MAX_BODY_BYTES)) {
    return tooLargeResponse(request, GATEWAY_MAX_BODY_BYTES);
  }

  // ---- 2/3：鉴权前置（body 读取之前完成令牌/禁用校验；模型白名单 body 读取后补检） ----
  const auth = await requireGatewayAuth(request, { model: null });
  if (!auth.ok) return auth.response;

  // ---- 3/3：读取 body（超限中断 413 / 非法 JSON 400） ----
  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyWithLimit(request, GATEWAY_MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return tooLargeResponse(request, GATEWAY_MAX_BODY_BYTES);
    }
    return new Response(JSON.stringify({ error: { message: (err as Error).message } }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    });
  }

  const requestModel = (body.model as string) || "deepseek-v4.1-flash";
  const wantsStream = body.stream === true;

  // ---- 模型白名单补检（虚拟密钥主体）+ 日配额/月预算预检 ----
  const modelCheck = authorizeModelForPrincipal(request, auth.auth, requestModel);
  if (!modelCheck.ok) return modelCheck.response as Response;
  const quotaCheck = await enforceVirtualKeyQuota(request, auth.auth);
  if (!quotaCheck.ok) return quotaCheck.response;

  // ---- 守卫：previous_response_id（无状态网关不支持服务端会话链；替代路径 = 全量回放 input） ----
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && body.previous_response_id !== "") {
    return jsonResponse(
      {
        error: {
          message:
            `previous_response_id is not supported by this stateless gateway. ` +
            `Replay the full conversation history in "input" instead of referencing a stored response.`,
          type: "invalid_request_error",
          param: "previous_response_id",
          code: "unsupported_previous_response_id",
        },
      },
      400,
      request
    );
  }

  // ---- 请求转译（Responses → Chat Completions）：服务端工具剥离 + 规范形态修复 ----
  let translated;
  try {
    translated = translateResponsesRequest(body);
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: { message: err.message, type: "invalid_request_error" } }, err.status, request);
    }
    return new Response(JSON.stringify({ error: { message: (err as Error).message } }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    });
  }

  const { chatBody, droppedTools, customToolNames, functionToolNames } = translated;
  // 能力降级可观测：被剥离工具类型清单（流式/非流式响应均携带）
  const droppedToolsHeader: Record<string, string> =
    droppedTools.length > 0 ? { "X-Gateway-Dropped-Tools": droppedTools.join(", ") } : {};

  const echoContext: ResponseEchoContext = {
    requestId: `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    model: requestModel,
    echo: {
      ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
      ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
      ...(typeof body.max_output_tokens === "number" ? { max_output_tokens: body.max_output_tokens } : {}),
      ...(typeof body.parallel_tool_calls === "boolean" ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
      ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}),
    },
    customToolNames,
    functionToolNames,
  };

  try {
    const fleet = getProviderFleet(auth.config);
    const upstream = await dispatchExchange({
      protocol: "openai",
      model: requestModel,
      body: chatBody,
      fleet,
      config: auth.config,
      request,
      apiKeyName: auth.auth.ok ? (auth.auth.principal?.name ?? null) : null,
    });

    // ---- 错误透传（400/401/404/429/502）：保持 OpenAI error 信封 + dropped-tools 头（转译已发生，降级仍可观测） ----
    if (upstream.status >= 400) {
      const errText = await upstream.text();
      return new Response(errText, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") || "application/json",
          ...corsHeadersFor(request),
          ...droppedToolsHeader,
        },
      });
    }

    // ---- 网关落点头透传（与 /v1/chat/completions 同语义） ----
    const gatewayHeaders: Record<string, string> = {};
    for (const h of ["x-gateway-account", "x-gateway-model", "x-gateway-fallback"]) {
      const v = upstream.headers.get(h);
      if (v) gatewayHeaders[h] = v;
    }

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

    // ---- 流式：chat SSE → Responses SSE（事件序列 created → deltas → completed） ----
    if (contentType.includes("text/event-stream") && upstream.body) {
      const stream = chatSseToResponsesStream(upstream.body, echoContext, {
        signal: request.signal,
        pingIntervalMs: 10_000, // 客户端空闲保活（SSE 注释行，零语义影响）
      });
      return new Response(stream, {
        status: 200,
        headers: responsesSseHeaders({
          ...corsHeadersFor(request),
          ...gatewayHeaders,
          ...droppedToolsHeader,
        }),
      });
    }

    // ---- 非流式：chat JSON → Responses response 对象 ----
    const text = await upstream.text();
    let chatJson: Record<string, unknown>;
    try {
      chatJson = JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.warn("[Responses] upstream returned non-JSON body to non-stream request — 502");
      return new Response(
        JSON.stringify({
          error: {
            message: "Upstream returned a non-JSON body that could not be translated to a Responses object.",
            type: "api_error",
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeadersFor(request), ...droppedToolsHeader } }
      );
    }

    // 客户端要流但上游回了 JSON（provider 忽略 stream / 聚合路径）→ 合成最小完整事件序列
    if (wantsStream) {
      const stream = chatJsonToResponsesStream(chatJson, echoContext);
      return new Response(stream, {
        status: 200,
        headers: responsesSseHeaders({
          ...corsHeadersFor(request),
          ...gatewayHeaders,
          ...droppedToolsHeader,
        }),
      });
    }

    const responsesJson = chatCompletionToResponsesResponse(chatJson, echoContext);
    return new Response(JSON.stringify(responsesJson), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeadersFor(request),
        ...gatewayHeaders,
        ...droppedToolsHeader,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: (err as Error).message } }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request), ...droppedToolsHeader },
    });
  }
}

// CORS 预检（与 /v1/chat/completions 同款）
export async function OPTIONS(request: NextRequest) {
  return corsPreflightResponse(request);
}

export async function GET(request: NextRequest) {
  return new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), {
    status: 405,
    headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
  });
}
