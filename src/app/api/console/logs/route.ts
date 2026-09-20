// GET /api/console/logs —— 运行日志（时间/模型/命中提供商与账号/耗时/状态码/Token 用量/错误）。
// v3.0.4：支持 ?provider=（命中提供商精确筛选）与 ?usage=exact|estimated|none（用量来源筛选）；
// v3.0.5：支持 ?status=（2xx/4xx/5xx 大类或具体三位状态码）、?key=（调用方密钥名精确筛选）、
//         ?from=&to=（毫秒时间戳范围，趋势图点击柱跳转该小时）；
// v3.0.6：支持 ?account=（命中账号精确筛选，与 provider 组合防跨提供商同名串扰）；
// 响应附带 providers / keys / accounts / models（日志中出现过的提供商、密钥主体、账号组合与对外模型去重清单，供筛选下拉/自动补全）。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { distinctLogAccounts, distinctLogKeys, distinctLogModels, distinctLogProviders, listRequestLogs } from "@/lib/gateway/config/requestLog";

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

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const params = request.nextUrl.searchParams;
  const [result, providers, keys, accounts, models] = await Promise.all([
    listRequestLogs({
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
    }),
    distinctLogProviders(),
    distinctLogKeys(),
    distinctLogAccounts(),
    distinctLogModels(),
  ]);
  return ok({ ...result, providers, keys, accounts, models });
}
