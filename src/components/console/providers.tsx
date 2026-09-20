// API 中转管理 —— 提供商实例卡片网格 + 新增/编辑配置悬浮窗（按类型动态字段、
// 提供商级代理覆盖、保存前测试连接）+ 删除（被路由引用时后端 409 展示原因）。
"use client";

import * as React from "react";
import {
  Activity,
  ArrowLeftRight,
  Building2,
  Check,
  ChevronDown,
  Eye,
  Gift,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  X,
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
import { PROVIDER_TYPE_META, isMaskedValue } from "@/lib/console/format";
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
  opencode: Gift,
  qwenweb: Globe,
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
  token: string;
  cookie: string;
  fingerprintText: string;
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
    token: "",
    cookie: "",
    fingerprintText: "",
    accounts: [],
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formFromProvider(p: ConsoleProvider): ProviderForm {
  const cfg = p.config || {};
  const headers = (cfg.defaultHeaders as Record<string, string> | undefined) || {};
  const fingerprint = cfg.fingerprint;
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
    token: str(cfg.token),
    cookie: str(cfg.cookie),
    fingerprintText: fingerprint && typeof fingerprint === "object" ? JSON.stringify(fingerprint, null, 2) : "",
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
    case "opencode":
      if (f.baseUrl.trim()) config.baseUrl = f.baseUrl.trim();
      break;
    case "qwenweb": {
      config.baseUrl = f.baseUrl.trim();
      if (f.token) config.token = f.token.trim();
      if (f.cookie) config.cookie = f.cookie.trim();
      if (f.fingerprintText.trim()) {
        try {
          config.fingerprint = JSON.parse(f.fingerprintText);
        } catch {
          // 无效 JSON 由前端校验拦住，此处兜底忽略
        }
      }
      break;
    }
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
  const secrets: unknown[] = [f.apiKey, f.token, f.cookie];
  for (const a of f.accounts) secrets.push(a.accessToken, a.refreshToken);
  return secrets.every((v) => isMaskedValue(v));
}

/**
 * v3.8.0：模型健康一览行 —— 对外模型 × 路由候选（failover 顺序）× 24h 健康指标。
 * 成功率三档配色（≥90 emerald / ≥60 amber / <60 red）、耗时 >3s amber、
 * 最后调用复用共享 LastUsedCell；模型名可点击跳转该模型日志。
 */
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
}: {
  onViewLogs?: (providerId: string) => void;
  onViewLogsForModel?: (model: string) => void;
} = {}) {
  const [data, setData] = React.useState<ProvidersData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  // v3.8.0：模型健康一览折叠态（默认展开；用户手折后 session 内保持）
  const [healthOpen, setHealthOpen] = React.useState(true);

  // 卡片级测试结果
  const [cardTest, setCardTest] = React.useState<Record<string, { loading: boolean; result: ProviderTestResult | null; error: string }>>({});

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
  const [fingerprintError, setFingerprintError] = React.useState("");

  // Dialog 内测试连接
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<ProviderTestResult | null>(null);
  const [testError, setTestError] = React.useState("");

  // 删除
  const [delTarget, setDelTarget] = React.useState<ConsoleProvider | null>(null);
  const [delSaving, setDelSaving] = React.useState(false);

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
    setFingerprintError("");
    setTestResult(null);
    setTestError("");
    setDialogOpen(true);
  };

  const openEdit = (p: ConsoleProvider) => {
    setEditing(p);
    setForm(formFromProvider(p));
    setFormError("");
    setFingerprintError("");
    setTestResult(null);
    setTestError("");
    setDialogOpen(true);
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
    setTestResult(null);
    setTestError("");
  };

  const changeType = (t: ProviderType) => {
    setForm((f) => ({
      ...f,
      type: t,
      baseUrl: f.baseUrl ? f.baseUrl : PROVIDER_TYPE_META[t]?.defaultBaseUrl || "",
    }));
    setTestResult(null);
    setTestError("");
  };

  const runDialogTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      let payload: Record<string, unknown>;
      if (editing && allSecretsMasked(form)) {
        // 凭据未改动（掩码）→ 用已保存的 DB 凭据实测
        payload = { providerId: editing.id };
      } else {
        const built = buildPayload(form, !!editing);
        const { config, accounts } = built as { config: Record<string, unknown>; accounts: Array<{ credentials?: Record<string, unknown> }> };
        const credentials =
          form.type === "workbuddy"
            ? accounts[0]?.credentials || {}
            : {
                ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                ...(form.token ? { token: form.token } : {}),
                ...(form.cookie ? { cookie: form.cookie } : {}),
              };
        payload = { type: form.type, config, credentials };
      }
      const r = await apiPost<ProviderTestResult>("/api/console/providers/test", payload);
      setTestResult(r);
    } catch (e) {
      setTestError(errMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setFormError("");
    setFingerprintError("");

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

    let fingerprint: Record<string, unknown> | undefined;
    if (form.type === "qwenweb" && form.fingerprintText.trim()) {
      try {
        fingerprint = JSON.parse(form.fingerprintText) as Record<string, unknown>;
      } catch (e) {
        setFingerprintError(`指纹参数不是合法 JSON：${errMessage(e)}`);
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
      if (fingerprint) payload.config.fingerprint = fingerprint;
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

  const runCardTest = async (p: ConsoleProvider) => {
    setCardTest((s) => ({ ...s, [p.id]: { loading: true, result: null, error: "" } }));
    try {
      const r = await apiPost<ProviderTestResult>("/api/console/providers/test", { providerId: p.id });
      setCardTest((s) => ({ ...s, [p.id]: { loading: false, result: r, error: "" } }));
    } catch (e) {
      setCardTest((s) => ({ ...s, [p.id]: { loading: false, result: null, error: errMessage(e) } }));
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="API 中转管理"
        description={`上游提供商实例（调度按路由候选顺序故障转移）· 共 ${providers.length} 个`}
        actions={
          <>
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
            const t = cardTest[p.id];
            return (
              <div key={p.id} className="flex flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-xs">
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
                    className="mt-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-stone-50 px-2.5 py-1.5 text-left text-[11px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                  >
                    <span className="font-medium text-stone-600">近 24h</span>
                    <span className="tabular-nums">{p.stats24h.requests} 次调用</span>
                    <span
                      className={`font-medium tabular-nums ${
                        p.stats24h.successRate >= 90 ? "text-emerald-600" : p.stats24h.successRate >= 60 ? "text-amber-600" : "text-red-600"
                      }`}
                      title="近 24 小时 2xx/3xx 响应占比"
                    >
                      成功率 {p.stats24h.successRate}%
                    </span>
                    {p.stats24h.avgDurationMs !== null && (
                      <span className={`tabular-nums ${p.stats24h.avgDurationMs > 3000 ? "text-amber-600" : ""}`}>
                        平均 {p.stats24h.avgDurationMs} ms
                      </span>
                    )}
                    <span className="ml-auto hidden items-center gap-0.5 text-stone-400 sm:inline">日志
                      <ArrowLeftRight className="size-3" />
                    </span>
                  </button>
                ) : (
                  <p className="mt-3 text-[11px] text-stone-300">近 24h 无调用记录</p>
                )}

                {/* 测试结果 */}
                {t?.loading && (
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> 正在实测连通性…
                  </p>
                )}
                {t?.error && <p className="mt-3 text-xs text-red-600">{t.error}</p>}
                {t?.result && (
                  <p className={`mt-3 text-xs ${t.result.success ? "text-emerald-700" : "text-red-600"}`}>
                    {t.result.success ? "✓ " : "✗ "}
                    {t.result.message}
                    {typeof t.result.elapsedMs === "number" ? `（${t.result.elapsedMs}ms）` : ""}
                  </p>
                )}

                <div className="mt-auto flex justify-end gap-1 pt-4">
                  <Button variant="outline" size="sm" onClick={() => void runCardTest(p)} disabled={t?.loading}>
                    {t?.loading ? <Loader2 className="animate-spin" /> : <Zap />}
                    测试
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
              按提供商类型渲染字段；凭据显示掩码，未改动将沿用原值；可先「测试连接」再保存。
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

              {form.type === "opencode" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-oc-baseurl">Base URL</Label>
                    <Input id="pv-oc-baseurl" value={form.baseUrl} onChange={(e) => setF({ baseUrl: e.target.value })} placeholder="https://opencode.ai/zen/v1" className="font-mono text-xs" />
                    <p className="text-xs text-muted-foreground">
                      <Gift className="mr-1 inline size-3 text-emerald-600" />
                      免费模型池：-free 后缀模型免凭据直连，模型列表自动同步并做健康追踪
                    </p>
                  </div>
                </div>
              )}

              {form.type === "qwenweb" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-q-baseurl">Base URL</Label>
                    <Input id="pv-q-baseurl" value={form.baseUrl} onChange={(e) => setF({ baseUrl: e.target.value })} placeholder="https://chat.qwen.ai" className="font-mono text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-q-token">Token</Label>
                    <Input id="pv-q-token" value={form.token} onChange={(e) => setF({ token: e.target.value })} placeholder="Web 端 Token" className="font-mono text-xs" autoComplete="off" spellCheck={false} />
                    {form.token.includes("••••") && <p className="text-xs text-muted-foreground">当前为掩码值，保存时沿用原值</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-q-cookie">Cookie</Label>
                    <Textarea id="pv-q-cookie" value={form.cookie} onChange={(e) => setF({ cookie: e.target.value })} placeholder="浏览器 Cookie 字符串（可选）" className="font-mono text-xs" rows={3} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pv-q-fp">指纹参数 JSON（可选）</Label>
                    <Textarea
                      id="pv-q-fp"
                      value={form.fingerprintText}
                      onChange={(e) => {
                        setF({ fingerprintText: e.target.value });
                        setFingerprintError("");
                      }}
                      placeholder='{"userAgent":"…","ssxmod":"…"}'
                      className="min-h-24 font-mono text-xs"
                    />
                    {fingerprintError && <p className="text-xs text-red-600">{fingerprintError}</p>}
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Eye className="size-3" />
                      反爬指纹（LZW / ssxmod / bx-ua）；留空由系统自动生成
                    </p>
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

              {/* 测试连接 */}
              <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-stone-700">连接测试（保存前可测）</span>
                  <Button type="button" variant="outline" size="sm" onClick={runDialogTest} disabled={testing}>
                    {testing ? <Loader2 className="animate-spin" /> : <Zap />}
                    测试连接
                  </Button>
                </div>
                {testError && <p className="text-xs text-red-600">{testError}</p>}
                {testResult && (
                  <div className={`rounded-md px-2.5 py-2 text-xs ${testResult.success ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                    <p className="font-medium">
                      {testResult.success ? "✓ 连接成功" : "✗ 连接失败"}
                      {typeof testResult.elapsedMs === "number" ? ` · ${testResult.elapsedMs}ms` : ""}
                    </p>
                    <p className="mt-0.5 break-all">{testResult.message}</p>
                    {testResult.models && testResult.models.length > 0 && (
                      <p className="mt-1 break-all font-mono text-[10px] opacity-80">{testResult.models.slice(0, 8).join(" · ")}</p>
                    )}
                  </div>
                )}
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
