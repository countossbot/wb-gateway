// /api/console/routes/test-results —— 路由快测结果持久化（v4.9.13-local-r16）。
// POST：批量写入批测/单测结果（body { results: [{ model, record }] }），一次读改写避免 N 次往返；
// GET：返回全量 store（当前管理页按需回读 lastTest；此端点供调试/未来历史抽屉使用）。
// 写入失败静默降级（persisted=0），不阻断前端测试主流程。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import {
  readRouteTestStore,
  persistRouteTestResults,
} from "@/lib/gateway/console/routeTestStore";
import type { RouteTestRecord } from "@/lib/console/types";

export const dynamic = "force-dynamic";

/** 逐字段校验防非法状态入库（防注入畸形记录） */
function sanitizeRecord(raw: unknown): RouteTestRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RouteTestRecord>;
  if (typeof r.ok !== "boolean") return null;
  if (typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs) || r.durationMs < 0) return null;
  const protocol = r.protocol === "anthropic" ? "anthropic" : r.protocol === "openai" ? "openai" : null;
  if (!protocol) return null;
  const testedAt =
    typeof r.testedAt === "string" && !Number.isNaN(Date.parse(r.testedAt))
      ? r.testedAt
      : new Date().toISOString();
  return {
    ok: r.ok,
    status: typeof r.status === "number" && Number.isFinite(r.status) ? Math.round(r.status) : null,
    durationMs: Math.round(r.durationMs),
    upstreamModel: typeof r.upstreamModel === "string" ? r.upstreamModel.slice(0, 200) : null,
    error: typeof r.error === "string" ? r.error.slice(0, 300) : undefined,
    protocol,
    testedAt,
  };
}

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const store = await readRouteTestStore();
  return ok({ store });
}

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    results?: Array<{ model?: string; record?: unknown }>;
  };
  if (!Array.isArray(body.results) || body.results.length === 0) {
    return fail("缺少 results 数组");
  }
  if (body.results.length > 50) return fail("单次最多写入 50 条");
  const cleaned: Array<{ model: string; record: RouteTestRecord }> = [];
  for (const item of body.results) {
    if (!item?.model || typeof item.model !== "string") continue;
    const record = sanitizeRecord(item.record);
    if (record) cleaned.push({ model: item.model.slice(0, 128), record });
  }
  const persisted = await persistRouteTestResults(cleaned);
  return ok({ persisted, received: body.results.length });
}
