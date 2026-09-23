// 管理员密码与会话 —— scrypt 强哈希 + 双通道会话：Cookie（HttpOnly / SameSite=Lax）优先，
// Bearer 会话令牌（Authorization 头）兜底。
//
// 会话机制选型说明（README 同步）：选服务端会话而非 JWT，理由：
//   1. 需求明确要求「登出、会话有效期、滑动续期、修改密码后失效全部既有会话」——
//      服务端会话天然支持撤销；JWT 无状态签名无法单点失效（除非引入黑名单，等于变相会话）。
//   2. 管理端是单管理员场景，无跨服务共享身份的需求，JWT 的分布式收益为零。
//
// 双通道设计（v3.0.1 修复）：
//   Cookie 走 HttpOnly + SameSite=Lax，配合收紧后的 CORS（默认同源），CSRF 面最小。
//   但控制台可能被嵌入第三方 iframe（预览面板）——现代浏览器会在跨站 iframe 上下文
//   静默丢弃 SameSite=Lax Cookie，导致「登录成功却总被弹回登录页」。
//   兜底通道：登录响应同时下发会话令牌（前端存 localStorage、请求带 Authorization 头）。
//   两条通道指向同一条服务端 Session 记录：登出 / 改密 / 过期删除记录即同时失效，
//   撤销语义与纯 Cookie 设计完全一致（令牌仅代表控制台会话，不是网关 Master Key）。
import { db } from "@/lib/db";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { BoundedMap } from "../core/boundedMap";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = "uag_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时有效期
export const SESSION_SLIDING_MS = 60 * 60 * 1000; // 滑动续期：剩余 < 1h 时每次访问顺延

// ---- 密码（scrypt: salt$hash） ----
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const derived = await scrypt(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return derived.length === expected.length && nodeTimingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---- 会话 ----
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SessionPrincipal {
  isMaster: true;
  role: "admin";
  name: string;
  sessionId: string;
  userId: string;
}

export async function createSession(userId: string, username: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

// 从请求中提取 Bearer 会话令牌（Authorization: Bearer xxx）。
// 注意：这不是网关 Master Key / 虚拟密钥通道，仅用于控制台会话兜底；
// 值是否为有效会话由 resolveSessionFromToken 查库判定。
function bearerSessionToken(request: Request): string | null {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

// 令牌 → 会话主体（Cookie 值与 Bearer 令牌共用此核心）。
// 滑动续期：剩余 < SESSION_SLIDING_MS（1h）时把 expiresAt 顺延至 now + SESSION_TTL_MS（12h），
// 并同步写回 DB —— Bearer 通道无 Cookie 需重写，双通道共用此逻辑前端均无感知。
export async function resolveSessionFromToken(token: string): Promise<SessionPrincipal | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  const session = await db.session.findUnique({ where: { tokenHash } });
  if (!session) return null;
  const now = Date.now();
  const expiresAtMs = session.expiresAt.getTime();
  if (expiresAtMs < now) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  // 滑动续期：剩余 < 1h → 顺延至满 12h（活跃用户永不过期；不活跃用户到期自然失效）
  if (expiresAtMs - now < SESSION_SLIDING_MS) {
    const renewedAt = new Date(now + SESSION_TTL_MS);
    await db.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt: renewedAt } })
      .catch(() => {});
  } else {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
  }
  return {
    isMaster: true,
    role: "admin",
    name: "Console Admin",
    sessionId: session.id,
    userId: session.userId,
  };
}

// 从请求解析会话主体（双通道）：Cookie 优先，Bearer 令牌兜底；
// 均命中时视作同一主体（同 token 则同记录）。滑动续期（剩余 < 1h 时顺延 DB lastSeenAt）
export async function resolveSession(request: Request): Promise<SessionPrincipal | null> {
  // 通道 1：Cookie（同源/顶层页面 —— 常规部署主通道）
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (match) {
    const viaCookie = await resolveSessionFromToken(decodeURIComponent(match[1]));
    if (viaCookie) return viaCookie;
  }
  // 通道 2：Authorization Bearer 会话令牌（跨站 iframe 中 Cookie 被浏览器丢弃时兜底）
  const bearer = bearerSessionToken(request);
  if (bearer) {
    return resolveSessionFromToken(bearer);
  }
  return null;
}

// 探测当前请求的生效认证通道（控制台徽标展示用；与 resolveSession 同优先级）
export async function detectAuthVia(request: Request): Promise<"cookie" | "bearer" | null> {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (match && (await resolveSessionFromToken(decodeURIComponent(match[1])))) return "cookie";
  const bearer = bearerSessionToken(request);
  if (bearer && (await resolveSessionFromToken(bearer))) return "bearer";
  return null;
}

// 登出：双通道一并销毁（Cookie 令牌 + Bearer 令牌各自指向的会话记录）
export async function destroySession(request: Request): Promise<void> {
  const hashes = new Set<string>();
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (match) hashes.add(sha256(decodeURIComponent(match[1])));
  const bearer = bearerSessionToken(request);
  if (bearer) hashes.add(sha256(bearer));
  for (const tokenHash of hashes) {
    await db.session.deleteMany({ where: { tokenHash } }).catch(() => {});
  }
}

// 修改密码后失效全部既有会话
export async function destroyAllSessions(): Promise<void> {
  await db.session.deleteMany({});
}

// 过期会话清扫（v3.0.3）：登出不总发生，过期记录会在表内积累；
// 由调度器每小时调用一次，删除 expiresAt 已过期的全部记录。
// 注：resolveSessionFromToken 命中过期记录时会顺手删除单条，这里是兜底的批量清理。
export async function purgeExpiredSessions(): Promise<number> {
  try {
    const result = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return result.count;
  } catch {
    return 0;
  }
}

// 会话 Cookie 序列化（HttpOnly + SameSite=Lax；生产加 Secure —— 本地 HTTP 部署默认关闭）
export function sessionCookie(token: string, expiresAt: Date): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_INSECURE_COOKIE !== "1") {
    parts.push("Secure"); // 仅当生产且非本地 HTTP 模式
  }
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---- 登录失败限制与临时锁定 ----
// 5 次失败锁 15 分钟（进程内存计数 + LoginAudit 落库审计）
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
// v3.9.3：BoundedMap 有界化 —— 以客户端 IP 为键且只在登录成功时 delete，
// 可被扫描攻击打爆（每 IP 一条永不回收）。容量上限 1000 + 条目 TTL 15min：
// TTL 与 LOCK_MS 同长 —— 锁定到期条目也过期，语义配合而非冲突；
// sweep 惰性清扫挂在 recordLoginFailure（低频路径），无模块级定时器。
const LOGIN_FAILURES = new BoundedMap<string, { count: number; lockedUntil: number }>({
  maxEntries: 1000,
  ttlMs: LOCK_MS,
});

export function isLoginLocked(ip: string): { locked: boolean; retryAfterSec?: number } {
  const rec = LOGIN_FAILURES.get(ip);
  if (!rec) return { locked: false };
  if (rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

export function recordLoginFailure(ip: string): void {
  LOGIN_FAILURES.sweep(); // v3.9.3：惰性清扫过期条目（防扫描攻击打爆，Map 上限 1000 兜底）
  const rec = LOGIN_FAILURES.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  LOGIN_FAILURES.set(ip, rec);
}

export function clearLoginFailures(ip: string): void {
  LOGIN_FAILURES.delete(ip);
}

export async function auditLogin(ip: string, userAgent: string, success: boolean, reason?: string): Promise<void> {
  try {
    await db.loginAudit.create({
      data: { ip, userAgent: userAgent.slice(0, 300), success, reason: reason || null },
    });
  } catch {
    /* noop */
  }
}

// 客户端 IP 提取（反代场景取 X-Forwarded-For 首个）
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "127.0.0.1";
}

// 初始化引导防抢占：仅当「无管理员存在」且「请求来自本机」时可用
export function isLocalRequest(request: Request): boolean {
  const ip = clientIp(request);
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip === "::ffff:127.0.0.1";
}
