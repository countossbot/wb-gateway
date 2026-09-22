// GET /api/console/usage/billing?month=YYYY-MM —— 月度账单（v4.5.0）。
// Task 47 顺延项落地：按虚拟密钥分组的月度成本报表（管理员「看话费账单」视角）。
//
// 数据源 UsageDaily（day × providerId × apiKeyName × model 聚合表）：
// - rows 按 apiKeyName 分组（含 byModel 明细，模型维度逐行计价后归桶——不能由聚合 token 直接乘单价）；
// - totals 全月合计 + prevMonth 上月合计（环比徽标数据）；
// - months 有数据的月份清单（前端月份选择器数据源，降序）；
// - unpricedModels 当月未计价模型提示（补录引导，与设置页同口径）。
//
// 月份校验：YYYY-MM 正则 + 不晚于当前月 + 不早于 2020-01；非法回落当前月。
// 成本口径：与成本卡/透视/密钥预算完全同源（lib/console/pricing 单点）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { localDayKey } from "@/lib/gateway/config/requestLog";
import { loadPricingMap, estimateRowCost, EMPTY_COST_AGG, type CostAgg } from "@/lib/console/pricing";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 本地时区当前月（YYYY-MM） */
function currentMonthKey(): string {
  return localDayKey().slice(0, 7);
}

/** 上一个月（YYYY-MM；1 月 → 上年 12 月） */
function prevMonthKey(month: string): string {
  const y = parseInt(month.slice(0, 4), 10);
  const m = parseInt(month.slice(5, 7), 10);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function normalizeMonth(raw: string | null): string {
  if (!raw || !MONTH_RE.test(raw)) return currentMonthKey();
  // 不晚于当前月（未来月无数据）、不早于 2020-01（防脏输入拉爆查询）
  if (raw > currentMonthKey() || raw < "2020-01") return currentMonthKey();
  return raw;
}

interface KeyBill {
  apiKeyName: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  successRate: number | null;
  cost: CostAgg;
  /** 该密钥的月度成本预算（$；无同名虚拟密钥或未设预算 → 0 不限）；v4.5.0 打通预算展示 */
  monthlyCostLimit: number;
  /** 模型明细（请求量降序；模型维度逐行计价后归桶） */
  byModel: Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cost: CostAgg;
  }>;
}

interface MonthTotals {
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  successRate: number | null;
  cost: CostAgg;
}

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "usage.read");
  if (session instanceof Response) return session;

  const month = normalizeMonth(request.nextUrl.searchParams.get("month"));
  const prev = prevMonthKey(month);

  let rows;
  try {
    rows = await db.usageDaily.findMany({
      where: { day: { startsWith: month } },
      orderBy: [{ apiKeyName: "asc" }, { requests: "desc" }],
    });
  } catch (e) {
    return fail(`UsageDaily 查询失败: ${e instanceof Error ? e.message : String(e)}`, 500);
  }

  // 上月合计（环比徽标；仅聚合，无需明细）
  const prevRows = await db.usageDaily.findMany({
    where: { day: { startsWith: prev } },
    select: { model: true, requests: true, okRequests: true, inputTokens: true, outputTokens: true, cachedTokens: true },
  });

  // 有数据的月份清单（distinct day 前缀，降序；前端选择器 ≤ 12 个近月）
  const dayAgg = await db.usageDaily.findMany({ select: { day: true } });
  const monthsSet = new Set<string>();
  for (const r of dayAgg) monthsSet.add(r.day.slice(0, 7));
  // 当前月始终可选（即使暂无数据，方便盯盘）
  monthsSet.add(currentMonthKey());
  const months = Array.from(monthsSet).sort((a, b) => b.localeCompare(a)).slice(0, 12);

  // 单价表一次加载：本月行级 + 上月聚合 + byModel 归桶共用
  const pricing = await loadPricingMap();

  // v4.5.0：密钥名 → 月度预算映射（账单行附带预算进度；无同名虚拟密钥或未设预算 → 0）
  const vkRows = await db.virtualKey.findMany({ select: { name: true, monthlyCostLimit: true } });
  const budgetMap = new Map<string, number>();
  for (const vk of vkRows) {
    if (vk.monthlyCostLimit > 0) budgetMap.set(vk.name, vk.monthlyCostLimit);
  }

  // ---- 按密钥分组（含 byModel 明细） ----
  const byKey = new Map<string, KeyBill>();
  const totals: MonthTotals = {
    requests: 0,
    okRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    successRate: null,
    cost: { ...EMPTY_COST_AGG },
  };

  const emptyCost = (): CostAgg => ({ ...EMPTY_COST_AGG });
  const emptyBill = (keyName: string, budget: number): KeyBill => ({
    apiKeyName: keyName,
    requests: 0,
    okRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    successRate: null,
    cost: emptyCost(),
    monthlyCostLimit: budget,
    byModel: [],
  });
  const bumpAgg = (agg: CostAgg, cost: number | null, requests: number) => {
    if (cost === null) agg.unpricedRequests += requests;
    else {
      agg.cost += cost;
      agg.pricedRequests += requests;
    }
  };

  for (const r of rows) {
    const keyName = r.apiKeyName || "(unknown)";
    const cost = estimateRowCost(pricing, r.model, r.inputTokens, r.outputTokens, r.cachedTokens);
    const bill = byKey.get(keyName) || emptyBill(keyName, budgetMap.get(keyName) || 0);
    bill.requests += r.requests;
    bill.okRequests += r.okRequests;
    bill.inputTokens += r.inputTokens;
    bill.outputTokens += r.outputTokens;
    bill.cachedTokens += r.cachedTokens;
    bumpAgg(bill.cost, cost, r.requests);

    if (r.model) {
      let m = bill.byModel.find((x) => x.model === r.model);
      if (!m) {
        m = { model: r.model, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: emptyCost() };
        bill.byModel.push(m);
      }
      m.requests += r.requests;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.cachedTokens += r.cachedTokens;
      bumpAgg(m.cost, cost, r.requests);
    }
    // model="" 的 v4.2.3 前历史行不单列模型明细（estimateRowCost 返回 null 已归未计价口径）
    byKey.set(keyName, bill);

    totals.requests += r.requests;
    totals.okRequests += r.okRequests;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cachedTokens += r.cachedTokens;
    bumpAgg(totals.cost, cost, r.requests);
  }

  for (const bill of byKey.values()) {
    bill.successRate = bill.requests > 0 ? Math.round((bill.okRequests / bill.requests) * 100) : null;
    bill.cost.cost = Math.round(bill.cost.cost * 1e6) / 1e6;
    for (const m of bill.byModel) m.cost.cost = Math.round(m.cost.cost * 1e6) / 1e6;
    bill.byModel.sort((a, b) => b.requests - a.requests);
  }
  totals.successRate = totals.requests > 0 ? Math.round((totals.okRequests / totals.requests) * 100) : null;
  totals.cost.cost = Math.round(totals.cost.cost * 1e6) / 1e6;

  // ---- 上月合计（环比） ----
  const prevTotals: MonthTotals = {
    requests: 0,
    okRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    successRate: null,
    cost: emptyCost(),
  };
  for (const r of prevRows) {
    const cost = estimateRowCost(pricing, r.model, r.inputTokens, r.outputTokens, r.cachedTokens);
    prevTotals.requests += r.requests;
    prevTotals.okRequests += r.okRequests;
    prevTotals.inputTokens += r.inputTokens;
    prevTotals.outputTokens += r.outputTokens;
    prevTotals.cachedTokens += r.cachedTokens;
    bumpAgg(prevTotals.cost, cost, r.requests);
  }
  prevTotals.successRate = prevTotals.requests > 0 ? Math.round((prevTotals.okRequests / prevTotals.requests) * 100) : null;
  prevTotals.cost.cost = Math.round(prevTotals.cost.cost * 1e6) / 1e6;

  // ---- 当月未计价模型提示（补录引导，请求量降序） ----
  const unpricedMap = new Map<string, number>();
  for (const r of rows) {
    if (!r.model || pricing.has(r.model)) continue;
    unpricedMap.set(r.model, (unpricedMap.get(r.model) || 0) + r.requests);
  }
  const unpricedModels = Array.from(unpricedMap.entries())
    .map(([model, requests]) => ({ model, requests }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 20);

  return ok({
    month,
    prevMonth: prev,
    months,
    rows: Array.from(byKey.values()).sort((a, b) => b.cost.cost - a.cost.cost || b.requests - a.requests),
    totals,
    prevTotals,
    unpricedModels,
  });
}
