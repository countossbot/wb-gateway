// 运行时设置 —— 内存热配置层（SystemSetting 表的写穿缓存）。
// 代理、CORS 白名单、定时任务、日志等运行参数在此聚合；saveConfig 时同步刷新（热生效，无需重启）。
// 引擎的 GatewayConfig（providers/routes/keys）不在此层 —— 见 config/configService.ts。

import { db } from "@/lib/db";
import type { ProxyConfig } from "../proxy/proxyAgent";

export interface RuntimeSettingsShape {
  proxy: ProxyConfig | null;
  corsAllowedOrigins: string[]; // ["*"] 显式通配符（风险自担）或精确 Origin 白名单
  listenLan: boolean; // 是否允许局域网访问（默认 false，仅 127.0.0.1）
  logLevel: "debug" | "info" | "warn" | "error";
  checkinEnabled: boolean;
  checkinCron: string; // 默认 "0 9 * * *"（每天 09:00）
  checkinTz: string; // 默认 Asia/Shanghai
  checkinProviders: string[]; // v4.1.0：需要签到的提供商白名单（空数组 = 全部支持签到的提供商）
  keepaliveEnabled: boolean;
  keepaliveCron: string; // 默认 "0 */6 * * *"（每 6 小时 Token 保活）
  keepaliveTz: string;
  usageProviderId: string; // 默认 workbuddy
  maxContextTurns: number; // 0 = 不限
  auditRetentionDays: number; // v3.2.2：操作审计保留天数（默认 90，0 = 永久保留，每小时节流清扫）
  balanceRetentionDays: number; // v3.7.0：余额快照保留天数（默认 365，0 = 永久保留，每小时节流清扫）
  // ---- v4.2.0：SSE 流式保活与上游超时（Task 33 诊断 R1/R2/R6 修复，可热调） ----
  streamStallMs: number; // 上游停滞熔断阈值（默认 180_000；0 = 用默认；转译/透传/聚合三条路径统一）
  upstreamHeadersTimeoutMs: number; // undici 等待响应头超时（默认 300_000）
  upstreamBodyTimeoutMs: number; // undici body 字节间隔超时（默认 600_000，作为停滞熔断之后的安全网）
}

const DEFAULTS: RuntimeSettingsShape = {
  proxy: null,
  corsAllowedOrigins: [],
  listenLan: false,
  logLevel: "info",
  checkinEnabled: true,
  checkinCron: "0 9 * * *",
  checkinTz: "Asia/Shanghai",
  checkinProviders: [],
  keepaliveEnabled: true,
  keepaliveCron: "0 */6 * * *",
  keepaliveTz: "Asia/Shanghai",
  usageProviderId: "workbuddy",
  maxContextTurns: 0,
  auditRetentionDays: 90,
  balanceRetentionDays: 365,
  streamStallMs: 180_000,
  upstreamHeadersTimeoutMs: 300_000,
  upstreamBodyTimeoutMs: 600_000,
};

// v4.2.0：带范围钳制的整数解析（超时类设置共用；非法/越界回落默认值）
function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  allowZero: boolean
): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  if (allowZero && n === 0) return 0;
  return n >= min && n <= max ? n : fallback;
}

let cached: RuntimeSettingsShape = { ...DEFAULTS };
let loaded = false;

// 进程启动后首次访问时从 DB 水合；之后由 saveRuntimeSetting / refreshRuntimeSettings 主动刷新
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const rows = await db.systemSetting.findMany();
    applyRows(rows);
  } catch (e) {
    console.error("[RuntimeSettings] Failed to load from DB:", e);
  }
}

function applyRows(rows: Array<{ key: string; value: unknown }>): void {
  const merged: RuntimeSettingsShape = { ...DEFAULTS };
  for (const row of rows) {
    try {
      switch (row.key) {
        case "proxy":
          merged.proxy = (row.value as ProxyConfig) || null;
          break;
        case "corsAllowedOrigins":
          merged.corsAllowedOrigins = Array.isArray(row.value) ? (row.value as string[]) : [];
          break;
        case "listenLan":
          merged.listenLan = row.value === true;
          break;
        case "logLevel":
          merged.logLevel = (["debug", "info", "warn", "error"].includes(String(row.value))
            ? row.value
            : "info") as RuntimeSettingsShape["logLevel"];
          break;
        case "checkinEnabled":
          merged.checkinEnabled = row.value === true;
          break;
        case "checkinCron":
          merged.checkinCron = String(row.value || DEFAULTS.checkinCron);
          break;
        case "checkinTz":
          merged.checkinTz = String(row.value || DEFAULTS.checkinTz);
          break;
        case "checkinProviders":
          // v4.1.0：字符串数组过滤（防 Json 里混入非字符串项）；空数组 = 全部支持签到的提供商
          merged.checkinProviders = Array.isArray(row.value)
            ? (row.value as unknown[]).filter((x): x is string => typeof x === "string" && !!x)
            : [];
          break;
        case "keepaliveEnabled":
          merged.keepaliveEnabled = row.value === true;
          break;
        case "keepaliveCron":
          merged.keepaliveCron = String(row.value || DEFAULTS.keepaliveCron);
          break;
        case "keepaliveTz":
          merged.keepaliveTz = String(row.value || DEFAULTS.keepaliveTz);
          break;
        case "usageProviderId":
          merged.usageProviderId = String(row.value || DEFAULTS.usageProviderId);
          break;
        case "maxContextTurns":
          merged.maxContextTurns = Number(row.value) || 0;
          break;
        case "auditRetentionDays": {
          const n = Math.floor(Number(row.value));
          merged.auditRetentionDays = Number.isFinite(n) && n >= 0 ? n : DEFAULTS.auditRetentionDays;
          break;
        }
        case "balanceRetentionDays": {
          const n = Math.floor(Number(row.value));
          merged.balanceRetentionDays = Number.isFinite(n) && n >= 0 ? n : DEFAULTS.balanceRetentionDays;
          break;
        }
        // v4.2.0：SSE 流式保活与上游超时（范围与设置页 PUT 校验一致；0 = 用默认仅 stall 支持语义）
        case "streamStallMs": {
          // 0 = 用默认 180s；有效范围 10s~900s
          merged.streamStallMs = clampInt(row.value, DEFAULTS.streamStallMs, 10_000, 900_000, true);
          break;
        }
        case "upstreamHeadersTimeoutMs": {
          merged.upstreamHeadersTimeoutMs = clampInt(row.value, DEFAULTS.upstreamHeadersTimeoutMs, 5_000, 3_600_000, false);
          break;
        }
        case "upstreamBodyTimeoutMs": {
          merged.upstreamBodyTimeoutMs = clampInt(row.value, DEFAULTS.upstreamBodyTimeoutMs, 10_000, 3_600_000, false);
          break;
        }
        default:
          break;
      }
    } catch {
      /* 单键损坏不影响整体 */
    }
  }
  cached = merged;
}

// 同步读取（首次未加载时返回默认值；随后台加载。管理面在写入时总是先 refresh，实践中读到的都是新鲜值）
export function getRuntimeSettings(): RuntimeSettingsShape {
  return cached;
}

export function getCorsAllowedOrigins(): string[] {
  return cached.corsAllowedOrigins;
}

// 异步读取（确保 DB 已水合）
export async function getRuntimeSettingsAsync(): Promise<RuntimeSettingsShape> {
  await ensureLoaded();
  return cached;
}

// 写单个设置键并热刷新内存（代理/CORS/定时任务等热生效入口）
export async function saveRuntimeSetting(key: string, value: unknown): Promise<void> {
  await db.systemSetting.upsert({
    where: { key },
    create: { key, value: value as never },
    update: { value: value as never },
  });
  await refreshRuntimeSettings();
}

export async function saveRuntimeSettings(entries: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await db.systemSetting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
  }
  await refreshRuntimeSettings();
}

export async function refreshRuntimeSettings(): Promise<void> {
  try {
    const rows = await db.systemSetting.findMany();
    applyRows(rows);
    loaded = true;
  } catch (e) {
    console.error("[RuntimeSettings] refresh failed:", e);
  }
}

// 测试隔离
export function resetRuntimeSettingsForTest(): void {
  cached = { ...DEFAULTS };
  loaded = false;
}
