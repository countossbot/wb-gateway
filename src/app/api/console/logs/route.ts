// GET /api/console/logs —— 运行日志（时间/模型/命中提供商与账号/耗时/状态码/Token 用量/错误）。
// v3.0.4：支持 ?provider=（命中提供商精确筛选）与 ?usage=exact|estimated|none（用量来源筛选）；
// v3.0.5：支持 ?status=（2xx/4xx/5xx 大类或具体三位状态码）、?key=（调用方密钥名精确筛选）、
//         ?from=&to=（毫秒时间戳范围，趋势图点击柱跳转该小时）；
// v3.0.6：支持 ?account=（命中账号精确筛选，与 provider 组合防跨提供商同名串扰）；
// 响应附带 providers / keys / accounts / models（日志中出现过的提供商、密钥主体、账号组合与对外模型去重清单，供筛选下拉/自动补全）。
// v4.9.13-local-r2：附带 statusBreakdown（当前筛选除状态维度外的按状态码分组计数，状态速览条数据源）。
// v4.9.13-local-r3：附带 errorPatterns（同构筛选除状态外的错误模式归一化聚合 Top 6，错误模式速览条数据源）。
// v4.9.13-local-r6：支持 ?ep_hours=24|168 —— 错误模式速览条时间窗口（覆盖 from/to 时间维度，其余筛选保留）。
//         与总览「近期错误模式」卡的 24h/7d 窗口口径对齐：切窗口看全局错误构成，不被列表时间筛选缩窄。
// v4.9.13-local-r9：支持 ?error=（错误文本关键字 contains 筛选，错误模式下钻通道的检索维度）与
//         ?error_only=1（仅看有错误文本的行，排障一键聚焦）；两维与列表/速览/导出同源同口径。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { distinctLogAccounts, distinctLogKeys, distinctLogModels, distinctLogProviders, listRequestLogs, requestLogErrorPatterns, requestLogStatusBreakdown } from "@/lib/gateway/config/requestLog";
import { loadPricingMap, estimateRowCost } from "@/lib/console/pricing";

export const dynamic = "force-dynamic";

function parseUsage(v: string | null): "exact" | "estimated" | "none" | undefined {
  return v === "exact" || v === "estimated" || v === "none" ? v : undefined;
}

/** 状态码筛选白名单：大类 2xx/4xx/5xx 或具体三位数字 */
function parseStatus(v: string | null): string | undefined {
  if (!v) return undefined;
  if (v === "2xx" || v === "4xx" || v === "5xx") return v;
  if (/^\d{3}$/.test(v)) return v;
  return undefined;
}

/** 毫秒时间戳解析（非法/非正数返回 undefined） */
function parseTs(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** v4.9.13-local-r6：错误模式窗口白名单（24h/7d，与总览错误模式卡同档；非法值回落“全部”即跟随列表时间筛选） */
function parseEpHours(v: string | null): 24 | 168 | undefined {
  return v === "24" ? 24 : v === "168" ? 168 : undefined;
}

/** v4.9.13-local-r9：错误关键字（去空白、截断 200 字符防超长 LIKE 拖慢查询） */
function parseErrorKeyword(v: string | null): string | undefined {
  const s = (v || "").trim();
  return s.length > 0 ? s.slice(0, 200) : undefined;
}

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const params = request.nextUrl.searchParams;
  // v4.9.13-local-r6：错误模式速览窗口（独立于列表时间筛选；白名单 24/168）
  const epHours = parseEpHours(params.get("ep_hours"));
  const logQuery = {
    limit: Number(params.get("limit")) || 50,
    offset: Number(params.get("offset")) || 0,
    model: params.get("model") || undefined,
    provider: params.get("provider") || undefined,
    usage: parseUsage(params.get("usage")),
    status: parseStatus(params.get("status")),
    apiKeyName: params.get("key") || undefined,
    from: parseTs(params.get("from")),
    to: parseTs(params.get("to")),
    accountId: params.get("account") || undefined,
    errorKeyword: parseErrorKeyword(params.get("error")),
    hasError: params.get("error_only") === "1",
  };
  const [result, providers, keys, accounts, models, statusBreakdown, errorPatterns] = await Promise.all([
    listRequestLogs(logQuery),
    distinctLogProviders(),
    distinctLogKeys(),
    distinctLogAccounts(),
    distinctLogModels(),
    // 状态速览条：与列表同构筛选但忽略 status 维度（全集分布，不受当前状态筛选影响）
    requestLogStatusBreakdown(logQuery),
    // v4.9.13-local-r3：错误模式速览条（除状态维度外的全集错误归一化聚合；异常静默降级为空数组，不阻断主列表）
    // v4.9.13-local-r6：ep_hours 窗口时覆盖时间维度（from=now-hours，忽略列表 from/to；模型/密钥/账号等其余维度仍同构保留）
    requestLogErrorPatterns(
      epHours ? { ...logQuery, from: Date.now() - epHours * 3_600_000, to: undefined } : logQuery
    ).catch(() => []),
  ]);
  // v4.4.0：行级成本估算（ModelPricing × 每行 tokens；模型未配置单价 → null）。
  // 单价表一次加载后内存计算，页大小 ≤500 行零压力；估算口径与透视/总览完全同源。
  const pricing = await loadPricingMap();
  const items = result.items.map((r) => ({
    ...r,
    cost: estimateRowCost(pricing, r.model, r.inputTokens ?? 0, r.outputTokens ?? 0, r.cachedTokens ?? 0),
  }));
  // v4.9.13-local-r6：回带 errorPatternsHours —— 前端据此渲染窗口口径标签（“全部”时缺省 undefined）
  return ok({ ...result, items, providers, keys, accounts, models, statusBreakdown, errorPatterns, errorPatternsHours: epHours });
}
