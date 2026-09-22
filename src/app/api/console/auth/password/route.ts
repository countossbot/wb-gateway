// POST /api/console/auth/password —— 修改管理员密码（失效全部既有会话 + 重新登录）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword, destroyAllSessions } from "@/lib/gateway/session/session";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response || session === null) {
    return session ?? fail("未登录或会话已过期", 401);
  }
  // v4.9.0：多成员模式下任何人只能修改自己的密码（改他人密码走成员管理接口）

  const body = (await request.json().catch(() => ({}))) as { oldPassword?: string; newPassword?: string };
  const oldPassword = body.oldPassword || "";
  const newPassword = body.newPassword || "";
  if (newPassword.length < 8) {
    return fail("新密码至少 8 位");
  }
  const user = await db.adminUser.findUnique({ where: { id: session.userId } });
  if (!user) return fail("管理员账号不存在", 404);
  if (!(await verifyPassword(oldPassword, user.passwordHash))) {
    return fail("当前密码错误", 401);
  }
  await db.adminUser.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  // 修改密码后失效全部既有会话
  await destroyAllSessions();
  return ok({ message: "密码已修改，全部会话已失效，请重新登录" });
}
