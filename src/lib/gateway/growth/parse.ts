// 上游任务响应解析 —— 容忍字段缺失 / null / 类型漂移，绝不抛异常。
// 期望形状：{ code: 0, data: { tasks: [{ task_code, title, accept_status, progress: { current, target } }] } }

import { GROWTH_TASKS, tasksForGroups } from "./tasks";
import type { GrowthGroup, GrowthProgress, GrowthTaskProgress } from "./types";

/** 判断是否为普通对象（非 null / 非数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 安全取数字：字符串数字也接受，非法值回落默认值 */
function toNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 安全取字符串：仅接受 string，其他一律回落空串 */
function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** code -> 注册表定义，用于回填 label / group（上游可能只返回 task_code） */
const TASK_BY_CODE = new Map(GROWTH_TASKS.map((t) => [t.code, t]));

/**
 * 解析上游 /v2/activity/growth/tasks 响应。
 * completed 判定：accept_status === "completed" | "claimed"，或 progress.current >= progress.target（target > 0）。
 * 未在注册表中的 task_code 也保留（group 默认归入 growth），方便排查上游新增任务。
 */
export function parseTasks(json: unknown): GrowthTaskProgress[] {
  const out: GrowthTaskProgress[] = [];
  if (!isPlainObject(json)) return out;

  const data = isPlainObject(json.data) ? json.data : json;
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
  const progress = Array.isArray(data.task_list) ? data.task_list : [];

  // tasks 与 task_list 两种字段都兼容（不同活动版本字段名略有差异），去重合并
  for (const item of [...rawTasks, ...progress]) {
    if (!isPlainObject(item)) continue;
    const code = toStr(item.task_code) || toStr(item.code) || toStr(item.task_id);
    if (!code) continue;

    const def = TASK_BY_CODE.get(code);
    const progressObj = isPlainObject(item.progress) ? item.progress : {};
    const current = toNumber(progressObj.current ?? item.current ?? item.progress_value, 0);
    const target = toNumber(progressObj.target ?? item.target ?? item.progress_target, 0);
    const status = toStr(item.accept_status) || toStr(item.status);
    // 上游的 accept_status 有 claimed/completed/received 等多种写法，统一归一到布尔
    const completed = status === "completed" || status === "claimed" || (target > 0 && current >= target);
    const accepted = completed || status === "accepted" || status === "received";

    out.push({
      code,
      label: toStr(item.title) || toStr(item.label) || def?.label || code,
      group: def?.group ?? "growth",
      accepted,
      completed,
      current,
      target,
    });
  }

  return out;
}

/**
 * 汇总进度：只统计目标分组内、注册表里非 excluded 的任务。
 * 同一 code 可能在普通响应与小程序响应中重复出现，此处按“进度更大者优先”合并去重。
 */
export function summarize(all: GrowthTaskProgress[], groups: GrowthGroup[]): GrowthProgress {
  const wanted = new Set(tasksForGroups(groups).map((t) => t.code));

  // 先按 code 去重：completed 取或、current 取大、target 取大
  const merged = new Map<string, GrowthTaskProgress>();
  for (const t of all) {
    if (!wanted.has(t.code)) continue;
    const prev = merged.get(t.code);
    if (!prev) {
      merged.set(t.code, { ...t });
      continue;
    }
    merged.set(t.code, {
      ...prev,
      label: prev.label || t.label,
      accepted: prev.accepted || t.accepted,
      completed: prev.completed || t.completed,
      current: Math.max(prev.current, t.current),
      target: Math.max(prev.target, t.target),
    });
  }

  // 注册表中存在但上游未返回的任务，补一条零进度记录，保证 UI 分组完整
  for (const def of tasksForGroups(groups)) {
    if (!merged.has(def.code)) {
      const existing = all.find((t) => t.code === def.code);
      merged.set(def.code, {
        code: def.code,
        label: def.label,
        group: def.group,
        accepted: existing?.accepted ?? false,
        completed: existing?.completed ?? false,
        current: existing?.current ?? 0,
        target: existing?.target ?? 0,
      });
    }
  }

  const tasks = Array.from(merged.values());
  return {
    tasks,
    completedCount: tasks.filter((t) => t.completed).length,
    totalCount: tasks.length,
  };
}
