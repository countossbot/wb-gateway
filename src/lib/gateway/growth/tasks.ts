// 成长中心任务注册表（静态定义，与参考脚本一一对应）。
// 共 34 项：32 项可执行 + 2 项被标记 excluded（需人工/无法自动完成）。
// 分组归属是写死的，不要随意调整——前端分组展示与执行编排都依赖它。

import type { GrowthGroup, GrowthTaskDef } from "./types";

/** 全部任务定义（含被排除项） */
export const GROWTH_TASKS: GrowthTaskDef[] = [
  // ---------- 成长中心任务（17 可执行 + 1 排除） ----------
  { code: "create_canvas", label: "设计创意模式", group: "growth", mechanism: "real_api" },
  { code: "playbook_prompt", label: "探索优秀灵感", group: "growth", mechanism: "web_event" },
  { code: "RichMeow_Chat", label: "桌面端对话", group: "growth", mechanism: "desktop_event" },
  { code: "Library_read", label: "体验资料库", group: "growth", mechanism: "web_event" },
  { code: "Expert_lighthouse", label: "腾讯轻量云专家", group: "growth", mechanism: "web_event" },
  { code: "Hp_Appearance", label: "和平精英主题", group: "growth", mechanism: "web_event" },
  { code: "Buddy_App", label: "发现应用", group: "growth", mechanism: "desktop_event" },
  { code: "Buddy_App_QQ", label: "企鹅教师助手", group: "growth", mechanism: "desktop_event" },
  { code: "Model_chat_GLM5.2", label: "GLM-5.2模型对话", group: "growth", mechanism: "real_api" },
  { code: "black_cat", label: "夜猫子活动", group: "growth", mechanism: "real_api" },
  { code: "Expert_team_use_3", label: "召唤3次专家团", group: "growth", mechanism: "real_api" },
  { code: "first_buddy", label: "领取Buddy", group: "growth", mechanism: "desktop_event" },
  { code: "chat_5", label: "和AI聊天5次", group: "growth", mechanism: "real_api" },
  { code: "skill_1", label: "尝鲜热门技能", group: "growth", mechanism: "desktop_event" },
  { code: "expert_5", label: "召唤5次专家", group: "growth", mechanism: "web_event" },
  { code: "template_5", label: "使用5个模板", group: "growth", mechanism: "web_event" },
  { code: "automation_1", label: "设置自动化任务", group: "growth", mechanism: "web_event" },
  {
    // 公益专家：需要真实捐款，自动化无法完成，仅做展示
    code: "Expert_Philanthropy",
    label: "公益专家",
    group: "growth",
    mechanism: "web_event",
    excluded: true,
    excludedReason: "需真实捐款，无法自动完成",
  },
  // ---------- 开学季活动（4 可执行 + 1 排除） ----------
  { code: "share_invite", label: "分享活动给好友", group: "school", mechanism: "miniprogram_event" },
  { code: "chat_3_times", label: "和 AI 对话 3 次", group: "school", mechanism: "miniprogram_event" },
  { code: "desktop_chat_1_time", label: "桌面端功能体验", group: "school", mechanism: "desktop_event" },
  { code: "expert_use", label: "召唤 1 次开学季专家", group: "school", mechanism: "miniprogram_event" },
  {
    // 学生认证：需要微信实名认证，属于人工环节
    code: "task_student_verify",
    label: "学生认证",
    group: "school",
    mechanism: "miniprogram_event",
    excluded: true,
    excludedReason: "需微信实名认证，人工环节",
  },

  // ---------- 小程序任务（3 项，无排除） ----------
  { code: "Sequential_Tasks_1", label: "小程序内完成1次对话", group: "miniprogram", mechanism: "miniprogram_event" },
  {
    code: "Sequential_Tasks_2",
    label: "小程序内选中专家并完成对话",
    group: "miniprogram",
    mechanism: "miniprogram_event",
  },
  { code: "school_season", label: "参与校园日有奖活动", group: "miniprogram", mechanism: "miniprogram_event" },

  // ---------- 互动玩法（8 项，全部 playground） ----------
  { code: "lottery", label: "幸运大转盘抽奖", group: "play", mechanism: "playground" },
  { code: "blindbox", label: "盲盒", group: "play", mechanism: "playground" },
  { code: "buddy_info", label: "Buddy信息", group: "play", mechanism: "playground" },
  { code: "buddy_travel", label: "派猫猫旅行", group: "play", mechanism: "playground" },
  { code: "redeem", label: "积分兑换", group: "play", mechanism: "playground" },
  { code: "makeup", label: "补签卡", group: "play", mechanism: "playground" },
  { code: "gift_compensation", label: "礼包补偿", group: "play", mechanism: "playground" },
  { code: "badges", label: "徽章", group: "play", mechanism: "playground" },
];

/** 分组元数据（前端分组展示用） */
export const GROWTH_GROUPS: { id: GrowthGroup; label: string }[] = [
  { id: "growth", label: "成长中心任务" },
  { id: "school", label: "开学季活动" },
  { id: "miniprogram", label: "小程序任务" },
  { id: "play", label: "互动玩法" },
];

/** 按分组取可执行任务（自动过滤 excluded 项） */
export function tasksForGroups(groups: GrowthGroup[]): GrowthTaskDef[] {
  const set = new Set(groups);
  return GROWTH_TASKS.filter((t) => !t.excluded && set.has(t.group));
}
