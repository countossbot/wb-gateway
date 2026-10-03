// RSS 高水位告警横幅（v4.9.5 新增）
//
// 用途：当 RSS 跨越 2GB（amber 警戒）或 3GB（red 高危）阈值时，在主内容区顶部显示
// 一条不可忽略的横幅告警，让管理员从任何 tab 都能看到内存风险。
//
// Task 68 顺延项「超 2GB 时 sidebar 顶部加红色横幅告警 / 超 3GB 时自动触发 GC」的闭环。
//
// 设计：
//   - 复用 useRuntimeHealth 共享 Hook（与 RuntimeHealthBadge 同一数据源 + singleflight）
//   - level === "ok" 或 "loading" 时不渲染（零成本）
//   - level === "warn"（2-3GB）：amber 横幅 + 提示「RSS 已达 X%，建议关注内存增长」
//   - level === "danger"（> 3GB）：red 横幅 + 强提示「RSS 已达 X%，接近 4GB 上限，存在 OOM 风险」
//   - 可关闭（per-session sessionStorage 记忆；下次刷新页面重新出现，确保不被永久忽略）
//   - 不影响 layout 流（绝对定位 sticky 在 main 顶部，与 page header 共享空间）
"use client";

import * as React from "react";
import { AlertTriangle, X, TrendingUp } from "lucide-react";
import { useRuntimeHealth } from "@/lib/console/useRuntimeHealth";

const SESSION_STORAGE_KEY = "__uag_rss_alert_dismissed_level__";

/**
 * 读取 sessionStorage 中已 dismiss 的告警等级（仅当当前等级 > 已 dismiss 等级时重新显示）
 * —— 让用户 dismiss warn 后，若升级到 danger 时横幅再次出现（避免一次 dismiss 永久忽略）
 */
function getDismissedLevel(): "warn" | "danger" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    return v === "warn" || v === "danger" ? v : null;
  } catch {
    return null;
  }
}

function setDismissedLevel(level: "warn" | "danger") {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, level);
  } catch {
    // 静默：sessionStorage 不可用不应阻塞告警显示
  }
}

const LEVEL_SEVERITY: Record<string, number> = { ok: 0, loading: 0, warn: 1, danger: 2 };

export function RssAlertBanner() {
  const health = useRuntimeHealth();
  const [dismissed, setDismissed] = React.useState<"warn" | "danger" | null>(null);

  // 首次 mount 读取 sessionStorage
  React.useEffect(() => {
    setDismissed(getDismissedLevel());
  }, []);

  // 不显示条件：加载中 / ok / 已 dismiss 且当前等级 ≤ dismissed
  if (health.loading || health.level === "ok" || health.level === "loading") {
    return null;
  }
  const currentLevel = health.level as "warn" | "danger";
  if (dismissed && LEVEL_SEVERITY[currentLevel] <= LEVEL_SEVERITY[dismissed]) {
    return null;
  }

  const isDanger = currentLevel === "danger";
  const handleDismiss = () => {
    setDismissedLevel(currentLevel);
    setDismissed(currentLevel);
  };

  return (
    <div
      role="alert"
      className={`mb-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-sm ${
        isDanger
          ? "border-red-300 bg-red-50 text-red-900"
          : "border-amber-300 bg-amber-50 text-amber-900"
      }`}
    >
      <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${
        isDanger ? "bg-red-500 text-white animate-pulse" : "bg-amber-500 text-white"
      }`}>
        <AlertTriangle className="size-3" />
      </span>
      <div className="flex-1">
        <p className="font-semibold">
          {isDanger ? "⚠️ 内存高危告警" : "⚠️ 内存警戒告警"}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed">
          RSS 已达 <span className="font-mono font-bold">{health.rssHuman}</span>（4GB 上限的
          <span className="font-mono font-bold"> {health.percent.toFixed(1)}%</span>）。
          {isDanger
            ? "接近 4GB 沙箱上限，存在 OOM 风险 —— 建议尽快排查长任务或主动重启进程。"
            : "内存增长持续中 —— 建议关注「设置 → 系统信息」的 RSS 趋势 sparkline，提前预警。"}
          <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] opacity-70">
            <TrendingUp className="size-3" />
            进程已运行 {health.uptimeHuman}
          </span>
        </p>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className={`shrink-0 rounded p-1 transition-colors ${
          isDanger
            ? "text-red-600 hover:bg-red-100"
            : "text-amber-600 hover:bg-amber-100"
        }`}
        aria-label="关闭告警（本次会话内不再显示该等级告警）"
        title="关闭告警（本次会话内不再显示该等级告警；若升级到更高等级将再次出现）"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
