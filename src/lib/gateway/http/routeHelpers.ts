// 网关路由共享工具 —— 鉴权桥（Master Key / 会话 Cookie）、错误响应、JSON 头。
import { getConfig } from "@/lib/gateway/config/configService";
import { authenticateAccess, authenticateAdmin, type AuthResult } from "@/lib/gateway/auth/auth";
import { resolveSession, type SessionPrincipal } from "@/lib/gateway/session/session";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export function jsonResponse(data: unknown, status = 200, request: Request | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeadersFor(request) },
  });
}

// 网关端点鉴权（原语义：Bearer / x-api-key）
export async function requireGatewayAuth(
  request: Request,
  options: { model?: string | null; requireMaster?: boolean; allowCron?: boolean } = {}
): Promise<{ ok: true; config: import("@/lib/gateway/core/types").GatewayConfig; auth: AuthResult } | { ok: false; response: Response }> {
  const config = await getConfig();
  const auth = authenticateAccess(request, config, options);
  if (!auth.ok) {
    return { ok: false, response: auth.response as Response };
  }
  return { ok: true, config, auth };
}

// 管理端鉴权：Bearer Master Key（原自动化脚本兼容）或控制台会话 Cookie
export async function requireAdminAuth(
  request: Request
): Promise<{ ok: true; config: import("@/lib/gateway/core/types").GatewayConfig; principal: import("@/lib/gateway/auth/auth").AuthPrincipal } | { ok: false; response: Response }> {
  const sessionPrincipal: SessionPrincipal | null = await resolveSession(request);
  const config = await getConfig();
  const auth = authenticateAdmin(request, config, sessionPrincipal);
  if (!auth.ok || !auth.principal?.isMaster) {
    return {
      ok: false,
      response: jsonResponse(
        { error: { message: "Master Key Required for Admin Operations" } },
        401,
        request
      ),
    };
  }
  return { ok: true, config, principal: auth.principal };
}
