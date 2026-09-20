// GET /api/console/usage-audit —— v3.9.3：token 用量来源核对（只读，供人工比对上游账单）。
// 参数：?from=<ms>&to=<ms>（毫秒时间戳，含头不含尾）；缺省最近 24h。
// 响应：三种来源（upstreamUsageFrame/estimated/unknown）各自请求数、input/output/cached 合计、
//       cachedTokens 占 inputTokens 比值。纯只读聚合，不引入任何写入。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { summarizeUsageBySource } from "@/lib/gateway/config/requestLog";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  try {
    const now = Date.now();
    const from = Number(request.nextUrl.searchParams.get("from") ?? "") || now - 24 * 3600_000;
    const to = Number(request.nextUrl.searchParams.get("to") ?? "") || now;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return ok({ error: "invalid range: expect ?from=<ms>&to=<ms> with from < to" });
    }
    // 范围钳制：最长 31 天，防全表超大聚合
    const clampedFrom = Math.max(from, to - 31 * 24 * 3600_000);
    const summary = await summarizeUsageBySource(clampedFrom, to);
    return ok(summary);
  } catch (e) {
    return ok({ error: (e as Error).message });
  }
}
