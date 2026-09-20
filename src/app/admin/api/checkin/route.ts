// POST /admin/api/checkin —— 手动触发全部活跃账号池签到。
import { NextRequest } from "next/server";
import { requireAdminAuth, jsonResponse } from "@/lib/gateway/http/routeHelpers";
import { getProviderFleet, invalidateBalanceCache } from "@/lib/gateway/core/fleet";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  const fleet = getProviderFleet(auth.config);
  const results = await fleet.runDailyCheckins();
  invalidateBalanceCache();
  return jsonResponse({ success: true, results }, 200, request);
}
