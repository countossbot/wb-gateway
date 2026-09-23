// GET /api/console/auth/session —— 会话状态（前端路由守卫：未初始化 → 引导页；已登录 → 控制台）。
// authVia：当前生效认证通道（cookie / bearer），控制台顶栏徽标展示用。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolveSession, detectAuthVia } from "@/lib/gateway/session/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const adminCount = await db.adminUser.count();
  const session = await resolveSession(request);
  let username: string | null = null;
  let authVia: "cookie" | "bearer" | null = null;
  if (session) {
    const user = await db.adminUser.findUnique({ where: { id: session.userId } });
    username = user?.username || "admin";
    authVia = await detectAuthVia(request);
  }
  return Response.json({
    ok: true,
    data: {
      initialized: adminCount > 0,
      authenticated: !!session,
      username,
      authVia,
    },
  });
}
