// 定时任务 —— 每日签到 & Token 保活：开关 / cron / 时区（热生效）、立即执行（逐账号明细）、最近执行历史。
// v4.1.0：每日签到卡新增「签到提供商」多选下拉（空选 = 全部支持签到的提供商；保存后热生效）。
// v4.1.1：立即执行签到直传当前下拉选择（无需先保存）；结果卡显示本次执行范围；定时调度仍按已保存配置。
// v4.2.0：新增「成长中心」卡（分组勾选 + 账号选择 + 立即执行 SSE 实时日志 + 日志保留期）。
"use client";

import * as React from "react";
import {
  CalendarCheck,
  Check,
  ChevronsUpDown,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  EmptyState,
  ErrorAlert,
  LoadingBlock,
  PageHeader,
} from "@/components/console/ui";
import { apiGet, apiPost, apiPut, authHeaders, errMessage } from "@/lib/console/api";
import { COMMON_TIMEZONES, CRON_PRESETS, relativeTime } from "@/lib/console/format";
import { cn } from "@/lib/utils";
import type { CheckinCandidate, JobRunResult, JobsConfig, JobsData } from "@/lib/console/types";

interface RunDetailRow {
  label: string;
  ok: boolean;
  extra?: string;
}

/** 任意值安全归一为可渲染字符串（防 Json 对象直接成为 React child 导致整页崩溃） */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 把 runJob 返回的 detail 归一为可展示行 */
function normalizeRunDetail(job: string, detail: unknown): RunDetailRow[] {
  // error 字段可能是对象（上游业务包）——先归一为字符串，防对象成为 React child
  const errText = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  if (job === "checkin" && Array.isArray(detail)) {
    return (detail as Array<{ provider?: string; res?: unknown; error?: unknown }>).map((d) => {
      const resText =
        d.res && typeof d.res === "object"
          ? (() => {
              try {
                const s = JSON.stringify(d.res);
                return s.length > 160 ? `${s.slice(0, 160)}…` : s;
              } catch {
                return String(d.res);
              }
            })()
          : d.res !== undefined
            ? String(d.res)
            : "";
      return {
        label: d.provider || "—",
        ok: !d.error,
        extra: errText(d.error) || resText || "完成",
      };
    });
  }
  if (job === "keepalive" && detail && typeof detail === "object" && "refresh" in (detail as Record<string, unknown>)) {
    const refresh = (detail as { refresh?: Array<{ provider?: string; refreshed?: boolean; count?: number; error?: unknown }> }).refresh || [];
    return refresh.map((r) => ({
      label: r.provider || "—",
      ok: !!r.refreshed,
      extra: errText(r.error) ? `失败：${errText(r.error)}` : r.refreshed ? `已刷新${r.count ? `（${r.count} 个账号）` : ""}` : "无需刷新",
    }));
  }
  if (detail && typeof detail === "object" && "error" in (detail as Record<string, unknown>)) {
    return [{ label: "执行失败", ok: false, extra: errText((detail as { error?: unknown }).error) }];
  }
  return [];
}

/**
 * v3.8.0：节奏色块条原子组件（v3.7.0 RunRhythm 拆分复用）—— 最近 N 次运行的时序色块（左旧右新）。
 * 成功=emerald / 失败=red；悬停 title 查看单次明细（job/触发/时间/状态）。
 * 空列表返回 null（调用方决定是否渲染空态文案）。
 */
function RhythmBars({ runs, ariaLabelPrefix = "任务" }: { runs: JobsData["recentRuns"]; ariaLabelPrefix?: string }) {
  if (runs.length === 0) return null;
  const chrono = [...runs].reverse(); // API 返回 newest-first，节奏图需要时间轴从左到右
  const okCount = chrono.filter((r) => r.success).length;
  const failCount = chrono.length - okCount;
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex items-end gap-[3px]" role="img" aria-label={`${ariaLabelPrefix}最近 ${chrono.length} 次执行节奏：成功 ${okCount} 次，失败 ${failCount} 次`}>
        {chrono.map((r, i) => (
          <span
            key={i}
            className={cn(
              "block w-2 rounded-[3px] transition-colors",
              r.success ? "h-4 bg-emerald-400/80 hover:bg-emerald-500" : "h-5 bg-red-400/90 hover:bg-red-500"
            )}
            title={`${r.job === "checkin" ? "每日签到" : "Token 保活"} · ${r.triggered === "cron" ? "定时触发" : r.triggered === "cron-catchup" ? "错失补跑" : "手动执行"} · ${relativeTime(r.startedAt)} · ${r.success ? "成功" : "失败"}`}
          />
        ))}
      </div>
      <span className="hidden text-[11px] tabular-nums text-muted-foreground md:inline">
        成功 {okCount}
        {failCount > 0 ? <span className="text-red-500"> · 失败 {failCount}</span> : ""}
      </span>
    </div>
  );
}

/**
 * v3.8.0：per-job 独立节奏条 —— 两张任务卡各自渲染本任务的执行节奏（不再混在总历史里看不清）。
 * 卡内小尺寸变体：色块略窄（w-1.5），附带「最近 N 次」说明；无记录时显示淡态提示。
 */
function JobRhythmStrip({ runs }: { runs: JobsData["recentRuns"] }) {
  if (runs.length === 0) {
    return <p className="text-[11px] text-stone-300">本任务暂无执行记录（按 cron 触发或手动执行后生成）</p>;
  }
  const chrono = [...runs].reverse();
  const okCount = chrono.filter((r) => r.success).length;
  const failCount = chrono.length - okCount;
  return (
    <div className="flex flex-wrap items-center gap-2" role="img" aria-label={`本任务最近 ${chrono.length} 次执行节奏：成功 ${okCount} 次，失败 ${failCount} 次`}>
      <div className="flex items-end gap-[2px]">
        {chrono.map((r, i) => (
          <span
            key={i}
            className={cn(
              "block w-1.5 rounded-[2px] transition-colors",
              r.success ? "h-3.5 bg-emerald-400/80 hover:bg-emerald-500" : "h-4.5 bg-red-400/90 hover:bg-red-500"
            )}
            title={`${r.triggered === "cron" ? "定时触发" : r.triggered === "cron-catchup" ? "错失补跑" : "手动执行"} · ${relativeTime(r.startedAt)} · ${r.success ? "成功" : "失败"}`}
          />
        ))}
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground">
        最近 {chrono.length} 次：成功 {okCount}
        {failCount > 0 ? <span className="font-medium text-red-500"> · 失败 {failCount}</span> : ""}
      </span>
    </div>
  );
}

/**
 * v3.7.0：JobRun 执行节奏图（最近执行历史卡头，混合两任务时序）—— v3.8.0 改为复用 RhythmBars。
 */
function RunRhythm({ runs }: { runs: JobsData["recentRuns"] }) {
  return <RhythmBars runs={runs} ariaLabelPrefix="任务" />;
}

function CronField({
  id,
  label,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * *"
        className="font-mono text-xs"
        aria-invalid={!!error}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            aria-label={`${p.label}（cron: ${p.value}）`}
            title={`${p.label}（cron: ${p.value}）`}
            className={`rounded-md border px-1.5 py-0.5 text-[11px] transition-colors ${
              value === p.value
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : "border-stone-200 bg-stone-50 text-stone-500 hover:border-stone-300 hover:text-stone-700"
            }`}
          >
            {p.label}
            <code className="ml-1 font-mono opacity-60">{p.value}</code>
          </button>
        ))}
      </div>
    </div>
  );
}

function TzField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const zones = value && !COMMON_TIMEZONES.includes(value) ? [value, ...COMMON_TIMEZONES] : COMMON_TIMEZONES;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {zones.map((tz) => (
            <SelectItem key={tz} value={tz}>
              {tz}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * v4.1.0：签到提供商多选下拉（DropdownMenu + CheckboxItem）。
 * 空选 = 全部支持签到的提供商（后端 checkinProviders 空数组语义）。勾选后立即自动保存当前选择。
 * 勾选后菜单不自动关闭（onSelect preventDefault），支持连续勾选。
 */
function CheckinProviderPicker({
  candidates,
  selected,
  onChange,
}: {
  candidates: CheckinCandidate[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const triggerLabel =
    selected.length === 0
      ? "全部支持签到的提供商"
      : selected.length === 1
        ? candidates.find((c) => c.id === selected[0])?.name || selected[0]
        : `已选 ${selected.length} 个提供商`;
  const toggle = (id: string, checked: boolean) => {
    onChange(checked ? [...selected, id] : selected.filter((x) => x !== id));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 w-full justify-between font-normal">
          <span className="truncate text-sm">{triggerLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">需要签到的提供商</DropdownMenuLabel>
        {candidates.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            当前没有支持签到的启用提供商（签到能力类型：workbuddy）。先在「提供商」页添加。
          </p>
        ) : (
          candidates.map((c) => (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={selected.includes(c.id)}
              onCheckedChange={(v) => toggle(c.id, v === true)}
              onSelect={(e) => e.preventDefault()}
              className="gap-2"
            >
              <span className="truncate">{c.name}</span>
              <span className="ml-auto font-mono text-[10px] text-stone-400">{c.id}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
        {selected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onChange([]);
              }}
              className="text-xs text-muted-foreground"
            >
              清空选择（恢复全部提供商签到）
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------- 成长中心（v4.2.0）----------

/** 分组 id（与后端 GrowthGroup 保持一致） */
type GrowthGroupId = "growth" | "school" | "miniprogram" | "play";

/** GET /api/console/growth 的分组项 */
interface GrowthGroupInfo {
  id: GrowthGroupId;
  label: string;
  total: number;
}

/** GET /api/console/growth 的账号项（已完成进度由 completedCount/totalCount 展示） */
interface GrowthAccountInfo {
  id: string;
  name: string;
  status: "idle" | "running" | "done" | string;
  completedCount: number;
  totalCount: number;
}

interface GrowthOverview {
  groups: GrowthGroupInfo[];
  accounts: GrowthAccountInfo[];
}

/** 日志级别（后端 GrowthRunEvent.level；info/ok/warn/error） */
type GrowthLogLevel = "info" | "ok" | "warn" | "error";

/** 日志框内的一行（历史行与流式行统一结构） */
interface GrowthLogLine {
  key: string;
  level: GrowthLogLevel;
  message: string;
  time?: string;
}

/** GET /api/console/growth/logs 响应 */
interface GrowthLogsData {
  logs: { id: number; level: string; message: string; createdAt: string }[];
  retentionDays: number;
}

/** SSE 单条 GrowthRunEvent（宽松解析：字段可能缺失） */
interface GrowthRunEventPayload {
  level?: string;
  message?: string;
  done?: boolean;
  id?: number;
  createdAt?: string;
}

const GROWTH_GROUP_LABELS: { id: GrowthGroupId; label: string }[] = [
  { id: "growth", label: "成长中心任务" },
  { id: "school", label: "开学季活动" },
  { id: "miniprogram", label: "小程序任务" },
  { id: "play", label: "互动玩法" },
];

/** 归一后端返回值：只接受四个已知级别，其余按 info 处理 */
function normalizeGrowthLevel(level: unknown): GrowthLogLevel {
  return level === "ok" || level === "warn" || level === "error" ? level : "info";
}

const GROWTH_LEVEL_CLASS: Record<GrowthLogLevel, string> = {
  info: "text-stone-600",
  ok: "text-teal-600",
  warn: "text-amber-600",
  error: "text-red-600",
};

const GROWTH_RETENTION_OPTIONS = [7, 30, 90];

/**
 * 成长中心卡：分组勾选 + 账号选择 + 立即执行（SSE 实时日志）+ 日志保留期。
 * 仅「成长中心任务」默认勾选；已完成账号打 Badge 防重复执行；运行中禁止再次触发（后端为全局锁）。
 */
function GrowthCard({ fmtTime }: { fmtTime: (v: string) => string }) {
  const [overview, setOverview] = React.useState<GrowthOverview | null>(null);
  const [groups, setGroups] = React.useState<GrowthGroupId[]>(["growth"]);
  const [accountId, setAccountId] = React.useState("");
  const [lines, setLines] = React.useState<GrowthLogLine[]>([]);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState("");
  const [retention, setRetention] = React.useState(7);
  const logBoxRef = React.useRef<HTMLDivElement | null>(null);

  /** 加载分组 / 账号；保留已在框内的日志（只刷新状态与进度） */
  const loadOverview = React.useCallback(async () => {
    try {
      const data = await apiGet<GrowthOverview>("/api/console/growth");
      setOverview(data);
    } catch (e) {
      setError(errMessage(e));
    }
  }, []);

  /** 历史日志一次性载入（sinceId=0 增量语义：追加而非替换） */
  const loadHistory = React.useCallback(async () => {
    try {
      const data = await apiGet<GrowthLogsData>("/api/console/growth/logs?sinceId=0");
      setRetention(data.retentionDays > 0 ? data.retentionDays : 7);
      const rows = Array.isArray(data.logs) ? data.logs : [];
      setLines(
        rows.map(
          (r): GrowthLogLine => ({
            key: `h-${r.id}`,
            level: normalizeGrowthLevel(r.level),
            message: r.message,
            time: fmtTime(r.createdAt),
          })
        )
      );
    } catch (e) {
      setError(errMessage(e));
    }
  }, [fmtTime]);

  // 挂载：并行拉取概览与历史日志
  React.useEffect(() => {
    void loadOverview();
    void loadHistory();
  }, [loadOverview, loadHistory]);

  // 新日志行到达后滚动到底部
  React.useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const selected = overview?.accounts.find((a) => a.id === accountId) ?? null;
  const done = selected?.status === "done";
  const accountRunning = selected?.status === "running";
  const canRun =
    !!selected && groups.length > 0 && !running && !done && !accountRunning;

  const toggleGroup = (id: GrowthGroupId, checked: boolean) => {
    setGroups((prev) =>
      checked ? Array.from(new Set([...prev, id])) : prev.filter((g) => g !== id)
    );
  };

  /** 保存日志保留期（热生效；与 settings 模块同一 PUT 契约：顶层字段平铺） */
  const saveRetention = async (days: number) => {
    setRetention(days);
    try {
      await apiPut("/api/console/settings", { growthLogRetentionDays: days });
    } catch (e) {
      setError(errMessage(e));
    }
  };

  /** 立即执行：直连 fetch + ReadableStream 解析 SSE（apiPost 不支持流式） */
  const run = async () => {
    if (!canRun || !selected) return;
    setRunning(true);
    setError("");
    setLines((prev) => [
      ...prev,
      { key: `s-start-${Date.now()}`, level: "info", message: `开始执行：${selected.name}` },
    ]);
    try {
      // 双通道会话：Bearer（localStorage 会话令牌）+ Cookie 兜底。
      // 原生 fetch 不带 apiGet 的自动附头，必须显式加 authHeaders + credentials，
      // 否则预览面板（无 Cookie）或 Cookie 不达时会被网关判为未登录。
      const res = await fetch("/api/console/growth/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "same-origin",
        body: JSON.stringify({ accountId: selected.id, groups }),
      });
      if (res.status === 401) {
        throw new Error("控制台会话已过期，请重新登录后再执行");
      }
      if (!res.ok || !res.body) {
        // 非 2xx：尽量读出 { ok, error } 包里的中文错误
        const text = await res.text().catch(() => "");
        let msg = `执行失败（HTTP ${res.status}）`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch {
          // 非 JSON 响应（如 HTML 错误页）——保留状态码提示
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以空行分隔；最后一段可能不完整，留在 buffer 等下一次
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          for (const rawLine of block.split("\n")) {
            const line = rawLine.trim();
            // 心跳/注释行（: ping）与非 data 行直接忽略
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const evt = JSON.parse(payload) as GrowthRunEventPayload;
              if (evt.done) {
                finished = true;
                if (evt.message) {
                  setLines((prev) => [
                    ...prev,
                    {
                      key: `s-done-${Date.now()}`,
                      level: normalizeGrowthLevel(evt.level),
                      message: evt.message ?? "",
                    },
                  ]);
                }
                continue;
              }
              if (!evt.message) continue;
              setLines((prev) => [
                ...prev,
                {
                  key: `s-${evt.id ?? Date.now()}-${prev.length}`,
                  level: normalizeGrowthLevel(evt.level),
                  message: evt.message ?? "",
                },
              ]);
            } catch {
              // 防御：单行 JSON 解析失败不应中断整个流
            }
          }
        }
      }
    } catch (e) {
      const msg = errMessage(e);
      setError(msg);
      setLines((prev) => [
        ...prev,
        { key: `s-err-${Date.now()}`, level: "error", message: msg },
      ]);
    } finally {
      setRunning(false);
      // 执行结束刷新状态/进度（完成账号会变为 done → 按钮改为「已完成」Badge）
      await loadOverview();
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">成长中心</h2>
          <p className="text-xs text-muted-foreground">
            WorkBuddy 国内站任务（分组勾选后立即执行，实时输出日志）
          </p>
        </div>
        {selected && (
          <span className="text-xs text-stone-500">
            已完成 {selected.completedCount}/{selected.totalCount}
          </span>
        )}
      </div>

      {/* 分组勾选：默认仅勾选成长中心任务 */}
      <div className="grid gap-2 sm:grid-cols-2">
        {GROWTH_GROUP_LABELS.map((g) => {
          const total = overview?.groups.find((x) => x.id === g.id)?.total ?? 0;
          const id = `growth-group-${g.id}`;
          return (
            <label
              key={g.id}
              htmlFor={id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700"
            >
              <Checkbox
                id={id}
                checked={groups.includes(g.id)}
                onCheckedChange={(v) => toggleGroup(g.id, v === true)}
              />
              <span className="flex-1">{g.label}</span>
              <Badge variant="secondary" className="text-[10px] font-normal">
                {total}
              </Badge>
            </label>
          );
        })}
      </div>

      {/* 账号选择 + 进度 + 立即执行 */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder="选择账号" />
          </SelectTrigger>
          <SelectContent>
            {(overview?.accounts ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-stone-500">
          {selected ? `已完成 ${selected.completedCount}/${selected.totalCount}` : "—"}
        </span>
        <div className="ml-auto">
          {done ? (
            // 已完成：打标签防重复执行（按钮置灰改为状态徽标）
            <Badge className="bg-teal-50 text-teal-700 hover:bg-teal-50">
              <Check className="size-3" />
              已完成 {selected?.completedCount}/{selected?.totalCount}
            </Badge>
          ) : (
            <Button size="sm" onClick={run} disabled={!canRun}>
              {running ? <Loader2 className="animate-spin" /> : <Play />}
              立即执行
            </Button>
          )}
        </div>
      </div>

      {/* 实时日志（最新在底部，自动滚动） */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-stone-600">实时日志</span>
          <select
            aria-label="日志保留期"
            className="rounded-md border border-stone-200 bg-white px-1.5 py-0.5 text-[11px] text-stone-600"
            value={retention}
            onChange={(e) => void saveRetention(Number(e.target.value))}
          >
            {GROWTH_RETENTION_OPTIONS.map((d) => (
              <option key={d} value={d}>
                保留 {d} 天
              </option>
            ))}
          </select>
        </div>
        <div
          ref={logBoxRef}
          className="max-h-[200px] min-h-24 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-2 font-mono text-xs leading-5"
        >
          {lines.length === 0 ? (
            <p className="text-stone-400">暂无日志</p>
          ) : (
            lines.map((l) => (
              <p key={l.key} className={cn("whitespace-pre-wrap break-all", GROWTH_LEVEL_CLASS[l.level])}>
                {l.time ? <span className="text-stone-400">[{l.time}] </span> : null}
                {l.message}
              </p>
            ))
          )}
        </div>
        {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
      </div>
    </section>
  );
}

export function JobsModule() {
  const [data, setData] = React.useState<JobsData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  const [config, setConfig] = React.useState<JobsConfig | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [configError, setConfigError] = React.useState("");

  const [running, setRunning] = React.useState<string | null>(null);
  const [runResult, setRunResult] = React.useState<{ job: string; rows: RunDetailRow[]; error: string; scope?: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<JobsData>("/api/console/jobs");
      setData(d);
      setConfig(d.config);
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

  const setCfg = (patch: Partial<JobsConfig>) => setConfig((c) => (c ? { ...c, ...patch } : c));

  const autoSaveCheckinProviders = React.useCallback((next: string[]) => {
    setConfig((current) => {
      if (!current) return current;
      const nextConfig = { ...current, checkinProviders: next };
      void apiPut("/api/console/jobs", nextConfig).catch((e) => {
        setConfigError(errMessage(e));
      });
      return nextConfig;
    });
  }, []);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setConfigError("");
    try {
      await apiPut("/api/console/jobs", config);
      setNotice("定时任务配置已保存并热生效（无需重启）");
      await load();
    } catch (e) {
      setConfigError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (job: "checkin" | "keepalive") => {
    setRunning(job);
    setRunResult(null);
    try {
      // v4.1.1：签到直传当前 UI 下拉选择（空数组 = 全部）——所见即所执行，无需先点保存；
      // 定时调度不受影响（仍按保存的配置）。后端对 providers 逐项校验存在性与签到能力。
      const providers = job === "checkin" && config ? (config.checkinProviders ?? []) : undefined;
      const r = await apiPost<JobRunResult>(
        "/api/console/jobs/run",
        providers === undefined ? { job } : { job, providers }
      );
      const scope =
        job === "checkin" && providers !== undefined
          ? providers.length > 0
            ? `范围：仅 ${providers.length} 个所选提供商`
            : "范围：全部支持签到的提供商"
          : "";
      setRunResult({ job, rows: normalizeRunDetail(job, r.detail), error: "", scope });
      // v4.1.1：load() 会用服务器保存值重置本地 config —— 保留用户未保存的下拉选择，避免「刚勾选→点执行→选择被清空」
      const keepProviders = job === "checkin" ? providers : undefined;
      await load(); // 刷新最近执行与最近签到明细
      if (keepProviders !== undefined) setCfg({ checkinProviders: keepProviders });
    } catch (e) {
      setRunResult({ job, rows: [], error: errMessage(e), scope: "" });
    } finally {
      setRunning(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="定时任务" description="签到与 Token 保活自动化" />
        <LoadingBlock rows={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="定时任务"
        description="每日签到领积分 & Token 保活续签 —— 配置保存后热生效，调度器下个周期自动重读"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
            </Button>
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={save} disabled={saving || !config}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              保存配置
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
      {configError && <ErrorAlert message={configError} />}

      {/* 三张任务卡：每日签到 / 成长中心 / Token 保活 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <CalendarCheck className="size-4.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-stone-900">每日签到</h2>
                <p className="text-xs text-muted-foreground">WorkBuddy 等支持签到的账号自动领积分</p>
              </div>
            </div>
            <Switch
              checked={!!config?.checkinEnabled}
              onCheckedChange={(v) => setCfg({ checkinEnabled: v })}
              aria-label="启用每日签到"
            />
          </div>
          {config && (
            <div className="grid gap-3 sm:grid-cols-2">
              <CronField id="checkin-cron" label="Cron 表达式" value={config.checkinCron} onChange={(v) => setCfg({ checkinCron: v })} />
              <TzField id="checkin-tz" label="时区" value={config.checkinTz} onChange={(v) => setCfg({ checkinTz: v })} />
            </div>
          )}
          {/* v4.1.0：签到提供商白名单多选下拉（空选 = 全部支持签到的提供商） */}
          {config && (
            <div className="space-y-1.5">
              <Label htmlFor="checkin-providers">签到提供商</Label>
              <CheckinProviderPicker
                candidates={data?.checkinCandidates ?? []}
                selected={config.checkinProviders ?? []}
                onChange={autoSaveCheckinProviders}
              />
              <p className="text-xs text-muted-foreground">
                不选 = 全部支持签到的提供商；选择变更后自动保存。仅勾选的提供商会执行签到；「立即执行」和定时调度都会使用当前已保存的配置
              </p>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => void runNow("checkin")} disabled={running !== null}>
              {running === "checkin" ? <Loader2 className="animate-spin" /> : <Play />}
              立即执行签到
            </Button>
          </div>
          {/* v3.8.0：本任务独立执行节奏（per-job 过滤，与总历史节奏互不干扰） */}
          <div className="rounded-lg bg-stone-50 px-2.5 py-2">
            <p className="mb-1.5 text-[11px] font-medium text-stone-500">执行节奏</p>
            <JobRhythmStrip runs={(data?.recentRuns ?? []).filter((r) => r.job === "checkin")} />
          </div>
        </section>

        <GrowthCard fmtTime={relativeTime} />

        <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-teal-50 text-teal-600">
                <Timer className="size-4.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-stone-900">Token 保活</h2>
                <p className="text-xs text-muted-foreground">Access Token 定期刷新 + 指纹/免费模型池维护</p>
              </div>
            </div>
            <Switch
              checked={!!config?.keepaliveEnabled}
              onCheckedChange={(v) => setCfg({ keepaliveEnabled: v })}
              aria-label="启用 Token 保活"
            />
          </div>
          {config && (
            <div className="grid gap-3 sm:grid-cols-2">
              <CronField id="keepalive-cron" label="Cron 表达式" value={config.keepaliveCron} onChange={(v) => setCfg({ keepaliveCron: v })} />
              <TzField id="keepalive-tz" label="时区" value={config.keepaliveTz} onChange={(v) => setCfg({ keepaliveTz: v })} />
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => void runNow("keepalive")} disabled={running !== null}>
              {running === "keepalive" ? <Loader2 className="animate-spin" /> : <Play />}
              立即执行保活
            </Button>
          </div>
          {/* v3.8.0：本任务独立执行节奏（per-job 过滤） */}
          <div className="rounded-lg bg-stone-50 px-2.5 py-2">
            <p className="mb-1.5 text-[11px] font-medium text-stone-500">执行节奏</p>
            <JobRhythmStrip runs={(data?.recentRuns ?? []).filter((r) => r.job === "keepalive")} />
          </div>
        </section>
      </div>

      {/* 立即执行结果 */}
      {runResult && (
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-stone-700">
              立即执行结果 · {runResult.job === "checkin" ? "每日签到" : "Token 保活"}
              {runResult.scope && (
                <Badge variant="outline" className="border-stone-200 bg-stone-50 text-[10px] font-normal text-stone-500">
                  {runResult.scope}
                </Badge>
              )}
            </p>
            <Button variant="ghost" size="icon" className="size-7" onClick={() => setRunResult(null)} aria-label="关闭结果">
              ×
            </Button>
          </div>
          {runResult.error && <p className="text-sm text-red-600">{runResult.error}</p>}
          {runResult.rows.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>提供商</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>明细</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runResult.rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{r.label}</TableCell>
                      <TableCell>
                        {r.ok ? (
                          <Badge className="bg-emerald-100 text-emerald-700">成功</Badge>
                        ) : (
                          <Badge variant="destructive">失败</Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-md break-all text-xs text-muted-foreground">{r.extra}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            !runResult.error && <p className="text-sm text-muted-foreground">任务完成（无逐项明细返回）。</p>
          )}
        </div>
      )}

      {/* 最近签到明细 */}
      <div className="rounded-xl border border-stone-200 bg-white">
        <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
          <p className="text-sm font-medium text-stone-700">最近签到逐账号明细</p>
          <span className="text-xs text-muted-foreground">展示最近 10 条</span>
        </div>
        {(data?.lastCheckinDetail?.length ?? 0) === 0 ? (
          <div className="p-4">
            <EmptyState icon={<CalendarCheck className="size-5" />} title="尚无签到记录" description="启用每日签到或点击「立即执行签到」生成记录。" className="py-8" />
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-white">
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>提供商</TableHead>
                  <TableHead>触发</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="hidden sm:table-cell">结果</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.lastCheckinDetail.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium text-stone-800">{c.accountName || c.accountId}</TableCell>
                    <TableCell className="font-mono text-xs text-stone-500">{c.providerId}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[11px]">
                        {c.manual ? "手动" : "定时"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* v3.1.0/v3.1.1：四态显示（Task 16 遗留 #2/#3）——
                          成功=绿勾；已签到=灰徽标（10001 幂等）；活动未开启=天蓝徽标（INTL 业务态，非真失败）；
                          其余分类红字 + 分类语义 tooltip（凭据失效/网络异常） */}
                      {c.success ? (
                        <Check className="size-4 text-emerald-600" />
                      ) : (c as { category?: string | null }).category === "activity_inactive" ? (
                        <Badge
                          variant="secondary"
                          className="bg-sky-50 text-[11px] text-sky-700"
                          title="上游返回「签到活动未开启或已过期」：该站当前无签到活动，非账号故障"
                        >
                          活动未开启
                        </Badge>
                      ) : (c as { idempotentOk?: boolean }).idempotentOk ||
                        (c as { category?: string | null }).category === "idempotent" ? (
                        <Badge variant="secondary" className="bg-stone-100 text-[11px] text-stone-500" title="上游返回「今日已签到」：幂等成功，非真失败">
                          已签到
                        </Badge>
                      ) : (
                        <span
                          className="text-xs text-red-600"
                          title={
                            (c as { category?: string | null }).category === "credentials"
                              ? "凭据失效类失败（token 过期/无效），可在账号管理中刷新凭据"
                              : (c as { category?: string | null }).category === "network"
                                ? "网络异常类失败（超时/不可达），将按指数退避重试"
                                : "签到失败"
                          }
                        >
                          失败
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden max-w-64 truncate text-xs text-muted-foreground sm:table-cell" title={cellText(c.result)}>
                      {cellText(c.result) || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{relativeTime(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 最近执行历史 */}
      <div className="rounded-xl border border-stone-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 px-4 py-3">
          <p className="text-sm font-medium text-stone-700">最近执行历史</p>
          {/* v3.7.0：执行节奏图（左旧右新，成功绿/失败红）+ 汇总 */}
          <RunRhythm runs={data?.recentRuns ?? []} />
        </div>
        {(data?.recentRuns?.length ?? 0) === 0 ? (
          <div className="p-4">
            <EmptyState icon={<Clock className="size-5" />} title="尚无执行记录" description="任务按 cron 触发或手动执行后，历史将显示在这里。" className="py-8" />
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-white">
                <TableRow>
                  <TableHead>任务</TableHead>
                  <TableHead>触发</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="hidden sm:table-cell">明细</TableHead>
                  <TableHead>开始时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.recentRuns.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs font-medium">{r.job === "checkin" ? "每日签到" : "Token 保活"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[11px]" title={r.triggered === "cron-catchup" ? "进程在 cron 触发时刻不可用，调度器自动补跑" : undefined}>
                        {r.triggered === "cron" ? "定时触发" : r.triggered === "cron-catchup" ? "错失补跑" : "手动执行"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {r.success ? <Badge className="bg-emerald-100 text-emerald-700">成功</Badge> : <Badge variant="destructive">失败</Badge>}
                    </TableCell>
                    <TableCell className="hidden max-w-72 truncate font-mono text-[11px] text-muted-foreground sm:table-cell" title={cellText(r.detail)}>
                      {cellText(r.detail).slice(0, 120) || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{relativeTime(r.startedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
