// 虚拟密钥日配额执行（v4.3.0）—— 网关入口侧的成本护栏。
//
// 语义：
// - 仅对虚拟密钥主体生效（Master / Cron / 控制台会话不受限，与模型白名单同款主体语义）；
// - dailyRequestLimit：本地时区日内请求次数上限（到达即拒，被拒请求不计数 → 不存在「越拒越超」死锁）；
// - dailyTokenLimit：本地时区日内 input+output tokens 累计上限（入口按「已累计 ≥ 限额」预检拒绝；
//   单次超大请求自然越过的部分不做回滚——业界通行语义，超额上限≈单请求最大用量）；
// - 0 / 缺省 = 不限额（存量密钥零行为变化）。
//
// 账本口径：UsageDaily 已落库行（day × apiKeyName 求和）+ 内存缓冲 peekUsageDailyToday，
// 与控制台「今日统计」完全同源；被拒请求发生在 dispatch 之前，不产生日志/聚合行。
//
// 响应：429 + 与鉴权拒绝一致的 {error:{message}} 形态 + RFC 标准风格 RateLimit 头组
// （X-RateLimit-Limit/Remaining/Reset + Retry-After），Anthropic/OpenAI 客户端均可识别。

import { db } from "@/lib/db";
import { localDayKey, peekUsageDailyToday } from "@/lib/gateway/config/requestLog";
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

/** 本地时区下一个零点（配额自然重置时刻）距现在的秒数 */
function secondsUntilLocalMidnight(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
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

/**
 * 入口配额预检（虚拟密钥主体）。调用点：body 读取 + 模型白名单复检之后、dispatch 之前——
 * 被拒请求零上游成本、零日志写入。非虚拟密钥主体直接放行（零开销）。
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
  if (requestLimit <= 0 && tokenLimit <= 0) return { ok: true, snapshot: null }; // 未设限额零查询直通

  const keyName = auth.principal.name || "";
  const { requests, tokens } = await sumTodayUsage(keyName);
  const snapshot: QuotaSnapshot = { requests, tokens, requestLimit, tokenLimit };

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
  return { ok: true, snapshot };
}
