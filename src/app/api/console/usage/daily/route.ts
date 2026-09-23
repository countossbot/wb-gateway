// GET /api/console/usage/daily?days=7[&day=YYYY-MM-DD] —— UsageDaily 维度查询（透视表）。
// v3.1.1：清偿 Task 13/14 遗留 ——「UsageDaily 维度查询接口（按提供商 × 密钥透视表）」。
// 数据源 UsageDaily（day × providerId × apiKeyName × model 聚合表，v4.2.3 增模型维度），
// 不受 RequestLog 5000 条滚动窗口截断；已含今日（实时链路写入，30s 批量 flush），
// 历史天由回填任务保证。
//
// 响应形态：
// {
//   days: 7,                          // 实际覆盖天数
//   range: { from, to },              // 日期范围（含端点）
//   rows: [                           // 原始明细行（day × provider × key × model）
//     { day, providerId, apiKeyName, model, requests, okRequests, successRate,
//       inputTokens, outputTokens, cachedTokens, cost }
//   ],
//   pivot: {                          // 透视汇总（各维度对 model 维度行求和）
//     byProvider: [ { providerId, requests, okRequests, tokens..., cost, pricedRequests, unpricedRequests } ],  // 降序
//     byKey:      [ { apiKeyName,  requests, okRequests, tokens..., cost } ],  // 降序
//     byModel:    [ { model,       requests, okRequests, tokens..., cost } ],  // 降序（v4.2.3；model="" 排除）
//     byDay:      [ { day, requests, okRequests, tokens..., cost } ],          // 升序
//     totals:     { requests, okRequests, inputTokens, outputTokens, cachedTokens, cost, pricedRequests, unpricedRequests }
//   }
// }
// v4.4.0：cost 字段 = 按 ModelPricing 单价表估算（$/百万 tokens；未配置单价 → null 行级 /
// 桶级计价请求数 0）；桶级成本由模型维度逐行累加后再汇总（不能由聚合后的 token 直接乘单价）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { localDayKey } from "@/lib/gateway/config/requestLog";
import { loadPricingMap, estimateRowCost, EMPTY_COST_AGG, type CostAgg } from "@/lib/console/pricing";

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
  cost: CostAgg; // v4.4.0：桶级成本聚合（模型维度逐行计价后归入桶）
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

  // v4.4.0：单价表一次性加载（模型维度逐行计价 → 各桶累加）
  const pricing = await loadPricingMap();
  const rowCosts = new Map<number, number | null>(); // rows 下标 → 行级成本
  for (let i = 0; i < rows.length; i++) {
    rowCosts.set(i, estimateRowCost(pricing, rows[i].model, rows[i].inputTokens, rows[i].outputTokens, rows[i].cachedTokens));
  }

  const totals = { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: { ...EMPTY_COST_AGG } };
  const byProvider = new Map<string, AggBucket>();
  const byKey = new Map<string, AggBucket>();
  const byModel = new Map<string, AggBucket>();
  const byDay = new Map<string, AggBucket>();

  const emptyBucket = (): AggBucket => ({
    requests: 0,
    okRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cost: { ...EMPTY_COST_AGG },
  });

  const bump = (m: Map<string, AggBucket>, k: string, r: (typeof rows)[number], cost: number | null) => {
    const b = m.get(k) || emptyBucket();
    b.requests += r.requests;
    b.okRequests += r.okRequests;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cachedTokens += r.cachedTokens;
    if (cost === null) {
      b.cost.unpricedRequests += r.requests;
    } else {
      b.cost.cost += cost;
      b.cost.pricedRequests += r.requests;
    }
    m.set(k, b);
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cost = rowCosts.get(i) ?? null;
    totals.requests += r.requests;
    totals.okRequests += r.okRequests;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cachedTokens += r.cachedTokens;
    if (cost === null) {
      totals.cost.unpricedRequests += r.requests;
    } else {
      totals.cost.cost += cost;
      totals.cost.pricedRequests += r.requests;
    }
    bump(byProvider, r.providerId || "(unknown)", r, cost);
    bump(byKey, r.apiKeyName || "(unknown)", r, cost);
    if (r.model) bump(byModel, r.model, r, cost); // v4.2.3：模型维度透视（空串=历史未细分，不单列）
    bump(byDay, r.day, r, cost);
  }

  const withRate = (x: AggBucket): AggBucket & { successRate: number | null } => ({
    ...x,
    cost: { ...x.cost, cost: Math.round(x.cost.cost * 1e6) / 1e6 },
    successRate: x.requests > 0 ? Math.round((x.okRequests / x.requests) * 100) : null,
  });

  const byProviderRows = Array.from(byProvider.entries())
    .map(([name, v]) => ({ providerId: name, ...withRate(v) }))
    .sort((a, b) => b.requests - a.requests);
  const byKeyRows = Array.from(byKey.entries())
    .map(([name, v]) => ({ apiKeyName: name, ...withRate(v) }))
    .sort((a, b) => b.requests - a.requests);
  const byModelRows = Array.from(byModel.entries())
    .map(([name, v]) => ({ model: name, ...withRate(v) }))
    .sort((a, b) => b.requests - a.requests);
  const byDayRows = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, v]) => ({ day: name, ...withRate(v) }));

  const totalsOut = withRate(totals);

  return ok({
    days: Math.abs(dayDiff(fromKey, toKey)) + 1,
    range: { from: fromKey, to: toKey },
    rows: rows.map((r, i) => ({
      day: r.day,
      providerId: r.providerId,
      apiKeyName: r.apiKeyName,
      model: r.model,
      requests: r.requests,
      okRequests: r.okRequests,
      successRate: r.requests > 0 ? Math.round((r.okRequests / r.requests) * 100) : null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedTokens: r.cachedTokens,
      // v4.4.0：行级成本（模型未配置单价 → null）
      cost: rowCosts.get(i) ?? null,
    })),
    pivot: {
      byProvider: byProviderRows,
      byKey: byKeyRows,
      byModel: byModelRows,
      byDay: byDayRows,
      totals: totalsOut,
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
