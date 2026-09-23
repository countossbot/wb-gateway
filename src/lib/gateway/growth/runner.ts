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
import { parseSchoolTasks, parseTasks, summarize } from "./parse";
import { tasksForGroups } from "./tasks";
import type {
  GrowthGroup,
  GrowthProgress,
  GrowthRunEvent,
  GrowthTaskDef,
  GrowthTaskProgress,
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

    // 2) 逐项执行未完成的任务
    const pending = defs.filter((d) => !doneBefore.has(d.code));
    if (pending.length === 0) {
      await emit(ctx, { level: "ok", message: "所有任务均已完成，无需执行" });
    }
    for (const def of pending) {
      await runOne(ctx, client, def);
    }

    // 3) 回读上游真值结算
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

/** 执行单个任务：按机制分派。单项失败只记录，不中断整批。 */
async function runOne(ctx: RunCtx, client: GrowthClient, def: GrowthTaskDef): Promise<void> {
  const label = def.label;
  try {
    await emit(ctx, { level: "info", taskCode: def.code, label, message: `${label}：开始（${def.mechanism}）` });

    // 开学季走独立接口族（portal/activity/school），不能用成长中心的 accept/claim
    if (def.group === "school") {
      await runSchoolTask(ctx, client, def);
      return;
    }

    // 成长中心 / 小程序 / 互动玩法：统一先 accept（上游要求先接受才计入进度）
    await client.accept(def.code, { miniprogram: def.mechanism === "miniprogram_event" });

    switch (def.mechanism) {
      case "playground":
        await runPlayground(ctx, client, def);
        break;
      case "real_api":
        await runRealApi(ctx, client, def);
        break;
      case "miniprogram_event":
      case "desktop_event":
      case "web_event":
      default:
        await runEventReport(ctx, client, def);
        break;
    }

    // 领奖（上游受理后即可领取；失败不视为任务失败）
    await client.claim(def.code, { miniprogram: def.mechanism === "miniprogram_event" }).catch(() => {});
    await emit(ctx, { level: "ok", taskCode: def.code, label, message: `${label}：已提交` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await emit(ctx, { level: "error", taskCode: def.code, label, message: `${label}：失败 ${msg.slice(0, 120)}` });
  }
}

/** 真实 API 类：发真实模型对话（产生真实服务端状态） */
async function runRealApi(ctx: RunCtx, client: GrowthClient, def: GrowthTaskDef): Promise<void> {
  const prompts: Record<string, string[]> = {
    chat_5: ["你好", "今天天气怎么样？", "1+1等于几？", "Python是什么？", "推荐一本好书"],
    "Model_chat_GLM5.2": ["请用一句话介绍你自己"],
    black_cat: ["晚上好"],
    Expert_team_use_3: ["请用一句话介绍团队协作的要点"],
    create_canvas: ["帮我设计一个简洁的产品介绍画布"],
    playbook_prompt: ["给我一个写周报的提示词模板"],
  };
  const list = prompts[def.code] || [def.label];
  for (const p of list) {
    await client.chat(p);
  }
  await emit(ctx, {
    level: "info",
    taskCode: def.code,
    label: def.label,
    message: `${def.label}：已发送 ${list.length} 次真实对话`,
  });
}

/**
 * 开学季任务执行（独立接口族）。
 * 流程对齐参考脚本：viewed（激活）→ 类别判据 → claim。
 */
async function runSchoolTask(ctx: RunCtx, client: GrowthClient, def: GrowthTaskDef): Promise<void> {
  // 1) 先 viewed 激活（部分任务需先查看才可完成）
  await client.schoolViewed(def.code).catch(() => {});

  // 2) 按任务类别触发判据
  switch (def.code) {
    case "share_invite":
      await client.schoolShareComplete().catch(() => {});
      break;
    case "chat_3_times":
      // 和 AI 对话 3 次（真实对话）
      for (const p of ["你好", "1+1等于几？", "推荐一本好书"]) {
        await client.chat(p).catch(() => {});
      }
      break;
    case "desktop_chat_1_time":
      // 桌面端功能体验：非 Windows 环境降级为桌面指纹事件上报
      await client.reportTaskEvent(def.code, "desktop_event").catch(() => {});
      break;
    case "expert_use":
      await client.reportTaskEvent(def.code, "miniprogram_event").catch(() => {});
      break;
    default:
      break;
  }

  // 3) 领取奖励
  await client.schoolClaim(def.code).catch(() => {});
  await emit(ctx, { level: "ok", taskCode: def.code, label: def.label, message: `${def.label}：已提交` });
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

/** 事件上报类（web / 桌面 / 小程序）：按机制构造对应上报体 */
async function runEventReport(ctx: RunCtx, client: GrowthClient, def: GrowthTaskDef): Promise<void> {
  await client.reportTaskEvent(def.code, def.mechanism);
  await emit(ctx, {
    level: "info",
    taskCode: def.code,
    label: def.label,
    message: `${def.label}：已上报 ${def.mechanism} 事件`,
  });
}
