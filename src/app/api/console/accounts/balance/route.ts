// GET /api/console/accounts/balance —— 按提供商聚合余额（账号管理页余额徽标数据源）。
// v3.1.0：清偿 Task 16 遗留 #1 —— /v1/usage 只聚合 usage_provider_id（历史上仅 workbuddy），
// INTL 等其它 workbuddy 家族提供商的余额长期不可见。本端点对每个有账号的 workbuddy 家族
// 提供商并行调 fleet.getBalance(providerId)（内部 60s/10s 短缓存 + 账号级快照落库），
// 控制台即可展示每提供商余额徽标并手动/自动刷新。
// 非 workbuddy 家族（openai/anthropic）无余额概念 → 不查询，前端显示「—」。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { getConfig } from "@/lib/gateway/config/configService";
import { getProviderFleet, invalidateBalanceCache } from "@/lib/gateway/core/fleet";

export const dynamic = "force-dynamic";

export interface ProviderBalance {
  providerId: string;
  name: string;
  type: string;
  success: boolean;
  balance: number;
  total: number;
  unit: string;
  accountsCount: number;
  accounts: Array<{ id: string; name?: string; balance: number; total: number; success: boolean }>;
  error?: string;
}

async function queryBalance(
  fleet: ReturnType<typeof getProviderFleet>,
  p: { id: string; name: string; type: string },
  accountsCount: number
): Promise<ProviderBalance> {
  try {
    const bal = await fleet.getBalance(p.id);
    const details = Array.isArray(bal.accounts) ? bal.accounts : [];
    return {
      providerId: p.id,
      name: p.name,
      type: p.type,
      success: !!bal.success,
      balance: typeof bal.balance === "number" ? bal.balance : 0,
      total: typeof bal.total === "number" ? bal.total : 0,
      unit: bal.unit || "积分",
      accountsCount,
      accounts: details.map((d) => ({
        id: String(d.id ?? ""),
        name: typeof d.name === "string" ? d.name : undefined,
        balance: typeof d.balance === "number" ? d.balance : 0,
        total: typeof d.total === "number" ? d.total : 0,
        success: !!d.success,
      })),
      ...(bal.error ? { error: String(bal.error).slice(0, 200) } : {}),
    };
  } catch (e) {
    return {
      providerId: p.id,
      name: p.name,
      type: p.type,
      success: false,
      balance: 0,
      total: 0,
      unit: "积分",
      accountsCount,
      accounts: [],
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    };
  }
}

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const config = await getConfig();
  const fleet = getProviderFleet(config);

  const providers = await db.provider.findMany({ orderBy: { sortOrder: "asc" } });
  const accountCounts = await db.account.groupBy({ by: ["providerId"], _count: { _all: true } });
  const countMap = new Map(accountCounts.map((r) => [r.providerId, r._count._all]));

  // 只查有账号的 workbuddy 家族提供商（余额概念）
  const targets = providers.filter((p) => p.type === "workbuddy" && (countMap.get(p.id) || 0) > 0);

  // 单提供商模式：?providerId=xxx[&refresh=1] —— 分组徽标独立刷新（穿透 fleet 60s 缓存）
  const providerId = request.nextUrl.searchParams.get("providerId");
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  if (providerId) {
    const p = targets.find((t) => t.id === providerId);
    if (!p) return ok({ providers: [], fetchedAt: new Date().toISOString() });
    if (forceRefresh) invalidateBalanceCache();
    const result = await queryBalance(fleet, p, countMap.get(p.id) || 0);
    return ok({ providers: [result], fetchedAt: new Date().toISOString() });
  }

  // v3.2.3：全量模式 ?refresh=1 —— 账号页「立即刷新全部余额」批量按钮穿透 fleet 60s 缓存
  if (forceRefresh) invalidateBalanceCache();
  const results = await Promise.all(targets.map((p) => queryBalance(fleet, p, countMap.get(p.id) || 0)));

  return ok({ providers: results, fetchedAt: new Date().toISOString() });
}
