// /api/console/routes —— 模型路由管理（模型名 → 有序候选列表）。
// GET：路由 + 候选 + 可选提供商清单（前端拖拽排序）+ 近 24h 每路由调用统计；
// POST：新增路由；PUT：更新（含候选拖拽后的新顺序）；DELETE ?model=：删除路由。
// v4.9.13-local：GET 增补 implicitRoutes —— 运行时回填生效但未落库的代码默认路由，
// 修复「总览显示 9 条路由、管理页只见 3 条」的口径不一致（backfillMissingRoutes 只补内存不写库，
// 用户在 UI 上完全看不到这批路由的存在）。前端单独成区展示，可一键「转为自定义路由」落库接管。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { getConfig, invalidateConfigChanged } from "@/lib/gateway/config/configService";
import { auditCreate, auditDelete, auditUpdate } from "@/lib/gateway/console/auditService";
import {
  readRouteTestStore,
  deleteRouteTestResult,
} from "@/lib/gateway/console/routeTestStore";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const [routes, providers] = await Promise.all([
    db.modelRoute.findMany({
      include: { candidates: { orderBy: { sortOrder: "asc" } } },
      orderBy: { model: "asc" },
    }),
    // 提供商按 sortOrder 升序（与「API 中转」及原生配置展示顺序一致）
    db.provider.findMany({ select: { id: true, name: true, type: true, enabled: true }, orderBy: { sortOrder: "asc" } }),
  ]);

  // v4.9.12-local-r4：近 24h 每路由调用统计（RequestLog.model = 客户端请求的路由模型名）。
  // 单条 groupBy 查询覆盖全部路由，无 N+1；零流量路由不出现在结果中（前端按缺省渲染「24h 无调用」）。
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const grouped = await db.requestLog.groupBy({
    by: ["model"],
    where: { createdAt: { gte: since24h } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true },
    _avg: { durationMs: true },
    _max: { createdAt: true },
  });
  // 错误数需要单独统计（groupBy 无法同时按 status 细分出错误行）
  const errGrouped = await db.requestLog.groupBy({
    by: ["model"],
    where: { createdAt: { gte: since24h }, status: { gte: 400 } },
    _count: { _all: true },
  });
  const errCountByModel = new Map(errGrouped.map((g) => [g.model, g._count._all]));
  const stats: Record<string, {
    requests: number; errors: number; avgDurationMs: number | null;
    inputTokens: number; outputTokens: number; lastCallAt: string | null;
  }> = {};
  for (const g of grouped) {
    stats[g.model] = {
      requests: g._count._all,
      errors: errCountByModel.get(g.model) ?? 0,
      avgDurationMs: g._avg.durationMs != null ? Math.round(g._avg.durationMs) : null,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      lastCallAt: g._max.createdAt ? g._max.createdAt.toISOString() : null,
    };
  }

  // v4.9.12-local-r5：按「最终命中提供商」聚合（RequestLog 仅记录最终服务的 provider，
  // failover 中间失败不计入候选命中）。用于路由候选芯片的 24h 命中计数 ×N。
  const provGrouped = await db.requestLog.groupBy({
    by: ["providerId"],
    where: { createdAt: { gte: since24h }, providerId: { not: null } },
    _count: { _all: true },
    _avg: { durationMs: true },
  });
  const provErrGrouped = await db.requestLog.groupBy({
    by: ["providerId"],
    where: { createdAt: { gte: since24h }, providerId: { not: null }, status: { gte: 400 } },
    _count: { _all: true },
  });
  const provErrById = new Map(provErrGrouped.map((g) => [g.providerId as string, g._count._all]));
  const providerStats24h: Record<string, { requests: number; errors: number; avgDurationMs: number | null }> = {};
  for (const g of provGrouped) {
    if (!g.providerId) continue;
    providerStats24h[g.providerId] = {
      requests: g._count._all,
      errors: provErrById.get(g.providerId) ?? 0,
      avgDurationMs: g._avg.durationMs != null ? Math.round(g._avg.durationMs) : null,
    };
  }

  // v4.9.13-local：隐式代码默认路由 —— getConfig() 返回的运行时有效路由（含 backfillMissingRoutes
  // 回填的代码默认项）中，不在 DB ModelRoute 表里的部分。它们真实生效（可被客户端调用），
  // 但因未落库在管理页不可见不可管。这里下发给前端单独成区展示。
  // 口径注意：只看 model 键是否在 DB；候选链以运行时为准（与网关 dispatch 行为一致）。
  let implicitRoutes: Array<{
    model: string;
    prompt: string | null;
    candidates: Array<{ providerId: string; model: string; enabled: boolean; sortOrder: number }>;
  }> = [];
  try {
    const runtimeConfig = await getConfig();
    const dbModels = new Set(routes.map((r) => r.model));
    implicitRoutes = Object.entries(runtimeConfig.routes || {})
      .filter(([model]) => !dbModels.has(model))
      .map(([model, candidateList]) => ({
        model,
        // routePrompts 与 routes 平级存储；隐式路由未落库故 prompt 恒为 null（回填不携带提示词）
        prompt: null,
        candidates: (Array.isArray(candidateList) ? candidateList : [])
          .filter((c) => c && typeof c.provider === "string" && typeof c.model === "string")
          .map((c, i) => ({ providerId: c.provider, model: c.model, enabled: true, sortOrder: i })),
      }))
      .sort((a, b) => a.model.localeCompare(b.model));
  } catch (e) {
    // 运行时配置获取失败不阻断路由管理主功能（隐式区静默降级为不展示）
    console.error("[RoutesAPI] failed to compute implicit routes:", (e as Error).message);
    implicitRoutes = [];
  }

  // v4.9.13-local-r16：回读快测持久化结果（键 = 路由模型名；自定义与隐式路由统一附带 lastTest）
  const testStore = await readRouteTestStore();

  return ok({
    routes: routes.map((r) => ({
      id: r.id,
      model: r.model,
      enabled: r.enabled,
      // v4.6.0：路由级系统提示词（null = 未配置）
      prompt: r.prompt ?? null,
      candidates: r.candidates.map((c) => ({
        id: c.id,
        providerId: c.providerId,
        model: c.model,
        enabled: c.enabled,
        sortOrder: c.sortOrder,
      })),
      lastTest: testStore[r.model]?.last,
    })),
    // v4.9.13-local：运行时生效但未落库的代码默认路由（只读展示；前端提供「转为自定义」落库入口）
    implicitRoutes: implicitRoutes.map((r) => ({ ...r, lastTest: testStore[r.model]?.last })),
    providers,
    // v4.9.12-local-r4：24h 统计（键 = 路由模型名）
    stats24h: stats,
    // v4.9.12-local-r5：24h 最终命中提供商统计（键 = providerId）
    providerStats24h,
  });
}

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    model?: string;
    candidates?: Array<{ providerId?: string; provider?: string; model?: string }>;
    prompt?: string | null;
  };
  if (!body.model || !/^[a-zA-Z0-9._/\[\]-]{1,128}$/.test(body.model)) {
    return fail("模型名不合法（1-128 位字母数字与 . _ / [ ] -）");
  }
  const exists = await db.modelRoute.findUnique({ where: { model: body.model } });
  if (exists) return fail(`路由 "${body.model}" 已存在`, 409);

  const promptText = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null;
  const route = await db.modelRoute.create({
    data: { model: body.model, enabled: true, prompt: promptText },
  });
  let order = 0;
  for (const c of body.candidates || []) {
    const providerId = c.providerId || c.provider;
    if (!providerId || !c.model) continue;
    const provider = await db.provider.findUnique({ where: { id: providerId } });
    if (!provider) return fail(`候选引用的提供商 "${providerId}" 不存在`, 400);
    await db.routeCandidate.create({
      data: { routeId: route.id, providerId, model: c.model, enabled: true, sortOrder: order++ },
    });
  }
  await invalidateConfigChanged();
  await auditCreate(
    "route",
    route.id,
    body.model,
    { candidates: (body.candidates || []).map((c) => ({ providerId: c.providerId || c.provider, model: c.model })) },
    request
  );
  return ok({ id: route.id, model: body.model });
}

export async function PUT(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    id?: number;
    model?: string;
    enabled?: boolean;
    candidates?: Array<{ providerId?: string; provider?: string; model?: string; enabled?: boolean }>;
    prompt?: string | null;
  };
  if (!body.id) return fail("缺少路由 id");
  const existing = await db.modelRoute.findUnique({
    where: { id: body.id },
    include: { candidates: true },
  });
  if (!existing) return fail("路由不存在", 404);

  if (body.model && body.model !== existing.model) {
    const dup = await db.modelRoute.findUnique({ where: { model: body.model } });
    if (dup) return fail(`模型名 "${body.model}" 已被占用`, 409);
  }

  // v4.6.0：prompt 仅在请求显式携带该字段时更新（undefined = 保持原值，
  // 空串/null = 清除注入），避免其他调用方漏传字段时静默清空提示词。
  const promptPatch =
    body.prompt === undefined
      ? {}
      : {
          prompt:
            typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null,
        };

  await db.modelRoute.update({
    where: { id: body.id },
    data: {
      model: body.model ?? existing.model,
      enabled: body.enabled ?? existing.enabled,
      ...promptPatch,
    },
  });

  // 候选全量重写（拖拽排序后的新顺序）
  if (Array.isArray(body.candidates)) {
    // 先校验全部引用（原子性：任一无效则整体拒绝）
    for (const c of body.candidates) {
      const providerId = c.providerId || c.provider;
      if (!providerId || !c.model) return fail("候选项缺少 providerId 或 model");
      const provider = await db.provider.findUnique({ where: { id: providerId } });
      if (!provider) return fail(`候选引用的提供商 "${providerId}" 不存在`, 400);
    }
    await db.routeCandidate.deleteMany({ where: { routeId: body.id } });
    let order = 0;
    for (const c of body.candidates) {
      await db.routeCandidate.create({
        data: {
          routeId: body.id,
          providerId: c.providerId || (c.provider as string),
          model: c.model as string,
          enabled: c.enabled !== false,
          sortOrder: order++,
        },
      });
    }
  }
  await invalidateConfigChanged();
  await auditUpdate(
    "route",
    body.id,
    existing.model,
    {
      model: body.model ?? existing.model,
      enabled: body.enabled ?? existing.enabled,
      candidates: Array.isArray(body.candidates)
        ? body.candidates.map((c) => ({ providerId: c.providerId || c.provider, model: c.model, enabled: c.enabled !== false }))
        : undefined,
      // v4.6.0：只记变更标志与长度，避免长提示词全文撑爆审计表
      promptChanged:
        body.prompt === undefined
          ? undefined
          : (body.prompt?.trim() || null) !== (existing.prompt?.trim() || null),
      promptLength:
        body.prompt === undefined ? undefined : (body.prompt?.trim().length ?? 0),
    },
    request
  );
  return ok({ id: body.id });
}

export async function DELETE(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const id = request.nextUrl.searchParams.get("id");
  const model = request.nextUrl.searchParams.get("model");
  const where = id ? { id: Number(id) } : model ? { model } : null;
  if (!where) return fail("缺少路由 id 或 model");
  // v3.2.0：删除前连同候选一起快照（级联删除后可凭审计记录追溯/重建结构）
  const existing = await db.modelRoute.findUnique({ where, include: { candidates: true } });
  if (!existing) return fail("路由不存在", 404);
  await db.modelRoute.delete({ where }); // 级联删除候选
  await invalidateConfigChanged();
  // v4.9.13-local-r16：清理该路由的快测持久化记录（孤儿键；失败静默不阻断删除）
  await deleteRouteTestResult(existing.model);
  await auditDelete(
    "route",
    existing.id,
    existing.model,
    {
      snapshot: {
        model: existing.model,
        enabled: existing.enabled,
        candidates: existing.candidates.map((c) => ({
          providerId: c.providerId,
          model: c.model,
          enabled: c.enabled,
          sortOrder: c.sortOrder,
        })),
      },
      note: "凭此快照可重建路由（POST /api/console/routes），候选顺序按 sortOrder",
    },
    request
  );
  return ok({ deleted: existing.model });
}
