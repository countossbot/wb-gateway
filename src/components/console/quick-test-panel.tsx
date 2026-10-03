// 快速测试面板（v4.9.8 新增）—— 在虚拟密钥页底部提供端到端 API 测试
//
// 用途：让管理员在创建虚拟密钥后，无需离开控制台即可测试 API 调用是否通畅。
// 替代原有的「复制密钥 → 打开终端 → 粘贴 curl 命令 → 检查响应」多步流程。
//
// v4.9.12-local：真实 SSE 增量渲染（流式逐字上屏）
// v4.9.12-local-r2：升级为轻量 Playground ——
//   - 多轮对话（会话历史保留、气泡渲染、一键清空）
//   - System Prompt 与推理参数（temperature / max_tokens，可折叠高级区）
//   - 双协议切换（OpenAI /v1/chat/completions ↔ Anthropic /v1/messages，含流式事件解析）
//   - 每轮用量与耗时徽标 + 会话累计用量（input/output tokens）
//   - Enter 发送 / Shift+Enter 换行（兼容中文输入法组词态）
//   - 流式中断（AbortController）
// v4.9.12-local-r7：
//   - 模型下拉富展示：消费网关 /v1/models 透传的上游元数据（描述 / 上下文窗口 / 推理·视觉能力），
//     选中模型时在表单下方显示画像信息条
//   - 分享链接：调试参数 + 会话内容编码进 URL query（base64url），他人打开即可还原；
//     API 密钥永不入链；恢复后自动清除 URL 参数防刷新重放
// v4.9.12-local-r8：
//   - 模型下拉路由分组：消费网关 /v1/models 透传的 gateway_routed 标记，
//     分「已配置路由（可调用）/ 未配置路由（调用 404）」两组展示，选中无路由模型时琥珀警告条
//   - stop 截断标注：OpenAI finish=stop / Anthropic stop_reason 证据 + 内容启发式（空响应 /
//     结尾匹配序列），命中时轮次徽标「stop 截断」并在 Markdown 导出中同步标注
// v4.9.12-local-r9：
//   - 分享链接预览对话框：分享前先预览将要编码进 URL 的全部内容（参数 chips / System Prompt /
//     逐轮消息摘要 / 当前输入），确认后一键复制；URL 长度提示与超长拒绝内联展示
//   - 模型列表手动刷新：先经控制台 API 清除网关侧目录元数据缓存（尽力而为），再重拉 /v1/models，
//     新增提供商/候选后描述与能力标注立即可见
// v4.9.12-local-r10：
//   - 逐轮 cURL 复现：每轮请求发出时快照当时的参数与上下文（system / temperature / max_tokens /
//     top_p / stop / 流式 / 历史轮次），assistant 气泡 meta 行 hover 显现 Terminal 按钮，
//     一键复制重现该轮请求的 cURL —— 后续调整参数不影响历史轮次的复现保真度
//   - 修复：cURL 会话导出 Anthropic 分支漏带 temperature（与真实请求组装语义对齐）
// v4.9.13-local-r2：密钥一键载入 ——
//   - KeysModule 把密钥清单（名称/掩码/启用态）透传给本面板，「从密钥列表载入」Popover 直选；
//   - 选中后按 id 走 /api/console/keys?reveal= 换取明文填入输入框（与列表页「显示完整密钥」同一通道、
//     同一粒度：单密钥按需下发、管理员会话必需）；填入后自动触发 /v1/models 拉取（既有 debounce effect）
//   - 已载入密钥名以 chip 形式提示（输入框是 password 型，用户无法直观看到里面是什么）；
//     手动编辑输入框即清除 chip —— 明文只留在本地 state，不回传、不落库、不入分享链接
"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Eraser,
  FileDown,
  History,
  Info,
  KeyRound,
  Link2,
  Loader2,
  FolderOpen,
  Plus,
  RefreshCcw,
  Save,
  Send,
  Settings2,
  Share2,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectRichItem, SelectItemText, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/console/ui";
import { apiGet, apiPost } from "@/lib/console/api";

/** v4.9.13-local-r2：密钥选择器数据源 —— KeysModule 透传的密钥清单（仅展示必要字段，明文不透传） */
export interface PlaygroundKeyOption {
  id: string;
  name: string;
  keyMasked: string;
  enabled: boolean;
}

type Protocol = "openai" | "anthropic";

/** v4.9.12-local-r10：单轮请求参数快照 —— 逐轮 cURL 复现（以当时实际值为准，不受后续调整影响） */
interface TurnRequestSnapshot {
  system: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  stopSeqs: string[];
  stream: boolean;
  /** 本轮请求携带的历史上下文（slice(-MAX_HISTORY) 后的实际值） */
  priorTurns: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** assistant 专属：本轮元信息（耗时 / 用量 / 模型 / 协议） */
  meta?: {
    durationMs: number;
    inTok: number | null;
    outTok: number | null;
    model: string;
    protocol: Protocol;
    /** v4.9.12-local-r8：stop 截断 —— null = 未命中/未知；"" = 显式证据但序列未知；非空 = 命中的序列 */
    stopHit?: string | null;
    /** v4.9.12-local-r10：本轮请求参数快照（逐轮 cURL 复现；旧会话轮次无此字段则按钮不出现） */
    req?: TurnRequestSnapshot;
  };
  /** 中断或出错的轮次标记 */
  aborted?: boolean;
}

interface SessionUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

// v4.9.12-local-r7：/v1/models 目录条目（网关已透传上游扩展元数据，字段均可选）
interface ModelEntry {
  id: string;
  description?: string;
  contextWindow?: number;
  capabilities?: { reasoning?: boolean; streaming?: boolean; vision?: boolean };
  /** v4.9.12-local-r8：网关真实可路由标记（无路由模型调用将 404 No route） */
  routed?: boolean;
}

/** 128000 → "128k"；不足 1k 原样；空值返回 null */
function fmtContext(n?: number | null): string | null {
  if (!n || n <= 0) return null;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * v4.9.12-local-r8：stop 截断检测 ——
 * - 显式证据：OpenAI finish_reason=stop / Anthropic stop_reason=stop_sequence。
 *   注意：网关把 OpenAI finish=stop 转译为 Anthropic end_turn，故该证据在转译链路上不可靠；
 * - 内容启发式：响应为空（trim 后，首 token 即命中序列——实测转译链路会残留空白 token）
 *   或结尾与某序列精确匹配（OpenAI 命中时通常会剥离序列，结尾匹配仅在未剥离场景出现，属强信号）。
 * 返回命中的序列（未知时为 ""）；未配置 stop 或未命中返回 null。
 */
function detectStopHit(stopReason: string | null, content: string, stopList: string[]): string | null {
  if (stopList.length === 0) return null;
  if (content.trim() === "") {
    // 空响应 + 已配置 stop：按截断标注（不依赖显式证据——转译链路 stop_reason 不可靠；
    // 模型自然结束且零输出的概率远低于 stop 首 token 命中）
    return "";
  }
  const hit = stopList.find((s) => content.endsWith(s));
  return hit ?? null;
}

// ---- v4.9.12-local-r7：分享链接编解码（调试参数 + 会话 → URL query 的 base64url 负载）----
// 设计要点：API 密钥绝不入负载；内容经 UTF-8 → base64url，中文/引号/换行安全；
// 恢复时逐字段校验（范围收敛 + 长度截断），防止手工构造 URL 注入非法状态。
interface SharePayload {
  v: 1;
  p: Protocol;
  m: string;
  s: string;
  t: number;
  mt: number;
  tp: number;
  st: string[];
  fl: boolean;
  h: Array<{ r: "u" | "a"; c: string }>;
  q: string;
}

function encodeShareState(d: SharePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShareState(raw: string): SharePayload | null {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const d = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SharePayload>;
    if (!d || d.v !== 1 || (d.p !== "openai" && d.p !== "anthropic")) return null;
    return d as SharePayload;
  } catch {
    return null;
  }
}

const MAX_HISTORY = 20; // 会话保留的最大消息数（防止请求体无限膨胀）

// v4.9.11-sandbox-r10：与沙箱上游真实输出上限对齐（此前 UI 保守限制 32768，上游实为 [1, 98304]）。
// 上游网关侧仍有兜底钳制（v4.9.11-r3 起），此处对齐后 UI 与 API 直调行为一致，消除双重上限困惑。
const MAX_TOKENS_CAP = 98304;

// ---- v4.9.11-sandbox-r10：快捷 Prompt 模板库 ----
// 一键填充常用测试场景（message + 可选 system），覆盖翻译/代码审查/抽取/长输出压测/健康检查等
// Playground 高频用法；点击仅填充输入框（不自动发送），历史会话不受影响。
interface PromptTemplate {
  id: string;
  label: string;
  hint: string;
  message: string;
  system?: string;
}
const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "ping",
    label: "健康检查",
    hint: "最小请求，验证链路连通 · 回复单个单词",
    message: "回复一个单词：PONG",
  },
  {
    id: "translate",
    label: "中英互译",
    hint: "设定专业翻译角色 · 只输出译文",
    system: "你是专业翻译，中英互译准确流畅，专有名词保留原文。",
    message: "把以下内容翻译成英文，只输出译文：\n\n（在此粘贴中文内容）",
  },
  {
    id: "code-review",
    label: "代码审查",
    hint: "指出 bug / 安全风险 / 改进建议",
    message: "审查以下代码，指出 bug、安全风险与改进建议，按严重程度排序：\n\n```\n（在此粘贴代码）\n```",
  },
  {
    id: "json-extract",
    label: "JSON 提取",
    hint: "抽取引擎角色 · 只输出合法 JSON（测试 stop 序列好场景）",
    system: "你是信息抽取引擎，只输出合法 JSON，不要任何解释或代码块围栏。",
    message: "从以下文本提取 {姓名, 邮箱, 电话}，输出 JSON，缺失字段用 null：\n\n（在此粘贴文本）",
  },
  {
    id: "minutes",
    label: "会议纪要",
    hint: "要点式整理：决议 / 待办 / 风险",
    system: "你是专业秘书，输出结构清晰、要点精炼。",
    message: "把以下会议记录整理成要点式纪要，分「决议 / 待办 / 风险」三节：\n\n（在此粘贴记录）",
  },
  {
    id: "long-output",
    label: "长输出压测",
    hint: "800 字以上 · 可配合高级区调大 Max Tokens 验证钳制",
    message: "写一篇 800 字以上的短文，主题：城市夜跑的魅力。要求分三段，语言有画面感。",
  },
  {
    id: "tutor",
    label: "导师角色",
    hint: "角色扮演 + 类比解释（测试 System Prompt 生效）",
    system: "你是一位耐心的编程导师，总用生活中的类比解释技术概念，每次回答不超过 200 字。",
    message: "用类比解释什么是 WebSocket？",
  },
];

// ---- v4.9.12-local-r11：自定义模板（localStorage 持久化） ----
// 用户把常用 prompt 存为本浏览器本地模板（不上传、不入库、不跨设备）；
// 与内置模板同渲染入口，虚线边框区分；读写失败静默降级（隐私模式/配额满不干扰主流程）。
const CUSTOM_TEMPLATES_KEY = "uag-playground-custom-templates-v1";
const CUSTOM_TEMPLATES_CAP = 30;
const CUSTOM_LABEL_CAP = 24;
const CUSTOM_MESSAGE_CAP = 4000;

function loadCustomTemplates(): PromptTemplate[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const list = (parsed as { templates?: unknown }).templates;
    if (!Array.isArray(list)) return [];
    return list
      .filter((t): t is PromptTemplate => {
        if (!t || typeof t !== "object") return false;
        const c = t as Partial<PromptTemplate>;
        return (
          typeof c.id === "string" && c.id.startsWith("custom-") &&
          typeof c.label === "string" && c.label.trim() !== "" &&
          typeof c.message === "string" && c.message.trim() !== ""
        );
      })
      .slice(0, CUSTOM_TEMPLATES_CAP)
      .map((t) => ({
        id: t.id.slice(0, 48),
        label: t.label.slice(0, CUSTOM_LABEL_CAP),
        hint: typeof t.hint === "string" && t.hint ? t.hint.slice(0, 60) : "自定义模板",
        message: t.message.slice(0, CUSTOM_MESSAGE_CAP),
        ...(typeof t.system === "string" && t.system ? { system: t.system.slice(0, 2000) } : {}),
      }));
  } catch {
    return [];
  }
}

function persistCustomTemplates(list: PromptTemplate[]): boolean {
  try {
    window.localStorage.setItem(
      CUSTOM_TEMPLATES_KEY,
      JSON.stringify({ v: 1, templates: list.slice(0, CUSTOM_TEMPLATES_CAP) })
    );
    return true;
  } catch {
    return false;
  }
}

// ---- v4.9.13-local-r4：本地草稿持久化（localStorage）----
// 刷新/误关页后会话与调试参数不丢：防抖写 localStorage，挂载时恢复。
// 安全口径与分享链接一致：API 密钥绝不入草稿；恢复时逐字段校验防注入非法状态；
// 写失败静默（隐私模式/配额满 —— 草稿是锦上添花，不干扰主流程）。
const DRAFT_STORAGE_KEY = "uag-playground-draft-v1";
const DRAFT_SAVE_DEBOUNCE_MS = 600;

/** 草稿负载（字段语义与 SharePayload 对齐，但 history 保留完整 meta 以延续逐轮徽标与 cURL 复现） */
interface PlaygroundDraft {
  v: 1;
  p: Protocol;
  m: string;
  s: string;
  t: number;
  mt: number;
  tp: number;
  st: string;
  fl: boolean;
  h: ChatTurn[];
  q: string;
}

/** 读取并校验草稿（任意字段非法 → 整体放弃，宁可丢弃草稿不注入怪状态） */
function loadPlaygroundDraft(): PlaygroundDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    return parseDraftPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * v4.9.13-local-r5：草稿负载纯校验 —— localStorage 读与文件导入共用同一套规则（单一实现防口径漂移）。
 * 入参 unknown（JSON.parse 结果或用户上传文件内容），逐字段校验+收敛，非法返回 null。
 */
function parseDraftPayload(input: unknown): PlaygroundDraft | null {
  try {
    const d = input as Partial<PlaygroundDraft> | null;
    if (!d || typeof d !== "object" || d.v !== 1 || (d.p !== "openai" && d.p !== "anthropic")) return null;
    const clamp = (v: unknown, lo: number, hi: number, dflt: number) =>
      typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
    const hist: ChatTurn[] = Array.isArray(d.h)
      ? (d.h as unknown[])
          .filter((t): t is ChatTurn => {
            if (!t || typeof t !== "object") return false;
            const tt = t as ChatTurn;
            return (tt.role === "user" || tt.role === "assistant") && typeof tt.content === "string";
          })
          .slice(-MAX_HISTORY)
      : [];
    return {
      v: 1,
      p: d.p,
      m: typeof d.m === "string" ? d.m.slice(0, 200) : "",
      s: typeof d.s === "string" ? d.s.slice(0, 4000) : "",
      t: clamp(d.t, 0, 2, 0.7),
      mt: Math.floor(clamp(d.mt, 1, MAX_TOKENS_CAP, 1024)),
      tp: clamp(d.tp, 0.05, 1, 1),
      st: typeof d.st === "string" ? d.st.slice(0, 200) : "",
      fl: typeof d.fl === "boolean" ? d.fl : false,
      h: hist,
      q: typeof d.q === "string" ? d.q.slice(0, 8000) : "",
    };
  } catch {
    return null;
  }
}

/** v4.9.12-local-r5：解析 stop 序列输入（每行/逗号分隔 → 去重去空，上限 4） */
function parseStopSequences(text: string): string[] {
  const raw = text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(raw)).slice(0, 4);
}

// v4.9.12-local-r6：参数预设档位（temperature + top_p 联动一键切换；stop/max_tokens 不受影响）
type SamplingPreset = "precise" | "balanced" | "creative" | "custom";
const SAMPLING_PRESETS: Array<{ id: Exclude<SamplingPreset, "custom">; label: string; temperature: number; topP: number; desc: string }> = [
  { id: "precise", label: "精确", temperature: 0, topP: 1, desc: "确定性最高，适合抽取/分类/代码" },
  { id: "balanced", label: "平衡", temperature: 0.7, topP: 1, desc: "默认档，通用对话" },
  // v4.9.12-local-r10：creative 1.2 → 1.0 —— E2E 实测 GLM 上游限制 temperature ∈ [0,1]（>1 报 400
  // 「temperature参数非法」），预设必须对当前上游可用；多样性由 top_p 0.95 补充
  { id: "creative", label: "创意", temperature: 1, topP: 0.95, desc: "多样性高，适合写作/头脑风暴" },
];
function detectPreset(temperature: number, topP: number): SamplingPreset {
  for (const p of SAMPLING_PRESETS) {
    if (p.temperature === temperature && p.topP === topP) return p.id;
  }
  return "custom";
}

/**
 * v4.9.13-local-r3：QuickTestPanel 对外命令句柄（React 19 ref-as-prop）。
 * KeysModule 密钥行「在 Playground 中测试」按钮经此触发：
 * 滚动面板入视口 → 按 id 走 reveal 通道换取明文填入 → 既有 debounce effect 自动拉 /v1/models。
 */
export interface QuickTestPanelHandle {
  /** 载入密钥并滚动面板入视口；返回是否成功（停用/加载中/网络失败 → false） */
  loadKey: (k: PlaygroundKeyOption) => Promise<boolean>;
}

export function QuickTestPanel({ keys, ref }: { keys?: PlaygroundKeyOption[]; ref?: React.Ref<QuickTestPanelHandle> }) {
  const [apiKey, setApiKey] = React.useState("");
  // v4.9.13-local-r3：外部入口高亮 —— 从密钥行按钮载入成功后面板短暂 ring 提示落点
  const [flash, setFlash] = React.useState(false);
  const rootRef = React.useRef<HTMLElement>(null);
  // v4.9.13-local-r2：密钥一键载入（Popover 开合 / 载入中 / 已载入密钥名 / 失败提示）
  const [keyPickerOpen, setKeyPickerOpen] = React.useState(false);
  const [keyLoadingId, setKeyLoadingId] = React.useState<string | null>(null);
  const [loadedKeyName, setLoadedKeyName] = React.useState<string | null>(null);
  const [keyLoadError, setKeyLoadError] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<ModelEntry[]>([]);
  const [modelsState, setModelsState] = React.useState<"idle" | "loading" | "ready" | "empty">("idle");
  const [selectedModel, setSelectedModel] = React.useState("");
  // v4.9.12-local-r9：手动刷新模型列表（递增触发加载 effect 重跑）
  const [modelsNonce, setModelsNonce] = React.useState(0);
  // v4.9.12-local-r7：分享链接（复制反馈 + 恢复提示条）；r9：分享前预览对话框
  const [shareCopied, setShareCopied] = React.useState(false);
  const [restoredNotice, setRestoredNotice] = React.useState<string | null>(null);
  // v4.9.13-local-r6：草稿自动保存指示器（文档编辑器语言：unsaved/saved/unavailable）。
  // dirty=防抖窗口内未写入；saved=已写入 localStorage（带时间戳）；blocked=写失败（隐私模式/配额满）。
  const [draftSaveState, setDraftSaveState] = React.useState<"dirty" | "saved" | "blocked">("dirty");
  const [draftSavedAt, setDraftSavedAt] = React.useState<number | null>(null);
  // v4.9.13-local-r9：分享预览对话框（url = null 表示超长拒绝生成）
  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareUrl, setShareUrl] = React.useState<string | null>(null);
  // v4.9.13-local-r8：草稿菜单「复制分享链接」快捷项的反馈态（触发按钮短暂变 ✓ 已复制链接）
  const [draftLinkCopied, setDraftLinkCopied] = React.useState(false);
  const [protocol, setProtocol] = React.useState<Protocol>("openai");
  const [systemPrompt, setSystemPrompt] = React.useState("");
  const [temperature, setTemperature] = React.useState(0.7);
  const [maxTokens, setMaxTokens] = React.useState(1024);
  // v4.9.11-sandbox-r10：max_tokens 输入越界被钳制时的行内提醒（3s 自动消退，aria-live 播报）
  const [mtClampNotice, setMtClampNotice] = React.useState(false);
  const mtClampTimer = React.useRef<number | null>(null);
  /** 输入处理：越界即时钳制到上游真实上限 [1, 98304]，并触发一次性行内提醒 */
  const handleMaxTokensChange = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
      setMaxTokens(1);
      setMtClampNotice(false);
      return;
    }
    if (n > MAX_TOKENS_CAP) {
      setMaxTokens(MAX_TOKENS_CAP);
      setMtClampNotice(true);
      if (mtClampTimer.current !== null) window.clearTimeout(mtClampTimer.current);
      mtClampTimer.current = window.setTimeout(() => setMtClampNotice(false), 3000);
      return;
    }
    setMtClampNotice(false);
    setMaxTokens(Math.floor(n));
  };
  React.useEffect(() => () => { if (mtClampTimer.current !== null) window.clearTimeout(mtClampTimer.current); }, []);
  // v4.9.11-sandbox-r10：快捷模板 —— 最近使用的模板高亮 + system prompt 是否被覆盖的反馈
  const [activeTemplateId, setActiveTemplateId] = React.useState<string | null>(null);
  const applyTemplate = (t: PromptTemplate) => {
    setMessage(t.message);
    if (t.system) setSystemPrompt(t.system);
    setActiveTemplateId(t.id);
  };

  // v4.9.12-local-r11：自定义模板（localStorage 持久化，挂载时恢复）
  const [customTemplates, setCustomTemplates] = React.useState<PromptTemplate[]>([]);
  const [tplDialogOpen, setTplDialogOpen] = React.useState(false);
  const [tplManageOpen, setTplManageOpen] = React.useState(false);
  const [tplLabel, setTplLabel] = React.useState("");
  const [tplMessage, setTplMessage] = React.useState("");
  const [tplUseSystem, setTplUseSystem] = React.useState(false);
  const [tplError, setTplError] = React.useState("");
  const [tplSavedFlash, setTplSavedFlash] = React.useState(false);
  React.useEffect(() => {
    setCustomTemplates(loadCustomTemplates());
  }, []);
  React.useEffect(() => {
    if (!tplSavedFlash) return;
    const t = setTimeout(() => setTplSavedFlash(false), 2500);
    return () => clearTimeout(t);
  }, [tplSavedFlash]);

  const openSaveTemplate = () => {
    setTplLabel("");
    setTplMessage(message);
    setTplUseSystem(systemPrompt.trim() !== "");
    setTplError("");
    setTplDialogOpen(true);
  };

  const confirmSaveTemplate = () => {
    const label = tplLabel.trim();
    const msg = tplMessage; // 消息保留原始换行，仅校验非空
    if (!label) {
      setTplError("请填写模板名称");
      return;
    }
    if (!msg.trim()) {
      setTplError("消息内容不能为空");
      return;
    }
    const tpl: PromptTemplate = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label: label.slice(0, CUSTOM_LABEL_CAP),
      hint: tplUseSystem ? "含 System Prompt · 自定义" : "自定义模板",
      message: msg.slice(0, CUSTOM_MESSAGE_CAP),
      ...(tplUseSystem && systemPrompt.trim() ? { system: systemPrompt.slice(0, 2000) } : {}),
    };
    const next = [tpl, ...customTemplates].slice(0, CUSTOM_TEMPLATES_CAP);
    if (!persistCustomTemplates(next)) {
      setTplError("保存失败：浏览器本地存储不可用（隐私模式或配额已满）");
      return;
    }
    setCustomTemplates(next);
    setTplDialogOpen(false);
    setActiveTemplateId(tpl.id);
    setTplSavedFlash(true);
  };

  const deleteCustomTemplate = (id: string) => {
    const next = customTemplates.filter((t) => t.id !== id);
    setCustomTemplates(next);
    persistCustomTemplates(next); // 尽力而为：state 已删，持久化失败则刷新后回来（可接受）
    if (activeTemplateId === id) setActiveTemplateId(null);
  };
  // v4.9.12-local-r5：top_p（1 = 不传给上游）与 stop 序列（每行一个，最多 4 个）
  const [topP, setTopP] = React.useState(1);
  const [stopText, setStopText] = React.useState("");
  const [history, setHistory] = React.useState<ChatTurn[]>([]);
  const [message, setMessage] = React.useState("你好");
  const [stream, setStream] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [streamingText, setStreamingText] = React.useState("");
  const [errorMsg, setErrorMsg] = React.useState("");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [showCurl, setShowCurl] = React.useState(false);
  const [sessionUsage, setSessionUsage] = React.useState<SessionUsage>({ requests: 0, inputTokens: 0, outputTokens: 0 });
  const abortRef = React.useRef<AbortController | null>(null);
  const chatScrollRef = React.useRef<HTMLDivElement>(null);

  // v4.9.13-local-r2：从密钥列表一键载入 —— 按 id 走 reveal 通道换明文（与列表页「显示完整密钥」
  // 同一端点、同一粒度），填入后既有 debounce effect 自动拉 /v1/models；失败仅提示不阻断。
  // v4.9.13-local-r3：返回 boolean（外部行按钮需要知道成败以收敛 spinner）。
  const pickKey = async (k: PlaygroundKeyOption): Promise<boolean> => {
    if (!k.enabled || keyLoadingId) return false;
    setKeyLoadingId(k.id);
    setKeyLoadError(null);
    try {
      const r = await apiGet<{ keyValue: string }>(`/api/console/keys?reveal=${encodeURIComponent(k.id)}`, { quiet: true });
      if (!r?.keyValue) throw new Error("empty");
      setApiKey(r.keyValue);
      setLoadedKeyName(k.name);
      setKeyPickerOpen(false);
      return true;
    } catch {
      setKeyLoadError(`密钥「${k.name}」载入失败，请手动粘贴完整密钥或稍后重试`);
      return false;
    } finally {
      setKeyLoadingId(null);
    }
  };

  // v4.9.13-local-r3：对外命令句柄 —— 密钥行「在 Playground 中测试」入口：
  // 平滑滚动面板入视口（scroll-mt 抵消吸顶头部遮挡）→ 载入密钥 → 成功后 ring 高亮 1.8s 提示落点。
  React.useImperativeHandle(ref, () => ({
    loadKey: async (k) => {
      if (!k.enabled) return false;
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const success = await pickKey(k);
      if (success) {
        setFlash(true);
        setTimeout(() => setFlash(false), 1800);
      }
      return success;
    },
  }));

  // 当用户输入密钥后，用该密钥拉取 /v1/models 获取可用模型列表
  // 这样模型列表与实际测试的密钥权限一致（虚拟密钥可能有模型白名单限制）
  React.useEffect(() => {
    const key = apiKey.trim();
    if (!key) {
      setModels([]);
      setSelectedModel("");
      setModelsState("idle");
      return;
    }
    let cancelled = false;
    setModelsState("loading");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/v1/models", {
          headers: { "Authorization": `Bearer ${key}` },
        });
        if (!res.ok) {
          if (!cancelled) setModelsState("empty");
          return;
        }
        const d = await res.json();
        if (cancelled) return;
        // r7：解析网关透传的上游元数据（description / context_window / capabilities，均可选）
        // r8：解析 gateway_routed 可路由标记，已路由分组前置（稳定排序保持原相对顺序）
        const list: ModelEntry[] = (d.data ?? [])
          .map((m: { id?: string; description?: unknown; context_window?: unknown; capabilities?: unknown; gateway_routed?: unknown }) =>
            m?.id
              ? {
                  id: m.id,
                  ...(typeof m.description === "string" && m.description.trim()
                    ? { description: m.description.trim() }
                    : {}),
                  ...(typeof m.context_window === "number" && m.context_window > 0
                    ? { contextWindow: m.context_window }
                    : {}),
                  ...(m.capabilities && typeof m.capabilities === "object" && !Array.isArray(m.capabilities)
                    ? { capabilities: m.capabilities as ModelEntry["capabilities"] }
                    : {}),
                  ...(m.gateway_routed === true ? { routed: true } : m.gateway_routed === false ? { routed: false } : {}),
                }
              : null,
          )
          .filter((x: ModelEntry | null): x is ModelEntry => x !== null);
        list.sort((a, b) => Number(b.routed === true) - Number(a.routed === true));
        setModels(list);
        setModelsState(list.length > 0 ? "ready" : "empty");
        if (list.length > 0) setSelectedModel((prev) => prev || list[0].id);
      } catch {
        // 静默：密钥无效或网络错误时模型列表为空，用户可手动输入模型名
        if (!cancelled) setModelsState("empty");
      }
    }, 500); // 500ms debounce 避免每次按键都发请求
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiKey, modelsNonce]);

  // v4.9.12-local-r9：手动刷新模型列表 —— 先尽力清除网关侧目录元数据缓存（管理员会话），
  // 再重拉 /v1/models。新增提供商/候选或上游目录变化后，描述/上下文标注立即可见。
  const reloadModels = async () => {
    try {
      await apiPost("/api/console/models/catalog", undefined, { quiet: true });
    } catch {
      // 忽略：缓存失效失败（非管理员/网络异常）时仅跳过服务端失效，仍重拉本地列表
    }
    setModelsState("loading");
    setModelsNonce((n) => n + 1);
  };

  // v4.9.12-local-r7：分享链接恢复 —— 挂载时解析 URL ?pl=<base64url> 并还原参数与会话，
  // 随后立即用 history.replaceState 清除 pl 参数（防刷新重放 / 防误分享含状态的 URL）。
  // 密钥不参与还原（永不随链接分享），用户仍需自行粘贴。
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const pl = sp.get("pl");
    if (!pl) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("pl");
    window.history.replaceState(null, "", url.toString());
    const d = decodeShareState(pl);
    if (!d) return;
    setProtocol(d.p);
    if (typeof d.m === "string" && d.m) setSelectedModel(d.m);
    if (typeof d.s === "string") setSystemPrompt(d.s.slice(0, 4000));
    if (typeof d.t === "number" && d.t >= 0 && d.t <= 2) setTemperature(Math.round(d.t * 10) / 10);
    if (typeof d.mt === "number" && d.mt >= 1 && d.mt <= MAX_TOKENS_CAP) setMaxTokens(Math.floor(d.mt));
    if (typeof d.tp === "number" && d.tp >= 0.05 && d.tp <= 1) setTopP(d.tp);
    if (Array.isArray(d.st)) {
      const st = d.st.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 4);
      if (st.length > 0) setStopText(st.join("\n"));
    }
    if (typeof d.fl === "boolean") setStream(d.fl);
    let turns = 0;
    if (Array.isArray(d.h)) {
      const hist: ChatTurn[] = [];
      for (const t of d.h.slice(-MAX_HISTORY)) {
        if (!t || typeof t !== "object") continue;
        if ((t.r !== "u" && t.r !== "a") || typeof t.c !== "string") continue;
        hist.push({ role: t.r === "u" ? "user" : "assistant", content: t.c.slice(0, 8000) });
      }
      if (hist.length > 0) {
        setHistory(hist);
        turns = hist.length;
      }
    }
    if (typeof d.q === "string") setMessage(d.q.slice(0, 8000));
    setRestoredNotice(
      `已从分享链接恢复${turns > 0 ? ` ${turns} 轮会话与` : " "}调试参数（API 密钥不随链接分享，请自行粘贴后继续调试）`,
    );
  }, []);

  // v4.9.13-local-r4：本地草稿恢复 —— 挂载时读取 localStorage（URL 分享链接优先：
  // 有 ?pl= 参数时跳过，避免与分享恢复叠加覆盖）。恢复后按 meta 重建会话累计用量徽标。
  // 密钥不随草稿保存（安全口径与分享链接一致），恢复后需重新载入/粘贴。
  // v4.9.13-local-r5：恢复/导入共用 applyDraft（单一实现），导入入口在「草稿」菜单。
  const applyDraft = (d: PlaygroundDraft) => {
    setProtocol(d.p);
    if (d.m) setSelectedModel(d.m);
    setSystemPrompt(d.s);
    setTemperature(d.t);
    setMaxTokens(d.mt);
    setTopP(d.tp);
    if (d.st) setStopText(d.st);
    setStream(d.fl);
    if (d.h.length > 0) {
      setHistory(d.h);
      // 按 assistant 轮次 meta 重建会话累计用量（无 meta 的轮次不计，与实时累计口径一致）
      const usage = d.h.reduce(
        (acc, t) => {
          if (t.role === "assistant" && t.meta) {
            acc.requests += 1;
            acc.inputTokens += t.meta.inTok ?? 0;
            acc.outputTokens += t.meta.outTok ?? 0;
          }
          return acc;
        },
        { requests: 0, inputTokens: 0, outputTokens: 0 },
      );
      setSessionUsage(usage);
    }
    setMessage(d.q);
  };
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("pl")) return; // 分享链接恢复优先，该分支由上面的 effect 处理
    const d = loadPlaygroundDraft();
    if (!d) return;
    applyDraft(d);
    setRestoredNotice(
      `已恢复上次会话草稿（${d.h.length} 轮 · 存于浏览器本地；API 密钥不随草稿保存，请重新载入）`,
    );
  }, []);

  // v4.9.13-local-r4：草稿防抖持久化 —— 会话/参数/输入框任一变更后 600ms 写 localStorage。
  // 恢复 effect 先于写生效（挂载同步读、写有防抖），刷新往返无竞态；「清空」语义仅清会话，
  // 参数草稿保留（与按钮 title「清空会话历史与累计用量」一致）。
  // v4.9.13-local-r6：写入成功/失败同步到指示器状态（dirty → saved/blocked，与导出/导入共用同源写入内容）。
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setDraftSaveState("dirty");
    const timer = setTimeout(() => {
      try {
        const draft: PlaygroundDraft = {
          v: 1,
          p: protocol,
          m: selectedModel,
          s: systemPrompt.slice(0, 4000),
          t: temperature,
          mt: maxTokens,
          tp: topP,
          st: stopText.slice(0, 200),
          fl: stream,
          h: history.slice(-MAX_HISTORY),
          q: message.slice(0, 8000),
        };
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
        setDraftSaveState("saved");
        setDraftSavedAt(Date.now());
      } catch {
        // 静默：隐私模式/配额满 —— 草稿仅是锦上添花，不干扰主流程（指示器转 blocked 态如实告知）
        setDraftSaveState("blocked");
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [history, protocol, systemPrompt, temperature, maxTokens, topP, stopText, stream, selectedModel, message]);

  // v4.9.13-local-r6：指示器仅在有可保存内容时渲染（空会话+空输入+无系统提示词时隐藏，避免无意义噪音）
  const hasDraftContent =
    history.length > 0 || message.trim().length > 0 || systemPrompt.trim().length > 0 || stopText.trim().length > 0;

  // v4.9.12-local-r7：选中模型的上游画像元数据（无元数据目录时为 undefined，信息条不渲染）
  const selectedEntry = models.find((m) => m.id === selectedModel);

  // v4.9.12-local-r8：路由分组（routed !== false 进主组，向后兼容旧网关无标记字段）
  const routedGroup = models.filter((m) => m.routed !== false);
  const unroutedGroup = models.filter((m) => m.routed === false);
  const routedCount = models.filter((m) => m.routed === true).length;

  // 聊天区自动滚动到底部（新消息 / 流式增量时）
  React.useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, streamingText]);

  /** 组装协议请求体（不含 stream 字段） */
  const buildPayload = (withNewMessage: string, streamFlag: boolean) => {
    const hist = history.slice(-MAX_HISTORY);
    const stopList = parseStopSequences(stopText);
    if (protocol === "openai") {
      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt.trim()) messages.push({ role: "system", content: systemPrompt.trim() });
      for (const t of hist) messages.push({ role: t.role, content: t.content });
      messages.push({ role: "user", content: withNewMessage });
      return {
        endpoint: "/v1/chat/completions",
        body: {
          model: selectedModel,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(topP !== 1 ? { top_p: topP } : {}),
          ...(stopList.length > 0 ? { stop: stopList } : {}),
          stream: streamFlag,
        },
      };
    }
    // Anthropic 协议：system 独立参数；相邻同角色消息合并（Anthropic 标准要求 user/assistant 交替）
    const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const t of [...hist, { role: "user" as const, content: withNewMessage }]) {
      const last = merged[merged.length - 1];
      if (last && last.role === t.role) last.content += "\n\n" + t.content;
      else merged.push({ role: t.role, content: t.content });
    }
    const body: Record<string, unknown> = {
      model: selectedModel,
      max_tokens: maxTokens,
      messages: merged,
      stream: streamFlag,
      ...(topP !== 1 ? { top_p: topP } : {}),
      ...(stopList.length > 0 ? { stop_sequences: stopList } : {}),
    };
    if (systemPrompt.trim()) body.system = systemPrompt.trim();
    if (temperature !== 1) body.temperature = temperature;
    return { endpoint: "/v1/messages", body };
  };

  /** 从 OpenAI / Anthropic 响应 JSON 提取（回复文本, 输入 tokens, 输出 tokens, stop 截断检测） */
  const parseNonStreamBody = (raw: string): [string, number | null, number | null, string | null] => {
    try {
      const d = JSON.parse(raw) as Record<string, unknown>;
      const stopList = parseStopSequences(stopText);
      if (protocol === "openai") {
        const choices = d.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined;
        const usage = d.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        const content = choices?.[0]?.message?.content ?? "";
        return [
          content,
          usage?.prompt_tokens ?? null,
          usage?.completion_tokens ?? null,
          detectStopHit(choices?.[0]?.finish_reason ?? null, content, stopList),
        ];
      }
      const content = d.content as Array<{ type?: string; text?: string }> | undefined;
      const usage = d.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const text = (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const stopReason = typeof d.stop_reason === "string" ? d.stop_reason : null;
      // 真 Anthropic 上游会显式回传 stop_sequence 字段；网关转译链路则回退内容启发式
      const stopHit =
        stopReason === "stop_sequence"
          ? typeof d.stop_sequence === "string" && d.stop_sequence
            ? d.stop_sequence
            : ""
          : detectStopHit(stopReason, text, stopList);
      return [text, usage?.input_tokens ?? null, usage?.output_tokens ?? null, stopHit];
    } catch {
      return ["", null, null, null];
    }
  };

  /** 会话累计用量 +1 轮 */
  const accumulateUsage = (inTok: number | null, outTok: number | null) => {
    setSessionUsage((u) => ({
      requests: u.requests + 1,
      inputTokens: u.inputTokens + (inTok ?? 0),
      outputTokens: u.outputTokens + (outTok ?? 0),
    }));
  };

  /** OpenAI 协议流式：SSE data: 帧 → choices[0].delta.content；usage 帧捕获；终点帧 finish_reason 供 stop 截断检测 */
  const sendStreamOpenAI = async (payload: { endpoint: string; body: Record<string, unknown> }, start: number) => {
    const res = await fetch(payload.endpoint, { ...commonFetchInit(payload.body), signal: abortRef.current?.signal });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(text || `HTTP ${res.status}`), { httpStatus: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    let inTok: number | null = null;
    let outTok: number | null = null;
    let finishReason: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const p = trimmed.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const chunk = JSON.parse(p) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            acc += delta.content;
            setStreamingText(acc);
          }
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (chunk.usage) {
            inTok = chunk.usage.prompt_tokens ?? inTok;
            outTok = chunk.usage.completion_tokens ?? outTok;
          }
        } catch {
          // 非 JSON 负载（keepalive 注释帧等）忽略
        }
      }
    }
    const stopHit = detectStopHit(finishReason, acc, parseStopSequences(stopText));
    return { text: acc, durationMs: Date.now() - start, inTok, outTok, httpStatus: res.status, stopHit };
  };

  /** Anthropic 协议流式：message_start（输入 tokens）→ content_block_delta（增量文本）→ message_delta（输出 tokens + stop_reason）→ message_stop */
  const sendStreamAnthropic = async (payload: { endpoint: string; body: Record<string, unknown> }, start: number) => {
    const res = await fetch(payload.endpoint, { ...commonFetchInit(payload.body), signal: abortRef.current?.signal });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(text || `HTTP ${res.status}`), { httpStatus: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    let inTok: number | null = null;
    let outTok: number | null = null;
    let stopReason: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(trimmed.slice(5).trim()) as {
            type?: string;
            delta?: { text?: string; stop_reason?: string | null };
            message?: { usage?: { input_tokens?: number } };
            usage?: { output_tokens?: number };
          };
          if (ev.type === "message_start") inTok = ev.message?.usage?.input_tokens ?? inTok;
          else if (ev.type === "content_block_delta" && ev.delta?.text) {
            acc += ev.delta.text;
            setStreamingText(acc);
          } else if (ev.type === "message_delta") {
            if (ev.usage?.output_tokens != null) outTok = ev.usage.output_tokens;
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          }
        } catch {
          // 非 JSON 负载忽略
        }
      }
    }
    const stopHit = detectStopHit(stopReason, acc, parseStopSequences(stopText));
    return { text: acc, durationMs: Date.now() - start, inTok, outTok, httpStatus: res.status, stopHit };
  };

  const commonFetchInit = (body: Record<string, unknown>): RequestInit => ({
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const sendTest = async () => {
    if (loading) return;
    if (!apiKey.trim()) {
      setErrorMsg("请输入 API 密钥");
      return;
    }
    if (!selectedModel) {
      setErrorMsg(modelsState === "idle" ? "请先输入 API 密钥以加载模型列表" : "请选择模型");
      return;
    }
    if (!message.trim()) {
      setErrorMsg("请输入消息内容");
      return;
    }

    setErrorMsg("");
    const userMsg = message;
    setMessage("");
    const start = Date.now();
    setLoading(true);
    setStreamingText("");

    // v4.9.12-local-r10：快照本轮请求实际使用的参数与上下文（逐轮 cURL 复现）。
    // priorTurns 与 buildPayload 同源：history（尚未入列本轮 user 消息的闭包状态）slice(-MAX_HISTORY)。
    const turnSnapshot: TurnRequestSnapshot = {
      system: systemPrompt.trim(),
      temperature,
      maxTokens,
      topP,
      stopSeqs: parseStopSequences(stopText),
      stream,
      priorTurns: history.slice(-MAX_HISTORY).map((t) => ({ role: t.role, content: t.content })),
      userMessage: userMsg,
    };

    // 先把本轮 user 消息入列（流式完成/失败后都保留，保持会话上下文真实）
    setHistory((h) => [...h, { role: "user", content: userMsg }]);

    const payload = buildPayload(userMsg, stream);
    const finishTurn = (
      text: string,
      durationMs: number,
      inTok: number | null,
      outTok: number | null,
      opts?: { aborted?: boolean; stopHit?: string | null }
    ) => {
      setHistory((h) => [
        ...h,
        {
          role: "assistant",
          // r8：stop 命中且无正文时，空响应文案改为更准确的「stop 截断」
          content: text || (opts?.aborted ? "（已中断）" : opts?.stopHit != null ? "（stop 截断）" : "（空响应）"),
          meta: { durationMs, inTok, outTok, model: selectedModel, protocol, stopHit: opts?.stopHit ?? null, req: turnSnapshot },
          aborted: opts?.aborted,
        },
      ]);
      accumulateUsage(inTok, outTok);
    };

    try {
      if (stream) {
        abortRef.current = new AbortController();
        const r = protocol === "openai"
          ? await sendStreamOpenAI(payload, start)
          : await sendStreamAnthropic(payload, start);
        finishTurn(r.text, r.durationMs, r.inTok, r.outTok, { stopHit: r.stopHit });
      } else {
        const res = await fetch(payload.endpoint, { ...commonFetchInit(payload.body), signal: abortRef.current?.signal });
        const durationMs = Date.now() - start;
        const raw = await res.text();
        if (!res.ok) {
          setErrorMsg(`HTTP ${res.status}${raw ? ` · ${raw.slice(0, 300)}` : ""}`);
          return;
        }
        const [text, inTok, outTok, stopHit] = parseNonStreamBody(raw);
        finishTurn(text, durationMs, inTok, outTok, { stopHit });
      }
    } catch (e) {
      const err = e as Error & { httpStatus?: number; name?: string };
      if (err.name === "AbortError") {
        // 流式中断：保留已生成的部分内容
        const partial = streamingText;
        finishTurn(partial, Date.now() - start, null, null, { aborted: true });
      } else {
        setErrorMsg(`${err.httpStatus ? `HTTP ${err.httpStatus} · ` : ""}${err.message.slice(0, 300)}`);
      }
    } finally {
      setLoading(false);
      setStreamingText("");
      abortRef.current = null;
    }
  };

  const clearConversation = () => {
    if (loading) abortRef.current?.abort();
    setHistory([]);
    setSessionUsage({ requests: 0, inputTokens: 0, outputTokens: 0 });
    setErrorMsg("");
    setStreamingText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendTest();
    }
  };

  // cURL 示例（反映当前协议 + 高级参数）
  // v4.9.12-local-r3：
  //   - 修复转义缺陷：旧实现用模板字符串手拼 JSON，消息含引号/反斜杠会产生非法 JSON；
  //     现在构造真实对象 → JSON.stringify → POSIX 单引号转义（' → '\''），任意文本可安全粘贴
  //   - 新增「会话模式」：导出含完整多轮历史的 cURL（system + 历史轮次 + 当前输入），
  //     便于把整个调试会话一键迁移到终端 / CI 脚本复现
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const [curlMode, setCurlMode] = React.useState<"single" | "session">("single");

  /** POSIX shell 单引号安全包装：'foo'\''bar' 形式 */
  const shellSingleQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

  const buildCurlPayload = React.useCallback(
    (includeHistory: boolean) => {
      const sys = systemPrompt.trim();
      const turns: Array<{ role: string; content: string }> = [];
      if (includeHistory) {
        for (const t of history.slice(-MAX_HISTORY)) turns.push({ role: t.role, content: t.content });
      }
      turns.push({ role: "user", content: message || "你好" });
      const stopList = parseStopSequences(stopText);

      if (protocol === "openai") {
        const messages = sys ? [{ role: "system", content: sys }, ...turns] : turns;
        return {
          endpoint: "/v1/chat/completions",
          body: {
            model: selectedModel || models[0]?.id || "glm-4.6",
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(topP !== 1 ? { top_p: topP } : {}),
            ...(stopList.length > 0 ? { stop: stopList } : {}),
            stream,
          },
        };
      }
      // Anthropic：system 为顶层参数；相邻同角色消息必须合并（与真实请求组装逻辑一致）
      const merged: Array<{ role: string; content: string }> = [];
      for (const t of turns) {
        const last = merged[merged.length - 1];
        if (last && last.role === t.role) last.content += `\n\n${t.content}`;
        else merged.push({ ...t });
      }
      const body: Record<string, unknown> = {
        model: selectedModel || models[0]?.id || "glm-4.6",
        max_tokens: maxTokens,
        messages: merged,
        stream,
        ...(topP !== 1 ? { top_p: topP } : {}),
        ...(stopList.length > 0 ? { stop_sequences: stopList } : {}),
      };
      if (sys) body.system = sys;
      // v4.9.12-local-r10：与真实请求组装语义对齐（原漏带 temperature）
      if (temperature !== 1) body.temperature = temperature;
      return { endpoint: "/v1/messages", body };
    },
    [history, message, protocol, systemPrompt, selectedModel, models, temperature, maxTokens, topP, stopText, stream]
  );

  const curlCommand = React.useMemo(() => {
    const { endpoint, body } = buildCurlPayload(curlMode === "session");
    return `curl -X POST ${origin}${endpoint} \\\n  -H "Authorization: Bearer ${apiKey || "sk-uag-xxx"}" \\\n  -H "Content-Type: application/json" \\\n  -d ${shellSingleQuote(JSON.stringify(body))}`;
  }, [buildCurlPayload, curlMode, origin, apiKey]);

  // ---- v4.9.12-local-r10：逐轮 cURL 复现 ----
  // 用该轮请求当时的参数/上下文快照组装（后续调整参数不影响历史轮次的复现保真度）；
  // 协议按该轮 meta.protocol（跨协议会话中各轮各自还原）；密钥用当前输入框值（与面板整体 cURL 同语义）。
  const [copiedTurnIdx, setCopiedTurnIdx] = React.useState<number | null>(null);

  const buildTurnCurl = (t: ChatTurn): string => {
    const meta = t.meta;
    const req = meta?.req;
    if (!meta || !req) return "";
    const turns: Array<{ role: string; content: string }> = [...req.priorTurns, { role: "user", content: req.userMessage }];
    const key = apiKey || "sk-uag-xxx";
    if (meta.protocol === "openai") {
      const messages = req.system ? [{ role: "system", content: req.system }, ...turns] : turns;
      const body = {
        model: meta.model,
        messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        ...(req.topP !== 1 ? { top_p: req.topP } : {}),
        ...(req.stopSeqs.length > 0 ? { stop: req.stopSeqs } : {}),
        stream: req.stream,
      };
      return `curl -X POST ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d ${shellSingleQuote(JSON.stringify(body))}`;
    }
    // Anthropic：system 顶层参数；相邻同角色消息合并（与真实请求组装逻辑一致）
    const merged: Array<{ role: string; content: string }> = [];
    for (const m of turns) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else merged.push({ ...m });
    }
    const body: Record<string, unknown> = {
      model: meta.model,
      max_tokens: req.maxTokens,
      messages: merged,
      stream: req.stream,
      ...(req.topP !== 1 ? { top_p: req.topP } : {}),
      ...(req.stopSeqs.length > 0 ? { stop_sequences: req.stopSeqs } : {}),
    };
    if (req.system) body.system = req.system;
    if (req.temperature !== 1) body.temperature = req.temperature;
    return `curl -X POST ${origin}/v1/messages \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d ${shellSingleQuote(JSON.stringify(body))}`;
  };

  const copyTurnCurl = async (t: ChatTurn, idx: number) => {
    const cmd = buildTurnCurl(t);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = cmd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedTurnIdx(idx);
    window.setTimeout(() => setCopiedTurnIdx((cur) => (cur === idx ? null : cur)), 1600);
  };

  const hasConversation = history.length > 0 || !!streamingText;

  // v4.9.12-local-r8：模型下拉条目渲染（路由分组复用；r7 富条目 + r8 无路由芯片）
  const renderModelItem = (m: ModelEntry) => (
    <SelectRichItem key={m.id} value={m.id} className="py-2 text-xs">
      {/* r7：两行富条目 —— ItemText 仅含模型名（触发器回显），其余内容仅在下拉面板内渲染 */}
      <span className="flex min-w-0 flex-col items-start pr-5">
        <span className="flex max-w-full items-center gap-1.5">
          <SelectItemText className="font-mono">{m.id}</SelectItemText>
          {m.routed === false && (
            <span
              className="shrink-0 rounded bg-amber-50 px-1 text-[9px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200"
              title="该模型未配置路由，调用将返回 404 No route"
            >
              无路由
            </span>
          )}
          {m.capabilities?.reasoning && (
            <span className="shrink-0 rounded bg-teal-50 px-1 text-[9px] font-medium text-teal-700 ring-1 ring-teal-200 ring-inset">
              推理
            </span>
          )}
          {m.capabilities?.vision && (
            <span className="shrink-0 rounded bg-amber-50 px-1 text-[9px] font-medium text-amber-700 ring-1 ring-amber-200 ring-inset">
              视觉
            </span>
          )}
          {fmtContext(m.contextWindow) && (
            <span className="shrink-0 text-[9px] tabular-nums text-stone-400">{fmtContext(m.contextWindow)} ctx</span>
          )}
        </span>
        {m.description && (
          <span className="block max-w-[26rem] truncate font-sans text-[10px] font-normal text-stone-400" title={m.description}>
            {m.description}
          </span>
        )}
      </span>
    </SelectRichItem>
  );

  // ---- v4.9.12-local-r4：导出为 Markdown 会话记录（复制 / 下载 .md）----
  const buildMarkdown = React.useCallback(() => {
    const now = new Date();
    const lines: string[] = [];
    lines.push("# Playground 会话记录");
    lines.push("");
    lines.push(`- 导出时间：${now.toLocaleString("zh-CN", { hour12: false })}`);
    lines.push(`- 协议：${protocol === "openai" ? "OpenAI 兼容（/v1/chat/completions）" : "Anthropic 兼容（/v1/messages）"}`);
    lines.push(`- 模型：${selectedModel || "（未选择）"}`);
    const params: string[] = [`temperature ${temperature.toFixed(1)}`, `max_tokens ${maxTokens}`];
    if (topP !== 1) params.push(`top_p ${topP.toFixed(2)}`);
    const stopCount = parseStopSequences(stopText).length;
    if (stopCount > 0) params.push(`stop ×${stopCount}`);
    params.push(stream ? "流式开" : "流式关");
    lines.push(`- 参数：${params.join(" · ")}`);
    if (systemPrompt.trim()) {
      lines.push(`- System Prompt：${systemPrompt.trim().replace(/\n/g, " ⏎ ")}`);
    }
    lines.push(`- 会话用量：${sessionUsage.requests} 轮 · Σ入 ${sessionUsage.inputTokens.toLocaleString()} tok · Σ出 ${sessionUsage.outputTokens.toLocaleString()} tok`);
    lines.push("");
    lines.push("---");
    lines.push("");

    let turn = 0;
    for (const t of history) {
      if (t.role === "user") {
        turn += 1;
        lines.push(`## ${turn}. 用户`);
        lines.push("");
        lines.push(t.content);
        lines.push("");
      } else {
        lines.push(`## ${turn}. 助手${t.aborted ? "（已中断）" : ""}${t.meta?.stopHit != null ? "（stop 截断）" : ""}`);
        lines.push("");
        lines.push(t.content || (t.meta?.stopHit != null ? "（stop 截断）" : "（空响应）"));
        if (t.meta) {
          const meta: string[] = [`${t.meta.durationMs}ms`];
          if (t.meta.inTok != null) meta.push(`入 ${t.meta.inTok} tok`);
          if (t.meta.outTok != null) meta.push(`出 ${t.meta.outTok} tok`);
          if (t.meta.stopHit != null) meta.push(`stop 截断${t.meta.stopHit ? `:${t.meta.stopHit}` : ""}`);
          meta.push(t.meta.protocol, t.meta.model);
          lines.push("");
          lines.push(`> ${meta.join(" · ")}`);
        }
        lines.push("");
      }
    }
    if (history.length === 0) {
      lines.push("（会话为空）");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
    lines.push(`> 由 Universal AI Gateway 控制台 Playground 导出 · ${now.toISOString()}`);
    return lines.join("\n");
  }, [history, protocol, selectedModel, temperature, maxTokens, topP, stopText, stream, systemPrompt, sessionUsage]);

  const [mdCopied, setMdCopied] = React.useState(false);
  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
    } catch {
      // 剪贴板 API 不可用时的兜底
      const ta = document.createElement("textarea");
      ta.value = buildMarkdown();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setMdCopied(true);
    setTimeout(() => setMdCopied(false), 1600);
  };

  const downloadMarkdown = () => {
    const blob = new Blob([buildMarkdown()], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `uag-playground-session-${ts}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ---- v4.9.12-local-r7：分享链接（调试参数 + 会话 → URL；密钥永不入链）----
  // v4.9.12-local-r9：改为「先预览后复制」—— 分享按钮打开预览对话框，确认内容后一键复制
  const hasShareable = history.length > 0 || !!message.trim() || !!systemPrompt.trim();
  const buildShareUrl = (): string | null => {
    const payload: SharePayload = {
      v: 1,
      p: protocol,
      m: selectedModel,
      s: systemPrompt,
      t: temperature,
      mt: maxTokens,
      tp: topP,
      st: parseStopSequences(stopText),
      fl: stream,
      h: history.slice(-MAX_HISTORY).map((t) => ({ r: t.role === "user" ? "u" : "a", c: t.content })),
      q: message,
    };
    const enc = encodeShareState(payload);
    if (enc.length > 24000) return null; // URL 过长（约 8k 中文字符）拒绝生成，避免浏览器截断
    return `${origin}/?tab=keys&pl=${enc}`;
  };
  const openShareDialog = () => {
    setShareCopied(false);
    setShareUrl(buildShareUrl());
    setShareOpen(true);
  };

  // v4.9.13-local-r5：草稿导出 —— 与 localStorage 自动保存同源内容（会话+参数+输入框），
  // 序列化为带 schema 版本的 .json 文件下载；文件名含时间戳便于多份草稿并存。密钥绝不入草稿。
  const draftFileRef = React.useRef<HTMLInputElement>(null);
  const exportDraftFile = () => {
    const payload: PlaygroundDraft = {
      v: 1,
      p: protocol,
      m: selectedModel,
      s: systemPrompt.slice(0, 4000),
      t: temperature,
      mt: maxTokens,
      tp: topP,
      st: stopText.slice(0, 200),
      fl: stream,
      h: history.slice(-MAX_HISTORY),
      q: message.slice(0, 8000),
    };
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fname = `uag-playground-draft-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}.json`;
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      // 极端环境（blob 不可用）兜底：console 提示，不静默丢用户操作
      console.error("[Playground] 草稿导出失败：浏览器不支持 Blob 下载");
    }
  };

  // v4.9.13-local-r5：草稿导入 —— 读取文件文本 → JSON.parse → parseDraftPayload（与 localStorage
  // 恢复同一套校验规则：逐字段收敛，非法整体拒绝）→ applyDraft 应用 + 成功提示；
  // 非法文件给出可操作的错误提示（格式/字段/版本不匹配均归「不是有效草稿」）。
  const importDraftFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseDraftPayload(JSON.parse(text));
      if (!parsed) {
        setErrorMsg("导入失败：不是有效的 Playground 草稿文件（需为「草稿」菜单导出的 .json，版本/字段校验未通过）");
        return;
      }
      applyDraft(parsed);
      setErrorMsg("");
      setRestoredNotice(
        `已从草稿文件导入（${parsed.h.length} 轮 · ${file.name}；API 密钥不随草稿保存，请重新载入）`,
      );
    } catch {
      setErrorMsg("导入失败：文件不是合法 JSON，无法解析为草稿");
    }
  };
  const copyShareUrl = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // 剪贴板 API 不可用时的兜底
      const ta = document.createElement("textarea");
      ta.value = shareUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1600);
  };

  // v4.9.13-local-r8：草稿菜单「复制分享链接」快捷项 —— 与分享按钮同源负载（buildShareUrl 单一实现），
  // 但跳过预览对话框直接复制（快捷项语义）；超长拒绝 / 无可分享内容给出可操作提示；
  // 复制成功后触发按钮短暂变「已复制链接」提供可见反馈（菜单已关闭，对话框内反馈不可用）。
  const copyDraftShareLink = async () => {
    if (!hasShareable) {
      setErrorMsg("分享链接为空：当前无会话内容、系统提示词或未发送的输入，先写点什么再分享");
      return;
    }
    const url = buildShareUrl();
    if (!url) {
      setErrorMsg("分享链接生成失败：会话内容过长（约超 8k 中文字符），请先用「清空」精简会话，或改用「导出草稿（.json）」迁移");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    setErrorMsg("");
    setDraftLinkCopied(true);
    setTimeout(() => setDraftLinkCopied(false), 1600);
  };

  return (
    <section
      ref={rootRef}
      className={`space-y-4 rounded-xl border border-stone-200 bg-white p-4 scroll-mt-24 transition-[box-shadow] duration-500 lg:p-6 ${
        flash ? "ring-2 ring-teal-300 ring-offset-2" : ""
      }`}
    >
      {/* 标题行 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-stone-100 text-stone-600">
            <Terminal className="size-4.5" />
          </span>
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-900">
              Playground
              <Badge variant="outline" className="border-teal-200 bg-teal-50 px-1 py-0 text-[10px] font-medium text-teal-700">
                多轮 · 双协议
              </Badge>
            </h2>
            <p className="text-xs text-muted-foreground">选协议 → 粘贴密钥 → 多轮对话 → 观察用量与耗时</p>
          </div>
        </div>
        {/* v4.9.12-local-r4：flex-wrap 修复移动端按钮溢出（协议分段 + 4 个操作按钮在 390px 下换行） */}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {/* 协议切换（分段控件） */}
          <div role="tablist" aria-label="API 协议" className="flex rounded-lg border border-stone-200 bg-stone-50 p-0.5">
            {(["openai", "anthropic"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={protocol === p}
                onClick={() => setProtocol(p)}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                  protocol === p ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
                }`}
              >
                {p === "openai" ? "OpenAI" : "Anthropic"}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] text-stone-500 hover:text-stone-800"
            onClick={clearConversation}
            disabled={!hasConversation}
            title="清空会话历史与累计用量"
          >
            <Eraser className="size-3.5" />
            清空
          </Button>
          <Button variant="ghost" size="sm" className="text-[11px]" onClick={() => setShowCurl((v) => !v)}>
            <ChevronDown className={`size-3 transition-transform ${showCurl ? "rotate-180" : ""}`} />
            cURL
          </Button>
          {/* v4.9.12-local-r4：导出 Markdown 会话记录（复制 / 下载） */}
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] text-stone-500 hover:text-stone-800"
            onClick={() => void copyMarkdown()}
            disabled={!hasConversation}
            title="将整场会话（含每轮用量元信息）复制为 Markdown"
          >
            {mdCopied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
            {mdCopied ? "已复制" : "复制 MD"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] text-stone-500 hover:text-stone-800"
            onClick={downloadMarkdown}
            disabled={!hasConversation}
            title="下载会话记录为 .md 文件"
          >
            <FileDown className="size-3.5" />
            导出
          </Button>
          {/* v4.9.12-local-r7/r9：分享链接 —— 先预览确认内容再复制（API 密钥不随链接分享） */}
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] text-stone-500 hover:text-stone-800"
            onClick={openShareDialog}
            disabled={!hasShareable}
            title="预览并复制包含当前调试参数与会话内容的链接，他人打开即可还原（API 密钥不随链接分享）"
          >
            <Share2 className="size-3.5" />
            分享
          </Button>
          {/* v4.9.13-local-r5：草稿菜单 —— 导出 .json 文件（换设备迁移）/ 从文件导入（同一套校验规则）； */}
          {/* v4.9.13-local-r8：+「复制分享链接」快捷项 —— 草稿导出/导入/分享三入口归一（同一负载源）；密钥绝不入草稿 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={`text-[11px] ${draftLinkCopied ? "text-emerald-600" : "text-stone-500 hover:text-stone-800"}`}
                title="导出/导入会话草稿、复制分享链接（跨设备迁移；密钥不随草稿与链接）"
              >
                {draftLinkCopied ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
                {draftLinkCopied ? "已复制链接" : "草稿"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={() => void copyDraftShareLink()} disabled={!hasShareable} className="gap-2 text-[11px]">
                <Share2 className="size-3.5" aria-hidden />
                复制分享链接
              </DropdownMenuItem>
              <DropdownMenuItem onClick={exportDraftFile} className="gap-2 text-[11px]">
                <FileDown className="size-3.5" aria-hidden />
                导出草稿（.json）
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => draftFileRef.current?.click()} className="gap-2 text-[11px]">
                <FolderOpen className="size-3.5" aria-hidden />
                从文件导入草稿
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <p className="px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
                草稿含会话 / 调试参数 / 输入框内容；与浏览器自动保存同源。分享链接与导出文件同负载（链接免跳转预览直接复制）。API 密钥不随草稿/链接导出，导入后需重新载入。
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* v4.9.13-local-r6：草稿自动保存指示器（文档编辑器语言）—— */}
          {/* dirty：琥珀脉冲点 +「自动保存中…」；saved：翡翠点 +「已自动保存 HH:mm:ss」；blocked：红点 + 存储不可用 */}
          {hasDraftContent && (
            <span
              role="status"
              aria-live="polite"
              title={
                draftSaveState === "dirty"
                  ? "草稿防抖保存中（600ms 后写入浏览器 localStorage）"
                  : draftSaveState === "blocked"
                    ? "localStorage 写入失败（隐私模式/存储配额满）—— 草稿不会持久化，但当前会话不受影响"
                    : "草稿已写入浏览器 localStorage（密钥不随草稿保存）；刷新/误关页后自动恢复"
              }
              className="inline-flex items-center gap-1 tabular-nums text-[10px] text-stone-400"
            >
              <span
                className={`size-1.5 rounded-full ${
                  draftSaveState === "dirty"
                    ? "animate-pulse bg-amber-400"
                    : draftSaveState === "blocked"
                      ? "bg-red-400"
                      : "bg-emerald-500"
                }`}
                aria-hidden
              />
              {draftSaveState === "dirty"
                ? "自动保存中…"
                : draftSaveState === "blocked"
                  ? "草稿自动保存不可用"
                  : `已自动保存${draftSavedAt ? ` ${new Date(draftSavedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}`}
            </span>
          )}
          <input
            ref={draftFileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="选择草稿文件"
            onChange={(e) => {
              void importDraftFile(e.target.files?.[0] ?? null);
              e.target.value = ""; // 允许重复选同一个文件
            }}
          />
        </div>
      </div>

      {/* v4.9.12-local-r7：分享链接恢复提示 */}
      {restoredNotice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-[11px] leading-relaxed text-teal-800"
        >
          <Link2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{restoredNotice}</span>
          <button
            type="button"
            onClick={() => setRestoredNotice(null)}
            aria-label="关闭恢复提示"
            className="shrink-0 rounded p-0.5 text-teal-600 transition-colors hover:bg-teal-100 hover:text-teal-900"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {/* 密钥 + 模型 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-stone-600">API 密钥</label>
            {/* v4.9.13-local-r2：从密钥列表一键载入（明文按需换取，与列表页「显示完整密钥」同通道） */}
            {(keys?.length ?? 0) > 0 && (
              <Popover open={keyPickerOpen} onOpenChange={(v) => { setKeyPickerOpen(v); if (v) setKeyLoadError(null); }}>
                <PopoverTrigger
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-300"
                  title="从上方密钥列表选择一把填入（按需换取明文，仅本地填充）"
                >
                  <KeyRound className="size-3" />
                  从密钥列表载入
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 p-2">
                  <p className="px-1.5 pb-1.5 text-[11px] font-medium text-stone-500">选择虚拟密钥（按需换取明文，仅本地填充）</p>
                  <div className="max-h-64 overflow-y-auto">
                    {keys!.map((k) => (
                      <button
                        key={k.id}
                        type="button"
                        disabled={!k.enabled || keyLoadingId !== null}
                        onClick={() => void pickKey(k)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                          k.enabled ? "hover:bg-stone-100" : "cursor-not-allowed opacity-50"
                        } ${keyLoadingId === k.id ? "bg-stone-100" : ""}`}
                      >
                        {keyLoadingId === k.id ? (
                          <Loader2 className="size-3.5 shrink-0 animate-spin text-stone-400" />
                        ) : (
                          <KeyRound className="size-3.5 shrink-0 text-stone-400" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-stone-800">{k.name}</span>
                          <span className="block truncate font-mono text-[10px] text-stone-400">{k.keyMasked}</span>
                        </span>
                        {loadedKeyName === k.name && keyLoadingId === null ? (
                          <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">已载入</span>
                        ) : !k.enabled ? (
                          <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-[9px] text-stone-500">已停用</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  {keyLoadError && (
                    <p role="alert" className="mt-1.5 flex items-start gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] leading-relaxed text-red-700">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {keyLoadError}
                    </p>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              // 手动编辑视为脱离「已载入」状态：chip 提示同步清除（明文与密钥名的对应已不可信）
              if (loadedKeyName !== null) setLoadedKeyName(null);
            }}
            placeholder="sk-uag-...（虚拟密钥或 Master Key）"
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          {/* 已载入密钥名提示：输入框为 password 型，用户看不到里面是什么；明文仅本地 state */}
          {loadedKeyName && (
            <p className="flex items-center gap-1 text-[10px] text-emerald-700">
              <Check className="size-3 shrink-0" aria-hidden />
              已载入密钥「{loadedKeyName}」· 明文仅本地填充，不回传服务端；手动编辑即失效
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-stone-600">模型</label>
            {/* v4.9.12-local-r9：手动刷新模型列表（含网关侧目录缓存失效，尽力而为） */}
            <button
              type="button"
              onClick={() => void reloadModels()}
              disabled={!apiKey.trim() || modelsState === "loading"}
              title="重新拉取模型列表（先清除网关侧目录元数据缓存）：新增提供商/候选后点击，描述与能力标注立即可见"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {modelsState === "loading" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCcw className="size-3" />}
              刷新
            </button>
          </div>
          <Select value={selectedModel} onValueChange={setSelectedModel} disabled={modelsState !== "ready"}>
            <SelectTrigger className="text-xs">
              <SelectValue
                placeholder={
                  modelsState === "idle"
                    ? "先输入密钥加载模型"
                    : modelsState === "loading"
                      ? "加载中…"
                      : modelsState === "empty"
                        ? "无可用模型（检查密钥）"
                        : "选择模型"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {models.length === 0 ? (
                <SelectItem value="_loading" disabled>
                  {modelsState === "idle" ? "先输入密钥加载模型" : modelsState === "loading" ? "加载中…" : "无可用模型（检查密钥是否有效）"}
                </SelectItem>
              ) : (
                <>
                  {/* r8：路由分组 —— 已路由（可调用）在前，无路由（404）在琥珀分组内；Radix 要求 Label 位于 Group 内 */}
                  {routedGroup.length > 0 && (
                    <SelectGroup>
                      {routedCount > 0 && (
                        <SelectLabel className="px-2 pb-1 pt-1.5 text-[10px] font-semibold text-emerald-700">
                          已配置路由 · 可调用（{routedCount}）
                        </SelectLabel>
                      )}
                      {routedGroup.map(renderModelItem)}
                    </SelectGroup>
                  )}
                  {unroutedGroup.length > 0 && (
                    <SelectGroup>
                      <SelectSeparator className="mx-2" />
                      <SelectLabel className="px-2 pb-1 pt-1.5 text-[10px] font-semibold text-stone-400">
                        未配置路由 · 调用将 404（{unroutedGroup.length}）
                      </SelectLabel>
                      {unroutedGroup.map(renderModelItem)}
                    </SelectGroup>
                  )}
                </>
              )}
            </SelectContent>
          </Select>
          {/* r7：选中模型画像信息条（仅当上游提供了描述/上下文元数据时渲染） */}
          {selectedEntry?.description && (
            <div className="flex items-start gap-1.5 rounded-lg border border-stone-200/70 bg-stone-50/80 px-2.5 py-1.5">
              <Info className="mt-0.5 size-3 shrink-0 text-teal-600" aria-hidden />
              <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-stone-500" title={selectedEntry.description}>
                {selectedEntry.description}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                {selectedEntry.capabilities?.reasoning && (
                  <Badge variant="outline" className="border-teal-200 bg-teal-50 px-1 py-0 text-[9px] text-teal-700">推理</Badge>
                )}
                {selectedEntry.capabilities?.vision && (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 px-1 py-0 text-[9px] text-amber-700">视觉</Badge>
                )}
                {fmtContext(selectedEntry.contextWindow) && (
                  <Badge variant="outline" className="border-stone-200 bg-white px-1 py-0 text-[9px] tabular-nums text-stone-500">
                    {fmtContext(selectedEntry.contextWindow)} ctx
                  </Badge>
                )}
              </div>
            </div>
          )}
          {/* r8：选中无路由模型的琥珀警告条 —— 避免发请求后才撞 404 */}
          {selectedEntry?.routed === false && (
            <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5">
              <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-600" aria-hidden />
              <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-amber-800">
                该模型未配置路由，直接调用将返回 <span className="font-medium">404 No route</span>。请在「模型路由」页添加路由，或改选「已配置路由」分组中的模型。
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 高级参数（可折叠）：System Prompt / temperature / max_tokens */}
      <div className="rounded-lg border border-stone-200/70">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-stone-500 transition-colors hover:text-stone-800"
        >
          <Settings2 className="size-3.5" />
          高级参数
          {systemPrompt.trim() && (
            <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1 py-0 text-[9px] text-stone-500">system 已设置</Badge>
          )}
          {temperature !== 0.7 && (
            <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1 py-0 text-[9px] tabular-nums text-stone-500">temp {temperature}</Badge>
          )}
          {topP !== 1 && (
            <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1 py-0 text-[9px] tabular-nums text-stone-500">top_p {topP}</Badge>
          )}
          {parseStopSequences(stopText).length > 0 && (
            <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1 py-0 text-[9px] tabular-nums text-stone-500">stop ×{parseStopSequences(stopText).length}</Badge>
          )}
          <ChevronDown className={`ml-auto size-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
        </button>
        {showAdvanced && (
          <div className="space-y-3 border-t border-stone-200/70 px-3 py-3">
            {/* v4.9.12-local-r6：采样预设档位（temperature + top_p 一键切换；当前组合命中预设时高亮，否则为「自定义」） */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-stone-500">预设</span>
              <div role="tablist" aria-label="采样参数预设" className="flex rounded-lg border border-stone-200 bg-stone-50 p-0.5">
                {SAMPLING_PRESETS.map((p) => {
                  const active = detectPreset(temperature, topP) === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={`${p.desc}（temp ${p.temperature} · top_p ${p.topP === 1 ? "不传" : p.topP}）`}
                      onClick={() => {
                        setTemperature(p.temperature);
                        setTopP(p.topP);
                      }}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        active ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="tab"
                  aria-selected={detectPreset(temperature, topP) === "custom"}
                  disabled
                  title="当前为自定义参数组合（拖动滑杆后自动切换）"
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    detectPreset(temperature, topP) === "custom"
                      ? "bg-white text-stone-900 shadow-sm"
                      : "cursor-not-allowed text-stone-300"
                  }`}
                >
                  自定义
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-stone-600">System Prompt{protocol === "anthropic" ? "（Anthropic system 参数）" : "（system 角色）"}</label>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="可选。为整场会话设定角色 / 约束，如：你是一个简洁的技术助手，用中文回答。"
                className="min-h-[54px] text-xs"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-stone-600">Temperature</label>
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-stone-600">{temperature.toFixed(1)}</span>
                </div>
                <Slider
                  value={[temperature]}
                  min={0}
                  max={2}
                  step={0.1}
                  onValueChange={([v]) => setTemperature(v)}
                  aria-label="temperature 采样温度"
                />
                <p className="text-[10px] text-stone-400">0 最确定 · 1 默认 · 2 最随机（部分上游仅接受 ≤1，如 GLM 限 [0,1]，超限会被上游 400 拒绝）</p>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-stone-600">Max Tokens（单轮上限）</label>
                <Input
                  type="number"
                  min={1}
                  max={MAX_TOKENS_CAP}
                  value={maxTokens}
                  onChange={(e) => handleMaxTokensChange(e.target.value)}
                  className="h-8 text-xs tabular-nums"
                  aria-describedby="max-tokens-hint"
                />
                {/* v4.9.11-sandbox-r10：越界钳制行内提醒（aria-live 播报，3s 自动消退） */}
                <p aria-live="polite" className={mtClampNotice ? "text-[10px] font-medium text-amber-600" : "hidden"}>
                  已超出上游输出上限，自动钳制到 {MAX_TOKENS_CAP.toLocaleString()}
                </p>
                <p id="max-tokens-hint" className="text-[10px] text-stone-400">
                  Anthropic 协议此参数必填；沙箱上游输出上限 [1, {MAX_TOKENS_CAP.toLocaleString()}] —— 输入越界会自动钳制并提示（v4.9.11-r3 起网关侧同样兜底），API 直调也无需手改
                </p>
              </div>
            </div>
            {/* v4.9.12-local-r5：top_p 与 stop 序列（第二行参数区） */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-stone-600">Top P（核采样）</label>
                  <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-stone-600">{topP.toFixed(2)}</span>
                </div>
                <Slider
                  value={[topP]}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onValueChange={([v]) => setTopP(v)}
                  aria-label="top_p 核采样阈值"
                />
                <p className="text-[10px] text-stone-400">1 = 不传给上游（默认）· 与 Temperature 不建议同时调整</p>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-stone-600">Stop 序列（每行一个，最多 4 个）</label>
                <Textarea
                  value={stopText}
                  onChange={(e) => setStopText(e.target.value)}
                  placeholder={"例：\nEND\n###"}
                  className="min-h-[54px] font-mono text-xs"
                  rows={2}
                />
                <p className="text-[10px] text-stone-400">
                  命中即停止生成（OpenAI stop / Anthropic stop_sequences）；当前 {parseStopSequences(stopText).length}/4
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 对话区 */}
      <div
        ref={chatScrollRef}
        className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/50 p-3 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5"
        aria-live="polite"
        aria-label="Playground 对话记录"
      >
        {!hasConversation && (
          <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">
            <Terminal className="size-6 text-stone-300" />
            <p className="text-xs font-medium text-stone-400">开始你的第一轮对话</p>
            <p className="max-w-xs text-[11px] leading-relaxed text-stone-300">
              输入密钥后发送消息；开启「高级参数」可设置 System Prompt 与采样参数；协议可随时切换（会话上下文两协议通用）；模型列表已按路由可用性分组，无路由模型调用将 404。
            </p>
          </div>
        )}
        {history.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-stone-900 px-3 py-2 text-[13px] leading-relaxed text-white">
                {t.content}
              </div>
            </div>
          ) : (
            // r10：group + hover 显现逐轮操作（终端 cURL 复制）；触屏设备常显（sm: 才隐藏）
            <div key={i} className="group space-y-1">
              <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border px-3 py-2 text-[13px] leading-relaxed transition-colors ${
                t.aborted ? "border-amber-200 bg-amber-50 text-stone-700" : "border-stone-200 bg-white text-stone-800 group-hover:border-stone-300"
              }`}>
                {t.content}
              </div>
              {t.meta && (
                <div className="flex flex-wrap items-center gap-1 pl-1">
                  <Badge variant="outline" className="border-stone-200 bg-white px-1 py-0 text-[9px] tabular-nums text-stone-400">
                    {t.meta.durationMs}ms
                  </Badge>
                  {t.meta.inTok != null && (
                    <Badge variant="outline" className="border-stone-200 bg-white px-1 py-0 text-[9px] tabular-nums text-stone-400">
                      入 {t.meta.inTok} tok
                    </Badge>
                  )}
                  {t.meta.outTok != null && (
                    <Badge variant="outline" className="border-stone-200 bg-white px-1 py-0 text-[9px] tabular-nums text-stone-400">
                      出 {t.meta.outTok} tok
                    </Badge>
                  )}
                  {/* r8：stop 截断标注（琥珀） */}
                  {t.meta.stopHit != null && (
                    <Badge
                      variant="outline"
                      className="border-amber-200 bg-amber-50 px-1 py-0 text-[9px] tabular-nums text-amber-700"
                      title={t.meta.stopHit ? `生成在 stop 序列「${t.meta.stopHit}」处被截断（finish=stop / stop_sequence）` : "生成被 stop 序列提前终止（finish=stop / stop_sequence）"}
                    >
                      stop 截断{t.meta.stopHit ? `:${t.meta.stopHit}` : ""}
                    </Badge>
                  )}
                  <span className="text-[9px] text-stone-300">{t.meta.protocol} · {t.meta.model}</span>
                  {/* r10：逐轮 cURL 复现（快照该轮请求实际参数与上下文）；桌面端 hover 显现，触屏常显 */}
                  {t.meta.req && (
                    <button
                      type="button"
                      onClick={() => void copyTurnCurl(t, i)}
                      className={`ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded transition ${
                        copiedTurnIdx === i
                          ? "bg-emerald-50 text-emerald-600"
                          : "text-stone-400 hover:bg-stone-200/70 hover:text-stone-700"
                      } pointer-fine:opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                      title="复制重现该轮请求的 cURL（当时参数 + 历史上下文 · 密钥用当前输入框的值）"
                      aria-label={`复制第 ${Math.floor(i / 2) + 1} 轮请求的 cURL`}
                    >
                      {copiedTurnIdx === i ? <Check className="size-3" /> : <Terminal className="size-3" />}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        )}
        {/* 流式增量气泡 */}
        {streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[13px] leading-relaxed text-stone-800">
              {streamingText}
              <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-emerald-600 align-middle" />
            </div>
          </div>
        )}
      </div>

      {/* 输入区 + 操作栏 */}
      <div className="space-y-2">
        {/* v4.9.11-sandbox-r10：快捷 Prompt 模板库（一键填充 message + 可选 system，不自动发送）
            v4.9.12-local-r11：内置模板后追加自定义模板（虚线边框）+ 存为模板/管理入口 */}
        <div className="flex items-start gap-1.5">
          <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-stone-400" aria-hidden>
            <Sparkles className="size-3" />
            模板
          </span>
          <div className="flex flex-1 flex-wrap gap-1" role="toolbar" aria-label="快捷 Prompt 模板">
            {PROMPT_TEMPLATES.map((t) => {
              const active = activeTemplateId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  title={`${t.hint}${t.system ? " · 会同时填充 System Prompt" : ""}`}
                  aria-label={`使用模板：${t.label}（${t.hint}）`}
                  aria-pressed={active}
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    active
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                      : "border-stone-200 bg-stone-50 text-stone-600 hover:border-emerald-300 hover:bg-emerald-50/60 hover:text-emerald-700"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
            {customTemplates.map((t) => {
              const active = activeTemplateId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  title={`${t.hint}${t.system ? " · 会同时填充 System Prompt" : ""}`}
                  aria-label={`使用自定义模板：${t.label}`}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    active
                      ? "border-violet-400 bg-violet-100 text-violet-800"
                      : "border-stone-300 bg-white text-stone-500 hover:border-violet-300 hover:bg-violet-50/60 hover:text-violet-700"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={openSaveTemplate}
              title="把当前消息（可选含 System Prompt）存为自定义模板（仅保存在本浏览器）"
              aria-label="把当前消息存为自定义模板"
              className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-[10px] font-medium text-stone-400 transition-colors hover:border-emerald-300 hover:bg-emerald-50/60 hover:text-emerald-700"
            >
              <Plus className="size-2.5" aria-hidden />
              存为模板
            </button>
            {customTemplates.length > 0 && (
              <button
                type="button"
                onClick={() => setTplManageOpen(true)}
                title={`管理自定义模板（当前 ${customTemplates.length} 个，保存在本浏览器）`}
                aria-label={`管理自定义模板（共 ${customTemplates.length} 个）`}
                className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-stone-400 underline-offset-2 transition-colors hover:text-stone-600 hover:underline"
              >
                管理（{customTemplates.length}）
              </button>
            )}
          </div>
          {tplSavedFlash && (
            <span role="status" className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-emerald-600">
              <Check className="size-3" aria-hidden />
              已存为模板
            </span>
          )}
        </div>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入消息…（Enter 发送 / Shift+Enter 换行）"
          className="min-h-[60px] text-sm"
          rows={2}
          disabled={loading}
        />
        <div className="flex flex-wrap items-center gap-3">
          {loading ? (
            <Button
              size="sm"
              variant="outline"
              className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={() => abortRef.current?.abort()}
            >
              <Square className="size-3.5" />
              停止
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-stone-900 hover:bg-stone-800"
              onClick={() => void sendTest()}
              disabled={!message.trim()}
            >
              <Send className="size-4" />
              发送
            </Button>
          )}
          {loading && stream && <Loader2 className="size-3.5 animate-spin text-stone-400" />}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={stream} onCheckedChange={setStream} className="scale-75" />
            <span>流式{stream ? "（SSE 增量渲染）" : ""}</span>
          </div>
          {/* 会话累计用量 */}
          {sessionUsage.requests > 0 && (
            <div className="ml-auto flex items-center gap-1">
              <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] tabular-nums text-stone-500">
                会话 {sessionUsage.requests} 轮
              </Badge>
              <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] tabular-nums text-stone-500">
                Σ入 {sessionUsage.inputTokens.toLocaleString()}
              </Badge>
              <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] tabular-nums text-stone-500">
                Σ出 {sessionUsage.outputTokens.toLocaleString()} tok
              </Badge>
            </div>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700">
          <span className="font-medium">请求失败：</span>
          <span className="break-all">{errorMsg}</span>
        </div>
      )}

      {/* cURL 命令（可折叠；支持单条消息 / 完整会话两种导出粒度） */}
      {showCurl && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-stone-500">
                cURL 命令（{protocol === "openai" ? "/v1/chat/completions" : "/v1/messages · Anthropic 协议"}）
              </span>
              {/* 导出粒度切换：单条 = 仅当前输入；会话 = system + 全部历史轮次 + 当前输入 */}
              <div role="tablist" aria-label="cURL 导出粒度" className="flex rounded-md border border-stone-200 bg-stone-50 p-0.5">
                {([
                  { id: "single", label: "单条", title: "仅包含当前输入的消息" },
                  { id: "session", label: "含会话历史", title: "包含 System Prompt 与全部历史轮次（最多 20 条）" },
                ] as const).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={curlMode === m.id}
                    title={m.title}
                    disabled={m.id === "session" && history.length === 0}
                    onClick={() => setCurlMode(m.id)}
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      curlMode === m.id ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
                    }`}
                  >
                    {m.id === "session" && <History className="size-3" />}
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <CopyButton text={curlCommand} size="sm" variant="ghost" label="复制" />
          </div>
          <pre className="max-h-64 overflow-auto rounded-lg border border-stone-700 bg-stone-900 p-3 text-[11px] leading-relaxed text-stone-100 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-600 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5">
            <code>{curlCommand}</code>
          </pre>
          {curlMode === "session" && history.length > 0 && (
            <p className="text-[10px] text-stone-400">
              会话模式：包含 {Math.min(history.length, MAX_HISTORY)} 条历史消息（最老优先保留，上限 {MAX_HISTORY} 条）+ 当前输入。
            </p>
          )}
        </div>
      )}

      {/* 提示 */}
      <p className="text-[11px] text-muted-foreground">
        提示：多轮对话会把历史上下文一并发给模型（网关侧按轮次计费与审计）；切换协议仅改变请求端点与响应格式，路由与用量统计不受影响。
      </p>

      {/* v4.9.12-local-r9：分享链接预览对话框 —— 复制前确认将要分享的全部内容（密钥永不入链） */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Share2 className="size-4 text-teal-600" />
              分享链接预览
            </DialogTitle>
            <DialogDescription>
              以下全部内容将编码进链接，对方打开即可还原你的调试现场。API 密钥不会包含在链接中。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* 参数概览 chips */}
            <div className="flex flex-wrap gap-1">
              {[
                { label: protocol === "openai" ? "OpenAI 协议" : "Anthropic 协议" },
                { label: `模型 ${selectedModel || "（未选）"}` },
                { label: stream ? "流式" : "非流式" },
                { label: `temp ${temperature}` },
                { label: `max_tokens ${maxTokens}` },
                ...(topP !== 1 ? [{ label: `top_p ${topP}` }] : []),
                ...(parseStopSequences(stopText).length > 0 ? [{ label: `stop ×${parseStopSequences(stopText).length}` }] : []),
              ].map((chip) => (
                <span
                  key={chip.label}
                  className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[10px] text-stone-600"
                >
                  {chip.label}
                </span>
              ))}
            </div>

            {/* System Prompt 预览 */}
            {systemPrompt.trim() && (
              <div className="rounded-lg border border-stone-200 bg-stone-50/60 px-2.5 py-1.5">
                <p className="text-[10px] font-medium text-stone-400">System Prompt</p>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-stone-600" title={systemPrompt}>
                  {systemPrompt}
                </p>
              </div>
            )}

            {/* 会话轮次预览 */}
            <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50/60 p-2 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5">
              {history.length === 0 && !message.trim() && (
                <p className="px-1 py-2 text-center text-[11px] text-stone-400">暂无会话内容</p>
              )}
              {history.map((t, i) => (
                <div key={i} className="flex items-start gap-1.5 rounded-md bg-white px-2 py-1">
                  <span
                    className={`mt-px shrink-0 rounded px-1 py-px text-[9px] font-medium ${
                      t.role === "user" ? "bg-stone-800 text-white" : "bg-stone-200 text-stone-700"
                    }`}
                  >
                    {t.role === "user" ? "用户" : "助手"}
                  </span>
                  <p className="min-w-0 flex-1 break-all text-[11px] leading-relaxed text-stone-600" title={t.content}>
                    {t.content.length > 160 ? `${t.content.slice(0, 160)}…` : t.content}
                  </p>
                </div>
              ))}
              {message.trim() && (
                <div className="flex items-start gap-1.5 rounded-md border border-dashed border-stone-300 bg-white/60 px-2 py-1">
                  <span className="mt-px shrink-0 rounded bg-stone-800 px-1 py-px text-[9px] font-medium text-white">用户</span>
                  <p className="min-w-0 flex-1 break-all text-[11px] leading-relaxed text-stone-500" title={message}>
                    <span className="mr-1 text-[9px] text-amber-600">［当前输入 · 未发送］</span>
                    {message.length > 160 ? `${message.slice(0, 160)}…` : message}
                  </p>
                </div>
              )}
            </div>

            {/* URL 尺寸提示 / 超长错误 */}
            {shareUrl ? (
              <p className="text-[10px] text-stone-400">
                链接长度 {shareUrl.length.toLocaleString()} 字符
                {shareUrl.length > 20000 && <span className="ml-1 text-amber-600">（接近上限，对方浏览器可能无法完整还原，建议精简会话）</span>}
                {" · "}负载为 base64url（内容明文可解码，请勿分享敏感业务内容）
              </p>
            ) : (
              <div className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-700">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                会话过长，无法生成分享链接（请清空部分历史后重试）。
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShareOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              className="bg-stone-900 hover:bg-stone-800"
              onClick={() => void copyShareUrl()}
              disabled={!shareUrl}
            >
              {shareCopied ? <Check className="size-3.5 text-emerald-300" /> : <Link2 className="size-3.5" />}
              {shareCopied ? "已复制" : "复制链接"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- v4.9.12-local-r11：存为自定义模板 ---------- */}
      <Dialog open={tplDialogOpen} onOpenChange={(o) => !o && setTplDialogOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>存为自定义模板</DialogTitle>
            <DialogDescription>
              仅保存在本浏览器（localStorage），不上传服务器、不跨设备同步；上限 {CUSTOM_TEMPLATES_CAP} 个。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5 py-1">
            <div className="space-y-1.5">
              <label htmlFor="tpl-label" className="text-xs font-medium text-stone-700">
                模板名称 <span className="text-red-500" aria-hidden>*</span>
                <span className="ml-1 font-normal text-stone-400">（≤ {CUSTOM_LABEL_CAP} 字）</span>
              </label>
              <Input
                id="tpl-label"
                value={tplLabel}
                onChange={(e) => setTplLabel(e.target.value)}
                maxLength={CUSTOM_LABEL_CAP}
                placeholder="如：周报整理"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tpl-message" className="text-xs font-medium text-stone-700">
                消息内容 <span className="text-red-500" aria-hidden>*</span>
                <span className="ml-1 font-normal text-stone-400">（已带入当前输入框，可再编辑）</span>
              </label>
              <Textarea
                id="tpl-message"
                value={tplMessage}
                onChange={(e) => setTplMessage(e.target.value)}
                rows={4}
                maxLength={CUSTOM_MESSAGE_CAP}
                className="text-xs"
                placeholder="模板填充到输入框的消息文本"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
              <div className="min-w-0 pr-3">
                <p className="text-xs font-medium text-stone-700">包含当前 System Prompt</p>
                <p className="mt-0.5 truncate text-[11px] text-stone-400">
                  {systemPrompt.trim() ? systemPrompt.slice(0, 60) : "（当前 System Prompt 为空）"}
                </p>
              </div>
              <Switch
                checked={tplUseSystem}
                onCheckedChange={setTplUseSystem}
                disabled={systemPrompt.trim() === ""}
                aria-label="模板是否包含当前 System Prompt"
              />
            </div>
            {tplError && (
              <p role="alert" className="text-xs text-red-600">
                {tplError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTplDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={confirmSaveTemplate} className="bg-stone-900 hover:bg-stone-800">
              <Save />
              保存模板
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- v4.9.12-local-r11：管理自定义模板 ---------- */}
      <Dialog open={tplManageOpen} onOpenChange={(o) => !o && setTplManageOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>管理自定义模板（{customTemplates.length}）</DialogTitle>
            <DialogDescription>
              保存在本浏览器 localStorage，删除后不可恢复（内置模板不受影响）。
            </DialogDescription>
          </DialogHeader>
          {customTemplates.length === 0 ? (
            <p className="py-6 text-center text-xs text-stone-400">还没有自定义模板 —— 在输入框写好 prompt 后点「＋ 存为模板」。</p>
          ) : (
            <div className="max-h-72 space-y-1.5 overflow-y-auto py-1 pr-1" role="list" aria-label="自定义模板列表">
              {customTemplates.map((t) => (
                <div
                  key={t.id}
                  role="listitem"
                  className="flex items-start justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-stone-800">
                      {t.label}
                      {t.system && (
                        <span className="rounded-sm bg-violet-100 px-1 text-[9px] font-medium text-violet-700">SYS</span>
                      )}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-stone-400">{t.message}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteCustomTemplate(t.id)}
                    aria-label={`删除模板：${t.label}`}
                    title="删除该模板"
                    className="shrink-0 rounded p-1 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTplManageOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
