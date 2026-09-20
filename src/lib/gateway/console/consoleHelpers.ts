// 控制台 API 共享工具 —— 会话鉴权、凭据掩码/回填契约（与 /admin/api/config 同一套约定）、
// 统一响应包 { ok, data?, error? }。
import { resolveSession, type SessionPrincipal } from "../session/session";
import { getRuntimeSettingsAsync } from "../config/runtimeSettings";
import { db } from "@/lib/db";

export function ok(data: unknown = null): Response {
  return Response.json({ ok: true, data });
}

export function fail(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

// 控制台会话鉴权（除 login/setup/session 外全部要求）
export async function requireSession(request: Request): Promise<SessionPrincipal | null> {
  return resolveSession(request);
}

export async function requireSessionOr401(request: Request): Promise<SessionPrincipal | Response | null> {
  const session = await resolveSession(request);
  if (!session) return fail("未登录或会话已过期", 401);
  return session;
}

// ---- 凭据掩码 / 回填契约（验收要求三.6，与 configService.mergeSecrets 同一约定） ----
// 界面只显示掩码；保存时若该字段未被改动（仍为掩码值或空），服务端必须用 DB 原值回填，
// 绝不允许因一次保存把凭据清空。
export const SECRET_FIELDS = ["accessToken", "refreshToken", "apiKey", "token", "cookie", "jwtToken"];
export const REDACTED = "***REDACTED***";

export function maskSecret(value: unknown): string {
  if (!value || typeof value !== "string") return "";
  if (value.length <= 8) return REDACTED;
  return `${value.slice(0, 4)}••••${value.slice(-4)}（已隐藏，共 ${value.length} 位）`;
}

// 对 Account.credentials / Provider config 做掩码副本（不修改原对象）
export function maskAccountCredentials(
  credentials: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const creds = { ...(credentials || {}) };
  for (const field of SECRET_FIELDS) {
    if (creds[field]) creds[field] = maskSecret(creds[field]);
  }
  return creds;
}

// 保存回填：传入的 credentials 中掩码/空字段沿用 DB 原值
export function mergeCredentialsOnSave(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const merged = { ...(incoming || {}) };
  const src = existing || {};
  for (const field of SECRET_FIELDS) {
    const val = merged[field];
    const isMasked =
      val === REDACTED ||
      val === "" ||
      val === null ||
      val === undefined ||
      (typeof val === "string" && val.includes("••••"));
    if (isMasked && src[field]) {
      merged[field] = src[field];
    }
  }
  return merged;
}

// 虚拟密钥值掩码（键名场景用 maskKeyName，值场景用本函数）
export { maskKeyName } from "../config/configService";

export function maskKeyValue(key: string): string {
  return maskSecret(key);
}

// 设置聚合（settings 页一次性读取）
export async function consoleSettingsSnapshot(): Promise<Record<string, unknown>> {
  const settings = await getRuntimeSettingsAsync();
  const rows = await db.systemSetting.findMany();
  const map: Record<string, unknown> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    proxy: settings.proxy,
    corsAllowedOrigins: settings.corsAllowedOrigins,
    listenLan: settings.listenLan,
    logLevel: settings.logLevel,
    checkinEnabled: settings.checkinEnabled,
    checkinCron: settings.checkinCron,
    checkinTz: settings.checkinTz,
    keepaliveEnabled: settings.keepaliveEnabled,
    keepaliveCron: settings.keepaliveCron,
    keepaliveTz: settings.keepaliveTz,
    maxContextTurns: settings.maxContextTurns,
    usageProviderId: settings.usageProviderId,
    auditRetentionDays: settings.auditRetentionDays,
    balanceRetentionDays: settings.balanceRetentionDays, // v3.7.0
    streamStallMs: settings.streamStallMs, // v4.2.0
    upstreamHeadersTimeoutMs: settings.upstreamHeadersTimeoutMs, // v4.2.0
    upstreamBodyTimeoutMs: settings.upstreamBodyTimeoutMs, // v4.2.0
    hasMasterKey: typeof map.master_key === "string" && (map.master_key as string).length > 0,
    hasCronSecret: typeof map.cron_secret === "string" && (map.cron_secret as string).length > 0,
    configVersion: map.config_version ?? 1,
  };
}
