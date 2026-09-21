// POST /admin/api/checkin —— 手动触发签到。
// v4.2.4：接入签到提供商白名单（与调度器 cron 路径及 /checkin 同语义——
// 热读运行时设置 checkinProviders，空数组 = 全部支持签到的提供商）；
// 响应附 scope 字段透明化实际生效范围。
import { NextRequest } from "next/server";
import { requireAdminAuth, jsonResponse } from "@/lib/gateway/http/routeHelpers";
import { getProviderFleet, invalidateBalanceCache } from "@/lib/gateway/core/fleet";
import { getRuntimeSettingsAsync } from "@/lib/gateway/config/runtimeSettings";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  const fleet = getProviderFleet(auth.config);
  // v4.2.4：热读签到提供商白名单（与 jobs/scheduler.ts runJob 同语义）
  const { checkinProviders } = await getRuntimeSettingsAsync();
  const results = await fleet.runDailyCheckins(
    Array.isArray(checkinProviders) ? checkinProviders : []
  );
  invalidateBalanceCache();
  return jsonResponse(
    {
      success: true,
      scope: {
        // 空 = 全部支持签到的提供商；非空 = 白名单限定
        providers: checkinProviders.length > 0 ? checkinProviders : "all",
        checked: results.length,
      },
      results,
    },
    200,
    request
  );
}
