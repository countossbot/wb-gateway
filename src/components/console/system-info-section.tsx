// 系统信息 Section（v4.9.1 新增）—— 网关自身运行时状态可视化
// 展示：版本/运行时/数据库/调度器四块；自动每 30s 刷新 + 手动刷新按钮
// 数据源：GET /api/console/system-info（仅控制台会话可访问）
"use client";

import * as React from "react";
import {
  Activity,
  ChevronDown,
  Clock,
  Cpu,
  Database,
  HardDrive,
  Loader2,
  RefreshCcw,
  Server,
  Timer,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/console/settings-sections";
import { apiGet, errMessage } from "@/lib/console/api";
import { relativeTime } from "@/lib/console/format";
import { forecastRss, formatForecastHint, type ForecastResult } from "@/lib/console/rssForecast";

interface SystemInfoData {
  version: string;
  runtime: {
    nodeVersion: string;
    bunVersion: string | null;
    platform: string;
    arch: string;
    uptimeSec: number;
    uptimeHuman: string;
    startedAt: string;
  };
  memory: {
    rssBytes: number;
    rssHuman: string;
    heapUsedHuman: string;
    heapTotalHuman: string;
    externalHuman: string;
    // v4.9.2：RSS 历史 sparkline 数据
    rssHistory?: Array<{
      at: string;
      ts: number;
      rss: number;
      heapUsed: number;
      heapTotal: number;
      external: number;
    }>;
    metricsStartedAt?: string;
  };
  db: {
    dialect: string;
    filePath: string;
    fileSizeBytes: number;
    fileSizeHuman: string;
    walSizeBytes: number;
    walSizeHuman: string;
    tableCounts: Record<string, number>;
  };
  scheduler: {
    tickIntervalSec: number;
    startedAt: string;
    settings: {
      checkinEnabled: boolean;
      checkinCron: string;
      checkinTz: string;
      keepaliveEnabled: boolean;
      keepaliveCron: string;
      keepaliveTz: string;
    };
    lastRuns: Record<string, { job: string; triggered: string; success: boolean; startedAt: string; detail: unknown } | null>;
    nextCron: {
      checkin: { at: string; inSeconds: number; inHuman: string } | null;
      keepalive: { at: string; inSeconds: number; inHuman: string } | null;
    };
  };
}

/** v4.9.3：客户端实时倒计时 —— 接收目标 ISO 时间，每秒重算「还剩 Xd Yh Zm Zs」 */
function LiveCountdown({ targetIso, fallbackHuman }: { targetIso: string | null; fallbackHuman?: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!targetIso) {
    return <span className="text-stone-400">{fallbackHuman ? `${fallbackHuman} 后` : "—"}</span>;
  }
  const targetMs = new Date(targetIso).getTime();
  const remainingMs = targetMs - now;
  if (Number.isNaN(targetMs)) {
    return <span className="text-stone-400">—</span>;
  }
  if (remainingMs <= 0) {
    // 已到触发时间但下次轮询还没刷新（30s API 周期 vs 1s 客户端）
    return (
      <span className="inline-flex items-center gap-1 text-amber-600">
        <span className="size-1 animate-pulse rounded-full bg-amber-500" aria-hidden />
        即将触发…
      </span>
    );
  }
  const totalSec = Math.floor(remainingMs / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return (
    <span className="inline-flex items-center gap-1 text-emerald-700 tabular-nums" title={`目标时间：${targetIso}`}>
      <span className="size-1 animate-pulse rounded-full bg-emerald-500" aria-hidden />
      {parts.join(" ")} 后
    </span>
  );
}

/** v4.9.3：WAL 增长可视化条 —— 当前 WAL / 512KB TRUNCATE 阈值比例 */
function WalGrowthBar({ walSizeBytes }: { walSizeBytes: number }) {
  // 调度器在 WAL ≥ 512KB 时提前 TRUNCATE（scheduler.ts WAL_TRUNCATE_THRESHOLD_BYTES）
  const TRUNCATE_THRESHOLD = 512 * 1024;
  const ratio = Math.min(1, walSizeBytes / TRUNCATE_THRESHOLD);
  const percent = (ratio * 100).toFixed(1);
  const color = ratio > 0.8 ? "bg-amber-500" : ratio > 0.5 ? "bg-sky-500" : "bg-emerald-400";
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-[10px] text-stone-400">
        <span>WAL 增长（阈值 512KB → 调度器自动 TRUNCATE）</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-stone-200">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-stone-600">{label}</p>
        {hint && <p className="text-[11px] text-stone-400">{hint}</p>}
      </div>
      <div className={`text-right text-xs ${mono ? "font-mono" : ""} text-stone-900`}>{value}</div>
    </div>
  );
}

function MiniStat({
  icon,
  label,
  value,
  accent = "stone",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: "stone" | "emerald" | "amber" | "sky";
}) {
  const accentMap: Record<string, string> = {
    stone: "bg-stone-50 text-stone-700 border-stone-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    sky: "bg-sky-50 text-sky-700 border-sky-200",
  };
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${accentMap[accent]}`}>
      <span className="size-4 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wide opacity-70">{label}</p>
        <p className="truncate text-xs font-semibold">{value}</p>
      </div>
    </div>
  );
}

/** v4.9.2：纯 SVG sparkline —— 不引入 recharts 等重依赖，自适应宽度。
 *  v4.9.6：增预测延伸线（线性回归外推 30 分钟，dashed + projected point + tooltip）。 */
function RssSparkline({
  samples,
  currentRss,
  limitBytes,
}: {
  samples: Array<{ ts: number; rss: number; heapUsed?: number; heapTotal?: number; external?: number }>;
  currentRss: number;
  limitBytes: number;
}) {
  if (!samples || samples.length === 0) {
    return (
      <div className="flex h-12 items-center justify-center rounded-md border border-dashed border-stone-200 text-[10px] text-stone-400">
        采样启动中，60s 后可见趋势…
      </div>
    );
  }
  // SVG viewBox：宽 110（v4.9.6 增 10 给预测线延伸空间），高 30
  const W = 110;
  const H = 30;
  const padY = 3;
  const forecastZoneStart = 100; // 0-100 为实测样本区，100-110 为预测延伸区
  // y 轴范围：0 ~ max(rss, limit) — 让 4GB 上限始终可见作为参考线
  const maxRss = Math.max(...samples.map((s) => s.rss), currentRss, limitBytes);
  const yScale = (v: number) => H - padY - (v / maxRss) * (H - padY * 2);
  // x 轴：实测样本按索引在 0-100 区间分布
  const xFor = (i: number) => samples.length === 1 ? forecastZoneStart / 2 : (i / (samples.length - 1)) * forecastZoneStart;

  // 构造路径（折线）
  const linePath = samples
    .map((s, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)},${yScale(s.rss).toFixed(2)}`)
    .join(" ");
  // 区域填充路径（折线 + 底部闭合）
  const areaPath = `${linePath} L${forecastZoneStart.toFixed(2)},${H} L0,${H} Z`;

  const peak = samples.reduce((a, b) => (b.rss > a.rss ? b : a), samples[0]);
  const latest = samples[samples.length - 1];
  // 颜色：按当前 RSS 占 4GB 比例
  const ratio = currentRss / limitBytes;
  const strokeColor = ratio > 0.75 ? "#ef4444" : ratio > 0.5 ? "#f59e0b" : "#10b981";
  const fillColor = ratio > 0.75 ? "#fee2e2" : ratio > 0.5 ? "#fef3c7" : "#d1fae5";

  // v4.9.6：线性回归外推 30 分钟
  const forecast: ForecastResult | null = forecastRss(samples, 30 * 60 * 1000, limitBytes);
  // 预测线起点 = 最新样本位置；终点 = 预测点（在 forecastZone 100-110 之间）
  const forecastLinePath = forecast
    ? `M${xFor(samples.length - 1).toFixed(2)},${yScale(latest.rss).toFixed(2)} L${W.toFixed(2)},${yScale(forecast.projectedBytes).toFixed(2)}`
    : null;
  // 预测点颜色：projected > 3GB red / > 2GB amber / else 同实测色
  const forecastPointColor = forecast
    ? forecast.projectedBytes > limitBytes * 0.75
      ? "#ef4444"
      : forecast.projectedBytes > limitBytes * 0.5
        ? "#f59e0b"
        : strokeColor
    : strokeColor;
  const forecastHint = forecast ? formatForecastHint(forecast, limitBytes) : null;
  const forecastExceedsLimit = forecast ? forecast.projectedBytes > limitBytes : false;

  return (
    <div className="rounded-md border border-stone-200 bg-stone-50/50 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px] text-stone-500">
        <span>RSS 趋势 · {samples.length} 个样本 · 最早 {samples.length > 0 ? new Date(samples[0].ts).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
        <span>峰值 {(peak.rss / 1024 / 1024).toFixed(0)}MB</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-12 w-full" role="img" aria-label="RSS 历史趋势与 30 分钟预测">
        {/* 4GB 上限参考线 */}
        <line
          x1="0"
          y1={yScale(limitBytes).toFixed(2)}
          x2={W}
          y2={yScale(limitBytes).toFixed(2)}
          stroke="#fca5a5"
          strokeWidth="0.4"
          strokeDasharray="1.5,1"
        />
        {/* v4.9.6：预测区域分隔虚线（x=100 处） */}
        {forecast && (
          <line
            x1={forecastZoneStart}
            y1="0"
            x2={forecastZoneStart}
            y2={H}
            stroke="#cbd5e1"
            strokeWidth="0.3"
            strokeDasharray="0.8,0.8"
          />
        )}
        {/* 区域填充 */}
        <path d={areaPath} fill={fillColor} opacity="0.6" />
        {/* 折线 */}
        <path d={linePath} fill="none" stroke={strokeColor} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        {/* v4.9.6：预测延伸线（dashed） */}
        {forecastLinePath && (
          <path
            d={forecastLinePath}
            fill="none"
            stroke={forecastPointColor}
            strokeWidth="0.8"
            strokeLinecap="round"
            strokeDasharray="1.5,1"
            opacity="0.7"
          />
        )}
        {/* v4.9.6：预测点（菱形 diamond 形态以区分实测点） */}
        {forecast && (
          <g>
            <rect
              x={(W - 1).toFixed(2)}
              y={(yScale(forecast.projectedBytes) - 1).toFixed(2)}
              width="2"
              height="2"
              transform={`rotate(45 ${W} ${yScale(forecast.projectedBytes)})`}
              fill={forecastPointColor}
              opacity="0.9"
            >
              <title>{forecastHint ?? ""}</title>
            </rect>
            {forecastExceedsLimit && (
              <circle
                cx={W}
                cy={yScale(forecast.projectedBytes)}
                r="2"
                fill="none"
                stroke="#ef4444"
                strokeWidth="0.4"
                opacity="0.6"
              >
                <title>{`⚠️ 预测 30 分钟后 RSS 将超过 4GB 上限！\n${forecastHint}`}</title>
              </circle>
            )}
          </g>
        )}
        {/* v4.9.3：每个样本点的 hover 命中区域 + native <title> tooltip（r=3 透明圆） */}
        {samples.map((s, i) => (
          <circle
            key={`hit-${i}`}
            cx={xFor(i).toFixed(2)}
            cy={yScale(s.rss).toFixed(2)}
            r="3"
            fill="transparent"
            style={{ cursor: "pointer" }}
          >
            <title>
              {`时间：${new Date(s.ts).toLocaleTimeString("zh-CN", { hour12: false })}\n` +
                `RSS：${(s.rss / 1024 / 1024).toFixed(1)}MB（${((s.rss / limitBytes) * 100).toFixed(1)}%）\n` +
                `Heap：${((s.heapUsed ?? 0) / 1024 / 1024).toFixed(1)}MB / ${((s.heapTotal ?? 0) / 1024 / 1024).toFixed(1)}MB\n` +
                `External：${((s.external ?? 0) / 1024 / 1024).toFixed(1)}MB`}
            </title>
          </circle>
        ))}
        {/* 峰值点（如果不是最新）—— 可见，r=1.2 半透明 */}
        {peak !== latest && (
          <circle cx={xFor(samples.indexOf(peak)).toFixed(2)} cy={yScale(peak.rss).toFixed(2)} r="1.2" fill={strokeColor} fillOpacity="0.5" />
        )}
        {/* 最新点高亮 —— 可见，r=1.4 */}
        <circle cx={xFor(samples.length - 1).toFixed(2)} cy={yScale(latest.rss).toFixed(2)} r="1.4" fill={strokeColor} />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-stone-500">
        <span>
          采样起始 {new Date(samples[0].ts).toLocaleTimeString("zh-CN", { hour12: false })}
        </span>
        <span>
          当前 {(currentRss / 1024 / 1024).toFixed(0)}MB / 上限 {(limitBytes / 1024 / 1024 / 1024).toFixed(0)}GB · {((currentRss / limitBytes) * 100).toFixed(1)}%
        </span>
      </div>
      {/* v4.9.6：预测摘要行 */}
      {forecast && (
        <div className="mt-1.5 flex items-center justify-between rounded border border-stone-200 bg-white/60 px-2 py-1 text-[10px]">
          <span className="flex items-center gap-1 text-stone-500">
            <span className="inline-block size-1 rotate-45 bg-stone-400" aria-hidden />
            30 分钟预测
          </span>
          <span className={`tabular-nums font-medium ${forecastExceedsLimit ? "text-red-600" : forecast.projectedBytes > limitBytes * 0.75 ? "text-amber-600" : "text-stone-700"}`}>
            {(forecast.projectedBytes / 1024 / 1024).toFixed(0)}MB（{((forecast.projectedBytes / limitBytes) * 100).toFixed(1)}%）
            <span className="ml-1 text-stone-400">R²={forecast.rSquared.toFixed(2)}</span>
            {forecastExceedsLimit && <span className="ml-1 text-red-500">⚠️ 超限</span>}
          </span>
        </div>
      )}
    </div>
  );
}

/** v4.9.2：表行数网格（可展开/折叠） */
function TableCountsGrid({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  const [expanded, setExpanded] = React.useState(false);
  const shown = expanded ? entries : entries.slice(0, 9);
  const hiddenCount = entries.length - 9;

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wide text-stone-400">表行数</p>
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-expanded={expanded}
          >
            {expanded ? "收起" : `展开全部 (${hiddenCount} 张)`}
            <ChevronDown className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
      <div className={`grid grid-cols-3 gap-1.5 ${expanded ? "max-h-72 overflow-y-auto" : ""}`}>
        {shown.map(([name, count]) => (
          <div key={name} className="rounded border border-stone-200 bg-white px-2 py-1">
            <p className="truncate text-[10px] text-stone-500" title={name}>{name}</p>
            <p className={`text-xs font-semibold ${count > 0 ? "text-stone-900" : "text-stone-300"}`}>{count}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SystemInfoSection() {
  const [info, setInfo] = React.useState<SystemInfoData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState<number | null>(null);

  const fetchInfo = React.useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const data = await apiGet<SystemInfoData>("/api/console/system-info");
      setInfo(data);
      setLastUpdated(Date.now());
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    fetchInfo();
    const t = setInterval(() => fetchInfo(true), 30_000);
    return () => clearInterval(t);
  }, [fetchInfo]);

  return (
    <Section
      icon={<Activity className="size-4.5" />}
      title="系统信息"
      description="网关进程运行时状态 · 数据库文件大小 · 调度器与定时任务 · 30 秒自动刷新"
      actions={
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden text-[11px] text-stone-400 sm:inline">
              更新于 {relativeTime(new Date(lastUpdated).toISOString())}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchInfo(true)}
            disabled={refreshing}
          >
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw />}
            <span className="hidden sm:inline">刷新</span>
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-8 text-sm text-stone-400">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载系统信息中…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : info ? (
        <div className="space-y-4">
          {/* 顶部 4 个迷你统计卡 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniStat
              icon={<Server className="size-4" />}
              label="运行时"
              value={`Node ${info.runtime.nodeVersion.split("v")[1] || info.runtime.nodeVersion}`}
              accent="sky"
            />
            <MiniStat
              icon={<Timer className="size-4" />}
              label="运行时长"
              value={info.runtime.uptimeHuman}
              accent="emerald"
            />
            <MiniStat
              icon={<Database className="size-4" />}
              label="数据库"
              value={info.db.dialect.toUpperCase()}
              accent="emerald"
            />
            <MiniStat
              icon={<HardDrive className="size-4" />}
              label="DB 文件"
              value={info.db.fileSizeHuman}
              accent="amber"
            />
          </div>

          {/* 详细网格 */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* 运行时 */}
            <div className="rounded-lg border border-stone-200 bg-stone-50/50 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Cpu className="size-3.5 text-stone-500" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">运行时</h3>
              </div>
              <div className="divide-y divide-stone-100">
                <StatRow label="网关版本" value={<Badge variant="outline" className="font-mono text-[10px]">v{info.version}</Badge>} />
                <StatRow label="Node.js" value={info.runtime.nodeVersion} mono />
                <StatRow
                  label="Bun"
                  value={info.runtime.bunVersion ?? "—"}
                  mono
                  hint={info.runtime.bunVersion ? "运行在 Bun 上" : "未启用 Bun"}
                />
                <StatRow label="平台" value={`${info.runtime.platform} / ${info.runtime.arch}`} mono />
                <StatRow
                  label="进程启动"
                  value={relativeTime(info.runtime.startedAt)}
                  hint={new Date(info.runtime.startedAt).toLocaleString()}
                />
                <StatRow label="运行时长" value={<span className="font-semibold text-emerald-700">{info.runtime.uptimeHuman}</span>} />
              </div>
            </div>

            {/* 内存 */}
            <div className="rounded-lg border border-stone-200 bg-stone-50/50 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Activity className="size-3.5 text-stone-500" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">内存占用</h3>
              </div>
              <div className="divide-y divide-stone-100">
                <StatRow label="RSS（驻留集）" value={<span className="font-semibold text-amber-700">{info.memory.rssHuman}</span>} hint="进程实际占用物理内存" />
                <StatRow label="Heap Used" value={info.memory.heapUsedHuman} mono hint="V8 已使用堆" />
                <StatRow label="Heap Total" value={info.memory.heapTotalHuman} mono hint="V8 已分配堆" />
                <StatRow label="External" value={info.memory.externalHuman} mono hint="C++ 对象（Buffer 等）" />
              </div>
              {/* RSS 可视化条（粗略比例：rss / 4GB） + 历史趋势 sparkline */}
              <div className="mt-3 space-y-2">
                <div>
                  <div className="mb-1 flex items-center justify-between text-[10px] text-stone-400">
                    <span>RSS 占用 vs 4GB 上限</span>
                    <span>{((info.memory.rssBytes / (4 * 1024 * 1024 * 1024)) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
                    <div
                      className={`h-full rounded-full transition-all ${
                        info.memory.rssBytes > 3 * 1024 * 1024 * 1024
                          ? "bg-red-500"
                          : info.memory.rssBytes > 2 * 1024 * 1024 * 1024
                            ? "bg-amber-500"
                            : "bg-emerald-500"
                      }`}
                      style={{ width: `${Math.min(100, (info.memory.rssBytes / (4 * 1024 * 1024 * 1024)) * 100)}%` }}
                    />
                  </div>
                </div>
                {/* v4.9.2：RSS 历史 sparkline（30 分钟窗口，60s 采样） */}
                <RssSparkline
                  samples={info.memory.rssHistory ?? []}
                  currentRss={info.memory.rssBytes}
                  limitBytes={4 * 1024 * 1024 * 1024}
                />
              </div>
            </div>

            {/* 数据库 */}
            <div className="rounded-lg border border-stone-200 bg-stone-50/50 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Database className="size-3.5 text-stone-500" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">数据库</h3>
              </div>
              <div className="divide-y divide-stone-100">
                <StatRow label="方言" value={<Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">{info.db.dialect}</Badge>} />
                <StatRow label="连接 / 文件" value={<span className="block max-w-[200px] truncate" title={info.db.filePath}>{info.db.filePath || "—"}</span>} mono />
                <StatRow label="数据库大小" value={<span className="font-semibold">{info.db.fileSizeHuman}</span>} hint={info.db.dialect === "sqlite" ? undefined : "远程 PG，大小由 Aiven 托管"} />
                {info.db.dialect === "sqlite" && (
                  <StatRow label="WAL 大小" value={info.db.walSizeHuman} mono hint="Write-Ahead Log；调度器每小时或超 512KB 时 TRUNCATE" />
                )}
              </div>
              {/* v4.9.3：WAL 增长可视化条（仅 SQLite 本地部署时显示） */}
              {info.db.dialect === "sqlite" && info.db.walSizeBytes > 0 && (
                <WalGrowthBar walSizeBytes={info.db.walSizeBytes} />
              )}
              {/* v4.9.2：表行数网格（可展开/折叠，全 17 张表） */}
              <TableCountsGrid counts={info.db.tableCounts} />
            </div>

            {/* 调度器 */}
            <div className="rounded-lg border border-stone-200 bg-stone-50/50 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Clock className="size-3.5 text-stone-500" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">调度器</h3>
              </div>
              <div className="divide-y divide-stone-100">
                <StatRow
                  label="Tick 周期"
                  value={`${info.scheduler.tickIntervalSec}s`}
                  mono
                  hint="调度器轮询间隔"
                />
                <StatRow
                  label="签到 (Checkin)"
                  value={
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={`px-1.5 py-0 text-[10px] ${
                          info.scheduler.settings.checkinEnabled
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-stone-200 bg-stone-50 text-stone-500"
                        }`}
                      >
                        {info.scheduler.settings.checkinEnabled ? "启用" : "停用"}
                      </Badge>
                      <code className="font-mono text-[11px] text-stone-700">{info.scheduler.settings.checkinCron}</code>
                    </div>
                  }
                />
                <StatRow
                  label="下次签到"
                  value={<LiveCountdown targetIso={info.scheduler.nextCron.checkin?.at ?? null} fallbackHuman={info.scheduler.nextCron.checkin?.inHuman} />}
                />
                <StatRow
                  label="保活 (Keepalive)"
                  value={
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={`px-1.5 py-0 text-[10px] ${
                          info.scheduler.settings.keepaliveEnabled
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-stone-200 bg-stone-50 text-stone-500"
                        }`}
                      >
                        {info.scheduler.settings.keepaliveEnabled ? "启用" : "停用"}
                      </Badge>
                      <code className="font-mono text-[11px] text-stone-700">{info.scheduler.settings.keepaliveCron}</code>
                    </div>
                  }
                />
                <StatRow
                  label="下次保活"
                  value={<LiveCountdown targetIso={info.scheduler.nextCron.keepalive?.at ?? null} fallbackHuman={info.scheduler.nextCron.keepalive?.inHuman} />}
                />
              </div>
              {/* 最近任务执行 */}
              <div className="mt-3">
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">最近执行</p>
                <div className="space-y-1">
                  {(["checkin", "keepalive"] as const).map((job) => {
                    const r = info.scheduler.lastRuns[job];
                    return (
                      <div key={job} className="flex items-center justify-between rounded border border-stone-200 bg-white px-2 py-1">
                        <span className="text-[11px] text-stone-600">{job === "checkin" ? "签到" : "保活"}</span>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={`px-1 py-0 text-[9px] ${
                              r?.success
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-red-200 bg-red-50 text-red-700"
                            }`}
                          >
                            {r ? (r.success ? "成功" : "失败") : "—"}
                          </Badge>
                          <span className="text-[10px] text-stone-400">
                            {r ? relativeTime(r.startedAt) : "从未执行"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
