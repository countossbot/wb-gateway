// GET /api/console/logs/export —— 运行日志 CSV 导出（v3.0.8，审计场景）。
// 与 /api/console/logs 共享七维筛选语义（模型/提供商/账号/密钥/状态码/用量来源/时间范围），
// 导出全部匹配行（上限 5000，与滚动窗口同量级），响应 text/csv 附件（BOM + RFC 4180 转义）。
// 响应头 X-Export-Rows / X-Export-Truncated 供前端提示导出行数与截断状态。
import { NextRequest } from "next/server";
import { requirePermission } from "@/lib/gateway/console/consoleHelpers";
import { exportRequestLogsCsv } from "@/lib/gateway/config/requestLog";

export const dynamic = "force-dynamic";

function parseUsage(v: string | null): "exact" | "estimated" | "none" | undefined {
  return v === "exact" || v === "estimated" || v === "none" ? v : undefined;
}

function parseStatus(v: string | null): string | undefined {
  if (!v) return undefined;
  if (v === "2xx" || v === "4xx" || v === "5xx") return v;
  if (/^\d{3}$/.test(v)) return v;
  return undefined;
}

function parseTs(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "log.read");
  if (session instanceof Response) return session;
  const params = request.nextUrl.searchParams;
  const { csv, rows, truncated } = await exportRequestLogsCsv({
    model: params.get("model") || undefined,
    provider: params.get("provider") || undefined,
    usage: parseUsage(params.get("usage")),
    status: parseStatus(params.get("status")),
    apiKeyName: params.get("key") || undefined,
    from: parseTs(params.get("from")),
    to: parseTs(params.get("to")),
    accountId: params.get("account") || undefined,
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="uag-logs-${stamp}.csv"`,
      "X-Export-Rows": String(rows),
      "X-Export-Truncated": truncated ? "1" : "0",
    },
  });
}
