// 运行时健康徽章（v4.9.3 引入，v4.9.5 重构用 useRuntimeHealth 共享 Hook）
//
// 用途：让管理员从任何 tab 都能一眼看到 RSS 占用与进程健康度，提前预警 OOM（4GB 沙箱上限）。
// Task 65 警示「RSS 已涨至 4GB 上限 32%，建议 sidebar 加角标提示」的闭环。
//
// v4.9.5 重构：抽取 useRuntimeHealth 共享 Hook，与 RssAlertBanner 复用同一数据源 +
// 全局 singleflight 防止双组件 mount 时的重复请求。
"use client";

import * as React from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { useRuntimeHealth, formatBytes, formatUptime, type HealthLevel } from "@/lib/console/useRuntimeHealth";

const LEVEL_STYLES: Record<HealthLevel, { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-emerald-500", text: "text-emerald-700", label: "正常" },
  warn: { dot: "bg-amber-500", text: "text-amber-700", label: "警戒" },
  danger: { dot: "bg-red-500 animate-pulse", text: "text-red-700", label: "高危" },
  loading: { dot: "bg-stone-300", text: "text-stone-500", label: "采样中" },
};

/**
 * 运行时健康徽章 —— 全局展示 RSS + 运行时长 + 健康度彩色 dot。
 * 在 sidebar footer 与 mobile sheet footer 渲染。
 */
export function RuntimeHealthBadge() {
  const health = useRuntimeHealth();
  const style = LEVEL_STYLES[health.level];
  const tooltip = !health.loading
    ? `RSS ${health.rssHuman} / 4GB (${health.percent.toFixed(1)}%) · 运行 ${formatUptime(health.uptimeSec)} · ${style.label}`
    : "采样中…";

  return (
    <div className="mt-1.5 flex items-center justify-between" title={tooltip}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-500">
        <Activity className="size-3 text-stone-400" />
        运行时
      </span>
      <div className="flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${style.dot}`} aria-label={style.label} />
        <span className={`font-mono text-[10px] tabular-nums ${style.text}`}>
          {!health.loading && health.rssBytes > 0
            ? `${formatBytes(health.rssBytes)} · ${formatUptime(health.uptimeSec)}`
            : "—"}
        </span>
        {health.level === "danger" && <AlertTriangle className="size-3 text-red-500" aria-label="高危" />}
      </div>
    </div>
  );
}
