// Proxy（Next.js 16：原 middleware 约定已更名）—— 根路径内容协商 + CORS 预检收口。
//
// 1. `/` 的契约：原版 curl / 返回健康检查 JSON，重构版 / 是 Web 控制台页面。
//    内容协商：Accept 含 text/html（浏览器）→ 控制台页面；否则（curl / API 客户端）
//    rewrite 到 /healthz（对外 URL 与响应结构不变）。
// 2. OPTIONS 预检：默认 204 无 CORS 头（同源收紧）；白名单命中才回显。
import { NextRequest, NextResponse } from "next/server";
import { getCorsAllowedOrigins } from "@/lib/gateway/config/runtimeSettings";

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CORS 预检：仅白名单命中回显（默认同源策略，见 http/headers.ts）
  if (request.method === "OPTIONS") {
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
    return new NextResponse(null, { status: 204, headers });
  }

  // 根路径内容协商：非浏览器（无 text/html Accept）→ 健康检查 JSON（原版契约）
  if (pathname === "/") {
    const accept = request.headers.get("accept") || "";
    if (!accept.includes("text/html")) {
      return NextResponse.rewrite(new URL("/healthz", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // v3.9.3：排除网关 API 路径 —— middleware 运行会导致框架缓冲整个请求 body（绕过入口
  // 防护的 413 拒绝，30 个 2MB 并发即可撑爆内存）。/v1/* 的 CORS 预检由各 route 的
  // OPTIONS 导出处理（corsPreflightResponse 共享工具）。
  matcher: ["/", "/((?!_next/static|_next/image|favicon\\.ico|v1/).*)"],
};
