// GET /api/console/audit?limit=100[&entity=][&action=][&days=] —— 控制台操作审计查询（v3.2.0）。
// POST /api/console/audit —— 手动按保留期清理过期审计（v3.2.2；仅删超过 auditRetentionDays 的记录）。
// Task 17「路由全删」事故的防御闭环：谁在什么时候删了什么、删除前长什么样（快照可追溯）。
// 响应形态：
// {
//   entries: [ { id, action, entity, entityId, entityName, detail, ip, actor, createdAt } ],
//   stats: { total24h, deletes24h, total7d, total, retentionDays },
//   filter: { entity?, action?, limit, days }
// }
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { purgeExpiredAuditLogs } from "@/lib/gateway/jobs/scheduler";
import { recordAudit } from "@/lib/gateway/console/auditService";
import { getRuntimeSettingsAsync } from "@/lib/gateway/config/runtimeSettings";

export const dynamic = "force-dynamic";

const VALID_ENTITIES = ["provider", "account", "route", "key", "setting", "system"];
const VALID_ACTIONS = ["delete", "create", "update", "toggle", "regenerate", "restore"];

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const params = request.nextUrl.searchParams;
  const entity = params.get("entity");
  const action = params.get("action");
  const daysParam = Number(params.get("days")) || 0;
  const days = daysParam > 0 ? Math.min(90, daysParam) : 0; // 0 = 不限时间窗口
  const limit = Math.min(500, Math.max(1, Number(params.get("limit")) || 100));

  if (entity && !VALID_ENTITIES.includes(entity)) return fail(`无效实体类型：${entity}`);
  if (action && !VALID_ACTIONS.includes(action)) return fail(`无效操作类型：${action}`);

  const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined;
  const since24h = new Date(Date.now() - 86_400_000);
  const since7d = new Date(Date.now() - 7 * 86_400_000);

  const entries = await db.auditLog.findMany({
    where: {
      ...(entity ? { entity } : {}),
      ...(action ? { action } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const [total24h, deletes24h, total7d, total, retentionDays] = await Promise.all([
    db.auditLog.count({ where: { createdAt: { gte: since24h } } }),
    db.auditLog.count({ where: { createdAt: { gte: since24h }, action: "delete" } }),
    db.auditLog.count({ where: { createdAt: { gte: since7d } } }),
    db.auditLog.count(),
    getRuntimeSettingsAsync().then((s) => s.auditRetentionDays),
  ]);

  return ok({
    entries: entries.map((e) => ({
      id: e.id,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      entityName: e.entityName,
      detail: e.detail,
      ip: e.ip,
      actor: e.actor,
      createdAt: e.createdAt.toISOString(),
    })),
    stats: { total24h, deletes24h, total7d, total, retentionDays },
    filter: { entity: entity || null, action: action || null, limit, days: days || null },
  });
}

// v3.2.2：手动清理过期审计（按当前保留期设置；0 = 永久保留，拒绝执行并提示）。
// 清理动作本身留审计痕（删除数量进 detail），保证操作可追溯。
export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const retention = (await getRuntimeSettingsAsync()).auditRetentionDays;
  if (!retention || retention <= 0) {
    return fail("当前保留期为「永久保留」，无过期记录可清理；如需启用请先在系统参数中设置保留天数");
  }
  const purged = await purgeExpiredAuditLogs(retention);
  await recordAudit(
    {
      action: "delete",
      entity: "system",
      entityId: "audit_retention",
      entityName: "审计日志清理",
      detail: { note: `手动清理过期审计：保留期 ${retention} 天，删除 ${purged} 条`, purged },
    },
    request
  );
  return ok({ purged, retentionDays: retention, message: purged > 0 ? `已清理 ${purged} 条过期审计记录` : "无过期审计记录（保留期内全部保留）" });
}
