// 成长中心 —— 执行器（v4.9.1）
//
// 一次「立即执行」的流程（对齐参考脚本的幂等思路）：
//   1. 读上游任务进度（普通口径 + 小程序口径 + 开学季口径，合并去重）
//   2. 对勾选组内「未完成」的任务逐项执行
//   3. 每步产出 GrowthRunEvent（增量写 GrowthLog + 实时推给 UI）
//   4. 执行后回读进度，以「上游真值」结算 completedCount
//
// 重要：完成数以**上游 accept_status/progress** 为准（绝对真值），
// 不按「本次执行成功数」统计 —— 否则数字会随勾选组跳变。
import { db } from "@/lib/db";
import { GrowthClient } from "./client";
import {
  fetchNormalExperts,
  fetchSchoolExpert,
  fetchTeamExperts,
  getRecipe,
  schoolExpertFallback,
  schoolReport,
  WRITE_GAP_SEC,
} from "./events";
import { parseSchoolTasks, parseTasks, summarize } from "./parse";
import { tasksForGroups } from "./tasks";
import type {
  GrowthGroup,
  GrowthProgress,
  GrowthReporter,
  GrowthRunEvent,
  GrowthTaskDef,
  GrowthTaskProgress,
  RecipeCtx,
} from "./types";
import { acquireLock, releaseLock, settleRun } from "./state";

/** 执行上下文：日志同时落库（append-only）并回调给调用方（SSE 推送） */
interface RunCtx {
  accountId: string;
  accountName: string;
  runId: string;
  sink?: (e: GrowthRunEvent) => void;
}

async function emit(ctx: RunCtx, e: Omit<GrowthRunEvent, "ts">): Promise<void> {
  const ev: GrowthRunEvent = { ts: Date.now(), ...e };
  try {
    await db.growthLog.create({
      data: {
        accountId: ctx.accountId,
        accountName: ctx.accountName,
        runId: ctx.runId,
        taskCode: e.taskCode || "",
        label: e.label || "",
        level: e.level,
        message: e.message,
      },
    });
  } catch {
    // 日志落库失败不影响任务执行（与 auditService 同样的容错策略）
  }
  ctx.sink?.(ev);
}

/**
 * 读取上游进度，合并三份口径（缺一份会导致任务被误判为 0/N，使 done 永不可达）：
 *   1. 普通口径   —— 成长中心组任务
 *   2. 小程序口径 —— 小程序组任务（必须带 X-Client-Platform: miniprogram 才下发）
 *   3. 开学季口径 —— 开学季组任务（独立接口 portal/activity/school/tasks）
 */
export async function readProgress(
  client: GrowthClient,
  groups: GrowthGroup[],
): Promise<{ progress: GrowthProgress; raw: GrowthTaskProgress[] }> {
  const wantSchool = groups.includes("school");
  const [normal, mp, school] = await Promise.all([
    client.getTasks().catch(() => null),
    client.getTasks({ miniprogram: true }).catch(() => null),
    wantSchool ? client.getSchoolTasks().catch(() => null) : Promise.resolve(null),
  ]);
  const merged = new Map<string, GrowthTaskProgress>();
  for (const p of [...parseTasks(normal), ...parseTasks(mp), ...parseSchoolTasks(school)]) {
    const prev = merged.get(p.code);
    // 同一 code 多份口径都出现时，取进度更靠前的一份
    if (!prev || p.current > prev.current || (p.completed && !prev.completed)) {
      merged.set(p.code, p);
    }
  }
  const all = [...merged.values()];
  return { progress: summarize(all, groups), raw: all };
}

export interface RunOptions {
  accountId: string;
  accountName: string;
  accessToken: string;
  uid?: string;
  nick?: string;
  groups: GrowthGroup[];
  sink?: (e: GrowthRunEvent) => void;
}

export interface RunResult {
  ok: boolean;
  status?: "done" | "partial";
  completedCount: number;
  totalCount: number;
  error?: string;
}

/** 执行一次成长任务批次（调用方无需预先取锁，此处内部取锁并保证释放） */
export async function runGrowthTasks(opts: RunOptions): Promise<RunResult> {
  const runId = `grow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx: RunCtx = {
    accountId: opts.accountId,
    accountName: opts.accountName,
    runId,
    sink: opts.sink,
  };

  const lock = await acquireLock(opts.accountId, runId);
  if (!lock.ok) {
    await emit(ctx, { level: "error", message: `无法开始：${lock.reason}` });
    return { ok: false, completedCount: 0, totalCount: 0, error: lock.reason };
  }

  const client = new GrowthClient(opts.accessToken, opts.uid || opts.accountId, opts.nick || opts.accountName);
  let lastError = "";

  try {
    const defs = tasksForGroups(opts.groups);
    await emit(ctx, {
      level: "info",
      message: `开始执行 · 账号「${opts.accountName}」· 勾选 ${opts.groups.length} 组 · 共 ${defs.length} 项`,
    });

    // 1) 先读进度，确定哪些需要做（幂等：已完成的不重做）
    const before = await readProgress(client, opts.groups);
    const doneBefore = new Set(before.progress.tasks.filter((t) => t.completed).map((t) => t.code));
    await emit(ctx, {
      level: "info",
      message: `执行前进度：${before.progress.completedCount}/${before.progress.totalCount} 已完成`,
      completedCount: before.progress.completedCount,
      totalCount: before.progress.totalCount,
    });

    // 2) 先确定待办清单，并批量登记（accept）——先受理再上报判据，否则上报不计分
    const pending = defs.filter((d) => !doneBefore.has(d.code));
    if (pending.length === 0) {
      await emit(ctx, { level: "ok", message: "所有任务均已完成，无需执行" });
    }
    const pendingCodes = pending.map((d) => d.code);
    if (pendingCodes.length) {
      try {
        for (const c of pendingCodes) await client.accept(c);
      } catch {
        await emit(ctx, { level: "warn", message: "批量登记失败，继续尝试上报" });
      }
    }

    // 3) 逐项执行未完成的任务（开学季组走独立接口族）
    for (const def of pending) {
      if (def.group === "school") {
        await runSchoolTask(ctx, client, def);
      } else {
        await runOne(ctx, client, def);
      }
    }

    const after = await readProgress(client, opts.groups);
    const status = await settleRun(opts.accountId, {
      completedCount: after.progress.completedCount,
      totalCount: after.progress.totalCount,
      groups: opts.groups,
    });
    await emit(ctx, {
      level: status === "done" ? "ok" : "warn",
      message:
        status === "done"
          ? `全部完成：${after.progress.completedCount}/${after.progress.totalCount}（账号已锁定，不再重复执行）`
          : `未全部完成：${after.progress.completedCount}/${after.progress.totalCount}（当天可重试）`,
      completedCount: after.progress.completedCount,
      totalCount: after.progress.totalCount,
    });
    return {
      ok: true,
      status,
      completedCount: after.progress.completedCount,
      totalCount: after.progress.totalCount,
    };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    await emit(ctx, { level: "error", message: `执行异常：${lastError}` });
    // 异常也要结算，避免账号卡在 running
    await settleRun(opts.accountId, {
      completedCount: 0,
      totalCount: 0,
      groups: opts.groups,
      error: lastError,
    }).catch(() => {});
    return { ok: false, completedCount: 0, totalCount: 0, error: lastError };
  } finally {
    // 异常安全：无论成败都释放全局锁
    await releaseLock(opts.accountId);
  }
}

// ─────────────────────────────────────────────────────────────
// 配方驱动执行（T3）
//
// 旧实现按 def.mechanism 粗粒度分派：发一个事件就宣称成功，
// 于是出现「接口 200、进度不动」的静默成功。现在改为查表执行
// events.ts 里的配方，并要求「上游进度曲线真的动了」才算完成。
// ─────────────────────────────────────────────────────────────

/** 把 GrowthClient 适配成配方所需的最小接口（窄接口，避免直接依赖具体类） */
function asReporter(client: GrowthClient): GrowthReporter {
  return {
    reportCloud: (events) => client.reportCloud(events),
    reportWeb: (events) => client.reportWeb(events),
    reportMp: (events) => client.reportMp(events),
    webchat: (convName, prompt, meta, model) => client.webchat(convName, prompt, meta, model),
  };
}

/** 当前该任务的上游进度（取不到时按「未完成 0/1」处理，保证循环有界） */
async function taskProgress(
  client: GrowthClient,
  def: GrowthTaskDef,
): Promise<{ status: string; cur: number; tgt: number }> {
  try {
    const { progress } = await readProgress(client, [def.group]);
    const t = progress.tasks.find((x) => x.code === def.code);
    if (t) {
      return {
        status: t.completed ? "completed" : t.accepted ? "accepted" : "",
        cur: t.current,
        tgt: t.target,
      };
    }
  } catch {
    /* 读不到就按未完成处理 */
  }
  return { status: "", cur: 0, tgt: 1 };
}

/** 进度是否已达标（对齐脚本：completed/claimed 或 cur >= tgt 即 break） */
function isSatisfied(p: { status: string; cur: number; tgt: number }): boolean {
  if (p.status === "completed" || p.status === "claimed") return true;
  return p.tgt > 0 && p.cur >= p.tgt;
}

/** 构造配方执行上下文 */
function makeRecipeCtx(ctx: RunCtx, client: GrowthClient, round: number): RecipeCtx {
  return {
    uid: client.uid,
    nick: client.nick,
    round,
    client: asReporter(client),
    sleep: (sec) => new Promise((r) => setTimeout(r, Math.max(0, sec) * 1000)),
    getNormalExperts: (count) => fetchNormalExperts(count),
    getTeamExperts: (count) => fetchTeamExperts(count),
    fetchSchoolExpert: async () => {
      const r = await fetchSchoolExpert();
      return r.id ? r : schoolExpertFallback();
    },
    schoolReport: (events, o) => {
      // token 是 client 的私有字段（T3 约定不改 client.ts），此处用窄断言读取，
      // 仅用于开学季 copilot 通道的 Authorization 头。
      const tk = (client as unknown as { token?: string }).token ?? "";
      return schoolReport(tk, client.uid, client.nick, events, o);
    },
    needRealDesktop: false,
  };
}

/**
 * 执行单个任务：查配方 → 多轮执行 → 回读进度确认。
 * 单项失败只记录，不中断整批。
 */
async function runOne(ctx: RunCtx, client: GrowthClient, def: GrowthTaskDef): Promise<void> {
  const label = def.label;
  try {
    await emit(ctx, { level: "info", taskCode: def.code, label, message: `${label}：开始` });

    // 无配方的任务：明确 warn 并跳过（不再伪成功）
    const recipe = getRecipe(def.code);
    if (!recipe) {
      await emit(ctx, {
        level: "warn",
        taskCode: def.code,
        label,
        message: `${label}：暂无事件配方，已跳过（需补充 events.ts 配方）`,
      });
      return;
    }

    const before = await taskProgress(client, def);
    if (isSatisfied(before)) {
      await emit(ctx, {
        level: "info",
        taskCode: def.code,
        label,
        message: `${label}：上游已完成（${before.status} ${before.cur}/${before.tgt}），跳过`,
      });
      return;
    }

    // 多轮：每轮前查进度，达标即 break；轮间 sleep(WRITE_GAP)
    const maxRounds = recipe.loop ? 8 : 1;
    let reported = false;
    let lastNote = "";
    for (let round = 0; round < maxRounds; round++) {
      const p = await taskProgress(client, def);
      if (isSatisfied(p)) break;
      const rctx = makeRecipeCtx(ctx, client, round);
      const out = await recipe.run(rctx);
      reported = reported || out.reported;
      if (out.note) lastNote = out.note;
      if (!out.reported) {
        // 前置条件不满足（如不在夜猫窗口）：不再空转
        await emit(ctx, {
          level: "warn",
          taskCode: def.code,
          label,
          message: `${label}：本轮未上报（${out.note || "条件不满足"}）`,
        });
        break;
      }
      if (round + 1 < maxRounds) await new Promise((r) => setTimeout(r, WRITE_GAP_SEC * 1000));
    }

    // 领奖（上游受理后即可领取；失败不视为任务失败）
    await client.claim(def.code, { miniprogram: def.mechanism === "miniprogram_event" }).catch(() => {});

    // 回读进度，以「上游真值」判定成败（避免静默成功）
    const after = await taskProgress(client, def);
    const moved = after.cur > before.cur || isSatisfied(after);
    const ok = reported && moved;
    await emit(ctx, {
      level: ok ? "ok" : "warn",
      taskCode: def.code,
      label,
      message: ok
        ? `${label}：完成（进度 ${before.cur}/${before.tgt} → ${after.cur}/${after.tgt}）${
            lastNote ? " · " + lastNote : ""
          }`
        : `${label}：已上报但上游进度未变（${before.cur} → ${after.cur}）${
            lastNote ? " · " + lastNote : ""
          }`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await emit(ctx, { level: "error", taskCode: def.code, label, message: `${label}：失败 ${msg.slice(0, 120)}` });
  }
}

/**
 * 开学季任务执行。
 *
 * share_invite 不走上报配方（保持原样：调 schoolShareComplete）。
 * 其余开学季任务若在 events.ts 有配方，则走配方；否则回落到
 * 「viewed 激活 → claim」的最小流程。
 */
async function runSchoolTask(ctx: RunCtx, client: GrowthClient, def: GrowthTaskDef): Promise<void> {
  // share_invite：保持原实现，不引入事件配方
  if (def.code === "share_invite") {
    await client.schoolViewed(def.code).catch(() => {});
    await client.schoolShareComplete().catch(() => {});
    await client.schoolClaim(def.code).catch(() => {});
    await emit(ctx, { level: "ok", taskCode: def.code, label: def.label, message: `${def.label}：已提交` });
    return;
  }

  // 其余任务若有配方（desktop_chat_1_time / expert_use / chat_3_times / school_season），走配方
  if (getRecipe(def.code)) {
    await runOne(ctx, client, def);
    return;
  }

  // 无配方：viewed 激活 → claim（明确 warn，不伪成功）
  await client.schoolViewed(def.code).catch(() => {});
  await client.schoolClaim(def.code).catch(() => {});
  await emit(ctx, {
    level: "warn",
    taskCode: def.code,
    label: def.label,
    message: `${def.label}：暂无事件配方，仅做 viewed/claim`,
  });
}

/** 互动玩法类：纯业务玩法调用（非埋点） */
async function runPlayground(ctx: RunCtx, client: GrowthClient, def: GrowthTaskDef): Promise<void> {
  switch (def.code) {
    case "lottery": {
      const chances = await client.lotteryChances();
      const n = Number((chances as { data?: { balance?: number } })?.data?.balance ?? 0);
      let drew = 0;
      for (let i = 0; i < Math.min(n, 20); i++) {
        await client.lotteryDraw();
        drew++;
      }
      await emit(ctx, {
        level: "info",
        taskCode: def.code,
        label: def.label,
        message: `抽奖：剩余 ${n} 次，已抽 ${drew} 次`,
      });
      break;
    }
    case "blindbox": {
      const quota = await client.blindboxQuota();
      const n = Number((quota as { data?: { affordable?: number } })?.data?.affordable ?? 0);
      if (n > 0) await client.blindboxOpen(Math.min(n, 5));
      await emit(ctx, { level: "info", taskCode: def.code, label: def.label, message: `盲盒：可开 ${n} 次` });
      break;
    }
    case "buddy_travel": {
      const st = await client.buddyTravelStatus();
      const state = String((st as { data?: { state?: string } })?.data?.state ?? "");
      if (state === "arrived") {
        await client.buddyTravelClaim();
        await emit(ctx, { level: "info", taskCode: def.code, label: def.label, message: "旅行已到达，领取奖励" });
      } else if (state === "idle") {
        const cfg = await client.buddyTravelConfig();
        const locs = (cfg as { data?: { locations?: Array<{ id?: number }> } })?.data?.locations ?? [];
        const id = Number(locs[0]?.id ?? 0);
        if (id > 0) await client.buddyTravelDepart(id);
        await emit(ctx, { level: "info", taskCode: def.code, label: def.label, message: `派 Buddy 出发（目的地 ${id}）` });
      } else {
        await emit(ctx, { level: "info", taskCode: def.code, label: def.label, message: `旅行中（${state}），本次不出发` });
      }
      break;
    }
    case "redeem": {
      for (const level of [1, 2, 3]) {
        await client.redeem(level).catch(() => {}); // 403=天数不足 / 409=已兑换，静默
      }
      await emit(ctx, { level: "info", taskCode: def.code, label: def.label, message: "积分兑换：已尝试各档位" });
      break;
    }
    case "badges":
      await client.badges();
      break;
    case "buddy_info":
    case "makeup":
    case "gift_compensation":
    default:
      await client.buddyInfo().catch(() => {});
      break;
  }
}
