// 控制台前端统一 API 封装 —— 所有请求走相对路径 /api/console/*。
// 统一处理 { ok, data, error } 响应包；401 时触发全局未授权回调（page.tsx 注册 → 跳回登录态）。
//
// 双通道会话（v3.0.1）：Cookie 优先；预览面板等跨站 iframe 中 Cookie 会被浏览器丢弃，
// 故登录后把会话令牌存 localStorage，请求自动附带 Authorization: Bearer。
"use client";

// 会话令牌存储（与 Cookie 指向同一条服务端 Session 记录；登出/改密/过期时 401 自动清除）
const SESSION_TOKEN_KEY = "uag_session_token";

export function saveSessionToken(token: string | null | undefined): void {
  try {
    if (token) localStorage.setItem(SESSION_TOKEN_KEY, token);
    else localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* localStorage 不可用（隐私模式等）时静默降级为纯 Cookie 通道 */
  }
}

export function readSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** 构造带会话令牌的请求头（供 page.tsx 的裸 fetch 复用） */
export function authHeaders(): Record<string, string> {
  const token = readSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** page.tsx 在挂载时注册：任何请求收到 401 → 会话失效，切回登录页 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  opts?: { quiet?: boolean }
): Promise<T> {
  // 双通道：Cookie（credentials 同源自动携带）+ Bearer 会话令牌兑底
  const token = readSessionToken();
  // v3.9.1：30s 硬超时 —— 修复「日志页卡死」：此前 fetch 无超时，后端挂起（dev 编译/DB 锁/
  // 代理假死）时前端永远停在 loading 旧数据。超时后抛 ApiError 走常规错误展示（可重试）。
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
      credentials: "same-origin",
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
      throw new ApiError("请求超时（30 秒）——服务端繁忙或无响应，请稍后重试", 0);
    }
    throw new ApiError(`网络请求失败：${(e as Error).message}`, 0);
  }

  if (res.status === 401) {
    // 令牌已死（登出/改密/过期/伪造）→ 清除本地死令牌，回到登录态
    clearSessionToken();
    if (!opts?.quiet) unauthorizedHandler?.();
    let msg = "未登录或会话已过期";
    try {
      const body = (await res.clone().json()) as Envelope<T>;
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, 401);
  }

  const text = await res.text();
  let body: Envelope<T>;
  try {
    body = JSON.parse(text) as Envelope<T>;
  } catch {
    throw new ApiError(`服务端返回异常（HTTP ${res.status}）`, res.status);
  }

  if (!body.ok) {
    throw new ApiError(body.error || `请求失败（HTTP ${res.status}）`, res.status);
  }
  return body.data as T;
}

export function apiGet<T>(path: string, opts?: { quiet?: boolean }): Promise<T> {
  return request<T>(path, { method: "GET" }, opts);
}

export function apiPost<T>(path: string, payload?: unknown, opts?: { quiet?: boolean }): Promise<T> {
  return request<T>(
    path,
    { method: "POST", body: JSON.stringify(payload ?? {}) },
    opts
  );
}

export function apiPut<T>(path: string, payload?: unknown, opts?: { quiet?: boolean }): Promise<T> {
  return request<T>(
    path,
    { method: "PUT", body: JSON.stringify(payload ?? {}) },
    opts
  );
}

export function apiPatch<T>(path: string, payload?: unknown, opts?: { quiet?: boolean }): Promise<T> {
  return request<T>(
    path,
    { method: "PATCH", body: JSON.stringify(payload ?? {}) },
    opts
  );
}

export function apiDelete<T>(path: string, opts?: { quiet?: boolean }): Promise<T> {
  return request<T>(path, { method: "DELETE" }, opts);
}

/** 提取错误消息（用于内联错误展示） */
export function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
