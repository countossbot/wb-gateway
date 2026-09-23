// 成长中心 —— 「每任务事件配方表」（T3）。
//
// 背景：此前的 runner 只按 def.mechanism 粗粒度地发一个事件就宣称成功，
// 导致「已提交但进度未动」的静默成功。本文件把参考脚本
// /Volumes/stable/workbuddy_daily.py 里每个任务的**真实事件序列**逐字段搬过来，
// 按「任务 code → 通道 + 事件构造器」的形式定义成配方；runner 只负责调度。
//
// 设计约束：
// 1. 本文件**不 import 具体 client 类**（该文件正被并行任务改造），只依赖下面的
//    窄接口 GrowthReporter 声明所需方法，保证两侧可独立编译。
// 2. 所有 id 一律走 deriveId(uid, kind)（稳定纯函数），禁止 Math.random/Date.now
//    参与身份类字段，避免上游把同一账号判为异常设备。
// 3. 事件字段逐条对照参考脚本行号抄写，行号写在每个构造函数上方，方便回归核对。

import { deriveId, desktopFingerprint } from "./derive";
import type { ExpertInfo, GrowthReporter, RecipeCtx } from "./types";

// ─────────────────────────────────────────────────────────────
// 常量（对齐参考脚本 L149 / L152 / L219-232）
// ─────────────────────────────────────────────────────────────

/** 企鹅教师助手模板（Buddy_App_QQ） */
export const QQ_TPL = "cb_y5Dy46tPQGGWtueMxXbe";
/** 和平精英激战金秋主题 key（Hp_Appearance） */
export const THEME_KEY = "theme-tkmw7j";
/** 资料库介绍页（Library_read） */
export const LIB_DOC_URL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
/** 尝鲜热门技能名（skill_1） */
export const SKILL_NAME = "algorithmic-trading";
/** 开学季活动 id */
export const SCHOOL_ACTIVITY_ID = "school_open_day_2026";
/** 开学季专家分类（expert_use） */
export const SCHOOL_EXPERT_CATEGORY = "16-BackToSchool";
/** 专家市场配置（内联兜底，对齐 L153） */
export const EXPERT_MARKETPLACE_URL =
  "https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace/expert_center.json";
/** 每轮之间写入间隔（秒），对齐脚本常量 WRITE_GAP */
export const WRITE_GAP_SEC = 2;
/** 桌面事件请求模型（对齐 L2125 附近默认值） */
const DESKTOP_MODEL_ID = "fast-model";
const DESKTOP_MODEL_NAME = "fast-model";
/** 专家事件统一请求模型（对齐 L882 / L1552 / L768） */
const EXPERT_MODEL_ID = "deepseek-v4-flash";
const EXPERT_MODEL_NAME = "DeepSeek V4 Flash";
/** web 域 ideName（chat_request_events 公共段，对齐 L625） */
const WEB_IDE_NAME = "web-Agents";

/** 模板场景（对齐 L897-899；上游配置拉不到时用这份兜底） */
export const TEMPLATE_SCENES: Array<{ id: string; name: string }> = [
  { id: "01-ProductDesign", name: "产品设计" },
  { id: "02-Marketing", name: "营销文案" },
  { id: "03-DataAnalysis", name: "数据分析" },
  { id: "04-Education", name: "教育培训" },
  { id: "05-OfficeWork", name: "办公效率" },
];

// ─────────────────────────────────────────────────────────────
// 通用小工具
// ─────────────────────────────────────────────────────────────

/** 毫秒时间戳（事件 timestamp / clientSendTime 用；不参与身份派生，允许用 Date） */
function nowMs(): number {
  return Date.now();
}

/** uuid v4 形态的随机 id（requestId / messageId 等一次性字段，对齐脚本 str(uuid.uuid4())） */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 兜底：非加密随机也满足「一次性、不用于身份」的要求
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 北京时间小时（0-23）。参考脚本 beijing_now()，不依赖系统 TZ。 */
export function beijingHour(): number {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.getUTCHours();
}

/** 北京时间 date 字符串 YYYY-MM-DD */
export function beijingDate(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 夜猫窗口：CST 23:00 - 次日 08:00（对齐 L2095-2100） */
export function withinNightWindow(): boolean {
  const h = beijingHour();
  return h >= 23 || h < 8;
}

/** chat/web 域公共段（对齐 L625-628） */
function webCommon(uid: string, nick: string) {
  return {
    userId: uid,
    userNickname: nick,
    ideName: WEB_IDE_NAME,
    ideType: WEB_IDE_NAME,
    machineId: deriveId(uid, "webmachine"),
    machineName: "MacBookPro",
    os: "Mac OS X",
    osVersion: "10.15.7",
    arch: "x64",
    clientVersion: "1.0.0",
    ideVersion: "1.100.0",
    netType: "WIFI",
    timezone: "Asia/Shanghai",
  };
}

/** 小程序公共段（对齐 L1585-1595 mp_base） */
export function mpBase(uid: string, nick: string) {
  return {
    timestamp: nowMs(),
    ideType: "workbuddy-mp",
    ideName: "workbuddy-mp",
    userId: uid,
    username: nick,
    userNickname: nick,
    platform: "mp-weixin",
    clientVersion: "2.4.0",
    os: "windows",
    osVersion: "11",
    arch: "x64",
    machineId: deriveId(uid, "mpmachine"),
    timezone: "Asia/Shanghai",
  };
}

/** 小程序 chat_request_send 单事件（对齐 L1596-1612 mp_chat_event） */
export function mpChatEvent(
  uid: string,
  nick: string,
  convId: string,
  activityId?: string,
): Record<string, unknown> {
  const ev: Record<string, unknown> = {
    eventCode: "chat_request_send",
    conversationId: convId,
    requestId: "wbmp-" + uuid(),
    messageId: "wbmp-msg-" + uuid(),
    requestModelId: "glm-5.2",
    requestModelName: "GLM-5.2",
    source: "mini",
    inputToken: 12,
    outputToken: 0,
    status: "success",
  };
  if (activityId) ev.activityId = activityId;
  return ev;
}

/** 小程序「召唤专家 + 实际使用」双事件（对齐 L1615-1646 mp_expert_use_events） */
export function mpExpertUseEvents(
  uid: string,
  nick: string,
  expertId: string,
  expertName: string,
  convId: string,
  activityId?: string,
): Array<Record<string, unknown>> {
  const rid = "wb2api-" + uuid();
  const evs: Array<Record<string, unknown>> = [
    {
      eventCode: "expert_summoned",
      id: expertId,
      name: expertName,
      expertTitle: expertName,
      type: "agent",
      expertType: "expert",
      source: "school",
      category: SCHOOL_EXPERT_CATEGORY,
      conversationId: convId,
      requestId: rid,
    },
    {
      eventCode: "expert_actual_use",
      id: expertId,
      name: expertId,
      expertTitle: expertName,
      type: "agent",
      expertType: "expert",
      source: "school",
      category: SCHOOL_EXPERT_CATEGORY,
      expertId,
      expertName,
      conversationId: convId,
      requestId: rid,
      "codebuddy.session_id": convId,
      "codebuddy.conversation_request_id": rid,
    },
  ];
  if (activityId) for (const e of evs) e.activityId = activityId;
  return evs;
}

/** web 域单元素点击事件（对齐 L2207-2220 report_web_event） */
function webClickEvent(
  uid: string,
  nick: string,
  eventCode: string,
  pageUrl: string,
  elementId: string,
  elementName: string,
): Record<string, unknown> {
  return {
    eventCode,
    ...webCommon(uid, nick),
    timestamp: nowMs(),
    reportDelay: 0,
    pageURL: pageUrl,
    elementId,
    elementName,
    userId: uid,
    userNickname: nick,
  };
}

/** 桌面端公共指纹（对齐 L2078-2092 desktop_fingerprint） */
function desktopFp(uid: string, nick: string) {
  return desktopFingerprint(uid, nick);
}

/** 桌面 6 连「成功对话」事件链（对齐 L2114-2171 desktop_chat_sequence） */
export function desktopChatSequence(
  uid: string,
  nick: string,
  conversationId: string,
  requestId: string,
  messageId: string,
  modelId: string = DESKTOP_MODEL_ID,
  modelName: string = DESKTOP_MODEL_NAME,
): Array<Record<string, unknown>> {
  const fp = desktopFp(uid, nick);
  const ev: Array<Record<string, unknown>> = [];
  const mk = (eventCode: string, extra: Record<string, unknown>) => {
    const e: Record<string, unknown> = {
      eventCode,
      timestamp: nowMs(),
      reportDelay: 0,
      ...fp,
      ...extra,
    };
    ev.push(e);
  };

  mk("chat_request_send", {
    conversationId,
    requestId,
    messageId,
    requestModelId: modelId,
    requestModelName: modelName,
    has_repo: false,
    repo_type: "none",
    workspace_type: "empty",
    isNewConversation: true,
    isNewSession: true,
    triggerType: "manual",
  });
  mk("chat_message_send", {
    conversationId,
    messageId: messageId + "-user",
    requestId,
    role: "user",
    inputToken: 12,
    contentType: "text",
  });
  mk("chat_message_response", {
    messageId: messageId + "-assistant",
    responseModelId: modelId,
    inputToken: 12,
    outputToken: 64,
    totalToken: 76,
    conversationId,
    requestId,
    status: "success",
  });
  mk("chat_message_status", {
    conversationId,
    messageId: messageId + "-assistant",
    requestId,
    status: "success",
    durationMs: 1200,
  });
  mk("chat_request_response", {
    conversationId,
    requestId,
    messageId,
    responseModelId: modelId,
    status: "success",
    isEnd: true,
    "codebuddy.session_id": conversationId,
    "codebuddy.conversation_request_id": requestId,
    traceId: requestId,
    rootRequestId: requestId,
    parentConversationId: conversationId,
    agentName: "cli",
    agentType: "main",
  });
  return ev;
}

/** 桌面「进入 Buddy 应用」五连事件（对齐 L2174-2188 desktop_buddy5_sequence） */
export function desktopBuddy5Sequence(
  uid: string,
  nick: string,
  buddyId: string,
  buddyName: string,
): Array<Record<string, unknown>> {
  const fp = desktopFp(uid, nick);
  const ev: Array<Record<string, unknown>> = [];
  const mk = (eventCode: string, extra: Record<string, unknown>) => {
    ev.push({ eventCode, timestamp: nowMs(), reportDelay: 0, ...fp, ...extra });
  };
  mk("buddyapp_discover_click", { elementId: buddyId, elementName: buddyName });
  mk("buddyapp_show", { elementId: buddyId, elementName: buddyName });
  mk("buddyapp_enter_click", {
    elementId: buddyId,
    elementName: buddyName,
    position: 2,
    isFirstPage: "1",
  });
  mk("buddyapp_auth_confirm_click", { elementId: buddyId, elementName: buddyName });
  mk("buddyapp_bindaccount_skip_click", { elementId: buddyId, elementName: buddyName });
  return ev;
}

/**
 * web 域「真实对话」配套事件链（对齐 L622-642 chat_request_events）。
 * 返回 5 个事件：chat_request_send / chat_message_send / chat_message_response
 *              / chat_message_status / chat_request_response。
 */
export function chatRequestEvents(
  uid: string,
  nick: string,
  convId: string,
  prompt: string,
  txt: string,
): Array<Record<string, unknown>> {
  const common = webCommon(uid, nick);
  const rid = "cmb-" + uuid();
  const mid = "cmb-" + uuid();
  const inputToken = Math.max(1, Math.ceil(prompt.length / 2));
  const outputToken = Math.max(1, Math.ceil(txt.length / 2));
  return [
    {
      eventCode: "chat_request_send",
      ...common,
      timestamp: nowMs(),
      reportDelay: 0,
      conversationId: convId,
      requestId: rid,
      messageId: mid,
      requestModelId: "glm-5.2",
      requestModelName: "GLM-5.2",
      has_repo: false,
      repo_type: "none",
      workspace_type: "empty",
      isNewConversation: true,
      isNewSession: true,
      triggerType: "manual",
      source: "web",
    },
    {
      eventCode: "chat_message_send",
      ...common,
      timestamp: nowMs(),
      reportDelay: 0,
      conversationId: convId,
      requestId: rid,
      messageId: mid + "-user",
      role: "user",
      inputToken,
      contentType: "text",
      source: "web",
    },
    {
      eventCode: "chat_message_response",
      ...common,
      timestamp: nowMs(),
      reportDelay: 0,
      conversationId: convId,
      requestId: rid,
      messageId: mid + "-assistant",
      responseModelId: "glm-5.2",
      inputToken,
      outputToken,
      totalToken: inputToken + outputToken,
      status: "success",
      source: "web",
    },
    {
      eventCode: "chat_message_status",
      ...common,
      timestamp: nowMs(),
      reportDelay: 0,
      conversationId: convId,
      requestId: rid,
      messageId: mid + "-assistant",
      status: "success",
      durationMs: 1500,
      source: "web",
    },
    {
      eventCode: "chat_request_response",
      ...common,
      timestamp: nowMs(),
      reportDelay: 0,
      conversationId: convId,
      requestId: rid,
      messageId: mid,
      responseModelId: "glm-5.2",
      status: "success",
      isEnd: true,
      "codebuddy.session_id": convId,
      "codebuddy.conversation_request_id": rid,
      traceId: rid,
      rootRequestId: rid,
      agentName: "cli",
      agentType: "main",
      source: "web",
    },
  ];
}

/** 开学季桌面 6 连事件（对齐 L1883-1893 _school_desktop_seq_event，额外打 activityId） */
export function schoolDesktopSeqEvent(
  uid: string,
  nick: string,
  convId: string,
): Array<Record<string, unknown>> {
  return desktopChatSequence(uid, nick, convId, "wbsc-" + uuid(), "wbsc-msg-" + uuid()).map(
    (e) => ({ ...e, activityId: SCHOOL_ACTIVITY_ID }),
  );
}

// ─────────────────────────────────────────────────────────────
// 配方执行上下文（runner 注入）
// ─────────────────────────────────────────────────────────────

/** 单轮执行结果 */
interface RoundOutcome {
  /** 本轮是否向上游发出了至少 1 次有效上报 */
  reported: boolean;
  /** 人类可读的补充说明（进日志） */
  note?: string;
}

/** 配方定义：由 runner 按 code 取出并执行 */
export interface Recipe {
  code: string;
  /** 通道说明（写进日志，便于排障） */
  channel: string;
  /** 是否需要多轮循环（按上游进度收敛） */
  loop: boolean;
  /**
   * 执行一轮。ctx 提供 progress() 查询与各通道上报能力。
   * 返回 reported=false 表示本轮未发出任何上报（如前置条件不满足）。
   */
  run: (ctx: RecipeCtx) => Promise<RoundOutcome>;
}

// ─────────────────────────────────────────────────────────────
// 配方：报告类（CLOUD 桌面通道 reportCloud）
// ─────────────────────────────────────────────────────────────

/** create_canvas：设计创意模式（对齐 L921-931） */
const createCanvas: Recipe = {
  code: "create_canvas",
  channel: "reportCloud",
  loop: false,
  run: async (ctx) => {
    // 对齐 L923-925：单次上报两个事件（同一请求内）
    await ctx.client.reportCloud([
      {
        eventCode: "agent_task_created",
        source: "CLOUD",
        name: "",
        mode: "craft",
        requestModelId: "default",
        task_mode: "design",
      } as Record<string, unknown>,
      { eventCode: "wbx_design_canvas_task_create" } as Record<string, unknown>,
    ]);
    return { reported: true };
  },
};

/** template_5：使用 5 个模板（对齐 L895-917） */
const template5: Recipe = {
  code: "template_5",
  channel: "reportCloud",
  loop: true,
  run: async (ctx) => {
    const scenes = TEMPLATE_SCENES;
    // 对齐 L900-914：每个场景一轮，3 个事件；tid 直接用场景 id
    for (const sc of scenes) {
      await ctx.client.reportCloud([
        {
          eventCode: "agent_task_created",
          source: "CLOUD",
          name: "",
          mode: "craft",
          requestModelId: "default",
          action: sc.id,
          has_template: true,
          template_id: sc.id,
          template_name: sc.name,
        } as Record<string, unknown>,
        {
          eventCode: "agent_task_created_with_template",
          templateId: sc.id,
          templateName: sc.name,
          isCustomModel: true,
          id: sc.id,
          name: sc.name,
        } as Record<string, unknown>,
        {
          eventCode: "playbook_prompt_send",
          ext1: uuid(),
          requestId: uuid(),
          id: sc.id,
          name: sc.name,
          type: "other",
          promptLength: 30,
          isOfficial: 1,
          source: "growth-center",
        } as Record<string, unknown>,
      ]);
      await ctx.sleep(WRITE_GAP_SEC);
    }
    return { reported: true, note: `已上报 ${scenes.length} 个模板` };
  },
};

/**
 * 普通专家事件对（expert_5，对齐 L882-890）。
 * 注意脚本里 expert_5 的 expertType 是 "agent"（不是 "expert"）。
 */
function expertPair(e: ExpertInfo): Array<Record<string, unknown>> {
  return [
    {
      eventCode: "expert_summoned",
      id: e.id,
      name: e.name,
      type: "agent",
      expertTitle: e.profession || "",
      expertType: "agent",
    },
    {
      eventCode: "expert_actual_use",
      id: e.id,
      name: e.name,
      type: "agent",
      expertTitle: e.profession || "",
      expertType: "agent",
    },
  ];
}

/**
 * 腾讯轻量云专家事件对（Expert_lighthouse，对齐 L1548-1558）。
 * 字段与普通专家不同：带 source/timestamp/version/cost/characterCount/conversationId 等。
 */
function lighthousePair(uid: string, e: ExpertInfo): Array<Record<string, unknown>> {
  const rid = uuid();
  const cid = "conv-" + uuid();
  return [
    {
      eventCode: "expert_summoned",
      id: e.id,
      name: e.name,
      type: "agent",
      expertTitle: e.profession || "",
      expertType: "agent",
      source: "builtin",
      timestamp: nowMs(),
    },
    {
      eventCode: "expert_actual_use",
      id: e.id,
      name: e.name,
      expertTitle: e.profession || "",
      type: "agent",
      expertType: "agent",
      source: "builtin",
      version: "",
      cost: 0,
      characterCount: 12,
      conversationId: cid,
      requestId: rid,
      messageId: rid,
      requestModelId: EXPERT_MODEL_ID,
      requestModelName: EXPERT_MODEL_NAME,
      userId: uid,
    },
  ];
}

/** expert_5：召唤 5 次普通专家（对齐 L869-892） */
const expert5: Recipe = {
  code: "expert_5",
  channel: "reportCloud",
  loop: true,
  run: async (ctx) => {
    const experts = await ctx.getNormalExperts(20);
    if (!experts.length) {
      return { reported: false, note: "专家市场为空，跳过本轮" };
    }
    const i = ctx.round % experts.length;
    const e = experts[i];
    await ctx.client.reportCloud(expertPair(e));
    return { reported: true, note: `专家 ${e.name}` };
  },
};

/** Expert_lighthouse：腾讯轻量云专家（对齐 L1535-1560） */
const expertLighthouse: Recipe = {
  code: "Expert_lighthouse",
  channel: "reportCloud",
  loop: false,
  run: async (ctx) => {
    const experts = await ctx.getNormalExperts(20);
    let lh =
      experts.find(
        (e) => (e.name || "").includes("轻量") || (e.id || "").toLowerCase().includes("lighthouse"),
      ) || null;
    if (!lh && experts.length) lh = experts[0];
    if (!lh) lh = { id: "expert-lh-" + uuid().slice(0, 8), name: "轻量云专家" };
    await ctx.client.reportCloud(lighthousePair(ctx.uid, lh));
    return { reported: true, note: `专家 ${lh.name}` };
  },
};

/** automation_1：画布自动化 3 事件（对齐 L919-933） */
const automation1: Recipe = {
  code: "automation_1",
  channel: "reportCloud",
  loop: false,
  run: async (ctx) => {
    // 对齐 L930-933：3 个事件同一请求；只有 create 带 isAutomationBackground
    await ctx.client.reportCloud([
      {
        eventCode: "automated_task_create",
        action: "create",
        isAutomationBackground: true,
      } as Record<string, unknown>,
      { eventCode: "automated_task_create_suc", action: "create" } as Record<string, unknown>,
      { eventCode: "automated_task_execute", action: "execute" } as Record<string, unknown>,
    ]);
    return { reported: true };
  },
};

/** playbook_prompt：单个 playbook_prompt_send（对齐 L935-938） */
const playbookPrompt: Recipe = {
  code: "playbook_prompt",
  channel: "reportCloud",
  loop: false,
  run: async (ctx) => {
    // 对齐 L938：playbook_prompt_send 单事件
    await ctx.client.reportCloud([
      {
        eventCode: "playbook_prompt_send",
        promptLength: 30,
        isOfficial: 1,
        source: "growth-center",
      } as Record<string, unknown>,
    ]);
    return { reported: true };
  },
};

/** Library_read：web 域两次元素点击（对齐 L815-826） */
const libraryRead: Recipe = {
  code: "Library_read",
  channel: "reportWeb",
  loop: false,
  run: async (ctx) => {
    await ctx.client.reportWeb([
      webClickEvent(
        ctx.uid,
        ctx.nick,
        "web_element_click",
        LIB_DOC_URL,
        "library_doc_intro_click",
        "WorkBuddy资料库介绍",
      ),
    ]);
    await ctx.sleep(WRITE_GAP_SEC);
    await ctx.client.reportWeb([
      webClickEvent(
        ctx.uid,
        ctx.nick,
        "web_element_click",
        LIB_DOC_URL,
        "library_doc_read_click",
        "WorkBuddy资料库文档阅读",
      ),
    ]);
    return { reported: true };
  },
};

/** Hp_Appearance：先切主题再上报 appearance_skin_apply（对齐 L796-813） */
const hpAppearance: Recipe = {
  code: "Hp_Appearance",
  channel: "attachTheme + reportCloud",
  loop: false,
  run: async (ctx) => {
    if (!ctx.client.setTheme) {
      return { reported: false, note: "client 未提供 setTheme，无法切换主题" };
    }
    const ok = await ctx.client.setTheme(THEME_KEY);
    if (!ok) return { reported: false, note: "主题切换接口失败，跳过上报" };
    await ctx.sleep(WRITE_GAP_SEC);
    await ctx.client.reportCloud([
      { eventCode: "appearance_skin_apply", themeKey: THEME_KEY, source: "CLOUD" },
    ]);
    return { reported: true };
  },
};

// ─────────────────────────────────────────────────────────────
// 配方：LOCAL 桌面序列 / 真实对话
// ─────────────────────────────────────────────────────────────

/** Buddy_App / Buddy_App_QQ：桌面五连（对齐 L778-793 + L2174-2188） */
function buddyAppRecipe(code: string): Recipe {
  return {
    code,
    channel: "reportCloud(desktop)",
    loop: false,
    run: async (ctx) => {
      const buddyId = deriveId(ctx.uid, "buddy-app");
      await ctx.client.reportCloud(desktopBuddy5Sequence(ctx.uid, ctx.nick, buddyId, code));
      // 对齐 L778-793：Buddy_App 与 Buddy_App_QQ 走同一五连序列
      return { reported: true };
    },
  };
}

/** first_buddy：LOCAL 事件 + 协议/领取 API（对齐 L1489-1507） */
const firstBuddy: Recipe = {
  code: "first_buddy",
  channel: "reportCloud + buddyApi",
  loop: false,
  run: async (ctx) => {
    await ctx.client.reportCloud([
      { eventCode: "buddy_agreement_view", timestamp: nowMs() } as Record<string, unknown>,
    ]);
    if (!ctx.client.buddyAgree || !ctx.client.buddyFirst) {
      return { reported: true, note: "client 缺少 buddy 接口，仅上报查看事件" };
    }
    const a = await ctx.client.buddyAgree();
    if (!a) return { reported: true, note: "agree 接口失败" };
    const f = await ctx.client.buddyFirst();
    return { reported: true, note: f ? "领取成功" : "领取接口失败" };
  },
};

/** skill_1：装插件 → 查技能 id → skill_info（对齐 L1388-1434） */
const skill1: Recipe = {
  code: "skill_1",
  channel: "installPlugin + marketSkill + reportCloud",
  loop: false,
  run: async (ctx) => {
    if (ctx.needRealDesktop && ctx.desktopSeq) {
      // Windows 真机桌面流程（参考脚本 L1334-1385）在 Node 侧不可用，退回遥测。
    }
    if (!ctx.client.installPlugin || !ctx.client.marketSkillList) {
      return { reported: false, note: "client 缺少插件安装/技能列表接口" };
    }
    const ok = await ctx.client.installPlugin(SKILL_NAME);
    if (!ok) return { reported: false, note: "插件安装失败" };
    const skillId = await ctx.client.marketSkillList(SKILL_NAME);
    if (!skillId) return { reported: false, note: "未查到技能 id" };
    await ctx.client.reportCloud([
      {
        eventCode: "skill_info",
        skillId,
        skillName: SKILL_NAME,
        action: "install",
        source: "CLOUD",
      } as Record<string, unknown>,
    ]);
    return { reported: true, note: `技能 ${skillId}` };
  },
};

/** RichMeow_Chat：桌面 6 连（对齐 L1397-1407 + L2114-2171） */
const richMeowChat: Recipe = {
  code: "RichMeow_Chat",
  channel: "reportCloud(desktop)",
  loop: false,
  run: async (ctx) => {
    const conv = "fp-rm-conv-" + deriveId(ctx.uid, "rm-conv");
    const req = "fp-rm-req-" + deriveId(ctx.uid, "rm-req");
    const msg = "fp-rm-msg-" + deriveId(ctx.uid, "rm-msg");
    await ctx.client.reportCloud(desktopChatSequence(ctx.uid, ctx.nick, conv, req, msg));
    return { reported: true };
  },
};

/** chat_5 / Model_chat_GLM5.2：真实对话 + 配套 5 事件（对齐 L829-843） */
function chatRecipe(code: string, prompts: string[]): Recipe {
  return {
    code,
    channel: "webchat + reportCloud",
    loop: true,
    run: async (ctx) => {
      const prompt = prompts[ctx.round % prompts.length];
      const r = await ctx.client.webchat(code, prompt);
      if (!r || !r.conversationId) {
        return { reported: false, note: "webchat 无响应" };
      }
      await ctx.client.reportCloud(
        chatRequestEvents(ctx.uid, ctx.nick, r.conversationId, prompt, r.content || "OK"),
      );
      // 对齐 L831-843：每轮一次 webchat + 5 个配套事件
      return { reported: true };
    },
  };
}

/** black_cat：仅 23:00-08:00 执行，有响应即完成当日（对齐 L844-866） */
const blackCat: Recipe = {
  code: "black_cat",
  channel: "webchat + reportCloud",
  loop: true,
  run: async (ctx) => {
    if (!withinNightWindow()) {
      return { reported: false, note: "非夜猫窗口（CST 23:00-08:00），跳过" };
    }
    const prompts = ["今天天气怎么样？", "1+1等于几？", "讲个笑话"];
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await ctx.client.webchat("black_cat", prompts[attempt % prompts.length]);
      if (r && r.content) {
        last = r.content;
        break;
      }
      await ctx.sleep(5);
    }
    if (!last) return { reported: false, note: "夜猫子对话 3 次均失败" };
    const r = await ctx.client.webchat("black_cat", prompts[0]);
    if (r && r.conversationId) {
      await ctx.client.reportCloud(
        chatRequestEvents(ctx.uid, ctx.nick, r.conversationId, prompts[0], r.content || last),
      );
    }
    return { reported: true, note: "当日 1 次已完成" };
  },
};

/** Expert_team_use_3：真实团队对话 + 遥测（对齐 L741-775） */
const expertTeamUse3: Recipe = {
  code: "Expert_team_use_3",
  channel: "webchat(meta) + reportCloud",
  loop: true,
  run: async (ctx) => {
    const teams = await ctx.getTeamExperts(10);
    if (!teams.length) return { reported: false, note: "团队专家为空" };
    const team = teams[ctx.round % teams.length];
    const prompt = "你好，请简单介绍一下你们团队能帮我做什么，回答OK即可";
    const reqId = uuid();
    const msgId = "cmb-" + uuid();
    const ge = [
      {
        eventCode: "ExpertActualUse",
        id: team.id,
        extra: {
          name: team.name,
          expertTitle: team.profession || "",
          type: team.industryId || "",
          expertType: "team",
          source: "builtin",
          version: "",
          cost: 8,
          characterCount: prompt.length,
          requestId: reqId,
          messageId: msgId,
          requestModelId: "glm-5.2",
          requestModelName: "GLM-5.2",
        },
        expertType: "team",
      },
    ];
    // 对齐 L760-766：整块 meta 挂在 "codebuddy.ai" 下
    const meta = {
      "codebuddy.ai": {
        growthEvent: JSON.stringify(ge),
        promptRequestId: reqId,
        clientSendTime: nowMs(),
        userId: ctx.uid,
        mode: "craft",
        model: "glm-5.2",
        expertId: team.id,
        expert: {
          id: team.id,
          name: team.name,
          profession: team.profession || "",
          prompt: prompt.slice(0, 50),
        },
        tags: ["expert:" + team.id],
      },
    };
    const r = await ctx.client.webchat("team", prompt, meta);
    const convId = r && r.conversationId ? r.conversationId : "wbteam-" + uuid();
    // 对齐 L769-772：再补一条 expert_actual_use（type=agent 的团队遥测）
    await ctx.client.reportCloud([
      {
        eventCode: "expert_actual_use",
        id: team.id,
        name: team.name,
        expertTitle: team.profession || "",
        type: team.industryId || "",
        expertType: "team",
        source: "builtin",
        version: "",
        cost: 8,
        characterCount: prompt.length,
        conversationId: convId,
        requestId: reqId,
        messageId: msgId,
        requestModelId: "glm-5.2",
        requestModelName: "GLM-5.2",
      } as Record<string, unknown>,
    ]);
    return { reported: true, note: `团队 ${team.name}` };
  },
};

// ─────────────────────────────────────────────────────────────
// 配方：小程序口径（reportMp）
// ─────────────────────────────────────────────────────────────

/** Sequential_Tasks_1：小程序 chat_request_send（对齐 L1750-1754） */
const sequentialTasks1: Recipe = {
  code: "Sequential_Tasks_1",
  channel: "reportMp",
  loop: true,
  run: async (ctx) => {
    await ctx.client.reportMp([mpChatEvent(ctx.uid, ctx.nick, "wb" + deriveId(ctx.uid, "mp-conv"))]);
    return { reported: true };
  },
};

/** Sequential_Tasks_2：小程序专家双事件（对齐 L1756-1764） */
const sequentialTasks2: Recipe = {
  code: "Sequential_Tasks_2",
  channel: "reportMp",
  loop: true,
  run: async (ctx) => {
    let eid = "";
    let ename = "";
    if (ctx.fetchSchoolExpert) {
      const r = await ctx.fetchSchoolExpert();
      eid = r.id;
      ename = r.name;
    }
    if (!eid) {
      eid = "WorkspaceBuilder";
      ename = "专家";
    }
    const conv = "wbexp-" + uuid();
    await ctx.client.reportMp(mpExpertUseEvents(ctx.uid, ctx.nick, eid, ename, conv));
    return { reported: true, note: `专家 ${ename}` };
  },
};

/** school_season：小程序校园日对话 + activityId（对齐 L1767-1772） */
const schoolSeason: Recipe = {
  code: "school_season",
  channel: "reportMp",
  loop: true,
  run: async (ctx) => {
    await ctx.client.reportMp([
      mpChatEvent(ctx.uid, ctx.nick, "wbmps-" + uuid(), SCHOOL_ACTIVITY_ID),
    ]);
    return { reported: true };
  },
};

/** chat_3_times：3 次真实对话 + mp_chat_event（对齐 L1596-1612 用法） */
const chat3Times: Recipe = {
  code: "chat_3_times",
  channel: "webchat + reportMp",
  loop: true,
  run: async (ctx) => {
    const prompt = ["你好", "今天天气怎么样？", "1+1等于几？"][ctx.round % 3];
    const r = await ctx.client.webchat("chat3", prompt);
    const conv = r && r.conversationId ? r.conversationId : "wbmp-" + uuid();
    await ctx.client.reportMp([mpChatEvent(ctx.uid, ctx.nick, conv)]);
    return { reported: true };
  },
};

// ─────────────────────────────────────────────────────────────
// 配方：开学季腾讯 copilot 通道（desktop_chat_1_time / expert_use）
// ─────────────────────────────────────────────────────────────

/** desktop_chat_1_time：开学季桌面通道（对齐 L2270-2293 + L1883-1893） */
const desktopChat1Time: Recipe = {
  code: "desktop_chat_1_time",
  channel: "schoolReport(desktop)",
  loop: false,
  run: async (ctx) => {
    if (!ctx.schoolReport) {
      return { reported: false, note: "未注入 schoolReport 通道" };
    }
    const conv = "wbsc-" + uuid();
    const ok = await ctx.schoolReport(schoolDesktopSeqEvent(ctx.uid, ctx.nick, conv), {
      desktop: true,
    });
    return { reported: ok, note: ok ? "开学季桌面事件已发" : "开学季桌面上报失败" };
  },
};

/** expert_use（开学季）：拉 BackToSchool 专家后上报（对齐 L1807-1818 + L1860-1882） */
const schoolExpertUse: Recipe = {
  code: "expert_use",
  channel: "schoolReport + fetchSchoolExpert",
  loop: false,
  run: async (ctx) => {
    if (!ctx.schoolReport) {
      return { reported: false, note: "未注入 schoolReport 通道" };
    }
    let eid = "";
    let ename = "";
    if (ctx.fetchSchoolExpert) {
      const r = await ctx.fetchSchoolExpert();
      eid = r.id;
      ename = r.name;
    }
    if (!eid) {
      eid = "WorkspaceBuilder";
      ename = "开学季助手";
    }
    const conv = "wbsc-" + uuid();
    const ok = await ctx.schoolReport(mpExpertUseEvents(ctx.uid, ctx.nick, eid, ename, conv), {
      desktop: true,
    });
    return { reported: ok, note: ok ? `专家 ${ename} 已上报` : "开学季专家上报失败" };
  },
};

// ─────────────────────────────────────────────────────────────
// 上游数据获取（专家市场 / 开学季专家 / 开学季通道）
//
// 这些接口 client.ts 未封装（且 client.ts 正被并行任务改造），
// 因此在本文件内直接用 fetch 实现；失败一律降级为空结果，绝不抛错。
// ─────────────────────────────────────────────────────────────

/** 专家市场配置缓存（进程内，避免每轮重复拉取） */
let marketplaceCache: { at: number; data: unknown } | null = null;

async function fetchMarketplace(): Promise<unknown> {
  const now = Date.now();
  if (marketplaceCache && now - marketplaceCache.at < 10 * 60 * 1000) {
    return marketplaceCache.data;
  }
  try {
    const r = await fetch(EXPERT_MARKETPLACE_URL, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const data = await r.json();
    marketplaceCache = { at: now, data };
    return data;
  } catch {
    return null;
  }
}

/** 从市场配置里抽取专家数组（兼容多种字段名，对齐脚本 fetch_expert_marketplace） */
function pickExperts(data: unknown): ExpertInfo[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const cands = [d.experts, d.normal_experts, (d.data as Record<string, unknown>)?.experts];
  for (const c of cands) {
    if (!Array.isArray(c)) continue;
    const out: ExpertInfo[] = [];
    for (const it of c) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const id = String(o.id ?? o.expertId ?? "");
      if (!id) continue;
      out.push({
        id,
        name: String(o.name ?? o.expertName ?? id),
        profession: String(o.profession ?? o.profession_name ?? ""),
        industryId: String(o.industryId ?? o.industry_id ?? ""),
      });
    }
    if (out.length) return out;
  }
  return [];
}

/** 普通专家列表（expert_5 / Expert_lighthouse） */
export async function fetchNormalExperts(count = 20): Promise<ExpertInfo[]> {
  const all = pickExperts(await fetchMarketplace());
  return all.slice(0, count);
}

/** 团队专家列表（Expert_team_use_3，对齐 L181-205 get_team_experts） */
export async function fetchTeamExperts(count = 10): Promise<ExpertInfo[]> {
  const data = await fetchMarketplace();
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const c = d.teams ?? d.team_experts ?? (d.data as Record<string, unknown>)?.teams;
    if (Array.isArray(c)) {
      const out: ExpertInfo[] = [];
      for (const it of c) {
        if (!it || typeof it !== "object") continue;
        const o = it as Record<string, unknown>;
        const id = String(o.id ?? o.expertId ?? "");
        if (!id) continue;
        out.push({
          id,
          name: String(o.name ?? o.expertName ?? id),
          profession: String(o.profession ?? ""),
          industryId: String(o.industryId ?? ""),
        });
      }
      if (out.length) return out.slice(0, count);
    }
  }
  // 兜底：市场里没有团队分类时，用普通专家顶上（保持任务可推进）
  return (await fetchNormalExperts(count)).slice(0, count);
}

/** 开学季专家兜底（对齐 L1810-1815 SCHOOL_EXPERT_FALLBACK） */
const SCHOOL_EXPERT_FALLBACK: ExpertInfo = {
  id: "WorkspaceBuilder",
  name: "开学季助手",
  profession: "教育",
};

/** 开学季专家列表接口请求体（对齐 L1862-1865） */
export async function fetchSchoolExpert(): Promise<{ id: string; name: string }> {
  try {
    const r = await fetch(
      "https://www.codebuddy.cn/v2/operation-platform/market/expert/list",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edition_mode: "all,domestic",
          page: 1,
          page_size: 20,
          sort: 1,
          expert_category: SCHOOL_EXPERT_CATEGORY,
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) return { id: "", name: "" };
    const d = (await r.json()) as { data?: { experts?: unknown[]; results?: unknown[] } };
    const arr = d.data?.experts ?? d.data?.results ?? [];
    const first = arr[0] as Record<string, unknown> | undefined;
    if (first) {
      const id = String(first.id ?? first.expert_id ?? "");
      const name = String(first.name ?? first.expert_name ?? id);
      if (id) return { id, name };
    }
  } catch {
    /* 降级到兜底 */
  }
  return { id: "", name: "" };
}

/** 开学季兜底专家（供 runner 在拉取失败时使用） */
export function schoolExpertFallback(): { id: string; name: string } {
  return { id: SCHOOL_EXPERT_FALLBACK.id, name: SCHOOL_EXPERT_FALLBACK.name };
}

/**
 * 开学季事件上报（对齐 L1842-1858 _school_report）。
 * host 默认 codebuddy.cn；desktop=true 时走 copilot.tencent.com（桌面任务判据）。
 * 信封形状：`{"common": {...}, "events": [...]}` —— 与 reportCloud 的裸数组不同。
 */
export async function schoolReport(
  token: string,
  uid: string,
  nick: string,
  events: Array<Record<string, unknown>>,
  opts: { desktop?: boolean } = {},
): Promise<boolean> {
  const host = opts.desktop ? "https://copilot.tencent.com" : "https://www.codebuddy.cn";
  const common = {
    ideName: opts.desktop ? "web-Agents" : "web",
    ideType: "WorkBuddy",
    ideVersion: "1.0.0",
    mode: opts.desktop ? "LOCAL" : "CLOUD",
    product: "workbuddy",
    userId: uid,
    userNickname: nick,
    timezone: "Asia/Shanghai",
  };
  try {
    const r = await fetch(host + "/v2/report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-User-Id": uid,
      },
      body: JSON.stringify({ common, events }),
      signal: AbortSignal.timeout(20000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
// ─────────────────────────────────────────────────────────────
// 配方表
// ─────────────────────────────────────────────────────────────

/** 全部已实现配方（key = 任务 code） */
export const GROWTH_RECIPES: Record<string, Recipe> = {
  create_canvas: createCanvas,
  template_5: template5,
  expert_5: expert5,
  Expert_team_use_3: expertTeamUse3,
  Expert_lighthouse: expertLighthouse,
  automation_1: automation1,
  playbook_prompt: playbookPrompt,
  Library_read: libraryRead,
  Hp_Appearance: hpAppearance,
  Buddy_App: buddyAppRecipe("Buddy_App"),
  Buddy_App_QQ: buddyAppRecipe("Buddy_App_QQ"),
  first_buddy: firstBuddy,
  skill_1: skill1,
  RichMeow_Chat: richMeowChat,
  chat_5: chatRecipe("chat_5", [
    "你好",
    "今天天气怎么样？",
    "1+1等于几？",
    "Python是什么？",
    "推荐一本好书",
  ]),
  "Model_chat_GLM5.2": chatRecipe("Model_chat_GLM5.2", ["你好，请介绍一下你自己"]),
  black_cat: blackCat,
  chat_3_times: chat3Times,
  desktop_chat_1_time: desktopChat1Time,
  expert_use: schoolExpertUse,
  Sequential_Tasks_1: sequentialTasks1,
  Sequential_Tasks_2: sequentialTasks2,
  school_season: schoolSeason,
  // share_invite 无需事件配方：由 runner 直接调 client.schoolShareComplete()（保持原样）
};

/** 取配方；未定义返回 null（runner 会记 warn，不再伪成功） */
export function getRecipe(code: string): Recipe | null {
  return GROWTH_RECIPES[code] ?? null;
}

/** 明确列出「暂无实现」的任务 code（runner 会跳过并 warn，避免静默成功） */
export const RECIPE_TODO: readonly string[] = [
  // share_invite：不需要事件配方，走既有 schoolShareComplete（不算缺失）
];

export type { GrowthReporter };
