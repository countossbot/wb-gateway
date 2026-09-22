// /api/console/accounts —— 账号管理（按提供商分组的列表 + 单账号 CRUD + 启停）。
// GET ?providerId=：某提供商账号列表（凭据掩码）；POST：新增账号；
// PUT：编辑（掩码回填契约）；DELETE ?providerId=&id=：删除；PATCH：快速启停。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requirePermission,
  ok,
  fail,
  maskAccountCredentials,
  mergeCredentialsOnSave,
} from "@/lib/gateway/console/consoleHelpers";
import { invalidateConfigChanged } from "@/lib/gateway/config/configService";
import { auditCreate, auditDelete, auditToggle, auditUpdate } from "@/lib/gateway/console/auditService";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "provider.read");
  if (session instanceof Response) return session;
  const providerId = request.nextUrl.searchParams.get("providerId");

  const accounts = await db.account.findMany({
    where: providerId ? { providerId } : undefined,
    orderBy: [{ providerId: "asc" }, { id: "asc" }],
  });
  const providers = await db.provider.findMany({ select: { id: true, name: true, type: true } });

  // v3.0.4：每账号近 24h 调用统计（RequestLog 按 providerId+accountId 复合聚合，避免跨提供商同名账号串扰）
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [accStats, accOkStats] = await Promise.all([
    db.requestLog.groupBy({
      by: ["providerId", "accountId"],
      where: { createdAt: { gte: since24h }, accountId: { not: null } },
      _count: { _all: true },
    }),
    db.requestLog.groupBy({
      by: ["providerId", "accountId"],
      where: { createdAt: { gte: since24h }, accountId: { not: null }, status: { gte: 200, lt: 400 } },
      _count: { _all: true },
    }),
  ]);
  const okAccMap = new Map(accOkStats.map((r) => [`${r.providerId}/${r.accountId}`, r._count._all]));
  const accStatsMap = new Map<string, { requests: number; successRate: number; failures: number }>();
  for (const row of accStats) {
    const key = `${row.providerId}/${row.accountId}`;
    const total = row._count._all;
    const ok = okAccMap.get(key) || 0;
    accStatsMap.set(key, {
      requests: total,
      successRate: total > 0 ? Math.round((ok / total) * 100) : 100,
      // v3.1.0：精确失败次数（健康面板 Tooltip 明细）
      failures: total - ok,
    });
  }

  // v3.8.0：每账号最后调用时间（RequestLog 滚动窗口 MAX(createdAt)，按 providerId+accountId 复合维度，
  // 与 keys 页「最后使用」同口径；不受 24h 过滤，长期闲置账号也能看到窗口内的尾巴）
  const lastUsedRows = await db.requestLog.groupBy({
    by: ["providerId", "accountId"],
    where: { accountId: { not: null } },
    _max: { createdAt: true },
  });
  const lastUsedMap = new Map<string, string>();
  for (const row of lastUsedRows) {
    if (row._max.createdAt) {
      lastUsedMap.set(`${row.providerId}/${row.accountId}`, row._max.createdAt.toISOString());
    }
  }

  // 按提供商分组（验收要求三.3「按提供商分组的列表」）
  const grouped = providers.map((p) => ({
    provider: { id: p.id, name: p.name, type: p.type },
    accounts: accounts
      .filter((a) => a.providerId === p.id)
      .map((a) => ({
        id: a.id,
        providerId: a.providerId,
        name: a.name,
        enabled: a.enabled,
        credentials: maskAccountCredentials(a.credentials as Record<string, unknown>),
        balance: a.balance,
        cooldownUntil: a.cooldownUntil,
        cooldownStreak: a.cooldownStreak,
        // v3.2.2：冷却原因摘要（tooltip 展示，运维排障用）
        cooldownReason: a.cooldownReason,
        lastCheckinAt: a.lastCheckinAt,
        lastCheckinOk: a.lastCheckinOk,
        lastRefreshAt: a.lastRefreshAt,
        stats24h: accStatsMap.get(`${a.providerId}/${a.id}`) || null,
        // v3.8.0：最后调用时间（滚动窗口语义，UI 侧已说明）
        lastUsedAt: lastUsedMap.get(`${a.providerId}/${a.id}`) || null,
      })),
  }));

  return ok({ grouped, total: accounts.length, enabled: accounts.filter((a) => a.enabled).length });
}

export async function POST(request: NextRequest) {
  const session = await requirePermission(request, "provider.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    providerId?: string;
    id?: string;
    name?: string;
    enabled?: boolean;
    credentials?: Record<string, unknown>;
  };
  if (!body.providerId) return fail("缺少 providerId");
  const provider = await db.provider.findUnique({ where: { id: body.providerId } });
  if (!provider) return fail("提供商不存在", 404);
  const accId = body.id || `account-${Date.now().toString(36)}`;
  const exists = await db.account.findUnique({
    where: { providerId_id: { providerId: body.providerId, id: accId } },
  });
  if (exists) return fail(`账号 "${accId}" 已存在`, 409);
  await db.account.create({
    data: {
      id: accId,
      providerId: body.providerId,
      name: body.name || accId,
      enabled: body.enabled !== false,
      credentials: (body.credentials || {}) as never,
    },
  });
  await invalidateConfigChanged();
  await auditCreate(
    "account",
    `${body.providerId}/${accId}`,
    body.name || accId,
    { providerId: body.providerId, enabled: body.enabled !== false },
    request
  );
  return ok({ id: accId, providerId: body.providerId });
}

export async function PUT(request: NextRequest) {
  const session = await requirePermission(request, "provider.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    providerId?: string;
    id?: string;
    name?: string;
    enabled?: boolean;
    credentials?: Record<string, unknown>;
  };
  if (!body.providerId || !body.id) return fail("缺少 providerId 或 id");
  const existing = await db.account.findUnique({
    where: { providerId_id: { providerId: body.providerId, id: body.id } },
  });
  if (!existing) return fail("账号不存在", 404);

  // 掩码回填契约：credentials 中掩码/空字段沿用 DB 原值（绝不允许一次保存清空凭据）
  const merged = mergeCredentialsOnSave(body.credentials || {}, existing.credentials as Record<string, unknown>);

  await db.account.update({
    where: { providerId_id: { providerId: body.providerId, id: body.id } },
    data: {
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      credentials: merged as never,
    },
  });
  await invalidateConfigChanged();
  await auditUpdate(
    "account",
    `${body.providerId}/${body.id}`,
    body.name ?? existing.name,
    { name: body.name ?? existing.name, enabled: body.enabled ?? existing.enabled, credentialsChanged: !!body.credentials },
    request
  );
  return ok({ id: body.id, providerId: body.providerId });
}

// PATCH：快速启停（列表开关）
export async function PATCH(request: NextRequest) {
  const session = await requirePermission(request, "provider.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    providerId?: string;
    id?: string;
    enabled?: boolean;
  };
  if (!body.providerId || !body.id || body.enabled === undefined) {
    return fail("缺少 providerId / id / enabled");
  }
  const existing = await db.account.findUnique({
    where: { providerId_id: { providerId: body.providerId, id: body.id } },
  });
  if (!existing) return fail("账号不存在", 404);
  await db.account.update({
    where: { providerId_id: { providerId: body.providerId, id: body.id } },
    data: { enabled: body.enabled },
  });
  await invalidateConfigChanged();
  await auditToggle("account", `${body.providerId}/${body.id}`, existing.name || body.id, body.enabled, request);
  return ok({ id: body.id, enabled: body.enabled });
}

export async function DELETE(request: NextRequest) {
  const session = await requirePermission(request, "provider.write");
  if (session instanceof Response) return session;
  const providerId = request.nextUrl.searchParams.get("providerId");
  const id = request.nextUrl.searchParams.get("id");
  if (!providerId || !id) return fail("缺少 providerId 或 id");
  const existing = await db.account.findUnique({
    where: { providerId_id: { providerId, id } },
  });
  if (!existing) return fail("账号不存在", 404);
  await db.account.delete({ where: { providerId_id: { providerId, id } } });
  await invalidateConfigChanged();
  await auditDelete(
    "account",
    `${providerId}/${id}`,
    existing.name || id,
    {
      snapshot: { providerId, accountId: id, name: existing.name, enabled: existing.enabled, credentials: existing.credentials },
      note: "凭据已在审计中脱敏；凭此快照可追溯账号配置结构，凭据需人工重录",
    },
    request
  );
  return ok({ deleted: `${providerId}/${id}` });
}
