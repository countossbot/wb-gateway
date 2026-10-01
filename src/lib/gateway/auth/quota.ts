// 虚拟密钥日配额 + 月度成本预算执行（v4.3.0 / v4.5.0）—— 网关入口侧的成本护栏。
//
// 语义：
// - 仅对虚拟密钥主体生效（Master / Cron / 控制台会话不受限，与模型白名单同款主体语义）；
// - dailyRequestLimit：本地时区日内请求次数上限（到达即拒，被拒请求不计数 → 不存在「越拒越超」死锁）；
// - dailyTokenLimit：本地时区日内 input+output tokens 累计上限（入口按「已累计 ≥ 限额」预检拒绝；
//   单次超大请求自然越过的部分不做回滚——业界通行语义，超额上限≈单请求最大用量）；
// - monthlyCostLimit（v4.5.0）：本地时区自然月内**估算成本**累计上限（$）。
//   当月成本 = Σ(UsageDaily 当月行按模型 × ModelPricing 单价)/1M + 内存缓冲今日未 flush 部分
//   （与总览成本卡 / 透视成本模式完全同源口径）；已累计 ≥ 预算即拒，被拒请求零上游成本零记账
//   （不存在越拒越超死锁）。注意：依赖管理员配置的单价表——未配置单价的模型不计成本，
//   单价表为空时预算永不触发（语义在 /admin 规范页与密钥页脚注明）。
// - 0 / 缺省 = 不限额（存量密钥零行为变化）。
//
// 账本口径：UsageDaily 已落库行（day × apiKeyName 求和）+ 内存缓冲 peek，
// 与控制台「今日统计」完全同源；被拒请求发生在 dispatch 之前，不产生日志/聚合行。
//
// 响应：429 + 与鉴权拒绝一致的 {error:{message}} 形态 + RFC 标准风格 RateLimit 头组
// （X-RateLimit-Limit/Remaining/Reset + Retry-After，月预算额外附 X-Budget-Limit/Remaining/Reset），
// Anthropic/OpenAI 客户端均可识别。

import { db } from "@/lib/db";
import { localDayKey, peekUsageDailyToday, peekUsageDailyTodayByModel } from "@/lib/gateway/config/requestLog";
import { loadPricingMap, estimateRowCost } from "@/lib/console/pricing";
import { corsHeadersFor } from "@/lib/gateway/http/headers";
import type { AuthResult } from "./auth";

export interface QuotaSnapshot {
  /** 今日已计请求次数（DB + 缓冲） */
  requests: number;
  /** 今日已计 input+output tokens */
  tokens: number;
  /** 生效的请求日限额（0 = 不限） */
  requestLimit: number;
  /** 生效的 token 日限额（0 = 不限） */
  tokenLimit: number;
  /** v4.5.0：本月已累计估算成本（$，DB + 缓冲；仅设预算时计算） */
  monthCost: number;
  /** v4.5.0：生效的月度成本预算（$；0 = 不限） */
  monthlyCostLimit: number;
}

/** 汇总某密钥今日用量（UsageDaily 已落库 + 内存缓冲；不区分 ok/失败——配额按尝试计） */
async function sumTodayUsage(apiKeyName: string): Promise<{ requests: number; tokens: number }> {
  const day = localDayKey();
  const rows = await db.usageDaily.findMany({
    where: { day, apiKeyName },
    select: { requests: true, inputTokens: true, outputTokens: true },
  });
  let requests = 0;
  let tokens = 0;
  for (const r of rows) {
    requests += r.requests;
    tokens += r.inputTokens + r.outputTokens;
  }
  const buf = peekUsageDailyToday(apiKeyName);
  requests += buf.requests;
  tokens += buf.inputTokens + buf.outputTokens;
  return { requests, tokens };
}

/**
 * 汇总某密钥本月已累计估算成本（$）。
 * 当月 UsageDaily 行（day 前缀匹配）按模型分组 × 单价表 + 今日缓冲按模型分组 × 单价表。
 * 与总览成本卡同口径（estimateRowCost 单点复用）；未配置单价的模型天然不计成本。
 */
async function sumMonthCost(apiKeyName: string): Promise<number> {
  const month = localDayKey().slice(0, 7); // YYYY-MM（本地时区自然月）
  const rows = await db.usageDaily.findMany({
    where: { day: { startsWith: month }, apiKeyName },
    select: { model: true, inputTokens: true, outputTokens: true, cachedTokens: true },
  });
  // 按模型分组合并（DB 行 + 缓冲行统一进同一桶后逐桶计价）
  const byModel = new Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number }>();
  const addRow = (model: string, inputTokens: number, outputTokens: number, cachedTokens: number) => {
    const b = byModel.get(model) || { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    b.inputTokens += inputTokens;
    b.outputTokens += outputTokens;
    b.cachedTokens += cachedTokens;
    byModel.set(model, b);
  };
  for (const r of rows) addRow(r.model, r.inputTokens, r.outputTokens, r.cachedTokens);
  for (const r of peekUsageDailyTodayByModel(apiKeyName)) addRow(r.model, r.inputTokens, r.outputTokens, r.cachedTokens);

  const pricing = await loadPricingMap();
  let cost = 0;
  for (const [model, tokens] of byModel) {
    const c = estimateRowCost(pricing, model, tokens.inputTokens, tokens.outputTokens, tokens.cachedTokens);
    if (c !== null) cost += c; // 未配置单价 → 不计成本（保守口径）
  }
  return Math.round(cost * 1e6) / 1e6;
}

/** 本地时区下一个零点（配额自然重置时刻）距现在的秒数 */
function secondsUntilLocalMidnight(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/** 本地时区下月 1 日 0 点（月预算自然重置时刻）距现在的秒数 */
function secondsUntilNextMonth(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

function quotaResponse(
  request: Request,
  message: string,
  snapshot: QuotaSnapshot,
  which: "requests" | "tokens"
): Response {
  const resetSec = secondsUntilLocalMidnight();
  const limit = which === "requests" ? snapshot.requestLimit : snapshot.tokenLimit;
  const used = which === "requests" ? snapshot.requests : snapshot.tokens;
  const remaining = Math.max(0, limit - used);
  return new Response(
    JSON.stringify({
      error: {
        type: "rate_limit_error",
        message,
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(resetSec),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": String(remaining),
        "X-RateLimit-Reset": String(resetSec),
        ...corsHeadersFor(request),
      },
    }
  );
}

/** v4.5.0：月预算耗尽响应（429 + X-Budget-* 头组；Retry-After 为下月 1 日重置秒数） */
function budgetResponse(request: Request, message: string, snapshot: QuotaSnapshot): Response {
  const resetSec = secondsUntilNextMonth();
  const remainingUsd = Math.max(0, snapshot.monthlyCostLimit - snapshot.monthCost);
  return new Response(
    JSON.stringify({
      error: {
        type: "rate_limit_error",
        message,
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(resetSec),
        "X-RateLimit-Limit": "budget",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(resetSec),
        // 4 位小数（微预算/测试场景可读；真实预算 $ 量级下 toFixed(4) 同样精确）
        "X-Budget-Limit": snapshot.monthlyCostLimit.toFixed(4),
        "X-Budget-Remaining": remainingUsd.toFixed(4),
        "X-Budget-Reset": String(resetSec),
        ...corsHeadersFor(request),
      },
    }
  );
}
/**
 * F1 修复（并发配额超发）—— 原子预占层。
 *
 * 原缺陷：enforceVirtualKeyQuota 是「读快照 → 判定」两步，二者之间没有任何互斥；
 * 而用量真正落库要到响应结束后（dispatch 的 onUsage → requestLog 的 30s 内存缓冲）才发生。
 * 于是 N 个并发请求会同时读到同一个 used 值、同时通过判定，日配额/月预算可被成倍突破。
 *
 * 修复策略（不新增表、不改 schema、零方言分支）：
 *   1) 进程内为每个 key 维护「已在本进程内放行但尚未反映到统计的请求数」= pending；
 *   2) 用一把按 key 共享的串行队列，把「读统计 + 合并 pending + 判定 + 占位」压成一个临界区，
 *      同一 key 的并发请求在网关内排队通过，判定依据始终是最新的 used+pending；
 *   3) 请求结束后（含异常）由 release 归还占位——成功时用量已被 requestLog 计入，释放即可；
 *      失败/异常时同样释放，保证不会因异常把额度永久锁死。
 *
 * 边界说明：多进程/多实例部署下，本层只能约束单进程内的并发；跨进程仍需数据库侧的
 * 原子扣减（条件 UPDATE）才能彻底闭合。但相较于修复前「同一进程内也完全无保护」，
 * 已是把超发窗口从「无界」收敛到「实例数 × 单请求」的量级。
 */
type PendingBucket = { day: string; count: number };
const pendingByKey = new Map<string, PendingBucket>();
const keyLocks = new Map<string, Promise<void>>();

/** 取某 key 当前 pending（跨日自动归零，避免昨天的占位泄漏到今天） */
function pendingCount(keyName: string): number {
  const b = pendingByKey.get(keyName);
  if (!b || b.day !== localDayKey()) return 0;
  return b.count;
}

/** 占位 +1 */
function acquireSlot(keyName: string): void {
  const day = localDayKey();
  const b = pendingByKey.get(keyName);
  if (!b || b.day !== day) pendingByKey.set(keyName, { day, count: 1 });
  else b.count += 1;
}

/** 归还占位（幂等保护：计数不为负、不跨日串味） */
function releaseSlot(keyName: string): void {
  const b = pendingByKey.get(keyName);
  if (!b || b.day !== localDayKey()) return;
  b.count = Math.max(0, b.count - 1);
  if (b.count === 0) pendingByKey.delete(keyName);
}

/** 按 key 串行化：把「读+判+占」放进临界区（前一任务无论成功失败都解锁） */
async function withKeyLock<T>(keyName: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(keyName) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => (unlock = resolve));
  keyLocks.set(keyName, prev.then(() => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    unlock();
    // 队列尾部已轮到自己的 gate，若没有后继任务则清理，避免 Map 无界增长
    if (keyLocks.get(keyName) === prev.then(() => gate)) keyLocks.delete(keyName);
  }
}

/**
 * 入口配额预检（虚拟密钥主体）。调用点：body 读取 + 模型白名单复检之后、dispatch 之前——
 * 被拒请求零上游成本、零日志写入。非虚拟密钥主体直接放行（零开销）。
 * v4.5.0：日配额与月预算共用一次入口预检；月预算仅在设置了 monthlyCostLimit 时才查询
 * 单价表与当月聚合（未设预算的密钥零额外开销）。
 */
export async function enforceVirtualKeyQuota(
  request: Request,
  auth: AuthResult
): Promise<{ ok: true; snapshot: QuotaSnapshot | null } | { ok: false; response: Response }> {
  if (!auth.ok || !auth.principal) return { ok: true, snapshot: null };
  const vk = auth.principal.virtualKey;
  if (!vk) return { ok: true, snapshot: null }; // master / cron：无配额语义

  const requestLimit = Math.max(0, Math.floor(Number(vk.dailyRequestLimit) || 0));
  const tokenLimit = Math.max(0, Math.floor(Number(vk.dailyTokenLimit) || 0));
  const monthlyCostLimit = Math.max(0, Number(vk.monthlyCostLimit) || 0);
  if (requestLimit <= 0 && tokenLimit <= 0 && monthlyCostLimit <= 0) return { ok: true, snapshot: null }; // 未设限额零查询直通

  const keyName = auth.principal.name || "";

  // F1 修复：判定与占位必须在同一临界区内完成，并计入本进程已放行但未落库的 pending。
  const verdict = await withKeyLock(keyName, async () => {
    const { requests, tokens } = await sumTodayUsage(keyName);
    const monthCost = monthlyCostLimit > 0 ? await sumMonthCost(keyName) : 0;
    const pending = pendingCount(keyName);
    // 判定口径：已落库 + 本进程在途。请求维度按「每请求占 1」计入，避免并发全部踩线通过。
    const requestSnapshot = {
      requests: requests + pending,
      tokens,
      requestLimit,
      tokenLimit,
      monthCost,
      monthlyCostLimit,
    };

    if (requestLimit > 0 && requests + pending >= requestLimit) {
      return {
        ok: false as const,
        response: quotaResponse(
          request,
          `Daily request quota exhausted for API key "${keyName}": ${requests + pending}/${requestLimit} requests today. Limit resets at local midnight.`,
          requestSnapshot,
          "requests"
        ),
      };
    }
    if (tokenLimit > 0 && tokens >= tokenLimit) {
      return {
        ok: false as const,
        response: quotaResponse(
          request,
          `Daily token quota exhausted for API key "${keyName}": ${tokens.toLocaleString()}/${tokenLimit.toLocaleString()} tokens today. Limit resets at local midnight.`,
          requestSnapshot,
          "tokens"
        ),
      };
    }
    if (monthlyCostLimit > 0 && monthCost >= monthlyCostLimit) {
      return {
        ok: false as const,
        response: budgetResponse(
          request,
          `Monthly cost budget exhausted for API key "${keyName}": estimated $${monthCost.toFixed(4)} of $${monthlyCostLimit.toFixed(2)} this month (model pricing table basis; unpriced models excluded). Budget resets at start of next local month.`,
          requestSnapshot
        ),
      };
    }

    // 通过：立即占位，使并发后继请求看到 +1
    acquireSlot(keyName);
    return { ok: true as const, snapshot: requestSnapshot };
  });

  return verdict;
}

/**
 * F1 配套：归还 enforceVirtualKeyQuota 占用的额度位。
 * 调用点必须在请求生命周期结束处（成功 / 失败 / 抛异常）调用一次，避免占位泄漏把额度锁死。
 * 对未设限额或非虚拟密钥主体（从未占位）是安全的空操作。
 */
export function releaseQuotaSlot(auth: AuthResult): void {
  const vk = auth.principal?.virtualKey;
  if (!vk) return;
  const keyName = auth.principal?.name || "";
  if (!keyName) return;
  releaseSlot(keyName);
}
