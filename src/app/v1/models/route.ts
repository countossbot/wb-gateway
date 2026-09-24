// GET /v1/models —— 模型列表接口（OpenAI 兼容目录结构）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { DEFAULT_ROUTES } from "@/lib/gateway/config/configService";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireGatewayAuth(request);
  if (!auth.ok) return auth.response;

  // 1. 先取 DB 中已启用、且有候选的模型路由（优先）
  const rows = await db.modelRoute.findMany({
    where: { enabled: true, candidates: { some: { enabled: true } } },
    select: { model: true },
    orderBy: { id: "asc" },
  });

  // 2. 再取 DEFAULT_ROUTES 的全部键
  const defaults = Object.keys(DEFAULT_ROUTES);

  // 3. 去重合并：DB 路由在前，默认列表补齐缺失项
  const seen = new Set<string>();
  const configuredModels: string[] = [];
  for (const m of [...rows.map((row) => row.model), ...defaults]) {
    if (!seen.has(m)) {
      seen.add(m);
      configuredModels.push(m);
    }
  }

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
    },
  );
}