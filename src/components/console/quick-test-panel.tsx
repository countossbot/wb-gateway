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
  Link2,
  Loader2,
  RefreshCcw,
  Send,
  Settings2,
  Share2,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectRichItem, SelectItemText, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/console/ui";
import { apiPost } from "@/lib/console/api";

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

export function QuickTestPanel() {
  const [apiKey, setApiKey] = React.useState("");
  const [models, setModels] = React.useState<ModelEntry[]>([]);
  const [modelsState, setModelsState] = React.useState<"idle" | "loading" | "ready" | "empty">("idle");
  const [selectedModel, setSelectedModel] = React.useState("");
  // v4.9.12-local-r9：手动刷新模型列表（递增触发加载 effect 重跑）
  const [modelsNonce, setModelsNonce] = React.useState(0);
  // v4.9.12-local-r7：分享链接（复制反馈 + 恢复提示条）；r9：分享前预览对话框
  const [shareCopied, setShareCopied] = React.useState(false);
  const [restoredNotice, setRestoredNotice] = React.useState<string | null>(null);
  // v4.9.12-local-r9：分享预览对话框（url = null 表示超长拒绝生成）
  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareUrl, setShareUrl] = React.useState<string | null>(null);
  const [protocol, setProtocol] = React.useState<Protocol>("openai");
  const [systemPrompt, setSystemPrompt] = React.useState("");
  const [temperature, setTemperature] = React.useState(0.7);
  const [maxTokens, setMaxTokens] = React.useState(1024);
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
    if (typeof d.mt === "number" && d.mt >= 1 && d.mt <= 32768) setMaxTokens(Math.floor(d.mt));
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

  return (
    <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-4 lg:p-6">
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
          <label className="text-xs font-medium text-stone-600">API 密钥</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-uag-...（虚拟密钥或 Master Key）"
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
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
                  max={32768}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Math.max(1, Math.min(32768, Number(e.target.value) || 1)))}
                  className="h-8 text-xs tabular-nums"
                />
                <p className="text-[10px] text-stone-400">Anthropic 协议此参数必填</p>
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
    </section>
  );
}
