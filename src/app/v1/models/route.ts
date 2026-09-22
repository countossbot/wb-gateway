// GET /v1/models —— 模型列表接口（OpenAI 兼容目录结构）。
import { NextRequest } from "next/server";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireGatewayAuth(request);
  if (!auth.ok) return auth.response;

  const configuredModels = Object.keys(auth.config.routes || {});

  return new Response(
    JSON.stringify({
      object: "list",
      data: configuredModels.map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "worker-gateway",
      })),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }
  );
}
