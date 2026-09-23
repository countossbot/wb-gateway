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
  // v4.9.2：账号池调度模式。
  //   "load-balance"（默认）—— 会话粘性优先：同一会话固定打同一账号（上游按账号隔离的
  //     前缀缓存保持热，命中率不随账号数稀释）；无粘性键时退化为轮转。
  //   "sequential" —— 顺序调度：完全按 round-robin 轮转，忽略会话粘性键。
  // 两者共用 orderAccounts()，仅「是否传 affinityKey」不同，无独立算法分支。
  accountSchedulingMode: "load-balance" | "sequential";
  auditRetentionDays: number; // v3.2.2：操作审计保留天数（默认 90，0 = 永久保留，每小时节流清扫）
  balanceRetentionDays: number; // v3.7.0：余额快照保留天数（默认 365，0 = 永久保留，每小时节流清扫）
  // v4.9.0：成长中心执行日志保留天数（全局，默认 7；UI 可选 7/30/90）。
  // 日志表 append-only 永不 UPDATE，仅按此期限删除过期行（0 = 永久保留）。
  growthLogRetentionDays: number;
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
  accountSchedulingMode: "load-balance",
  auditRetentionDays: 90,
  balanceRetentionDays: 365,
  growthLogRetentionDays: 7,
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

// 进程启动后首次访问时从 DB 水合；之后由 saveRuntimeSetting / refreshRuntimeSettings 主动刷新
//
// v4.2.4：globalThis 共享存储 —— dev 模式下 Turbopack 按路由拆分模块图，每个 route
// 会得到 runtimeSettings.ts 的独立 module 实例（Task 19 曾为 configService 踩过同款坑：
// 控制台路由写入后写穿缓存只刷新自己实例，网关路由实例永远读旧值——签到白名单实测复现：
// PUT /api/console/jobs 保存 ["workbuddy"] 后 POST /admin/api/checkin 仍读到 []）。
// 把 cached/loaded 挂到 globalThis 上让同进程内所有模块实例共享同一份状态；
// 生产单实例模式行为零变化。HMR 重编译时：模块重新初始化会从 globalThis 取回旧状态，
// 并与新 DEFAULTS 合并（新增键补默认值），不丢失已加载的设置。
interface RuntimeSettingsStore {
  cached: RuntimeSettingsShape;
  loaded: boolean;
}
const gStore = globalThis as typeof globalThis & { __uagRuntimeSettingsStore?: RuntimeSettingsStore };
if (gStore.__uagRuntimeSettingsStore) {
  // 复用已有共享状态（另一模块实例已创建/HMR 重编译）：新 DEFAULTS 补齐新增键，保留已加载值
  gStore.__uagRuntimeSettingsStore.cached = { ...DEFAULTS, ...gStore.__uagRuntimeSettingsStore.cached };
} else {
  gStore.__uagRuntimeSettingsStore = { cached: { ...DEFAULTS }, loaded: false };
}
const store: RuntimeSettingsStore = gStore.__uagRuntimeSettingsStore;

async function ensureLoaded(): Promise<void> {
  if (store.loaded) return;
  store.loaded = true;
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
        case "accountSchedulingMode":
          // 白名单收窄：非法/历史脏值一律回落默认（load-balance），不留未知态给调度器
          merged.accountSchedulingMode =
            row.value === "sequential" || row.value === "load-balance"
              ? row.value
              : DEFAULTS.accountSchedulingMode;
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
        case "growthLogRetentionDays": {
          const n = Math.floor(Number(row.value));
          merged.growthLogRetentionDays = Number.isFinite(n) && n >= 0 ? n : DEFAULTS.growthLogRetentionDays;
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
  store.cached = merged;
}

// 同步读取（首次未加载时返回默认值；随后台加载。管理面在写入时总是先 refresh，实践中读到的都是新鲜值）
export function getRuntimeSettings(): RuntimeSettingsShape {
  return store.cached;
}

export function getCorsAllowedOrigins(): string[] {
  return store.cached.corsAllowedOrigins;
}

// 异步读取（确保 DB 已水合）
export async function getRuntimeSettingsAsync(): Promise<RuntimeSettingsShape> {
  await ensureLoaded();
  return store.cached;
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
    store.loaded = true;
  } catch (e) {
    console.error("[RuntimeSettings] refresh failed:", e);
  }
}

// 测试隔离（连同 globalThis 共享状态一起重置，防跨测试模块实例残留）
export function resetRuntimeSettingsForTest(): void {
  store.cached = { ...DEFAULTS };
  store.loaded = false;
}
