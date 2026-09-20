// 总览 —— 聚合余额 / 账号与提供商统计 / 缓存命中率 / 最近签到与刷新 / 可用模型 / 账号状态表。
"use client";

import * as React from "react";
import {
  Activity,
  BarChart3,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Coins,
  Copy,
  Download,
  Gauge,
  HeartPulse,
  Hourglass,
  Layers,
  Network,
  PieChart,
  RefreshCw,
  Route as RouteIcon,
  Snowflake,
  Table2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CopyButton,
  EmptyState,
  ErrorAlert,
  LoadingBlock,
  PageHeader,
  StatCard,
  CooldownDot,
  ClearCooldownButton,
  BalanceTrendBars,
} from "@/components/console/ui";
import { apiGet, errMessage } from "@/lib/console/api";
import { cooldownRemaining, fmtCompact, fmtNum, relativeTime } from "@/lib/console/format";
import type { BalanceHistoryData, ModelHealthData, OverviewData, OverviewInsightsData, SloData, TopKeyRow, TopModelRow, TopProviderRow, Trend7Day, Trend7DayPrev, TrendBucket } from "@/lib/console/types";

/** v3.0.5：近 24h 逐小时请求趋势 mini 图（纯 CSS 柱状：成功 emerald / 失败 red，Tooltip 显示明细；
 *  有流量的柱可点击 → 跳转运行日志按该小时窗口过滤；移动端横向滚动保证 24 柱可读性） */
function Trend24hCard({ buckets, onHourClick }: { buckets: TrendBucket[]; onHourClick?: (hourIso: string) => void }) {
  const max = Math.max(1, ...buckets.map((b) => b.requests));
  const totalReqs = buckets.reduce((s, b) => s + b.requests, 0);
  const totalOk = buckets.reduce((s, b) => s + b.okRequests, 0);
  const totalIn = buckets.reduce((s, b) => s + b.inputTokens, 0);
  const totalOut = buckets.reduce((s, b) => s + b.outputTokens, 0);
  const successRate = totalReqs > 0 ? Math.round((totalOk / totalReqs) * 100) : null;

  const hourLabel = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-stone-700">近 24h 请求趋势</p>
        <p className="text-xs text-muted-foreground">
          {totalReqs > 0 ? (
            <>
              共 <span className="font-medium tabular-nums text-stone-700">{totalReqs}</span> 次请求 ·
              成功率{" "}
              <span
                className={`font-medium tabular-nums ${
                  (successRate ?? 100) >= 90 ? "text-emerald-600" : (successRate ?? 100) >= 60 ? "text-amber-600" : "text-red-600"
                }`}
              >
                {successRate}%
              </span>{" "}
              · 输入 {fmtCompact(totalIn)} / 输出 {fmtCompact(totalOut)} tokens
            </>
          ) : (
            "近 24 小时无网关请求"
          )}
        </p>
      </div>
      <TooltipProvider delayDuration={120}>
        {/* 移动端横向滚动：窄屏下 24 柱压缩过窄，保持最小可读宽度 */}
        <div className="mt-3 -mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex h-28 min-w-[520px] items-end gap-[3px]" role="img" aria-label={`近 24 小时请求趋势，共 ${totalReqs} 次请求`}>
          {buckets.map((b, i) => {
            const okH = (b.okRequests / max) * 100;
            const failH = ((b.requests - b.okRequests) / max) * 100;
            const isPeak = b.requests === max && b.requests > 0;
            const clickable = b.requests > 0 && !!onHourClick;
            return (
              <Tooltip key={b.hour + i}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => clickable && onHourClick?.(b.hour)}
                    className="group relative flex h-full min-w-0 flex-1 flex-col-reverse rounded-t-[3px] disabled:cursor-default"
                    aria-label={`${hourLabel(b.hour)} ${b.requests} 次请求${clickable ? "，点击查看该小时日志" : ""}`}
                  >
                    <span
                      className={`block w-full rounded-t-[3px] transition-colors ${
                        b.requests === 0
                          ? "bg-stone-100 group-hover:bg-stone-200"
                          : failH > 0
                            ? "bg-red-400 group-hover:bg-red-500"
                            : "bg-emerald-500/70 group-hover:bg-emerald-500"
                      } ${isPeak ? "ring-1 ring-emerald-300" : ""}`}
                      style={{ height: `${Math.max(b.requests > 0 ? 4 : 1.5, okH + failH)}%` }}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <p className="font-medium tabular-nums">{hourLabel(b.hour)} 起 1 小时</p>
                  <p className="tabular-nums">
                    {b.requests} 次请求 · 成功 {b.okRequests}
                    {b.requests - b.okRequests > 0 && (
                      <span className="text-red-500"> · 失败 {b.requests - b.okRequests}</span>
                    )}
                  </p>
                  {(b.inputTokens > 0 || b.outputTokens > 0) && (
                    <p className="tabular-nums text-muted-foreground">
                      输入 {fmtNum(b.inputTokens)} / 输出 {fmtNum(b.outputTokens)} tokens
                    </p>
                  )}
                  {clickable && <p className="mt-0.5 text-[10px] text-emerald-600">点击查看该小时请求日志 →</p>}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {/* x 轴刻度：每 6 小时一个标签（与柱图同宽联动滚动） */}
        <div className="mt-1.5 flex min-w-[520px] gap-[3px]">
          {buckets.map((b, i) => (
            <div key={"lbl" + i} className="flex-1 text-center">
              {i % 6 === 0 || i === buckets.length - 1 ? (
                <span className="text-[10px] tabular-nums text-stone-400">{hourLabel(b.hour)}</span>
              ) : (
                <span className="text-[10px] text-transparent">·</span>
              )}
            </div>
          ))}
        </div>
        </div>
      </TooltipProvider>
      <p className="mt-2 text-[11px] text-stone-400">
        柱高 = 该小时请求数（绿 = 全部成功 · 红 = 含失败）· 悬停查看明细
        {onHourClick ? " · 点击柱跳转该小时日志" : ""} · 统计窗口随滚动日志保留最近 5000 条
      </p>
    </div>
  );
}

/**
 * v3.2.0：近 7 天用量透视卡（Task 20 遗留 #3 清偿 —— UsageDaily 透视接口的 UI 落地）。
 * - 折叠卡片：默认收起（控制总览首屏信息密度），展开时才请求 /api/console/usage/daily?days=7（懒加载 + 60s 内存缓存）
 * - 三视角 Tabs：按提供商 / 按密钥 / 按天；表格列：维度 | 请求 | 成功率 | tokens（输入/输出/缓存命中）
 * - 头部摘要：日期范围 + 总请求 + 总 tokens；成功率三色语义与全局一致（≥90 绿 / ≥60 琥珀 / <60 红）
 */
interface PivotBucket {
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  successRate: number | null;
}
interface UsageDailyPivot {
  days: number;
  range: { from: string; to: string };
  pivot: {
    byProvider: Array<{ providerId: string } & PivotBucket>;
    byKey: Array<{ apiKeyName: string } & PivotBucket>;
    byDay: Array<{ day: string } & PivotBucket>;
    totals: PivotBucket;
  };
}

// v3.4.0：缓存槽携带窗口维度（days 不同 → 未命中重新拉取）；后端 UsageDaily 已支持 days 1-90
const PIVOT_CACHE: { days: number; at: number; data: UsageDailyPivot | null } = { days: 0, at: 0, data: null };

const PIVOT_WINDOW_OPTIONS = [7, 14, 30, 60, 90] as const;

function rateClass(rate: number | null): string {
  if (rate === null) return "text-muted-foreground";
  return rate >= 90 ? "text-emerald-600" : rate >= 60 ? "text-amber-600" : "text-red-600";
}

function UsagePivotCard() {
  const [open, setOpen] = React.useState(false);
  const [days, setDays] = React.useState<number>(7);
  const [data, setData] = React.useState<UsageDailyPivot | null>(PIVOT_CACHE.data);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [tab, setTab] = React.useState("provider");

  const load = React.useCallback(async (force = false, windowDays?: number) => {
    const d = windowDays ?? days;
    // 60s 内存缓存（按窗口维度分开命中）：反复展开/收起/切窗口不重复请求（穿透用刷新按钮）
    if (!force && PIVOT_CACHE.data && PIVOT_CACHE.days === d && Date.now() - PIVOT_CACHE.at < 60_000) {
      setData(PIVOT_CACHE.data);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await apiGet<UsageDailyPivot>(`/api/console/usage/daily?days=${d}`);
      PIVOT_CACHE.days = d;
      PIVOT_CACHE.data = res;
      PIVOT_CACHE.at = Date.now();
      setData(res);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [days]);

  // v3.4.0：切换统计窗口（拉取对应天数；缓存未命中时才真正请求）
  const changeDays = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n === days) return;
    setDays(n);
    void load(false, n);
  };

  const handleOpen = (o: boolean) => {
    setOpen(o);
    if (o) void load();
  };

  // v3.2.3：透视数据 CSV 导出（客户端生成，BOM + RFC 4180 转义，与日志导出同口径）。
  // 一次导出三维视图全部分区 + 合计行，Excel/WPS 直接打开不乱码。
  const exportPivotCsv = React.useCallback(() => {
    if (!data) return;
    const esc = (v: string | number | null) => {
      const s = String(v ?? "");
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["维度", "请求数", "成功数", "成功率%", "输入tokens", "输出tokens", "缓存命中tokens"];
    const lines: string[] = [];
    lines.push(`Universal AI Gateway · 近 ${data.days} 天用量透视（${data.range.from} ~ ${data.range.to}）`);
    const section = (name: string, rows: Array<PivotBucket & { label: string }>) => {
      lines.push("");
      lines.push(`视图,${esc(name)}`);
      lines.push(header.map(esc).join(","));
      for (const r of rows) {
        lines.push(
          [r.label, r.requests, r.okRequests, r.successRate ?? "", r.inputTokens, r.outputTokens, r.cachedTokens]
            .map(esc)
            .join(",")
        );
      }
    };
    section("按提供商", data.pivot.byProvider.map((r) => ({ ...r, label: r.providerId })));
    section("按密钥", data.pivot.byKey.map((r) => ({ ...r, label: r.apiKeyName })));
    section("按天", data.pivot.byDay.map((r) => ({ ...r, label: r.day })));
    const t = data.pivot.totals;
    lines.push("");
    lines.push(["合计", t.requests, t.okRequests, t.successRate ?? "", t.inputTokens, t.outputTokens, t.cachedTokens].map(esc).join(","));
    const csv = "\uFEFF" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uag-usage-pivot-${data.range.from}_to_${data.range.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [data]);

  const rangeLabel = data ? `${data.range.from.slice(5).replace("-", "/")} – ${data.range.to.slice(5).replace("-", "/")}` : "";
  const totals = data?.pivot.totals;
  const rows =
    tab === "provider"
      ? (data?.pivot.byProvider || []).map((r) => ({ key: r.providerId, label: r.providerId, ...r }))
      : tab === "key"
        ? (data?.pivot.byKey || []).map((r) => ({ key: r.apiKeyName, label: r.apiKeyName, ...r }))
        : (data?.pivot.byDay || []).map((r) => ({ key: r.day, label: `${Number(r.day.slice(5, 7))}/${Number(r.day.slice(8, 10))}`, ...r }));

  return (
    <Collapsible open={open} onOpenChange={handleOpen}>
      <div className="rounded-xl border border-stone-200 bg-white">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400"
            aria-expanded={open}
          >
            <span className="flex items-center gap-2">
              <PieChart className="size-4 text-teal-600" aria-hidden />
              <span className="text-sm font-medium text-stone-700">近 {days} 天用量透视</span>
              <span className="hidden text-[11px] text-muted-foreground sm:inline">提供商 × 密钥 × 日期三维视角（点击展开）</span>
            </span>
            <ChevronDown className={`size-4 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-stone-100 px-4 py-3">
            {loading && !data ? (
              <LoadingBlock rows={3} />
            ) : error ? (
              <p className="text-xs text-red-600">加载失败：{error}</p>
            ) : !data || rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">近 {days} 天暂无用量数据（数据来自 UsageDaily 按日聚合，不受滚动日志窗口截断）。</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tabs value={tab} onValueChange={setTab}>
                      <TabsList className="h-7">
                        <TabsTrigger value="provider" className="h-7 px-2.5 text-xs">按提供商</TabsTrigger>
                        <TabsTrigger value="key" className="h-7 px-2.5 text-xs">按密钥</TabsTrigger>
                        <TabsTrigger value="day" className="h-7 px-2.5 text-xs">按天</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    {/* v3.4.0：自定义统计窗口（后端 UsageDaily 已支持 days 1-90，纯前端拉取参数） */}
                    <Select value={String(days)} onValueChange={changeDays}>
                      <SelectTrigger
                        className="h-7 w-[104px] gap-1 border-stone-200 px-2 text-xs text-stone-600"
                        aria-label="透视统计窗口（天数）"
                      >
                        <CalendarDays className="size-3 text-stone-400" aria-hidden />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PIVOT_WINDOW_OPTIONS.map((d) => (
                          <SelectItem key={d} value={String(d)} className="text-xs">
                            近 {d} 天
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {rangeLabel} · {totals?.requests ?? 0} 次 · {fmtCompact((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0))} tk
                      {(totals?.cachedTokens ?? 0) > 0 ? ` · 缓 ${fmtCompact(totals!.cachedTokens)}` : ""}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                      disabled={loading}
                      onClick={() => void load(true)}
                      aria-label="刷新透视数据"
                    >
                      <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} aria-hidden />
                      刷新
                    </Button>
                    {/* v3.2.3：导出全部三维透视分区 + 合计为 CSV（BOM + RFC 4180） */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                      disabled={!data || rows.length === 0}
                      onClick={exportPivotCsv}
                      aria-label="导出透视数据 CSV"
                      title={`导出近 ${days} 天透视全部分区（提供商/密钥/日期 + 合计）为 CSV`}
                    >
                      <Download className="size-3" aria-hidden />
                      导出
                    </Button>
                  </div>
                </div>
                <div className="mt-2 max-h-72 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="h-8 text-xs">维度</TableHead>
                        <TableHead className="h-8 text-right text-xs">请求</TableHead>
                        <TableHead className="h-8 text-right text-xs">成功率</TableHead>
                        <TableHead className="h-8 text-right text-xs">输入 / 输出 tk</TableHead>
                        <TableHead className="h-8 text-right text-xs">缓存命中</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.slice(0, 12).map((r) => (
                        <TableRow key={r.key}>
                          <TableCell className="max-w-52 py-1.5 text-xs font-medium text-stone-800">
                            <span className="block truncate" title={r.key}>{r.label}</span>
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs tabular-nums">{r.requests}</TableCell>
                          <TableCell className={`py-1.5 text-right text-xs tabular-nums ${rateClass(r.successRate)}`}>
                            {r.successRate === null ? "—" : `${r.successRate}%`}
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                            {fmtNum(r.inputTokens)} / {fmtNum(r.outputTokens)}
                          </TableCell>
                          <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                            {r.cachedTokens > 0 ? fmtNum(r.cachedTokens) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {rows.length > 12 && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">仅展示前 12 行（共 {rows.length} 行）· 完整数据可调 GET /api/console/usage/daily</p>
                )}
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * v3.1.1：今日 Top 密钥排行卡（Task 19 遗留建议）。
 * - UsageDaily 按密钥名聚合今日请求数 Top 5；点击行 → 运行日志按「该密钥 + 今日全天」过滤（第六跳转通道）
 * - 成功率三色语义与 HealthBadge 一致（≥90 emerald / ≥60 amber / <60 red）
 * - 空态引导文案说明数据来源，非报错
 * v3.2.0：昨日兕底 —— 今日零调用时后端改返昨日 Top，date 与今日不同时显示「昨日数据」标注
 */
function TopKeysCard({
  rows,
  date,
  todayKey,
  onKeyClick,
}: {
  rows: TopKeyRow[];
  date?: string;
  todayKey?: string;
  onKeyClick?: (keyName: string) => void;
}) {
  const maxReq = Math.max(1, ...rows.map((r) => r.requests));
  const isYesterday = !!date && !!todayKey && date !== todayKey;
  const dateLabel = date ? `${Number(date.split("-")[1])}/${Number(date.split("-")[2])}` : "";
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <p className="text-sm font-medium text-stone-700">今日 Top 密钥</p>
        <p className="mt-2 text-xs text-muted-foreground">
          今日尚无按密钥计费的调用，且昨日亦无数据。调用发生后将按请求数排行（数据来自 UsageDaily 按日聚合，不含未知调用方）。
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex items-baseline gap-1.5">
        <BarChart3 className="size-4 shrink-0 self-center text-amber-500" aria-hidden />
        <p className="shrink-0 text-sm font-medium text-stone-700">今日 Top 密钥</p>
        {isYesterday ? (
          <Badge
            variant="outline"
            className="border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-700"
            title={`今日暂无调用，展示 ${dateLabel}（昨日）数据`}
          >
            昨日 {dateLabel} 兕底
          </Badge>
        ) : null}
        <span className="truncate text-[11px] text-muted-foreground">按请求数 · Top {rows.length}</span>
      </div>
      <ol className="mt-3 space-y-2">
        {rows.map((r, i) => {
          const rate = r.requests > 0 ? Math.round((r.okRequests / r.requests) * 100) : 100;
          const rateColor =
            rate >= 90 ? "text-emerald-600" : rate >= 60 ? "text-amber-600" : "text-red-600";
          const tokens = r.inputTokens + r.outputTokens;
          return (
            <li key={r.apiKeyName}>
              <button
                type="button"
                onClick={onKeyClick ? () => onKeyClick(r.apiKeyName) : undefined}
                disabled={!onKeyClick}
                aria-label={`查看密钥 ${r.apiKeyName}${isYesterday ? `（${dateLabel}）` : " 今日"}请求日志`}
                className={`group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  onKeyClick ? "cursor-pointer hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400" : "cursor-default"
                }`}
              >
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-bold tabular-nums ${
                    i === 0
                      ? "bg-amber-100 text-amber-700"
                      : i === 1
                        ? "bg-stone-200 text-stone-600"
                        : i === 2
                          ? "bg-orange-50 text-orange-700"
                          : "bg-stone-100 text-stone-400"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-stone-800" title={r.apiKeyName}>
                    {r.apiKeyName}
                  </span>
                  {/* 占比条：与请求峰值相对占比，直观对比用量 */}
                  <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-stone-100" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-emerald-400/70 transition-[width]"
                      style={{ width: `${Math.max(6, Math.round((r.requests / maxReq) * 100))}%` }}
                    />
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-xs font-semibold text-stone-800">{r.requests} 次</span>
                  <span className={`block text-[10px] ${rateColor}`} title={`tokens 精确值：${fmtNum(tokens)}${r.cachedTokens > 0 ? ` · 缓存精确值：${fmtNum(r.cachedTokens)}` : ""}`}>
                    {rate}% · {fmtCompact(tokens)} tk{r.cachedTokens > 0 ? ` · 缓 ${fmtCompact(r.cachedTokens)}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * v3.9.0：今日 Top 模型排行卡 —— 与 TopKeysCard 对称（同排行交互、同三档成功率、同占比条语言）。
 * 数据源 RequestLog 按对外模型聚合（本地今日 0 点窗口；今日零调用时后端昨日兑底）。
 * 点击行 → 运行日志按「该模型 + 今日全天」过滤（复用第八跳转通道）。
 * 占比条用 teal 与 Top 密钥的 emerald 区分，一览双卡时不混淆。
 */
function TopModelsCard({
  rows,
  date,
  todayKey,
  onModelClick,
}: {
  rows: TopModelRow[];
  date?: string;
  todayKey?: string;
  onModelClick?: (model: string) => void;
}) {
  const maxReq = Math.max(1, ...rows.map((r) => r.requests));
  const isYesterday = !!date && !!todayKey && date !== todayKey;
  const dateLabel = date ? `${Number(date.split("-")[1])}/${Number(date.split("-")[2])}` : "";
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <p className="text-sm font-medium text-stone-700">今日 Top 模型</p>
        <p className="mt-2 text-xs text-muted-foreground">
          今日暂无调用，且昨日亦无数据。调用发生后将按请求数排行（数据来自按日聚合表的模型维度，不受滚动日志窗口截断）。
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex items-baseline gap-1.5">
        <Boxes className="size-4 shrink-0 self-center text-teal-500" aria-hidden />
        <p className="shrink-0 text-sm font-medium text-stone-700">今日 Top 模型</p>
        {isYesterday ? (
          <Badge
            variant="outline"
            className="border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-700"
            title={`今日暂无调用，展示 ${dateLabel}（昨日）数据`}
          >
            昨日 {dateLabel} 兕底
          </Badge>
        ) : null}
        <span className="truncate text-[11px] text-muted-foreground">按请求数 · Top {rows.length}</span>
      </div>
      <ol className="mt-3 space-y-2">
        {rows.map((r, i) => {
          const rate = r.requests > 0 ? Math.round((r.okRequests / r.requests) * 100) : 100;
          const rateColor =
            rate >= 90 ? "text-emerald-600" : rate >= 60 ? "text-amber-600" : "text-red-600";
          const tokens = r.inputTokens + r.outputTokens;
          return (
            <li key={r.model}>
              <button
                type="button"
                onClick={onModelClick ? () => onModelClick(r.model) : undefined}
                disabled={!onModelClick}
                aria-label={`查看模型 ${r.model}${isYesterday ? `（${dateLabel}）` : " 今日"}请求日志`}
                className={`group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  onModelClick ? "cursor-pointer hover:bg-teal-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400" : "cursor-default"
                }`}
              >
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-bold tabular-nums ${
                    i === 0
                      ? "bg-teal-100 text-teal-700"
                      : i === 1
                        ? "bg-stone-200 text-stone-600"
                        : i === 2
                          ? "bg-teal-50 text-teal-600"
                          : "bg-stone-100 text-stone-400"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs font-medium text-stone-800" title={r.model}>
                    {r.model}
                  </span>
                  {/* 占比条：与请求峰值相对占比（teal，与 Top 密钥 emerald 区分） */}
                  <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-stone-100" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-teal-400/70 transition-[width]"
                      style={{ width: `${Math.max(6, Math.round((r.requests / maxReq) * 100))}%` }}
                    />
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-xs font-semibold text-stone-800">{r.requests} 次</span>
                  <span className={`block text-[10px] ${rateColor}`} title={`tokens 精确值：${fmtNum(tokens)}${r.cachedTokens > 0 ? ` · 缓存精确值：${fmtNum(r.cachedTokens)}` : ""}`}>
                    {rate}% · {fmtCompact(tokens)} tk{r.cachedTokens > 0 ? ` · 缓 ${fmtCompact(r.cachedTokens)}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * v4.2.1：近 7 天 Top 提供商排行卡（Task 32 顺延项落地）。
 * - UsageDaily providerId 维度聚合（持久数据，不受滚动日志窗口截断）；Top 5 按请求数
 * - 每行：排名徽标（orange 系）+ 提供商名 + 占比条 + 请求数/成功率/token + 份额百分比
 * - 份额 share = 该提供商请求 / 窗口内全部请求（含未命中行作分母，忠实反映总盘子；窗口语义随选择器联动自洽）
 * - 与 Top 密钥（emerald）/ Top 模型（teal）三色区分，一览三卡不混淆
 * - v4.2.4：窗口选择器（7/14/30 天，orange 主题与卡片一致）+ 独立 insights API 拉取（loading 态内容半透明脉冲）
 */
const TP_WINDOW_OPTIONS: Array<{ days: 7 | 14 | 30; label: string }> = [
  { days: 7, label: "7 天" },
  { days: 14, label: "14 天" },
  { days: 30, label: "30 天" },
];

function TopProvidersCard({
  rows,
  windowDays = 7,
  onWindowChange,
  loading,
}: {
  rows: TopProviderRow[];
  windowDays?: 7 | 14 | 30;
  onWindowChange?: (days: 7 | 14 | 30) => void;
  loading?: boolean;
}) {
  const maxReq = Math.max(1, ...rows.map((r) => r.requests));
  const totalShare = rows.reduce((s, r) => s + r.share, 0);
  const nDays = windowDays;
  const windowSelector = onWindowChange ? (
    <span className="ml-auto shrink-0" role="group" aria-label="切换 Top 提供商窗口长度">
      {TP_WINDOW_OPTIONS.map((o) => (
        <button
          key={o.days}
          type="button"
          onClick={() => onWindowChange(o.days)}
          aria-pressed={windowDays === o.days}
          title={`按 ${o.days} 天窗口查看 Top 提供商排行（份额为该窗口内占比）`}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            windowDays === o.days
              ? "bg-orange-100 text-orange-700"
              : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"
          }`}
        >
          {o.label}
        </button>
      ))}
    </span>
  ) : null;
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="flex items-baseline gap-1.5">
          <p className="text-sm font-medium text-stone-700">近 {nDays} 天 Top 提供商</p>
          {windowSelector}
        </div>
        <p className={`mt-2 text-xs text-muted-foreground ${loading ? "animate-pulse" : ""}`}>
          近 {nDays} 天尚无命中提供商的调用。调用发生后将按请求数排行（数据来自 UsageDaily 按日聚合，重启不丢）。
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex items-baseline gap-1.5">
        <Network className="size-4 shrink-0 self-center text-orange-500" aria-hidden />
        <p className="shrink-0 text-sm font-medium text-stone-700">近 {nDays} 天 Top 提供商</p>
        {totalShare < 99 && (
          <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] font-medium text-stone-500" title={`另有 ${(100 - totalShare).toFixed(1)}% 请求未命中提供商（容灾或路由缺失）`}>
            另 {Math.round((100 - totalShare) * 10) / 10}% 未命中
          </Badge>
        )}
        {windowSelector}
        <span className="truncate text-[11px] text-muted-foreground">按请求数 · Top {rows.length}</span>
      </div>
      {/* v4.2.4：独立 API 拉取期间内容半透明脉冲（窗口切换不闪整页 loading） */}
      <ol className={`mt-3 space-y-2 transition-opacity ${loading ? "animate-pulse opacity-50" : ""}`}>
        {rows.map((r, i) => {
          const rate = r.requests > 0 ? Math.round((r.okRequests / r.requests) * 100) : 100;
          const rateColor =
            rate >= 90 ? "text-emerald-600" : rate >= 60 ? "text-amber-600" : "text-red-600";
          const tokens = r.inputTokens + r.outputTokens;
          return (
            <li key={r.providerId}>
              <div className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5">
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-bold tabular-nums ${
                    i === 0
                      ? "bg-orange-100 text-orange-700"
                      : i === 1
                        ? "bg-stone-200 text-stone-600"
                        : i === 2
                          ? "bg-orange-50 text-orange-600"
                          : "bg-stone-100 text-stone-400"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-stone-800" title={`${r.providerName}（${r.providerId}）`}>
                    {r.providerName}
                  </span>
                  {/* 占比条：与请求峰值相对占比（orange，与 Top 密钥 emerald / Top 模型 teal 区分） */}
                  <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-stone-100" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-orange-400/70 transition-[width]"
                      style={{ width: `${Math.max(6, Math.round((r.requests / maxReq) * 100))}%` }}
                    />
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-xs font-semibold text-stone-800">{r.requests} 次</span>
                  <span
                    className={`block text-[10px] ${rateColor}`}
                    title={`tokens 精确值：${fmtNum(tokens)}${r.cachedTokens > 0 ? ` · 缓存精确值：${fmtNum(r.cachedTokens)}` : ""} · 份额 ${r.share}%`}
                  >
                    {rate}% · {fmtCompact(tokens)} tk · 占 {r.share}%
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** v4.2.1：单日健康柱颜色 —— ≥90 emerald / ≥60 amber / <60 red / 无流量 stone 平点 */
function healthBarClass(rate: number | null): string {
  if (rate === null) return "";
  if (rate >= 90) return "bg-emerald-400 group-hover/bar:bg-emerald-500";
  if (rate >= 60) return "bg-amber-400 group-hover/bar:bg-amber-500";
  return "bg-red-400 group-hover/bar:bg-red-500";
}

/**
 * v4.2.1：模型健康 sparkline 卡（Task 32 顺延项落地）。
 * - 窗口内每个模型一行：模型名 + N 根日柱（高度=当日请求量相对峰值；颜色=当日成功率三档）
 *   + 右侧窗口内请求数与总成功率
 * - 点击行 → 运行日志按「该模型 + 今日全天」过滤（复用第八跳转通道语义）
 * - v4.2.3b：窗口长度可选 7/14/30 天（数据源为持久聚合，长窗口零额外成本）；
 *   柱宽自适应（flex-1 均分，长窗口自动变窄不溢出）
 * - 脚注注明持久聚合口径（v4.2.3 改读 UsageDaily 模型维度：跨滚动窗口持久，不再受 5000 条截断）
 * - v4.2.4：数据改由独立 insights API 拉取（切窗口不再整页重载）；loading 态内容半透明脉冲
 */
const MH_WINDOW_OPTIONS: Array<{ days: 7 | 14 | 30; label: string }> = [
  { days: 7, label: "7 天" },
  { days: 14, label: "14 天" },
  { days: 30, label: "30 天" },
];

function ModelHealthCard({
  data,
  windowDays = 7,
  onWindowChange,
  loading,
  onModelClick,
}: {
  data?: ModelHealthData;
  windowDays?: 7 | 14 | 30;
  onWindowChange?: (days: 7 | 14 | 30) => void;
  loading?: boolean;
  onModelClick?: (model: string) => void;
}) {
  const models = data?.models || [];
  const nDays = data?.windowDays || windowDays;
  if (models.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="flex items-baseline gap-1.5">
          <p className="text-sm font-medium text-stone-700">模型健康 · 近 {nDays} 天</p>
          {onWindowChange ? (
            <span className="ml-auto" role="group" aria-label="切换模型健康窗口长度">
              {MH_WINDOW_OPTIONS.map((o) => (
                <button
                  key={o.days}
                  type="button"
                  onClick={() => onWindowChange(o.days)}
                  aria-pressed={windowDays === o.days}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    windowDays === o.days
                      ? "bg-rose-100 text-rose-700"
                      : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        <p className={`mt-2 text-xs text-muted-foreground ${loading ? "animate-pulse" : ""}`}>
          近 {nDays} 天暂无网关调用。调用发生后将按模型展示每日请求量与成功率走势（数据来自按日聚合表的模型维度）。
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex items-baseline gap-1.5">
        <HeartPulse className="size-4 shrink-0 self-center text-rose-500" aria-hidden />
        <p className="shrink-0 text-sm font-medium text-stone-700">模型健康 · 近 {nDays} 天</p>
        {onWindowChange ? (
          <span className="ml-auto shrink-0" role="group" aria-label="切换模型健康窗口长度">
            {MH_WINDOW_OPTIONS.map((o) => (
              <button
                key={o.days}
                type="button"
                onClick={() => onWindowChange(o.days)}
                aria-pressed={windowDays === o.days}
                title={`按 ${o.days} 天窗口查看模型健康`}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  windowDays === o.days
                    ? "bg-rose-100 text-rose-700"
                    : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                }`}
              >
                {o.label}
              </button>
            ))}
          </span>
        ) : (
          <span className="truncate text-[11px] text-muted-foreground">日柱高=请求量 · 色=成功率</span>
        )}
      </div>
      {/* v4.2.4：独立 API 拉取期间内容半透明脉冲（切窗口不闪整页 loading） */}
      <ul className={`mt-3 space-y-1.5 transition-opacity ${loading ? "animate-pulse opacity-50" : ""}`}>
        {models.map((m) => {
          const maxDay = Math.max(1, ...m.points.map((p) => p.requests));
          const rateN = m.requests7d > 0 ? Math.round((m.okRequests7d / m.requests7d) * 100) : 100;
          const rateNColor =
            rateN >= 90 ? "text-emerald-600" : rateN >= 60 ? "text-amber-600" : "text-red-600";
          return (
            <li key={m.model}>
              <button
                type="button"
                onClick={onModelClick ? () => onModelClick(m.model) : undefined}
                disabled={!onModelClick}
                aria-label={`查看模型 ${m.model} 今日请求日志（近 ${nDays} 天 ${m.requests7d} 次，成功率 ${rateN}%）`}
                className={`group flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left transition-colors ${
                  onModelClick ? "cursor-pointer hover:bg-rose-50/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-300" : "cursor-default"
                }`}
              >
                <span className="w-32 shrink-0 truncate font-mono text-xs font-medium text-stone-800 sm:w-40" title={m.model}>
                  {m.model}
                </span>
                {/* 窗口内 sparkline：高=当日请求量（相对本模型峰值），色=当日成功率三档；无流量日渲染平点；
                    柱宽 flex-1 自适应（30 天窗口自动变窄不溢出） */}
                <span className="flex h-7 min-w-0 flex-1 items-end justify-end gap-[2px] sm:gap-[3px]" role="img" aria-label={`${m.model} 近 ${nDays} 天每日请求与成功率`}>
                  {m.points.map((p, i) => {
                    const rate = p.requests > 0 ? Math.round((p.okRequests / p.requests) * 100) : null;
                    const h = p.requests > 0 ? Math.max(15, Math.round((p.requests / maxDay) * 100)) : 0;
                    // 30 天窗口跨月，tooltip 用完整日期（YYYY-MM-DD）避免歧义
                    const tip =
                      p.requests > 0
                        ? `${p.day} · ${p.requests} 次 · 成功率 ${rate}%`
                        : `${p.day} · 无流量`;
                    return (
                      <span
                        key={i}
                        title={tip}
                        className={`group/bar flex h-full min-w-0 flex-1 flex-col justify-end ${rate === null ? "items-center" : ""}`}
                      >
                        {p.requests > 0 ? (
                          <span
                            className={`block w-full rounded-[2px] transition-colors ${healthBarClass(rate)}`}
                            style={{ height: `${h}%` }}
                          />
                        ) : (
                          <span className="block h-[3px] w-full rounded-full bg-stone-200" />
                        )}
                      </span>
                    );
                  })}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-xs font-semibold text-stone-800">{m.requests7d} 次</span>
                  <span className={`block text-[10px] ${rateNColor}`} title={`近 ${nDays} 天成功率（成功 ${m.okRequests7d} / 共 ${m.requests7d}）`}>
                    {nDays} 天 {rateN}%
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2.5 border-t border-stone-100 pt-2 text-[10px] leading-relaxed text-muted-foreground">
        数据来自按日聚合表的模型维度（v4.2.3 起持久累积，不受滚动日志窗口截断；当日统计有约 30 秒批量落库延迟；v4.2.3 之前的历史行无模型细分）；柱色阈值：绿 ≥90% · 黄 ≥60% · 红 &lt;60%。
      </p>
    </div>
  );
}

// ---- v4.3.2：服务质量 SLO 卡 ----

/** SLO 窗口切换选项（与后端 normalizeSloHours 白名单一致） */
const SLO_WINDOW_OPTIONS: Array<{ hours: 1 | 6 | 24; label: string }> = [
  { hours: 1, label: "1h" },
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
];

/** 延迟人读格式：<1s → "812 ms"；≥1s → "1.35 s" */
function fmtLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** 服务质量色阶：≥99 emerald / ≥95 amber / <95 red（SLO 运维口径比模型健康卡更严） */
function sloRateClass(rate: number): string {
  return rate >= 99 ? "text-emerald-600" : rate >= 95 ? "text-amber-600" : "text-red-600";
}

function SloCard({
  data,
  windowHours = 24,
  onWindowChange,
  loading,
}: {
  data?: SloData;
  windowHours?: 1 | 6 | 24;
  onWindowChange?: (hours: 1 | 6 | 24) => void;
  loading?: boolean;
}) {
  const nHours = data?.windowHours || windowHours;
  const samples = data?.samples ?? 0;

  // 空态：窗口内零请求（保持窗口切换可用，等流量进来）
  if (samples === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="flex items-baseline gap-1.5">
          <p className="text-sm font-medium text-stone-700">服务质量 · 近 {nHours} 小时</p>
          {onWindowChange ? (
            <span className="ml-auto" role="group" aria-label="切换服务质量窗口长度">
              {SLO_WINDOW_OPTIONS.map((o) => (
                <button
                  key={o.hours}
                  type="button"
                  onClick={() => onWindowChange(o.hours)}
                  aria-pressed={windowHours === o.hours}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    windowHours === o.hours
                      ? "bg-cyan-100 text-cyan-700"
                      : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        <p className={`mt-2 text-xs text-muted-foreground ${loading ? "animate-pulse" : ""}`}>
          近 {nHours} 小时暂无网关调用。调用发生后将展示延迟分位数（P50/P95/P99）、成功率与延迟分布直方图。
        </p>
      </div>
    );
  }

  const hist = data?.histogram || [];
  const maxCount = hist.length > 0 ? Math.max(1, ...hist.map((b) => b.count)) : 1;
  const lastBucket = hist.length > 0 ? hist[hist.length - 1] : null;
  const axisMax = lastBucket ? lastBucket.toMs : 0;
  // 分位数在直方图横轴上的落点（%）；null 时不渲染标线
  const markerPct = (v: number | null) => (v != null && axisMax > 0 ? Math.min(100, (v / axisMax) * 100) : null);
  const p50Pct = markerPct(data?.p50 ?? null);
  const p95Pct = markerPct(data?.p95 ?? null);
  const successRate = data?.successRate ?? null;
  const streamShare = data?.streamShare ?? null;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex items-baseline gap-1.5">
        <Activity className="size-4 shrink-0 self-center text-cyan-600" aria-hidden />
        <p className="shrink-0 text-sm font-medium text-stone-700">服务质量 · 近 {nHours} 小时</p>
        {onWindowChange ? (
          <span className="ml-auto shrink-0" role="group" aria-label="切换服务质量窗口长度">
            {SLO_WINDOW_OPTIONS.map((o) => (
              <button
                key={o.hours}
                type="button"
                onClick={() => onWindowChange(o.hours)}
                aria-pressed={windowHours === o.hours}
                title={`按 ${o.hours} 小时窗口查看服务质量`}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  windowHours === o.hours
                    ? "bg-cyan-100 text-cyan-700"
                    : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                }`}
              >
                {o.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      {/* v4.3.2：独立 API 拉取期间内容半透明脉冲（切窗口不闪整页 loading） */}
      <div className={`mt-3 transition-opacity ${loading ? "animate-pulse opacity-50" : ""}`}>
        {/* 分位数四格：P50 / P95 / P99 / 平均（口径 = 成功且有耗时记录的请求） */}
        <div className="grid grid-cols-4 gap-2" role="list" aria-label="延迟分位数">
          {([
            { label: "P50", v: data?.p50 ?? null, cls: "text-stone-900" },
            { label: "P95", v: data?.p95 ?? null, cls: "text-cyan-700" },
            { label: "P99", v: data?.p99 ?? null, cls: "text-amber-600" },
            { label: "平均", v: data?.avgMs ?? null, cls: "text-stone-900" },
          ] as const).map((m) => (
            <div
              key={m.label}
              role="listitem"
              className="rounded-lg bg-stone-50 px-2 py-2 text-center"
              title={`${m.label} 延迟（成功请求口径）`}
            >
              <p className="text-[10px] font-medium tracking-wide text-stone-500">{m.label}</p>
              <p className={`mt-0.5 text-sm font-semibold tabular-nums sm:text-base ${m.v == null ? "text-stone-300" : m.cls}`}>
                {m.v == null ? "—" : fmtLatency(m.v)}
              </p>
            </div>
          ))}
        </div>

        {/* 延迟分布直方图（线性等宽 20 桶；≥P95 桶染 amber；P50/P95 竖虚线标位） */}
        {hist.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-medium tracking-wide text-stone-500">
              延迟分布（{hist.length} 桶 · 桶宽 {fmtLatency(Math.max(1, Math.round((hist[1]?.fromMs ?? hist[0].toMs) - hist[0].fromMs)))}）
            </p>
            <div className="relative mt-1.5">
              {/* P50 / P95 标线（绝对定位于直方图横轴比例处） */}
              {p50Pct != null && (
                <span
                  className="pointer-events-none absolute bottom-0 top-0 z-10 border-l border-dashed border-stone-400/70"
                  style={{ left: `${p50Pct}%` }}
                  title={`P50 = ${fmtLatency(data?.p50 ?? 0)}`}
                />
              )}
              {p95Pct != null && (
                <span
                  className="pointer-events-none absolute bottom-0 top-0 z-10 border-l border-dashed border-amber-500/70"
                  style={{ left: `${p95Pct}%` }}
                  title={`P95 = ${fmtLatency(data?.p95 ?? 0)}`}
                />
              )}
              <div
                className="flex h-14 items-end gap-[2px] sm:gap-[3px]"
                role="img"
                aria-label={`延迟分布直方图：${hist.length} 个桶，横轴 0 到 ${fmtLatency(axisMax)}`}
              >
                {hist.map((b, i) => {
                  const bucketMid = (b.fromMs + b.toMs) / 2;
                  const beyondP95 = (data?.p95 ?? Infinity) < bucketMid;
                  const h = b.count > 0 ? Math.max(6, Math.round((b.count / maxCount) * 100)) : 2;
                  return (
                    <span
                      key={i}
                      title={`${fmtLatency(b.fromMs)} – ${fmtLatency(b.toMs)} · ${b.count} 次${beyondP95 ? " · 超出 P95" : ""}`}
                      className={`block min-w-0 flex-1 rounded-[2px] transition-colors ${
                        beyondP95 ? "bg-amber-400" : b.count > 0 ? "bg-cyan-400" : "bg-stone-200"
                      }`}
                      style={{ height: `${h}%` }}
                    />
                  );
                })}
              </div>
            </div>
            {/* 横轴刻度：0 / P50 / P95 / max */}
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-stone-400">
              <span>0</span>
              {p50Pct != null && p50Pct > 12 && p50Pct < 88 && (
                <span className="text-stone-400">P50</span>
              )}
              {p95Pct != null && p95Pct > 12 && p95Pct < 92 && (
                <span className="text-amber-500/80">P95</span>
              )}
              <span>{fmtLatency(axisMax)}</span>
            </div>
          </div>
        )}

        {/* 成功率 / 流式占比 / 样本徽标行 */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          {successRate != null && (
            <Badge
              variant="outline"
              className={`border-stone-200 bg-stone-50 font-medium tabular-nums ${sloRateClass(successRate)}`}
              title={`成功 ${data?.okCount ?? 0} / 共 ${samples}（含错误请求）`}
            >
              成功率 {successRate}%
            </Badge>
          )}
          {streamShare != null && (
            <Badge
              variant="outline"
              className="border-stone-200 bg-stone-50 tabular-nums text-stone-600"
              title={`流式请求 ${data?.streamCount ?? 0} 次`}
            >
              流式 {streamShare}%
            </Badge>
          )}
          <Badge variant="outline" className="border-stone-200 bg-stone-50 tabular-nums text-stone-600">
            {samples} 样本
          </Badge>
          {(data?.errCount ?? 0) > 0 && (
            <Badge variant="outline" className="border-red-200 bg-red-50 tabular-nums text-red-600" title="窗口内非 2xx 请求数">
              {data?.errCount} 错误
            </Badge>
          )}
        </div>
      </div>

      <p className="mt-2.5 border-t border-stone-100 pt-2 text-[10px] leading-relaxed text-muted-foreground">
        分位数 / 直方图仅统计成功（2xx）且有耗时记录的请求（失败请求耗时语义混杂不拉偏分布）；成功率与流式占比含全部请求；数据来自滚动日志（5000 条上限，超高流量下长窗口可能截断）；样本 &lt;5 不出分位数、&lt;8 不出直方图。
      </p>
    </div>
  );
}

/**
 * v4.2.1：余额可用天数外推（Task 32 顺延项落地）—— 纯前端复用余额快照序列。
 * 算法：carry-forward 填充后取首末已知点，净消耗速率 slope = (last - first) / 跨度天数；
 * slope < -0.01（净消耗）→ 预计可用天数 = last / -slope；slope ≥ -0.01 → 净增长/持平；
 * 已知点不足 2 个或跨度 < 1 天 → null（数据不足不出数，不误导）。
 * 注意：外推假设消耗速率恒定（签到/充值与消耗相抵后的净速率），快照断档日沿用最近值。
 */
function forecastBalance(
  points: Array<number | null>
): { kind: "growing" } | { kind: "limited"; days: number; dailyRate: number; spanDays: number } | null {
  let last: number | null = null;
  const filled = points.map((v) => {
    if (v !== null) last = v;
    return last;
  });
  const knownIdx: number[] = [];
  filled.forEach((v, i) => {
    if (v !== null) knownIdx.push(i);
  });
  if (knownIdx.length < 2) return null;
  const firstIdx = knownIdx[0];
  const lastIdx = knownIdx[knownIdx.length - 1];
  const span = lastIdx - firstIdx;
  if (span < 1) return null;
  const first = filled[firstIdx];
  const lastV = filled[lastIdx];
  if (first === null || lastV === null) return null;
  const slope = (lastV - first) / span; // 每日净变化（负=净消耗）
  if (slope >= -0.01) return { kind: "growing" };
  return {
    kind: "limited",
    days: Math.max(1, Math.round(lastV / -slope)),
    dailyRate: Math.round(-slope * 100) / 100,
    spanDays: span,
  };
}

/** v4.2.1：预计可用天数文案（聚合余额卡 footer 与账号表行内共用口径） */
function forecastText(fc: ReturnType<typeof forecastBalance>): string {
  if (!fc) return "";
  if (fc.kind === "growing") return "长期可用";
  if (fc.days > 999) return "999+ 天";
  return `≈${fc.days} 天`;
}

/** v3.0.6：近 7 天日趋势卡（UsageDaily 聚合；绿=全成功/红=含失败/灰=零流量；
 *  有流量的柱可点击 → 跳转运行日志按该天 0 点-24 点窗口过滤；数据不受滚动日志窗口截断）
 *  v3.5.0：头部新增「vs 上 7 天」环比徽标（请求数/token 对比，中性 teal/stone 语义 + Tooltip 明细） */
function Trend7dCard({ days, prev, onDayClick }: { days: Trend7Day[]; prev?: Trend7DayPrev; onDayClick?: (dayKey: string) => void }) {
  const max = Math.max(1, ...days.map((d) => d.requests));
  const totalReqs = days.reduce((s, d) => s + d.requests, 0);
  const totalOk = days.reduce((s, d) => s + d.okRequests, 0);
  const totalIn = days.reduce((s, d) => s + d.inputTokens, 0);
  const totalOut = days.reduce((s, d) => s + d.outputTokens, 0);
  const successRate = totalReqs > 0 ? Math.round((totalOk / totalReqs) * 100) : null;
  const activeDays = days.filter((d) => d.requests > 0).length;

  // v3.5.0：环比计算（上 7 天存在或上窗口有数据才展示；无对比基准时不显示徽标）
  const hasPrev = !!prev && (prev.requests > 0 || totalReqs > 0);
  const prevTokens = (prev?.inputTokens ?? 0) + (prev?.outputTokens ?? 0);
  const curTokens = totalIn + totalOut;
  const deltaPct = (cur: number, pv: number): number | null => {
    if (pv === 0) return cur > 0 ? 100 : null; // 从 0 增长记 +100%，双方皆 0 不展示
    return Math.round(((cur - pv) / pv) * 100);
  };
  const reqDelta = hasPrev ? deltaPct(totalReqs, prev!.requests) : null;
  const tkDelta = hasPrev ? deltaPct(curTokens, prevTokens) : null;

  const dayLabel = (day: string) => {
    // YYYY-MM-DD → M/D（本地时区已由后端归一）
    const [, m, d] = day.split("-");
    return `${Number(m)}/${Number(d)}`;
  };
  const weekdayLabel = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("zh-CN", { weekday: "short" });
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-stone-700">
          近 7 天消耗趋势
          {/* v3.5.0：环比徽标（中性 teal/stone 语义；Tooltip 展示两窗口明细） */}
          {hasPrev && (reqDelta !== null || tkDelta !== null) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`inline-flex cursor-help items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
                    (reqDelta ?? 0) > 0
                      ? "bg-teal-50 text-teal-700"
                      : (reqDelta ?? 0) < 0
                        ? "bg-stone-100 text-stone-500"
                        : "bg-stone-100 text-stone-500"
                  }`}
                >
                  {(reqDelta ?? 0) > 0 ? "↑" : (reqDelta ?? 0) < 0 ? "↓" : "→"}
                  {reqDelta === null ? "" : `${Math.abs(reqDelta)}%`}
                  {(reqDelta ?? 0) === 0 ? "持平" : ""}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <p className="font-medium">近 7 天 vs 上 7 天</p>
                <p className="tabular-nums">
                  请求 {totalReqs} 次 ← {prev!.requests} 次
                  {reqDelta !== null && (
                    <span className={reqDelta > 0 ? " text-teal-600" : reqDelta < 0 ? " text-stone-400" : ""}>
                      （{reqDelta > 0 ? "+" : reqDelta < 0 ? "" : "±"}{reqDelta === 0 ? "持平" : `${reqDelta}%`}）
                    </span>
                  )}
                </p>
                <p className="tabular-nums text-muted-foreground">
                  tokens {fmtNum(curTokens)} ← {fmtNum(prevTokens)}
                  {tkDelta !== null && (
                    <span>（{tkDelta > 0 ? "+" : ""}{tkDelta === 0 ? "持平" : `${tkDelta}%`}）</span>
                  )}
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {totalReqs > 0 ? (
            <>
              共 <span className="font-medium tabular-nums text-stone-700">{totalReqs}</span> 次请求 ·
              {activeDays} 天有流量 · 成功率{" "}
              <span
                className={`font-medium tabular-nums ${
                  (successRate ?? 100) >= 90 ? "text-emerald-600" : (successRate ?? 100) >= 60 ? "text-amber-600" : "text-red-600"
                }`
              }
              >
                {successRate}%
              </span>{" "}
              · 输入 {fmtCompact(totalIn)} / 输出 {fmtCompact(totalOut)} tokens
            </>
          ) : (
            "近 7 天无网关请求"
          )}
        </p>
      </div>
      <TooltipProvider delayDuration={120}>
        <div className="mt-3 flex h-24 items-end gap-2" role="img" aria-label={`近 7 天请求趋势，共 ${totalReqs} 次请求`}>
          {days.map((d, i) => {
            const okH = (d.okRequests / max) * 100;
            const failH = ((d.requests - d.okRequests) / max) * 100;
            const isPeak = d.requests === max && d.requests > 0;
            const isToday = i === days.length - 1;
            const clickable = d.requests > 0 && !!onDayClick;
            return (
              <Tooltip key={d.day}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => clickable && onDayClick?.(d.day)}
                    className="group relative flex h-full min-w-0 flex-1 flex-col-reverse rounded-t-[4px] disabled:cursor-default"
                    aria-label={`${d.day} ${d.requests} 次请求${clickable ? "，点击查看该天日志" : ""}`}
                  >
                    <span
                      className={`block w-full rounded-t-[4px] transition-colors ${
                        d.requests === 0
                          ? "bg-stone-100 group-hover:bg-stone-200"
                          : failH > 0
                            ? "bg-red-400 group-hover:bg-red-500"
                            : "bg-teal-500/70 group-hover:bg-teal-500"
                      } ${isPeak ? "ring-1 ring-teal-300" : ""}`}
                      style={{ height: `${Math.max(d.requests > 0 ? 6 : 2, okH + failH)}%` }}
                    />
                    {isToday && <span className="absolute -top-0.5 right-1/2 translate-x-1/2 size-1 rounded-full bg-amber-400" aria-label="今日" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <p className="font-medium tabular-nums">{d.day}（{weekdayLabel(d.day)}）{isToday ? " · 今日" : ""}</p>
                  <p className="tabular-nums">
                    {d.requests} 次请求 · 成功 {d.okRequests}
                    {d.requests - d.okRequests > 0 && <span className="text-red-500"> · 失败 {d.requests - d.okRequests}</span>}
                  </p>
                  {(d.inputTokens > 0 || d.outputTokens > 0) && (
                    <p className="tabular-nums text-muted-foreground">
                      输入 {fmtNum(d.inputTokens)} / 输出 {fmtNum(d.outputTokens)} tokens
                    </p>
                  )}
                  {clickable && <p className="mt-0.5 text-[10px] text-emerald-600">点击查看该天请求日志 →</p>}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {/* x 轴刻度：每天一个标签（M/D + 周几） */}
        <div className="mt-1.5 flex gap-2">
          {days.map((d, i) => (
            <div key={"lbl7" + i} className="flex-1 text-center">
              <span className={`text-[10px] tabular-nums ${i === days.length - 1 ? "font-medium text-amber-600" : "text-stone-400"}`}>
                {dayLabel(d.day)}
              </span>
              <span className="block text-[9px] text-stone-300">{weekdayLabel(d.day)}</span>
            </div>
          ))}
        </div>
      </TooltipProvider>
      <p className="mt-2 text-[11px] text-stone-400">
        柱高 = 该天请求数（绿 = 全部成功 · 红 = 含失败 · 琥珀点 = 今日）
        {onDayClick ? " · 点击柱跳转该天日志" : ""} · 数据来自按日聚合表，不受滚动日志窗口（5000 条）截断
      </p>
    </div>
  );
}

export function OverviewModule({ onHourClick, onDayClick, onTodayClick, onKeyClick, onModelClick }: { onHourClick?: (hourIso: string) => void; onDayClick?: (dayKey: string) => void; onTodayClick?: () => void; onKeyClick?: (keyName: string) => void; onModelClick?: (model: string) => void } = {}) {
  const [data, setData] = React.useState<OverviewData | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [copiedModel, setCopiedModel] = React.useState("");
  // v4.2.3b：模型健康窗口长度（7/14/30 天；数据已持久化，长窗口零额外成本）
  // v4.2.4：窗口切换改调独立 insights API（不再触发整页 overview 重载，Task 42b 遗留清偿）
  const [mhWindow, setMhWindow] = React.useState<7 | 14 | 30>(7);
  // v4.2.4：Top 提供商排行窗口（7/14/30 天；share 语义随窗口联动自洽）
  const [tpWindow, setTpWindow] = React.useState<7 | 14 | 30>(7);
  // v4.3.2：服务质量 SLO 窗口（1/6/24 小时；与 mh/tp 同范式走独立 insights API，切窗口不整页重载）
  const [sloWindow, setSloWindow] = React.useState<1 | 6 | 24>(24);
  // v4.2.4：洞察独立数据（模型健康 + Top 提供商；主响应 7 天种子初始化，窗口切换/刷新由独立 API 更新）
  const [insights, setInsights] = React.useState<OverviewInsightsData | null>(null);
  const [insightsLoading, setInsightsLoading] = React.useState(false);
  // v4.3.2：总览自动刷新（关 / 30 秒 / 60 秒；localStorage 持久化；页面不可见时跳过该轮并重置倒计时）
  const [autoRefresh, setAutoRefresh] = React.useState<"off" | "30" | "60">("off");
  const [nextRefreshIn, setNextRefreshIn] = React.useState(0);
  React.useEffect(() => {
    const saved = localStorage.getItem("uag_overview_autorefresh");
    if (saved === "30" || saved === "60") setAutoRefresh(saved);
  }, []);
  const applyAutoRefresh = React.useCallback((mode: "off" | "30" | "60") => {
    setAutoRefresh(mode);
    localStorage.setItem("uag_overview_autorefresh", mode);
    setNextRefreshIn(0);
  }, []);
  // v3.4.0：一键清冷却操作反馈（内联轻提示，非报错；3s 自动消失）
  const [cdNotice, setCdNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  // v3.6.0：余额历史快照（14 天窗口；静默拉取，失败不影响主视图）
  const [balTrend, setBalTrend] = React.useState<BalanceHistoryData | null>(null);
  React.useEffect(() => {
    if (!cdNotice) return;
    const t = setTimeout(() => setCdNotice(null), 3000);
    return () => clearTimeout(t);
  }, [cdNotice]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<OverviewData>("/api/console/overview");
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

  // v4.2.4：洞察独立拉取 —— 切窗口只重拉模型健康/Top 提供商（两个 UsageDaily 轻量查询），
  // 页面其余数据（余额/账号/趋势等）不动；加载期间卡片内容半透明脉冲而非整页 loading。
  // v4.3.2：追加 SLO（slo_hours；RequestLog 窗口聚合）同请求合并拉取。
  const loadInsights = React.useCallback(
    async (mh: 7 | 14 | 30, tp: 7 | 14 | 30, slo: 1 | 6 | 24) => {
      setInsightsLoading(true);
      try {
        const d = await apiGet<OverviewInsightsData>(
          `/api/console/overview/insights?mh_days=${mh}&tp_days=${tp}&slo_hours=${slo}`
        );
        setInsights(d);
      } catch {
        /* 拉取失败保留旧数据（卡片继续展示上次窗口内容，下次切换/刷新重试） */
      } finally {
        setInsightsLoading(false);
      }
    },
    []
  );
  // 挂载/切窗口 → 独立拉取（与主 load 并行，互不阻塞）
  React.useEffect(() => {
    void loadInsights(mhWindow, tpWindow, sloWindow);
  }, [loadInsights, mhWindow, tpWindow, sloWindow]);
  // 主响应到达且洞察仍为空（首次挂载）→ 用 7 天种子即时渲染，随后被独立拉取的同口径数据替换
  React.useEffect(() => {
    if (data && !insights && mhWindow === 7 && tpWindow === 7 && sloWindow === 24) {
      setInsights({
        model_health: data.model_health ?? { days: [], models: [] },
        top_providers_7d: data.top_providers_7d || [],
        top_providers_window_days: 7,
        slo: data.slo,
      });
    }
  }, [data, insights, mhWindow, tpWindow, sloWindow]);

  // v3.6.0：余额趋势独立拉取（quiet；接口/数据缺失时优雅降级为无 footer）
  // v4.2.3b：抽出为可重拉回调 —— 刷新按钮同步重拉（旧实现仅组件挂载时拉取一次，
  // 刷新后余额快照/外推不更新，见 Task 40 遗留项「balTrend 刷新不重拉」）
  const loadBalTrend = React.useCallback(() => {
    apiGet<BalanceHistoryData>("/api/console/balances/history?days=14", { quiet: true })
      .then(setBalTrend)
      .catch(() => {});
  }, []);
  React.useEffect(() => {
    loadBalTrend();
  }, [loadBalTrend]);

  // v4.3.2：总览自动刷新 —— 秒级倒计时驱动（关 / 30 秒 / 60 秒）。
  // 细节：①倒计时走 ref（interval 回调里直接副作用，避免 setState updater 内二次 setState 的
  // StrictMode 双调用风险）；②页面不可见（visibilityState）时跳过该轮并重置倒计时
  //（后台标签页不空转刷请求，切回来也不会瞬间连刷）；③窗口参数变化会重建 interval 重置倒计时。
  const nextRefreshRef = React.useRef(0);
  React.useEffect(() => {
    if (autoRefresh === "off") {
      nextRefreshRef.current = 0;
      setNextRefreshIn(0);
      return;
    }
    const seconds = Number(autoRefresh);
    nextRefreshRef.current = seconds;
    setNextRefreshIn(seconds);
    const t = window.setInterval(() => {
      nextRefreshRef.current -= 1;
      if (nextRefreshRef.current <= 0) {
        nextRefreshRef.current = seconds;
        setNextRefreshIn(seconds);
        if (document.visibilityState === "visible") {
          void load();
          loadBalTrend();
          void loadInsights(mhWindow, tpWindow, sloWindow);
        }
      } else {
        setNextRefreshIn(nextRefreshRef.current);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [autoRefresh, load, loadBalTrend, loadInsights, mhWindow, tpWindow, sloWindow]);

  // v3.6.0：聚合余额逐日序列 —— 各账号 carry-forward 后按日求和
  //（存量指标语义：账号当日无快照沿用最近已知值，避免「没测=归零」的错误断崖）
  const balTrendAgg = React.useMemo(() => {
    if (!balTrend || balTrend.accounts.length === 0) return null;
    const { days, accounts } = balTrend;
    const agg: Array<number | null> = new Array(days.length).fill(null);
    for (const acc of accounts) {
      let last: number | null = null;
      acc.points.forEach((v, i) => {
        if (v !== null) last = v;
        if (last !== null) agg[i] = (agg[i] ?? 0) + last;
      });
    }
    const known = agg.filter((v): v is number => v !== null);
    if (known.length === 0) return null;
    const first = known[0];
    const last = known[known.length - 1];
    return {
      days,
      points: agg,
      first,
      last,
      delta: Math.round((last - first) * 100) / 100,
    };
  }, [balTrend]);

  // v4.2.1：聚合余额可用天数外推（净消耗速率来自 14 天快照首末已知点；数据不足/净增长时优雅降级）
  const balForecast = React.useMemo(() => (balTrendAgg ? forecastBalance(balTrendAgg.points) : null), [balTrendAgg]);

  // v4.2.1：每账号外推结果（键 providerId\0accountId → 外推；余额趋势拉取失败时为空 Map，行内不渲染）
  const accountForecast = React.useMemo(() => {
    const m = new Map<string, ReturnType<typeof forecastBalance>>();
    if (balTrend) {
      for (const acc of balTrend.accounts) {
        m.set(`${acc.providerId}\u0000${acc.accountId}`, forecastBalance(acc.points));
      }
    }
    return m;
  }, [balTrend]);

  // v3.4.0：清冷却完成回调（成功与否都刷新账号状态；徽标随新数据消失/保留）
  const handleCooldownCleared = React.useCallback(
    (message: string, ok: boolean) => {
      setCdNotice({ ok, text: message });
      void load();
    },
    [load]
  );

  const copyModel = async (m: string) => {
    try {
      await navigator.clipboard.writeText(m);
      setCopiedModel(m);
      setTimeout(() => setCopiedModel(""), 1500);
    } catch {
      /* ignore */
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="总览" description="账户总览与运行状态" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-stone-100" />
          ))}
        </div>
        <LoadingBlock rows={4} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="总览" description="账户总览与运行状态" />
        <ErrorAlert message={error} onRetry={load} />
      </div>
    );
  }

  if (!data) return null;

  const hitRate = data.cache?.hitRate ?? 0;
  const balanceVal = data.balance?.balance;
  const balanceOk = data.balance?.success !== false;
  const todayTokens = (data.today_stats?.inputTokens || 0) + (data.today_stats?.outputTokens || 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="总览"
        description="聚合余额、账号与路由状态、上游缓存命中率"
        actions={
          <div className="flex items-center gap-2">
            {/* v4.3.2：自动刷新（关/30s/60s；localStorage 持久化；页面不可见时暂停轮询） */}
            <span
              className="inline-flex items-center rounded-md border border-stone-200 bg-white p-0.5"
              role="group"
              aria-label="总览自动刷新间隔"
            >
              {([
                { v: "off", label: "关" },
                { v: "30", label: "30s" },
                { v: "60", label: "60s" },
              ] as const).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => applyAutoRefresh(o.v)}
                  aria-pressed={autoRefresh === o.v}
                  title={
                    o.v === "off"
                      ? "关闭自动刷新"
                      : `每 ${o.v} 秒自动刷新总览（页面不可见时暂停；localStorage 持久化）`
                  }
                  className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                    autoRefresh === o.v
                      ? "bg-emerald-100 text-emerald-700"
                      : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                  }`
                }
              >
                {o.label}
              </button>
              ))}
            </span>
            {autoRefresh !== "off" && (
              <span
                className="text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
                title={`下次自动刷新倒计时（每 ${autoRefresh} 秒）`}
              >
                {nextRefreshIn}s 后自动刷新
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => { void load(); loadBalTrend(); void loadInsights(mhWindow, tpWindow, sloWindow); }} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
            </Button>
          </div>
        }
      />

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="聚合余额"
          value={balanceOk ? fmtNum(balanceVal) : "—"}
          unit={data.balance?.unit || "积分"}
          hint={
            balanceOk
              ? `总量 ${fmtNum(data.balance?.total)} · ${data.balance?.accounts?.length || 0} 个账号`
              : `查询失败：${data.balance?.error || "无可用余额来源"}`
          }
          icon={<Coins className="size-4" />}
          accent="emerald"
          footer={
            balTrendAgg ? (
              <div>
                <BalanceTrendBars
                  days={balTrendAgg.days}
                  points={balTrendAgg.points}
                  className="w-full"
                  ariaLabel="近 14 天聚合余额趋势"
                />
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>近 14 天水位</span>
                  <span
                    className={
                      balTrendAgg.delta > 0
                        ? "font-medium text-emerald-600"
                        : balTrendAgg.delta < 0
                          ? "font-medium text-amber-600"
                          : undefined
                    }
                  >
                    {balTrendAgg.delta > 0 ? "+" : ""}
                    {fmtNum(balTrendAgg.delta)}（{fmtNum(balTrendAgg.first)} → {fmtNum(balTrendAgg.last)}）
                  </span>
                </div>
                {/* v4.2.1：预计可用天数外推 —— 净消耗速率线性外推；数据不足/净增长时不出数不误导 */}
                {balForecast && balForecast.kind === "limited" && (
                  <p
                    className="mt-1 flex items-center gap-1 border-t border-stone-100 pt-1 text-[10px] text-muted-foreground"
                    title={`按近 ${balForecast.spanDays + 1} 天快照外推：平均净消耗 ${fmtNum(balForecast.dailyRate)}/天（签到/充值与消耗相抵后的净速率），当前水位 ${fmtNum(balTrendAgg.last)}。假设消耗速率恒定，仅供容量规划参考。`}
                  >
                    <Hourglass className="size-3 shrink-0 text-amber-500" aria-hidden />
                    预计可用
                    <span
                      className={
                        balForecast.days <= 7
                          ? "font-semibold text-red-600"
                          : balForecast.days <= 30
                            ? "font-semibold text-amber-600"
                            : "font-medium text-emerald-700"
                      }
                    >
                      {forecastText(balForecast)}
                    </span>
                    · 净耗 {fmtNum(balForecast.dailyRate)}/天
                  </p>
                )}
                {balForecast && balForecast.kind === "growing" && (
                  <p
                    className="mt-1 flex items-center gap-1 border-t border-stone-100 pt-1 text-[10px] text-muted-foreground"
                    title="近 14 天快照窗口内余额净增长或持平（签到/充值 ≥ 消耗），无耗尽风险"
                  >
                    <Hourglass className="size-3 shrink-0 text-emerald-500" aria-hidden />
                    余额净增长/持平 · 长期可用
                  </p>
                )}
              </div>
            ) : undefined
          }
        />
        <StatCard
          label="上游账号"
          value={
            <>
              <span className="text-emerald-600">{data.accounts_enabled}</span>
              <span className="text-lg text-muted-foreground"> / {data.accounts_total}</span>
            </>
          }
          hint="启用 / 总数"
          icon={<Users className="size-4" />}
          accent="teal"
        />
        <StatCard
          label="API 中转"
          value={
            <>
              <span className="text-emerald-600">{data.providers_count}</span>
              <span className="text-lg text-muted-foreground"> / {data.providers_total}</span>
            </>
          }
          hint={
            data.providers_count < data.providers_total
              ? "调度实例 / 配置总数（新建中转需重启进程后进入调度）"
              : "调度实例 / 配置总数"
          }
          icon={<Network className="size-4" />}
          accent="stone"
        />
        <StatCard
          label="模型路由"
          value={data.routes_count}
          hint={`覆盖 ${data.available_models?.length || 0} 个可用模型`}
          icon={<RouteIcon className="size-4" />}
          accent="amber"
        />
        <StatCard
          label="缓存命中率"
          value={<span className={hitRate >= 30 ? "text-emerald-600" : undefined}>{hitRate}%</span>}
          hint={
            data.cache && data.cache.responses > 0
              ? `${data.cache.cachedResponses || 0} / ${data.cache.responses} 次有用量请求命中 · 省约 ${fmtNum(data.cache.cachedTokens || 0)} tokens（重启不丢）`
              : "尚无缓存命中 · 上游前缀缓存对重复提示词生效（如 Claude Code 固定系统提示），重复请求可省 token"
          }
          icon={<Activity className="size-4" />}
          accent="teal"
        />
        <StatCard
          label="今日消耗"
          value={
            todayTokens > 0 ? (
              <span
                title={`精确值 ${fmtNum(todayTokens)} tokens（≥ 1 万自动缩写，悬停查全量）`}
                className={data.today_stats?.successRate !== null && (data.today_stats?.successRate ?? 100) >= 80 ? "text-emerald-600" : undefined}
              >
                {fmtCompact(todayTokens)}
              </span>
            ) : (
              "0"
            )
          }
          unit="tokens"
          hint={
            data.today_stats && data.today_stats.requests > 0
              ? `${data.today_stats.requests} 次请求 · 成功率 ${data.today_stats.successRate}% · 输入 ${fmtCompact(data.today_stats.inputTokens)} / 输出 ${fmtCompact(data.today_stats.outputTokens)}${data.today_stats.cachedTokens > 0 ? ` · 缓存命中 ${fmtCompact(data.today_stats.cachedTokens)}` : ""}`
              : "今日暂无网关请求"
          }
          icon={<Gauge className="size-4" />}
          accent="amber"
          onClick={onTodayClick ? (data.today_stats && data.today_stats.requests > 0 ? onTodayClick : undefined) : undefined}
          clickHint={onTodayClick && data.today_stats && data.today_stats.requests > 0 ? "点击查看今日请求日志 →" : undefined}
        />
      </div>

      {/* v4.3.2：服务质量 SLO 卡（延迟分位数 / 成功率 / 流式占比 / 延迟分布直方图；
          窗口切换走独立 insights API 不整页重载；置于趋势卡之前 —— 运维视角第一优先级） */}
      <SloCard
        data={insights?.slo}
        windowHours={sloWindow}
        onWindowChange={setSloWindow}
        loading={insightsLoading}
      />

      {/* v3.0.4：近 24h 逐小时趋势（v3.0.5：柱可点击跳转该小时日志） */}
      {(data.trend24h?.length || 0) > 0 && <Trend24hCard buckets={data.trend24h || []} onHourClick={onHourClick} />}

      {/* v3.0.6：近 7 天日趋势（UsageDaily 聚合；点击柱跳转该天日志） */}
      {(data.trend7d?.length || 0) > 0 && <Trend7dCard days={data.trend7d || []} prev={data.trend7d_prev} onDayClick={onDayClick} />}

      {/* v3.2.0：近 7 天用量透视（提供商 × 密钥 × 日期三维视角；折叠懒加载不抢占首屏） */}
      <UsagePivotCard />

      {/* 最近签到 / 刷新 + 今日 Top 密钥排行（v3.1.1）+ 今日 Top 模型排行（v3.9.0）+ 密钥提示 */}
      {/* v3.9.0：xl 6 列网格 —— 上排三张小卡各占 2，下排双排行卡各占 3（排行卡信息密度高，宽版更易读） */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <div className="rounded-xl border border-stone-200 bg-white p-4 xl:col-span-2">
          <p className="text-sm font-medium text-stone-700">最近每日签到</p>
          <p className="mt-2 text-lg font-semibold tabular-nums text-stone-900">
            {data.last_checkin ? relativeTime(data.last_checkin.time) : "尚未签到"}
          </p>
          {data.last_checkin && (
            <p className="mt-1 text-xs text-muted-foreground">
              触发提供商 {data.last_checkin.provider} · {data.last_checkin.details.length} 个账号 ·
              成功 {data.last_checkin.details.filter((d) => d.success).length} 个
            </p>
          )}
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-4 xl:col-span-2">
          <p className="text-sm font-medium text-stone-700">最近 Token 刷新</p>
          <p className="mt-2 text-lg font-semibold tabular-nums text-stone-900">
            {data.last_refresh ? relativeTime(data.last_refresh) : "尚未刷新"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">签到与保活任务可在「定时任务」中配置</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-4 xl:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-stone-700">当前可用模型</p>
            {data.available_models?.length > 0 && (
              <CopyButton
                text={data.available_models.join("\n")}
                label="复制全部"
                variant="secondary"
              />
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(data.available_models || []).slice(0, 12).map((m) => (
              <Badge
                key={m}
                variant="outline"
                className="cursor-pointer border-stone-200 bg-stone-50 font-mono text-[11px] text-stone-700 hover:border-emerald-300 hover:bg-emerald-50"
                onClick={() => copyModel(m)}
                title="点击复制"
              >
                {copiedModel === m && <Check className="text-emerald-600" />}
                {m}
              </Badge>
            ))}
            {(data.available_models?.length || 0) > 12 && (
              <Badge variant="outline" className="border-stone-200 bg-stone-50 text-[11px] text-stone-500">
                +{data.available_models.length - 12} 个
              </Badge>
            )}
            {(data.available_models?.length || 0) === 0 && (
              <p className="text-xs text-muted-foreground">暂无路由或免费模型池</p>
            )}
          </div>
        </div>
        {/* v3.1.1：今日 Top 密钥排行（第六跳转通道：点击行 → 该密钥今日日志）；v3.2.0：昨日兕底标注 */}
        <div className="xl:col-span-3">
          <TopKeysCard
            rows={data.today_top_keys || []}
            date={data.top_keys_date}
            todayKey={new Date().toLocaleDateString("sv-SE")}
            onKeyClick={onKeyClick}
          />
        </div>
        {/* v3.9.0：今日 Top 模型排行（与 Top 密钥对称；点击行 → 该模型今日日志，复用第八跳转通道） */}
        <div className="xl:col-span-3">
          <TopModelsCard
            rows={data.today_top_models || []}
            date={data.top_models_date}
            todayKey={new Date().toLocaleDateString("sv-SE")}
            onModelClick={onModelClick}
          />
        </div>
        {/* v4.2.1：Top 提供商排行（UsageDaily 持久聚合；v4.2.4：窗口可选 7/14/30 天，独立 API 拉取） */}
        <div className="xl:col-span-3">
          <TopProvidersCard
            rows={insights?.top_providers_7d || []}
            windowDays={tpWindow}
            onWindowChange={setTpWindow}
            loading={insightsLoading}
          />
        </div>
        {/* v4.2.1：模型健康 sparkline（v4.2.3b：窗口可选 7/14/30 天；点击行 → 该模型今日日志；v4.2.4 独立 API 拉取） */}
        <div className="xl:col-span-3">
          <ModelHealthCard
            data={insights?.model_health}
            windowDays={mhWindow}
            onWindowChange={setMhWindow}
            loading={insightsLoading}
            onModelClick={onModelClick}
          />
        </div>
      </div>

      {/* 账号状态表 */}
      <div className="rounded-xl border border-stone-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
          <p className="text-sm font-medium text-stone-700">账号状态</p>
          <div className="flex min-w-0 items-center gap-2">
            {cdNotice && (
              <span
                role="status"
                className={`truncate rounded-md px-2 py-0.5 text-xs font-medium ${
                  cdNotice.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
                }`}
              >
                {cdNotice.text}
              </span>
            )}
            <span className="shrink-0 text-xs text-muted-foreground">
              共 {data.accounts.length} 个账号 · 冷却中的账号将被调度器暂时绕过
            </span>
          </div>
        </div>
        {data.accounts.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Users className="size-6" />}
              title="尚未配置任何上游账号"
              description="前往「API 中转」添加提供商，或在「账号管理」中批量导入已有账号。"
            />
          </div>
        ) : (
          <TooltipProvider delayDuration={200}>
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-white">
                  <TableRow>
                    <TableHead>账号</TableHead>
                    <TableHead className="hidden sm:table-cell">提供商</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="hidden md:table-cell">余额</TableHead>
                    <TableHead className="hidden lg:table-cell">最近签到</TableHead>
                    <TableHead className="hidden lg:table-cell">最近刷新</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.accounts.map((a) => {
                    const bal = a.balance as { balance?: number; total?: number } | null;
                    const cd = cooldownRemaining(a.cooldownUntil);
                    // v4.2.1：该账号余额可用天数外推（快照序列缺失/数据不足时为 null → 不渲染）
                    const fc = accountForecast.get(`${a.providerId}\u0000${a.id}`);
                    return (
                      <TableRow key={`${a.providerId}/${a.id}`}>
                        <TableCell className="font-medium text-stone-800">
                          <span className="flex items-center gap-2">
                            {a.enabled ? (
                              <span className="size-1.5 rounded-full bg-emerald-500" aria-label="启用" />
                            ) : (
                              <span className="size-1.5 rounded-full bg-stone-300" aria-label="停用" />
                            )}
                            {a.name}
                            <code className="hidden rounded bg-stone-100 px-1 text-[10px] text-stone-500 sm:inline">{a.id}</code>
                          </span>
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs text-stone-500 sm:table-cell">{a.providerId}</TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {a.enabled ? (
                              <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[11px] text-emerald-700">启用</Badge>
                            ) : (
                              <Badge variant="outline" className="border-stone-200 bg-stone-50 text-[11px] text-stone-500">停用</Badge>
                            )}
                            <CooldownDot remaining={cd} streak={a.cooldownStreak} reason={a.cooldownReason} />
                            {cd && (
                              <ClearCooldownButton
                                providerId={a.providerId}
                                accountId={a.id}
                                accountName={a.name}
                                onCleared={handleCooldownCleared}
                              />
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="hidden tabular-nums md:table-cell">
                          {bal && typeof bal.balance === "number" ? (
                            <span className="flex flex-col gap-0.5">
                              <span className="flex items-center gap-1">
                                <CircleDollarSign className="size-3.5 text-stone-400" />
                                {fmtNum(bal.balance)}
                              </span>
                              {/* v4.2.1：预计可用天数行内徽标（净消耗外推；≤7 天红 / ≤30 天黄 / 其余绿；净增长显示「长期」） */}
                              {fc && (
                                <span
                                  className={`inline-flex w-fit items-center gap-0.5 rounded px-1 py-px text-[10px] font-medium ${
                                    fc.kind === "growing"
                                      ? "bg-emerald-50 text-emerald-700"
                                      : fc.days <= 7
                                        ? "bg-red-50 text-red-600"
                                        : fc.days <= 30
                                          ? "bg-amber-50 text-amber-700"
                                          : "bg-emerald-50 text-emerald-700"
                                  }`}
                                  title={
                                    fc.kind === "growing"
                                      ? "近 14 天快照窗口内余额净增长/持平，无耗尽风险"
                                      : `按近 ${fc.spanDays + 1} 天快照外推：净消耗 ${fmtNum(fc.dailyRate)}/天，预计可用 ${fc.days} 天（假设速率恒定，仅供参考）`
                                  }
                                >
                                  <Hourglass className="size-2.5" aria-hidden />
                                  {forecastText(fc)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {a.lastCheckinAt ? (
                            <span className="flex items-center gap-1.5">
                              {a.lastCheckinOk === true && <Check className="size-3.5 text-emerald-600" />}
                              {a.lastCheckinOk === false && <X className="size-3.5 text-red-500" />}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-default text-xs text-muted-foreground">{relativeTime(a.lastCheckinAt)}</span>
                                </TooltipTrigger>
                                <TooltipContent>{a.lastCheckinAt}</TooltipContent>
                              </Tooltip>
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">未签到</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                          {a.lastRefreshAt ? relativeTime(a.lastRefreshAt) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>
        )}
      </div>

      {error && <ErrorAlert message={error} onRetry={load} />}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Snowflake className="size-3" />
        冷却中的账号按指数退避（1→2→4→8 分钟封顶）自动恢复；连续失败次数越多冷却越久。
        <Layers className="ml-2 size-3" />
        缓存命中基于请求日志滚动窗口持久统计（仅计上游报告了精确用量的请求）。
        <Copy className="ml-2 size-3" />
        点击模型徽章可复制模型名。
        {onHourClick && (
          <>
            <Activity className="ml-2 size-3" />
            点击趋势柱可跳转查看该小时/该天的请求日志。
          </>
        )}
      </p>
    </div>
  );
}
