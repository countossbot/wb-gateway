// /api/console/routes —— 模型路由管理（模型名 → 有序候选列表）。
// GET：路由 + 候选 + 可选提供商清单（前端拖拽排序）；POST：新增路由；
// PUT：更新（含候选拖拽后的新顺序）；DELETE ?model=：删除路由。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { invalidateConfigChanged, nativeProviderModels } from "@/lib/gateway/config/configService";
import { auditCreate, auditDelete, auditUpdate } from "@/lib/gateway/console/auditService";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "route.read");
  if (session instanceof Response) return session;
  const [routes, providers] = await Promise.all([
    db.modelRoute.findMany({
      include: { candidates: { orderBy: { sortOrder: "asc" } } },
      orderBy: { model: "asc" },
    }),
    // 提供商按 sortOrder 升序（与「API 中转」及原生配置展示顺序一致）
    db.provider.findMany({ select: { id: true, name: true, type: true, enabled: true }, orderBy: { sortOrder: "asc" } }),
  ]);
  return ok({
    routes: routes.map((r) => ({
      id: r.id,
      model: r.model,
      enabled: r.enabled,
      candidates: r.candidates.map((c) => ({
        id: c.id,
        providerId: c.providerId,
        model: c.model,
        enabled: c.enabled,
        sortOrder: c.sortOrder,
      })),
    })),
    providers,
    // 原生模型目录（按适配器类型归组，模型 ID 原样透传）——候选项「模型」下拉框数据源
    providerModels: nativeProviderModels(),
  });
}

export async function POST(request: NextRequest) {
  const session = await requirePermission(request, "route.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    model?: string;
    candidates?: Array<{ providerId?: string; provider?: string; model?: string }>;
  };
  if (!body.model || !/^[a-zA-Z0-9._/\[\]-]{1,128}$/.test(body.model)) {
    return fail("模型名不合法（1-128 位字母数字与 . _ / [ ] -）");
  }
  const exists = await db.modelRoute.findUnique({ where: { model: body.model } });
  if (exists) return fail(`路由 "${body.model}" 已存在`, 409);

  const route = await db.modelRoute.create({ data: { model: body.model, enabled: true } });
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
  const session = await requirePermission(request, "route.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    id?: number;
    model?: string;
    enabled?: boolean;
    candidates?: Array<{ providerId?: string; provider?: string; model?: string; enabled?: boolean }>;
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

  await db.modelRoute.update({
    where: { id: body.id },
    data: {
      model: body.model ?? existing.model,
      enabled: body.enabled ?? existing.enabled,
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
    },
    request
  );
  return ok({ id: body.id });
}

export async function DELETE(request: NextRequest) {
  const session = await requirePermission(request, "route.write");
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
