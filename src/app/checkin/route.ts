// POST /checkin —— 手动签到接口。
// 需要 Master Key 或 Cron Secret：此接口会触发上游真实签到，不能对普通虚拟密钥开放。
// Cron secret 只能触发定时任务，无法调用 Admin API（因 isMaster: false 被 /admin 网关拦截）。
// v4.2.4：接入签到提供商白名单（与调度器 cron 路径同语义——空数组 = 全部支持签到的提供商）；
// 响应附 scope 字段透明化本轮实际生效范围，便于自动化脚本核对。
import { NextRequest } from "next/server";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { getRuntimeSettingsAsync } from "@/lib/gateway/config/runtimeSettings";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireGatewayAuth(request, { requireMaster: true, allowCron: true });
  if (!auth.ok) return auth.response;

  const fleet = getProviderFleet(auth.config);
  // v4.2.4：热读签到提供商白名单（与 jobs/scheduler.ts runJob 同语义）
  const { checkinProviders } = await getRuntimeSettingsAsync();
  const results = await fleet.runDailyCheckins(
    Array.isArray(checkinProviders) ? checkinProviders : []
  );
  // 余额缓存失效：签到后积分变化，下一次 /v1/usage 穿透查询
  const { invalidateBalanceCache } = await import("@/lib/gateway/core/fleet");
  invalidateBalanceCache();
  return new Response(
    JSON.stringify(
      {
        success: true,
        scope: {
          // 空 = 全部支持签到的提供商；非空 = 白名单限定
          providers: checkinProviders.length > 0 ? checkinProviders : "all",
          checked: results.length,
        },
        results,
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }
  );
}

// 兼容 GET（curl 便捷触发；原版仅 POST，此处保持 POST 为主，GET 返回方法提示）
export async function GET(request: NextRequest) {
  return new Response(
    JSON.stringify({ error: { message: "Method Not Allowed. Use POST with Master Key or Cron Secret." } }),
    { status: 405, headers: { "Content-Type": "application/json", ...corsHeadersFor(request) } }
  );
}
