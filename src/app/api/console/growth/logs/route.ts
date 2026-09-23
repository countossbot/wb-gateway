// GET /api/console/growth/logs —— 成长中心执行日志（增量拉取）
//
// 查询参数：
//   sinceId  只返回 id > sinceId 的行（增量；首次传 0）
//   limit    单次上限，默认 200，最大 1000
//   accountId 可选，按账号过滤
//
// 日志表 append-only（永不 UPDATE），保留期由 growthLogRetentionDays 控制。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { getRuntimeSettingsAsync } from "@/lib/gateway/config/runtimeSettings";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const sp = request.nextUrl.searchParams;
  const sinceId = Math.max(0, Math.floor(Number(sp.get("sinceId")) || 0));
  const accountId = sp.get("accountId") || "";
  const rawLimit = Math.floor(Number(sp.get("limit")) || 200);
  const limit = Math.min(1000, Math.max(1, rawLimit));

  const settings = await getRuntimeSettingsAsync();

  const rows = await db.growthLog.findMany({
    where: {
      id: { gt: sinceId },
      ...(accountId ? { accountId } : {}),
    },
    orderBy: { id: "asc" },
    take: limit,
  });

  return ok({
    logs: rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      accountName: r.accountName,
      runId: r.runId,
      taskCode: r.taskCode,
      label: r.label,
      level: r.level,
      message: r.message,
      createdAt: r.createdAt,
    })),
    retentionDays: settings.growthLogRetentionDays,
    // 是否还有更多（前端据此决定是否继续拉）
    hasMore: rows.length === limit,
  });
}
