// 账号管理 —— 按提供商分组的账号列表（启停/编辑/删除/新增）+ 批量导入 + 双模式导出。
// 凭据掩码契约：编辑时显示掩码值，未改动就原样传回，后端自动回填原值。
"use client";

import * as React from "react";
import {
  Check,
  Download,
  FileJson,
  FileUp,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  X,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BalanceTrendBars,
  CooldownDot,
  ClearCooldownButton,
  EmptyState,
  ErrorAlert,
  HealthBadge,
  LastUsedCell,
  LoadingBlock,
  PageHeader,
  TypeBadge,
} from "@/components/console/ui";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, errMessage } from "@/lib/console/api";
import { cooldownRemaining, fmtNum, relativeTime } from "@/lib/console/format";
import type { AccountsData, BalanceHistoryData, ConsoleAccount, ImportResult } from "@/lib/console/types";
import { Wallet } from "lucide-react";

/** v3.1.0：per-provider 余额徽标数据（来自 GET /api/console/accounts/balance） */
interface ProviderBalanceInfo {
  providerId: string;
  success: boolean;
  balance: number;
  total: number;
  unit: string;
  accountsCount: number;
  error?: string;
}

type ConflictStrategy = "skip" | "overwrite" | "newid";

/** 各提供商类型的账号凭据字段 */
const CRED_FIELDS: Record<string, Array<{ key: string; label: string; placeholder: string; textarea?: boolean }>> = {
  workbuddy: [
    { key: "userId", label: "User ID", placeholder: "WorkBuddy 用户 ID" },
    { key: "accessToken", label: "Access Token", placeholder: "访问令牌（较长字符串）" },
    { key: "refreshToken", label: "Refresh Token", placeholder: "刷新令牌（可选）" },
  ],
  openai: [{ key: "apiKey", label: "API Key", placeholder: "sk-…" }],
  anthropic: [{ key: "apiKey", label: "API Key", placeholder: "sk-ant-…" }],
  qwenweb: [
    { key: "token", label: "Token", placeholder: "Web 端 Token" },
    { key: "cookie", label: "Cookie", placeholder: "浏览器 Cookie 字符串（可选）", textarea: true },
  ],
  opencode: [],
};

function credFieldsFor(type: string) {
  return CRED_FIELDS[type] ?? [];
}

/**
 * v3.1.0：提供商分组余额徽标。
 * - 数据来自 GET /api/console/accounts/balance（fleet 60s 短缓存 + 账号级快照落库）
 * - 点击刷新按钮穿透缓存实测；加载中转圈；失败降级灰态并提示原因（Tooltip）
 * - INTL 站余额从此可见（清偿 Task 16 遗留 #1：/v1/usage 只聚合 usage_provider_id）
 */
function BalanceBadge({
  info,
  loading,
  unitHint,
  onRefresh,
}: {
  info?: ProviderBalanceInfo;
  loading: boolean;
  unitHint?: string;
  onRefresh: () => void;
}) {
  const hasData = !!info;
  const ok = info?.success && typeof info?.balance === "number";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors ${
        !hasData
          ? "border-stone-200 bg-stone-50 text-stone-400"
          : ok
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-amber-200 bg-amber-50 text-amber-700"
      }`}
      title={unitHint}
    >
      <Wallet className="size-3.5" aria-hidden />
      {!hasData ? (
        <span>余额 —</span>
      ) : ok ? (
        <span>
          余额 <span className="font-semibold">{fmtNum(info!.balance)}</span>
          <span className="text-emerald-600/70"> / {fmtNum(info!.total)} {info!.unit}</span>
        </span>
      ) : (
        <span>余额获取失败{info?.error ? ` · ${info.error.slice(0, 40)}` : ""}</span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        aria-label="刷新该提供商余额"
        className="ml-0.5 rounded p-0.5 text-current/70 transition-colors hover:bg-white/60 hover:text-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-50"
      >
        {loading ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <RefreshCw className="size-3" aria-hidden />}
      </button>
    </span>
  );
}

export function AccountsModule({ onViewLogs }: { onViewLogs?: (target: { providerId: string; accountId: string }) => void } = {}) {
  const [data, setData] = React.useState<AccountsData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<AccountsData>("/api/console/accounts");
      setData(d);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // v3.1.0：per-provider 余额徽标（页面加载后静默拉取；单提供商刷新穿透 fleet 缓存）
  const [balances, setBalances] = React.useState<Record<string, ProviderBalanceInfo>>({});
  const [balanceFetchedAt, setBalanceFetchedAt] = React.useState<string>("");
  const [balLoading, setBalLoading] = React.useState<Record<string, boolean>>({});
  // v3.6.0：余额历史快照（14 天；静默拉取失败降级为无趋势列）
  const [balTrend, setBalTrend] = React.useState<BalanceHistoryData | null>(null);
  const balTrendIndex = React.useMemo(() => {
    const m = new Map<string, Array<number | null>>();
    if (!balTrend) return m;
    for (const acc of balTrend.accounts) m.set(`${acc.providerId}/${acc.accountId}`, acc.points);
    return m;
  }, [balTrend]);

  const applyBalances = React.useCallback((providers: ProviderBalanceInfo[]) => {
    setBalances((prev) => {
      const next = { ...prev };
      for (const p of providers) next[p.providerId] = p;
      return next;
    });
  }, []);

  const loadBalances = React.useCallback(async () => {
    try {
      const d = await apiGet<{ providers: ProviderBalanceInfo[]; fetchedAt: string }>("/api/console/accounts/balance");
      applyBalances(d.providers || []);
      if (d.fetchedAt) setBalanceFetchedAt(d.fetchedAt);
    } catch {
      /* 静默失败：余额徽标属锦上添花，不打断账号列表 */
    }
  }, [applyBalances]);

  // v3.6.0：余额历史快照拉取（quiet；刷新余额后重拉让今日柱实时跟随）
  const loadBalTrend = React.useCallback(async () => {
    try {
      const d = await apiGet<BalanceHistoryData>("/api/console/balances/history?days=14", { quiet: true });
      setBalTrend(d);
    } catch {
      /* 静默：趋势列非关键数据 */
    }
  }, []);

  const refreshBalanceFor = React.useCallback(
    async (providerId: string) => {
      setBalLoading((m) => ({ ...m, [providerId]: true }));
      try {
        const d = await apiGet<{ providers: ProviderBalanceInfo[]; fetchedAt: string }>(
          `/api/console/accounts/balance?providerId=${encodeURIComponent(providerId)}&refresh=1`
        );
        applyBalances(d.providers || []);
        if (d.fetchedAt) setBalanceFetchedAt(d.fetchedAt);
        void loadBalTrend(); // 今日快照可能已更新，趋势跟随刷新
      } catch {
        /* 静默 */
      } finally {
        setBalLoading((m) => ({ ...m, [providerId]: false }));
      }
    },
    [applyBalances, loadBalTrend]
  );

  // v3.2.3：批量刷新全部余额（页头按钮）——一次请求穿透 fleet 缓存实测所有
  // workbuddy 家族提供商，全部徽标同步转圈，成功后统一更新 + notice 反馈。
  const [refreshingAll, setRefreshingAll] = React.useState(false);
  const hasBalanceTargets = (data?.grouped ?? []).some((g) => g.provider.type === "workbuddy" && g.accounts.length > 0);
  const refreshAllBalances = React.useCallback(async () => {
    const wbIds = (data?.grouped ?? [])
      .filter((g) => g.provider.type === "workbuddy" && g.accounts.length > 0)
      .map((g) => g.provider.id);
    if (wbIds.length === 0) return;
    setRefreshingAll(true);
    setBalLoading((m) => {
      const next = { ...m };
      for (const id of wbIds) next[id] = true;
      return next;
    });
    try {
      const d = await apiGet<{ providers: ProviderBalanceInfo[]; fetchedAt: string }>(
        "/api/console/accounts/balance?refresh=1"
      );
      applyBalances(d.providers || []);
      if (d.fetchedAt) setBalanceFetchedAt(d.fetchedAt);
      setNotice(`已刷新 ${d.providers?.length ?? 0} 个提供商的全部账号余额`);
      void loadBalTrend(); // 今日快照可能已更新，趋势跟随刷新
    } catch {
      /* 静默：余额徽标属锦上添花，不打断账号列表 */
    } finally {
      setRefreshingAll(false);
      setBalLoading((m) => {
        const next = { ...m };
        for (const id of wbIds) next[id] = false;
        return next;
      });
    }
  }, [applyBalances, data, loadBalTrend]);

  React.useEffect(() => {
    void load();
    void loadBalances();
    void loadBalTrend();
  }, [load, loadBalances, loadBalTrend]);

  // 新增账号 Dialog
  const [addFor, setAddFor] = React.useState<{ id: string; name: string; type: string } | null>(null);
  const [addForm, setAddForm] = React.useState<{ id: string; name: string; creds: Record<string, string> }>({ id: "", name: "", creds: {} });
  const [addSaving, setAddSaving] = React.useState(false);
  const [addError, setAddError] = React.useState("");

  // 编辑账号 Dialog
  const [editAcc, setEditAcc] = React.useState<ConsoleAccount | null>(null);
  const [editForm, setEditForm] = React.useState<{ name: string; creds: Record<string, string> }>({ name: "", creds: {} });
  const [editSaving, setEditSaving] = React.useState(false);
  const [editError, setEditError] = React.useState("");

  // 删除确认
  const [delAcc, setDelAcc] = React.useState<ConsoleAccount | null>(null);
  const [delSaving, setDelSaving] = React.useState(false);

  // 导入 Dialog
  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState("");
  const [importConflict, setImportConflict] = React.useState<ConflictStrategy>("skip");
  const [importTarget, setImportTarget] = React.useState("");
  const [importResult, setImportResult] = React.useState<ImportResult | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState("");

  // 完整导出二次确认
  const [fullExportOpen, setFullExportOpen] = React.useState(false);

  const openAdd = (provider: { id: string; name: string; type: string }) => {
    setAddFor(provider);
    setAddForm({ id: "", name: "", creds: {} });
    setAddError("");
  };

  const saveAdd = async () => {
    if (!addFor) return;
    setAddSaving(true);
    setAddError("");
    try {
      const creds: Record<string, string> = {};
      for (const f of credFieldsFor(addFor.type)) {
        const v = (addForm.creds[f.key] || "").trim();
        if (v) creds[f.key] = v;
      }
      if (Object.keys(creds).length === 0) {
        setAddError("请至少填写一个凭据字段");
        setAddSaving(false);
        return;
      }
      await apiPost("/api/console/accounts", {
        providerId: addFor.id,
        id: addForm.id.trim() || undefined,
        name: addForm.name.trim() || undefined,
        credentials: creds,
      });
      setAddFor(null);
      setNotice("账号已添加");
      await load();
    } catch (e) {
      setAddError(errMessage(e));
    } finally {
      setAddSaving(false);
    }
  };

  const openEdit = (acc: ConsoleAccount) => {
    setEditAcc(acc);
    const creds: Record<string, string> = {};
    const fields = credFieldsFor(
      data?.grouped.find((g) => g.provider.id === acc.providerId)?.provider.type || ""
    );
    for (const f of fields) {
      const v = acc.credentials[f.key];
      creds[f.key] = typeof v === "string" ? v : "";
    }
    setEditForm({ name: acc.name, creds });
    setEditError("");
  };

  const saveEdit = async () => {
    if (!editAcc) return;
    setEditSaving(true);
    setEditError("");
    try {
      await apiPut("/api/console/accounts", {
        providerId: editAcc.providerId,
        id: editAcc.id,
        name: editForm.name.trim() || editAcc.name,
        enabled: editAcc.enabled,
        credentials: editForm.creds, // 掩码值原样传回，后端回填
      });
      setEditAcc(null);
      setNotice("账号已更新（未改动的凭据保持原值）");
      await load();
    } catch (e) {
      setEditError(errMessage(e));
    } finally {
      setEditSaving(false);
    }
  };

  const toggleEnabled = async (acc: ConsoleAccount, enabled: boolean) => {
    // 乐观更新
    setData((d) =>
      d
        ? {
            ...d,
            grouped: d.grouped.map((g) => ({
              ...g,
              accounts: g.accounts.map((a) => (a.id === acc.id && a.providerId === acc.providerId ? { ...a, enabled } : a)),
            })),
            enabled: d.grouped.reduce(
              (n, g) =>
                n +
                g.accounts.filter((a) =>
                  a.providerId === acc.providerId && a.id === acc.id ? enabled : a.enabled
                ).length,
              0
            ),
          }
        : d
    );
    try {
      await apiPatch("/api/console/accounts", { providerId: acc.providerId, id: acc.id, enabled });
    } catch (e) {
      setError(errMessage(e));
      await load();
    }
  };

  const confirmDelete = async () => {
    if (!delAcc) return;
    setDelSaving(true);
    try {
      await apiDelete(`/api/console/accounts?providerId=${encodeURIComponent(delAcc.providerId)}&id=${encodeURIComponent(delAcc.id)}`);
      setDelAcc(null);
      setNotice("账号已删除");
      await load();
    } catch (e) {
      setError(errMessage(e));
      setDelAcc(null);
    } finally {
      setDelSaving(false);
    }
  };

  const onFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ""));
    };
    reader.readAsText(file);
  };

  const runImport = async () => {
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const r = await apiPost<ImportResult>("/api/console/accounts/import", {
        text: importText,
        conflict: importConflict,
        targetProviderId: importTarget || undefined,
      });
      setImportResult(r);
      await load();
    } catch (e) {
      setImportError(errMessage(e));
    } finally {
      setImporting(false);
    }
  };

  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const providers = data?.grouped.map((g) => g.provider) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="账号管理"
        description={`按提供商分组管理上游账号 · 共 ${data?.total ?? 0} 个（启用 ${data?.enabled ?? 0}）`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
            </Button>
            {/* v3.2.3：批量刷新全部余额（仅当存在可查余额的提供商时展示） */}
            {hasBalanceTargets && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshAllBalances()}
                disabled={refreshingAll}
                title="穿透缓存实测所有 workbuddy 家族提供商的全部账号余额（一次请求并行查询）"
              >
                <Wallet className={refreshingAll ? "animate-pulse" : undefined} />
                刷新全部余额
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => { setImportOpen(true); setImportResult(null); setImportError(""); }}>
              <Upload />
              批量导入
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="bg-stone-900 hover:bg-stone-800">
                  <Download />
                  导出
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>导出账号数据</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setFullExportOpen(true)} className="text-amber-700">
                  <FileJson />
                  完整导出（含凭据）
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.open("/api/console/accounts/export?mode=redacted", "_blank")}>
                  <FileJson />
                  脱敏导出（凭据移除）
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
      ) : !data || data.grouped.length === 0 ? (
        <EmptyState
          icon={<Users className="size-6" />}
          title="尚无提供商与账号"
          description="先在「API 中转管理」中添加提供商，再回到此处添加账号；或使用「批量导入」一次导入全部账号。"
        />
      ) : (
        <div className="space-y-4">
          {data.grouped.map((g) => (
            <section key={g.provider.id} className="overflow-hidden rounded-xl border border-stone-200 bg-white">
              <header className="flex flex-wrap items-center gap-2 border-b border-stone-100 bg-stone-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold text-stone-800">{g.provider.name}</h2>
                <code className="rounded bg-white px-1.5 py-0.5 text-[11px] text-stone-500">{g.provider.id}</code>
                <TypeBadge type={g.provider.type} />
                <Badge variant="secondary" className="text-[11px]">
                  {g.accounts.length} 个账号
                </Badge>
                {/* v3.1.0：per-provider 余额徽标（workbuddy 家族）+ 独立刷新（穿透 fleet 60s 缓存） */}
                {g.provider.type === "workbuddy" && g.accounts.length > 0 && (
                  <BalanceBadge
                    info={balances[g.provider.id]}
                    loading={!!balLoading[g.provider.id]}
                    unitHint={g.provider.id === "workbuddy-intl" ? "积分（INTL 站独立计量）" : undefined}
                    onRefresh={() => void refreshBalanceFor(g.provider.id)}
                  />
                )}
                <div className="ml-auto">
                  <Button variant="outline" size="sm" onClick={() => openAdd(g.provider)}>
                    <Plus />
                    新增账号
                  </Button>
                </div>
              </header>

              {g.accounts.length === 0 ? (
                <div className="px-4 py-6">
                  <EmptyState
                    icon={<Users className="size-5" />}
                    title="该提供商暂无账号"
                    description={g.provider.type === "opencode" ? "OpenCode Zen 免费层无需账号凭据，可直接使用。" : "点击右上角「新增账号」添加，或使用批量导入。"}
                    className="py-8"
                  />
                </div>
              ) : (
                <TooltipProvider delayDuration={150}>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>账号</TableHead>
                        <TableHead>启用</TableHead>
                        <TableHead className="hidden md:table-cell">凭据</TableHead>
                        <TableHead className="hidden sm:table-cell">余额</TableHead>
                        <TableHead className="hidden xl:table-cell">健康面板</TableHead>
                        {/* v3.8.0：最后调用（与密钥页「最后使用」同款三色活跃点） */}
                        <TableHead className="hidden lg:table-cell">最后调用</TableHead>
                        <TableHead className="hidden lg:table-cell">签到</TableHead>
                        <TableHead className="hidden lg:table-cell">刷新</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.accounts.map((a) => {
                        const bal = a.balance as { balance?: number } | null;
                        const cd = cooldownRemaining(a.cooldownUntil);
                        const maskedSummary = Object.entries(a.credentials || {})
                          .filter(([, v]) => v && String(v).length > 0)
                          .slice(0, 2)
                          .map(([k, v]) => `${k}: ${String(v).slice(0, 16)}`)
                          .join(" · ");
                        return (
                          // v3.0.7：组合键防跨提供商同名账号（如多个 default）React key 冲突
                          <TableRow key={`${g.provider.id}/${a.id}`}>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-medium text-stone-800">{a.name}</span>
                                <span className="flex items-center gap-2">
                                  <code className="text-[11px] text-stone-400">{a.id}</code>
                                  <CooldownDot remaining={cd} streak={a.cooldownStreak} reason={a.cooldownReason} />
                                  {/* v3.4.0：冷却中账号一键清除（复用共享组件；操作后 notice 反馈 + 刷新列表） */}
                                  {cd && (
                                    <ClearCooldownButton
                                      providerId={g.provider.id}
                                      accountId={a.id}
                                      accountName={a.name}
                                      onCleared={(message) => {
                                        setNotice(message);
                                        void load();
                                      }}
                                    />
                                  )}
                                </span>
                                {/* v3.9.0：移动端露出最后调用（桌面列在 lg+ 展示，移动端无表列可用，
                                    收进账号名下方摘要行；与桌面同源数据同款组件） */}
                                <span className="lg:hidden">
                                  <LastUsedCell at={a.lastUsedAt} noun="命中" emptyTitle="请求日志滚动窗口内无该账号的调用记录（语义为近期未命中该账号）" />
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Switch
                                checked={a.enabled}
                                onCheckedChange={(v) => void toggleEnabled(a, v)}
                                aria-label={`启用账号 ${a.name}`}
                              />
                            </TableCell>
                            <TableCell className="hidden max-w-56 truncate font-mono text-[11px] text-stone-500 md:table-cell">
                              {maskedSummary || "—"}
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">
                              <div className="flex flex-col gap-1">
                                <span className="tabular-nums">
                                  {bal && typeof bal.balance === "number" ? fmtNum(bal.balance) : "—"}
                                </span>
                                {/* v3.6.0：账号余额趋势（14 天水位，仅有权重快照的账号渲染；xl 以下隐藏避免挢表） */}
                                {balTrendIndex.get(`${g.provider.id}/${a.id}`) && (
                                  <BalanceTrendBars
                                    days={balTrend!.days}
                                    points={balTrendIndex.get(`${g.provider.id}/${a.id}`)!}
                                    className="w-24"
                                    ariaLabel={`账号 ${a.name} 近 14 天余额趋势`}
                                  />
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="hidden xl:table-cell">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <HealthBadge
                                    stats24h={a.stats24h}
                                    todayTokens={null}
                                    onClick={onViewLogs ? () => onViewLogs({ providerId: g.provider.id, accountId: a.id }) : undefined}
                                    ariaLabel={`查看账号 ${a.name} 近 24h 请求日志`}
                                    tooltipTitle={`近 24 小时命中该账号的请求：${a.stats24h?.requests ?? 0} 次，成功率 ${a.stats24h?.successRate ?? 0}%`}
                                  />
                                </TooltipTrigger>
                                {(a.stats24h?.requests ?? 0) > 0 && (
                                  <TooltipContent>
                                    近 24 小时命中该账号的请求：{a.stats24h!.requests} 次，成功率 {a.stats24h!.successRate}%，失败 {a.stats24h?.failures ?? 0} 次
                                    {onViewLogs ? " · 点击查看该账号的请求日志 →" : ""}
                                  </TooltipContent>
                                )}
                              </Tooltip>
                            </TableCell>
                            {/* v3.8.0：最后调用（与密钥页同款共享组件；账号维度滚动窗口 MAX(createdAt)） */}
                            <TableCell className="hidden lg:table-cell">
                              <LastUsedCell at={a.lastUsedAt} noun="命中" emptyTitle="请求日志滚动窗口内无该账号的调用记录（语义为近期未命中该账号）" />
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
                              {a.lastCheckinAt ? (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                  {a.lastCheckinOk === true ? <Check className="size-3.5 text-emerald-600" /> : a.lastCheckinOk === false ? <X className="size-3.5 text-red-500" /> : null}
                                  {relativeTime(a.lastCheckinAt)}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">未签到</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                              {a.lastRefreshAt ? relativeTime(a.lastRefreshAt) : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button variant="ghost" size="icon" onClick={() => openEdit(a)} aria-label="编辑账号">
                                  <Pencil className="text-stone-500" />
                                </Button>
                                <Button variant="ghost" size="icon" onClick={() => setDelAcc(a)} aria-label="删除账号">
                                  <Trash2 className="text-red-500" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                </TooltipProvider>
              )}
            </section>
          ))}
        </div>
      )}

      {/* ---------- 新增账号 Dialog ---------- */}
      <Dialog open={!!addFor} onOpenChange={(o) => !o && setAddFor(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新增账号 · {addFor?.name}</DialogTitle>
            <DialogDescription>
              {addFor?.type === "opencode"
                ? "OpenCode Zen 免费层无需凭据字段。"
                : "凭据按提供商类型填写；保存后界面仅显示掩码。"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="add-acc-id">账号 ID（可选）</Label>
                <Input id="add-acc-id" value={addForm.id} onChange={(e) => setAddForm((f) => ({ ...f, id: e.target.value }))} placeholder="留空自动生成" className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-acc-name">账号名称（可选）</Label>
                <Input id="add-acc-name" value={addForm.name} onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：主力号 / 备用号" />
              </div>
            </div>
            {credFieldsFor(addFor?.type || "").map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`add-cred-${f.key}`}>{f.label}</Label>
                {f.textarea ? (
                  <Textarea
                    id={`add-cred-${f.key}`}
                    value={addForm.creds[f.key] || ""}
                    onChange={(e) => setAddForm((s) => ({ ...s, creds: { ...s.creds, [f.key]: e.target.value } }))}
                    placeholder={f.placeholder}
                    className="font-mono text-xs"
                    rows={3}
                  />
                ) : (
                  <Input
                    id={`add-cred-${f.key}`}
                    value={addForm.creds[f.key] || ""}
                    onChange={(e) => setAddForm((s) => ({ ...s, creds: { ...s.creds, [f.key]: e.target.value } }))}
                    placeholder={f.placeholder}
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </div>
            ))}
            {addError && <p className="text-sm text-red-600">{addError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddFor(null)} disabled={addSaving}>
              取消
            </Button>
            <Button onClick={saveAdd} disabled={addSaving} className="bg-stone-900 hover:bg-stone-800">
              {addSaving && <Loader2 className="animate-spin" />}
              添加账号
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 编辑账号 Dialog ---------- */}
      <Dialog open={!!editAcc} onOpenChange={(o) => !o && setEditAcc(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑账号 · {editAcc?.name}</DialogTitle>
            <DialogDescription>
              凭据显示为掩码；不做修改则保持原值，输入新值将覆盖。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            <div className="space-y-1.5">
              <Label htmlFor="edit-acc-name">账号名称</Label>
              <Input id="edit-acc-name" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            {(data?.grouped.find((g) => g.provider.id === editAcc?.providerId)?.provider.type === "opencode"
              ? []
              : credFieldsFor(data?.grouped.find((g) => g.provider.id === editAcc?.providerId)?.provider.type || "")
            ).map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`edit-cred-${f.key}`}>{f.label}</Label>
                {f.textarea ? (
                  <Textarea
                    id={`edit-cred-${f.key}`}
                    value={editForm.creds[f.key] || ""}
                    onChange={(e) => setEditForm((s) => ({ ...s, creds: { ...s.creds, [f.key]: e.target.value } }))}
                    placeholder={f.placeholder}
                    className="font-mono text-xs"
                    rows={3}
                  />
                ) : (
                  <Input
                    id={`edit-cred-${f.key}`}
                    value={editForm.creds[f.key] || ""}
                    onChange={(e) => setEditForm((s) => ({ ...s, creds: { ...s.creds, [f.key]: e.target.value } }))}
                    placeholder={f.placeholder}
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                {editForm.creds[f.key] && editForm.creds[f.key].includes("••••") && (
                  <p className="text-xs text-muted-foreground">当前为掩码值，保存时将自动沿用原凭据</p>
                )}
              </div>
            ))}
            {editError && <p className="text-sm text-red-600">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditAcc(null)} disabled={editSaving}>
              取消
            </Button>
            <Button onClick={saveEdit} disabled={editSaving} className="bg-stone-900 hover:bg-stone-800">
              {editSaving && <Loader2 className="animate-spin" />}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 删除确认 ---------- */}
      <AlertDialog open={!!delAcc} onOpenChange={(o) => !o && setDelAcc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除账号「{delAcc?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              该操作不可撤销，账号凭据与冷却状态将一并删除。若该账号正在被路由使用，相关请求会自动切换到其他候选。
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

      {/* ---------- 批量导入 Dialog ---------- */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>批量导入账号</DialogTitle>
            <DialogDescription>
              支持完整导出的 JSON 闭环导入（uag-export-v1 或 providers 数组）、WorkBuddy 账号切换器导出（wb-switch-accounts，自动按域名分组为 CN / INTL 账号池），或 workbuddy 凭据四列 CSV（name,userId,accessToken,refreshToken）。脱敏导出会被系统拒绝。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            <Tabs defaultValue="paste">
              <TabsList>
                <TabsTrigger value="paste">粘贴文本</TabsTrigger>
                <TabsTrigger value="upload">上传文件</TabsTrigger>
              </TabsList>
              <TabsContent value="paste" className="space-y-2 pt-2">
                <Textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder='粘贴 JSON 或 CSV 全文…&#10;{"format":"uag-export-v1","providers":[…]}&#10;或 wb-switch-accounts 导出全文（自动识别分组）&#10;或 name,userId,accessToken,refreshToken'
                  className="min-h-40 font-mono text-xs"
                />
              </TabsContent>
              <TabsContent value="upload" className="space-y-2 pt-2">
                <label
                  className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-stone-300 bg-stone-50/60 px-4 py-8 text-center hover:border-emerald-400 hover:bg-emerald-50/40"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    onFile(e.dataTransfer.files?.[0] ?? null);
                  }}
                >
                  <FileUp className="size-8 text-stone-400" />
                  <span className="text-sm font-medium text-stone-700">点击选择或拖入文件</span>
                  <span className="text-xs text-muted-foreground">支持 .json / .csv / .txt</span>
                  <input
                    type="file"
                    accept=".json,.csv,.txt"
                    className="sr-only"
                    onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {importText && (
                  <Textarea
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    className="min-h-40 font-mono text-xs"
                  />
                )}
              </TabsContent>
            </Tabs>

            <div className="space-y-1.5">
              <Label>冲突策略（账号已存在时）</Label>
              <RadioGroup value={importConflict} onValueChange={(v) => setImportConflict(v as ConflictStrategy)} className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="skip" id="conf-skip" />
                  <Label htmlFor="conf-skip" className="font-normal">跳过</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="overwrite" id="conf-ow" />
                  <Label htmlFor="conf-ow" className="font-normal">覆盖更新（空字段保留原值）</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="newid" id="conf-newid" />
                  <Label htmlFor="conf-newid" className="font-normal">生成新 ID 追加</Label>
                </div>
              </RadioGroup>
            </div>

            <div className="space-y-1.5">
              <Label>CSV 目标提供商（CSV 导入时必选）</Label>
              <Select value={importTarget || undefined} onValueChange={setImportTarget}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择目标提供商（JSON 导入无需选择）" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}（{p.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {importError && <p className="text-sm text-red-600">{importError}</p>}

            {importResult && (
              <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">成功 {importResult.success}</Badge>
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">跳过 {importResult.skipped}</Badge>
                  <Badge variant="destructive">失败 {importResult.failed}</Badge>
                  {importResult.format === "wb-switch-accounts" && (
                    <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-700">wb-switch 格式已自动分组</Badge>
                  )}
                </div>
                {importResult.formatNote && (
                  <p className="rounded border border-teal-100 bg-teal-50/70 px-2 py-1.5 text-xs leading-relaxed text-teal-800">
                    {importResult.formatNote}
                  </p>
                )}
                {importResult.details.length > 0 && (
                  <div className="max-h-56 overflow-y-auto rounded border border-stone-200 bg-white">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">#</TableHead>
                          <TableHead className="w-20">状态</TableHead>
                          <TableHead>提供商 / 账号</TableHead>
                          <TableHead>原因</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {importResult.details.map((d, i) => (
                          <TableRow key={i}>
                            <TableCell className="tabular-nums text-stone-400">{d.index}</TableCell>
                            <TableCell>
                              {d.status === "success" && <Badge className="bg-emerald-100 text-emerald-700">成功</Badge>}
                              {d.status === "skipped" && <Badge className="bg-amber-100 text-amber-700">跳过</Badge>}
                              {d.status === "failed" && <Badge className="bg-red-100 text-red-700">失败</Badge>}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {d.providerId || "—"}
                              {d.accountId ? ` / ${d.accountId}` : ""}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{d.reason || "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              关闭
            </Button>
            <Button onClick={runImport} disabled={importing || !importText.trim()} className="bg-stone-900 hover:bg-stone-800">
              {importing ? <Loader2 className="animate-spin" /> : <Upload />}
              开始导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 完整导出二次确认 ---------- */}
      <AlertDialog open={fullExportOpen} onOpenChange={setFullExportOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>完整导出包含全部凭据明文</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  导出文件包含所有上游账号的访问令牌 / API Key 等敏感凭据。文件一旦泄露，等同交出全部上游账号。
                </p>
                <ul className="list-disc pl-4 text-sm">
                  <li>仅建议在本地备份 / 迁移时使用完整导出</li>
                  <li>分享给他人请使用「脱敏导出」</li>
                  <li>完整导出可再次导入形成闭环（脱敏导出会被系统拒绝导入）</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => window.open("/api/console/accounts/export?mode=full", "_blank")}
              className="bg-amber-600 hover:bg-amber-700"
            >
              <Download />
              我已知晓风险，导出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {data && data.total > 0 && (
        <p className="text-xs text-muted-foreground">
          提示：列表中的凭据均为掩码显示；编辑时保持掩码值不变即可沿用原凭据。
        </p>
      )}
    </div>
  );
}
