// /api/console/providers —— API 中转管理（提供商实例 CRUD）。
// GET：列表（config 脱敏 + 账号池掩码）；POST：新增；PUT：编辑（掩码回填契约）；
// DELETE ?id=：删除。配置悬浮窗按 type 渲染不同字段（前端），后端按 type 归一凭据。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requireSessionOr401,
  ok,
  fail,
  maskAccountCredentials,
  mergeCredentialsOnSave,
} from "@/lib/gateway/console/consoleHelpers";
import { supportedProviderTypes } from "@/lib/gateway/providers";
import { invalidateConfigChanged, NATIVE_PROVIDER_PRESETS } from "@/lib/gateway/config/configService";
import { auditCreate, auditDelete, auditUpdate } from "@/lib/gateway/console/auditService";

export const dynamic = "force-dynamic";

const SECRET_CONFIG_FIELDS = ["apiKey", "token", "cookie", "accessToken", "refreshToken", "jwtToken"];

function maskProviderConfig(config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...(config || {}) };
  for (const field of SECRET_CONFIG_FIELDS) {
    if (masked[field]) {
      const v = masked[field] as string;
      masked[field] = v.length <= 8 ? "***REDACTED***" : `${v.slice(0, 4)}••••${v.slice(-4)}（已隐藏，共 ${v.length} 位）`;
    }
  }
  return masked;
}

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const providers = await db.provider.findMany({ orderBy: { sortOrder: "asc" } });
  const accounts = await db.account.findMany();

  // v3.0.3：各提供商近 24h 调用统计（RequestLog 聚合：次数 / 成功率 / 平均耗时）
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [stats24h, okStats24h] = await Promise.all([
    db.requestLog.groupBy({
      by: ["providerId"],
      where: { createdAt: { gte: since24h }, providerId: { not: null } },
      _count: { _all: true },
      _avg: { durationMs: true },
    }),
    db.requestLog.groupBy({
      by: ["providerId"],
      where: { createdAt: { gte: since24h }, providerId: { not: null }, status: { gte: 200, lt: 400 } },
      _count: { _all: true },
    }),
  ]);
  const statsMap = new Map<string, { requests: number; successRate: number; avgDurationMs: number | null }>();
  const okMap = new Map(okStats24h.map((r) => [r.providerId as string, r._count._all]));
  for (const row of stats24h) {
    const pid = row.providerId as string;
    const total = row._count._all;
    const ok = okMap.get(pid) || 0;
    statsMap.set(pid, {
      requests: total,
      successRate: total > 0 ? Math.round((ok / total) * 100) : 100,
      avgDurationMs: row._avg.durationMs !== null ? Math.round(row._avg.durationMs as number) : null,
    });
  }

  // v3.8.0：模型健康一览（对外模型 × 路由候选 × 24h 调用健康）
  const routes = await db.modelRoute.findMany({
    include: { candidates: { orderBy: { sortOrder: "asc" } } },
    orderBy: { model: "asc" },
  });
  const [modelStats, modelOkStats, modelLastUsed] = await Promise.all([
    db.requestLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: since24h } },
      _count: { _all: true },
      _avg: { durationMs: true },
    }),
    db.requestLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: since24h }, status: { gte: 200, lt: 400 } },
      _count: { _all: true },
    }),
    db.requestLog.groupBy({ by: ["model"], _max: { createdAt: true } }),
  ]);
  const mOkMap = new Map(modelOkStats.map((r) => [r.model, r._count._all]));
  const mLastMap = new Map(modelLastUsed.filter((r) => r._max.createdAt).map((r) => [r.model, r._max.createdAt!.toISOString()]));
  const modelHealth = routes.map((r) => {
    const row24 = modelStats.find((s) => s.model === r.model);
    const total = row24?._count._all ?? null;
    const okN = mOkMap.get(r.model) ?? 0;
    return {
      model: r.model,
      enabled: r.enabled,
      candidates: r.candidates.map((c) => ({
        providerId: c.providerId,
        model: c.model,
        enabled: c.enabled,
        sortOrder: c.sortOrder,
      })),
      calls24h: total,
      successRate24h: total && total > 0 ? Math.round((okN / total) * 100) : null,
      avgDurationMs: row24?._avg.durationMs != null ? Math.round(row24._avg.durationMs) : null,
      lastUsedAt: mLastMap.get(r.model) ?? null,
    };
  });

  const result = providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    enabled: p.enabled,
    sortOrder: p.sortOrder,
    proxyOverride: p.proxyOverride,
    config: maskProviderConfig(p.config as Record<string, unknown>),
    accounts: accounts
      .filter((a) => a.providerId === p.id)
      .map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        credentials: maskAccountCredentials(a.credentials as Record<string, unknown>),
        balance: a.balance,
        cooldownUntil: a.cooldownUntil,
        lastCheckinAt: a.lastCheckinAt,
        lastCheckinOk: a.lastCheckinOk,
        lastRefreshAt: a.lastRefreshAt,
      })),
    accountCount: accounts.filter((a) => a.providerId === p.id).length,
    accountEnabledCount: accounts.filter((a) => a.providerId === p.id && a.enabled).length,
    stats24h: statsMap.get(p.id) || null,
  }));

  return ok({
    providers: result,
    supportedTypes: supportedProviderTypes(),
    // 原生项目预设提供商清单（「新增中转」提供商 ID 下拉框数据源；排序/展示与原生一致）
    nativePresets: NATIVE_PROVIDER_PRESETS,
    // v3.8.0：模型健康一览（对外模型 × 路由候选 × 24h 健康指标）
    modelHealth,
  });
}

interface ProviderPayload {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  proxyOverride?: string | null;
  config?: Record<string, unknown>;
  accounts?: Array<{
    id?: string;
    name?: string;
    enabled?: boolean;
    credentials?: Record<string, unknown>;
  }>;
}

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as ProviderPayload;

  if (!body.type || !supportedProviderTypes().includes(body.type)) {
    return fail(`无效的提供商类型：${body.type}（支持 ${supportedProviderTypes().join(", ")}）`);
  }
  if (!body.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.id)) {
    return fail("提供商 ID 必须为 1-64 位字母数字或 -_");
  }
  const exists = await db.provider.findUnique({ where: { id: body.id } });
  if (exists) return fail(`提供商 ID "${body.id}" 已存在`, 409);

  const maxOrder = await db.provider.aggregate({ _max: { sortOrder: true } });
  await db.provider.create({
    data: {
      id: body.id,
      name: body.name || body.id,
      type: body.type,
      enabled: body.enabled !== false,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      config: (body.config || {}) as never,
      proxyOverride: body.proxyOverride ?? null,
    },
  });
  // 账号池
  for (const acc of body.accounts || []) {
    const accId = acc.id || `account-${Date.now().toString(36)}`;
    await db.account.create({
      data: {
        id: accId,
        providerId: body.id,
        name: acc.name || accId,
        enabled: acc.enabled !== false,
        credentials: (acc.credentials || {}) as never,
      },
    });
  }
  await invalidateConfigChanged(); // 失效内存缓存与 fleet 单例
  await auditCreate(
    "provider",
    body.id,
    body.name || body.id,
    {
      type: body.type,
      enabled: body.enabled !== false,
      accountCount: (body.accounts || []).length,
      config: body.config || {},
    },
    request
  );
  return ok({ id: body.id });
}

export async function PUT(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as ProviderPayload;
  if (!body.id) return fail("缺少 provider id");

  const existing = await db.provider.findUnique({
    where: { id: body.id },
    include: { accounts: true },
  });
  if (!existing) return fail("提供商不存在", 404);

  // 凭据回填契约：config 中的敏感字段若为掩码/空 → 沿用 DB 原值；
  // config 整体未提供（undefined）→ 沿用 DB 原值（PATCH 语义，防止只改 enabled/name 的调用静默抹掉全部配置）
  const existingConfig = (existing.config as Record<string, unknown>) || {};
  const incomingConfig = body.config === undefined
    ? { ...existingConfig }
    : ((body.config || {}) as Record<string, unknown>);
  for (const field of SECRET_CONFIG_FIELDS) {
    const val = incomingConfig[field];
    const isMasked =
      val === "***REDACTED***" || val === "" || val === null || val === undefined ||
      (typeof val === "string" && val.includes("••••"));
    if (isMasked && existingConfig[field]) {
      incomingConfig[field] = existingConfig[field];
    }
  }

  await db.provider.update({
    where: { id: body.id },
    data: {
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      config: incomingConfig as never,
      proxyOverride: body.proxyOverride !== undefined ? body.proxyOverride : existing.proxyOverride,
    },
  });

  // 账号池同步（掩码回填契约：账号凭据未改动则沿用 DB 原值）
  const existingAccounts = new Map(existing.accounts.map((a) => [a.id, a]));
  const keepIds = new Set<string>();
  for (const acc of body.accounts || []) {
    const accId = acc.id || `account-${Date.now().toString(36)}`;
    keepIds.add(accId);
    const prev = existingAccounts.get(accId);
    const mergedCreds = mergeCredentialsOnSave(acc.credentials || {}, prev?.credentials as Record<string, unknown>);
    await db.account.upsert({
      where: { providerId_id: { providerId: body.id, id: accId } },
      create: {
        id: accId,
        providerId: body.id,
        name: acc.name || accId,
        enabled: acc.enabled !== false,
        credentials: mergedCreds as never,
      },
      update: {
        name: acc.name ?? (prev?.name || accId),
        enabled: acc.enabled ?? (prev?.enabled ?? true),
        credentials: mergedCreds as never,
      },
    });
  }
  for (const [accId] of existingAccounts) {
    if (!keepIds.has(accId)) {
      await db.account.delete({ where: { providerId_id: { providerId: body.id, id: accId } } });
    }
  }
  await invalidateConfigChanged();
  await auditUpdate(
    "provider",
    body.id,
    body.name ?? existing.name,
    {
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      proxyOverride: body.proxyOverride !== undefined ? body.proxyOverride : existing.proxyOverride,
      accountCount: (body.accounts || []).length,
      removedAccounts: Array.from(existingAccounts.keys()).filter((accId) => !keepIds.has(accId)),
    },
    request
  );
  return ok({ id: body.id });
}

export async function DELETE(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return fail("缺少 provider id");
  // v3.2.0：删除前连同账号池一起快照（级联删除后可凭审计记录追溯）
  const existing = await db.provider.findUnique({ where: { id }, include: { accounts: true } });
  if (!existing) return fail("提供商不存在", 404);
  // 引用检查：路由候选引用时拒绝删除（等价保留 validateConfig 的 routes 引用约束）
  const refCount = await db.routeCandidate.count({ where: { providerId: id } });
  if (refCount > 0) {
    return fail(`仍有 ${refCount} 条路由候选引用该提供商，请先移除相关路由`, 409);
  }
  await db.provider.delete({ where: { id } }); // 级联删除账号
  await invalidateConfigChanged();
  await auditDelete(
    "provider",
    existing.id,
    existing.name,
    {
      snapshot: {
        type: existing.type,
        enabled: existing.enabled,
        config: existing.config,
        proxyOverride: existing.proxyOverride,
        accounts: existing.accounts.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled, credentials: a.credentials })),
      },
      note: "凭据已在审计中脱敏；凭此快照可重建提供商结构与账号清单，凭据需人工重录",
    },
    request
  );
  return ok({ deleted: id });
}
