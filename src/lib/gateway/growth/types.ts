// WorkBuddy「成长中心」自动化的公共类型定义。
// 该模块为纯 HTTP 客户端（重写自参考 Python 脚本），不依赖 Python / 子进程。
// 注意：本模块仅面向国内站（workbuddy.cn / codebuddy.cn），不要使用 workbuddy.ai。

/** 任务所属分组 */
export type GrowthGroup = "growth" | "school" | "miniprogram" | "play";

/** 任务完成机制：决定用哪种手段触发 */
export type GrowthMechanism =
  | "real_api" // 上游正式接口直接可完成
  | "web_event" // Web 端埋点上报（/v2/report）
  | "desktop_event" // 桌面端埋点上报（需要伪造桌面指纹）
  | "miniprogram_event" // 小程序端埋点上报（X-Client-Platform: miniprogram）
  | "playground"; // 互动玩法（抽奖 / 盲盒 / 兑换等）

/** 单个任务的定义（静态注册表项） */
export interface GrowthTaskDef {
  code: string; // upstream task_code, e.g. "create_canvas"
  label: string; // Chinese display name
  group: GrowthGroup;
  mechanism: GrowthMechanism;
  /** true if the reference script marks it manual/impossible (excluded from execution) */
  excluded?: boolean;
  excludedReason?: string;
}

/** 单个任务的实时进度 */
export interface GrowthTaskProgress {
  code: string;
  label: string;
  group: GrowthGroup;
  accepted: boolean;
  completed: boolean;
  current: number;
  target: number;
}

/** 整体进度汇总 */
export interface GrowthProgress {
  tasks: GrowthTaskProgress[];
  completedCount: number; // tasks where completed===true and not excluded
  totalCount: number; // non-excluded tasks in the requested groups
}

/** 流式推送给 UI 的事件 */
export interface GrowthRunEvent {
  // streamed to UI
  ts: number;
  taskCode?: string;
  label?: string;
  level: "info" | "ok" | "warn" | "error";
  message: string;
  completedCount?: number;
  totalCount?: number;
}
