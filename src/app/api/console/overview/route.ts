// GET /api/console/overview —— 账户总览（验收要求三.3）：
// 聚合余额与积分、账号总数与启用数、提供商数量、模型路由数量、
// 上游前缀缓存命中率、最近一次签到与最近一次 Token 刷新时间、当前可用模型列表。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { getConfig } from "@/lib/gateway/config/configService";
import { getProviderFleet } from "@/lib/gateway/core/fleet";
import { VERSION } from "@/lib/gateway/config/configService";
import { localDayKey } from "@/lib/gateway/config/requestLog";

/** v3.9.0：Top 模型行结构（与 types.ts TopModelRow 同形；API 内部局部定义避免跨层依赖） */
interface TopModelRowShape {
  model: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const [config, accounts, providers, routes] = await Promise.all([
    getConfig(),
    db.account.findMany(),
    db.provider.findMany(),
    db.modelRoute.findMany({ include: { candidates: true } }),
  ]);

  const fleet = getProviderFleet(config);
  const bal = await fleet.getBalance();

  // 最近签到与最近 Token 刷新
  const lastCheckinLog = await db.checkinLog.findFirst({ orderBy: { createdAt: "desc" } });
  const lastCheckinAccounts = lastCheckinLog
    ? await db.checkinLog.findMany({
        where: { createdAt: { gte: new Date(lastCheckinLog.createdAt.getTime() - 60_000) } },
      })
    : [];
  const lastRefreshAccount = await db.account.findFirst({
    where: { lastRefreshAt: { not: null } },
    orderBy: { lastRefreshAt: "desc" },
  });

  // v3.0.6：今日消耗改读 UsageDaily 按日聚合（不再受 RequestLog 5000 条滚动窗口截断）
  const todayKey = localDayKey();
  const todayRows = await db.usageDaily.findMany({ where: { day: todayKey } });
  const todayTotal = todayRows.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      okRequests: acc.okRequests + r.okRequests,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cachedTokens: acc.cachedTokens + r.cachedTokens,
    }),
    { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  );
  const todayStats = {
    requests: todayTotal.requests,
    successRate:
      todayTotal.requests > 0 ? Math.round((todayTotal.okRequests / todayTotal.requests) * 100) : null,
    inputTokens: todayTotal.inputTokens,
    outputTokens: todayTotal.outputTokens,
    cachedTokens: todayTotal.cachedTokens,
  };

  // v3.1.1：今日 Top 密钥排行（UsageDaily 按密钥名维度聚合今日；剔除未知调用方；Top 5 按请求数降序）
  const todayKeyRows = await db.usageDaily.findMany({
    where: { day: todayKey, apiKeyName: { not: "" } },
    select: { apiKeyName: true, requests: true, okRequests: true, inputTokens: true, outputTokens: true, cachedTokens: true },
  });
  const keyAgg = new Map<string, { apiKeyName: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number }>();
  for (const r of todayKeyRows) {
    const b = keyAgg.get(r.apiKeyName) || { apiKeyName: r.apiKeyName, requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    b.requests += r.requests;
    b.okRequests += r.okRequests;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cachedTokens += r.cachedTokens;
    keyAgg.set(r.apiKeyName, b);
  }
  const todayTopKeys = Array.from(keyAgg.values())
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);

  // v3.2.0：昨日 Top 兜底 —— 今日零调用时改展示昨日 Top（卡片不再空洞无内容），
  // topKeysDate 标注数据归属日期（前端据此提示「今日暂无调用，展示昨日数据」）
  let topKeysDate = todayKey;
  let topKeys = todayTopKeys;
  if (topKeys.length === 0) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yKey = localDayKey(yesterday);
    const yRows = await db.usageDaily.findMany({
      where: { day: yKey, apiKeyName: { not: "" } },
      select: { apiKeyName: true, requests: true, okRequests: true, inputTokens: true, outputTokens: true, cachedTokens: true },
    });
    const yAgg = new Map<string, { apiKeyName: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number }>();
    for (const r of yRows) {
      const b = yAgg.get(r.apiKeyName) || { apiKeyName: r.apiKeyName, requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      b.requests += r.requests;
      b.okRequests += r.okRequests;
      b.inputTokens += r.inputTokens;
      b.outputTokens += r.outputTokens;
      b.cachedTokens += r.cachedTokens;
      yAgg.set(r.apiKeyName, b);
    }
    topKeys = Array.from(yAgg.values()).sort((a, b) => b.requests - a.requests).slice(0, 5);
    if (topKeys.length > 0) topKeysDate = yKey;
  }

  // v3.9.0：今日 Top 模型排行（RequestLog 按对外模型聚合本地今日 0 点窗口；UsageDaily 无模型维度，
  // 与 24h 趋势同口径；Top 5 按请求数降序；今日零调用时昨日兑底，口径与 Top 密钥一致）
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const yesterdayMidnight = new Date(todayMidnight);
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
  const [mTodayTotal, mTodayOk, mYesterdayTotal, mYesterdayOk] = await Promise.all([
    db.requestLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: todayMidnight } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cachedTokens: true },
    }),
    db.requestLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: todayMidnight }, status: { gte: 200, lt: 400 } },
      _count: { _all: true },
    }),
    db.requestLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: yesterdayMidnight, lt: todayMidnight } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cachedTokens: true },
    }),
    db.requestLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: yesterdayMidnight, lt: todayMidnight }, status: { gte: 200, lt: 400 } },
      _count: { _all: true },
    }),
  ]);
  const toTopModels = (
    totals: typeof mTodayTotal,
    okRows: Array<{ model: string; _count: { _all: number } }>
  ): TopModelRowShape[] => {
    const okMap = new Map(okRows.map((r) => [r.model, r._count._all]));
    return totals
      .map((r) => ({
        model: r.model,
        requests: r._count._all,
        okRequests: okMap.get(r.model) ?? 0,
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
        cachedTokens: r._sum.cachedTokens ?? 0,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 5);
  };
  let topModelsDate = todayKey;
  let topModels = toTopModels(mTodayTotal, mTodayOk);
  if (topModels.length === 0) {
    topModels = toTopModels(mYesterdayTotal, mYesterdayOk);
    if (topModels.length > 0) topModelsDate = localDayKey(yesterdayMidnight);
  }

  // v3.0.6：近 7 天日趋势（UsageDaily groupBy day；含今日；跨滚动窗口持久准确）
  // v3.5.0：一次拉取 14 天切两半 → 附带前 7 天汇总 trend7d_prev（前端环比徽标）
  const dayKeys14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return localDayKey(d);
  });
  const dayKeys7 = dayKeys14.slice(7);
  const prevKeys7 = dayKeys14.slice(0, 7);
  const trend7Rows = await db.usageDaily.findMany({ where: { day: { in: dayKeys14 } } });
  const trend7Map = new Map<string, { requests: number; okRequests: number; inputTokens: number; outputTokens: number }>();
  for (const r of trend7Rows) {
    const b = trend7Map.get(r.day) || { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0 };
    b.requests += r.requests;
    b.okRequests += r.okRequests;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    trend7Map.set(r.day, b);
  }
  const trend7d = dayKeys7.map((day) => ({ day, ...(trend7Map.get(day) || { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0 }) }));
  const trend7dPrev = prevKeys7.reduce(
    (acc, day) => {
      const b = trend7Map.get(day);
      if (b) {
        acc.requests += b.requests;
        acc.okRequests += b.okRequests;
        acc.inputTokens += b.inputTokens;
        acc.outputTokens += b.outputTokens;
      }
      return acc;
    },
    { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0 }
  );

  // v3.9.1：上游前缀缓存命中统计改为 RequestLog 持久聚合（修复「命中率一直 0%」）。
  // 旧实现 snapshotCacheStats() 为进程内存计数，dev 重启/HMR 后清零导致页面恒显 0%；
  // 新口径：分母 = 上游报告了精确 usage 的请求（usageExact=true），分子 = 其中 cachedTokens>0 者
  // （dispatch 落库时 cachedTokens=0 与「上游未报缓存」同为 null，故命中判定用 gt 0）。
  // 重启不丢、跨滚动窗口持久；/admin/api/status 机器接口仍用进程级 cacheStats 实时计数。
  const [cacheUsageRows, cacheHitRows, cacheHitAgg] = await Promise.all([
    db.requestLog.count({ where: { usageExact: true } }),
    db.requestLog.count({ where: { usageExact: true, cachedTokens: { gt: 0 } } }),
    db.requestLog.aggregate({ _sum: { cachedTokens: true }, where: { usageExact: true, cachedTokens: { gt: 0 } } }),
  ]);
  const cacheStats = {
    responses: cacheUsageRows,
    cachedResponses: cacheHitRows,
    cachedTokens: cacheHitAgg._sum.cachedTokens ?? 0,
    hitRate: cacheUsageRows > 0 ? Math.round((cacheHitRows / cacheUsageRows) * 1000) / 10 : 0,
  };

  // v3.0.4：近 24h 逐小时趋势（24 个整点桶，含成功/失败与 token 用量；滚动窗口内精确）
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const trendRows = await db.requestLog.findMany({
    where: { createdAt: { gte: since24h } },
    select: { createdAt: true, status: true, inputTokens: true, outputTokens: true },
  });
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const firstBucket = Math.floor(now / hourMs) * hourMs - 23 * hourMs; // 最早的整点桶起点
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(firstBucket + i * hourMs).toISOString(),
    requests: 0,
    okRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
  }));
  for (const row of trendRows) {
    const idx = Math.floor((row.createdAt.getTime() - firstBucket) / hourMs);
    if (idx < 0 || idx >= 24) continue;
    const b = buckets[idx];
    b.requests += 1;
    if ((row.status ?? 0) >= 200 && (row.status ?? 0) < 400) b.okRequests += 1;
    b.inputTokens += row.inputTokens || 0;
    b.outputTokens += row.outputTokens || 0;
  }
  const trend24h = buckets;

  // 可用模型列表（路由配置 + opencode 免费池）
  const opencode = fleet.getProvider("opencode");
  const opencodeFreeModels =
    typeof (opencode as unknown as { getFreeModels?: () => string[] })?.getFreeModels === "function"
      ? (opencode as unknown as { getFreeModels: () => string[] }).getFreeModels()
      : [];
  const availableModels = Array.from(new Set([...Object.keys(config.routes || {}), ...opencodeFreeModels]));

  // 各账号最近签到明细（聚合展示）
  const accountsWithState = accounts.map((a) => ({
    id: a.id,
    providerId: a.providerId,
    name: a.name,
    enabled: a.enabled,
    balance: a.balance as Record<string, unknown> | null,
    cooldownUntil: a.cooldownUntil?.toISOString() || null,
    cooldownStreak: a.cooldownStreak,
    cooldownReason: a.cooldownReason,
    lastCheckinAt: a.lastCheckinAt?.toISOString() || null,
    lastCheckinOk: a.lastCheckinOk,
    lastRefreshAt: a.lastRefreshAt?.toISOString() || null,
  }));

  return ok({
    version: VERSION,
    balance: {
      balance: bal.balance,
      total: bal.total,
      unit: bal.unit || "积分",
      accounts: bal.accounts || [],
    },
    accounts_total: accounts.length,
    accounts_enabled: accounts.filter((a) => a.enabled).length,
    providers_count: fleet.activeCount,
    providers_total: providers.length,
    routes_count: Object.keys(config.routes || {}).length,
    routes_total: routes.length,
    cache: cacheStats,
    today_stats: todayStats,
    today_top_keys: topKeys,
    top_keys_date: topKeysDate,
    today_top_models: topModels,
    top_models_date: topModelsDate,
    trend24h,
    trend7d,
    trend7d_prev: trend7dPrev,
    last_checkin: lastCheckinLog
      ? {
          time: lastCheckinLog.createdAt.toISOString(),
          provider: lastCheckinLog.providerId,
          details: lastCheckinAccounts.map((l) => ({
            accountId: l.accountId,
            accountName: l.accountName,
            success: l.success,
          })),
        }
      : null,
    last_refresh: lastRefreshAccount?.lastRefreshAt?.toISOString() || null,
    available_models: availableModels,
    accounts: accountsWithState,
  });
}
