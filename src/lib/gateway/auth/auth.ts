// 鉴权中心 —— 客户端 API Key / Master Key / Cron Secret / 虚拟密钥。
// 等价保留原项目 authenticateAccess 全部语义（含常量时间比较），
// 并叠加控制台会话 Cookie 鉴权（新能力，供 Web 控制台调用管理接口）。

import { timingSafeEqual } from "./timing";
import { corsHeadersFor } from "../http/headers";
import type { GatewayConfig, VirtualKeyEntry } from "../core/types";

export interface AuthPrincipal {
  isMaster: boolean;
  role: string;
  name: string;
  // 控制台会话主体（新）：session 标识允许后续按会话做权限关联
  sessionId?: string;
  // v3.9.3：虚拟密钥主体时指向其配置（模型白名单复检用；master/cron 主体为空）
  virtualKey?: VirtualKeyEntry | null;
}

export interface AuthOptions {
  model?: string | null;
  requireMaster?: boolean;
  allowCron?: boolean;
}

export interface AuthResult {
  ok: boolean;
  principal?: AuthPrincipal;
  response?: Response;
}

function unauthorized(message: string, status = 401, request: Request): AuthResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }),
  };
}

// 从请求提取 token：Authorization: Bearer xxx / Authorization: xxx / x-api-key
export function extractToken(request: Request): string {
  const authHeader = request.headers.get("authorization") || "";
  const xApiKey = request.headers.get("x-api-key") || "";

  if (authHeader.startsWith("Bearer ")) return authHeader.substring(7).trim();
  if (authHeader) return authHeader.trim();
  if (xApiKey) return xApiKey.trim();
  return "";
}

export function authenticateAccess(
  request: Request,
  config: GatewayConfig,
  options: AuthOptions = {}
): AuthResult {
  const { model = null, requireMaster = false, allowCron = false } = options;
  const token = extractToken(request);

  if (!token) {
    return unauthorized("Missing API Key", 401, request);
  }

  // 1. 验证 Master Key（常数时间比较，抗时序侧信道）
  if (config.master_key && timingSafeEqual(token, config.master_key)) {
    return {
      ok: true,
      principal: { isMaster: true, role: "admin", name: "Master Admin" },
    };
  }

  // 1.1 验证 Cron Secret (仅在 allowCron=true 时启用)
  // 顺序必须在 requireMaster 之前：/checkin 用 {requireMaster:true, allowCron:true}
  // 同时接受 master 与 cron（cron 降权 isMaster:false）；其他 admin 接口 allowCron=false，
  // cron 落到下面的 requireMaster 被拒
  if (
    config.cron_secret &&
    timingSafeEqual(token, config.cron_secret) &&
    allowCron
  ) {
    return {
      ok: true,
      principal: { isMaster: false, role: "cron", name: "Cron Trigger" },
    };
  }

  // 1.2 当 requireMaster 时：仅 Master Key 可访问（cron 已在上一步按 allowCron 处理）
  if (requireMaster) {
    return unauthorized("Master Key Required", 401, request);
  }

  // 2. 验证虚拟客户端密钥
  const virtualKeys = config.virtual_keys || {};
  const keyObj: VirtualKeyEntry | undefined = virtualKeys[token];
  if (keyObj) {
    if (!keyObj.enabled) {
      return unauthorized("API Key has been disabled", 403, request);
    }

    if (model && Array.isArray(keyObj.models) && !keyObj.models.includes("*")) {
      if (!keyObj.models.includes(model)) {
        return unauthorized(
          `Model "${model}" is not permitted for this API Key`,
          403,
          request
        );
      }
    }

    return {
      ok: true,
      principal: {
        isMaster: false,
        role: keyObj.role || "client",
        name: keyObj.name || "Client",
        virtualKey: keyObj, // v3.9.3：白名单复检用
      },
    };
  }

  return unauthorized("Invalid API Key", 401, request);
}

/**
 * v3.9.3：密钥级模型白名单复检（入口防护分流后补做）。
 *
 * 背景：入口需在读取 body 之前完成鉴权（防大 body 无鉴权占用内存），但 model 在 body 内；
 * 本函数在 body 读取后补一次模型级校验。拒绝响应与 authenticateAccess 内联白名单校验
 * 逐字节一致（同一 unauthorized 出口、同一消息、同一状态码），仅改变执行顺序不改语义。
 * 仅对虚拟密钥主体生效（master / cron 主体无白名单约束，与原内联逻辑一致）；
 * 第一阶段已拦截的失败主体不会到达这里（调用方保证 auth.ok）。
 */
export function authorizeModelForPrincipal(
  request: Request,
  auth: AuthResult,
  model: string
): AuthResult {
  if (!auth.ok || !auth.principal) return auth;
  const keyObj = auth.principal.virtualKey;
  if (!keyObj) return auth; // master / cron 主体：无白名单语义
  if (model && Array.isArray(keyObj.models) && !keyObj.models.includes("*")) {
    if (!keyObj.models.includes(model)) {
      return unauthorized(`Model "${model}" is not permitted for this API Key`, 403, request);
    }
  }
  return auth;
}

// 管理端鉴权（/admin/api/*）：接受 Bearer Master Key（原自动化脚本兼容），
// 或控制台会话 Cookie（新 Web 控制台）。二者满足其一即为 isMaster。
export function authenticateAdmin(
  request: Request,
  config: GatewayConfig,
  sessionPrincipal: AuthPrincipal | null
): AuthResult {
  // 会话主体已由上层中间件解析（Cookie 有效）
  if (sessionPrincipal) {
    return { ok: true, principal: sessionPrincipal };
  }
  // 回退：Bearer Master Key（原语义）
  return authenticateAccess(request, config, { requireMaster: true });
}
