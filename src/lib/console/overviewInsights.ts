// 总览洞察计算共享层 —— 供 /api/console/overview（首屏种子数据）与
// /api/console/overview/insights（独立窗口切换 API，v4.2.4）复用同一套聚合逻辑，
// 防两处口径漂移。数据源均为 UsageDaily 持久聚合表（跨滚动窗口、重启不丢）。
import { db } from "@/lib/db";
import { localDayKey } from "@/lib/gateway/config/requestLog";
import { loadPricingMap, estimateRowCost, type CostAgg } from "./pricing";

/** 模型健康行（与 types.ts ModelHealthModel 同形；此处局部定义避免 lib 层反向依赖 console 类型层） */
export interface ModelHealthModelRow {
  model: string;
  points: Array<{ day: string; requests: number; okRequests: number }>;
  requests7d: number;
  okRequests7d: number;
}

export interface ModelHealthDataResult {
  days: string[];
  models: ModelHealthModelRow[];
  windowDays?: number;
}

/** Top 提供商行（与 types.ts TopProviderRow 同形） */
export interface TopProviderRowResult {
  providerId: string;
  providerName: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  share: number;
  /** v4.4.0：窗口内估算成本（$；需按模型维度逐行计价后归入桶） */
  cost: number;
  /** v4.4.0：桶内已计价请求数（未计价 = requests - pricedRequests） */
  pricedRequests: number;
}

// 窗口天数白名单（与前端 7/14/30 按钮组一致）
const ALLOWED_WINDOWS = new Set([7, 14, 30]);

export function normalizeWindowDays(raw: unknown): number {
  const n = Number(raw);
  return ALLOWED_WINDOWS.has(n) ? n : 7;
}

/** 近 N 天日期轴（最旧 → 今日，本地时区日键；与 overview/usage-daily 的 localDayKey 口径一致） */
function windowDayKeys(days: number): string[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    return localDayKey(d);
  });
}

/**
 * 模型健康（UsageDaily 模型维度）—— 近 N 天（含今日）按「对外模型 × 本地日」聚合，
 * 每模型 N 个日点（requests/okRequests）供 sparkline 渲染；按窗口内请求数取 Top 6。
 * v4.2.3 前历史行（model=""）不参与。核心逻辑自 overview route 平移（v4.2.3 版），口径零变化。
 */
export async function computeModelHealthData(days: number): Promise<ModelHealthDataResult> {
  const dayKeys = windowDayKeys(days);
  const rows = await db.usageDaily.findMany({
    where: { day: { in: dayKeys }, model: { not: "" } },
    select: { day: true, model: true, requests: true, okRequests: true },
  });
  const map = new Map<string, Array<{ requests: number; okRequests: number }>>();
  for (const row of rows) {
    const idx = dayKeys.indexOf(row.day);
    if (idx < 0) continue;
    let arr = map.get(row.model);
    if (!arr) {
      arr = dayKeys.map(() => ({ requests: 0, okRequests: 0 }));
      map.set(row.model, arr);
    }
    arr[idx].requests += row.requests;
    arr[idx].okRequests += row.okRequests;
  }
  return {
    days: dayKeys,
    windowDays: days,
    models: Array.from(map.entries())
      .map(([model, points]) => ({
        model,
        points: points.map((p, i) => ({ day: dayKeys[i], ...p })),
        requests7d: points.reduce((s, p) => s + p.requests, 0),
        okRequests7d: points.reduce((s, p) => s + p.okRequests, 0),
      }))
      .sort((a, b) => b.requests7d - a.requests7d)
      .slice(0, 6),
  };
}

/**
 * Top 提供商排行（UsageDaily providerId 维度）—— 近 N 天按 providerId 聚合，
 * 按请求数 Top 5；剔除 providerId="" 的未命中行（容灾/路由缺失），但其请求数计入
 * 份额分母（share = 该提供商 / 窗口内全部请求，忠实反映总盘子）。
 * v4.2.4：窗口长度参数化（原 overview route 固定 7 天复用 trend7Rows；此处独立查询，
 * 语义与「近 N 天」标题一致）。share 的窗口语义随窗口联动，自洽无歧义。
 */
export async function computeTopProviders(days: number): Promise<TopProviderRowResult[]> {
  const dayKeys = windowDayKeys(days);
  const rows = await db.usageDaily.findMany({
    where: { day: { in: dayKeys } },
    select: { providerId: true, model: true, requests: true, okRequests: true, inputTokens: true, outputTokens: true, cachedTokens: true },
  });
  // 提供商名称 join（overview route 同款：id 兜底显示）
  const providers = await db.provider.findMany({ select: { id: true, name: true } });
  // v4.4.0：单价表一次加载（模型维度逐行计价；未配置单价归未计价口径）
  const pricing = await loadPricingMap();
  const agg = new Map<
    string,
    { requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: CostAgg }
  >();
  let totalRequests = 0;
  for (const r of rows) {
    totalRequests += r.requests;
    const key = r.providerId || "";
    if (!key) continue; // 未命中提供商的行不参与排行，但计入分母
    const b = agg.get(key) || { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: { cost: 0, pricedRequests: 0, unpricedRequests: 0 } };
    b.requests += r.requests;
    b.okRequests += r.okRequests;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cachedTokens += r.cachedTokens;
    const c = estimateRowCost(pricing, r.model, r.inputTokens, r.outputTokens, r.cachedTokens);
    if (c === null) b.cost.unpricedRequests += r.requests;
    else {
      b.cost.cost += c;
      b.cost.pricedRequests += r.requests;
    }
    agg.set(key, b);
  }
  return Array.from(agg.entries())
    .map(([providerId, b]) => ({
      providerId,
      providerName: providers.find((p) => p.id === providerId)?.name || providerId,
      ...b,
      cost: Math.round(b.cost.cost * 1e6) / 1e6,
      pricedRequests: b.cost.pricedRequests,
      share: totalRequests > 0 ? Math.round((b.requests / totalRequests) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);
}

// ---- v4.3.2：服务质量 SLO（RequestLog 延迟分位数 / 成功率 / 流式占比 / 延迟分布直方图）----

/** SLO 窗口小时数白名单（与前端 1h/6h/24h 按钮组一致） */
const ALLOWED_SLO_HOURS = new Set([1, 6, 24]);

export function normalizeSloHours(raw: unknown): number {
  const n = Number(raw);
  return ALLOWED_SLO_HOURS.has(n) ? n : 24;
}

/** 直方图单桶（右开区间 [fromMs, toMs)；末桶闭区间含 max） */
export interface SloHistogramBucket {
  fromMs: number;
  toMs: number;
  count: number;
}

/** 与 types.ts SloData 同形（此处局部定义避免 lib 层反向依赖 console 类型层） */
export interface SloDataResult {
  windowHours: number;
  /** 窗口内日志总条数（含错误请求） */
  samples: number;
  okCount: number;
  errCount: number;
  /** 成功率 0-100（一位小数；samples=0 时 null） */
  successRate: number | null;
  /** 延迟分位数（毫秒；基于成功且有耗时记录的请求；样本 <5 时 null 避免误导） */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** 平均耗时（毫秒；口径同分位数） */
  avgMs: number | null;
  /** 流式请求数与占比 0-100 */
  streamCount: number;
  streamShare: number | null;
  /** 延迟分布直方图（线性等宽桶，桶数 = 样本数>0 ? 20 : 0） */
  histogram: SloHistogramBucket[];
}

/** 就地排序后取分位数（nearest-rank 法：ceil(p*n)-1 号位） */
function percentileSorted(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 服务质量 SLO —— 近 N 小时 RequestLog 聚合。
 * 口径说明：
 * - 数据源为 RequestLog（滚动窗口 5000 条，超高流量下 24h 可能被截断 —— 前端脚注注明）；
 * - 分位数 / 平均耗时仅统计「成功（2xx）且 durationMs 有值」的请求（运维惯例：失败请求
 *   的耗时语义混杂 —— 429 预检秒拒与 504 上游超时不可比，混入会拉偏 P50）；
 * - 成功率 / 流式占比统计窗口内全部请求（含错误）；
 * - 直方图线性等宽 20 桶（0 → 样本最大值）；样本过少（<8）时不出直方图避免锯齿噪音。
 */
export async function computeSloData(hours: number): Promise<SloDataResult> {
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = await db.requestLog.findMany({
    where: { createdAt: { gte: since } },
    select: { status: true, durationMs: true, stream: true },
    orderBy: { createdAt: "asc" },
    take: 5000,
  });
  const samples = rows.length;
  const okCount = rows.filter((r) => (r.status ?? 0) >= 200 && (r.status ?? 0) < 300).length;
  const errCount = samples - okCount;
  const streamCount = rows.filter((r) => r.stream).length;

  // 延迟样本：成功且有耗时
  const latencies = rows
    .filter((r) => (r.status ?? 0) >= 200 && (r.status ?? 0) < 300 && r.durationMs != null)
    .map((r) => r.durationMs as number)
    .sort((a, b) => a - b);
  // 分位数门槛：样本过少时不出数（<5 条分位数无统计意义）
  const enough = latencies.length >= 5;
  const p50 = enough ? percentileSorted(latencies, 50) : null;
  const p95 = enough ? percentileSorted(latencies, 95) : null;
  const p99 = enough ? percentileSorted(latencies, 99) : null;
  const avgMs = enough
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : null;

  // 直方图：线性等宽 20 桶（样本 ≥8 才渲染；桶宽 = max/20，max=0 时单桶）
  const histogram: SloHistogramBucket[] = [];
  if (latencies.length >= 8) {
    const max = latencies[latencies.length - 1];
    const bucketCount = 20;
    const width = max > 0 ? max / bucketCount : 1;
    const counts = new Array<number>(bucketCount).fill(0);
    for (const v of latencies) {
      let idx = Math.floor(v / width);
      if (idx >= bucketCount) idx = bucketCount - 1; // 末桶闭区间收 max
      counts[idx] += 1;
    }
    for (let i = 0; i < bucketCount; i++) {
      histogram.push({
        fromMs: Math.round(i * width),
        toMs: Math.round((i + 1) * width),
        count: counts[i],
      });
    }
  }

  return {
    windowHours: hours,
    samples,
    okCount,
    errCount,
    successRate: samples > 0 ? Math.round((okCount / samples) * 1000) / 10 : null,
    p50,
    p95,
    p99,
    avgMs,
    streamCount,
    streamShare: samples > 0 ? Math.round((streamCount / samples) * 1000) / 10 : null,
    histogram,
  };
}
