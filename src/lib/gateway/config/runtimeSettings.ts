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
};

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
