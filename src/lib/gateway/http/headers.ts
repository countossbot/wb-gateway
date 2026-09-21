// HTTP 管道 —— 与协议无关的响应头工具。被 auth / admin / exchange / providers 跨层消费。
//
// 【安全重构说明】原实现 CORS 为 Access-Control-Allow-Origin: "*"（通配符），
// 与新的 Cookie 会话机制组合会形成 CSRF 型安全漏洞，故收紧：
//   - 默认不发送任何 Access-Control-* 头（同源：控制台与网关 API 同端口同源）
//   - 管理员可在设置页配置 corsAllowedOrigins 白名单；命中白名单的 Origin 才回显该 Origin
//   - 网关 API（/v1/*）被本机服务端客户端（Claude Code / CC-Switch / Cursor）调用，
//     属非浏览器调用，不需要 CORS 头；如需网页客户端（NextChat）跨域接入，
//     在设置中显式加入其 Origin 即可（最小必要配置）
// 白名单热生效：每次请求从内存配置读取（saveConfig 时同步更新）。

import { getCorsAllowedOrigins } from "../config/runtimeSettings";

/** 计算某请求应返回的 CORS 头集合（同源默认无头；白名单命中才回显） */
export function corsHeadersFor(request: Request | null): Record<string, string> {
  if (!request) return {};
  const origin = request.headers.get("origin");
  if (!origin) return {}; // 非浏览器 / 同源 GET 导航：无 CORS 头需求
  const allowed = getCorsAllowedOrigins();
  if (allowed.includes("*")) {
    // 显式配置 "*" 才回到通配符行为（风险自担，设置页有提示）
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
  }
  if (allowed.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, x-api-key, x-session-id, x-conversation-id, anthropic-version, X-Api-Key",
      "Access-Control-Allow-Credentials": "true",
    };
  }
  return {}; // 未命中白名单：不回 CORS 头（浏览器侧即拒绝）
}

/** 兼容导出：无请求上下文时的空 CORS 集（不再使用通配符） */
export const corsHeaders: Record<string, string> = {};

/**
 * v3.9.3：CORS 预检响应（/v1/* 路由的 OPTIONS 导出用）。
 * 原 proxy.ts（middleware）的预检逻辑收口到此：默认 204 无 CORS 头（同源收紧），
 * 白名单命中才回显——与 middleware 版行为一致，仅执行位置从 middleware 移到 route
 * （middleware 运行会缓冲整个请求 body，绕过入口 413 防护，故 /v1/* 排除在 matcher 外）。
 */
export function corsPreflightResponse(request: Request): Response {
  const origin = request.headers.get("origin");
  const allowed = getCorsAllowedOrigins();
  const headers: Record<string, string> = {};
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers["Access-Control-Allow-Origin"] = allowed.includes("*") ? "*" : origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      "Authorization, Content-Type, x-api-key, x-session-id, x-conversation-id, anthropic-version";
    if (!allowed.includes("*")) {
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Vary"] = "Origin";
    }
  }
  return new Response(null, { status: 204, headers });
}

// 逐跳（hop-by-hop）响应头：转发上游响应时必须剔除，否则分帧会被这些头破坏
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "content-length",
]);

// 复制上游响应头，剔除逐跳头，再叠加网关自有头。返回一个干净的 Headers。
export function buildResponseHeaders(
  upstreamHeaders: Headers,
  extra: Record<string, string> = {}
): Headers {
  const headers = new Headers();
  upstreamHeaders.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k, v);
  }
  return headers;
}

// 流式 SSE 响应头：禁用各级缓冲（网关自身、反代、中间层），
// x-accel-buffering: no 指示 nginx/Caddy 等反代禁用响应缓冲，
// no-cache no-transform 防中间层缓存与内容改写，保证首字延迟不退化。
export function sseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache no-transform",
    "x-accel-buffering": "no",
    Connection: "keep-alive",
    ...extra,
  };
}
