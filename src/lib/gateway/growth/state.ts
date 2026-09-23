// 成长中心 —— 账号状态机与全局互斥锁（v4.9.0）
//
// 状态三态（GrowthAccountState.status）：
//   idle    未开始 / 已重置 → 可执行
//   running 执行中（持有全局互斥锁）
//   done    本次全部完成 → 永久锁定，防再次手动执行
//
// 规则（按需求确定）：
//   - 互斥锁「方案 a」：全局串行，任何时刻全站只允许一个账号在跑。
//     内存锁防同进程并发；DB 行状态防重启/多进程误判。
//   - partial（未全部完成）当天可立即重试。
//   - 只有 partial 会在次日 0 点（Asia/Shanghai）被重置为 idle；
//     done 不重置（防再次手动执行）。
import { db } from "@/lib/db";
import { getRuntimeSettingsAsync } from "../config/runtimeSettings";
import type { GrowthGroup } from "./types";

/** 全局互斥锁：同一进程内同时只允许一个成长任务批次 */
let inFlight: { accountId: string; runId: string; startedAt: number } | null = null;

/** running 行存活上限：超过则视为进程异常中断的遗留状态并强制回收 */
const RUNNING_STALE_MS = 30 * 60 * 1000;

export function currentRun(): { accountId: string; runId: string; startedAt: number } | null {
  return inFlight;
}

/**
 * 尝试获取全局互斥锁（方案 a：全站同时只允许一个账号执行）。
 *
 * 三层防护（缺一不可）：
 *   1. 同步占位：在任何 await 之前先置 inFlight —— 否则两个并发请求都会
 *      通过内存检查（await 期间 inFlight 仍为 null），导致两个账号同时跑。
 *   2. DB running 行：覆盖进程重启后内存锁丢失的情况；仅在未见行才拒绝。
 *   3. 陈旧 running 回收：进程被 kill 时会留下永久 running 行，使所有账号
 *      永久不可执行。超过 RUNNING_STALE_MS 的 running 行视为陈旧，强制回收。
 */
export async function acquireLock(
  accountId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // 1) 同步占位（必须在第一个 await 之前，防同进程并发穿透）
  if (inFlight) {
    const who = inFlight.accountId;
    return {
      ok: false,
      reason: who === accountId ? "该账号正在执行中" : `已有其他账号正在执行（${who}），请等待完成`,
    };
  }
  inFlight = { accountId, runId, startedAt: Date.now() };

  try {
    // 3) 陈旧 running 回收：超过阈值仍为 running 的视为异常中断
    const stuck = await db.growthAccountState.findMany({
      where: { status: "running" },
      select: { accountId: true, lastRunAt: true },
    });
    const now = Date.now();
    for (const row of stuck) {
      if (row.accountId === accountId) continue;
      const startedAt = row.lastRunAt ? new Date(row.lastRunAt).getTime() : 0;
      if (now - startedAt > RUNNING_STALE_MS) {
        // 陈旧：强制作废，避免永久卡死
        await db.growthAccountState.update({
          where: { accountId: row.accountId },
          data: { status: "partial", lastError: "执行中断（超时回收）" },
        });
        console.warn(`[Growth] reclaimed stale running state for ${row.accountId}`);
        continue;
      }
      // 2) 真正在跑：回滚占位并拒绝
      inFlight = null;
      return { ok: false, reason: `已有其他账号正在执行（${row.accountId}），请等待完成` };
    }
    await db.growthAccountState.upsert({
      where: { accountId },
      create: { accountId, providerId: "workbuddy", status: "running" },
      update: { status: "running", lastError: "", lastRunAt: new Date() },
    });
    return { ok: true };
  } catch (e) {
    inFlight = null; // 取锁失败必须回滚占位，否则永久自锁
    throw e;
  }
}

/** 释放互斥锁（幂等，finally 中调用） */
export async function releaseLock(accountId: string): Promise<void> {
  if (inFlight && inFlight.accountId === accountId) inFlight = null;
}

/** 结算一次执行：全部完成 → done（永久锁定）；否则 partial（当天可重试） */
export async function settleRun(
  accountId: string,
  opts: { completedCount: number; totalCount: number; groups: GrowthGroup[]; error?: string },
): Promise<"done" | "partial"> {
  const allDone = opts.totalCount > 0 && opts.completedCount >= opts.totalCount;
  const status = allDone ? "done" : "partial";
  await db.growthAccountState.upsert({
    where: { accountId },
    create: {
      accountId,
      providerId: "workbuddy",
      status,
      completedCount: opts.completedCount,
      totalCount: opts.totalCount,
      groups: opts.groups.join(","),
      lastRunAt: new Date(),
      lastError: opts.error || "",
    },
    update: {
      status,
      completedCount: opts.completedCount,
      totalCount: opts.totalCount,
      groups: opts.groups.join(","),
      lastRunAt: new Date(),
      lastError: opts.error || "",
    },
  });
  return status;
}

/**
 * 次日 0 点重置：把「昨天的 partial」清回 idle，让用户次日可再次执行。
 * done 保持锁定（按需求：已完成账号不再手动执行）。
 * 由调度器每小时节流调用（与审计/余额清理同一 tick）。
 */
export async function resetStalePartial(): Promise<number> {
  const bjStartOfToday = startOfBeijingToday();
  const res = await db.growthAccountState.updateMany({
    where: {
      status: "partial",
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: bjStartOfToday } }],
    },
    data: { status: "idle" },
  });
  if (res.count > 0) {
    console.log(`[Growth] reset ${res.count} partial account(s) to idle (次日 0 点重置)`);
  }
  return res.count;
}

/** 北京时间（Asia/Shanghai，UTC+8）当日 0 点对应的 UTC Date */
function startOfBeijingToday(): Date {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600_000);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - 8 * 3600_000);
}

/** 按保留期清理成长日志（append-only 表，只删过期行）。0 = 永久保留。 */
export async function pruneGrowthLogs(): Promise<number> {
  const settings = await getRuntimeSettingsAsync();
  const days = settings.growthLogRetentionDays;
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const res = await db.growthLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (res.count > 0) {
    console.log(`[Growth] pruned ${res.count} log row(s) older than ${days} day(s)`);
  }
  return res.count;
}
