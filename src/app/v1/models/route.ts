// GET /v1/models —— 模型列表接口（OpenAI 兼容目录结构，含 opencode 免费模型池）。
import { NextRequest } from "next/server";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireGatewayAuth(request);
  if (!auth.ok) return auth.response;

  const config = auth.config;
  const fleet = getProviderFleet(config);
  const configuredModels = Object.keys(config.routes || {});
  const opencode = fleet.getProvider("opencode");
  const opencodeFreeModels =
    typeof (opencode as unknown as { getFreeModels?: () => string[] })?.getFreeModels === "function"
      ? (opencode as unknown as { getFreeModels: () => string[] }).getFreeModels()
      : [];
  const allModels = Array.from(new Set([...configuredModels, ...opencodeFreeModels]));

  return new Response(
    JSON.stringify({
      object: "list",
      data: allModels.map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: opencodeFreeModels.includes(id) ? "opencode-zen-free" : "worker-gateway",
      })),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }
  );
}
