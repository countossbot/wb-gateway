// 模型路由 —— 模型名 → 有序候选链（故障转移顺序）。
// 候选列表编辑器支持 @dnd-kit 拖拽排序；顺序即数组顺序，保存时全量重写。
"use client";

import * as React from "react";
import {
  Activity,
  ArrowRight,
  Check,
  DatabaseZap,
  Gauge,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Send,
  Trash2,
  Zap,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  EmptyState,
  ErrorAlert,
  LoadingBlock,
  PageHeader,
} from "@/components/console/ui";
import { apiDelete, apiGet, apiPost, apiPut, errMessage } from "@/lib/console/api";
import type { RouteRow, RouteStat24h, RoutesData } from "@/lib/console/types";

// ---- 上游模型目录拉取（/api/console/providers/models）----
// 模块级缓存 60s：同一提供商多行候选/反复打开表单不重复打上游；强制刷新穿透。
// v4.7.2：workbuddy 两区接入真实上游拉取；v4.8.1 改为对齐桌面端 /v3/config 合并列表。
// 响应可携带 details 元数据；下拉项精简展示（仅模型名 + 倍率/免费徽章）。
interface UpstreamModelDetail {
  id: string;
  name?: string | null;
  /** 上游展示文案原样透传："x0.29" / "x0.00 credits" / null（无固定倍率） */
  credits?: string | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  isDefault?: boolean;
  tags?: string[];
}
interface ProviderModelsData {
  source: "upstream";
  models: string[];
  details?: UpstreamModelDetail[];
  /** 上游全量模型数（含 CLI 白名单外旧模型），与 models.length 不同时有参考意义 */
  allCount?: number;
  upstreamUrl?: string;
}
const MODEL_FETCH_CACHE = new Map<string, { data: ProviderModelsData; at: number }>();
const MODEL_FETCH_TTL = 60_000;

async function fetchProviderModels(
  providerId: string,
  force = false
): Promise<ProviderModelsData & { cached?: boolean }> {
  const hit = MODEL_FETCH_CACHE.get(providerId);
  if (hit && !force && Date.now() - hit.at < MODEL_FETCH_TTL) {
    return { ...hit.data, cached: true };
  }
  const d = await apiGet<ProviderModelsData>(`/api/console/providers/models?providerId=${encodeURIComponent(providerId)}${force ? "&refresh=1" : ""}`);
  MODEL_FETCH_CACHE.set(providerId, { data: d, at: Date.now() });
  return d;
}

// 倍率徽章文案："x0.00 credits" → 免费（绿色）；"x0.29" → ×0.29；null → 无
function creditsBadgeLabel(credits: string | null | undefined): { text: string; tone: "free" | "normal" } | null {
  if (!credits) return null;
  const v = credits.replace(/\s*credits$/i, "").trim();
  if (!v) return null;
  if (/^x?0(?:\.0+)?$/i.test(v.replace("x", ""))) return { text: "免费", tone: "free" };
  return { text: v.startsWith("x") ? `×${v.slice(1)}` : `×${v}`, tone: "normal" };
}

interface CandidateDraft {
  key: string;
  providerId: string;
  model: string;
  /** 模型输入模式：true = 手动输入（自定义/非原生列表模型）；false/缺省 = 原生模型 ID 下拉 */
  modelCustom?: boolean;
}

// 「手动输入」哨兵值：含冒号，不在原生模型 ID 字符集 [a-zA-Z0-9._/\[\]-] 内，不可能与真实模型 ID 冲突
const MODEL_MANUAL_SENTINEL = "custom:manual";

let draftSeq = 0;
function newDraft(providerId = "", model = ""): CandidateDraft {
  draftSeq += 1;
  return { key: `cand-${Date.now()}-${draftSeq}`, providerId, model };
}

// ---- v4.9.12-local-r4：路由 24h 统计徽标条 + 相对时间 ----

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

const statBadgeCls =
  "inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-1.5 py-0.5 text-[10px] tabular-nums text-stone-500 transition-colors hover:border-stone-300 hover:bg-stone-50";

// ---- v4.9.12-local-r10：上游模型目录缓存快照（r9 建议项 ④）----

interface CatalogCacheEntry {
  providerId: string;
  ok: boolean;
  ageSec: number;
  metaModels: number;
}

/** 缓存年龄秒 → 紧凑展示（<60s 原样 / <1h 分钟 / 小时） */
function fmtCacheAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

/** 头部缓存快照条：各 provider 一枚状态芯片（ok=emerald / 失败负缓存=amber） */
function CatalogCacheBar({ cache }: { cache: CatalogCacheEntry[] | null }) {
  if (!cache || cache.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="上游模型目录缓存快照">
      <span className="text-[10px] font-medium text-stone-400">目录缓存</span>
      {cache.map((c) => (
        <span
          key={c.providerId}
          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums transition-colors hover:border-stone-300 ${
            c.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"
          }`}
          title={`提供商 ${c.providerId} 的上游目录元数据缓存于 ${c.ageSec} 秒前（新鲜期 5 分钟）· 覆盖 ${c.metaModels} 个模型的扩展元数据（描述/上下文/能力）${
            c.ok ? "" : " · 最近一次拉取失败（负缓存 30s），Playground 加载模型列表时会自动重试"
          }`}
        >
          <span className={`size-1.5 rounded-full ${c.ok ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
          <span className="max-w-[10rem] truncate font-mono">{c.providerId}</span>
          <span className="text-current/60">·</span>
          <span>{c.metaModels} 模型</span>
          <span className="text-current/60">·</span>
          <span>{fmtCacheAge(c.ageSec)}前</span>
        </span>
      ))}
      <span className="text-[10px] text-stone-300">Playground 加载模型列表 / 5min 新鲜期后自动更新</span>
    </div>
  );
}

// v4.9.12-local-r5：候选芯片 24h 最终命中计数（×N 尾注 + title 说明；无流量不出数）
function providerHitBadge(stat: { requests: number; errors: number } | undefined): React.ReactNode {
  if (!stat || stat.requests === 0) return null;
  return (
    <span
      className={`ml-0.5 rounded bg-stone-100 px-1 text-[9px] tabular-nums not-italic ${stat.errors > 0 ? "text-amber-600" : "text-stone-400"}`}
    >
      ×{stat.requests}
    </span>
  );
}

function providerHitTitle(stat: { requests: number; errors: number; avgDurationMs: number | null } | undefined): string {
  if (!stat || stat.requests === 0) return " · 24h 无最终命中";
  const parts = [` · 24h 最终命中 ${stat.requests} 次`];
  if (stat.errors > 0) parts.push(`（含 ${stat.errors} 次失败）`);
  if (stat.avgDurationMs != null) parts.push(`均 ${stat.avgDurationMs}ms`);
  return parts.join("");
}

function RouteStatBadges({ stat }: { stat: RouteStat24h | undefined }) {
  if (!stat || stat.requests === 0) {
    return (
      <span className={"inline-flex items-center gap-1 rounded-md border border-dashed border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[10px] text-stone-400"}>
        <Activity className="size-3" />
        24h 无调用
      </span>
    );
  }
  const okCount = stat.requests - stat.errors;
  const rate = Math.round((okCount / stat.requests) * 100);
  const rateTone = rate >= 100 ? "text-emerald-600" : rate >= 50 ? "text-amber-600" : "text-red-600";
  return (
    <span className="flex flex-wrap items-center gap-1" aria-label={`近 24 小时 ${stat.requests} 次调用，成功率 ${rate}%`}>
      <span className={statBadgeCls}>
        <Activity className="size-3 text-stone-400" />
        24h {stat.requests} 次
      </span>
      <span className={`${statBadgeCls} ${rateTone}`} title={`${okCount}/${stat.requests} 成功 · ${stat.errors} 失败`}>
        <span className={`size-1.5 rounded-full ${rate >= 100 ? "bg-emerald-500" : rate >= 50 ? "bg-amber-500" : "bg-red-500"}`} />
        {rate}%
      </span>
      {stat.avgDurationMs != null && (
        <span className={statBadgeCls} title="成功请求平均耗时">
          <Gauge className="size-3 text-stone-400" />
          均 {stat.avgDurationMs >= 1000 ? `${(stat.avgDurationMs / 1000).toFixed(2)}s` : `${stat.avgDurationMs}ms`}
        </span>
      )}
      {(stat.inputTokens > 0 || stat.outputTokens > 0) && (
        <span className={statBadgeCls} title="Token 用量（输入/输出）">
          Σ {stat.inputTokens.toLocaleString()} / {stat.outputTokens.toLocaleString()} tok
        </span>
      )}
      {stat.lastCallAt && (
        <span className={statBadgeCls} title={new Date(stat.lastCallAt).toLocaleString()}>
          最近 {relativeTime(stat.lastCallAt)}
        </span>
      )}
    </span>
  );
}

function SortableCandidate({
  cand,
  index,
  providers,
  onChange,
  onRemove,
}: {
  cand: CandidateDraft;
  index: number;
  providers: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  onChange: (patch: Partial<CandidateDraft>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cand.key });

  // v4.7.2 修复：模型下拉弹层超出对话框卡片 —— Radix 默认以视口为碰撞边界，
  // 长目录（16-30 项）向上翻转时会冲出卡片顶部。改为以所在 Dialog 元素为碰撞边界
  //（collisionBoundary）+ 高度上限，弹层始终限制在卡片内并内部滚动。
  const modelTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [modelMenuBoundary, setModelMenuBoundary] = React.useState<HTMLDivElement | null>(null);

  // 当前选中的提供商（模型目录来自其上游实时拉取）
  const provider = providers.find((p) => p.id === cand.providerId);

  // 上游实时模型目录：选提供商后自动拉取（失败/超时如实提示，可手动输入；不再降级内置目录）
  const [upstream, setUpstream] = React.useState<ProviderModelsData | null>(null);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [modelsError, setModelsError] = React.useState("");
  const loadModels = React.useCallback(
    async (pid: string, force = false) => {
      if (!pid) return;
      setModelsLoading(true);
      setModelsError("");
      try {
        const d = await fetchProviderModels(pid, force);
        setUpstream({ source: d.source, models: d.models || [], details: d.details, allCount: d.allCount, upstreamUrl: d.upstreamUrl });
      } catch (e) {
        setModelsError(errMessage(e));
        setUpstream(null);
      } finally {
        setModelsLoading(false);
      }
    },
    []
  );
  React.useEffect(() => {
    setUpstream(null);
    setModelsError("");
    if (cand.providerId) void loadModels(cand.providerId);
  }, [cand.providerId, loadModels]);

  // 模型下拉数据源：仅上游实时目录（/v3/config）。失败/无数据时不展示下拉，可手动输入。
  const modelOptions = upstream?.models?.length ? upstream.models : [];
  const modelInOptions = !!cand.model && modelOptions.includes(cand.model);
  // 上游元数据（details）：模型 ID → 倍率/上下文/能力（无则朴素渲染）
  const detailMap = React.useMemo(() => {
    const m = new Map<string, UpstreamModelDetail>();
    for (const d of upstream?.details || []) m.set(d.id, d);
    return m;
  }, [upstream?.details]);
  // 下拉模式：已选提供商 + 有可用目录 + 未切手动 + （已填值时值在目录内）
  const useModelSelect =
    !!cand.providerId && modelOptions.length > 0 && !cand.modelCustom && (!cand.model || modelInOptions);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-lg border border-stone-200 bg-white p-2 shadow-xs ${isDragging ? "z-10 ring-2 ring-emerald-300" : ""}`}
    >
      <button
        type="button"
        className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-600 focus-visible:outline-none active:cursor-grabbing"
        aria-label="拖拽排序"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <span className="w-6 shrink-0 text-center text-xs tabular-nums text-stone-400">{index + 1}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
        {/* value 恒传字符串（含空串）保持受控：避免首次选择时 uncontrolled→controlled 警告 */}
        <Select value={cand.providerId} onValueChange={(v) => onChange({ providerId: v })}>
          <SelectTrigger size="sm" className="w-full sm:w-52">
            <SelectValue placeholder="选择提供商" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="font-medium">{p.name}</span>
                <code className="ml-1 text-[10px] text-stone-400">{p.id}</code>
                {!p.enabled && <Badge variant="outline" className="ml-1 text-[9px] text-stone-400">停用</Badge>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* 模型字段：选提供商后自动从上游拉取模型目录（openai/anthropic/workbuddy 两区实时；
            （失败如实提示，可手动输入），workbuddy 上游响应含元数据 → 下拉项精简展示
            （仅模型名 + 倍率/免费徽章）；手动输入始终可切（保留任意上游模型能力，模型 ID 原样透传零改写） */}
        {useModelSelect ? (
          <div className="flex w-full min-w-0 flex-1 gap-1.5">
            <Select
              value={cand.model}
              onValueChange={(v) => {
                if (v === MODEL_MANUAL_SENTINEL) {
                  onChange({ modelCustom: true });
                } else {
                  onChange({ model: v });
                }
              }}
              onOpenChange={(open) => {
                // 展开时捕获所在 Dialog 元素作为弹层碰撞边界（收起时不重置，保持引用稳定）
                if (open) setModelMenuBoundary(modelTriggerRef.current?.closest("[role=dialog]") as HTMLDivElement | null ?? null);
              }}
            >
              <SelectTrigger ref={modelTriggerRef} size="sm" className="h-8 min-w-0 flex-1 font-mono text-xs">
                <SelectValue
                  placeholder={
                    modelsLoading
                      ? "正在从上游拉取模型…"
                      : `选择模型（客户端实时 · ${modelOptions.length} 个）`
                  }
                />
              </SelectTrigger>
              {/* collisionBoundary=Dialog + maxHeight 上限：弹层不冲出卡片，长目录内部滚动 */}
              <SelectContent
                collisionBoundary={modelMenuBoundary ?? undefined}
                collisionPadding={8}
                style={{ maxHeight: "min(18rem, var(--radix-select-content-available-height))" }}
              >
                {upstream && (
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] text-stone-400">
                    <span className="size-1.5 rounded-full bg-teal-500" />已对齐客户端实时列表（{modelOptions.length}/{upstream.allCount}）
                  </div>
                )}
                {modelsError && !upstream && (
                  <div className="px-2 py-1.5 text-[10px] text-red-500">模型目录拉取失败——请检查该提供商账户凭证，或点右侧刷新重试</div>
                )}
                {modelOptions.map((m) => {
                  const det = detailMap.get(m);
                  const cred = creditsBadgeLabel(det?.credits);
                  return (
                    <SelectItem key={m} value={m}>
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <code className="truncate font-mono text-xs">{m}</code>
                        {cred ? (
                          <Badge
                            variant="secondary"
                            className={`h-4 shrink-0 px-1 text-[9px] ${cred.tone === "free" ? "bg-emerald-50 text-emerald-700" : "text-stone-500"}`}
                          >
                            {cred.text}
                          </Badge>
                        ) : null}
                      </span>
                    </SelectItem>
                  );
                })}
                <SelectItem value={MODEL_MANUAL_SENTINEL}>
                  <span className="text-xs text-muted-foreground">手动输入其他模型…</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 size-8 shrink-0"
              onClick={() => cand.providerId && void loadModels(cand.providerId, true)}
              disabled={modelsLoading || !cand.providerId}
              title="从上游强制刷新模型列表"
              aria-label="刷新上游模型列表"
            >
              <RefreshCw className={modelsLoading ? "size-3.5 animate-spin" : "size-3.5"} />
            </Button>
          </div>
        ) : (
          <div className="flex w-full flex-1 gap-1.5">
            <Input
              value={cand.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder={cand.providerId ? "上游模型 ID（沿用原始标识符）" : "先选择提供商"}
              className="h-8 flex-1 font-mono text-xs"
            />
            {modelOptions.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 px-2 text-xs"
                onClick={() => onChange({ modelCustom: false, model: "" })}
                title="改从模型列表选择"
              >
                列表
              </Button>
            )}
          </div>
        )}
        {modelsError && cand.providerId && !useModelSelect && (
          <p className="w-full text-[11px] text-amber-600">模型目录拉取失败（{modelsError}）——已保留手动输入</p>
        )}
      </div>
      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={onRemove} aria-label="删除此候选">
        <Trash2 className="size-3.5 text-red-500" />
      </Button>
    </div>
  );
}

// ---- v4.9.12-local-r4：路由行内快速测试对话框 ----
// 用一条最小请求（max_tokens=64）验证「路由名 → 候选链 → 上游」整条链路，
// 展示网关返回的真实上游模型（failover 后可见差异）。测试请求与普通请求一样计费/审计。
// v4.9.12-local-r8：双协议支持 —— OpenAI（/v1/chat/completions）与
// Anthropic（/v1/messages，x-api-key + anthropic-version 头）可切换，
// 响应解析双形态（content 数组拼接 / choices 取值，stop_reason ↔ finish_reason）。
type TestProtocol = "openai" | "anthropic";

interface TestResult {
  httpStatus: number;
  durationMs: number;
  /** 上游应答文本（仅 2xx） */
  text: string;
  /** 响应体中的 model 字段 = 上游上报的真实模型（可能经上游重写，如 glm-4-flash → glm-4-plus） */
  upstreamModel: string | null;
  inTok: number | null;
  outTok: number | null;
  /** OpenAI finish_reason 或 Anthropic stop_reason（展示时统一标记为 finish） */
  finishReason: string | null;
  /** 本轮使用的协议（结果徽标展示） */
  protocol: TestProtocol;
}

const ROUTE_TEST_KEY_STORAGE = "uag-route-test-key";
// v4.9.12-local-r9：协议选择会话内记忆（上轮已知观察修复 —— 原每次打开默认回 OpenAI）
const ROUTE_TEST_PROTO_STORAGE = "uag-route-test-proto";

function RouteTestDialog({
  route,
  providerName,
  open,
  onOpenChange,
}: {
  route: RouteRow;
  providerName: (id: string) => string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [apiKey, setApiKey] = React.useState("");
  const [message, setMessage] = React.useState("请回复 pong 两个字母即可");
  const [protocol, setProtocol] = React.useState<TestProtocol>(
    () => (sessionStorage.getItem(ROUTE_TEST_PROTO_STORAGE) === "anthropic" ? "anthropic" : "openai"),
  );
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [errorMsg, setErrorMsg] = React.useState("");
  const resultRef = React.useRef<HTMLDivElement>(null);

  // 协议选择持久化（sessionStorage）：下次打开对话框沿用上次协议
  React.useEffect(() => {
    sessionStorage.setItem(ROUTE_TEST_PROTO_STORAGE, protocol);
  }, [protocol]);

  // 打开时回填 sessionStorage 里的密钥（路由测试与 Playground 密钥相互独立，会话内记忆）
  React.useEffect(() => {
    if (open) {
      setApiKey(sessionStorage.getItem(ROUTE_TEST_KEY_STORAGE) ?? "");
      setResult(null);
      setErrorMsg("");
    }
  }, [open]);

  const send = async () => {
    if (loading) return;
    if (!apiKey.trim()) {
      setErrorMsg("请输入 API 密钥（虚拟密钥或 Master Key）");
      return;
    }
    setLoading(true);
    setErrorMsg("");
    setResult(null);
    sessionStorage.setItem(ROUTE_TEST_KEY_STORAGE, apiKey.trim());
    const start = Date.now();
    const isAnthropic = protocol === "anthropic";
    try {
      // r8：双协议端点 / 认证头 / 请求体（Anthropic max_tokens 必填；OpenAI 显式 stream:false）
      const res = await fetch(isAnthropic ? "/v1/messages" : "/v1/chat/completions", {
        method: "POST",
        headers: isAnthropic
          ? {
              "x-api-key": apiKey.trim(),
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            }
          : {
              "Authorization": `Bearer ${apiKey.trim()}`,
              "Content-Type": "application/json",
            },
        body: JSON.stringify(
          isAnthropic
            ? { model: route.model, max_tokens: 64, messages: [{ role: "user", content: message || "ping" }] }
            : {
                model: route.model,
                messages: [{ role: "user", content: message || "ping" }],
                max_tokens: 64,
                stream: false,
              },
        ),
      });
      const durationMs = Date.now() - start;
      const raw = await res.text();
      if (!res.ok) {
        setErrorMsg(`HTTP ${res.status}${raw ? ` · ${raw.slice(0, 240)}` : ""}`);
        return;
      }
      const d = JSON.parse(raw) as {
        // OpenAI 形态
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
        model?: string;
        // Anthropic 形态
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string;
      };
      const text = isAnthropic
        ? (d.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
        : d.choices?.[0]?.message?.content ?? "";
      setResult({
        httpStatus: res.status,
        durationMs,
        text,
        upstreamModel: d.model ?? null,
        inTok: isAnthropic ? d.usage?.input_tokens ?? null : d.usage?.prompt_tokens ?? null,
        outTok: isAnthropic ? d.usage?.output_tokens ?? null : d.usage?.completion_tokens ?? null,
        finishReason: isAnthropic ? d.stop_reason ?? null : d.choices?.[0]?.finish_reason ?? null,
        protocol,
      });
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    } catch (e) {
      setErrorMsg(errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // 上游模型归属提示：精确匹配某候选 → 显示候选；上游重写/不在候选中 → 如实标注
  const hitCandidate = result?.upstreamModel
    ? route.candidates.find((c) => c.model === result.upstreamModel)
    : undefined;
  const upstreamRewritten = !!result?.upstreamModel && !hitCandidate && !route.candidates.some((c) => c.model === result.upstreamModel);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            <Zap className="size-4 text-amber-500" />
            快速测试 · {route.model}
          </DialogTitle>
          <DialogDescription>
            发送一条最小真实请求验证整条候选链（含故障转移）。与普通请求一样计费并写入运行日志。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 候选链预览 */}
          <div className="flex flex-wrap items-center gap-1.5">
            {route.candidates.length === 0 ? (
              <span className="text-xs text-red-600">该路由无候选 —— 请求将 404</span>
            ) : (
              route.candidates.map((c, i) => (
                <React.Fragment key={c.id}>
                  {i > 0 && <ArrowRight className="size-3 text-stone-300" />}
                  <span className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-600">
                    <span className="text-emerald-700">{providerName(c.providerId)}</span>
                    <span className="text-stone-300">/</span>
                    {c.model}
                  </span>
                </React.Fragment>
              ))
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rt-test-key">API 密钥</Label>
            <Input
              id="rt-test-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-uag-...（虚拟密钥或 Master Key）"
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* r8：双协议切换（分段控件；切换时清空上次结果避免混淆） */}
          <div className="space-y-1.5">
            <Label>测试协议</Label>
            <div role="tablist" aria-label="测试协议" className="flex w-fit rounded-lg border border-stone-200 bg-stone-50 p-0.5">
              {([
                { id: "openai", label: "OpenAI", endpoint: "/v1/chat/completions" },
                { id: "anthropic", label: "Anthropic", endpoint: "/v1/messages" },
              ] as const).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={protocol === p.id}
                  onClick={() => {
                    setProtocol(p.id);
                    setResult(null);
                    setErrorMsg("");
                  }}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    protocol === p.id ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
                  }`}
                >
                  {p.label}
                  <span className="ml-1 font-mono text-[9px] text-stone-400">{p.endpoint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rt-test-msg">测试消息（max_tokens 固定 64，控制测试成本）</Label>
            <Textarea
              id="rt-test-msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="min-h-[54px] text-xs"
              rows={2}
            />
          </div>

          <Button onClick={() => void send()} disabled={loading || !message.trim()} className="w-full bg-stone-900 hover:bg-stone-800">
            {loading ? <Loader2 className="animate-spin" /> : <Send className="size-4" />}
            {loading ? "请求中…" : "发送测试请求"}
          </Button>

          {errorMsg && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700">
              <span className="font-medium">请求失败：</span>
              <span className="break-all">{errorMsg}</span>
            </div>
          )}

          {result && (
            <div ref={resultRef} className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
              <div className="flex flex-wrap items-center gap-1">
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                  <Check className="size-3" />
                  HTTP {result.httpStatus}
                </span>
                <span className={statBadgeCls}>{result.protocol === "anthropic" ? "Anthropic · /v1/messages" : "OpenAI · /v1/chat/completions"}</span>
                <span className={statBadgeCls}>{result.durationMs}ms</span>
                {result.inTok != null && <span className={statBadgeCls}>入 {result.inTok} tok</span>}
                {result.outTok != null && <span className={statBadgeCls}>出 {result.outTok} tok</span>}
                {result.finishReason && <span className={statBadgeCls}>finish: {result.finishReason}</span>}
              </div>
              {result.upstreamModel && (
                <div className="flex items-center gap-1.5 text-[11px] text-stone-600">
                  <ArrowRight className="size-3 text-emerald-600" />
                  <span>
                    最终命中上游模型：<code className="rounded bg-white px-1 py-0.5 font-mono text-[10px] text-stone-800">{result.upstreamModel}</code>
                    {hitCandidate && (
                      <span className="ml-1 text-stone-400">（候选「{hitCandidate.model}」，{providerName(hitCandidate.providerId)}）</span>
                    )}
                    {upstreamRewritten && (
                      <span className="ml-1 text-amber-600" title="上游返回的模型名与路由候选配置不一致（上游可能重写了模型名，或发生了故障转移）">
                        · 与候选配置不一致，详见运行日志
                      </span>
                    )}
                  </span>
                </div>
              )}
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-stone-200 bg-white p-2 text-[11px] leading-relaxed text-stone-700 [scrollbar-width:thin]">
                {result.text || "（空响应）"}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RoutesModule() {
  const [data, setData] = React.useState<RoutesData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  // v4.9.12-local-r10：上游模型目录缓存快照（r9 建议项 ④）——
  // 头部常驻展示各 provider 缓存年龄 / 覆盖模型数，替代「仅失效后瞬时可见」；无后端改动，复用 GET 快照 API
  const [catalogCache, setCatalogCache] = React.useState<CatalogCacheEntry[] | null>(null);
  const loadCatalogCache = React.useCallback(async () => {
    try {
      const d = await apiGet<{ cache: CatalogCacheEntry[] }>("/api/console/models/catalog");
      setCatalogCache(d.cache);
    } catch {
      setCatalogCache(null); // 非管理员会话 / 接口异常时静默隐藏（不影响路由主功能）
    }
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<RoutesData>("/api/console/routes");
      setData(d);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
    void loadCatalogCache();
  }, [loadCatalogCache]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  // 新增 / 编辑
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<RouteRow | null>(null);
  const [modelName, setModelName] = React.useState("");
  const [routeEnabled, setRouteEnabled] = React.useState(true);
  const [candidates, setCandidates] = React.useState<CandidateDraft[]>([]);
  // v4.6.0：路由级系统提示词注入（追加式，不覆盖客户端自带 system）
  const [prompt, setPrompt] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");

  // 删除
  const [delTarget, setDelTarget] = React.useState<RouteRow | null>(null);
  const [delSaving, setDelSaving] = React.useState(false);

  // v4.9.12-local-r4：行内快速测试
  const [testTarget, setTestTarget] = React.useState<RouteRow | null>(null);

  // v4.9.12-local-r9：模型目录缓存手动失效（路由/提供商变更后元数据立即可见，不必等 5min 新鲜期）
  const [catalogRefreshing, setCatalogRefreshing] = React.useState(false);
  const refreshCatalog = async () => {
    if (catalogRefreshing) return;
    setCatalogRefreshing(true);
    try {
      const d = await apiPost<{ invalidated: number; scope: string; cache: CatalogCacheEntry[] }>(
        "/api/console/models/catalog",
      );
      setCatalogCache(d.cache); // r10：失效后快照即时同步到头部缓存年龄条
      setNotice(
        d.invalidated > 0
          ? `模型目录缓存已清除（${d.invalidated} 个提供商）· Playground 重新加载模型列表即拉取最新元数据`
          : "缓存本为空，Playground 下次加载模型列表时将拉取最新上游目录",
      );
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setCatalogRefreshing(false);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const openCreate = () => {
    setEditing(null);
    setRouteEnabled(true);
    setCandidates([newDraft()]);
    setPrompt("");
    setFormError("");
    setDialogOpen(true);
  };

  const openEdit = (r: RouteRow) => {
    setEditing(r);
    setModelName(r.model);
    setRouteEnabled(r.enabled);
    setCandidates(r.candidates.map((c) => newDraft(c.providerId, c.model)));
    if (r.candidates.length === 0) setCandidates([newDraft()]);
    setFormError("");
    setPrompt(r.prompt ?? "");
    setDialogOpen(true);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setCandidates((items) => {
        const oldIndex = items.findIndex((i) => i.key === active.id);
        const newIndex = items.findIndex((i) => i.key === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const save = async () => {
    setFormError("");
    if (!/^[a-zA-Z0-9._/\[\]-]{1,128}$/.test(modelName.trim())) {
      setFormError("模型名不合法（1-128 位字母数字与 . _ / [ ] -）");
      return;
    }
    const valid = candidates.filter((c) => c.providerId && c.model.trim());
    if (valid.length !== candidates.length) {
      setFormError("存在未选择提供商或未填模型名的候选，请补全或删除");
      return;
    }
    if (valid.length === 0) {
      setFormError("至少添加一个候选");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        model: modelName.trim(),
        // v4.6.0：空串 → null（后端据此清除注入）
        prompt: prompt.trim() ? prompt.trim() : null,
        candidates: valid.map((c) => ({ providerId: c.providerId, model: c.model.trim() })),
      };
      if (editing) {
        await apiPut("/api/console/routes", { id: editing.id, enabled: routeEnabled, ...payload });
        setNotice(`路由「${modelName}」已更新`);
      } else {
        await apiPost("/api/console/routes", payload);
        setNotice(`路由「${modelName}」已创建`);
      }
      setDialogOpen(false);
      await load();
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleRoute = async (r: RouteRow, enabled: boolean) => {
    setData((d) => (d ? { ...d, routes: d.routes.map((x) => (x.id === r.id ? { ...x, enabled } : x)) } : d));
    try {
      await apiPut("/api/console/routes", { id: r.id, enabled });
    } catch (e) {
      setError(errMessage(e));
      await load();
    }
  };

  const confirmDelete = async () => {
    if (!delTarget) return;
    setDelSaving(true);
    try {
      await apiDelete(`/api/console/routes?id=${delTarget.id}`);
      setDelTarget(null);
      setNotice("路由已删除");
      await load();
    } catch (e) {
      setError(errMessage(e));
      setDelTarget(null);
    } finally {
      setDelSaving(false);
    }
  };

  const providers = data?.providers ?? [];
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name || id;
  const routes = data?.routes ?? [];
  // v4.9.12-local-r4：24h 统计（后端可能旧版未下带 → 可选）
  const stats24h = data?.stats24h ?? {};
  // v4.9.12-local-r5：按最终命中提供商聚合（键 = providerId）
  const providerStats24h = data?.providerStats24h ?? {};

  return (
    <div className="space-y-6">
      <PageHeader
        title="模型路由"
        description={`客户端模型 → 有序候选链（顺序即故障转移优先级）· 共 ${routes.length} 条`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
            </Button>
            {/* v4.9.12-local-r9：目录缓存手动失效 —— 提供商/候选变更后元数据立即可见 */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshCatalog()}
              disabled={catalogRefreshing}
              title="清除网关内存中的上游模型目录元数据缓存（新鲜期 5 分钟）。新增提供商或候选后点击，Playground 重新加载模型列表即可看到最新描述/上下文/能力标注"
            >
              <DatabaseZap className={catalogRefreshing ? "animate-pulse" : undefined} />
              刷新目录
            </Button>
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={openCreate}>
              <Plus />
              新增路由
            </Button>
          </>
        }
      />

      {/* v4.9.12-local-r10：目录缓存快照条（r9 建议项 ④：缓存年龄常驻可见，不再仅失效后瞬时展示） */}
      <CatalogCacheBar cache={catalogCache} />

      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <Check className="size-4" />
          {notice}
        </div>
      )}
      <ErrorAlert message={error} onRetry={load} />

      {loading && !data ? (
        <LoadingBlock rows={4} />
      ) : routes.length === 0 ? (
        <EmptyState
          icon={<RouteIcon className="size-6" />}
          title="尚无模型路由"
          description="创建路由把客户端模型指到候选中转；请求失败时按顺序自动切换下一个候选。"
          action={
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={openCreate}>
              <Plus />
              新增路由
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <div className="divide-y divide-stone-100">
            {routes.map((r) => (
              <div key={r.id} className="px-4 py-4 transition-colors hover:bg-stone-50/70">
                {/* 主行：开关 + 模型名 | 候选链 | 操作 */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 items-center gap-3 sm:w-72">
                    <Switch checked={r.enabled} onCheckedChange={(v) => void toggleRoute(r, v)} aria-label={`启用路由 ${r.model}`} />
                    <code className="min-w-0 truncate font-mono text-sm font-medium text-stone-800" title={r.model}>
                      {r.model}
                    </code>
                    {!r.enabled && <Badge variant="outline" className="shrink-0 text-[10px] text-stone-500">停用</Badge>}
                    {r.prompt && (
                      <Badge variant="outline" className="shrink-0 text-[10px] text-stone-600">
                        提示词
                      </Badge>
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    {r.candidates.length === 0 ? (
                      <span className="text-xs text-muted-foreground">无候选（请求将 404）</span>
                    ) : (
                      r.candidates.map((c, i) => (
                        <React.Fragment key={c.id}>
                          {i > 0 && <ArrowRight className="size-3.5 text-stone-300" />}
                          <span
                            className={`inline-flex max-w-[17rem] items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                              c.enabled
                                ? "border-stone-200 bg-stone-50 text-stone-700 hover:border-stone-300 hover:bg-white"
                                : "border-stone-200 bg-stone-100 text-stone-400 line-through"
                            }`}
                            title={`${providerName(c.providerId)} / ${c.model}${c.enabled ? providerHitTitle(providerStats24h[c.providerId]) : " · 已停用候选"}`}
                          >
                            <span className="shrink-0 whitespace-nowrap text-emerald-700">{providerName(c.providerId)}</span>
                            <span className="shrink-0 text-stone-400">/</span>
                            <span className="min-w-0 truncate">{c.model}</span>
                            {c.enabled && providerHitBadge(providerStats24h[c.providerId])}
                          </span>
                        </React.Fragment>
                      ))
                    )}
                  </div>

                  <div className="flex shrink-0 justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setTestTarget(r)}
                      aria-label={`快速测试 ${r.model}`}
                      title="快速测试：发送一条最小真实请求验证候选链"
                      className="group/t"
                    >
                      <Zap className="text-stone-400 transition-colors group-hover/t:text-amber-500" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(r)}
                      aria-label="编辑路由"
                      title="编辑模型名、候选链与系统提示词注入"
                      className="hover:[&_[svg]]:text-stone-800"
                    >
                      <Pencil className="text-stone-400 transition-colors" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDelTarget(r)}
                      aria-label="删除路由"
                      title="删除该路由（候选链一并删除）"
                      className="hover:[&_[svg]]:text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="text-red-400 transition-colors" />
                    </Button>
                  </div>
                </div>

                {/* 统计条：近 24h 调用概览（与模型名左缘对齐） */}
                <div className="mt-2.5 sm:pl-12">
                  <RouteStatBadges stat={stats24h[r.model]} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {providers.length === 0 && (
        <p className="text-xs text-amber-700">尚无提供商 —— 请先在「API 中转」中创建，否则路由候选无处可选。</p>
      )}

      {/* ---------- 新增 / 编辑路由 Dialog ---------- */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !o && setDialogOpen(false)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑路由 · ${editing.model}` : "新增模型路由"}</DialogTitle>
            <DialogDescription>
              候选按顺序故障转移：请求失败或模型身份错误时自动切换到下一个候选。拖动把手调整顺序。
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[62vh] pr-3">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="rt-model">模型名（客户端请求使用的名称）</Label>
                <Input
                  id="rt-model"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="如 claude-3-5-sonnet-20241022"
                  className="font-mono text-xs"
                />
              </div>

              {editing && (
                <div className="flex items-center gap-3">
                  <Switch checked={routeEnabled} onCheckedChange={setRouteEnabled} id="rt-enabled" />
                  <Label htmlFor="rt-enabled" className="font-normal text-muted-foreground">启用该路由</Label>
                </div>
              )}

              {/* v4.6.0：路由级系统提示词注入 —— 置于候选链之上，作用于整条路由 */}
              <div className="space-y-2">
                <Label htmlFor="rt-prompt">系统提示词注入（可选）</Label>
                <Textarea
                  id="rt-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={"例：回答保持简洁。当前模型 {{model}} 由 {{provider}} 提供。"}
                  className="min-h-[96px] font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  以「追加」方式并入请求，不会覆盖客户端自带的系统提示词。可用变量：
                  {" "}
                  <code>{"{{model}}"}</code> <code>{"{{provider}}"}</code>{" "}
                  <code>{"{{upstreamModel}}"}</code> <code>{"{{date}}"}</code>{" "}
                  <code>{"{{time}}"}</code> <code>{"{{datetime}}"}</code>{" "}
                  <code>{"{{apiKeyName}}"}</code>；未识别的变量原样保留。留空则不注入。
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>候选链（从上到下依次尝试）</Label>
                  <Button variant="outline" size="sm" onClick={() => setCandidates((c) => [...c, newDraft()])}>
                    <Plus />
                    添加候选
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  模型下拉直接使用原生项目提供的模型 ID（原样透传）；切换提供商后目录随之更新，也可切换为手动输入
                </p>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  <SortableContext items={candidates.map((c) => c.key)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {candidates.map((c, i) => (
                        <SortableCandidate
                          key={c.key}
                          cand={c}
                          index={i}
                          providers={providers}
                          onChange={(patch) => setCandidates((cs) => cs.map((x) => (x.key === c.key ? { ...x, ...patch } : x)))}
                          onRemove={() => setCandidates((cs) => cs.filter((x) => x.key !== c.key))}
                        />
                      ))}
                      {candidates.length === 0 && (
                        <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 px-3 py-4 text-center text-xs text-muted-foreground">
                          尚无候选 —— 点击「添加候选」
                        </p>
                      )}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>

              {formError && <p className="text-sm text-red-600">{formError}</p>}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving} className="bg-stone-900 hover:bg-stone-800">
              {saving && <Loader2 className="animate-spin" />}
              {editing ? "保存路由" : "创建路由"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- v4.9.12-local-r4：行内快速测试 ---------- */}
      {testTarget && (
        <RouteTestDialog
          route={testTarget}
          providerName={providerName}
          open={!!testTarget}
          onOpenChange={(o) => !o && setTestTarget(null)}
        />
      )}

      {/* ---------- 删除确认 ---------- */}
      <AlertDialog open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除路由「{delTarget?.model}」？</AlertDialogTitle>
            <AlertDialogDescription>
              路由与其全部候选将被删除。客户端再请求该模型将返回 404（无可用路由）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={delSaving}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              {delSaving && <Loader2 className="animate-spin" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
