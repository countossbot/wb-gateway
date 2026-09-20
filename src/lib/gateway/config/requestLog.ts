// 请求日志 —— 每次网关交换落库（模型/命中提供商与账号/耗时/状态码/Token 用量）。
// 异步写、失败不阻断请求路径；控制台「运行日志」模块与 /admin/api 状态查询消费。
// v3.0.6：同步写 UsageDaily 按日聚合（日 × 提供商 × 密钥维度），统计不再受滚动窗口截断。
// v4.2.3：聚合维度增加 model（模型健康/Top 模型排行的跨滚动窗口根本解）。
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export interface RequestLogEntry {
  model: string;
  protocol: "anthropic" | "openai";
  providerId?: string | null;
  accountId?: string | null;
  durationMs?: number | null;
  status?: number | null;
  stream?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  apiKeyName?: string | null;
  error?: string | null;
  /** true=上游精确 usage；false=网关字符估算；null=未知（无用量或旧路径） */
  usageExact?: boolean | null;
}

/** v3.0.6：本地时区 YYYY-MM-DD（今日消耗/日趋势的日键；与 overview 的本地 0 点口径一致）。 */
export function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function recordRequestLog(entry: RequestLogEntry): Promise<void> {
  try {
    await db.requestLog.create({
      data: {
        model: entry.model,
        protocol: entry.protocol,
        providerId: entry.providerId ?? null,
        accountId: entry.accountId ?? null,
        durationMs: entry.durationMs ?? null,
        status: entry.status ?? null,
        stream: entry.stream ?? false,
        inputTokens: entry.inputTokens ?? null,
        outputTokens: entry.outputTokens ?? null,
        cachedTokens: entry.cachedTokens ?? null,
        apiKeyName: entry.apiKeyName ?? null,
        error: entry.error ? String(entry.error).slice(0, 2000) : null,
        usageExact: entry.usageExact ?? null,
      },
    });
    // v3.9.3：UsageDaily 聚合改为内存累积 + 定时批量 flush（见 bumpUsageDaily / flushUsageDaily）
    bumpUsageDailyBuffered(entry);
    // v3.9.3：滚动窗口清理已移出写入路径 —— 原实现在这里每请求执行一次 db.requestLog.count()
    // （每次请求多一条全量聚合 SQL，与日志写入串行拉长延迟），清理改为由调度器每 5 分钟
    // 按 id 阈值分段删除（purgeRequestLogsByIdThreshold，见 scheduler tick）。
  } catch (e) {
    console.error("[RequestLog] persist failed:", e);
  }
}

// ---- v3.9.3：UsageDaily 内存聚合 + 定时批量 flush（替代逐请求 upsert） ----
// 旧实现每个请求一次 db.usageDaily.upsert（与 RequestLog.create 构成两次独立写入/两次 WAL 追加）。
// 新实现参考 cacheStats 的内存累积模式：按 day × providerId × apiKeyName × model 四维度在内存累加，
// 每 30 秒批量 flush 一次（$transaction 包裹保证一致性；失败整批退回缓冲不丢数）。
// flushTimer + scheduleFlush 幂等调度；进程退出路径由 instrumentation 的 SIGTERM 钩子兜底 flush。
// v4.2.3：第四维度 model（对外模型名；空串=未知，与其它维度键空串占位思路一致）。
interface UsageDailyCell {
  day: string;
  providerId: string;
  apiKeyName: string;
  model: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

const usageDailyBuffer = new Map<string, UsageDailyCell>();
let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;
let usageFlushing = false;
const USAGE_FLUSH_INTERVAL_MS = 30 * 1000;
const USAGE_FLUSH_TX_BATCH = 200; // 单事务 upsert 上限（分片提交，避免长事务占写锁）

function usageCellKey(day: string, providerId: string, apiKeyName: string, model: string): string {
  return `${day}\u0000${providerId}\u0000${apiKeyName}\u0000${model}`;
}

/** 内存累加一次请求（同步、零 IO；替代原逐请求 upsert） */
function bumpUsageDailyBuffered(entry: RequestLogEntry): void {
  const day = localDayKey();
  const providerKey = entry.providerId ?? "";
  const keyKey = entry.apiKeyName ?? "";
  const modelKey = entry.model ?? "";
  const key = usageCellKey(day, providerKey, keyKey, modelKey);
  const ok = (entry.status ?? 0) >= 200 && (entry.status ?? 0) < 400;
  const cell = usageDailyBuffer.get(key);
  if (cell) {
    cell.requests += 1;
    if (ok) cell.okRequests += 1;
    cell.inputTokens += entry.inputTokens ?? 0;
    cell.outputTokens += entry.outputTokens ?? 0;
    cell.cachedTokens += entry.cachedTokens ?? 0;
  } else {
    usageDailyBuffer.set(key, {
      day,
      providerId: providerKey,
      apiKeyName: keyKey,
      model: modelKey,
      requests: 1,
      okRequests: ok ? 1 : 0,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      cachedTokens: entry.cachedTokens ?? 0,
    });
  }
  scheduleUsageFlush();
}

/**
 * v4.3.0：读取内存缓冲中某密钥今日（本地时区日）未 flush 的聚合量（零 IO 同步读）。
 * 供配额执行（quota.ts）与 UsageDaily 落库行合并，消除 30s flush 窗口内的统计盲区：
 * DB 已落库量 + 本缓冲量 = 该密钥今日真实累计（同模块图内精确；dev 跨路由模块实例
 * 间仍存在理论盲区——生产单实例无此问题）。
 */
export function peekUsageDailyToday(apiKeyName: string): {
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
} {
  const day = localDayKey();
  const out = { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const cell of usageDailyBuffer.values()) {
    if (cell.day !== day || cell.apiKeyName !== apiKeyName) continue;
    out.requests += cell.requests;
    out.okRequests += cell.okRequests;
    out.inputTokens += cell.inputTokens;
    out.outputTokens += cell.outputTokens;
    out.cachedTokens += cell.cachedTokens;
  }
  return out;
}

/** 幂等调度：缓冲非空且无 pending timer 时排一次 flush（30s） */
function scheduleUsageFlush(): void {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    void flushUsageDaily();
  }, USAGE_FLUSH_INTERVAL_MS);
  // 不阻止进程退出（退出路径由 SIGTERM 钩子同步 flush 兜底）
  (usageFlushTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * 批量 flush 内存聚合到 UsageDaily（$transaction 分片提交）。
 * 先取出再清零（防 flush 期间新聚合丢失）；失败整批退回缓冲并在 30s 后重试。
 * 供调度器兜底调用与进程退出钩子（instrumentation SIGTERM）使用。
 */
export async function flushUsageDaily(): Promise<number> {
  if (usageFlushing) return 0;
  usageFlushing = true;
  try {
    if (usageFlushTimer) {
      clearTimeout(usageFlushTimer);
      usageFlushTimer = null;
    }
    // 静默空 flush（零日志噪声）；有数据时留痕供审计
    if (usageDailyBuffer.size === 0) return 0;
    console.log(`[UsageDaily] flush: cells=${usageDailyBuffer.size}`);
    // 先取出再清零：flush 期间新到的聚合留在缓冲，下一轮处理（不丢）
    const batch = [...usageDailyBuffer.values()];
    usageDailyBuffer.clear();
    try {
      for (let i = 0; i < batch.length; i += USAGE_FLUSH_TX_BATCH) {
        const slice = batch.slice(i, i + USAGE_FLUSH_TX_BATCH);
        await db.$transaction(
          slice.map((cell) =>
            db.usageDaily.upsert({
              where: {
                day_providerId_apiKeyName_model: {
                  day: cell.day,
                  providerId: cell.providerId,
                  apiKeyName: cell.apiKeyName,
                  model: cell.model,
                },
              },
              create: {
                day: cell.day,
                providerId: cell.providerId,
                apiKeyName: cell.apiKeyName,
                model: cell.model,
                requests: cell.requests,
                okRequests: cell.okRequests,
                inputTokens: cell.inputTokens,
                outputTokens: cell.outputTokens,
                cachedTokens: cell.cachedTokens,
              },
              update: {
                requests: { increment: cell.requests },
                okRequests: { increment: cell.okRequests },
                inputTokens: { increment: cell.inputTokens },
                outputTokens: { increment: cell.outputTokens },
                cachedTokens: { increment: cell.cachedTokens },
              },
            })
          )
        );
      }
      return batch.length;
    } catch (e) {
      // 失败退回：把这批聚合并回缓冲（同键合并），30s 后自动重试
      console.error("[UsageDaily] batch flush failed, rebuffering:", e);
      for (const cell of batch) {
        const key = usageCellKey(cell.day, cell.providerId, cell.apiKeyName, cell.model);
        const cur = usageDailyBuffer.get(key);
        if (cur) {
          cur.requests += cell.requests;
          cur.okRequests += cell.okRequests;
          cur.inputTokens += cell.inputTokens;
          cur.outputTokens += cell.outputTokens;
          cur.cachedTokens += cell.cachedTokens;
        } else {
          usageDailyBuffer.set(key, cell);
        }
      }
      scheduleUsageFlush();
      return 0;
    }
  } finally {
    usageFlushing = false;
  }
}

/** v3.9.3：滚动窗口清理（调度器每 5 分钟调用；每批 ≤500 行短事务，不长时间持有写锁）。
 *  按 id 阈值删除：取当前 maxId，删 id ≤ maxId - 5000 的行（自增主键序即写入序，
 *  不再依赖 createdAt 排序/全表扫描）。返回删除总行数。 */
export async function purgeRequestLogsByIdThreshold(retain = 5000, batch = 500): Promise<number> {
  try {
    const maxRow = await db.requestLog.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    if (!maxRow || maxRow.id <= retain) return 0;
    const cutoffId = maxRow.id - retain;
    let deleted = 0;
    while (true) {
      // 本批上界 = 待删区间内第 batch 个 id（PK 索引取前缀，deleteMany 范围精确）
      const candidates = await db.requestLog.findMany({
        where: { id: { lte: cutoffId } },
        orderBy: { id: "asc" },
        take: batch,
        select: { id: true },
      });
      if (candidates.length === 0) break;
      const upper = candidates[candidates.length - 1].id;
      const r = await db.requestLog.deleteMany({ where: { id: { lte: upper } } });
      deleted += r.count;
      if (candidates.length < batch) break; // 不足一批 = 已清完
    }
    return deleted;
  } catch (e) {
    console.error("[RequestLog] purge by id threshold failed:", e);
    return 0;
  }
}

/** v3.0.7（v4.2.3 增模型维度）：UsageDaily 历史回填——从 RequestLog 现存滚动窗口（≤5000 条）
 *  按（日 × 提供商 × 密钥 × 模型）聚合补齐 UsageDaily 无任何行的历史天
 *  （幂等：已存在行的天整体跳过，防止部分行双计；今日由实时链路负责不回填）。
 *  启动时自动执行一次，也可经 /admin/api/usage-backfill 手动触发。 */
export async function backfillUsageDaily(): Promise<{ days: number; rows: number; skippedDays: string[] }> {
  const today = localDayKey();
  // 1. 已存在的聚合行：已记录的天整体跳过（幂等 + 防双计）
  const existingRows = await db.usageDaily.findMany({ select: { day: true } });
  const existingDays = new Set(existingRows.map((r) => r.day));

  // 2. 拉取滚动窗口内全部请求日志，按天 × 维度聚合
  const logs = await db.requestLog.findMany({
    select: { createdAt: true, providerId: true, apiKeyName: true, model: true, status: true, inputTokens: true, outputTokens: true, cachedTokens: true },
  });
  const agg = new Map<string, Map<string, { requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number; providerId: string; apiKeyName: string; model: string }>>();
  for (const l of logs) {
    const day = localDayKey(l.createdAt);
    if (day >= today) continue; // 今日行由实时链路负责，不回填
    if (existingDays.has(day)) continue; // 该天已有聚合行（部分或全部）——整体跳过防双计
    const providerId = l.providerId ?? "";
    const apiKeyName = l.apiKeyName ?? "";
    const model = l.model ?? "";
    const dimKey = `${providerId}\u0000${apiKeyName}\u0000${model}`;
    let dayMap = agg.get(day);
    if (!dayMap) {
      dayMap = new Map();
      agg.set(day, dayMap);
    }
    const b = dayMap.get(dimKey) || { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerId, apiKeyName, model };
    b.requests += 1;
    if ((l.status ?? 0) >= 200 && (l.status ?? 0) < 400) b.okRequests += 1;
    b.inputTokens += l.inputTokens ?? 0;
    b.outputTokens += l.outputTokens ?? 0;
    b.cachedTokens += l.cachedTokens ?? 0;
    dayMap.set(dimKey, b);
  }

  const toCreate: Array<{ day: string; providerId: string; apiKeyName: string; model: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number }> = [];
  for (const [day, dayMap] of agg) {
    for (const b of dayMap.values()) {
      toCreate.push({ day, providerId: b.providerId, apiKeyName: b.apiKeyName, model: b.model, requests: b.requests, okRequests: b.okRequests, inputTokens: b.inputTokens, outputTokens: b.outputTokens, cachedTokens: b.cachedTokens });
    }
  }
  if (toCreate.length > 0) {
    // 注：SQLite 的 createMany 不支持 skipDuplicates（Prisma 类型与运行时均拒绝）；
    // 聚合逻辑只处理「UsageDaily 无任何行」的历史天，唯一约束天然满足，无需去重兜底
    await db.usageDaily.createMany({ data: toCreate });
  }
  const days = new Set(toCreate.map((r) => r.day));
  // 跳过原因透明化：已有行的历史天清单（调用方可展示，供人工判断是否需要重置后重建）
  const skippedDays = [...existingDays].filter((d) => d < today).sort();
  return { days: days.size, rows: toCreate.length, skippedDays };
}

/**
 * v4.2.3：模型维度拆分迁移 —— 把 v4.2.3 之前写入的 model="" 历史聚合行，
 * 在「RequestLog 完整覆盖该天」时安全重切为按模型细分行（delete + rebuild 原子事务）。
 *
 * 安全前提（防数据丢失的硬校验）：该天 UsageDaily 的 requests 总和 == 该天 RequestLog 行数。
 * 只有计数精确相等才说明滚动窗口日志完整覆盖该天全部请求，重切结果与原聚合完全等价；
 * 日志已被滚出窗口/部分缺失（计数不等）的天保留 model="" 原样不重切（零风险路径），
 * 下次启动仍会重试（若届时日志恢复完整）。
 *
 * 幂等性：无 model="" 行时零操作直接返回；由 instrumentation 在启动时（backfill 之后）调用。
 */
export async function splitUsageDailyModelDimension(): Promise<{
  daysChecked: number;
  daysSplit: number;
  rowsBefore: number;
  rowsAfter: number;
  skipped: Array<{ day: string; usageRequests: number; logCount: number }>;
}> {
  // 1. 找出含 model="" 行的天
  const legacyRows = await db.usageDaily.findMany({ where: { model: "" }, select: { day: true, requests: true } });
  if (legacyRows.length === 0) {
    return { daysChecked: 0, daysSplit: 0, rowsBefore: 0, rowsAfter: await db.usageDaily.count(), skipped: [] };
  }
  const legacyDays = new Map<string, number>(); // day -> requests 总和
  for (const r of legacyRows) legacyDays.set(r.day, (legacyDays.get(r.day) || 0) + r.requests);

  const rowsBefore = await db.usageDaily.count();
  const skipped: Array<{ day: string; usageRequests: number; logCount: number }> = [];
  const splitDays: string[] = [];

  // 2. 逐天安全校验 + 重切
  for (const [day, usageRequests] of legacyDays) {
    const dayStart = new Date(`${day}T00:00:00`);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const logs = await db.requestLog.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
      select: { providerId: true, apiKeyName: true, model: true, status: true, inputTokens: true, outputTokens: true, cachedTokens: true },
    });
    // 硬校验：聚合行请求数 == 日志行数（否则该天日志不完整，保留原行不冒险重切）
    if (logs.length !== usageRequests) {
      skipped.push({ day, usageRequests, logCount: logs.length });
      continue;
    }
    // 从日志重聚合（四维度）
    const cells = new Map<string, { day: string; providerId: string; apiKeyName: string; model: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number }>();
    for (const l of logs) {
      const providerId = l.providerId ?? "";
      const apiKeyName = l.apiKeyName ?? "";
      const model = l.model ?? "";
      const k = `${providerId}\u0000${apiKeyName}\u0000${model}`;
      const ok = (l.status ?? 0) >= 200 && (l.status ?? 0) < 400;
      const c = cells.get(k) || { day, providerId, apiKeyName, model, requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      c.requests += 1;
      if (ok) c.okRequests += 1;
      c.inputTokens += l.inputTokens ?? 0;
      c.outputTokens += l.outputTokens ?? 0;
      c.cachedTokens += l.cachedTokens ?? 0;
      cells.set(k, c);
    }
    // 重切原子事务：先删该天全部行（含 model=""），再建四维度细分行
    // （计数已硬校验相等，重切结果请求数与原聚合严格等价）
    await db.$transaction([
      db.usageDaily.deleteMany({ where: { day } }),
      ...[...cells.values()].map((c) =>
        db.usageDaily.create({
          data: { day: c.day, providerId: c.providerId, apiKeyName: c.apiKeyName, model: c.model, requests: c.requests, okRequests: c.okRequests, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedTokens: c.cachedTokens },
        })
      ),
    ]);
    splitDays.push(day);
  }
  const rowsAfter = await db.usageDaily.count();
  return { daysChecked: legacyDays.size, daysSplit: splitDays.length, rowsBefore, rowsAfter, skipped };
}

export interface RequestLogQuery {
  limit?: number;
  offset?: number;
  model?: string;
  /** v3.0.4：按命中提供商筛选（提供商 ID 精确匹配） */
  provider?: string;
  /** v3.0.4：按 usage 来源筛选（exact=上游精确 / estimated=网关估算 / none=未记录） */
  usage?: "exact" | "estimated" | "none";
  /** v3.0.5：按状态码筛选（2xx/4xx/5xx 大类或具体三位数字如 429） */
  status?: string;
  /** v3.0.5：按调用方密钥名筛选（精确匹配；含 Master Admin / Cron Trigger 等主体名） */
  apiKeyName?: string;
  /** v3.0.5：时间范围起点（毫秒时间戳，含）；与 to 组合支持趋势图点击跳转该小时 */
  from?: number;
  /** v3.0.5：时间范围终点（毫秒时间戳，不含） */
  to?: number;
  /** v3.0.6：按命中账号筛选（accountId 精确；与 provider 组合可防跨提供商同名串扰） */
  accountId?: string;
}

/** v3.0.5：状态码筛选值 → Prisma Int 过滤器（大类 → 区间；具体码 → 精确匹配） */
function statusFilterFor(v: string): Prisma.IntNullableFilter | number | undefined {
  if (v === "2xx" || v === "4xx" || v === "5xx") {
    const base = v === "2xx" ? 200 : v === "4xx" ? 400 : 500;
    return { gte: base, lt: base + 100 };
  }
  if (/^\d{3}$/.test(v)) return Number(v);
  return undefined;
}

export async function listRequestLogs(opts: RequestLogQuery = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: Prisma.RequestLogWhereInput = {};
  if (opts.model) where.model = opts.model;
  if (opts.provider) where.providerId = opts.provider;
  if (opts.usage === "exact") where.usageExact = true;
  else if (opts.usage === "estimated") where.usageExact = false;
  else if (opts.usage === "none") where.usageExact = null;
  if (opts.apiKeyName) where.apiKeyName = opts.apiKeyName;
  if (opts.accountId) where.accountId = opts.accountId;
  if (opts.status) {
    const f = statusFilterFor(opts.status);
    if (f !== undefined) where.status = f;
  }
  // 时间范围（趋势图点击柱跳转：from=整点、to=整点+1h；也支持前端预设窗口）
  if (Number.isFinite(opts.from) || Number.isFinite(opts.to)) {
    const range: { gte?: Date; lt?: Date } = {};
    if (Number.isFinite(opts.from) && (opts.from as number) >= 0) range.gte = new Date(opts.from as number);
    if (Number.isFinite(opts.to) && (opts.to as number) > 0) range.lt = new Date(opts.to as number);
    if (range.gte || range.lt) where.createdAt = range;
  }
  const [items, total] = await Promise.all([
    db.requestLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: opts.offset ?? 0,
    }),
    db.requestLog.count({ where }),
  ]);
  return { items, total };
}

/** v3.0.4：日志中出现过的前提商去重清单（按调用次数降序）—— 运行日志筛选下拉数据源。 */
export async function distinctLogProviders(): Promise<string[]> {
  const rows = await db.requestLog.groupBy({
    by: ["providerId"],
    where: { providerId: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { providerId: "desc" } },
  });
  return rows.map((r) => r.providerId as string);
}

/** v3.0.5：日志中出现过的密钥主体去重清单（按调用次数降序）—— 运行日志密钥筛选下拉数据源。 */
export async function distinctLogKeys(): Promise<string[]> {
  const rows = await db.requestLog.groupBy({
    by: ["apiKeyName"],
    where: { apiKeyName: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { apiKeyName: "desc" } },
  });
  return rows.map((r) => r.apiKeyName as string);
}

/** v3.0.6：日志中出现过的（提供商 × 账号）组合去重清单（按调用次数降序）—— 运行日志账号筛选下拉数据源。
 *  组合键防跨提供商同名账号（如多个标准适配器的 default）串扰。 */
export async function distinctLogAccounts(): Promise<Array<{ providerId: string; accountId: string; label: string; requests: number }>> {
  const rows = await db.requestLog.groupBy({
    by: ["providerId", "accountId"],
    where: { providerId: { not: null }, accountId: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { providerId: "desc" } },
  });
  return rows.map((r) => ({
    providerId: r.providerId as string,
    accountId: r.accountId as string,
    label: `${r.providerId} / ${r.accountId}`,
    requests: r._count._all,
  }));
}

/** v3.9.0：日志中出现过的对外模型去重清单（按调用次数降序，Top 30）—— 运行日志模型筛选 datalist 数据源。 */
export async function distinctLogModels(): Promise<string[]> {
  const rows = await db.requestLog.groupBy({
    by: ["model"],
    _count: { _all: true },
    orderBy: { _count: { model: "desc" } },
    take: 30,
  });
  return rows.map((r) => r.model);
}

// ---- v3.0.8：CSV 导出（审计场景） ----

/** CSV 字段转义：含逗号/引号/换行 → 双引号包裹 + 内部引号翻倍（RFC 4180） */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 导出行数上限：滚动窗口本身 5000 条，导出全量匹配集即可覆盖 */
export const LOG_EXPORT_CAP = 5000;

/**
 * v3.0.8：按七维筛选导出全部匹配日志为 CSV 文本。
 * 复用 listRequestLogs 的 where 构建逻辑（单处维护筛选语义），
 * 覆盖 take 上限拉全量（上限 LOG_EXPORT_CAP，与滚动窗口同量级）。
 */
export async function exportRequestLogsCsv(opts: RequestLogQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
  type LogRow = Awaited<ReturnType<typeof listRequestLogs>>["items"][number];
  // 复用 listRequestLogs 的筛选语义（单处维护），上限 LOG_EXPORT_CAP（与滚动窗口同量级）
  const probe = await listRequestLogs({ ...opts, limit: 1, offset: 0 });
  const total = probe.total;
  const rows: LogRow[] = [];
  const want = Math.min(total, LOG_EXPORT_CAP);
  // listRequestLogs 钳制单次 ≤500 行，按 500 分批抓全量
  for (let offset = 0; offset < want; offset += 500) {
    const batch = await listRequestLogs({ ...opts, limit: Math.min(500, want - offset), offset });
    rows.push(...batch.items);
  }
  const truncated = total > LOG_EXPORT_CAP;

  const header = [
    "时间", "模型", "协议", "提供商", "账号", "调用方密钥", "状态码", "耗时(ms)",
    "流式", "输入tokens", "输出tokens", "缓存命中tokens", "用量来源", "错误",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([
      r.createdAt.toISOString(),
      r.model,
      r.protocol,
      r.providerId ?? "",
      r.accountId ?? "",
      r.apiKeyName ?? "",
      r.status ?? "",
      r.durationMs ?? "",
      r.stream ? "是" : "否",
      r.inputTokens ?? "",
      r.outputTokens ?? "",
      r.cachedTokens ?? "",
      r.usageExact === true ? "精确(上游usage)" : r.usageExact === false ? "估算(字符折算)" : "未记录",
      r.error ?? "",
    ].map(csvCell).join(","));
  }
  // 前置 BOM：Excel 直接双击打开 UTF-8 中文不乱码
  return { csv: "\uFEFF" + lines.join("\r\n"), rows: rows.length, truncated };
}

// ---- v3.9.3：用量来源核对（只读；供人工比对上游账单） ----

export interface UsageSourceBucket {
  /** upstreamUsageFrame=上游 usage 帧（精确）/ estimated=字符估算 / unknown=未记录 */
  source: "upstreamUsageFrame" | "estimated" | "unknown";
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** cachedTokens / inputTokens 比值（%）；inputTokens=0 时为 null（除零保护） */
  cachedRatioPct: number | null;
}

export interface UsageAuditSummary {
  from: string;
  to: string;
  buckets: UsageSourceBucket[];
  totalRequests: number;
}

/**
 * 只读核对接口：按时间范围统计三种用量来源各自的请求数与 token 合计。
 * 数据来自 RequestLog.usageExact 布尔列（true=上游精确 / false=估算 / null=未记录），
 * 不引入任何写入。用于人工比对上游账单（精确来源占比 + 缓存命中占比）。
 */
export async function summarizeUsageBySource(fromMs: number, toMs: number): Promise<UsageAuditSummary> {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const rows = await db.requestLog.groupBy({
    by: ["usageExact"],
    where: { createdAt: { gte: from, lt: to } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, cachedTokens: true },
  });
  const bucketFor = (usageExact: boolean | null): UsageSourceBucket["source"] =>
    usageExact === true ? "upstreamUsageFrame" : usageExact === false ? "estimated" : "unknown";
  const buckets: UsageSourceBucket[] = rows.map((r) => {
    const input = r._sum.inputTokens ?? 0;
    const cached = r._sum.cachedTokens ?? 0;
    return {
      source: bucketFor(r.usageExact),
      requests: r._count._all,
      inputTokens: input,
      outputTokens: r._sum.outputTokens ?? 0,
      cachedTokens: cached,
      cachedRatioPct: input > 0 ? Math.round((cached / input) * 1000) / 10 : null,
    };
  });
  // 固定顺序：精确 → 估算 → 未记录（便于人读）
  const order: UsageSourceBucket["source"][] = ["upstreamUsageFrame", "estimated", "unknown"];
  buckets.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    buckets,
    totalRequests: buckets.reduce((s, b) => s + b.requests, 0),
  };
}
