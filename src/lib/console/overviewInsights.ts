// 总览洞察计算共享层 —— 供 /api/console/overview（首屏种子数据）与
// /api/console/overview/insights（独立窗口切换 API，v4.2.4）复用同一套聚合逻辑，
// 防两处口径漂移。数据源均为 UsageDaily 持久聚合表（跨滚动窗口、重启不丢）。
import { db } from "@/lib/db";
import { localDayKey } from "@/lib/gateway/config/requestLog";

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
    select: { providerId: true, requests: true, okRequests: true, inputTokens: true, outputTokens: true, cachedTokens: true },
  });
  // 提供商名称 join（overview route 同款：id 兜底显示）
  const providers = await db.provider.findMany({ select: { id: true, name: true } });
  const agg = new Map<
    string,
    { requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number }
  >();
  let totalRequests = 0;
  for (const r of rows) {
    totalRequests += r.requests;
    const key = r.providerId || "";
    if (!key) continue; // 未命中提供商的行不参与排行，但计入分母
    const b = agg.get(key) || { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    b.requests += r.requests;
    b.okRequests += r.okRequests;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cachedTokens += r.cachedTokens;
    agg.set(key, b);
  }
  return Array.from(agg.entries())
    .map(([providerId, b]) => ({
      providerId,
      providerName: providers.find((p) => p.id === providerId)?.name || providerId,
      ...b,
      share: totalRequests > 0 ? Math.round((b.requests / totalRequests) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);
}
