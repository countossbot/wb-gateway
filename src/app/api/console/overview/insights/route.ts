// GET /api/console/overview/insights —— 总览洞察独立 API（v4.2.4）。
// 动机：Task 42b 遗留「切窗口会整页 overview 重载」——模型健康/Top 提供商两卡的窗口
// 切换此前依赖主 overview 请求携带 mh_days 触发全量重载（余额/账号/趋势等全部重拉）。
// 现拆为独立端点：切窗口只重拉洞察数据（2 个 UsageDaily 轻量查询），页面其余数据不动。
// 响应结构与主 overview 响应中的 model_health / top_providers_7d 字段同形（种子数据可无缝切换）。
// 查询参数：mh_days=7|14|30（模型健康窗口，默认 7）、tp_days=7|14|30（Top 提供商窗口，默认 7；
// 非 7/14/30 的值一律回落 7，与前端按钮组一致）。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import {
  computeModelHealthData,
  computeTopProviders,
  normalizeWindowDays,
} from "@/lib/console/overviewInsights";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const mhDays = normalizeWindowDays(request.nextUrl.searchParams.get("mh_days"));
  const tpDays = normalizeWindowDays(request.nextUrl.searchParams.get("tp_days"));

  // 两窗口独立计算并行执行（各为一次 UsageDaily findMany 轻量查询）
  const [modelHealth, topProviders] = await Promise.all([
    computeModelHealthData(mhDays),
    computeTopProviders(tpDays),
  ]);

  return ok({
    model_health: modelHealth,
    // 字段名保持 top_providers_7d 形态的前端兼容（windowDays 由独立字段回显实际窗口）
    top_providers_7d: topProviders,
    top_providers_window_days: tpDays,
  });
}
