// v3.4.0：控制台单页 URL 状态同步 —— 日志筛选深链 + tab 深链的统一封装。
// 背景：单页 8 个 tab 全靠 React state 切换（URL 恒为 /），跨页跳转通道（趋势柱/密钥徽标等 6 条）
// 携参走 props；此前筛选无法通过 URL 复现/分享。本模块把「tab + 日志七维筛选」映射到 query string：
//   /?tab=logs&provider=workbuddy&status=error&from=1730000000000&to=1730003600000
// 读写统一走 history.replaceState（不触发导航、不污染历史栈）；SSR 环境静默降级。
"use client";

import type { ConsoleTab } from "@/components/console/sidebar";

const TAB_IDS: readonly ConsoleTab[] = [
  "overview",
  "accounts",
  "providers",
  "keys",
  "routes",
  "jobs",
  "logs",
  "settings",
] as const;

/** 解析 URL 中的 tab 参数（非法值返回 null，调用方回落默认页） */
export function parseTabParam(search: string): ConsoleTab | null {
  const t = new URLSearchParams(search).get("tab");
  return TAB_IDS.includes(t as ConsoleTab) ? (t as ConsoleTab) : null;
}

/** 日志筛选的 URL 可表达形态（customRange 为 epoch ms；label 不入 URL，读回时由时间范围重新生成） */
export interface LogsUrlFilters {
  model: string;
  provider: string;
  usage: string;
  status: string;
  key: string;
  account: string;
  customRange: { from: number; to: number } | null;
}

const LOG_KEYS = ["model", "provider", "usage", "status", "key", "account", "from", "to"] as const;

/** 从 URL 读取日志筛选（无任何日志参数时返回 null，表示「无深链意图」） */
export function parseLogsFilters(search: string): LogsUrlFilters | null {
  const p = new URLSearchParams(search);
  const hasAny = LOG_KEYS.some((k) => p.get(k));
  if (!hasAny) return null;
  const fromNum = Number(p.get("from"));
  const toNum = Number(p.get("to"));
  const hasRange = Number.isFinite(fromNum) && Number.isFinite(toNum) && fromNum > 0 && toNum > fromNum;
  return {
    model: p.get("model") || "",
    provider: p.get("provider") || "all",
    usage: p.get("usage") || "all",
    status: p.get("status") || "all",
    key: p.get("key") || "all",
    account: p.get("account") || "all",
    customRange: hasRange ? { from: fromNum, to: toNum } : null,
  };
}

function replaceSearchParams(mutate: (p: URLSearchParams) => void): void {
  if (typeof window === "undefined") return;
  const p = new URLSearchParams(window.location.search);
  mutate(p);
  const qs = p.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`
  );
}

/** 写入 tab（logs 筛选参数由 logs 模块自行维护；离开日志 tab 时清除其筛选参数保持 URL 诚实） */
export function syncTabToUrl(tab: ConsoleTab): void {
  replaceSearchParams((p) => {
    if (tab === "overview") p.delete("tab");
    else p.set("tab", tab);
    if (tab !== "logs") LOG_KEYS.forEach((k) => p.delete(k));
  });
}

/** 日志筛选 → 规范化 query string（tab=logs 恒定在首位语义；全默认时仅 tab=logs）。
 *  syncLogsFiltersToUrl 与「复制链接」共用，保证 URL 形态一致 */
export function logsFiltersToQuery(f: LogsUrlFilters): string {
  const p = new URLSearchParams();
  if (f.model.trim()) p.set("model", f.model.trim());
  if (f.provider && f.provider !== "all") p.set("provider", f.provider);
  if (f.usage && f.usage !== "all") p.set("usage", f.usage);
  if (f.status && f.status !== "all") p.set("status", f.status);
  if (f.key && f.key !== "all") p.set("key", f.key);
  if (f.account && f.account !== "all") p.set("account", f.account);
  if (f.customRange) {
    p.set("from", String(f.customRange.from));
    p.set("to", String(f.customRange.to));
  }
  p.set("tab", "logs");
  return p.toString();
}

/** 写入当前日志筛选（全默认筛选时 URL 只保留 tab=logs；整条 query 由 logsFiltersToQuery 规范化重写） */
export function syncLogsFiltersToUrl(f: LogsUrlFilters): void {
  if (typeof window === "undefined") return;
  const qs = logsFiltersToQuery(f);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`
  );
}

/** 当前页面的深链完整地址（基于给定筛选构造；origin/pathname 取自当前地址） */
export function buildDeepLink(f: LogsUrlFilters): string {
  if (typeof window === "undefined") return "";
  const qs = logsFiltersToQuery(f);
  return `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ""}`;
}
