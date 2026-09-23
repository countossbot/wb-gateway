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

// ─────────────────────────────────────────────────────────────
// 事件配方（T3）相关类型
//
// 为什么用「窄接口 GrowthReporter」而不是直接 import GrowthClient：
// client.ts 由并行任务改造通道方法，两侧需要能独立编译。runner 传入的
// 实际对象只需满足本接口即可。
// ─────────────────────────────────────────────────────────────

/** 专家条目（来自专家市场配置） */
export interface ExpertInfo {
  id: string;
  name: string;
  profession?: string;
  industryId?: string;
}

/**
 * 配方执行所需的最小上报能力。
 * 所有方法都必须「防御式」：失败返回 false / null，不抛错。
 */
export interface GrowthReporter {
  /** CLOUD 桌面通道（自动补桌面信封） */
  reportCloud(events: Array<Record<string, unknown>>): Promise<boolean>;
  /** web 域通道 */
  reportWeb(events: Array<Record<string, unknown>>): Promise<boolean>;
  /** 小程序通道 */
  reportMp(events: Array<Record<string, unknown>>): Promise<boolean>;
  /** 真实对话（webchat）；失败返回 null */
  webchat(
    convName: string,
    prompt: string,
    meta?: Record<string, unknown>,
    model?: string,
  ): Promise<{ conversationId: string; requestId: string; content: string } | null>;
  // ── 以下为可选能力：client 未提供时配方会降级并说明原因（不伪成功） ──
  /** 切换主题（Hp_Appearance） */
  setTheme?(themeKey: string): Promise<boolean>;
  /** 安装插件（skill_1） */
  installPlugin?(name: string): Promise<boolean>;
  /** 查技能 id（skill_1）；失败返回 null */
  marketSkillList?(name: string): Promise<string | null>;
  /** Buddy 协议同意（first_buddy） */
  buddyAgree?(): Promise<boolean>;
  /** 领取第一只 Buddy（first_buddy） */
  buddyFirst?(): Promise<boolean>;
}

/** 开学季腾讯 copilot 通道上报（desktop_chat_1_time / expert_use） */
export type SchoolReporter = (
  events: Array<Record<string, unknown>>,
  opts?: { desktop?: boolean },
) => Promise<boolean>;

/** 配方执行上下文：由 runner 注入 */
export interface RecipeCtx {
  uid: string;
  nick: string;
  /** 当前轮次（从 0 开始），配方可用它轮转专家/场景 */
  round: number;
  /** 上报客户端（窄接口） */
  client: GrowthReporter;
  /** 睡眠（秒），runner 注入以免阻塞事件循环 */
  sleep: (sec: number) => Promise<void>;
  /** 拉普通专家列表（失败返回空数组） */
  getNormalExperts: (count: number) => Promise<ExpertInfo[]>;
  /** 拉团队专家列表（失败返回空数组） */
  getTeamExperts: (count: number) => Promise<ExpertInfo[]>;
  /** 拉开学季专家（失败返回空 id） */
  fetchSchoolExpert?: () => Promise<{ id: string; name: string }>;
  /** 开学季 copilot 通道上报（未注入时相关配方会明确跳过） */
  schoolReport?: SchoolReporter;
  /** 是否具备真实桌面能力（Windows 桌面换血流程）；Node 侧恒为 false */
  needRealDesktop?: boolean;
  /** 桌面序列额外钩子（预留给真实桌面流程） */
  desktopSeq?: unknown;
}
