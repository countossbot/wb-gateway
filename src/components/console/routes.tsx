// 模型路由 —— 模型名 → 有序候选链（故障转移顺序）。
// 候选列表编辑器支持 @dnd-kit 拖拽排序；顺序即数组顺序，保存时全量重写。
"use client";

import * as React from "react";
import {
  ArrowRight,
  Check,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Trash2,
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
import {
  EmptyState,
  ErrorAlert,
  LoadingBlock,
  PageHeader,
} from "@/components/console/ui";
import { apiDelete, apiGet, apiPost, apiPut, errMessage } from "@/lib/console/api";
import type { RouteRow, RoutesData } from "@/lib/console/types";

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
  source: "upstream" | "derived";
  models: string[];
  details?: UpstreamModelDetail[];
  /** 上游全量模型数（含 CLI 白名单外旧模型），与 models.length 不同时有参考意义 */
  allCount?: number;
  fallbackReason?: string;
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

function SortableCandidate({
  cand,
  index,
  providers,
  providerModels,
  onChange,
  onRemove,
}: {
  cand: CandidateDraft;
  index: number;
  providers: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  providerModels?: Record<string, string[]>;
  onChange: (patch: Partial<CandidateDraft>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cand.key });

  // v4.7.2 修复：模型下拉弹层超出对话框卡片 —— Radix 默认以视口为碰撞边界，
  // 长目录（16-30 项）向上翻转时会冲出卡片顶部。改为以所在 Dialog 元素为碰撞边界
  //（collisionBoundary）+ 高度上限，弹层始终限制在卡片内并内部滚动。
  const modelTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [modelMenuBoundary, setModelMenuBoundary] = React.useState<HTMLDivElement | null>(null);

  // 当前提供商的静态原生模型目录（兑底）：按适配器类型归组；模型 ID 原样透传
  const provider = providers.find((p) => p.id === cand.providerId);
  const nativeModels = (providerModels && provider && providerModels[provider.type]) || [];

  // 上游实时模型目录：选提供商后自动拉取（失败/超时自动降级静态目录，手动输入始终可用）
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
        setUpstream({ source: d.source, models: d.models || [], details: d.details, allCount: d.allCount, fallbackReason: d.fallbackReason, upstreamUrl: d.upstreamUrl });
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

  // 模型下拉数据源：优先上游/推导目录；拉取中或失败时兑底静态目录
  const upstreamModels = upstream?.models?.length ? upstream.models : [];
  const hasClientCatalog = upstream?.source === "upstream";
  const modelOptions = hasClientCatalog ? upstreamModels : nativeModels;
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
            拉取失败 → 推导目录降级），workbuddy 上游响应含元数据 → 下拉项精简展示
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
                      : upstream?.source === "upstream"
                        ? `选择模型（客户端实时 · ${modelOptions.length} 个）`
                        : upstream?.source === "derived"
                          ? `选择模型（已知目录 · ${modelOptions.length} 个）`
                          : `选择模型（${modelOptions.length} 个）`
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
                    {upstream.source === "upstream" ? (
                      <><span className="size-1.5 rounded-full bg-teal-500" />已对齐客户端实时列表（{modelOptions.length}/{upstream.allCount}）</>
                    ) : (
                      <><span className="size-1.5 rounded-full bg-amber-500" />已知目录 · 来自当前路由配置与内置预设{upstream.fallbackReason ? `（${upstream.fallbackReason.slice(0, 60)}）` : "（该类型上游无公开模型列表接口，或暂时不可用）"}</>
                    )}
                  </div>
                )}
                {modelsError && !upstream && (
                  <div className="px-2 py-1.5 text-[10px] text-red-500">模型目录拉取失败——已降级静态目录，可点右侧刷新重试</div>
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

export function RoutesModule() {
  const [data, setData] = React.useState<RoutesData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

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
  }, []);

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
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");

  // 删除
  const [delTarget, setDelTarget] = React.useState<RouteRow | null>(null);
  const [delSaving, setDelSaving] = React.useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const openCreate = () => {
    setEditing(null);
    setModelName("");
    setRouteEnabled(true);
    setCandidates([newDraft()]);
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
  const providerModels = data?.providerModels;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name || id;
  const routes = data?.routes ?? [];

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
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={openCreate}>
              <Plus />
              新增路由
            </Button>
          </>
        }
      />

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
              <div key={r.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 items-center gap-3 sm:w-72">
                  <Switch checked={r.enabled} onCheckedChange={(v) => void toggleRoute(r, v)} aria-label={`启用路由 ${r.model}`} />
                  <code className="min-w-0 truncate font-mono text-sm font-medium text-stone-800" title={r.model}>
                    {r.model}
                  </code>
                  {!r.enabled && <Badge variant="outline" className="shrink-0 text-[10px] text-stone-500">停用</Badge>}
                </div>

                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  {r.candidates.length === 0 ? (
                    <span className="text-xs text-muted-foreground">无候选（请求将 404）</span>
                  ) : (
                    r.candidates.map((c, i) => (
                      <React.Fragment key={c.id}>
                        {i > 0 && <ArrowRight className="size-3.5 text-stone-300" />}
                        <span
                          className={`inline-flex max-w-56 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                            c.enabled
                              ? "border-stone-200 bg-stone-50 text-stone-700"
                              : "border-stone-200 bg-stone-100 text-stone-400 line-through"
                          }`}
                          title={`${providerName(c.providerId)} / ${c.model}`}
                        >
                          <span className="text-emerald-700">{providerName(c.providerId)}</span>
                          <span className="text-stone-400">/</span>
                          <span className="truncate">{c.model}</span>
                        </span>
                      </React.Fragment>
                    ))
                  )}
                </div>

                <div className="flex shrink-0 justify-end gap-1">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(r)} aria-label="编辑路由">
                    <Pencil className="text-stone-500" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDelTarget(r)} aria-label="删除路由">
                    <Trash2 className="text-red-500" />
                  </Button>
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
                          providerModels={providerModels}
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
