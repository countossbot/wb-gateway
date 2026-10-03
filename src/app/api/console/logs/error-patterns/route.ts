// GET /api/console/logs/error-patterns —— 错误模式轻量端点（v4.9.13-local-r8，密钥/账号失败徽标 tooltip 数据源）。
// 与 /api/console/logs 的 errorPatterns 字段同源（requestLogErrorPatterns 单一实现），但：
// - 只返回错误模式（不拉日志列表/状态速览），悬停触发的高频短交互下代价最小；
// - hours 白名单窗口（默认 24，与失败徽标的 24h 口径对齐；支持 168）；
// - 按密钥/账号/提供商维度过滤 —— 「悬停即知失败的是什么错」，免去跳转日志页。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { requestLogErrorPatterns } from "@/lib/gateway/config/requestLog";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const p = request.nextUrl.searchParams;
  const hours = p.get("hours") === "168" ? 168 : 24;
  try {
    const patterns = await requestLogErrorPatterns({
      apiKeyName: p.get("key") || undefined,
      provider: p.get("provider") || undefined,
      accountId: p.get("account") || undefined,
      // 窗口语义与总览错误卡 ep_hours 一致：覆盖时间维度（from=now-hours）
      from: Date.now() - hours * 3600 * 1000,
    });
    return ok({ patterns, hours });
  } catch {
    // 聚合失败静默降级为空集：tooltip 属增强展示，不制造红色报错噪音
    return ok({ patterns: [], hours });
  }
}
