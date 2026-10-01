// POST /v1/chat/completions —— OpenAI Chat Completions 协议入口。
import { NextRequest } from "next/server";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { dispatchExchange } from "@/lib/gateway/exchange/exchange";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { corsHeadersFor } from "@/lib/gateway/http/headers";
import {
  GATEWAY_MAX_BODY_BYTES,
  PayloadTooLargeError,
  contentLengthTooLarge,
  readJsonBodyWithLimit,
  tooLargeResponse,
} from "@/lib/gateway/http/bodyGuard";
import { authorizeModelForPrincipal } from "@/lib/gateway/auth/auth";
import {
  enforceVirtualKeyQuota,
  releaseQuotaSlot,
  bindQuotaSlotToResponse,
} from "@/lib/gateway/auth/quota";
import { corsPreflightResponse } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // ---- v3.9.3 入口防护 1/3：Content-Length 超限直接 413（不读 body，内存零占用） ----
  if (contentLengthTooLarge(request, GATEWAY_MAX_BODY_BYTES)) {
    return tooLargeResponse(request, GATEWAY_MAX_BODY_BYTES);
  }

  // ---- 2/3：鉴权前置（令牌校验在 body 读取之前完成，大 body 不再无鉴权占用内存） ----
  // model 在 body 内：第一阶段以无模型模式完成令牌/禁用校验；模型白名单在 body 读取后补检
  // （authorizeModelForPrincipal，拒绝响应与原先鉴权内联校验逐字节一致，仅顺序变化）。
  const auth = await requireGatewayAuth(request, { model: null });
  if (!auth.ok) return auth.response;

  // ---- 3/3：读取 body（Content-Length 缺失即 chunked 场景走流式读取，累计超限中断 413） ----
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

  // ---- 模型白名单补检（虚拟密钥主体；master/cron 不受限，与原语义一致） ----
  const modelCheck = authorizeModelForPrincipal(request, auth.auth, requestModel);
  if (!modelCheck.ok) return modelCheck.response as Response;

  // ---- v4.3.0：密钥级日配额预检（虚拟密钥主体；超限 429，零上游成本零日志写入） ----
  const quotaCheck = await enforceVirtualKeyQuota(request, auth.auth);
  if (!quotaCheck.ok) return quotaCheck.response;

  // F1 修复配套：占位在 enforceVirtualKeyQuota 内完成，必须在所有出口归还（含异常），
  // F1 修复配套：占位在 enforceVirtualKeyQuota 内完成，必须在所有出口归还（含异常）。
  // F1-3 修正（审查发现）：流式请求返回的 Response 其 body 尚未消费，若在此处无条件归还，
  // 整段流式期间占位归零、超发窗口依旧敞开 —— 故流式交由 body 结束/取消时释放。
  try {
    const fleet = getProviderFleet(auth.config);
    const upstream = await dispatchExchange({
      protocol: "openai",
      model: requestModel,
      body,
      fleet,
      config: auth.config,
      request,
      // v3.0.4：调用方密钥名落请求日志（虚拟密钥名 / Master Admin / Cron Trigger）
      apiKeyName: auth.auth.ok ? (auth.auth.principal?.name ?? null) : null,
    });
    // 流式：占位随 body 生命周期释放；非流式：由下面的 finally 释放
    return bindQuotaSlotToResponse(upstream, auth.auth);
  } catch (err) {
    // 失败/异常：该次不计入用量，立即归还占位
    releaseQuotaSlot(auth.auth);
    return new Response(JSON.stringify({ error: { message: (err as Error).message } }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    });
  }
}

// v3.9.3：CORS 预检（原 proxy.ts middleware 处理；matcher 排除 /v1/* 后移到 route 层）
export async function OPTIONS(request: NextRequest) {
  return corsPreflightResponse(request);
}

export async function GET(request: NextRequest) {
  return new Response(JSON.stringify({ error: { message: "Method Not Allowed" } }), {
    status: 405,
    headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
  });
}
