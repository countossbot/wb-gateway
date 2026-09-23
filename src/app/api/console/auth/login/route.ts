// POST /api/console/auth/login —— 管理员登录（失败计数 + 临时锁定 + 审计）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  verifyPassword,
  createSession,
  sessionCookie,
  isLoginLocked,
  recordLoginFailure,
  clearLoginFailures,
  auditLogin,
  clientIp,
} from "@/lib/gateway/session/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent") || "";

  // 失败次数限制与临时锁定
  const lock = isLoginLocked(ip);
  if (lock.locked) {
    await auditLogin(ip, ua, false, `locked (${lock.retryAfterSec}s remaining)`);
    return Response.json(
      { ok: false, error: `失败次数过多，已临时锁定，请 ${Math.ceil((lock.retryAfterSec || 0) / 60)} 分钟后再试` },
      { status: 429 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) {
    return Response.json({ ok: false, error: "用户名与密码不能为空" }, { status: 400 });
  }

  const user = await db.adminUser.findUnique({ where: { username } });
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !valid) {
    recordLoginFailure(ip);
    await auditLogin(ip, ua, false, user ? "wrong password" : "unknown username");
    return Response.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
  }

  clearLoginFailures(ip);
  await auditLogin(ip, ua, true, "login success");
  const { token, expiresAt } = await createSession(user.id, user.username);
  return Response.json(
    {
      ok: true,
      data: {
        username: user.username,
        expiresAt: expiresAt.toISOString(),
        // 会话令牌：仅供刚通过密码验证的客户端本人持有（前端 localStorage 存放、
        // 请求以 Authorization: Bearer 附带）。与 Cookie 指向同一条服务端会话记录，
        // 登出/改密/过期即同时失效。用于跨站 iframe 中 Cookie 被浏览器丢弃时的兜底通道。
        sessionToken: token,
      },
    },
    { headers: { "Set-Cookie": sessionCookie(token, expiresAt) } }
  );
}
