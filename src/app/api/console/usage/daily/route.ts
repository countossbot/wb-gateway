// GET /api/console/usage/daily?days=7[&day=YYYY-MM-DD] —— UsageDaily 维度查询（透视表）。
// v3.1.1：清偿 Task 13/14 遗留 ——「UsageDaily 维度查询接口（按提供商 × 密钥透视表）」。
// 数据源 UsageDaily（day × providerId × apiKeyName 聚合表），不受 RequestLog 5000 条滚动窗口截断；
// 已含今日（实时链路写入），历史天由回填任务保证。
//
// 响应形态：
// {
//   days: 7,                          // 实际覆盖天数
//   range: { from, to },              // 日期范围（含端点）
//   rows: [                           // 原始明细行（day × provider × key）
//     { day, providerId, apiKeyName, requests, okRequests, successRate,
//       inputTokens, outputTokens, cachedTokens }
//   ],
//   pivot: {                          // 透视汇总
//     byProvider: [ { providerId, requests, okRequests, tokens... } ],  // 降序
//     byKey:      [ { apiKeyName,  requests, okRequests, tokens... } ],  // 降序
//     byDay:      [ { day, requests, okRequests, tokens... } ],          // 升序
//     totals:     { requests, okRequests, inputTokens, outputTokens, cachedTokens }
//   }
// }
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { localDayKey } from "@/lib/gateway/config/requestLog";

export const dynamic = "force-dynamic";

const MAX_DAYS = 90;

function isValidDayKey(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

interface AggBucket {
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const params = request.nextUrl.searchParams;
  const singleDay = params.get("day");
  let fromKey: string;
  let toKey: string;

  if (isValidDayKey(singleDay)) {
    fromKey = singleDay;
    toKey = singleDay;
  } else {
    const days = Math.min(MAX_DAYS, Math.max(1, Number(params.get("days")) || 7));
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    fromKey = localDayKey(from);
    toKey = localDayKey();
  }

  let rows;
  try {
    rows = await db.usageDaily.findMany({
      where: { day: { gte: fromKey, lte: toKey } },
      orderBy: [{ day: "asc" }, { requests: "desc" }],
    });
  } catch (e) {
    return fail(`UsageDaily 查询失败: ${e instanceof Error ? e.message : String(e)}`, 500);
  }

  const totals = { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const byProvider = new Map<string, AggBucket>();
  const byKey = new Map<string, AggBucket>();
  const byDay = new Map<string, AggBucket>();

  const bump = (m: Map<string, AggBucket>, k: string, r: (typeof rows)[number]) => {
    const b = m.get(k) || { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    b.requests += r.requests;
    b.okRequests += r.okRequests;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cachedTokens += r.cachedTokens;
    m.set(k, b);
  };

  for (const r of rows) {
    totals.requests += r.requests;
    totals.okRequests += r.okRequests;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cachedTokens += r.cachedTokens;
    bump(byProvider, r.providerId || "(unknown)", r);
    bump(byKey, r.apiKeyName || "(unknown)", r);
    bump(byDay, r.day, r);
  }

  const withRate = (x: AggBucket): AggBucket & { successRate: number | null } => ({
    ...x,
    successRate: x.requests > 0 ? Math.round((x.okRequests / x.requests) * 100) : null,
  });

  const byProviderRows = Array.from(byProvider.entries())
    .map(([name, v]) => ({ providerId: name, ...withRate(v) }))
    .sort((a, b) => b.requests - a.requests);
  const byKeyRows = Array.from(byKey.entries())
    .map(([name, v]) => ({ apiKeyName: name, ...withRate(v) }))
    .sort((a, b) => b.requests - a.requests);
  const byDayRows = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, v]) => ({ day: name, ...withRate(v) }));

  return ok({
    days: Math.abs(dayDiff(fromKey, toKey)) + 1,
    range: { from: fromKey, to: toKey },
    rows: rows.map((r) => ({
      day: r.day,
      providerId: r.providerId,
      apiKeyName: r.apiKeyName,
      requests: r.requests,
      okRequests: r.okRequests,
      successRate: r.requests > 0 ? Math.round((r.okRequests / r.requests) * 100) : null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedTokens: r.cachedTokens,
    })),
    pivot: {
      byProvider: byProviderRows,
      byKey: byKeyRows,
      byDay: byDayRows,
      totals: withRate({ ...totals }),
    },
  });
}

// YYYY-MM-DD 差值（UTC 语义近似即可，仅用于响应元信息）
function dayDiff(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const dbb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(dbb)) return 0;
  return Math.round((dbb - da) / 86_400_000);
}
