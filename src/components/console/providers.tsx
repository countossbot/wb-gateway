// API 中转管理 —— 提供商实例卡片网格 + 新增/编辑配置悬浮窗（按类型动态字段、
// 提供商级代理覆盖）+ 删除（被路由引用时后端 409 展示原因）。
"use client";

import * as React from "react";
import {
  Activity,
  ArrowLeftRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Eye,
  History,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  EmptyState,
  ErrorAlert,
  KVEditor,
  LastUsedCell,
  LoadingBlock,
  PageHeader,
  TypeBadge,
} from "@/components/console/ui";
import { apiDelete, apiGet, apiPost, apiPut, errMessage } from "@/lib/console/api";
import { PROVIDER_TYPE_META, isMaskedValue, relativeTime, absoluteTime } from "@/lib/console/format";
import { cn } from "@/lib/utils";
import type {
  ConsoleProvider,
  ModelHealthRow,
  NativeProviderPreset,
  ProviderTestResult,
  ProviderType,
  ProvidersData,
} from "@/lib/console/types";

const TYPE_ICONS: Record<string, React.ElementType> = {
  workbuddy: Building2,
  openai: Zap,
  anthropic: Sparkles,
};

interface AccountRowDraft {
  key: string; // 前端行标识
  id: string;
  name: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

interface ProviderForm {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  proxyMode: "follow" | "direct" | "custom";
  proxyCustom: string;
  baseUrl: string;
  apiKey: string;
  anthropicVersion: string;
  balanceUrl: string;
  extraHeaders: Array<{ key: string; value: string }>;
  region: "cn" | "intl";
  accounts: AccountRowDraft[];
}

function emptyForm(): ProviderForm {
  return {
    id: "",
    name: "",
    type: "openai",
    enabled: true,
    proxyMode: "follow",
    proxyCustom: "",
    baseUrl: "",
    apiKey: "",
    anthropicVersion: "2023-06-01",
    balanceUrl: "",
    extraHeaders: [],
    region: "cn",
    accounts: [],
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formFromProvider(p: ConsoleProvider): ProviderForm {
  const cfg = p.config || {};
  const headers = (cfg.defaultHeaders as Record<string, string> | undefined) || {};
  const proxyOverride = p.proxyOverride;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    enabled: p.enabled,
    proxyMode: proxyOverride === "direct" ? "direct" : proxyOverride ? "custom" : "follow",
    proxyCustom: proxyOverride && proxyOverride !== "direct" ? proxyOverride : "",
    baseUrl: str(cfg.baseUrl),
    apiKey: str(cfg.apiKey),
    anthropicVersion: str(cfg.anthropicVersion) || "2023-06-01",
    balanceUrl: str(cfg.balanceUrl),
    extraHeaders: Object.entries(headers).map(([key, value]) => ({ key, value: String(value) })),
    region: cfg.region === "intl" ? "intl" : "cn",
    accounts: (p.accounts || []).map((a, i) => ({
      key: `acc-${i}-${a.id}`,
      id: a.id,
      name: a.name,
      userId: str(a.credentials?.userId),
      accessToken: str(a.credentials?.accessToken),
      refreshToken: str(a.credentials?.refreshToken),
    })),
  };
}

/** 从表单构建 config / accounts 载荷（掩码值原样传回，后端回填） */
function buildPayload(f: ProviderForm, editing: boolean) {
  const config: Record<string, unknown> = {};
  switch (f.type) {
    case "workbuddy":
      config.region = f.region;
      break;
    case "openai": {
      config.baseUrl = f.baseUrl.trim();
      if (f.apiKey) config.apiKey = f.apiKey.trim();
      if (f.balanceUrl.trim()) config.balanceUrl = f.balanceUrl.trim();
      const headers: Record<string, string> = {};
      for (const h of f.extraHeaders) {
        if (h.key.trim()) headers[h.key.trim()] = h.value;
      }
      if (Object.keys(headers).length > 0) config.defaultHeaders = headers;
      break;
    }
    case "anthropic":
      config.baseUrl = f.baseUrl.trim();
      if (f.apiKey) config.apiKey = f.apiKey.trim();
      if (f.anthropicVersion.trim()) config.anthropicVersion = f.anthropicVersion.trim();
      break;
  }

  const accounts =
    f.type === "workbuddy"
      ? f.accounts.map((a) => ({
          id: a.id || undefined,
          name: a.name.trim() || undefined,
          enabled: true,
          credentials: {
            ...(a.userId.trim() ? { userId: a.userId.trim() } : {}),
            ...(a.accessToken ? { accessToken: a.accessToken } : {}),
            ...(a.refreshToken ? { refreshToken: a.refreshToken } : {}),
          },
        }))
      : [];

  return {
    id: f.id.trim(),
    name: f.name.trim() || f.id.trim(),
    type: f.type,
    enabled: f.enabled,
    proxyOverride:
      f.proxyMode === "follow" ? null : f.proxyMode === "direct" ? "direct" : f.proxyCustom.trim(),
    config,
    accounts,
    ...(editing ? {} : {}),
  };
}

function allSecretsMasked(f: ProviderForm): boolean {
  const secrets: unknown[] = [f.apiKey];
  for (const a of f.accounts) secrets.push(a.accessToken, a.refreshToken);
  return secrets.every((v) => isMaskedValue(v));
}

/**
 * v3.8.0：模型健康一览行 —— 对外模型 × 路由候选（failover 顺序）× 24h 健康指标。
 * 成功率三档配色（≥90 emerald / ≥60 amber / <60 red）、耗时 >3s amber、
 * 最后调用复用共享 LastUsedCell；模型名可点击跳转该模型日志。
 */
// v4.9.12-local-r11：连通性测试结果条（卡片内嵌与悬浮窗共用）。
// 成功：翡翠描边 + 延迟/模型数/凭据来源；失败：红色描边 + 状态码与可操作错误。
// workbuddy（authChecked=false）仅网络可达性，措辞单独区分避免误导。
// v4.9.12-local-r12：持久化测试徽标（卡片常驻）。
// 数据源为服务端 lastTest（SystemSetting 持久化）；会话内重新测试后由 TestResultStrip 接管。
// 点击徽标 = 重新测试；title 展示完整结果明细。
function LastTestBadge({ result, onRetest, testing }: { result: ProviderTestResult; onRetest: () => void; testing: boolean }) {
  const anonymous = result.authSource === "none" && result.authChecked && result.ok;
  const tone = !result.ok
    ? "border-red-200 bg-red-50 text-red-600"
    : anonymous
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";
  const summary = !result.ok
    ? `探测失败${result.status !== null ? `（HTTP ${result.status}）` : ""}`
    : anonymous
      ? "连通（匿名）"
      : result.authChecked
        ? `上次连通 · ${result.elapsedMs} ms${result.modelsCount !== null ? ` · ${result.modelsCount} 模型` : ""}`
        : `网络可达 · ${result.elapsedMs} ms`;
  return (
    <button
      type="button"
      onClick={onRetest}
      disabled={testing}
      title={`最近一次连通性测试（点击重新测试）\n${summary}\n${result.target || "—"}${result.error ? `\n${result.error}` : ""}\n${absoluteTime(result.testedAt)}`}
      aria-label={`最近测试结果：${summary}，${relativeTime(result.testedAt)}。点击重新测试`}
      className={cn(
        "mt-3 inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors hover:brightness-95",
        tone,
        testing && "opacity-60"
      )}
    >
      {testing ? (
        <Loader2 className="size-2.5 animate-spin" aria-hidden />
      ) : (
        <span aria-hidden className={cn("size-1.5 rounded-full", !result.ok ? "bg-red-500" : anonymous ? "bg-amber-500" : "bg-emerald-500")} />
      )}
      {summary}
      <span className="opacity-70">· {relativeTime(result.testedAt)}</span>
    </button>
  );
}

function TestResultStrip({
  result,
  onDismiss,
  compact = false,
}: {
  result: ProviderTestResult;
  onDismiss?: () => void;
  compact?: boolean;
}) {
  const authSourceLabel: Record<ProviderTestResult["authSource"], string> = {
    "account-pool": "账号池密钥",
    "provider-key": "提供商密钥",
    draft: "草稿密钥",
    none: "匿名",
  };
  const anonymous = result.authSource === "none" && result.authChecked;
  const unreachable = result.status === null && !result.ok;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "mt-2 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed",
        result.ok && !anonymous
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : anonymous
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "border-red-200 bg-red-50 text-red-700"
      )}
    >
      <div className="flex items-start gap-1.5">
        {result.ok && !anonymous ? (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {result.ok
              ? anonymous
                ? "连通（匿名）"
                : result.authChecked
                  ? `连通 · ${result.elapsedMs} ms`
                  : `网络可达 · ${result.elapsedMs} ms（未校验凭据）`
              : unreachable
                ? "无法连接"
                : `探测失败（HTTP ${result.status ?? "—"}）`}
            {result.ok && result.modelsCount !== null && ` · ${result.modelsCount} 个模型`}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] opacity-80" title={result.target}>
            {result.target || "—"}
          </p>
          {!compact && result.ok && result.sampleModels.length > 0 && (
            <p className="mt-1 truncate font-mono text-[10px] opacity-75" title={result.sampleModels.join(", ")}>
              {result.sampleModels.join(" · ")}
            </p>
          )}
          {result.error && (
            <p className="mt-1 break-words" title={result.error}>
              {result.error}
            </p>
          )}
          <p className="mt-0.5 text-[10px] opacity-70">
            凭据：{authSourceLabel[result.authSource]}
            {result.authChecked ? "" : " · 仅测可达性"} · {new Date(result.testedAt).toLocaleTimeString()}
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="收起测试结果"
            className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <X className="size-3" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * v4.9.12-local-r13：编辑悬浮窗「最近测试历史」折叠区。
 * 数据源为服务端 testHistory（SystemSetting providerTestResults，cap 10 最新在前）；
 * 每条：状态点 + 摘要 + 相对时间（悬停绝对时间）+ 探测目标；失败条目附错误摘要。
 * 仅编辑态且有历史时渲染（新增态/无历史不占空间）。
 */
function TestHistorySection({ history }: { history: ProviderTestResult[] }) {
  const [open, setOpen] = React.useState(false);
  const okCount = history.filter((h) => h.ok).length;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-stone-200 bg-stone-50/50">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        >
          <History className="size-3.5 shrink-0 text-stone-400" aria-hidden />
          最近测试历史
          <Badge variant="outline" className="px-1 py-0 text-[9px] font-normal">{history.length}</Badge>
          <span className={cn("ml-auto text-[10px] font-normal", okCount === history.length ? "text-emerald-600" : "text-stone-400")}>
            {okCount}/{history.length} 连通
          </span>
          <ChevronDown className={cn("size-3.5 shrink-0 text-stone-400 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-48 space-y-0.5 overflow-y-auto border-t border-stone-100 px-2 py-2" aria-label="连通性测试历史列表">
          {history.map((h, i) => {
            const anonymous = h.authSource === "none" && h.authChecked && h.ok;
            const summary = !h.ok
              ? `失败${h.status !== null ? ` · HTTP ${h.status}` : " · 无法连接"}`
              : anonymous
                ? "连通（匿名）"
                : h.authChecked
                  ? `连通 · ${h.elapsedMs} ms${h.modelsCount !== null ? ` · ${h.modelsCount} 模型` : ""}`
                  : `网络可达 · ${h.elapsedMs} ms`;
            return (
              <li key={`${h.testedAt}-${i}`} className="rounded-md px-1.5 py-1 transition-colors hover:bg-white/70">
                <div className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", !h.ok ? "bg-red-500" : anonymous ? "bg-amber-500" : "bg-emerald-500")}
                  />
                  <span className="min-w-0 flex-1 truncate" title={h.error ?? summary}>
                    {summary}
                    {!h.ok && h.error && <span className="text-red-600"> · {h.error}</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-stone-400" title={absoluteTime(h.testedAt)}>
                    {relativeTime(h.testedAt)}
                  </span>
                </div>
                <p className="ml-3 truncate font-mono text-[10px] text-stone-400" title={`${h.target || "—"}${h.error ? ` — ${h.error}` : ""}`}>
                  {h.target || "—"}
                </p>
              </li>
            );
          })}
        </ul>
        <p className="border-t border-stone-100 px-3 py-1.5 text-[10px] leading-relaxed text-stone-400">
          测试记录仅用于运维排障（每提供商保留最近 {history.length} 条）；「测试连接」按钮即测当前表单/已保存配置。
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ModelHealthRowView({
  row,
  onViewLogsForModel,
}: {
  row: ModelHealthRow;
  onViewLogsForModel?: (model: string) => void;
}) {
  const clickable = !!onViewLogsForModel;
  return (
    <TableRow className={cn(clickable && "cursor-pointer")} onClick={clickable ? () => onViewLogsForModel!(row.model) : undefined}>
      <TableCell>
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5">
            {clickable ? (
              <button
                type="button"
                className="font-mono text-xs font-medium text-stone-800 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-500"
                onClick={(e) => {
                  e.stopPropagation(); // 行级 click 同跳，按钮层防止双触发
                  onViewLogsForModel!(row.model);
                }}
                aria-label={`查看模型 ${row.model} 的请求日志`}
              >
                {row.model}
              </button>
            ) : (
              <code className="font-mono text-xs font-medium text-stone-800">{row.model}</code>
            )}
            {!row.enabled && (
              <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1 text-[10px] text-stone-400">
                路由停用
              </Badge>
            )}
          </span>
          {clickable && <span className="text-[10px] text-stone-300">点击查看该模型的请求日志 →</span>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          {row.candidates.length === 0 ? (
            <span className="text-[11px] text-red-500" title="路由存在但没有任何候选 —— 该模型当前不可用">
              无候选
            </span>
          ) : (
            row.candidates.map((c) => (
              <span
                key={`${c.sortOrder}-${c.providerId}-${c.model}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  c.enabled
                    ? "border-stone-200 bg-stone-50 text-stone-600"
                    : "border-stone-100 bg-white text-stone-300 line-through"
                )}
                title={`候选 #${c.sortOrder} · ${c.providerId} → ${c.model}${c.enabled ? "" : "（已停用，failover 跳过）"}`}
              >
                <span className="rounded-sm bg-stone-200/70 px-0.5 text-[9px] font-sans font-medium text-stone-500">#{c.sortOrder}</span>
                {c.providerId}
                <span className="text-stone-300">→</span>
                {c.model}
              </span>
            ))
          )}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.calls24h === null ? (
          <span className="text-[11px] text-stone-300" title="近 24 小时无调用记录">
            无调用
          </span>
        ) : (
          <span className="text-xs text-stone-700">{row.calls24h}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {row.successRate24h === null ? (
          <span className="text-[11px] text-stone-300">—</span>
        ) : (
          <span
            className={cn(
              "text-xs font-medium tabular-nums",
              row.successRate24h >= 90 ? "text-emerald-600" : row.successRate24h >= 60 ? "text-amber-600" : "text-red-600"
            )}
            title="近 24 小时 2xx/3xx 响应占比"
          >
            {row.successRate24h}%
          </span>
        )}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">
        {row.avgDurationMs === null ? (
          <span className="text-[11px] text-stone-300">—</span>
        ) : (
          <span className={cn("text-xs", row.avgDurationMs > 3000 ? "text-amber-600" : "text-stone-600")}>
            {row.avgDurationMs} ms
          </span>
        )}
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <LastUsedCell at={row.lastUsedAt} noun="调用" emptyTitle="请求日志滚动窗口内无该模型的调用记录（语义为近期未调用）" />
      </TableCell>
    </TableRow>
  );
}

export function ProvidersModule({
  onViewLogs,
  /** v3.8.0：模型健康一览行点击 → 按模型过滤跳转运行日志（第八跳转通道） */
  onViewLogsForModel,
  /** r18：总览 Top 提供商行 → 定位高亮目标提供商卡片（第十二跳转通道） */
  focusProviderId,
  onProviderFocusConsumed,
}: {
  onViewLogs?: (providerId: string) => void;
  onViewLogsForModel?: (model: string) => void;
  focusProviderId?: string | null;
  onProviderFocusConsumed?: () => void;
} = {}) {
  const [data, setData] = React.useState<ProvidersData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  // v3.8.0：模型健康一览折叠态（默认展开；用户手折后 session 内保持）
  const [healthOpen, setHealthOpen] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<ProvidersData>("/api/console/providers");
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

  // 新增 / 编辑 Dialog
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ConsoleProvider | null>(null);
  const [form, setForm] = React.useState<ProviderForm>(emptyForm());
  // 提供商 ID 选择模式：预设下拉（默认）/ 自定义输入（多实例场景）
  const [idCustom, setIdCustom] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");

  // 删除
  const [delTarget, setDelTarget] = React.useState<ConsoleProvider | null>(null);
  const [delSaving, setDelSaving] = React.useState(false);

  // v4.9.12-local-r11：连通性测试（卡片按已保存配置实测；悬浮窗按草稿实测）
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [cardResults, setCardResults] = React.useState<Record<string, ProviderTestResult>>({});
  const [draftTesting, setDraftTesting] = React.useState(false);
  const [draftTest, setDraftTest] = React.useState<ProviderTestResult | null>(null);
  const [draftTestError, setDraftTestError] = React.useState("");

  // v4.9.12-local-r12：全部测试（批处理逐个实测，进度落在各卡片的 testingId 上）
  const [testingAll, setTestingAll] = React.useState(false);
  const testingAllRef = React.useRef(false);

  // r18：总览 Top 提供商行联动 —— 数据就绪后滚动定位 + 2.2s 翡翠光环（与设置页定价区引导同构）。
  // 消费回调在定位执行后才触发（清父级 state）；回调走 ref —— 若在 effect 内同步消费，
  // 父级重渲染会更换回调身份导致 effect cleanup 把 pending 定位定时器取消（首版实阳 bug）。
  const [highlightProviderId, setHighlightProviderId] = React.useState<string | null>(null);
  const consumedCbRef = React.useRef(onProviderFocusConsumed);
  consumedCbRef.current = onProviderFocusConsumed;
  React.useEffect(() => {
    if (!focusProviderId || !data) return;
    const pid = focusProviderId;
    // 下一帧滚动定位（等 grid 渲染完成），随后短暂光环标识目标卡
    const t = window.setTimeout(() => {
      const el = document.querySelector(`[data-provider-card="${CSS.escape(pid)}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightProviderId(pid);
      consumedCbRef.current?.();
      window.setTimeout(() => setHighlightProviderId((cur) => (cur === pid ? null : cur)), 2200);
    }, 150);
    return () => window.clearTimeout(t);
  }, [focusProviderId, data]);

  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const openCreate = () => {
    setEditing(null);
    const f = emptyForm();
    f.baseUrl = PROVIDER_TYPE_META[f.type]?.defaultBaseUrl || "";
    setForm(f);
    setIdCustom(false);
    setFormError("");
    setDraftTest(null);
    setDraftTestError("");
    setDialogOpen(true);
  };

  const openEdit = (p: ConsoleProvider) => {
    setEditing(p);
    setForm(formFromProvider(p));
    setFormError("");
    setDraftTest(null);
    setDraftTestError("");
    setDialogOpen(true);
  };

  // v4.9.12-local-r11：卡片「测试」——按已保存配置实测（后端自动取账号池首密钥/提供商密钥）
  const runCardTest = async (p: ConsoleProvider) => {
    setTestingId(p.id);
    try {
      const r = await apiPost<{ result: ProviderTestResult }>("/api/console/providers/test", { providerId: p.id });
      setCardResults((m) => ({ ...m, [p.id]: r.result }));
    } catch (e) {
      setCardResults((m) => ({
        ...m,
        [p.id]: {
          ok: false,
          status: null,
          elapsedMs: 0,
          target: "",
          type: p.type,
          authSource: "none",
          authChecked: true,
          modelsCount: null,
          sampleModels: [],
          error: errMessage(e),
          testedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  // v4.9.12-local-r11：悬浮窗「测试连接」——编辑态且密钥为掩码时按已保存配置实测
  //（掩码值发不上后端也解不开），否则按当前表单草稿实测（不落库）。
  const runDraftTest = async () => {
    setDraftTestError("");
    setDraftTesting(true);
    try {
      const keyMasked = !form.apiKey || form.apiKey.includes("••••") || form.apiKey === "***REDACTED***";
      const useSaved = !!editing && keyMasked;
      const payload = useSaved
        ? { providerId: editing!.id }
        : {
            draft: {
              type: form.type,
              baseUrl: form.baseUrl,
              apiKey: form.apiKey,
              anthropicVersion: form.anthropicVersion,
              region: form.region,
              defaultHeaders: Object.fromEntries(
                form.extraHeaders.filter((h) => h.key.trim() !== "").map((h) => [h.key, h.value])
              ),
            },
          };
      const r = await apiPost<{ result: ProviderTestResult }>("/api/console/providers/test", payload);
      setDraftTest(r.result);
    } catch (e) {
      setDraftTest(null);
      setDraftTestError(errMessage(e));
    } finally {
      setDraftTesting(false);
    }
  };

  const setF = (patch: Partial<ProviderForm>) => setForm((f) => ({ ...f, ...patch }));

  // 原生预设选择：提供商 ID + 类型 + 区域 + Base URL 一并填充（均为原生默认值，零映射）
  const applyPreset = (preset: NativeProviderPreset) => {
    setForm((f) => ({
      ...f,
      id: preset.id,
      type: preset.type as ProviderType,
      region: preset.region || (preset.type === "workbuddy" ? "cn" : f.region),
      baseUrl: preset.baseUrl || PROVIDER_TYPE_META[preset.type as ProviderType]?.defaultBaseUrl || "",
      name: f.name || preset.id,
    }));
  };

  const changeType = (t: ProviderType) => {
    setForm((f) => ({
      ...f,
      type: t,
      baseUrl: f.baseUrl ? f.baseUrl : PROVIDER_TYPE_META[t]?.defaultBaseUrl || "",
    }));
  };

  const save = async () => {
    setFormError("");

    if (!editing) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(form.id.trim())) {
        setFormError("提供商 ID 必须为 1-64 位字母数字或 -_（将用于路由候选引用）");
        return;
      }
      if (form.proxyMode === "custom" && !form.proxyCustom.trim()) {
        setFormError("自定义代理模式下必须填写代理地址");
        return;
      }
    }


    if (form.type === "workbuddy" && form.accounts.length === 0) {
      setFormError("WorkBuddy 提供商至少需要一个账号（账号池）");
      return;
    }

    setSaving(true);
    try {
      const payload = buildPayload(form, !!editing);
      if (editing) {
        await apiPut("/api/console/providers", payload);
        setNotice(`中转「${form.name || form.id}」已更新`);
      } else {
        await apiPost("/api/console/providers", payload);
        setNotice(`中转「${form.name || form.id}」已创建`);
      }
      setDialogOpen(false);
      await load();
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (p: ConsoleProvider, enabled: boolean) => {
    setData((d) =>
      d ? { ...d, providers: d.providers.map((x) => (x.id === p.id ? { ...x, enabled } : x)) } : d
    );
    try {
      await apiPut("/api/console/providers", {
        id: p.id,
        name: p.name,
        type: p.type,
        enabled,
        proxyOverride: p.proxyOverride,
        config: p.config, // 掩码值原样传回
        accounts: p.accounts.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, credentials: a.credentials })),
      });
    } catch (e) {
      setError(errMessage(e));
      await load();
    }
  };

  const confirmDelete = async () => {
    if (!delTarget) return;
    setDelSaving(true);
    try {
      await apiDelete(`/api/console/providers?id=${encodeURIComponent(delTarget.id)}`);
      setDelTarget(null);
      setNotice("中转已删除");
      await load();
    } catch (e) {
      setError(errMessage(e));
      setDelTarget(null);
    } finally {
      setDelSaving(false);
    }
  };

  const providers = data?.providers ?? [];
  const nativePresets = data?.nativePresets ?? [];
  // v4.9.12-local-r13：编辑悬浮窗「最近测试历史」数据源 —— 优先取列表最新数据（保存/重测后更准确），回退打开对话框时捕获的对象
  const editingHistory = editing
    ? providers.find((x) => x.id === editing.id)?.testHistory ?? editing.testHistory ?? []
    : [];

  // v4.9.12-local-r12：全部测试 —— 逐个实测（复用单卡测试通道），结果汇入 notice；
  // providersRef 供事件监听器读到最新列表而不依赖闭包时序。
  const providersRef = React.useRef<ConsoleProvider[]>(providers);
  providersRef.current = providers;

  const runAllTests = React.useCallback(async () => {
    if (testingAllRef.current) return;
    const list = providersRef.current;
    if (list.length === 0) return;
    testingAllRef.current = true;
    setTestingAll(true);
    let okCount = 0;
    let failCount = 0;
    for (const p of list) {
      setTestingId(p.id);
      try {
        const r = await apiPost<{ result: ProviderTestResult }>("/api/console/providers/test", { providerId: p.id });
        setCardResults((m) => ({ ...m, [p.id]: r.result }));
        if (r.result.ok) okCount++;
        else failCount++;
      } catch (e) {
        failCount++;
        setCardResults((m) => ({
          ...m,
          [p.id]: {
            ok: false,
            status: null,
            elapsedMs: 0,
            target: "",
            type: p.type,
            authSource: "none",
            authChecked: true,
            modelsCount: null,
            sampleModels: [],
            error: errMessage(e),
            testedAt: new Date().toISOString(),
          },
        }));
      }
    }
    setTestingId(null);
    setTestingAll(false);
    testingAllRef.current = false;
    setNotice(`全部测试完成：${okCount} 连通 / ${failCount} 失败（共 ${list.length} 个）`);
  }, []);

  // ⌘K 面板「测试提供商连通性」入口：双通道防错过 ——
  // 模块已挂载 → CustomEvent 直接触发；未挂载（正在切页）→ mount 时检查 sessionStorage 旗标。
  React.useEffect(() => {
    const handler = () => void runAllTests();
    window.addEventListener("uag:run-provider-test-all", handler);
    try {
      if (sessionStorage.getItem("uag:pending-test-all") === "1") {
        sessionStorage.removeItem("uag:pending-test-all");
        handler();
      }
    } catch {
      /* sessionStorage 不可用时仅依赖事件通道 */
    }
    return () => window.removeEventListener("uag:run-provider-test-all", handler);
  }, [runAllTests]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="API 中转管理"
        description={`上游提供商实例（调度按路由候选顺序故障转移）· 共 ${providers.length} 个`}
        actions={
          <>
            {providers.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runAllTests()}
                disabled={testingAll || loading}
                title="逐个实测全部提供商连通性（结果持久化，卡片常驻徽标同步更新）"
              >
                {testingAll ? <Loader2 className="animate-spin" /> : <Activity />}
                {testingAll ? "测试中…" : "全部测试"}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
            </Button>
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={openCreate}>
              <Plus />
              新增中转
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
        <LoadingBlock rows={3} />
      ) : providers.length === 0 ? (
        <EmptyState
          icon={<Server className="size-6" />}
          title="尚未配置任何 API 中转"
          description="添加 WorkBuddy / OpenAI 兼容 / Anthropic 兼容 / OpenCode Zen / Qwen Web 提供商，然后在「模型路由」中把模型指到这些中转。"
          action={
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={openCreate}>
              <Plus />
              新增中转
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((p) => {
            const TypeIcon = TYPE_ICONS[p.type] || Server;
            return (
              <div
                key={p.id}
                data-provider-card={p.id}
                className={`flex flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-xs transition-shadow duration-300${
                  highlightProviderId === p.id ? " ring-2 ring-emerald-400/70 ring-offset-2" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-stone-100 text-stone-600">
                        <TypeIcon className="size-4.5" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-stone-900">{p.name}</p>
                        <code className="text-[11px] text-stone-400">{p.id}</code>
                      </div>
                    </div>
                  </div>
                  <Switch checked={p.enabled} onCheckedChange={(v) => void toggleEnabled(p, v)} aria-label={`启用 ${p.name}`} />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <TypeBadge type={p.type} />
                  <Badge variant="secondary" className="text-[11px]">
                    账号 {p.accountEnabledCount}/{p.accountCount}
                  </Badge>
                  {/* v4.2.2：标准适配器多密钥轮换徽标（openai/anthropic + 启用账号 ≥1） */}
                  {(p.type === "openai" || p.type === "anthropic") && p.accountEnabledCount > 0 && (
                    <Badge
                      variant="outline"
                      className="gap-1 border-violet-200 bg-violet-50 text-[11px] font-medium text-violet-700"
                      title="多密钥轮换：请求在启用账号间调度（会话粘性 + 轮转 + 冷却退避 + 失败切换），响应头 X-Gateway-Account 可见落点；未配账号时使用下方单密钥直连"
                    >
                      <KeyRound className="size-3" aria-hidden="true" />
                      多密钥轮换
                    </Badge>
                  )}
                  {p.proxyOverride === "direct" && (
                    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[11px] text-amber-700">
                      <X className="size-3" /> 直连
                    </Badge>
                  )}
                  {p.proxyOverride && p.proxyOverride !== "direct" && (
                    <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[11px] text-teal-700">
                      <ArrowLeftRight className="size-3" /> 专属代理
                    </Badge>
                  )}
                  {!p.enabled && (
                    <Badge variant="outline" className="border-stone-200 bg-stone-50 text-[11px] text-stone-500">已停用</Badge>
                  )}
                </div>

                {/* v3.0.3：近 24h 调用统计（RequestLog 聚合）；v3.0.4：点击跳转运行日志并按提供商过滤 */}
                {p.stats24h && p.stats24h.requests > 0 ? (
                  <button
                    type="button"
                    onClick={() => onViewLogs?.(p.id)}
                    title={`点击查看 ${p.id} 的请求日志`}
                    aria-label={`查看 ${p.name} 近 24h 请求日志`}
                    className="mt-3 flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-stone-50 px-2.5 py-1.5 text-left text-[11px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <span className="shrink-0 whitespace-nowrap font-medium text-stone-600">近 24h</span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums">{p.stats24h.requests} 次调用</span>
                    <span
                      className={`shrink-0 whitespace-nowrap font-medium tabular-nums ${
                        p.stats24h.successRate >= 90 ? "text-emerald-600" : p.stats24h.successRate >= 60 ? "text-amber-600" : "text-red-600"
                      }`}
                      title="近 24 小时 2xx/3xx 响应占比"
                    >
                      成功率 {p.stats24h.successRate}%
                    </span>
                    {p.stats24h.avgDurationMs !== null && (
                      <span className={`shrink-0 whitespace-nowrap tabular-nums ${p.stats24h.avgDurationMs > 3000 ? "text-amber-600" : ""}`}>
                        平均 {p.stats24h.avgDurationMs} ms
                      </span>
                    )}
                    <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-stone-400">日志
                      <ArrowLeftRight className="size-3" />
                    </span>
                  </button>
                ) : (
                  <p className="mt-3 text-[11px] text-stone-300">近 24h 无调用记录</p>
                )}

                {/* v4.9.12-local-r12：持久化测试徽标（服务端 lastTest，会话内未重测时展示） */}
                {!cardResults[p.id] && p.lastTest && (
                  <LastTestBadge result={p.lastTest} testing={testingId === p.id} onRetest={() => void runCardTest(p)} />
                )}

                {/* v4.9.12-local-r11：连通性测试结果（内嵌卡片，可收起；会话内实测后覆盖持久徽标） */}
                {cardResults[p.id] && (
                  <TestResultStrip
                    result={cardResults[p.id]}
                    onDismiss={() =>
                      setCardResults((m) => {
                        const next = { ...m };
                        delete next[p.id];
                        return next;
                      })
                    }
                  />
                )}

                <div className="mt-auto flex justify-end gap-1 pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void runCardTest(p)}
                    disabled={testingId === p.id}
                    title="实测上游连通性（GET /models，与真实转发同源路径与凭据）"
                  >
                    {testingId === p.id ? <Loader2 className="animate-spin" /> : <Activity />}
                    {testingId === p.id ? "测试中…" : "测试"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                    <Pencil />
                    编辑
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDelTarget(p)} className="text-red-600 hover:bg-red-50 hover:text-red-700">
                    <Trash2 />
                    删除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- v3.8.0：模型健康一览（对外模型 × 路由候选 × 24h 健康指标） ---------- */}
      {(data?.modelHealth?.length ?? 0) > 0 && (
        <section className="rounded-xl border border-stone-200 bg-white" aria-label="模型健康一览">
          <button
            type="button"
            onClick={() => setHealthOpen((o) => !o)}
            aria-expanded={healthOpen}
            className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-stone-100 px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md bg-teal-50 text-teal-600">
                <Activity className="size-4" />
              </span>
              <p className="text-sm font-medium text-stone-700">模型健康一览</p>
              <Badge variant="secondary" className="text-[11px]">
                {data!.modelHealth!.length} 个对外模型
              </Badge>
              <Badge variant="outline" className="border-stone-200 text-[11px] text-stone-400">
                24h 有调用 {data!.modelHealth!.filter((m) => (m.calls24h ?? 0) > 0).length} 个
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="hidden sm:inline">近 24h 调用 · 成功率 · 平均耗时 · 最后调用</span>
              <ChevronDown className={cn("size-4 text-stone-400 transition-transform", healthOpen && "rotate-180")} />
            </div>
          </button>
          {healthOpen && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>对外模型</TableHead>
                    <TableHead className="min-w-64">路由候选（failover 顺序）</TableHead>
                    <TableHead className="text-right">24h 调用</TableHead>
                    <TableHead className="text-right">成功率</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">平均耗时</TableHead>
                    <TableHead className="hidden lg:table-cell">最后调用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.modelHealth!.map((m) => (
                    <ModelHealthRowView key={m.model} row={m} onViewLogsForModel={onViewLogsForModel} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      {/* ---------- 新增/编辑配置悬浮窗 ---------- */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !o && setDialogOpen(false)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑中转 · ${editing.name}` : "新增 API 中转"}</DialogTitle>
            <DialogDescription>
              按提供商类型渲染字段；凭据显示掩码，未改动将沿用原值。
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[62vh] pr-3">
            <div className="space-y-5">
              {/* 基本信息 */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={editing ? "pv-id" : "pv-id-select"}>提供商 ID</Label>
                  {editing ? (
                    <>
                      <Input id="pv-id" value={form.id} disabled className="font-mono text-xs" />
                      <p className="text-xs text-muted-foreground">ID 创建后不可修改</p>
                    </>
                  ) : idCustom ? (
                    <>
                      <div className="flex gap-1.5">
                        <Input
                          id="pv-id"
                          value={form.id}
                          onChange={(e) => setF({ id: e.target.value })}
                          placeholder="自定义 ID（1-64 位字母数字或 -_）"
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 shrink-0"
                          onClick={() => { setIdCustom(false); setF({ id: "" }); }}
                        >
                          预设
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">适用多实例场景：同一类型可建多个中转（如多个 OpenAI 兼容端点）</p>
                    </>
                  ) : (
                    <>
                      <Select
                        value={(nativePresets || []).some((p) => p.id === form.id) ? form.id : form.id ? "custom" : undefined}
                        onValueChange={(v) => {
                          if (v === "custom") {
                            setIdCustom(true);
                            setF({ id: "" });
                            return;
                          }
                          const preset = (nativePresets || []).find((p) => p.id === v);
                          if (preset) applyPreset(preset);
                        }}
                      >
                        <SelectTrigger id="pv-id-select" className="w-full font-mono text-xs">
                          <SelectValue placeholder="选择原生预设提供商" />
                        </SelectTrigger>
                        <SelectContent>
                          {(nativePresets || []).map((p) => {
                            const taken = providers.some((x) => x.id === p.id);
                            return (
                              <SelectItem key={p.id} value={p.id} disabled={taken}>
                                <span className="font-mono text-[11px] font-semibold">{p.id}</span>
                                <span className="ml-1.5 text-muted-foreground">{p.label}</span>
                                {taken && <Badge variant="outline" className="ml-1 text-[9px]">已存在</Badge>}
                              </SelectItem>
                            );
                          })}
                          <SelectItem value="custom">
                            <span className="text-xs">自定义 ID…（多实例）</span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">预设取自原生项目提供商列表（排序/展示与原生一致）；选中后自动填充类型与默认端点</p>
                    </>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pv-name">显示名称</Label>
                  <Input id="pv-name" value={form.name} onChange={(e) => setF({ name: e.target.value })} placeholder="留空同 ID" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select value={form.type} onValueChange={(v) => changeType(v as ProviderType)} disabled={!!editing}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PROVIDER_TYPE_META).map(([t, meta]) => {
                      const Icon = TYPE_ICONS[t];
                      const metaInfo = meta as { label: string; desc: string };
                      return (
                        <SelectItem key={t} value={t}>
                          <Icon className="size-4 text-stone-400" />
                          <span className="font-medium">{metaInfo.label}</span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{PROVIDER_TYPE_META[form.type]?.desc}</p>
              </div>

              <div className="flex items-center gap-3">
                <Switch checked={form.enabled} onCheckedChange={(v) => setF({ enabled: v })} id="pv-enabled" />
                <Label htmlFor="pv-enabled" className="font-normal text-muted-foreground">启用该中转（停用后不参与调度）</Label>
              </div>

              {/* 按类型渲染字段 */}
              {form.type === "workbuddy" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>站点区域</Label>
                    <RadioGroup value={form.region} onValueChange={(v) => setF({ region: v as "cn" | "intl" })} className="flex gap-6">
                      <div className="flex items-center gap-2">
                        <RadioGroupItem value="cn" id="wb-cn" />
                        <Label htmlFor="wb-cn" className="font-normal">国内站（cn）</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <RadioGroupItem value="intl" id="wb-intl" />
                        <Label htmlFor="wb-intl" className="font-normal">国际站（intl）</Label>
                      </div>
                    </RadioGroup>
                    <p className="text-xs text-muted-foreground">区域决定整组端点与签到 / 余额接口</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>账号池（多账号轮转调度）</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setF({
                            accounts: [
                              ...form.accounts,
                              { key: `acc-new-${Date.now()}`, id: "", name: "", userId: "", accessToken: "", refreshToken: "" },
                            ],
                          })
                        }
                      >
                        <Plus />
                        添加账号
                      </Button>
                    </div>
                    {form.accounts.length === 0 && (
                      <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 px-3 py-4 text-center text-xs text-muted-foreground">
                        尚未添加账号 —— WorkBuddy 需要 userId / accessToken 凭据才能调用
                      </p>
                    )}
                    {form.accounts.map((a, i) => (
                      <div key={a.key} className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/40 p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-stone-600">账号 #{i + 1}{a.id ? ` · ${a.id}` : ""}</span>
                          <Button variant="ghost" size="icon" className="size-7" onClick={() => setF({ accounts: form.accounts.filter((x) => x.key !== a.key) })} aria-label="删除此账号">
                            <Trash2 className="size-3.5 text-red-500" />
                          </Button>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Input value={a.id} onChange={(e) => setF({ accounts: form.accounts.map((x) => (x.key === a.key ? { ...x, id: e.target.value } : x)) })} placeholder="账号 ID（留空自动）" className="font-mono text-xs" disabled={!!a.id && !!editing} />
                          <Input value={a.name} onChange={(e) => setF({ accounts: form.accounts.map((x) => (x.key === a.key ? { ...x, name: e.target.value } : x)) })} placeholder="名称（可选）" />
                        </div>
                        <Input value={a.userId} onChange={(e) => setF({ accounts: form.accounts.map((x) => (x.key === a.key ? { ...x, userId: e.target.value } : x)) })} placeholder="User ID" className="font-mono text-xs" />
                        <Input value={a.accessToken} onChange={(e) => setF({ accounts: form.accounts.map((x) => (x.key === a.key ? { ...x, accessToken: e.target.value } : x)) })} placeholder="Access Token" className="font-mono text-xs" autoComplete="off" spellCheck={false} />
                        <Input value={a.refreshToken} onChange={(e) => setF({ accounts: form.accounts.map((x) => (x.key === a.key ? { ...x, refreshToken: e.target.value } : x)) })} placeholder="Refresh Token（可选，用于 401 自动续签）" className="font-mono text-xs" autoComplete="off" spellCheck={false} />
                        {a.accessToken.includes("••••") && (
                          <p className="text-xs text-muted-foreground">掩码值原样传回将沿用原凭据</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {form.type === "openai" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-baseurl">Base URL</Label>
                    <Input id="pv-baseurl" value={form.baseUrl} onChange={(e) => setF({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" className="font-mono text-xs" />
                    <p className="text-xs text-muted-foreground">OpenRouter / DeepSeek / 硅基流动等 OpenAI 协议端点</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-apikey">API Key</Label>
                    <Input id="pv-apikey" value={form.apiKey} onChange={(e) => setF({ apiKey: e.target.value })} placeholder="sk-…" className="font-mono text-xs" autoComplete="off" spellCheck={false} />
                    {form.apiKey.includes("••••") && <p className="text-xs text-muted-foreground">当前为掩码值，保存时沿用原值</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label>附加请求头（可选）</Label>
                    <KVEditor rows={form.extraHeaders} onChange={(rows) => setF({ extraHeaders: rows })} keyPlaceholder="如 X-Title" valuePlaceholder="如 my-app" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-balanceurl">余额查询 URL（可选）</Label>
                    <Input id="pv-balanceurl" value={form.balanceUrl} onChange={(e) => setF({ balanceUrl: e.target.value })} placeholder="https://…/dashboard/billing/credit_grants" className="font-mono text-xs" />
                  </div>
                </div>
              )}

              {form.type === "anthropic" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-a-baseurl">Base URL</Label>
                    <Input id="pv-a-baseurl" value={form.baseUrl} onChange={(e) => setF({ baseUrl: e.target.value })} placeholder="https://api.anthropic.com" className="font-mono text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-a-apikey">API Key</Label>
                    <Input id="pv-a-apikey" value={form.apiKey} onChange={(e) => setF({ apiKey: e.target.value })} placeholder="sk-ant-…" className="font-mono text-xs" autoComplete="off" spellCheck={false} />
                    {form.apiKey.includes("••••") && <p className="text-xs text-muted-foreground">当前为掩码值，保存时沿用原值</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-a-version">anthropic-version</Label>
                    <Input id="pv-a-version" value={form.anthropicVersion} onChange={(e) => setF({ anthropicVersion: e.target.value })} placeholder="2023-06-01" className="font-mono text-xs" />
                  </div>
                </div>
              )}

              {/* 提供商级代理覆盖 */}
              <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/50 p-3">
                <Label>提供商级代理覆盖</Label>
                <Select value={form.proxyMode} onValueChange={(v) => setF({ proxyMode: v as ProviderForm["proxyMode"] })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="follow">跟随全局设置</SelectItem>
                    <SelectItem value="direct">强制直连（绕过全局代理）</SelectItem>
                    <SelectItem value="custom">自定义代理地址</SelectItem>
                  </SelectContent>
                </Select>
                {form.proxyMode === "custom" && (
                  <Input
                    value={form.proxyCustom}
                    onChange={(e) => setF({ proxyCustom: e.target.value })}
                    placeholder="http://user:pass@host:port 或 socks5://…（可逗号分隔代理池）"
                    className="font-mono text-xs"
                  />
                )}
                <p className="text-xs text-muted-foreground">优先级：提供商覆盖 &gt; 全局代理 &gt; 环境变量 &gt; 直连</p>
              </div>

              {/* v4.9.12-local-r13：最近测试历史折叠区（编辑态且有历史时展示） */}
              {editing && editingHistory.length > 0 && <TestHistorySection history={editingHistory} />}

            </div>
          </ScrollArea>

          {/* v4.9.12-local-r11：草稿连通性测试结果（表单滚动区外，footer 上方，与表单错误同层） */}
          {draftTest && (
            <TestResultStrip
              result={draftTest}
              compact
              onDismiss={() => setDraftTest(null)}
            />
          )}
          {draftTestError && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">测试请求失败：{draftTestError}</span>
            </div>
          )}

          {/* v4.2.1：表单错误固定在滚动区外、footer 上方 —— 长表单无需滚到底即可看到校验错误
              （此前错误渲染在表单末尾，id 未填等校验错误在长表单下不可见，被误以为「点保存没反应」） */}
          {formError && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{formError}</span>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void runDraftTest()}
              disabled={draftTesting || saving}
              title={editing && (!form.apiKey || form.apiKey.includes("••••")) ? "密钥为掩码：将按已保存配置实测" : "按当前表单值实测（不会保存草稿）"}
            >
              {draftTesting ? <Loader2 className="animate-spin" /> : <Activity />}
              {draftTesting ? "测试中…" : "测试连接"}
            </Button>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving} className="bg-stone-900 hover:bg-stone-800">
              {saving && <Loader2 className="animate-spin" />}
              {editing ? "保存修改" : "创建中转"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 删除确认 ---------- */}
      <AlertDialog open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除中转「{delTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              该提供商及其全部账号将被删除（不可撤销）。若有模型路由候选引用它，删除会被拒绝并提示先移除相关路由。
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
