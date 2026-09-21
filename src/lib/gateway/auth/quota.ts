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
  const { requests, tokens } = await sumTodayUsage(keyName);
  const monthCost = monthlyCostLimit > 0 ? await sumMonthCost(keyName) : 0;
  const snapshot: QuotaSnapshot = { requests, tokens, requestLimit, tokenLimit, monthCost, monthlyCostLimit };

  if (requestLimit > 0 && requests >= requestLimit) {
    return {
      ok: false,
      response: quotaResponse(
        request,
        `Daily request quota exhausted for API key "${keyName}": ${requests}/${requestLimit} requests today. Limit resets at local midnight.`,
        snapshot,
        "requests"
      ),
    };
  }
  if (tokenLimit > 0 && tokens >= tokenLimit) {
    return {
      ok: false,
      response: quotaResponse(
        request,
        `Daily token quota exhausted for API key "${keyName}": ${tokens.toLocaleString()}/${tokenLimit.toLocaleString()} tokens today. Limit resets at local midnight.`,
        snapshot,
        "tokens"
      ),
    };
  }
  if (monthlyCostLimit > 0 && monthCost >= monthlyCostLimit) {
    return {
      ok: false,
      response: budgetResponse(
        request,
        `Monthly cost budget exhausted for API key "${keyName}": estimated $${monthCost.toFixed(4)} of $${monthlyCostLimit.toFixed(2)} this month (model pricing table basis; unpriced models excluded). Budget resets at start of next local month.`,
        snapshot
      ),
    };
  }
  return { ok: true, snapshot };
}
