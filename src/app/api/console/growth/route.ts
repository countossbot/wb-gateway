// GET /api/console/growth —— 成长中心：可执行账号列表 + 各组任务清单 + 账号状态
//
// 只暴露 CN 的 workbuddy 账号（providerId='workbuddy'），国际站（workbuddy-intl）不参与：
// 参考实现的全部端点为 workbuddy.cn / codebuddy.cn，零 workbuddy.ai 引用。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { GROWTH_GROUPS, GROWTH_TASKS } from "@/lib/gateway/growth/tasks";
import { currentRun } from "@/lib/gateway/growth/state";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const providerId = "workbuddy"; // 仅 CN；intl 不参与成长任务

  const [provider, accounts, states] = await Promise.all([
    db.provider.findUnique({ where: { id: providerId }, select: { id: true, name: true, enabled: true } }),
    db.account.findMany({
      where: { providerId, enabled: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.growthAccountState.findMany({ where: { providerId } }),
  ]);

  const stateMap = new Map(states.map((s) => [s.accountId, s]));

  return ok({
    provider: provider ? { id: provider.id, name: provider.name, enabled: provider.enabled } : null,
    groups: GROWTH_GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      total: GROWTH_TASKS.filter((t) => t.group === g.id && !t.excluded).length,
    })),
    // 任务清单（含被剔除项，供 UI 置灰/说明）
    tasks: GROWTH_TASKS.map((t) => ({
      code: t.code,
      label: t.label,
      group: t.group,
      mechanism: t.mechanism,
      excluded: !!t.excluded,
      excludedReason: t.excludedReason || "",
    })),
    accounts: accounts.map((a) => {
      const st = stateMap.get(a.id);
      return {
        id: a.id,
        name: a.name,
        status: st?.status || "idle",
        completedCount: st?.completedCount ?? 0,
        totalCount: st?.totalCount ?? 0,
        groups: st?.groups ? st.groups.split(",").filter(Boolean) : [],
        lastRunAt: st?.lastRunAt ?? null,
        lastError: st?.lastError || "",
      };
    }),
    running: currentRun(),
  });
}
