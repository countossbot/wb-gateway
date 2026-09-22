// POST /api/console/audit/restore —— 从审计删除快照一键重建模型路由（v3.2.3）。
// Task 17「路由全删」事故防御的最后一环：删除操作已在审计表留完整前快照
// （model/enabled/candidates 含 sortOrder），本端点凭快照原样回填，无需手工照抄 JSON。
//
// 安全语义（只增不删，绝不覆盖）：
// 1. 仅接受 entity=route 且 action=delete 的审计条目；
// 2. 若同名路由已存在 → 409 拒绝（不覆盖、不合并，避免误恢复放大事故）；
// 3. 候选引用的提供商必须仍然存在，缺失则明确报错（不静默跳过）；
// 4. 恢复成功后写一条 action=restore 的审计记录（来源审计 id 可追溯）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { invalidateConfigChanged } from "@/lib/gateway/config/configService";
import { auditRestore } from "@/lib/gateway/console/auditService";

export const dynamic = "force-dynamic";

interface RouteSnapshot {
  model?: string;
  enabled?: boolean;
  candidates?: Array<{ providerId?: string; model?: string; enabled?: boolean; sortOrder?: number }>;
}

export async function POST(request: NextRequest) {
  const session = await requirePermission(request, "backup.write");
  if (session instanceof Response) return session;

  const body = (await request.json().catch(() => ({}))) as { auditId?: number };
  const auditId = Number(body.auditId);
  if (!Number.isFinite(auditId) || auditId <= 0) return fail("缺少有效的 auditId");

  const entry = await db.auditLog.findUnique({ where: { id: auditId } });
  if (!entry) return fail("审计记录不存在（可能已被保留期清理）", 404);
  if (entry.entity !== "route" || entry.action !== "delete") {
    return fail("仅支持从「模型路由删除」类审计快照恢复");
  }

  const snap = (entry.detail as { snapshot?: RouteSnapshot } | null)?.snapshot;
  if (!snap || typeof snap.model !== "string" || !snap.model) {
    return fail("该审计记录缺少可用的路由快照（早期记录未保存快照）");
  }
  const candidates = Array.isArray(snap.candidates) ? snap.candidates : [];
  if (candidates.length === 0) {
    return fail("快照中无候选列表，恢复后将得到空路由（已拒绝，请改用手工重建）");
  }

  // 幂等防护：同名路由已存在则拒绝（绝不覆盖既有配置）
  const exists = await db.modelRoute.findUnique({ where: { model: snap.model } });
  if (exists) {
    return fail(`路由 "${snap.model}" 已存在（id=${exists.id}），无需重建；如需对齐快照请手工编辑该路由`, 409);
  }

  // 校验候选引用的提供商仍存在（不静默跳过，避免恢复出「看起来成功实则残缺」的路由）
  const missing: string[] = [];
  for (const c of candidates) {
    if (!c.providerId || !c.model) return fail("快照候选项缺少 providerId 或 model 字段，快照可能已损坏");
    const p = await db.provider.findUnique({ where: { id: c.providerId }, select: { id: true } });
    if (!p) missing.push(c.providerId);
  }
  if (missing.length > 0) {
    return fail(`快照引用的提供商已不存在：${[...new Set(missing)].join("、")}；请先重建提供商后再恢复路由`, 400);
  }

  const route = await db.modelRoute.create({
    data: { model: snap.model, enabled: snap.enabled !== false },
  });
  const ordered = [...candidates].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  let order = 0;
  for (const c of ordered) {
    await db.routeCandidate.create({
      data: {
        routeId: route.id,
        providerId: c.providerId as string,
        model: c.model as string,
        enabled: c.enabled !== false,
        sortOrder: order++,
      },
    });
  }
  await invalidateConfigChanged();
  await auditRestore(
    "route",
    route.id,
    snap.model,
    {
      restoredFromAuditId: auditId,
      candidates: ordered.length,
      note: "从删除审计快照一键重建",
    },
    request
  );
  return ok({ id: route.id, model: snap.model, candidates: ordered.length });
}
