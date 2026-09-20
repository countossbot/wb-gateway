// 运行日志 —— 请求级审计：时间 / 模型 / 协议 / 命中链路 / 耗时 / 状态码 / Token 用量 / 错误。
// v3.0.5：筛选体系增强 —— 状态码大类 / 调用方密钥 / 时间范围（预设 + 趋势图跳转的自定义小时窗口）；
// 行内密钥徽章可点击直接按该密钥过滤；外部跨模块跳转支持 provider / key / timeRange 三通道。
// v3.0.6：筛选七维 —— 新增账号（提供商 × 账号组合键，防跨提供商同名 default 串扰）与自定义起止时间
// （datetime-local 输入，起止均空 = 全部、仅填起始 = 起始到现在、仅填截止 = 截止之前）；账号徽标跳转第四通道。
// v3.0.8：CSV 导出 —— 按当前七维筛选导出全部匹配行（上限 5000，BOM + RFC 4180 转义，Excel 直接打开）。
"use client";

import * as React from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  KeyRound,
  Link2,
  RefreshCw,
  ScrollText,
  Search,
  Timer,
  UserCircle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  EmptyState,
  ErrorAlert,
  LoadingBlock,
  PageHeader,
  TokenBar,
} from "@/components/console/ui";
import { apiGet, authHeaders, errMessage } from "@/lib/console/api";
import { absoluteTime, statusColor, tokenUsage } from "@/lib/console/format";
import { buildDeepLink, parseLogsFilters, syncLogsFiltersToUrl } from "@/lib/console/urlState";
import type { LogsData } from "@/lib/console/types";

const PAGE_SIZE = 50;

/** v3.0.4：usage 来源筛选值（与服务端 logs 路由参数一致） */
type UsageFilter = "all" | "exact" | "estimated" | "none";

const USAGE_FILTER_OPTIONS: Array<{ value: UsageFilter; label: string }> = [
  { value: "all", label: "全部来源" },
  { value: "exact", label: "精确 · 上游 usage" },
  { value: "estimated", label: "估算 · 字符折算" },
  { value: "none", label: "未记录" },
];

/** v3.0.5：状态码大类筛选值 */
type StatusFilter = "all" | "2xx" | "4xx" | "5xx";

const STATUS_FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "2xx", label: "2xx 成功" },
  { value: "4xx", label: "4xx 客户端错误" },
  { value: "5xx", label: "5xx 服务端错误" },
];

/** v3.0.5：时间范围预设（value 同时是 Select 值与窗口毫秒数的索引） */
type TimePreset = "all" | "1h" | "6h" | "24h" | "7d" | "custom";

const TIME_PRESET_OPTIONS: Array<{ value: Exclude<TimePreset, "custom">; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "1h", label: "近 1 小时" },
  { value: "6h", label: "近 6 小时" },
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
];

const TIME_PRESET_MS: Record<Exclude<TimePreset, "custom" | "all">, number> = {
  "1h": 3600_000,
  "6h": 6 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
};

/** v3.0.5：跨模块跳转携带的自定义时间窗口（趋势图点击柱 → 该小时） */
export interface TimeRangeJump {
  from: number;
  to: number;
  label: string;
}

/** 组装时间筛选参数：custom（跳转窗口）优先，其次预设窗口，all → 无参数 */
function timeParams(
  preset: TimePreset,
  custom: TimeRangeJump | null,
): { from?: number; to?: number; label: string | null } {
  if (preset === "custom" && custom) return { from: custom.from, to: custom.to, label: custom.label };
  if (preset === "custom") return { label: null };
  if (preset === "all") return { label: null };
  return { from: Date.now() - TIME_PRESET_MS[preset], label: TIME_PRESET_OPTIONS.find((o) => o.value === preset)?.label ?? null };
}

const hhmm = (ts: number) =>
  `${String(new Date(ts).getHours()).padStart(2, "0")}:${String(new Date(ts).getMinutes()).padStart(2, "0")}`;

/** v3.0.6：毫秒时间戳 → datetime-local 输入值（YYYY-MM-DDTHH:mm，本地时区） */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** v3.0.6：datetime-local 输入值 → 毫秒时间戳（无输入返回 null） */
function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** v3.0.7：窗口展示标签——同天仅显示时分；跨天（如全天窗口 0 点→次日 0 点）显示 M/D HH:mm */
function rangeLabel(from: number, to: number): string {
  const fd = new Date(from);
  const td = new Date(to);
  const sameDay =
    fd.getFullYear() === td.getFullYear() && fd.getMonth() === td.getMonth() && fd.getDate() === td.getDate();
  if (sameDay) return `${hhmm(from)}–${hhmm(to)}`;
  const mdhm = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d.getTime())}`;
  return `${mdhm(fd)}–${mdhm(td)}`;
}

interface LoadArgs {
  model: string;
  provider: string;
  usage: UsageFilter;
  status: StatusFilter;
  key: string;
  account: string; // 组合键 "providerId/accountId" 或 "all"
  timePreset: TimePreset;
  customRange: TimeRangeJump | null;
  offset: number;
}

/** v3.0.6：账号组合键拆解（组合键防跨提供商同名账号串扰；与 provider 参数成对下发） */
function accountKeyOf(a: { providerId: string; accountId: string }): string {
  return `${a.providerId}/${a.accountId}`;
}

/**
 * v3.1.0：错误列点击复制（Task 14 遗留建议）。
 * 点击错误文本 → 复制全文到剪贴板（含 execCommand 兜底）→ 行内 ✓ 反馈 1.6s。
 * Tooltip 悬停仍显示全文；复制动作与悬停查看互补，审计归因不用再手动划选截断文本。
 */
function CopyableError({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [text]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label={`复制错误全文：${text.slice(0, 60)}`}
          className="flex w-full max-w-52 items-center gap-1.5 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400"
        >
          {copied ? (
            <span className="flex items-center gap-1 text-[11px] text-emerald-600">
              <Check className="size-3 shrink-0" aria-hidden />
              已复制全文
            </span>
          ) : (
            <>
              <span className="block cursor-pointer truncate font-mono text-[11px] text-red-600">{text}</span>
              <Copy className="size-3 shrink-0 text-red-300 transition-colors hover:text-red-600" aria-hidden />
            </>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-pre-wrap break-all">{copied ? "已复制到剪贴板" : text}</TooltipContent>
    </Tooltip>
  );
}

export function LogsModule({
  initialProvider,
  initialKeyName,
  initialTimeRange,
  initialAccount,
  initialModel,
}: {
  initialProvider?: string | null;
  initialKeyName?: string | null;
  initialTimeRange?: TimeRangeJump | null;
  /** v3.0.6：账号徽标跳转携带的（提供商 × 账号）组合 */
  initialAccount?: { providerId: string; accountId: string } | null;
  /** v3.8.0：模型健康行跳转携带的对外模型名 */
  initialModel?: string | null;
} = {}) {
  const [data, setData] = React.useState<LogsData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [modelFilter, setModelFilter] = React.useState("");
  const [appliedFilter, setAppliedFilter] = React.useState("");
  const [providerFilter, setProviderFilter] = React.useState<string>(
    initialProvider || (initialAccount ? initialAccount.providerId : "all")
  );
  const [usageFilter, setUsageFilter] = React.useState<UsageFilter>("all");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [keyFilter, setKeyFilter] = React.useState<string>(initialKeyName || "all");
  const [accountFilter, setAccountFilter] = React.useState<string>(
    initialAccount ? accountKeyOf(initialAccount) : "all"
  );
  const [timePreset, setTimePreset] = React.useState<TimePreset>(initialTimeRange ? "custom" : "all");
  const [customRange, setCustomRange] = React.useState<TimeRangeJump | null>(initialTimeRange ?? null);
  const [offset, setOffset] = React.useState(0);
  // v3.9.1：自动刷新默认开启 —— 修复「日志卡死」感知：此前默认关闭，新请求产生后页面永远不动，
  // 看起来像卡死；现在进入日志页即自动跟随，可手动关闭。
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = React.useState<number | null>(null);
  // v3.0.6：自定义起止时间输入（datetime-local 值；YYYY-MM-DDTHH:mm）
  const [customFromInput, setCustomFromInput] = React.useState("");
  const [customToInput, setCustomToInput] = React.useState("");

  /** v3.0.8：LoadArgs → 查询参数（load 与 CSV 导出共享同一套筛选语义） */
  const buildParams = React.useCallback((a: LoadArgs, withPaging: boolean) => {
    const params = new URLSearchParams();
    if (withPaging) {
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(a.offset));
    }
    if (a.model.trim()) params.set("model", a.model.trim());
    if (a.provider && a.provider !== "all") params.set("provider", a.provider);
    if (a.usage !== "all") params.set("usage", a.usage);
    if (a.status !== "all") params.set("status", a.status);
    if (a.key && a.key !== "all") params.set("key", a.key);
    // 账号组合键：同时下发 provider（组合查询）与 account（accountId 精确）
    if (a.account && a.account !== "all") {
      const slash = a.account.indexOf("/");
      const pid = slash > 0 ? a.account.slice(0, slash) : "";
      const aid = slash > 0 ? a.account.slice(slash + 1) : a.account;
      if (pid) params.set("provider", pid);
      if (aid) params.set("account", aid);
    }
    const tp = timeParams(a.timePreset, a.customRange);
    if (tp.from !== undefined) params.set("from", String(tp.from));
    if (tp.to !== undefined) params.set("to", String(tp.to));
    return params;
  }, []);

  // v3.9.1：竞态保护 —— 只有最新一次请求允许写入 state；慢响应（dev 编译/网络抖动）
  // 不再覆盖新数据（此前无保护，自动刷新与手动操作并发时旧响应可能覆盖新响应）。
  const loadSeq = React.useRef(0);
  const load = React.useCallback(
    async (a: LoadArgs, opts?: { background?: boolean }) => {
      const seq = ++loadSeq.current;
      const bg = opts?.background === true;
      if (!bg) {
        setLoading(true);
        setError("");
      }
      try {
        const params = buildParams(a, true);
        const d = await apiGet<LogsData>(`/api/console/logs?${params.toString()}`);
        if (seq !== loadSeq.current) return; // 已有更新请求，丢弃本次过期响应
        setData(d);
        setLastUpdatedAt(Date.now());
      } catch (e) {
        if (seq !== loadSeq.current) return;
        if (!bg) setError(errMessage(e));
        // 后台自动刷新失败静默：保留旧数据不打扰（fetch 已有 30s 超时兑底，不会永久挂起）
      } finally {
        if (!bg && seq === loadSeq.current) setLoading(false);
      }
    },
    [buildParams]
  );

  const baseArgs = React.useCallback(
    (over?: Partial<LoadArgs>): LoadArgs => ({
      model: appliedFilter,
      provider: providerFilter,
      usage: usageFilter,
      status: statusFilter,
      key: keyFilter,
      account: accountFilter,
      timePreset,
      customRange,
      offset,
      ...over,
    }),
    [appliedFilter, providerFilter, usageFilter, statusFilter, keyFilter, accountFilter, timePreset, customRange, offset],
  );

  React.useEffect(() => {
    // v3.4.0：挂载初始化 —— 跳转通道 props 优先于 URL 深链，URL 优先于默认值。
    // 深链形态：/?tab=logs&model=xx&provider=xx&usage=xx&status=xx&key=xx&account=xx&from=&to=
    const uf = typeof window !== "undefined" ? parseLogsFilters(window.location.search) : null;
    const usageVal = (uf?.usage && USAGE_FILTER_OPTIONS.some((o) => o.value === uf.usage) ? uf.usage : "all") as UsageFilter;
    const statusVal = (uf?.status && STATUS_FILTER_OPTIONS.some((o) => o.value === uf.status) ? uf.status : "all") as StatusFilter;
    const p = initialProvider || (initialAccount ? initialAccount.providerId : "") || uf?.provider || "all";
    const k = initialKeyName || uf?.key || "all";
    const acc = initialAccount ? accountKeyOf(initialAccount) : uf?.account || "all";
    // 跳转通道携时间窗口时优先；否则用 URL from/to（label 缺失由 rangeLabel 补齐展示）
    const tr = initialTimeRange ?? (uf?.customRange ? { ...uf.customRange, label: "自定义" } : null);
    const model = initialModel || uf?.model || "";
    setModelFilter(model);
    setAppliedFilter(model);
    setProviderFilter(p);
    setKeyFilter(k);
    setAccountFilter(acc);
    setUsageFilter(usageVal);
    setStatusFilter(statusVal);
    setCustomRange(tr);
    setTimePreset(tr ? "custom" : "all");
    if (tr) {
      setCustomFromInput(toLocalInput(tr.from));
      setCustomToInput(toLocalInput(tr.to));
    }
    void load({
      model,
      provider: p,
      usage: usageVal,
      status: statusVal,
      key: k,
      account: acc,
      timePreset: tr ? "custom" : "all",
      customRange: tr,
      offset: 0,
    });
  }, []);

  // 外部跳转同步：提供商统计条 / 趋势图柱 / 密钥徽标点击后携参进入本模块。
  // 注意：值变化包括清空（null）——侧边栏直达日志时 page.tsx 会清空跳转状态，这里必须同步重置筛选
  // （v3.0.4 曾对 null 提前 return 导致旧筛选残留，v3.0.5 修复）。
  // ⚠️ v3.4.0：首跑判定从 firstRun ref 改为「上次 props 快照」比较 —— React StrictMode 的
  // 挂载-重挂载会让 ref 首跑被消耗、二次运行误判为真实跳转，把 URL 深链初始化的筛选全部复位
  // （QA 实测：深链打开后筛选丢失回默认、24 条全量）。快照比较对 remount 幂等。
  const lastJumpKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    const jumpKey = JSON.stringify([initialProvider, initialKeyName, initialTimeRange, initialAccount, initialModel]);
    if (lastJumpKey.current === null || lastJumpKey.current === jumpKey) {
      lastJumpKey.current = jumpKey;
      return;
    }
    lastJumpKey.current = jumpKey;
    const p = initialProvider || (initialAccount ? initialAccount.providerId : "all");
    const k = initialKeyName || "all";
    const tr = initialTimeRange ?? null;
    const acc = initialAccount ? accountKeyOf(initialAccount) : "all";
    const m = initialModel || "";
    // v3.8.0：跳转查询携 model 时同步输入框与已应用筛选（保持 URL 深链与实际查询一致）
    setModelFilter(m);
    setAppliedFilter(m);
    setUsageFilter("all");
    setStatusFilter("all");
    setProviderFilter(p);
    setKeyFilter(k);
    setAccountFilter(acc);
    setCustomRange(tr);
    setTimePreset(tr ? "custom" : "all");
    setOffset(0);
    void load({
      model: m,
      provider: p,
      usage: "all",
      status: "all",
      key: k,
      account: acc,
      timePreset: tr ? "custom" : "all",
      customRange: tr,
      offset: 0,
    });
  }, [initialProvider, initialKeyName, initialTimeRange, initialAccount, initialModel]);

  // v3.4.0：用户筛选交互 → URL 深链同步（replaceState，不产生历史记录）。
  // 架构决策：不做「state → URL 自动同步 effect」——dev 环境实测存在不受控的 state 诡变
  // 会在自动同步下把深链参数清掉（且 UI 状态被污染）；改为仅在用户显式交互处同步，
  // URL 只反映用户真实操作，挂载/跳转携参的 state 迁移绝不触碰 URL。
  const syncFromArgs = React.useCallback((a: LoadArgs) => {
    const tp = timeParams(a.timePreset, a.customRange);
    syncLogsFiltersToUrl({
      model: a.model,
      provider: a.provider,
      usage: a.usage,
      status: a.status,
      key: a.key,
      account: a.account,
      customRange: tp.from !== undefined ? { from: tp.from, to: tp.to ?? Date.now() } : null,
    });
  }, []);

  // 自动刷新（10s，后台静默模式：不闪 loading、失败不打扰，数据到期即更）
  React.useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void load(baseArgs(), { background: true }), 10000);
    return () => clearInterval(t);
  }, [autoRefresh, load, baseArgs]);

  const applyFilter = () => {
    setAppliedFilter(modelFilter);
    setOffset(0);
    const a = baseArgs({ model: modelFilter, offset: 0 });
    void load(a);
    syncFromArgs(a); // v3.4.0：用户交互 → URL 深链同步
  };

  const changeProvider = (v: string) => {
    // v3.4.0：防御 Radix Select 挂载期偶发的 onValueChange("")（受控 value 指向的 item 尚未注册时）
    if (!v) return;
    setProviderFilter(v);
    setOffset(0);
    const a = baseArgs({ provider: v, offset: 0 });
    void load(a);
    syncFromArgs(a);
  };

  const changeUsage = (v: UsageFilter) => {
    if (!USAGE_FILTER_OPTIONS.some((o) => o.value === v)) return;
    setUsageFilter(v);
    setOffset(0);
    const a = baseArgs({ usage: v, offset: 0 });
    void load(a);
    syncFromArgs(a);
  };

  const changeStatus = (v: StatusFilter) => {
    // v3.4.0：防御 Radix Select 挂载期偶发的 onValueChange("")（QA 实测：深链打开时 status 被清空、
    // URL 深链参数被剥掉）。仅接受合法筛选值，空值/非法值直接忽略。
    if (!STATUS_FILTER_OPTIONS.some((o) => o.value === v)) return;
    setStatusFilter(v);
    setOffset(0);
    const a = baseArgs({ status: v, offset: 0 });
    void load(a);
    syncFromArgs(a);
  };

  const changeKey = (v: string) => {
    if (!v) return;
    setKeyFilter(v);
    setOffset(0);
    const a = baseArgs({ key: v, offset: 0 });
    void load(a);
    syncFromArgs(a);
  };

  const changeAccount = (v: string) => {
    if (!v) return;
    setAccountFilter(v);
    setOffset(0);
    // 账号组合键内含 provider：同步提供商下拉显示（组合查询）
    const slash = v.indexOf("/");
    const pid = slash > 0 ? v.slice(0, slash) : "all";
    setProviderFilter(pid);
    const a = baseArgs({ account: v, provider: pid, offset: 0 });
    void load(a);
    syncFromArgs(a);
  };

  const changeTimePreset = (v: TimePreset) => {
    if (!TIME_PRESET_OPTIONS.some((o) => o.value === v) && v !== "custom") return;
    setTimePreset(v);
    if (v !== "custom") {
      setCustomRange(null);
      setCustomFromInput("");
      setCustomToInput("");
    }
    setOffset(0);
    // 选「自定义起止…」但尚未填入起止时不加时间参数（timeParams 对无 range 的 custom 返回空）
    const a = baseArgs({ timePreset: v, customRange: v === "custom" ? customRange : null, offset: 0 });
    void load(a);
    syncFromArgs(a);
  };

  // v3.0.6：应用自定义起止时间（起止均空 = 全部时间；仅填起始 = 起始到现在；仅填截止 = 截止之前全部）
  const applyCustomRange = () => {
    const from = fromLocalInput(customFromInput);
    const to = fromLocalInput(customToInput);
    if (customFromInput && from === null) return; // 非法输入不应用
    if (customToInput && to === null) return;
    if (from === null && to === null) {
      // 双空 → 清空自定义窗口回到全部时间
      setCustomRange(null);
      setCustomFromInput("");
      setCustomToInput("");
      setOffset(0);
      void load(baseArgs({ timePreset: "all", customRange: null, offset: 0 }));
      return;
    }
    const range: TimeRangeJump = {
      from: from ?? 0,
      to: to ?? Date.now(),
      label: `自定义`,
    };
    setCustomRange(range);
    setOffset(0);
    const a = baseArgs({ timePreset: "custom", customRange: range, offset: 0 });
    void load(a);
    syncFromArgs(a);
  };

  const clearAll = () => {
    setModelFilter("");
    setAppliedFilter("");
    setProviderFilter("all");
    setUsageFilter("all");
    setStatusFilter("all");
    setKeyFilter("all");
    setAccountFilter("all");
    setTimePreset("all");
    setCustomRange(null);
    setCustomFromInput("");
    setCustomToInput("");
    setOffset(0);
    void load({
      model: "",
      provider: "all",
      usage: "all",
      status: "all",
      key: "all",
      account: "all",
      timePreset: "all",
      customRange: null,
      offset: 0,
    });
    syncFromArgs({
      model: "",
      provider: "all",
      usage: "all",
      status: "all",
      key: "all",
      account: "all",
      timePreset: "all",
      customRange: null,
      offset: 0,
    }); // v3.4.0：清除全部 → URL 同步归零
  };

  const hasActiveFilter =
    appliedFilter !== "" ||
    providerFilter !== "all" ||
    usageFilter !== "all" ||
    statusFilter !== "all" ||
    keyFilter !== "all" ||
    accountFilter !== "all" ||
    timePreset !== "all";

  const goPage = (dir: 1 | -1) => {
    const next = Math.max(0, offset + dir * PAGE_SIZE);
    setOffset(next);
    void load(baseArgs({ offset: next }));
  };

  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = data?.items ?? [];

  const usageLabel =
    usageFilter === "exact" ? "精确" : usageFilter === "estimated" ? "估算" : usageFilter === "none" ? "未记录" : null;
  const statusLabel = statusFilter !== "all" ? STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter)?.label : null;
  const accountLabel =
    accountFilter !== "all"
      ? `账号「${(data?.accounts || []).find((a) => accountKeyOf(a) === accountFilter)?.label || accountFilter}」`
      : null;
  const activeTimeLabel =
    timePreset === "custom" && customRange
      ? `${customRange.label}（${rangeLabel(customRange.from, customRange.to)}）`
      : timePreset !== "all"
        ? TIME_PRESET_OPTIONS.find((o) => o.value === timePreset)?.label ?? null
        : null;
  const filterSummary = [
    appliedFilter ? `模型「${appliedFilter}」` : null,
    providerFilter !== "all" ? `提供商「${providerFilter}」` : null,
    accountLabel,
    keyFilter !== "all" ? `密钥「${keyFilter}」` : null,
    statusLabel,
    usageLabel ? `用量${usageLabel}` : null,
    activeTimeLabel ? `时间 ${activeTimeLabel}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // v3.0.8：CSV 导出 —— 按当前七维筛选导出全部匹配行（blob 下载；X-Export-* 头反馳行数/截断）
  const [exporting, setExporting] = React.useState(false);
  const [exportNote, setExportNote] = React.useState("");
  // v3.4.0：复制深链 —— 把当前筛选打包成规范化 URL 复制（他人打开即还原同筛选视图）。
  // 从 baseArgs（当前 state）构造而非读 location.search：跳转通道携参进入时 URL 尚未同步也能复制正确。
  const [linkCopied, setLinkCopied] = React.useState(false);
  const copyDeepLink = async () => {
    try {
      const a = baseArgs();
      const tp = timeParams(a.timePreset, a.customRange);
      const url = buildDeepLink({
        model: a.model,
        provider: a.provider,
        usage: a.usage,
        status: a.status,
        key: a.key,
        account: a.account,
        customRange: tp.from !== undefined ? { from: tp.from, to: tp.to ?? Date.now() } : null,
      });
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // 降级：非 secure context / 受限 iframe（预览面板等）——隐藏 textarea + execCommand
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
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* URL 构造异常等：静默失败 */
    }
  };
  const exportCsv = async () => {
    setExporting(true);
    setExportNote("");
    setError("");
    try {
      const params = buildParams(baseArgs(), false);
      const res = await fetch(`/api/console/logs/export?${params.toString()}`, {
        method: "GET",
        headers: { ...authHeaders() },
        credentials: "same-origin",
      });
      if (res.status === 401) throw new Error("会话已过期，请重新登录");
      if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
      const blob = await res.blob();
      const rows = res.headers.get("X-Export-Rows") || "?";
      const truncated = res.headers.get("X-Export-Truncated") === "1";
      // 文件名：优先用服务端 Content-Disposition，否则本地生成
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m?.[1] || `uag-logs-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportNote(
        truncated
          ? `已导出 ${rows} 行（超过上限 5000 已截断，建议收窄筛选后分批导出）`
          : `已导出 ${rows} 行 CSV${filterSummary ? "（当前筛选）" : "（全部日志）"}`
      );
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setExporting(false);
      // 导出提示 8s 后自然消隐，避免长期占位
      setTimeout(() => setExportNote(""), 8000);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="运行日志"
        description={`网关请求审计（滚动保留最近 5000 条）· 共 ${total} 条${filterSummary ? ` · 筛选：${filterSummary}` : ""}`}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyDeepLink()}
              title={filterSummary ? "复制带当前筛选的链接（他人打开即还原同筛选视图）" : "复制日志页链接"}
            >
              {linkCopied ? <Check className="text-emerald-600" /> : <Link2 />}
              {linkCopied ? "已复制" : "复制链接"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportCsv()}
              disabled={exporting || loading || total === 0}
              title={filterSummary ? `按当前筛选导出全部匹配行（${total} 条）` : "导出全部日志（上限 5000 条）"}
            >
              <Download className={exporting ? "animate-bounce" : undefined} />
              {exporting ? "导出中…" : "导出 CSV"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAutoRefresh((v) => !v)} aria-pressed={autoRefresh} title={autoRefresh ? "每 10 秒后台自动跟随新日志（点击关闭）" : "开启后每 10 秒自动跟随新日志"}>
              <Zap className={autoRefresh ? "text-emerald-600" : undefined} />
              {autoRefresh ? "自动刷新中" : "自动刷新"}
            </Button>
            {lastUpdatedAt !== null && (
              <span
                className="hidden self-center text-[10px] tabular-nums text-stone-400 lg:inline"
                title="数据最后更新时间（自动刷新开启时每 10 秒跟随）"
              >
                更新于 {new Date(lastUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => void load(baseArgs())} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
            </Button>
          </>
        }
      />
      {exportNote && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700"
        >
          <Download className="size-3.5 shrink-0" />
          {exportNote}
        </div>
      )}

      {/* 筛选栏 */}
      <form
        className="space-y-2 rounded-xl border border-stone-200 bg-white p-3"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilter();
        }}
      >
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
            {/* v3.9.0：模型名 datalist 自动补全（数据源：日志中出现过的对外模型去重清单，按调用量降序） */}
            <Input
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              placeholder="按模型名精确筛选（输入可自动补全，如 glm-5.2）"
              className="pl-8 font-mono text-xs"
              list="logs-model-datalist"
              aria-label="按模型名筛选（支持自动补全）"
            />
            {(data?.models?.length ?? 0) > 0 && (
              <datalist id="logs-model-datalist">
                {data!.models!.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="outline" size="sm">
              应用筛选
            </Button>
            {hasActiveFilter && (
              <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
                清除
              </Button>
            )}
          </div>
        </div>
        {/* v3.0.6：维度筛选行 —— 提供商 / 账号 / 密钥 / 状态码 / 用量来源 / 时间范围 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 pt-2">
          <Select value={providerFilter} onValueChange={changeProvider}>
            <SelectTrigger className="h-8 w-full min-w-40 font-mono text-xs sm:w-44" aria-label="按提供商筛选">
              <SelectValue placeholder="全部提供商" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">全部提供商</SelectItem>
              {(data?.providers || []).map((p) => (
                <SelectItem key={p} value={p} className="font-mono text-xs">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* v3.0.6：账号（提供商 × 账号组合；组合键防跨提供商同名 default 串扰） */}
          <Select value={accountFilter} onValueChange={changeAccount}>
            <SelectTrigger className="h-8 w-full min-w-40 text-xs sm:w-48" aria-label="按命中账号筛选">
              <div className="flex min-w-0 items-center gap-1">
                <UserCircle className="size-3 shrink-0 text-stone-400" />
                <SelectValue placeholder="全部账号" />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">全部账号</SelectItem>
              {(data?.accounts || []).map((a) => (
                <SelectItem key={a.label} value={accountKeyOf(a)} className="max-w-72 font-mono text-xs">
                  <span className="inline-flex items-center gap-1 truncate" title={`${a.label} · ${a.requests} 次`}>
                    <UserCircle className="size-3 shrink-0 text-stone-400" />
                    {a.label}
                    <span className="shrink-0 text-[10px] text-stone-400">· {a.requests}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={keyFilter} onValueChange={changeKey}>
            <SelectTrigger className="h-8 w-full min-w-40 text-xs sm:w-44" aria-label="按调用方密钥筛选">
              <SelectValue placeholder="全部密钥" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">全部密钥</SelectItem>
              {(data?.keys || []).map((k) => (
                <SelectItem key={k} value={k} className="max-w-72 truncate text-xs">
                  <span className="inline-flex items-center gap-1 truncate">
                    <KeyRound className="size-3 shrink-0 text-stone-400" />
                    {k}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => changeStatus(v as StatusFilter)}>
            <SelectTrigger className="h-8 w-full min-w-36 text-xs sm:w-40" aria-label="按状态码筛选">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={usageFilter} onValueChange={(v) => changeUsage(v as UsageFilter)}>
            <SelectTrigger className="h-8 w-full min-w-36 text-xs sm:w-40" aria-label="按用量来源筛选">
              <SelectValue placeholder="全部来源" />
            </SelectTrigger>
            <SelectContent>
              {USAGE_FILTER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={timePreset} onValueChange={(v) => changeTimePreset(v as TimePreset)}>
            <SelectTrigger className="h-8 w-full min-w-36 text-xs sm:w-40" aria-label="按时间范围筛选">
              <SelectValue placeholder="全部时间" />
            </SelectTrigger>
            <SelectContent>
              {TIME_PRESET_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
              {/* v3.0.6：常设自定义起止入口；跳转携带的自定义小时/全天窗口也归此值 */}
              <SelectItem value="custom" className="text-xs">
                <span className="inline-flex items-center gap-1">
                  <Timer className="size-3 text-teal-600" />
                  {timePreset === "custom" && customRange ? customRange.label : "自定义起止…"}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* v3.0.6：自定义起止时间输入（选「自定义起止…」展开；跳转窗口也可在此微调） */}
        {timePreset === "custom" && (
          <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 pt-2">
            <label htmlFor="log-custom-from" className="text-xs text-stone-500">起</label>
            <Input
              id="log-custom-from"
              type="datetime-local"
              value={customFromInput || (customRange && customRange.from > 0 ? toLocalInput(customRange.from) : "")}
              onChange={(e) => setCustomFromInput(e.target.value)}
              className="h-8 w-44 text-xs tabular-nums"
              aria-label="自定义起始时间"
            />
            <label htmlFor="log-custom-to" className="text-xs text-stone-500">止</label>
            <Input
              id="log-custom-to"
              type="datetime-local"
              value={customToInput || (customRange ? toLocalInput(customRange.to) : "")}
              onChange={(e) => setCustomToInput(e.target.value)}
              className="h-8 w-44 text-xs tabular-nums"
              aria-label="自定义截止时间"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={applyCustomRange}
              disabled={!customFromInput && !customToInput && !customRange}
            >
              应用时间
            </Button>
            {(customFromInput || customToInput) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => {
                  setCustomFromInput("");
                  setCustomToInput("");
                }}
              >
                重置输入
              </Button>
            )}
            <span className="text-[10px] text-stone-400">起止均留空 = 全部时间；仅填起始 = 从起始到现在</span>
          </div>
        )}
      </form>

      <ErrorAlert message={error} onRetry={() => void load(baseArgs())} />

      {loading && !data ? (
        <LoadingBlock rows={6} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="size-6" />}
          title="暂无符合条件的请求日志"
          description={
            hasActiveFilter
              ? "当前筛选组合下没有记录——试着放宽筛选条件，或点击「清除」查看全部日志。"
              : "网关的每次 /v1/messages 与 /v1/chat/completions 交换都会记录在这里。"
          }
        />
      ) : (
        <TooltipProvider delayDuration={150}>
          <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-40">时间</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead className="hidden md:table-cell">协议</TableHead>
                    <TableHead className="hidden lg:table-cell">命中链路</TableHead>
                    <TableHead className="hidden sm:table-cell">耗时</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="hidden sm:table-cell">流式</TableHead>
                    <TableHead className="hidden xl:table-cell">Token 用量</TableHead>
                    <TableHead className="hidden md:table-cell">错误</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((l) => {
                    const durSlow = (l.durationMs ?? 0) > 3000;
                    return (
                      <TableRow key={l.id} className={l.error ? "bg-red-50/40" : undefined}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground" title={absoluteTime(l.createdAt)}>
                          {absoluteTime(l.createdAt)}
                        </TableCell>
                        <TableCell>
                          <code className="max-w-48 block truncate font-mono text-xs font-medium text-stone-800" title={l.model}>
                            {l.model}
                          </code>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge
                            variant="outline"
                            className={
                              l.protocol === "anthropic"
                                ? "border-amber-200 bg-amber-50 text-[10px] text-amber-700"
                                : "border-teal-200 bg-teal-50 text-[10px] text-teal-700"
                            }
                          >
                            {l.protocol}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden max-w-52 truncate font-mono text-[11px] text-stone-500 lg:table-cell" title={`${l.providerId || "—"} / ${l.accountId || "—"}`}>
                          {l.providerId || "—"}
                          <span className="text-stone-300"> / </span>
                          {l.accountId || "—"}
                          {l.apiKeyName && (
                            <button
                              type="button"
                              onClick={() => changeKey(l.apiKeyName as string)}
                              className="ml-1 rounded bg-stone-100 px-1 text-[10px] text-stone-500 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
                              title={`按密钥「${l.apiKeyName}」筛选日志`}
                            >
                              {l.apiKeyName}
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap tabular-nums text-xs sm:table-cell">
                          <span className={durSlow ? "font-medium text-amber-600" : "text-stone-600"}>
                            {l.durationMs !== null && l.durationMs !== undefined ? `${l.durationMs} ms` : "—"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className={`font-mono text-xs font-semibold ${statusColor(l.status)}`}>
                            {l.status ?? "—"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {l.stream ? (
                            <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10px] text-teal-700">
                              SSE
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap font-mono text-[11px] text-stone-600 xl:table-cell">
                          <div className="flex flex-col items-start gap-1">
                            {/* v4.1.0：精确/估算行内色块（与页脚图例同色语义：精确=emerald / 估算=amber / 未记录=无块），
                                v3.9.3 的文字尾注由 tokenUsage 输出，色块提供不读文字即可扫视的视觉通道；悬停 title 保留来源语义说明 */}
                            <span
                              className="flex items-center gap-1.5"
                              title={
                                l.usageExact === true
                                  ? "Token 用量取自上游响应的 usage 字段（精确值）"
                                  : l.usageExact === false
                                    ? "上游未提供 usage，网关按输出字符数估算（≈4 字符/token）"
                                    : undefined
                              }
                            >
                              {l.usageExact === true ? (
                                <span
                                  aria-hidden
                                  className="size-2 shrink-0 rounded-[3px] bg-emerald-400 ring-1 ring-emerald-500/40"
                                />
                              ) : l.usageExact === false ? (
                                <span
                                  aria-hidden
                                  className="size-2 shrink-0 rounded-[3px] bg-amber-400 ring-1 ring-amber-500/40"
                                />
                              ) : null}
                              <span className="sr-only">
                                {l.usageExact === true ? "精确用量" : l.usageExact === false ? "估算用量" : ""}
                              </span>
                              {tokenUsage(l.inputTokens, l.outputTokens, l.cachedTokens, l.usageExact)}
                            </span>
                            {/* v3.6.0：输入/输出/缓存三段占比条（悬停看精确百分比） */}
                            <TokenBar input={l.inputTokens} output={l.outputTokens} cached={l.cachedTokens} />
                          </div>
                        </TableCell>
                        <TableCell className="hidden max-w-52 md:table-cell">
                          {l.error ? (
                            <CopyableError text={l.error} />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* 分页 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                第 {page} / {totalPages} 页 · 每页 {PAGE_SIZE} 条
                {hasActiveFilter && total > 0 ? ` · 匹配 ${total} 条` : ""}
              </span>
              {/* v4.1.0：精确/估算图例（与行内色块同色同形：emerald 方块=精确 / amber 方块=估算） */}
              <span className="flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-[3px] bg-emerald-400 ring-1 ring-emerald-500/40" />
                精确 = 上游 usage
                <span aria-hidden className="ml-1 size-2 rounded-[3px] bg-amber-400 ring-1 ring-amber-500/40" />
                估算 = 字符折算
              </span>
              {/* v3.6.0：Token 占比条配色图例 */}
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-3 rounded-full bg-teal-400/80" aria-hidden /> 输入
                <span className="h-1.5 w-3 rounded-full bg-emerald-500/80" aria-hidden /> 输出
                <span className="h-1.5 w-3 rounded-full bg-amber-400/90" aria-hidden /> 缓存
              </span>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => goPage(-1)} disabled={offset === 0 || loading}>
                <ChevronLeft />
                上一页
              </Button>
              <Button variant="outline" size="sm" onClick={() => goPage(1)} disabled={offset + PAGE_SIZE >= total || loading}>
                <ChevronRight />
                下一页
              </Button>
            </div>
          </div>
        </TooltipProvider>
      )}
    </div>
  );
}
