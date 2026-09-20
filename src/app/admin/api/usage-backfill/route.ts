// POST /admin/api/usage-backfill —— 手动触发 UsageDaily 历史回填（幂等）。
// v3.0.7：从 RequestLog 滚动窗口（≤5000 条）聚合补齐 UsageDaily 无行的历史天；
// 已有行的天整体跳过（防双计）；今日行由实时链路负责不回填。
// 鉴权与 /admin/api/* 一致：Master Key 或管理员会话。
import { NextRequest } from "next/server";
import { requireAdminAuth, jsonResponse } from "@/lib/gateway/http/routeHelpers";
import { backfillUsageDaily } from "@/lib/gateway/config/requestLog";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  try {
    const result = await backfillUsageDaily();
    return jsonResponse(
      {
        ok: true,
        backfilled_days: result.days,
        backfilled_rows: result.rows,
        // 已有聚合行的历史天（跳过以防双计；如需重建须先手动清空该天行）
        skipped_days: result.skippedDays,
        note:
          result.rows > 0
            ? `已从滚动日志回填 ${result.rows} 行 / ${result.days} 天`
            : "无可回填数据（历史天均已有聚合行或滚动窗口内无历史日志）",
      },
      200,
      request
    );
  } catch (e) {
    return jsonResponse(
      { ok: false, error: (e as Error).message },
      500,
      request
    );
  }
}
