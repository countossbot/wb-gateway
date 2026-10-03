// useRuntimeHealth —— 进程运行时健康共享 Hook（v4.9.5 新增）
//
// 背景：Task 66 在 sidebar footer 渲染 RuntimeHealthBadge，独立轮询 /api/console/system-info
// 30s 周期。Task 69 新增 RssAlertBanner 顶层告警横幅，若再独立轮询会造成同一端点被
// 两个组件分别请求（60s 内 ~4 次请求，sidebar 30s + banner 30s）。
//
// 解决：把轮询逻辑提取为共享 Hook，多个组件订阅同一数据源 —— React state 在组件树中
// 只有一份，但 Hook 在每个使用处独立 setInterval；为避免重复请求，再加一个全局
// singleflight 标记（同 60s 内的请求合并）。
//
// 设计取舍：
//   - 不用 React Context（会强制所有子组件 re-render；sidebar 已 mounted 但 banner 仅在
//     alert 触发时才显示，二者 re-render 节奏不同）
//   - 全局 singleflight：同 1s 内并发的 fetchInfo 调用合并为一次（避免 sidebar + banner
//     同时 mount 时的双请求）
//   - 30s 轮询周期不变（与 SystemInfoSection 一致）
//   - 失败静默（hook 不抛 toast，调用方自己决定如何渲染 error 状态）
"use client";

import * as React from "react";

export type HealthLevel = "ok" | "warn" | "danger" | "loading";

export interface RuntimeHealth {
  rssBytes: number;
  rssHuman: string;
  uptimeSec: number;
  uptimeHuman: string;
  /** 健康度分级：< 50% ok / 50-75% warn / > 75% danger */
  level: HealthLevel;
  /** RSS / 4GB 上限百分比（0-100） */
  percent: number;
  /** 是否正在加载（首次拉取前） */
  loading: boolean;
  /** 最近一次错误信息（空字符串 = 无错误） */
  error: string;
}

const LIMIT_BYTES = 4 * 1024 * 1024 * 1024; // 4GB
const POLL_INTERVAL_MS = 30_000;
const SINGLEFLIGHT_KEY = "__uag_runtime_health_singleflight__"; // @deprecated 保留兼容；实际去重见下方共享订阅表
// v4.9.11：跨组件共享订阅表 —— RuntimeHealthBadge / RssAlertBanner / 其他调用方共用「一个」轮询定时器，
// 避免每个调用处各起 setInterval 造成重复请求（本网关有 4GB RSS 压力，重复轮询属实质负担）。
type RawInfoSubscriber = (r: RawInfo | null) => void;
const subscribers = new Set<RawInfoSubscriber>();
let sharedTimer: ReturnType<typeof setInterval> | null = null;

async function pollShared(): Promise<void> {
  const r = await fetchInfo();
  for (const fn of Array.from(subscribers)) fn(r);
}

function subscribe(fn: RawInfoSubscriber): () => void {
  subscribers.add(fn);
  if (!sharedTimer) {
    void pollShared();
    sharedTimer = setInterval(() => void pollShared(), POLL_INTERVAL_MS);
  } else {
    // 已有轮询在跑：新订阅者立即拿一次最新值（走 singleflight，不会额外打接口）
    void fetchInfo().then((r) => {
      if (subscribers.has(fn)) fn(r);
    });
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && sharedTimer) {
      clearInterval(sharedTimer);
      sharedTimer = null;
    }
  };
}

function classifyHealth(rssBytes: number): HealthLevel {
  const ratio = rssBytes / LIMIT_BYTES;
  if (ratio > 0.75) return "danger"; // > 3GB red
  if (ratio > 0.5) return "warn"; // > 2GB amber
  return "ok"; // < 2GB emerald
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

interface RawInfo {
  rssBytes: number;
  rssHuman: string;
  uptimeSec: number;
  uptimeHuman: string;
}

// 全局 singleflight：同 1s 内并发的 fetchInfo 调用合并为一次
let inflightPromise: Promise<RawInfo | null> | null = null;
let inflightExpiresAt = 0;

async function fetchInfo(): Promise<RawInfo | null> {
  const now = Date.now();
  if (inflightPromise && now < inflightExpiresAt) {
    return inflightPromise;
  }
  inflightExpiresAt = now + 1000; // 1s 内合并
  inflightPromise = (async () => {
    try {
      // 动态 import 避免在 SSR 阶段拉取
      const { apiGet } = await import("@/lib/console/api");
      const data = await apiGet<{
        memory: { rssBytes: number; rssHuman: string };
        runtime: { uptimeSec: number; uptimeHuman: string };
      }>("/api/console/system-info");
      return {
        rssBytes: data.memory.rssBytes,
        rssHuman: data.memory.rssHuman,
        uptimeSec: data.runtime.uptimeSec,
        uptimeHuman: data.runtime.uptimeHuman,
      };
    } catch {
      return null;
    } finally {
      // singleflight 标记在 1s 后过期；保留 inflightPromise 引用让并发调用拿到结果
      setTimeout(() => {
        if (Date.now() >= inflightExpiresAt - 50) inflightPromise = null;
      }, 1100);
    }
  })();
  return inflightPromise;
}

export function useRuntimeHealth(): RuntimeHealth {
  const [info, setInfo] = React.useState<RawInfo | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    // v4.9.11：改为共享订阅 —— 多个调用方只共用一个 30s 轮询定时器，避免重复请求
    const unsubscribe = subscribe((r) => {
      if (cancelled) return;
      if (r) {
        setInfo(r);
        setError("");
      } else {
        setError("拉取失败");
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const rssBytes = info?.rssBytes ?? 0;
  const level = info ? classifyHealth(rssBytes) : "loading";
  const percent = info ? Math.min(100, (rssBytes / LIMIT_BYTES) * 100) : 0;

  return {
    rssBytes,
    rssHuman: info?.rssHuman ?? formatBytes(rssBytes),
    uptimeSec: info?.uptimeSec ?? 0,
    uptimeHuman: info?.uptimeHuman ?? formatUptime(0),
    level,
    percent,
    loading,
    error,
  };
}

export { LIMIT_BYTES, classifyHealth, formatUptime, formatBytes };
