// GET /api/console/system-info —— 系统运行时信息面板（v4.9.1 新增）
//
// 用途：在「设置」页底部展示网关自身运行状态，方便运维与开发期排障。
// 返回：
//   - version / dialect / nodeVersion / bunVersion / platform / arch
//   - uptime：进程启动至今的秒数与人类可读时长
//   - memory：rss / heapUsed / heapTotal / external（bytes）
//   - db：fileSizeBytes（SQLite 文件大小）、walSizeBytes（WAL 文件大小）、tableCounts（17 张表的行数）
//   - scheduler：startedAt（首次启动时间，基于进程 uptime 反推）、tickIntervalSec（30s）、
//     lastJobRuns（最近一次签到 / 保活 JobRun 摘要）、nextCron（下次触发预览）
//   - cache：runtimeSettings 简要（checkin / keepalive 启停 + cron + tz）
//
// 安全：仅控制台会话可访问（requireSessionOr401）；不暴露任何凭据或外部上游信息。
import { NextRequest } from "next/server";
import { statSync, existsSync } from "node:fs";
import path from "node:path";
import { db, dbDialect } from "@/lib/db";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { VERSION } from "@/lib/gateway/config/configService";
import { getRuntimeSettingsAsync } from "@/lib/gateway/config/runtimeSettings";
import { lastJobRuns, nextCronMatch, parseCron } from "@/lib/gateway/jobs/scheduler";
import { getRssHistory, getMetricsStartedAt } from "@/lib/gateway/jobs/systemMetrics";

export const dynamic = "force-dynamic";

/** 把字节数格式化为人类可读（KB/MB/GB，保留 1 位小数） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 把秒数格式化为「Xd Yh Zm」紧凑形态 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

interface TableCount {
  name: string;
  count: number;
}

const COUNTED_TABLES = [
  "Provider",
  "Account",
  "ModelRoute",
  "RouteCandidate",
  "VirtualKey",
  "SystemSetting",
  "AdminUser",
  "Session",
  "CheckinLog",
  "RequestLog",
  "UsageDaily",
  "ModelPricing",
  "BalanceSnapshot",
  "AuditLog",
  "JobRun",
  "LoginAudit",
  "SchemaVersion",
] as const;

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  // 进程信息
  const uptimeSec = process.uptime();
  const mem = process.memoryUsage();
  const startedAt = new Date(Date.now() - uptimeSec * 1000).toISOString();

  // Bun 版本（在 Node 环境下为 null；TS 未知 Bun 全局类型，用 typeof 守卫 + 强类型断言）
  const bunVersion: string | null =
    typeof globalThis !== "undefined" && "Bun" in globalThis
      ? (globalThis as { Bun?: { version?: string } }).Bun?.version ?? null
      : null;

  // 数据库文件大小（SQLite 形如 file:/path/to/custom.db）
  const dbPath = resolveDbFilePath();
  // v4.9.11：远程库方言标签（本地为 PG + MySQL 双数据库，不再是快照的 PG-only）
  const pgLabel = dbDialect === "mysql" ? "MySQL" : "PG";
  let dbFileSizeBytes = 0;
  let walSizeBytes = 0;
  if (dbPath) {
    try {
      dbFileSizeBytes = statSync(dbPath).size;
    } catch {
      dbFileSizeBytes = 0;
    }
    try {
      walSizeBytes = statSync(`${dbPath}-wal`).size;
    } catch {
      walSizeBytes = 0;
    }
  }

  // 表行数（并发查询）
  const tableCountResults = await Promise.all(
    COUNTED_TABLES.map(async (name) => {
      try {
        // 动态表名访问 prisma client —— 用 keyof 断言让 TS 接受任意 model 名
        const prisma = db as unknown as Record<string, { count: () => Promise<number | bigint> }>;
        const r = await prisma[lowerFirst(name)].count();
        return { name, count: typeof r === "number" ? r : Number(r) } as TableCount;
      } catch {
        return { name, count: 0 } as TableCount;
      }
    })
  );
  const tableCounts = tableCountResults.reduce<Record<string, number>>((acc, t) => {
    acc[t.name] = t.count;
    return acc;
  }, {});

  // 调度器状态
  const settings = await getRuntimeSettingsAsync();
  const lastRuns = await lastJobRuns();
  const nowMs = Date.now();

  const nextCron = {
    checkin:
      settings.checkinEnabled && parseCron(settings.checkinCron)
        ? formatNextCron(settings.checkinCron, settings.checkinTz, nowMs)
        : null,
    keepalive:
      settings.keepaliveEnabled && parseCron(settings.keepaliveCron)
        ? formatNextCron(settings.keepaliveCron, settings.keepaliveTz, nowMs)
        : null,
  };

  return ok({
    version: VERSION,
    runtime: {
      nodeVersion: process.version,
      bunVersion,
      platform: process.platform,
      arch: process.arch,
      uptimeSec,
      uptimeHuman: formatUptime(uptimeSec),
      startedAt,
    },
    memory: {
      rssBytes: mem.rss,
      rssHuman: formatBytes(mem.rss),
      heapUsedBytes: mem.heapUsed,
      heapUsedHuman: formatBytes(mem.heapUsed),
      heapTotalBytes: mem.heapTotal,
      heapTotalHuman: formatBytes(mem.heapTotal),
      externalBytes: mem.external,
      externalHuman: formatBytes(mem.external),
      // v4.9.2：RSS 历史 sparkline 数据（最早 → 最新，最多 30 个样本 / 30 分钟窗口）
      rssHistory: getRssHistory(),
      metricsStartedAt: getMetricsStartedAt(),
    },
    db: {
      dialect: dbDialect,
      // 本地：SQLite 文件路径；远程：连接 host/db（从 DATABASE_URL 解析）。v4.9.11：标签按方言区分 PG / MySQL
      filePath: dbPath ?? resolvePgConnInfo(),
      fileSizeBytes: dbFileSizeBytes,
      fileSizeHuman: dbFileSizeBytes > 0 ? formatBytes(dbFileSizeBytes) : `—（远程 ${pgLabel}）`,
      walSizeBytes,
      walSizeHuman: walSizeBytes > 0 ? formatBytes(walSizeBytes) : `—（远程 ${pgLabel}）`,
      tableCounts,
    },
    scheduler: {
      tickIntervalSec: 30,
      startedAt,
      settings: {
        checkinEnabled: settings.checkinEnabled,
        checkinCron: settings.checkinCron,
        checkinTz: settings.checkinTz,
        keepaliveEnabled: settings.keepaliveEnabled,
        keepaliveCron: settings.keepaliveCron,
        keepaliveTz: settings.keepaliveTz,
      },
      lastRuns,
      nextCron,
    },
  });
}

/** 从 DATABASE_URL 解析出 SQLite 文件绝对路径；非 SQLite 返回 null */
function resolveDbFilePath(): string | null {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url.startsWith("file:")) return null;
  const raw = url.slice("file:".length);
  // 形如 file:/abs/path/to.db 或 file:./rel/path.db 或 file:../db/custom.db
  if (raw.startsWith("/")) return raw;
  // 相对路径以 cwd 解析
  return path.resolve(process.cwd(), raw);
}

/** 从 postgresql:// URL 解析出 host:port/db 展示信息（密码脱敏） */
function resolvePgConnInfo(): string | null {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url.startsWith("postgres")) return null;
  try {
    // 用 URL 解析；密码不在展示中输出
    const u = new URL(url);
    const host = u.hostname;
    const port = u.port || "5432";
    const db = u.pathname.slice(1) || "postgres";
    return `${host}:${port}/${db}`;
  } catch {
    return null;
  }
}

/** 首字母小写（Provider → provider, ModelRoute → modelRoute） */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** 把下次 cron 触发时间格式化为「YYYY-MM-DD HH:mm (zd 后)」紧凑形态 */
function formatNextCron(cronExpr: string, tz: string, fromMs: number): {
  at: string;
  inSeconds: number;
  inHuman: string;
} | null {
  const nextMs = nextCronMatch(cronExpr, tz, fromMs);
  if (nextMs == null) return null;
  const inSec = Math.max(0, Math.round((nextMs - fromMs) / 1000));
  return {
    at: new Date(nextMs).toISOString(),
    inSeconds: inSec,
    inHuman: formatUptime(inSec),
  };
}
