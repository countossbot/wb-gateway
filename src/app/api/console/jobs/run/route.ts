// POST /api/console/jobs/run —— 手动立即执行定时任务（签到 / Token 保活）。
// v4.1.1：签到可显式传 providers（当前 UI 下拉选择，空数组 = 全部）——无需先保存配置即按所选范围执行；
//   未传 providers 时回落为已保存的运行时设置（向后兼容）。逐项校验与 PUT /api/console/jobs 白名单同规则。
import { NextRequest } from "next/server";
import { requirePermission, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { runJob, checkinCapableProviderTypes } from "@/lib/gateway/jobs/scheduler";
import { invalidateBalanceCache } from "@/lib/gateway/core/fleet";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await requirePermission(request, "settings.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as { job?: string; providers?: unknown };
  const job = body.job;
  if (job !== "checkin" && job !== "keepalive") {
    return fail("job 必须为 checkin 或 keepalive");
  }

  // v4.1.1：手动签到的提供商白名单覆盖（UI 当前选择直传）
  let onlyOverride: string[] | undefined;
  if (job === "checkin" && body.providers !== undefined) {
    if (!Array.isArray(body.providers) || body.providers.some((x) => typeof x !== "string" || !x)) {
      return fail("providers 必须为字符串数组（空数组 = 全部支持签到的提供商）");
    }
    const ids = body.providers as string[];
    for (const id of ids) {
      const p = await db.provider.findUnique({ where: { id } });
      if (!p) return fail(`签到提供商白名单中的 "${id}" 不存在`);
      if (!checkinCapableProviderTypes().includes(p.type)) {
        return fail(`提供商 "${id}"（类型 ${p.type}）不支持签到，无法加入白名单`);
      }
    }
    onlyOverride = ids;
  }

  const detail = await runJob(job, "manual", onlyOverride);
  if (job === "checkin") invalidateBalanceCache();
  return ok({ job, detail });
}
