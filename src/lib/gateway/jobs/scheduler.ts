// 定时任务调度器 —— 每日签到 & Token 保活（原 Cloudflare Cron Triggers 的 Node 等价物）。
//
// 能力（验收要求三.3）：
//   - 签到与 Token 保活的开关、执行时间（cron 表达式）、时区均可配置
//   - 展示上次执行结果与逐账号明细（JobRun 表 + CheckinLog 表）
//   - 支持手动立即执行（/api/console/jobs/run）
//   - 配置热生效（每 tick 重读 runtimeSettings，无需重启）
//
// 实现：自研 5 字段 cron 匹配器（分 时 日 月 周），支持 * , - / 与数字；
// 时区用 Intl.DateTimeFormat 取目标时区的字段值比较。

import { getRuntimeSettingsAsync } from "../config/runtimeSettings";
import { getConfig } from "../config/configService";
import { getProviderFleet } from "../core/fleet";
import { db } from "@/lib/db";
import { statSync } from "node:fs";

interface CronFields {
  minute: number[];
  hour: number[];
  day: number[];
  month: number[];
  weekday: number[];
}

// v4.1.0：支持「每日签到」能力的提供商类型集合（与 providers/registry 注册的 adapter 能力对应）。
// 仅用于控制台下拉候选与白名单预检；实际执行仍以 hasDailyCheckin 运行时探针为准 ——
// 未来新增支持签到的 adapter 类型时在此追加即可，fleet 执行层无需改动。
const CHECKIN_CAPABLE_TYPES = ["workbuddy"] as const;

export function checkinCapableProviderTypes(): string[] {
  return [...CHECKIN_CAPABLE_TYPES];
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    if (!Number.isFinite(step) || step < 1) continue;
    let start = min;
    let end = max;
    if (range !== "*" && range !== "") {
      const [s, e] = range.split("-");
      start = parseInt(s, 10);
      end = e !== undefined ? parseInt(e, 10) : start;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    }
    for (let v = start; v <= end; v += step) {
      if (v >= min && v <= max) values.add(v === 7 && max === 6 ? 0 : v);
    }
  }
  return [...values];
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const day = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const weekday = parseField(parts[4], 0, 6);
  if (!minute.length || !hour.length || !day.length || !month.length || !weekday.length) return null;
  return { minute, hour, day, month, weekday };
}

// 目标时区下的字段分解（周日起始为 0，与标准 cron 对齐）
function fieldsInTz(date: Date, tz: string): { minute: number; hour: number; day: number; month: number; year: number; weekday: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      year: "numeric",
      weekday: "short",
      hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      minute: parseInt(parts.minute, 10),
      hour: parseInt(parts.hour, 10) % 24,
      day: parseInt(parts.day, 10),
      month: parseInt(parts.month, 10),
      year: parseInt(parts.year, 10),
      weekday: weekdayMap[parts.weekday] ?? 0,
    };
  } catch {
    // 非法时区回退本地
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      year: date.getFullYear(),
      weekday: date.getDay(),
    };
  }
}

export function cronMatches(date: Date, expr: string, tz: string): boolean {
  const cron = parseCron(expr);
  if (!cron) return false;
  const f = fieldsInTz(date, tz);
  return (
    cron.minute.includes(f.minute) &&
    cron.hour.includes(f.hour) &&
    cron.day.includes(f.day) &&
    cron.month.includes(f.month) &&
    cron.weekday.includes(f.weekday)
  );
}

/** v3.9.3：下一次匹配时刻（从 fromMs 起枚举未来 24h 分钟）。
 *  仅低频摘要（30 分钟一次）使用，成本可忽略；无匹配（非法表达式等）返回 null。 */
export function nextCronMatch(expr: string, tz: string, fromMs: number): number | null {
  if (!parseCron(expr)) return null;
  const startMinute = Math.floor(fromMs / 60000) + 1;
  for (let m = startMinute; m < startMinute + 24 * 60; m++) {
    if (cronMatches(new Date(m * 60000), expr, tz)) return m * 60000;
  }
  return null;
}

/**
 * v3.9.1：区间匹配 —— 返回 (fromMs, toMs] 内第一个匹配 cron 的绝对分钟（无则 null）。
 * 修复「长任务横跨匹配分钟导致漏跑」：任务执行期间 tick 被 running 互斥跳过，瞬时
 * cronMatches 的匹配窗口（60 秒）一过即永久错过；区间匹配让互斥释放后的第一个 tick
 * 回看错过的分钟并补触发（配合 lastCronMinute 去重不会双跑）。
 */
export function cronMatchesRange(fromMs: number, toMs: number, expr: string, tz: string): number | null {
  const firstMinute = Math.floor(fromMs / 60000) + 1;
  const lastMinute = Math.floor(toMs / 60000);
  for (let m = firstMinute; m <= lastMinute; m++) {
    if (cronMatches(new Date(m * 60000), expr, tz)) return m;
  }
  return null;
}

// ---- 调度器主体 ----
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let runningSince = 0;
// v3.9.1：去重键从「日内分钟数」改为「全局绝对分钟」——旧实现跨天重复（每天 09:00 都是 540），
// 进程活过 24h 后第二天同刻会被误判「本分钟已执行」而永久漏跑（QA 实证：checkin 从未有 cron 记录）。
const lastCronMinute = new Map<string, number>();
// v3.9.1：每 job 上次 tick 时刻（区间匹配回看起点——长任务释放互斥后第一 tick 追上错过的匹配分钟）
const lastTickAt = new Map<string, number>();
let lastCatchupCheckAt = 0; // v3.9.1：错失补偿检查节流（60s 一次）
const CATCHUP_CHECK_INTERVAL_MS = 60 * 1000;
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // v3.9.1：单次任务硬超时（网络挂起不再卡死互斥锁）
const RUNNING_WATCHDOG_MS = 30 * 60 * 1000; // v3.9.1：互斥锁看门狗（超时强制释放）
let lastSessionPurgeAt = 0; // v3.0.3：过期会话清扫节流（每小时一次）
const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastAuditPurgeAt = 0; // v3.2.2：审计过期清扫节流（每小时一次）
const AUDIT_PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastCooldownSweepAt = 0; // v3.2.3：过期冷却残留清扫节流（每小时一次）
const COOLDOWN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastBalancePurgeAt = 0; // v3.7.0：余额快照保留期清扫节流（每小时一次）
const BALANCE_PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastWalCheckpointAt = 0; // v3.9.3：WAL 主动 checkpoint 节流（每小时无条件一次）
const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;
let lastWalThresholdCheckAt = 0; // v3.9.3：WAL 阈值检查节流（每分钟一次，防抖）
const WAL_THRESHOLD_CHECK_INTERVAL_MS = 60 * 1000;
const WAL_TRUNCATE_THRESHOLD_BYTES = 512 * 1024; // v3.9.3：-wal 超 512KB 即提前 TRUNCATE（验收：10 分钟后 -wal ≤ 2×主库）
let lastLogPurgeAt = 0; // v3.9.3：请求日志滚动窗口清理节流（每 5 分钟一次）
const LOG_PURGE_INTERVAL_MS = 5 * 60 * 1000;
let lastSummaryAt = 0; // v3.9.3：低频状态摘要节流（每 30 分钟一次）
const SUMMARY_INTERVAL_MS = 30 * 60 * 1000;

// v3.9.1：dev HMR 防多 timer —— 模块热重载会重置本模块的 timer 变量，但旧 interval 仍在跑，
// startScheduler 再入会叠出多个并发 tick。用 globalThis 标记（跨模块实例存活）兜底。
const SCHED_TIMER_KEY = "__uag_scheduler_timer__";

export function startScheduler(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (timer || g[SCHED_TIMER_KEY]) return; // 幂等（含 HMR 场景）
  console.log("[Scheduler] Started (checkin & token keepalive, hot-reload from SQLite settings)");
  timer = setInterval(tick, 30 * 1000); // 30s 粒度：分钟级 cron 已足够精确
  // 避免阻止进程退出
  (timer as unknown as { unref?: () => void }).unref?.();
  g[SCHED_TIMER_KEY] = true;
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  delete (globalThis as unknown as Record<string, unknown>)[SCHED_TIMER_KEY];
}

/**
 * v3.9.1：从 cron 表达式估算执行周期（错失补偿的「超期」判定基准）。
 * 分钟多值 → 最小环形相邻差；小时多值 → 最小环形相邻差；其余按每日一次。
 * 例："0 (星号)/6 星号 星号 星号" → 6h；"0 9 星号 星号 星号" → 24h；"(星号)/5 星号 星号 星号 星号" → 5min。
 */
export function estimateCronIntervalMs(expr: string): number {
  const cron = parseCron(expr);
  if (!cron) return 24 * 60 * 60 * 1000;
  const minRingDiff = (sorted: number[], mod: number): number => {
    let min = Infinity;
    for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
    min = Math.min(min, mod - sorted[sorted.length - 1] + sorted[0]); // 环形闭合差
    return min;
  };
  if (cron.minute.length >= 2) {
    const d = minRingDiff([...cron.minute].sort((a, b) => a - b), 60);
    if (Number.isFinite(d) && d >= 1) return d * 60 * 1000;
  }
  if (cron.hour.length >= 2) {
    const d = minRingDiff([...cron.hour].sort((a, b) => a - b), 24);
    if (Number.isFinite(d) && d >= 1) return d * 60 * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
}

/**
 * v3.9.1：签到错失补偿判定 —— 进程在 cron 触发时刻不可用（重启/OOM/挂起）时，下一个 tick 补跑。
 * 语义：目标时区的「今天」已存在任一 cron 触发时刻且已过 2 分钟，而今天尚无 cron 系（cron/cron-catchup）
 * 执行记录 → overdue。上次执行（无论成败）在昨天或更早才判定，避免双跑。
 */
async function isCheckinOverdue(cronExpr: string, tz: string, now: Date): Promise<boolean> {
  const cron = parseCron(cronExpr);
  if (!cron) return false;
  const f = fieldsInTz(now, tz);
  const nowMin = f.hour * 60 + f.minute;
  // 今天的触发时刻（cron.hour × cron.minute 组合）中是否存在「已过 2 分钟以上」的
  const passed = cron.hour.some((h) => cron.minute.some((m) => h * 60 + m <= nowMin - 2));
  if (!passed) return false;
  // 今天是否已有 cron 系记录：用「最近一次 cron 系执行的 tz 日期 == 当前 tz 日期」判定（免去时区 0 点换算）
  const last = await db.jobRun.findFirst({
    where: { job: "checkin", triggered: { in: ["cron", "cron-catchup"] } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  if (!last) return true; // 从未自动签到过 → 补一次（部署后首次自动签到，语义合理）
  const lf = fieldsInTz(last.startedAt, tz);
  return !(lf.day === f.day && lf.month === f.month && lf.year === f.year);
}

/**
 * v3.9.1：保活错失补偿判定 —— 距最近一次 cron 系保活超过「估算周期 + 10 分钟容差」→ overdue。
 */
async function isKeepaliveOverdue(cronExpr: string, now: Date): Promise<boolean> {
  const interval = estimateCronIntervalMs(cronExpr);
  const last = await db.jobRun.findFirst({
    where: { job: "keepalive", triggered: { in: ["cron", "cron-catchup"] } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  if (!last) return true; // 从未自动保活过
  return now.getTime() - last.startedAt.getTime() > interval + 10 * 60 * 1000;
}

/** v3.9.1：带硬超时的任务执行 —— 上游网络挂起不再永久占用互斥锁（超时后 JobRun 由后台自然落库） */
async function guardedRunJob(job: "checkin" | "keepalive", triggered: "cron" | "cron-catchup"): Promise<void> {
  try {
    await Promise.race([
      runJob(job, triggered),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`job ${job} timed out after ${Math.round(JOB_TIMEOUT_MS / 60000)}min`)), JOB_TIMEOUT_MS);
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (e) {
    console.error(`[Scheduler] job ${job} (${triggered}) failed:`, (e as Error).message);
  }
}

async function tick(): Promise<void> {
  const nowMs = Date.now();
  // v3.9.1：互斥锁看门狗 —— 上一轮 tick 超过 30 分钟未结束（永久挂起）则强制释放，调度器自愈
  if (running) {
    if (runningSince > 0 && nowMs - runningSince > RUNNING_WATCHDOG_MS) {
      console.warn(`[Scheduler] Watchdog: tick stuck for ${Math.round((nowMs - runningSince) / 1000)}s, force-releasing mutex`);
      running = false;
    } else {
      return; // 上轮未完成则跳过（长签到互斥）
    }
  }
  running = true;
  runningSince = nowMs;
  try {
    const settings = await getRuntimeSettingsAsync();
    const now = new Date();

    // v3.9.1：区间匹配触发 —— 回看 (上次 tick, 现在] 内的匹配分钟，互斥阻塞期间错过的
    // 匹配窗口由释放后的第一个 tick 追上（长任务不再吞掉触发点）。
    // 回看窗口上限 35 分钟（> 看门狗周期），防止极端时钟跳跃导致海量枚举。
    const matchCron = (job: "checkin" | "keepalive", expr: string, tz: string, enabled: boolean): number | null => {
      if (!enabled) {
        lastTickAt.set(job, now.getTime());
        return null;
      }
      const prev = lastTickAt.get(job) ?? now.getTime() - 60_000; // 启动后首 tick 回看 1 分钟
      lastTickAt.set(job, now.getTime());
      const lookbackFrom = Math.max(prev, now.getTime() - 35 * 60 * 1000);
      return cronMatchesRange(lookbackFrom, now.getTime(), expr, tz);
    };

    const checkinMinute = matchCron("checkin", settings.checkinCron, settings.checkinTz, settings.checkinEnabled);
    if (checkinMinute !== null && lastCronMinute.get("checkin") !== checkinMinute) {
      lastCronMinute.set("checkin", checkinMinute);
      await guardedRunJob("checkin", "cron");
    }
    const keepaliveMinute = matchCron("keepalive", settings.keepaliveCron, settings.keepaliveTz, settings.keepaliveEnabled);
    if (keepaliveMinute !== null && lastCronMinute.get("keepalive") !== keepaliveMinute) {
      lastCronMinute.set("keepalive", keepaliveMinute);
      await guardedRunJob("keepalive", "cron");
    }

    // v3.9.1：错失补偿（60s 节流）——cron 触发时刻进程不可用（重启/OOM/挂起）后的兜底补跑。
    // 仅在「本次 tick 未区间触发」时检查，避免与上面的正常触发双跑。
    if (nowMs - lastCatchupCheckAt >= CATCHUP_CHECK_INTERVAL_MS) {
      lastCatchupCheckAt = nowMs;
      try {
        if (settings.checkinEnabled && checkinMinute === null && (await isCheckinOverdue(settings.checkinCron, settings.checkinTz, now))) {
          console.log("[Scheduler] Checkin missed its cron window (catch-up run)");
          await guardedRunJob("checkin", "cron-catchup");
        }
        if (settings.keepaliveEnabled && keepaliveMinute === null && (await isKeepaliveOverdue(settings.keepaliveCron, now))) {
          console.log("[Scheduler] Keepalive exceeded its interval (catch-up run)");
          await guardedRunJob("keepalive", "cron-catchup");
        }
      } catch (e) {
        console.error("[Scheduler] catch-up check failed:", e);
      }
    }

    // v3.0.3：过期会话清扫（每小时一次，节流；与签到/保活任务无关，不依赖开关）
    if (now.getTime() - lastSessionPurgeAt >= SESSION_PURGE_INTERVAL_MS) {
      lastSessionPurgeAt = now.getTime();
      try {
        const { purgeExpiredSessions } = await import("../session/session");
        const purged = await purgeExpiredSessions();
        if (purged > 0) console.log(`[Scheduler] Purged ${purged} expired session(s)`);
      } catch (e) {
        console.error("[Scheduler] session purge failed:", e);
      }
    }

    // v3.2.2：操作审计保留期清扫（每小时一次节流；auditRetentionDays=0 表示永久保留，跳过）
    if (now.getTime() - lastAuditPurgeAt >= AUDIT_PURGE_INTERVAL_MS) {
      lastAuditPurgeAt = now.getTime();
      try {
        const purged = await purgeExpiredAuditLogs();
        if (purged > 0) console.log(`[Scheduler] Purged ${purged} expired audit log(s) (retention ${settings.auditRetentionDays}d)`);
      } catch (e) {
        console.error("[Scheduler] audit purge failed:", e);
      }
    }

    // v3.2.3：过期冷却残留清扫（每小时一次节流；纯数据卫生——orderAccounts 已把
    // expiresAt < now 视为健康，过期行留在 DB 只会干扰展示与排查）
    if (now.getTime() - lastCooldownSweepAt >= COOLDOWN_SWEEP_INTERVAL_MS) {
      lastCooldownSweepAt = now.getTime();
      try {
        const { purgeExpiredCooldowns } = await import("../providers/workbuddy/cooldown");
        const swept = await purgeExpiredCooldowns();
        if (swept.db > 0 || swept.mem > 0)
          console.log(`[Scheduler] Swept expired cooldown residue: ${swept.db} db row(s), ${swept.mem} memory record(s)`);
      } catch (e) {
        console.error("[Scheduler] cooldown sweep failed:", e);
      }
    }

    // v3.7.0：余额快照保留期清扫（每小时一次节流；balanceRetentionDays=0 表示永久保留，跳过）
    if (now.getTime() - lastBalancePurgeAt >= BALANCE_PURGE_INTERVAL_MS) {
      lastBalancePurgeAt = now.getTime();
      try {
        const purged = await purgeExpiredBalanceSnapshots();
        if (purged > 0) console.log(`[Scheduler] Purged ${purged} expired balance snapshot row(s) (retention ${settings.balanceRetentionDays}d)`);
      } catch (e) {
        console.error("[Scheduler] balance snapshot purge failed:", e);
      }
    }

    // v3.9.3：请求日志滚动窗口清理（每 5 分钟一次节流）—— 从写入路径移出（原每请求一次
    // count 全表聚合）；按 id 阈值分段删除，每批 ≤500 行短事务，不长时间持有写锁。
    if (now.getTime() - lastLogPurgeAt >= LOG_PURGE_INTERVAL_MS) {
      lastLogPurgeAt = now.getTime();
      try {
        const { purgeRequestLogsByIdThreshold } = await import("../config/requestLog");
        const purged = await purgeRequestLogsByIdThreshold();
        if (purged > 0) console.log(`[Scheduler] Purged ${purged} old request log row(s) (rolling window 5000)`);
      } catch (e) {
        console.error("[Scheduler] request log purge failed:", e);
      }
    }

    // v3.9.3：低频状态摘要（每 30 分钟一次）—— 下次触发时刻 + 当前生效配置。
    // 静置期间（无触发/无清扫/无摘要）日志零新增：替代「每 tick 无条件输出状态行」
    // 的高频重复日志（降噪验收：静置 10 分钟容器日志新增 ≤3 行）。
    if (now.getTime() - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      lastSummaryAt = now.getTime();
      try {
        // 显示用「配置的目标时区」而非服务器本地时区（服务器常为 UTC，直接 getHours 会错位）
        const fmtNext = (expr: string, tz: string): string => {
          const nextMs = nextCronMatch(expr, tz, now.getTime());
          if (nextMs === null) return "无匹配";
          const d = new Date(nextMs);
          const inMin = Math.max(0, Math.round((nextMs - now.getTime()) / 60000));
          let parts: Record<string, string> = {};
          try {
            const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
            for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
          } catch {
            /* 非法时区回退本地 */
          }
          const label = `${parts.month ?? String(d.getMonth() + 1).padStart(2, "0")}-${parts.day ?? String(d.getDate()).padStart(2, "0")} ${parts.hour ?? String(d.getHours()).padStart(2, "0")}:${parts.minute ?? String(d.getMinutes()).padStart(2, "0")}`;
          const inLabel = inMin >= 60 ? `${Math.floor(inMin / 60)}h${inMin % 60}m` : `${inMin}m`;
          return `${label} (${inLabel}后)`;
        };
        console.log(
          `[Scheduler] Summary: checkin=${settings.checkinEnabled ? "on" : "off"} cron="${settings.checkinCron}" tz=${settings.checkinTz} next=${fmtNext(settings.checkinCron, settings.checkinTz)} | ` +
          `keepalive=${settings.keepaliveEnabled ? "on" : "off"} cron="${settings.keepaliveCron}" tz=${settings.keepaliveTz} next=${fmtNext(settings.keepaliveCron, settings.keepaliveTz)}`
        );
      } catch (e) {
        console.error("[Scheduler] summary failed:", e);
      }
    }

    // v3.9.3：WAL 主动收缩 —— 双臂策略：
    //   a) 阈值触发（每分钟检查）：-wal 超 512KB 即提前 TRUNCATE —— journal_size_limit=64MB
    //      只是兜底防线，高频小写入下每小时一次 TRUNCATE 跟不上 WAL 增速（实测 20 分钟涨到 1MB），
    //      阈值臂保证「运行十分钟后 -wal ≤ 2×主库」验收
    //   b) 无条件执行（每小时）：周期性 TRUNCATE 兑底（低流量时 WAL 永远很小，臂 a 不触发）
    //   两者共用同一执行体：checkpoint 前在当前连接重设 per-connection pragma，
    //   TRUNCATE 把 -wal 直接收到 0 字节；失败仅 warn 不抛出。
    const walNow = (() => {
      try {
        return statSync("db/custom.db-wal").size;
      } catch {
        return 0;
      }
    })();
    const walOverThreshold = walNow > WAL_TRUNCATE_THRESHOLD_BYTES && now.getTime() - lastWalThresholdCheckAt >= WAL_THRESHOLD_CHECK_INTERVAL_MS;
    const walHourlyDue = now.getTime() - lastWalCheckpointAt >= WAL_CHECKPOINT_INTERVAL_MS;
    if (walOverThreshold) lastWalThresholdCheckAt = now.getTime();
    if (walOverThreshold || walHourlyDue) {
      lastWalCheckpointAt = now.getTime();
      try {
        await db.$queryRawUnsafe(`PRAGMA journal_size_limit = 67108864`);
        await db.$queryRawUnsafe(`PRAGMA wal_autocheckpoint = 256`);
        const rows = (await db.$queryRawUnsafe(`PRAGMA wal_checkpoint(TRUNCATE)`)) as Array<Record<string, unknown>>;
        const r0 = rows[0] ?? {};
        console.log(`[Scheduler] WAL checkpoint(TRUNCATE) [${walOverThreshold ? "threshold" : "hourly"}]: pre=${walNow}B busy=${String(r0.busy)} wal_pages=${String(r0.log)} checkpointed=${String(r0.checkpointed)}`);
      } catch (e) {
        console.warn("[Scheduler] WAL checkpoint failed:", (e as Error).message);
      }
    }
  } catch (e) {
    console.error("[Scheduler] tick failed:", e);
  } finally {
    running = false;
  }
}

// 执行一个任务并落 JobRun 记录（手动触发传 triggered="manual"；错失补偿传 "cron-catchup"）
// v4.1.1：onlyOverride —— 手动执行签到时可显式传入当前 UI 下拉选择（空数组 = 全部），未传则热读已保存设置。
//   修复：用户在下拉勾选后直接点「立即执行」未先保存，旧实现读保存值（[] = 全部）导致全部提供商执行。
export async function runJob(
  job: "checkin" | "keepalive",
  triggered: "cron" | "cron-catchup" | "manual" = "manual",
  onlyOverride?: string[]
): Promise<unknown> {
  const config = await getConfig();
  const fleet = getProviderFleet(config);
  let detail: unknown;
  let success = true;
  try {
    if (job === "checkin") {
      // v4.1.0：签到提供商白名单（空数组 = 全部支持签到的提供商），热读运行时设置
      const only = Array.isArray(onlyOverride) ? onlyOverride : (await getRuntimeSettingsAsync()).checkinProviders;
      detail = await fleet.runDailyCheckins(only);
      success = Array.isArray(detail) && (detail as Array<{ error?: string }>).every((r) => !r.error);
    } else {
      // 保活：Token 刷新 + 各 provider onSchedule（指纹/免费模型池）
      const refresh = await fleet.refreshAllTokens();
      await fleet.runScheduledTasks();
      detail = { refresh };
      success = true;
    }
  } catch (e) {
    success = false;
    detail = { error: (e as Error).message };
  }
  try {
    await db.jobRun.create({
      data: {
        job,
        triggered,
        success,
        detail: detail as never,
      },
    });
  } catch {
    /* noop */
  }
  return detail;
}

// 上次执行结果（控制台「定时任务」模块展示）
export async function lastJobRuns(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const job of ["checkin", "keepalive"] as const) {
    const last = await db.jobRun.findFirst({ where: { job }, orderBy: { startedAt: "desc" } });
    result[job] = last || null;
  }
  return result;
}

// v3.2.2：按保留期清理过期操作审计（retentionDays=0 永久保留返回 0）。
// 供调度器每小时节流调用与设置页「立即清理」手动触发；仅删 AuditLog，不碰任何业务表。
export async function purgeExpiredAuditLogs(retentionDays?: number): Promise<number> {
  let days = retentionDays;
  if (days === undefined) {
    const { getRuntimeSettingsAsync } = await import("../config/runtimeSettings");
    days = (await getRuntimeSettingsAsync()).auditRetentionDays;
  }
  if (!days || days <= 0) return 0; // 0 = 永久保留
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const r = await db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return r.count;
}

// v3.7.0：按保留期清理过期余额快照（retentionDays=0 永久保留返回 0）。
// 仅删 BalanceSnapshot 中 day < cutoffDay 的行（day 为本地日字符串 YYYY-MM-DD，字符串序即时间序），
// 不碰业务表；保留期语义与审计一致（整日粒度，保留最近 N 天含今日）。
export async function purgeExpiredBalanceSnapshots(retentionDays?: number): Promise<number> {
  let days = retentionDays;
  if (days === undefined) {
    const { getRuntimeSettingsAsync } = await import("../config/runtimeSettings");
    days = (await getRuntimeSettingsAsync()).balanceRetentionDays;
  }
  if (!days || days <= 0) return 0; // 0 = 永久保留
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const r = await db.balanceSnapshot.deleteMany({ where: { day: { lt: cutoffDay } } });
  return r.count;
}
