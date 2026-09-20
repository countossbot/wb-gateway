// /api/console/backup —— 数据备份导出（GET）与导入恢复（POST，v4.1.0）。
// GET：全库逻辑导出（providers / accounts 凭据 / routes / keys / settings / 日志），
//      可经 /api/console/migrate-kv 的恢复模式再导入（JSON 含凭据，仅属主本地保存）。
// POST：uag-backup-v1 格式整包导入，两种模式：
//      merge     —— 增量幂等：按主键（provider.id / account.id / route.model / key.id / setting.key）
//                   已存在一律跳过（保留现值），仅补缺失条目；日志分区不导入（避免与现行滚动窗口混淆）。
//      overwrite —— 覆盖恢复：先清空配置与日志分区（providers/accounts/routes/candidates/
//                   virtualKeys/settings/checkinLogs/requestLogs）再按备份原样重建（保留原 id 与时间戳）。
//                   管理员/会话/审计/UsageDaily/BalanceSnapshot 五类表不受影响：
//                   ①账号与登录态不动，防止把自己锁在门外；②统计聚合表备份格式中不存在，
//                   删除只丢数据无恢复收益。
// 安全：导入属破坏性/关键操作，整次写入后落一条审计（restore/system，含分区计数摘要）；
//       事务超时放宽至 60s（备份日志可达千条量级，默认 5s 不够）。
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { recordAudit } from "@/lib/gateway/console/auditService";
import { VERSION, invalidateConfigChanged } from "@/lib/gateway/config/configService";
import { refreshRuntimeSettings } from "@/lib/gateway/config/runtimeSettings";
import { supportedProviderTypes } from "@/lib/gateway/providers";
import { invalidateBalanceCache } from "@/lib/gateway/core/fleet";
import { localDayKey } from "@/lib/gateway/config/requestLog";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const [
    providers,
    accounts,
    routes,
    candidates,
    virtualKeys,
    settings,
    checkinLogs,
    requestLogs,
  ] = await Promise.all([
    db.provider.findMany(),
    db.account.findMany(),
    db.modelRoute.findMany(),
    db.routeCandidate.findMany(),
    db.virtualKey.findMany(),
    db.systemSetting.findMany(),
    db.checkinLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
    db.requestLog.findMany({ orderBy: { createdAt: "desc" }, take: 1000 }),
  ]);

  const backup = {
    format: "uag-backup-v1",
    version: VERSION,
    exportedAt: new Date().toISOString(),
    // 注意：包含全部凭据明文（含 master_key / cron_secret / 虚拟密钥），
    // 仅属主本地保存；泄露等同交出全部上游账号。
    containsSecrets: true,
    providers,
    accounts,
    routes,
    candidates,
    virtualKeys,
    settings,
    checkinLogs,
    requestLogs,
  };

  const filename = `uag-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  return new Response(JSON.stringify(backup, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// ---- POST 导入 ----

interface BackupProvider {
  id: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  sortOrder?: number;
  config?: Record<string, unknown>;
  proxyOverride?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
interface BackupAccount {
  id: string;
  providerId: string;
  name?: string;
  enabled?: boolean;
  credentials?: Record<string, unknown>;
  balance?: unknown;
  cooldownUntil?: string | null;
  cooldownStreak?: number;
  cooldownReason?: string | null;
  lastCheckinAt?: string | null;
  lastCheckinOk?: boolean | null;
  lastRefreshAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
interface BackupRoute {
  id?: number;
  model: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
interface BackupCandidate {
  id?: number;
  routeId: number;
  providerId: string;
  model: string;
  enabled?: boolean;
  sortOrder?: number;
}
interface BackupKey {
  id: string;
  name?: string;
  keyValue: string;
  keyPrefix?: string;
  enabled?: boolean;
  models?: string[];
  role?: string;
  remark?: string | null;
  dailyRequestLimit?: number; // v4.3.0：日请求配额（旧备份缺省 → 0 不限额）
  dailyTokenLimit?: number; // v4.3.0：日 token 配额
  createdAt?: string;
  updatedAt?: string;
}
interface BackupSetting {
  key: string;
  value: unknown;
  updatedAt?: string;
}
interface BackupLog {
  id?: number;
  [k: string]: unknown;
}
interface BackupPayload {
  format?: string;
  version?: string;
  exportedAt?: string;
  containsSecrets?: boolean;
  providers?: BackupProvider[];
  accounts?: BackupAccount[];
  routes?: BackupRoute[];
  candidates?: BackupCandidate[];
  virtualKeys?: BackupKey[];
  settings?: BackupSetting[];
  checkinLogs?: BackupLog[];
  requestLogs?: BackupLog[];
}

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t) : null;
};
const toDateOrThrow = (v: string | null | undefined): Date | undefined => toDate(v) ?? undefined;

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const body = (await request.json().catch(() => ({}))) as { text?: string; mode?: string };
  const text = (body.text || "").trim();
  const mode = body.mode === "overwrite" ? "overwrite" : "merge";
  if (!text) return fail("导入内容为空：请先选择或粘贴 uag-backup 备份文件全文");

  let data: BackupPayload;
  try {
    data = JSON.parse(text) as BackupPayload;
  } catch (e) {
    return fail(`JSON 解析失败：${(e as Error).message}`);
  }
  if (data.format !== "uag-backup-v1") {
    return fail(
      `备份格式无法识别（format=${String(data.format ?? "缺失")}，期望 uag-backup-v1）。` +
        `请使用「一键备份导出」生成的文件；账号级导入请用账号管理页的导入功能`
    );
  }
  const hasSection =
    (Array.isArray(data.providers) && data.providers.length > 0) ||
    (Array.isArray(data.accounts) && data.accounts.length > 0) ||
    (Array.isArray(data.routes) && data.routes.length > 0) ||
    (Array.isArray(data.virtualKeys) && data.virtualKeys.length > 0) ||
    (Array.isArray(data.settings) && data.settings.length > 0);
  if (!hasSection) {
    return fail("备份文件没有任何可导入的业务分区（providers/accounts/routes/virtualKeys/settings 全为空）");
  }
  // 脱敏导出（containsSecrets=false）缺凭据，恢复后会产出无法调用的账号 —— 明确拒绝而非静默产废数据
  if (data.containsSecrets === false) {
    return fail("该备份为脱敏导出（不含凭据明文），不能作为恢复源；请使用含凭据的完整备份");
  }

  const warnings: string[] = [];
  const report: Array<{ section: string; action: string; detail: string }> = [];
  const counts = { providers: 0, accounts: 0, routes: 0, candidates: 0, keys: 0, settings: 0, checkinLogs: 0, requestLogs: 0 };

  try {
    await db.$transaction(
      async (tx) => {
        // ===== overwrite：先清空（外键顺序：candidates → routes → accounts → providers → keys → settings → logs）=====
        if (mode === "overwrite") {
          await tx.routeCandidate.deleteMany();
          await tx.modelRoute.deleteMany();
          await tx.account.deleteMany();
          await tx.provider.deleteMany();
          await tx.virtualKey.deleteMany();
          await tx.systemSetting.deleteMany();
          await tx.checkinLog.deleteMany();
          await tx.requestLog.deleteMany();
          report.push({ section: "overwrite", action: "clear", detail: "已清空 providers/accounts/routes/keys/settings 与两类日志分区（管理员/审计/统计聚合表不受影响）" });
        }

        // ===== providers =====
        const providers = Array.isArray(data.providers) ? data.providers : [];
        for (const p of providers) {
          if (!p?.id) {
            warnings.push("跳过一个缺少 id 的 provider 条目");
            continue;
          }
          const type = p.type || "openai";
          if (!supportedProviderTypes().includes(type)) {
            warnings.push(`provider "${p.id}" 类型 "${type}" 不受支持，跳过`);
            continue;
          }
          const exists = await tx.provider.findUnique({ where: { id: p.id } });
          if (exists) {
            report.push({ section: "provider", action: "skip", detail: `"${p.id}" 已存在（保留现值）` });
            continue;
          }
          await tx.provider.create({
            data: {
              id: p.id,
              name: p.name || p.id,
              type,
              enabled: p.enabled !== false,
              sortOrder: p.sortOrder ?? 0,
              config: (p.config || {}) as never,
              proxyOverride: p.proxyOverride ?? null,
              ...(toDateOrThrow(p.createdAt) ? { createdAt: toDateOrThrow(p.createdAt) } : {}),
            },
          });
          counts.providers++;
          report.push({ section: "provider", action: "create", detail: `"${p.id}"（类型 ${type}）` });
        }

        // ===== accounts（provider 主键为字符串直传；孤儿账号告警丢弃）=====
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        for (const a of accounts) {
          if (!a?.id || !a.providerId) {
            warnings.push("跳过一个缺少 id/providerId 的账号条目");
            continue;
          }
          const providerExists = await tx.provider.findUnique({ where: { id: a.providerId } });
          if (!providerExists) {
            warnings.push(`账号 "${a.id}" 引用的 provider "${a.providerId}" 不存在，跳过`);
            continue;
          }
          const exists = await tx.account.findUnique({ where: { id: a.id } });
          if (exists) {
            report.push({ section: "account", action: "skip", detail: `"${a.id}"（${a.name || a.id}）已存在（保留现值）` });
            continue;
          }
          await tx.account.create({
            data: {
              id: a.id,
              providerId: a.providerId,
              name: a.name || a.id,
              enabled: a.enabled !== false,
              credentials: (a.credentials || {}) as never,
              balance: (a.balance ?? Prisma.JsonNull) as never,
              cooldownUntil: toDate(a.cooldownUntil),
              cooldownStreak: a.cooldownStreak ?? 0,
              cooldownReason: a.cooldownReason ?? null,
              lastCheckinAt: toDate(a.lastCheckinAt),
              lastCheckinOk: a.lastCheckinOk ?? null,
              lastRefreshAt: toDate(a.lastRefreshAt),
              ...(toDateOrThrow(a.createdAt) ? { createdAt: toDateOrThrow(a.createdAt) } : {}),
            },
          });
          counts.accounts++;
          report.push({ section: "account", action: "create", detail: `"${a.id}"（${a.name || a.id} → ${a.providerId}）` });
        }

        // ===== routes + candidates（route 自增 id 重映射；候选引用缺失来源则丢弃）=====
        const routes = Array.isArray(data.routes) ? data.routes : [];
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        const routeIdMap = new Map<number, number>(); // 备份 routeId → 新 routeId
        for (const r of routes) {
          if (!r?.model) {
            warnings.push("跳过一条缺少 model 的路由");
            continue;
          }
          const exists = await tx.modelRoute.findUnique({ where: { model: r.model } });
          if (exists) {
            routeIdMap.set(r.id ?? -1, exists.id);
            report.push({ section: "route", action: "skip", detail: `"${r.model}" 已存在（保留现值）` });
            continue;
          }
          const created = await tx.modelRoute.create({
            data: {
              model: r.model,
              enabled: r.enabled !== false,
              ...(toDateOrThrow(r.createdAt) ? { createdAt: toDateOrThrow(r.createdAt) } : {}),
            },
          });
          if (typeof r.id === "number") routeIdMap.set(r.id, created.id);
          counts.routes++;
          report.push({ section: "route", action: "create", detail: `"${r.model}"` });
        }
        for (const c of candidates) {
          if (!c?.providerId || !c?.model) {
            warnings.push("跳过一条缺少 providerId/model 的候选");
            continue;
          }
          const newRouteId = routeIdMap.get(c.routeId);
          if (typeof newRouteId !== "number") {
            warnings.push(`候选 ${c.providerId}/${c.model} 引用的路由 #${c.routeId} 不在备份或无法映射，丢弃`);
            continue;
          }
          const providerExists = await tx.provider.findUnique({ where: { id: c.providerId } });
          if (!providerExists) {
            warnings.push(`候选引用不存在的 provider "${c.providerId}"，丢弃`);
            continue;
          }
          // 增量幂等：同一路由下 providerId+model 完全相同的候选不重复插入（overwrite 已清空不会命中）
          const candExists = await tx.routeCandidate.findFirst({
            where: { routeId: newRouteId, providerId: c.providerId, model: c.model },
          });
          if (candExists) {
            report.push({ section: "candidate", action: "skip", detail: `${c.providerId}/${c.model} 候选已存在（保留现值）` });
            continue;
          }
          await tx.routeCandidate.create({
            data: {
              routeId: newRouteId,
              providerId: c.providerId,
              model: c.model,
              enabled: c.enabled !== false,
              sortOrder: c.sortOrder ?? 0,
            },
          });
          counts.candidates++;
        }

        // ===== virtualKeys =====
        const keys = Array.isArray(data.virtualKeys) ? data.virtualKeys : [];
        for (const k of keys) {
          if (!k?.id || !k?.keyValue) {
            warnings.push("跳过一把缺少 id/keyValue 的虚拟密钥");
            continue;
          }
          const exists = await tx.virtualKey.findUnique({ where: { id: k.id } });
          if (exists) {
            report.push({ section: "virtual_key", action: "skip", detail: `${k.keyPrefix || k.keyValue.slice(0, 6)}… 已存在（保留现值）` });
            continue;
          }
          const kvConflict = await tx.virtualKey.findUnique({ where: { keyValue: k.keyValue } });
          if (kvConflict) {
            warnings.push(`密钥 ${k.keyPrefix || k.keyValue.slice(0, 6)}… 的 keyValue 与现有密钥冲突，跳过`);
            continue;
          }
          await tx.virtualKey.create({
            data: {
              id: k.id,
              name: k.name || "Imported Key",
              keyValue: k.keyValue,
              keyPrefix: k.keyPrefix || k.keyValue.slice(0, 6),
              enabled: k.enabled !== false,
              models: (Array.isArray(k.models) && k.models.length > 0 ? k.models : ["*"]) as never,
              role: k.role || "client",
              // v4.3.0：配额字段随备份往返（旧备份无此字段 → 0 不限额，兼容）
              dailyRequestLimit: Math.max(0, Math.floor(Number(k.dailyRequestLimit) || 0)),
              dailyTokenLimit: Math.max(0, Math.floor(Number(k.dailyTokenLimit) || 0)),
              remark: k.remark ?? "备份导入",
              ...(toDateOrThrow(k.createdAt) ? { createdAt: toDateOrThrow(k.createdAt) } : {}),
            },
          });
          counts.keys++;
          report.push({ section: "virtual_key", action: "create", detail: `${k.keyPrefix || k.keyValue.slice(0, 6)}…（${k.name || "未命名"}）` });
        }

        // ===== settings（系统密钥 master_key/cron_secret 一并恢复 —— 备份恢复语义）=====
        const settings = Array.isArray(data.settings) ? data.settings : [];
        for (const s of settings) {
          if (!s?.key) continue;
          const exists = await tx.systemSetting.findUnique({ where: { key: s.key } });
          if (exists) {
            report.push({ section: "setting", action: "skip", detail: `${s.key} 已存在（保留现值）` });
            continue;
          }
          await tx.systemSetting.create({ data: { key: s.key, value: (s.value ?? null) as never } });
          counts.settings++;
          report.push({ section: "setting", action: "create", detail: s.key });
        }

        // ===== 日志分区（仅 overwrite 恢复；merge 模式不导入 —— 增量日志与滚动窗口语义冲突）=====
        if (mode === "overwrite") {
          const checkinLogs = Array.isArray(data.checkinLogs) ? data.checkinLogs : [];
          for (const l of checkinLogs) {
            await tx.checkinLog.create({
              data: {
                ...(typeof l.id === "number" ? { id: l.id } : {}),
                providerId: String(l.providerId ?? ""),
                accountId: (l.accountId as string) ?? null,
                accountName: (l.accountName as string) ?? null,
                success: !!l.success,
                manual: !!l.manual,
                result: (l.result ?? Prisma.JsonNull) as never,
                ...(toDateOrThrow(l.createdAt as string) ? { createdAt: toDateOrThrow(l.createdAt as string) } : {}),
              },
            });
            counts.checkinLogs++;
          }
          const requestLogs = Array.isArray(data.requestLogs) ? data.requestLogs : [];
          for (const l of requestLogs) {
            await tx.requestLog.create({
              data: {
                ...(typeof l.id === "number" ? { id: l.id } : {}),
                model: String(l.model ?? "unknown"),
                protocol: String(l.protocol ?? "openai"),
                providerId: (l.providerId as string) ?? null,
                accountId: (l.accountId as string) ?? null,
                durationMs: (l.durationMs as number) ?? null,
                status: (l.status as number) ?? null,
                stream: !!l.stream,
                inputTokens: (l.inputTokens as number) ?? null,
                outputTokens: (l.outputTokens as number) ?? null,
                cachedTokens: (l.cachedTokens as number) ?? null,
                apiKeyName: (l.apiKeyName as string) ?? null,
                error: (l.error as string) ?? null,
                usageExact: typeof l.usageExact === "boolean" ? l.usageExact : null,
                ...(toDateOrThrow(l.createdAt as string) ? { createdAt: toDateOrThrow(l.createdAt as string) } : {}),
              },
            });
            counts.requestLogs++;
          }
          report.push({
            section: "logs",
            action: "create",
            detail: `签到日志 ${counts.checkinLogs} 条 · 请求日志 ${counts.requestLogs} 条`,
          });
        }
      },
      { timeout: 60_000, maxWait: 10_000 }
    );
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return fail(`导入事务失败已回滚（数据未受影响）：${msg}`);
  }

  // 热生效：引擎配置（fleet 重建）+ 运行时设置（checkin/proxy 等）+ 余额缓存
  await invalidateConfigChanged();
  await refreshRuntimeSettings();
  invalidateBalanceCache();

  // v4.1.2 修复：overwrite 导入后重建 UsageDaily 按日聚合 ——
  // 备份不导出统计聚合表（设计决策），旧实现导入后滚动日志有数而聚合表为空，
  // 总览页「24h 请求趋势」（读 RequestLog）与「近 7 天消耗趋势」（读 UsageDaily）互相矛盾。
  // 重建策略：从导入后的 RequestLog 全量聚合，仅覆盖导入日志涉及的日期（delete+recreate），
  // 未涉及的日期不受影响；聚合失败不阻断导入主流程（仅降级为告警）。
  // v4.2.3：聚合维度含 model（日 × 提供商 × 密钥 × 模型，与实时链路同口径）。
  if (mode === "overwrite" && counts.requestLogs > 0) {
    try {
      const logs = await db.requestLog.findMany({
        select: { createdAt: true, providerId: true, apiKeyName: true, model: true, status: true, inputTokens: true, outputTokens: true, cachedTokens: true },
      });
      const cells = new Map<string, { day: string; providerId: string; apiKeyName: string; model: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number }>();
      for (const l of logs) {
        const day = localDayKey(l.createdAt);
        const providerKey = l.providerId ?? "";
        const keyKey = l.apiKeyName ?? "";
        const modelKey = l.model ?? "";
        const k = `${day}\u0000${providerKey}\u0000${keyKey}\u0000${modelKey}`;
        const ok = (l.status ?? 0) >= 200 && (l.status ?? 0) < 400;
        const c = cells.get(k) || { day, providerId: providerKey, apiKeyName: keyKey, model: modelKey, requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        c.requests += 1;
        if (ok) c.okRequests += 1;
        c.inputTokens += l.inputTokens ?? 0;
        c.outputTokens += l.outputTokens ?? 0;
        c.cachedTokens += l.cachedTokens ?? 0;
        cells.set(k, c);
      }
      if (cells.size > 0) {
        const days = [...new Set([...cells.values()].map((c) => c.day))];
        // 仅重建导入日志涉及的日期：先删后建，避免与未涉及日期的既有聚合叠加双重计数
        await db.$transaction([
          db.usageDaily.deleteMany({ where: { day: { in: days } } }),
          ...[...cells.values()].map((c) =>
            db.usageDaily.create({
              data: { day: c.day, providerId: c.providerId, apiKeyName: c.apiKeyName, model: c.model, requests: c.requests, okRequests: c.okRequests, inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedTokens: c.cachedTokens },
            })
          ),
        ]);
        report.push({ section: "usage-daily", action: "rebuild", detail: `已从 ${counts.requestLogs} 条导入日志重建 ${days.length} 天的按日聚合（${cells.size} 个维度格，含模型维度）` });
      }
    } catch (e) {
      warnings.push(`UsageDaily 聚合重建失败（统计面板可能出现断档，不影响业务数据）：${(e as Error).message}`);
    }
  }

  const summary =
    `导入完成（${mode === "overwrite" ? "覆盖恢复" : "增量合并"}）：提供商 ${counts.providers} · 账号 ${counts.accounts} · 路由 ${counts.routes}（候选 ${counts.candidates}） · 密钥 ${counts.keys} · 设置 ${counts.settings}` +
    (mode === "overwrite" ? ` · 日志 ${counts.checkinLogs + counts.requestLogs}` : "") +
    (warnings.length > 0 ? `；${warnings.length} 条警告` : "");

  // 破坏性/关键操作审计（restore/system；写失败不影响主流程）
  recordAudit(
    {
      action: "restore",
      entity: "system",
      entityId: "backup-import",
      entityName: `备份导入（${mode === "overwrite" ? "覆盖恢复" : "增量合并"}）`,
      detail: { mode, counts, warnings, exportedAt: data.exportedAt ?? null, backupVersion: data.version ?? null },
    },
    request
  );

  return ok({ mode, counts, warnings, report, message: summary });
}
