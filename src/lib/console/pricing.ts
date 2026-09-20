// 模型单价与成本估算核心（v4.4.0）—— 供 usage/daily、overview、insights、logs 等聚合
// API 复用同一套计价口径，防两处漂移（与 overviewInsights 共享层同思路）。
//
// 计价语义（注释即契约，前端脚注同口径展示）：
// - 单位统一「$/百万 tokens」，由管理员按上游实际结算价填写（估算展示，非真实计费）；
// - cost = inputTokens × inputPerMTok + outputTokens × outputPerMTok
//        + cachedTokens × cachedPerMTok（未配置 cached 单价时缓存命中按 0 计）；
// - inputTokens 与 cachedTokens 为独立维度（Anthropic cache_read / OpenAI
//   prompt_tokens_details.cached 均不含在 input_tokens 内，见 requestLog 记账链路）；
// - 未配置单价的模型不计成本（估算口径「保守可见」：显示覆盖 badge 而非拍脑袋估值）；
// - UsageDaily 历史行（model=""，v4.2.3 前）天然无法计价，归入未计价口径。
import { db } from "@/lib/db";

/** 单价条目（$/1M tokens） */
export interface PricingEntry {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok: number;
}

/** DB 行（GET /api/console/pricing 回显） */
export interface PricingRow extends PricingEntry {
  updatedAt: string;
  updatedBy: string;
}

/** 加载全部单价（model → 单价）。表规模为管理员手工配置（≤ 数百行），整表查询即可。 */
export async function loadPricingMap(): Promise<Map<string, PricingEntry>> {
  const rows = await db.modelPricing.findMany();
  const map = new Map<string, PricingEntry>();
  for (const r of rows) {
    map.set(r.model, {
      model: r.model,
      inputPerMTok: r.inputPerMTok,
      outputPerMTok: r.outputPerMTok,
      cachedPerMTok: r.cachedPerMTok,
    });
  }
  return map;
}

/** 单行估算：未配置单价（或无 token 记录）返回 null —— 调用方归入「未计价」口径。 */
export function estimateRowCost(
  map: Map<string, PricingEntry>,
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number
): number | null {
  const entry = model ? map.get(model) : undefined;
  if (!entry) return null;
  const cost =
    (inputTokens * entry.inputPerMTok +
      outputTokens * entry.outputPerMTok +
      cachedTokens * entry.cachedPerMTok) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6; // 微美元级四舍五入防浮点尾噪
}

/** 成本聚合桶（各 API 透视/卡片共用） */
export interface CostAgg {
  /** 窗口内已计价请求的估算成本合计（$，6 位小数舍入） */
  cost: number;
  /** 已计价请求数 */
  pricedRequests: number;
  /** 未计价请求数（模型未配置单价 / 历史行 model="" / 无 token 记录） */
  unpricedRequests: number;
}

export const EMPTY_COST_AGG: CostAgg = { cost: 0, pricedRequests: 0, unpricedRequests: 0 };

/** 逐行累加进桶（rows 需含 model 与三 token 维度） */
export function accumulateCost(
  agg: CostAgg,
  map: Map<string, PricingEntry>,
  row: { model: string | null | undefined; requests: number; inputTokens: number; outputTokens: number; cachedTokens: number }
): void {
  const c = estimateRowCost(map, row.model, row.inputTokens, row.outputTokens, row.cachedTokens);
  if (c === null) {
    agg.unpricedRequests += row.requests;
  } else {
    agg.cost += c;
    agg.pricedRequests += row.requests;
  }
}

/** 合并两个桶（分层聚合用） */
export function mergeCostAgg(a: CostAgg, b: CostAgg): CostAgg {
  return {
    cost: a.cost + b.cost,
    pricedRequests: a.pricedRequests + b.pricedRequests,
    unpricedRequests: a.unpricedRequests + b.unpricedRequests,
  };
}

/** 计价覆盖率（0-100，一位小数；无请求时 null） */
export function costCoverage(agg: CostAgg): number | null {
  const total = agg.pricedRequests + agg.unpricedRequests;
  return total > 0 ? Math.round((agg.pricedRequests / total) * 1000) / 10 : null;
}

/**
 * 近 N 天出现过但未配置单价的模型清单（GET /api/console/pricing 附带，
 * 供设置页「一键补录」chips；按请求量降序 Top 20）。
 */
export async function unpricedModels(days: number): Promise<Array<{ model: string; requests: number }>> {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const { localDayKey } = await import("@/lib/gateway/config/requestLog");
  const fromKey = localDayKey(since);
  const rows = await db.usageDaily.groupBy({
    by: ["model"],
    _sum: { requests: true },
    where: { day: { gte: fromKey }, model: { not: "" } },
    orderBy: { _sum: { requests: "desc" } },
    take: 40,
  });
  const priced = await db.modelPricing.findMany({ select: { model: true } });
  const pricedSet = new Set(priced.map((p) => p.model));
  return rows
    .filter((r) => !pricedSet.has(r.model))
    .map((r) => ({ model: r.model, requests: r._sum.requests ?? 0 }))
    .slice(0, 20);
}
