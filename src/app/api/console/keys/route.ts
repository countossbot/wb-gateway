// /api/console/keys —— 虚拟密钥管理（增删改查、启停、备注、模型白名单、v4.3.0 日配额、v4.5.0 月度成本预算）。
// 密钥值只在创建时返回一次明文；列表/编辑回显掩码，保存时掩码 → DB 原值（回填契约）。
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { requirePermission, ok, fail, maskSecret } from "@/lib/gateway/console/consoleHelpers";
import { invalidateConfigChanged } from "@/lib/gateway/config/configService";
import { localDayKey } from "@/lib/gateway/config/requestLog";
import { loadPricingMap, estimateRowCost } from "@/lib/console/pricing";
import { auditCreate, auditDelete, auditUpdate } from "@/lib/gateway/console/auditService";

export const dynamic = "force-dynamic";

/** v4.3.0：配额入参清洗（非负整数；上限 1 亿防溢出；非法/缺省 → 0 不限额） */
function sanitizeLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100_000_000);
}

/** v4.5.0：月度成本预算入参清洗（非负浮点 $；上限 1 亿防溢出；非法/缺省 → 0 不限） */
function sanitizeBudget(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100_000_000);
}

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "key.read");
  if (session instanceof Response) return session;
  const keys = await db.virtualKey.findMany({ orderBy: { createdAt: "asc" } });

  // v3.0.4：每把密钥近 24h 调用统计（RequestLog.apiKeyName 聚合）
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [keyStats, keyOkStats] = await Promise.all([
    db.requestLog.groupBy({
      by: ["apiKeyName"],
      where: { createdAt: { gte: since24h }, apiKeyName: { not: null } },
      _count: { _all: true },
    }),
    db.requestLog.groupBy({
      by: ["apiKeyName"],
      where: { createdAt: { gte: since24h }, apiKeyName: { not: null }, status: { gte: 200, lt: 400 } },
      _count: { _all: true },
    }),
  ]);
  const okMap = new Map(keyOkStats.map((r) => [r.apiKeyName as string, r._count._all]));
  const statsMap = new Map<string, { requests: number; successRate: number; failures: number }>();
  for (const row of keyStats) {
    const name = row.apiKeyName as string;
    const total = row._count._all;
    const ok = okMap.get(name) || 0;
    statsMap.set(name, {
      requests: total,
      successRate: total > 0 ? Math.round((ok / total) * 100) : 100,
      // v3.1.0：精确失败次数（健康面板 Tooltip 明细）
      failures: total - ok,
    });
  }

  // v3.0.6：每密钥今日 token 聚合（UsageDaily 按日聚合；不受滚动日志窗口截断）
  const todayKey = localDayKey();
  const todayRows = await db.usageDaily.findMany({ where: { day: todayKey, apiKeyName: { not: "" } } });
  const todayMap = new Map<string, { requests: number; okRequests: number; inputTokens: number; outputTokens: number; cachedTokens: number }>();
  for (const r of todayRows) {
    const b = todayMap.get(r.apiKeyName) || { requests: 0, okRequests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    b.requests += r.requests;
    b.okRequests += r.okRequests;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cachedTokens += r.cachedTokens;
    todayMap.set(r.apiKeyName, b);
  }

  // v3.7.0：每密钥最后使用时间（RequestLog 全窗口 MAX(createdAt)，不受时间过滤；
  // 注：RequestLog 为 5000 条滚动窗口，若密钥最后一次调用已被滚出窗口则显示为「从未使用」（语义退化为「近期未使用」，列表提示文案已说明））
  const lastUsedRows = await db.requestLog.groupBy({
    by: ["apiKeyName"],
    where: { apiKeyName: { not: null } },
    _max: { createdAt: true },
  });
  const lastUsedMap = new Map<string, Date>();
  for (const row of lastUsedRows) {
    if (row._max.createdAt) lastUsedMap.set(row.apiKeyName as string, row._max.createdAt);
  }

  // v4.5.0：每密钥本月已累计估算成本（$，UsageDaily 当月行按模型 × 单价表；与网关预算执行同口径）
  const month = localDayKey().slice(0, 7);
  const monthRows = await db.usageDaily.findMany({
    where: { day: { startsWith: month }, apiKeyName: { not: "" } },
    select: { apiKeyName: true, model: true, inputTokens: true, outputTokens: true, cachedTokens: true },
  });
  const pricing = await loadPricingMap();
  const monthCostMap = new Map<string, number>();
  for (const r of monthRows) {
    const c = estimateRowCost(pricing, r.model, r.inputTokens, r.outputTokens, r.cachedTokens);
    if (c === null) continue; // 未配置单价不计成本（保守口径）
    monthCostMap.set(r.apiKeyName, (monthCostMap.get(r.apiKeyName) || 0) + c);
  }

  // v4.9.0：ownerUserId → owner display info
  const members = await db.adminUser.findMany({
    select: { id: true, username: true, displayName: true },
  });
  const memberMap = new Map(members.map((m) => [m.id, m]));

  return ok({
    keys: keys.map((k) => ({
      ownerUserId: k.ownerUserId || null,
      owner: k.ownerUserId ? {
        id: k.ownerUserId,
        username: memberMap.get(k.ownerUserId)?.username || "",
        displayName: memberMap.get(k.ownerUserId)?.displayName || memberMap.get(k.ownerUserId)?.username || "",
      } : null,
      id: k.id,
      name: k.name,
      keyMasked: maskSecret(k.keyValue),
      keyPrefix: k.keyPrefix,
      enabled: k.enabled,
      models: k.models,
      role: k.role,
      remark: k.remark,
      dailyRequestLimit: k.dailyRequestLimit,
      dailyTokenLimit: k.dailyTokenLimit,
      monthlyCostLimit: k.monthlyCostLimit,
      monthCost: Math.round((monthCostMap.get(k.name) || 0) * 1e6) / 1e6,
      createdAt: k.createdAt,
      updatedAt: k.updatedAt,
      stats24h: statsMap.get(k.name) || null,
      todayStats: todayMap.get(k.name) || null,
      lastUsedAt: lastUsedMap.get(k.name)?.toISOString() || null,
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await requirePermission(request, "key.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    keyValue?: string; // 自定义密钥（缺省自动生成）
    models?: string[];
    role?: string;
    remark?: string;
    dailyRequestLimit?: number; // v4.3.0：日请求配额（0 = 不限额）
    dailyTokenLimit?: number; // v4.3.0：日 token 配额（0 = 不限额）
    monthlyCostLimit?: number; // v4.5.0：月度成本预算（$/估算；0 = 不限）
    ownerUserId?: string | null; // v4.9.0：归属成员（可选）
  };
  // v4.9.0：ownerUserId 校验（传了必须是有效成员）
  let ownerUserId: string | null = null;
  if (body.ownerUserId) {
    const owner = await db.adminUser.findUnique({ where: { id: body.ownerUserId } });
    if (!owner || !owner.enabled) return fail("归属成员不存在或已禁用");
    ownerUserId = owner.id;
  }
  const keyValue = body.keyValue?.trim() || "sk-uag-" + randomBytes(20).toString("base64url");
  if (keyValue.length < 16) return fail("密钥长度至少 16 位");
  const exists = await db.virtualKey.findUnique({ where: { keyValue } });
  if (exists) return fail("密钥已存在", 409);
  const key = await db.virtualKey.create({
    data: {
      name: body.name || "Client Key",
      keyValue,
      keyPrefix: keyValue.slice(0, 6),
      enabled: true,
      models: (body.models && body.models.length > 0 ? body.models : ["*"]) as never,
      role: body.role || "client",
      remark: body.remark || null,
      dailyRequestLimit: sanitizeLimit(body.dailyRequestLimit),
      dailyTokenLimit: sanitizeLimit(body.dailyTokenLimit),
      monthlyCostLimit: sanitizeBudget(body.monthlyCostLimit),
      ownerUserId,
    },
  });
  await invalidateConfigChanged();
  // 创建时一次性返回明文（此后只有掩码）
  await auditCreate(
    "key",
    key.id,
    key.name,
    { models: key.models, role: key.role, keyPrefix: key.keyPrefix, customKey: !!body.keyValue?.trim(), dailyRequestLimit: key.dailyRequestLimit, dailyTokenLimit: key.dailyTokenLimit, monthlyCostLimit: key.monthlyCostLimit },
    request
  );
  return ok({ id: key.id, keyValue });
}

export async function PUT(request: NextRequest) {
  const session = await requirePermission(request, "key.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    enabled?: boolean;
    models?: string[];
    role?: string;
    remark?: string | null;
    dailyRequestLimit?: number; // v4.3.0：日请求配额（0 = 不限额；缺省保留现值）
    dailyTokenLimit?: number; // v4.3.0：日 token 配额（0 = 不限额；缺省保留现值）
    monthlyCostLimit?: number; // v4.5.0：月度成本预算（$/估算；0 = 不限；缺省保留现值）
    ownerUserId?: string | null; // v4.9.0：归属成员（null = 清除归属；缺省保留现值）
  };
  if (!body.id) return fail("缺少 key id");
  const existing = await db.virtualKey.findUnique({ where: { id: body.id } });
  if (!existing) return fail("密钥不存在", 404);
  // v4.3.0：配额缺省保留现值（开关切换 toggleEnabled 不传配额时不误清限额）；
  // 显式传 0 清除限额。非负整数入参清洗与创建一致。
  const nextReqLimit = body.dailyRequestLimit !== undefined ? sanitizeLimit(body.dailyRequestLimit) : existing.dailyRequestLimit;
  const nextTokLimit = body.dailyTokenLimit !== undefined ? sanitizeLimit(body.dailyTokenLimit) : existing.dailyTokenLimit;
  // v4.5.0：月预算同语义（缺省保留现值；显式 0 清除）
  const nextMonthlyBudget = body.monthlyCostLimit !== undefined ? sanitizeBudget(body.monthlyCostLimit) : existing.monthlyCostLimit;
  await db.virtualKey.update({
    where: { id: body.id },
    data: {
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      models: (body.models ?? (existing.models as string[])) as never,
      role: body.role ?? existing.role,
      remark: body.remark !== undefined ? body.remark : existing.remark,
      dailyRequestLimit: nextReqLimit,
      dailyTokenLimit: nextTokLimit,
      monthlyCostLimit: nextMonthlyBudget,
      ownerUserId: body.ownerUserId !== undefined ? body.ownerUserId : existing.ownerUserId,
    },
  });
  await invalidateConfigChanged();
  await auditUpdate(
    "key",
    body.id,
    body.name ?? existing.name,
    {
      name: body.name ?? existing.name,
      enabled: body.enabled ?? existing.enabled,
      models: body.models ?? (existing.models as string[]),
      role: body.role ?? existing.role,
      dailyRequestLimit: nextReqLimit,
      dailyTokenLimit: nextTokLimit,
      monthlyCostLimit: nextMonthlyBudget,
    },
    request
  );
  return ok({ id: body.id });
}

export async function DELETE(request: NextRequest) {
  const session = await requirePermission(request, "key.write");
  if (session instanceof Response) return session;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return fail("缺少 key id");
  const existing = await db.virtualKey.findUnique({ where: { id } });
  if (!existing) return fail("密钥不存在", 404);
  await db.virtualKey.delete({ where: { id } });
  await invalidateConfigChanged();
  await auditDelete(
    "key",
    existing.id,
    existing.name,
    {
      snapshot: { name: existing.name, keyPrefix: existing.keyPrefix, models: existing.models, role: existing.role, remark: existing.remark },
      note: "密钥值不进审计（凭据脱敏）；删除后使用该密钥的调用将 401",
    },
    request
  );
  return ok({ deleted: id });
}
