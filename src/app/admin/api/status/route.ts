// GET /admin/api/status —— 实时聚合状态（余额、账号、最近签到/刷新、缓存统计）。
// v3.0.7：新增 usage_daily（近 7 天按日用量汇总，UsageDaily 聚合——Agent-Native 消费，不受滚动日志窗口截断）。
import { NextRequest } from "next/server";
import { requireAdminAuth, jsonResponse } from "@/lib/gateway/http/routeHelpers";
import { getProviderFleet, invalidateBalanceCache } from "@/lib/gateway/core/fleet";
import { snapshotCacheStats } from "@/lib/gateway/core/cacheStats";
import { VERSION } from "@/lib/gateway/config/configService";
import { localDayKey } from "@/lib/gateway/config/requestLog";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  const config = await auth.config;

  // 最近签到 / 最近刷新（原 KV LAST_CHECKIN / LAST_REFRESH 语义 → CheckinLog / Account 聚合）
  let lastCheckin: unknown = null;
  let lastRefresh: string | null = null;
  try {
    const lastCheckinLog = await db.checkinLog.findFirst({ orderBy: { createdAt: "desc" } });
    if (lastCheckinLog) {
      const logs = await db.checkinLog.findMany({
        where: { createdAt: { gte: new Date(lastCheckinLog.createdAt.getTime() - 60_000) } },
        orderBy: { createdAt: "asc" },
      });
      lastCheckin = {
        time: lastCheckinLog.createdAt.toISOString(),
        provider: lastCheckinLog.providerId,
        accounts_count: logs.length,
        results: logs.map((l) => ({
          id: l.accountId,
          name: l.accountName,
          success: l.success,
          result: l.result,
        })),
      };
    }
    const lastRefreshAccount = await db.account.findFirst({
      where: { lastRefreshAt: { not: null } },
      orderBy: { lastRefreshAt: "desc" },
      select: { lastRefreshAt: true },
    });
    lastRefresh = lastRefreshAccount?.lastRefreshAt?.toISOString() || null;
  } catch {
    /* noop */
  }

  const fleet = getProviderFleet(config);
  const bal = await fleet.getBalance();

  // v3.0.7：近 7 天按日用量汇总（UsageDaily 全维度聚合；含今日；Agent-Native 可直接消费）
  let usageDaily: unknown = null;
  try {
    const dayKeys = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      return localDayKey(d);
    });
    const rows = await db.usageDaily.findMany({ where: { day: { in: dayKeys } } });
    const byDay = new Map<string, { requests: number; ok_requests: number; input_tokens: number; output_tokens: number; cached_tokens: number; providers: number }>();
    for (const r of rows) {
      const b = byDay.get(r.day) || { requests: 0, ok_requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, providers: 0 };
      b.requests += r.requests;
      b.ok_requests += r.okRequests;
      b.input_tokens += r.inputTokens;
      b.output_tokens += r.outputTokens;
      b.cached_tokens += r.cachedTokens;
      if (r.providerId !== "") b.providers += 1;
      byDay.set(r.day, b);
    }
    usageDaily = dayKeys.map((day) => ({ day, ...(byDay.get(day) || { requests: 0, ok_requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, providers: 0 }) }));
  } catch {
    /* noop：聚合失败不影响主状态 */
  }

  return jsonResponse(
    {
      service: "universal-ai-gateway",
      version: VERSION,
      time: new Date().toISOString(),
      balance: bal.balance,
      total_balance: bal.total,
      // v4.1.2：`|| 1` → `?? 1` —— 空库/查询失败时 fleet 已明确返回 accounts_count=0，
      // 旧的 `|| 1` 会把 0 覆盖成 1 造成「accounts_count: 1 且 accounts: []」的矛盾展示
      accounts_count: bal.accounts_count ?? 1,
      accounts: bal.accounts || [],
      last_checkin: lastCheckin,
      last_refresh: lastRefresh,
      providers_count: fleet.activeCount,
      routes_count: Object.keys(config.routes || {}).length,
      cache: snapshotCacheStats(),
      usage_daily: usageDaily,
    },
    200,
    request
  );
}

// POST /admin/api/status?refreshBalance=1 —— 顺带强制刷新余额缓存（控制台「刷新」按钮）
export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  invalidateBalanceCache();
  return GET(request);
}
