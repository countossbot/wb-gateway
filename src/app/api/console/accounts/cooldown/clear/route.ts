// POST /api/console/accounts/cooldown/clear —— 管理员一键清除指定账号冷却（v3.4.0）。
// 语义：强制清除（无条件清 DB + 进程内冷却缓存），对健康账号幂等无害（返回 cleared=false）。
// 非破坏性：只清冷却标记，不触碰账号本身；冷却被误清也会在下次 429 时自动重建（指数退避）。
// 审计：清除动作写 auditUpdate 留痕（含清除前的 streak / reason 摘要，排障可追溯）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { adminClearCooldown } from "@/lib/gateway/providers/workbuddy/cooldown";
import { auditUpdate } from "@/lib/gateway/console/auditService";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    providerId?: string;
    accountId?: string;
  };
  if (!body.providerId || !body.accountId) return fail("缺少 providerId 或 accountId");

  const acc = await db.account.findUnique({
    where: { providerId_id: { providerId: body.providerId, id: body.accountId } },
  });
  if (!acc) return fail("账号不存在", 404);

  const prev = {
    cooldownUntil: acc.cooldownUntil,
    cooldownStreak: acc.cooldownStreak,
    cooldownReason: acc.cooldownReason,
  };
  const cleared = await adminClearCooldown(body.providerId, body.accountId);

  if (cleared) {
    await auditUpdate(
      "account",
      `${body.providerId}/${body.accountId}`,
      acc.name || body.accountId,
      {
        action: "cooldown-clear",
        clearedCooldown: true,
        previous: {
          cooldownUntil: prev.cooldownUntil,
          cooldownStreak: prev.cooldownStreak,
          cooldownReason: prev.cooldownReason ? prev.cooldownReason.slice(0, 160) : null,
        },
      },
      request
    );
  }

  return ok({
    cleared,
    accountId: body.accountId,
    providerId: body.providerId,
    message: cleared
      ? `已清除账号「${acc.name || body.accountId}」的冷却状态`
      : "该账号当前不在冷却中，无需清除",
  });
}
