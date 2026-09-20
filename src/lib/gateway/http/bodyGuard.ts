// v3.9.3：网关入口 body 防护 —— 大请求拒绝（413）与无 Content-Length 场景的流式读取上限。
//
// 背景：旧入口先 `await request.json()` 再鉴权——30 个 2MB 并发请求在鉴权之前就把 body
// 全量读进内存（实测峰值 +21MB 不回落；mem_limit 320m 场景下是硬 OOM 而非软降级）。
// 本模块提供三件套：
//   1. contentLengthTooLarge()：Content-Length 超限判定（零内存占用即可拒绝）
//   2. readJsonBodyWithLimit()：读 body 的唯一入口——有 Content-Length 直接 json()；
//      chunked（无长度）走流式读取并累计计量，超限立即中断（reader.cancel）返回 413
//   3. tooLargeResponse()：统一的 413 响应（与网关其他错误响应同构）
import { corsHeadersFor } from "./headers";

export const GATEWAY_MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload Too Large");
    this.name = "PayloadTooLargeError";
  }
}

/** Content-Length 是否超限（缺失/非法返回 false，由流式读取兜底计量） */
export function contentLengthTooLarge(request: Request, maxBytes = GATEWAY_MAX_BODY_BYTES): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > maxBytes;
}

export function tooLargeResponse(request: Request, maxBytes = GATEWAY_MAX_BODY_BYTES): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Request body too large: limit is ${Math.round(maxBytes / 1024 / 1024)}MB`,
      },
    }),
    {
      status: 413,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }
  );
}

/**
 * 读取请求 body 并解析 JSON（入口防护统一出口）：
 *   - 有 Content-Length（≤ 上限）：直接 request.json()（框架路径，零额外拷贝）
 *   - 无 Content-Length（chunked）：流式读取 + 累计计量，超限 reader.cancel 并抛
 *     PayloadTooLargeError（调用方转 413）。chunk 数组收集、Blob 合并，无逐块 JS 拼接。
 * JSON 解析失败原样抛出（调用方按原有 400 分支处理，响应格式不变）。
 */
export async function readJsonBodyWithLimit(
  request: Request,
  maxBytes = GATEWAY_MAX_BODY_BYTES
): Promise<Record<string, unknown>> {
  if (request.headers.get("content-length")) {
    return (await request.json()) as Record<string, unknown>;
  }
  // chunked：流式读取 + 硬上限
  const reader = request.body?.getReader();
  if (!reader) {
    return {}; // 无 body：交由调用方 JSON 解析/字段访问路径自然报错
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {}); // 立即中断上游传输，释放内存
      throw new PayloadTooLargeError();
    }
    parts.push(value);
  }
  const text = await new Blob(parts as BlobPart[]).text();
  return JSON.parse(text) as Record<string, unknown>;
}
