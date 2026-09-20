// POST /admin/api/refresh —— 强制刷新全部缓存与落库的 AccessToken。
import { NextRequest } from "next/server";
import { requireAdminAuth, jsonResponse } from "@/lib/gateway/http/routeHelpers";
import { getProviderFleet } from "@/lib/gateway/core/fleet";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  const fleet = getProviderFleet(auth.config);
  const results = await fleet.refreshAllTokens();
  return jsonResponse({ success: true, results }, 200, request);
}
