// GET /api/console/auth/session —— 会话状态（前端路由守卫：未初始化 → 引导页；已登录 → 控制台）。
// authVia：当前生效认证通道（cookie / bearer），控制台顶栏徽标展示用。
// defaultPasswordActive（v4.9.13-local）：管理员口令仍为公开默认值 gateway-admin-2026 ——
// 控制台顶部常驻安全横幅引导改密（scrypt 校验与登录路径同源，仅对已登录会话计算）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveSession, detectAuthVia, isPublicDefaultPassword } from "@/lib/gateway/session/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const adminCount = await db.adminUser.count();
  const session = await resolveSession(request);
  let username: string | null = null;
  let authVia: "cookie" | "bearer" | null = null;
  let defaultPasswordActive = false;
  if (session) {
    const user = await db.adminUser.findUnique({ where: { id: session.userId } });
    username = user?.username || "admin";
    authVia = await detectAuthVia(request);
    if (user) defaultPasswordActive = await isPublicDefaultPassword(user.passwordHash);
  }
  return Response.json({
    ok: true,
    data: {
      initialized: adminCount > 0,
      authenticated: !!session,
      username,
      authVia,
      defaultPasswordActive,
    },
  });
}
