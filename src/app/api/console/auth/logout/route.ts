// POST /api/console/auth/logout —— 登出（销毁会话 + 清 Cookie）。
import { NextRequest } from "next/server";
import { destroySession, clearSessionCookie } from "@/lib/gateway/session/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  await destroySession(request);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
