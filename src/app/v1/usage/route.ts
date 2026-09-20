// GET /v1/usage —— 余额与积分查询（兼容 CC-Switch，响应结构不得改动）。
// 原版同时匹配 /usage 后缀；裸 /usage 变体见 src/app/usage/route.ts（同实现重导出）。
import { NextRequest } from "next/server";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireGatewayAuth(request);
  if (!auth.ok) return auth.response;

  const fleet = getProviderFleet(auth.config);
  const bal = await fleet.getBalance();
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        balance: bal.balance,
        total: bal.total,
        unit: bal.unit || "积分",
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }
  );
}
