// GET /v1/models —— 模型列表（OpenAI 兼容）。有启用路由就只用路由；一条都没有才用默认列表。
// 不读 getConfig().routes：backfillMissingRoutes 会把 DEFAULT_ROUTES 补进那份对象。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { DEFAULT_ROUTES } from "@/lib/gateway/config/configService";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireGatewayAuth(request);
  if (!auth.ok) return auth.response;

  const rows = await db.modelRoute.findMany({
    where: { enabled: true, candidates: { some: { enabled: true } } },
    select: { model: true },
    orderBy: { id: "asc" },
  });
  const configuredModels = rows.length > 0 ? rows.map((row) => row.model) : Object.keys(DEFAULT_ROUTES);

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
