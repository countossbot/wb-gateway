// GET/POST /admin/api/config —— 配置读写（脱敏返回 / 合并回填写入）。
// GET：机密字段（accessToken / refreshToken / apiKey / cron_secret 等）脱敏后再返回。
// POST：校验只有一处（saveConfig 内的 validateConfig，状态码由抛出的 ConfigError 携带）。
import { NextRequest } from "next/server";
import { requireAdminAuth, jsonResponse } from "@/lib/gateway/http/routeHelpers";
import { getConfig, saveConfig, redactConfig, ConfigError } from "@/lib/gateway/config/configService";
import type { GatewayConfig } from "@/lib/gateway/core/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  const config = await getConfig();
  // 机密字段脱敏后再返回（SECRET_FIELDS → ***REDACTED***；virtual_keys 键名掩码）
  return jsonResponse(redactConfig(config), 200, request);
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if (!auth.ok) return auth.response;
  try {
    const newConfig = (await request.json()) as GatewayConfig;
    await saveConfig(newConfig);
    return jsonResponse(
      { success: true, message: "Configuration saved to SQLite successfully" },
      200,
      request
    );
  } catch (e) {
    const status = e instanceof ConfigError ? e.status : 500;
    return jsonResponse({ error: { message: (e as Error).message } }, status, request);
  }
}
