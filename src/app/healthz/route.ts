// GET /healthz —— 健康检查（公开）。
// 当零可用 provider 或零路由时标记 degraded，避免永远 ok。
import { NextRequest } from "next/server";
import { getConfig, VERSION } from "@/lib/gateway/config/configService";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const config = await getConfig();
  const fleet = getProviderFleet(config);
  const hasProviders = fleet.activeCount > 0;
  const hasRoutes = Object.keys(config.routes || {}).length > 0;
  const status = hasProviders && hasRoutes ? "ok" : "degraded";
  return new Response(
    JSON.stringify({
      status,
      service: "universal-ai-gateway",
      version: VERSION,
      providers_active: fleet.activeCount,
      models_available: Object.keys(config.routes || {}).length,
      time: new Date().toISOString(),
    }),
    {
      status: status === "ok" ? 200 : 503,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }
  );
}
