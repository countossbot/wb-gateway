// POST /api/console/routes/test —— 控制台路由真实中转试跑。
// 复用生产 dispatchExchange：路由、故障转移、协议转译、代理、账号池、冷却、计费与请求日志均走真实链路。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { getConfig } from "@/lib/gateway/config/configService";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { dispatchExchange, type DispatchTraceEvent } from "@/lib/gateway/exchange/exchange";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function traceHeaders(
  trace: DispatchTraceEvent[],
  startedAt: number,
  response: Response,
  balance?: { success: boolean; total: number; unit: string } | null
): Headers {
  const headers = new Headers(response.headers);
  headers.set("X-Test-Trace", JSON.stringify(trace));
  headers.set("X-Test-Latency", String(Date.now() - startedAt));
  if (balance) headers.set("X-Test-Balance", JSON.stringify(balance));
  return headers;
}

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  if (!session) return fail("未登录或会话已过期", 401);

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return fail("请求体不是有效 JSON");

  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const protocol = raw.protocol === "anthropic" ? "anthropic" : raw.protocol === "openai" ? "openai" : null;
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  const system = typeof raw.system === "string" ? raw.system.trim() : "";
  const stream = raw.stream === true;
  const maxTokens = Math.min(Math.max(Math.floor(Number(raw.maxTokens) || 128), 1), 4096);
  const temperature = raw.temperature === undefined ? undefined : Number(raw.temperature);

  if (!model) return fail("缺少模型名");
  if (!protocol) return fail("协议必须是 openai 或 anthropic");
  if (!prompt) return fail("用户消息不能为空");
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return fail("temperature 必须在 0-2 之间");
  }

  const body: Record<string, unknown> = protocol === "anthropic"
    ? {
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        stream,
        ...(system ? { system } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      }
    : {
        model,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
        stream,
        ...(temperature !== undefined ? { temperature } : {}),
      };

  const trace: DispatchTraceEvent[] = [];
  const startedAt = Date.now();
  const config = await getConfig();
  const fleet = getProviderFleet(config);

  try {
    const upstreamResponse = await dispatchExchange({
      protocol,
      model,
      body,
      fleet,
      config,
      request,
      apiKeyName: "console-test",
      onDispatchEvent: (event) => trace.push(event),
    });

    const successEvent = trace.find((event) => event.type === "success");
    const providerBalance = successEvent
      ? await fleet.getBalance(successEvent.provider)
      : null;
    const balanceSummary = providerBalance
      ? { success: !!providerBalance.success, total: providerBalance.total ?? 0, unit: providerBalance.unit || "积分" }
      : null;
    const headers = traceHeaders(trace, startedAt, upstreamResponse, balanceSummary);

    if (upstreamResponse.headers.get("content-type")?.includes("text/event-stream") && upstreamResponse.body) {
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers,
      });
    }

    const text = await upstreamResponse.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 非 JSON 上游响应保持字符串，便于控制台排查。
    }
    return ok({
      status: upstreamResponse.status,
      latencyMs: Date.now() - startedAt,
      meta: {
        account: upstreamResponse.headers.get("X-Gateway-Account"),
        upstreamModel: upstreamResponse.headers.get("X-Gateway-Model"),
        fallback: upstreamResponse.headers.get("X-Gateway-Fallback") === "true",
        contentType: upstreamResponse.headers.get("content-type") || "",
        providerBalance: balanceSummary,
      },
      trace,
      body: parsed,
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    });
  }
}
