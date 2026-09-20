// 响应侧转译 —— OpenAI SSE/JSON → Anthropic SSE/JSON（reduce / extractors / stream）。
// 流式与非流式共享 extractors，两处不再各自拼装；路由见 ./dispatch.ts。
import { corsHeadersFor, sseHeaders } from "../http/headers";
import { recordUpstreamCache } from "../core/cacheStats";

// 模块级单例 Encoder / Decoder 与预编码静态 Buffer（零 GC 内存分配）
const textEncoder = new TextEncoder();
const KEEP_ALIVE_BYTES = textEncoder.encode('event: ping\ndata: {"type":"ping"}\n\n');
const EVENT_MSG_STOP_BYTES = textEncoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');

// ---- v3.9.3：SSE 行扫描器（chunk 数组 + 增量扫描索引） ----
/**
 * 旧实现每收到一个上游 chunk 都执行一次全量字符串拼接（buffer += ...，O(累计长度)）
 * 与一次全量 slice（buffer = buffer.slice(pos)，O(残量)）——长回复下内存分配量随总长度
 * 平方增长（500 并发实测 RSS 176→198MB 且不回落）。
 *
 * 新实现：chunk 只 append 进数组、扫描指针只前进；产出行时才发生行级大小的拷贝。
 *   - 已消费尽的 chunk 从数组头部移出（shift 摊销 O(1)）
 *   - 跨 chunk 残行用 carry 片段数组持有，行闭合时 join 一次（零重复拷贝）
 *   - 硬上限 256KB：残行超限且仍无完整行时按上限强制切分产出，剩余部分继续拼接
 *     （不丢弃数据；调用方按普通行处理，JSON.parse 失败静默跳过与原行为一致）
 * 输出字节序列不变：只影响「行如何从字节流中切出」，不影响行内容与写出字节。
 */
const SSE_LINE_BUFFER_LIMIT_CHARS = 256 * 1024; // 残行硬上限（256K 字符 ≈ 256~512KB 字节）

class ChunkLineScanner {
  private chunks: string[] = []; // 待扫描 chunk 队列（chunks[0] 自 scanOffset 起未扫描）
  private scanOffset = 0;
  private carry: string[] | null = null; // 跨 chunk 残行片段（行闭合时 join 一次）
  private carryLen = 0;
  private pending = 0; // 未消费字符数（待扫描 + carry 总量，用于超限判定）

  /** 追加一段新解码文本 */
  push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.pending += text.length;
  }

  /** 未消费总字符数（残行 + 待扫描） */
  get bufferedChars(): number {
    return this.pending;
  }

  /**
   * 取下一条完整行（不含换行符）；无完整行返回 null。
   * 残行超过 SSE_LINE_BUFFER_LIMIT_CHARS 仍无换行 → 强制按上限切分产出头部。
   */
  nextLine(): string | null {
    while (true) {
      const first = this.chunks[0];
      if (first !== undefined) {
        const nl = first.indexOf("\n", this.scanOffset);
        if (nl !== -1) {
          let line: string;
          if (this.carry && this.carry.length > 0) {
            this.carry.push(first.slice(this.scanOffset, nl));
            line = this.carry.join("");
            this.pending -= this.carryLen + (nl - this.scanOffset) + 1;
            this.carry = null;
            this.carryLen = 0;
          } else {
            line = first.slice(this.scanOffset, nl);
            this.pending -= nl + 1 - this.scanOffset;
          }
          this.scanOffset = nl + 1;
          if (this.scanOffset >= first.length) {
            this.chunks.shift();
            this.scanOffset = 0;
          }
          return line;
        }
        // 当前 chunk 无换行：整段并入 carry（scanOffset=0 时零拷贝引用），继续下一 chunk
        if (!this.carry) this.carry = [];
        const seg = this.scanOffset === 0 ? first : first.slice(this.scanOffset);
        this.carry.push(seg);
        this.carryLen += seg.length;
        this.chunks.shift();
        this.scanOffset = 0;
        continue;
      }
      // 无待扫描 chunk：残行超限则强制切分（防恶意/损坏流无限占用内存）
      if (this.carryLen > SSE_LINE_BUFFER_LIMIT_CHARS) {
        const joined = this.carry!.join("");
        const head = joined.slice(0, SSE_LINE_BUFFER_LIMIT_CHARS);
        const tail = joined.slice(SSE_LINE_BUFFER_LIMIT_CHARS);
        this.carry = [tail];
        this.carryLen = tail.length;
        this.pending = tail.length;
        return head; // 作为一行产出（数据不丢弃，尾部继续等待后续拼接）
      }
      return null;
    }
  }

  /**
   * 流结束时取走全部剩余未消费文本（残行）并清空缓冲。
   * 仅应在流终止后调用一次（原实现 `buffer` 尾部残留的等价物）。
   */
  drainRemainder(): string {
    // chunks[0] 可能已被部分扫描（scanOffset > 0）：未消费部分从指针处起算
    let rest = "";
    if (this.chunks.length > 0) {
      const firstRest = this.chunks[0].slice(this.scanOffset);
      rest = this.chunks.length > 1 ? firstRest + this.chunks.slice(1).join("") : firstRest;
    }
    const remainder = this.carry && this.carry.length > 0 ? this.carry.join("") + rest : rest;
    this.chunks = [];
    this.scanOffset = 0;
    this.carry = null;
    this.carryLen = 0;
    this.pending = 0;
    return remainder;
  }
}

export interface ParsedChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
  };
  error?: { message?: string };
  code?: number;
  msg?: string;
  message?: string;
  [key: string]: unknown;
}

// 纯函数：从已解析的上游 JSON 中提取错误消息（error 字段 / msg / message / 非零 code）。
// reduceOpenAIChunk 与 formatOpenAIToAnthropicJson 共享，避免两处各自拼装。
export function extractErrorMessage(parsed: ParsedChunk | null): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  return (
    parsed.error?.message ||
    parsed.msg ||
    parsed.message ||
    (parsed.code !== undefined && parsed.code !== 0 ? `Upstream error code ${parsed.code}` : null)
  );
}

// 纯函数：判断上游是否携带业务错误（Tencent code !== 0 或显式 error 字段）。
export function isUpstreamError(parsed: ParsedChunk | null): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  return !!(parsed.error || (parsed.code !== undefined && parsed.code !== 0));
}

// 纯函数：从已解析的 usage 中提取 token 计数，返回 { input, output }（缺失保留原值）。
// 兼容旧调用方（默认估算起点 20/1）。
export function extractUsage(
  parsed: ParsedChunk | null,
  current = { input: 20, output: 1 }
): { input: number; output: number } {
  const upstream = extractUsageUpstream(parsed);
  if (!upstream) return current;
  return {
    input: upstream.input > 0 ? upstream.input : current.input,
    output: upstream.output > 0 ? upstream.output : current.output,
  };
}

// 纯函数：从上游 usage 帧提取精确 token 计数；未提供/无效返回 null。
// 覆盖 OpenAI stream_options.include_usage 的末尾 chunk（无 choices 但带 usage）与
// 非 SSE JSON 响应的顶层 usage。字段容错：prompt_tokens / input_tokens、
// completion_tokens / output_tokens、以及字符串型数字。
export function extractUsageUpstream(parsed: ParsedChunk | null): { input: number; output: number } | null {
  const u = parsed?.usage;
  if (!u || typeof u !== "object") return null;
  const rawIn = (u as Record<string, unknown>).prompt_tokens ?? (u as Record<string, unknown>).input_tokens;
  const rawOut = (u as Record<string, unknown>).completion_tokens ?? (u as Record<string, unknown>).output_tokens;
  const input = Number(rawIn);
  const output = Number(rawOut);
  const hasInput = Number.isFinite(input) && input > 0;
  const hasOutput = Number.isFinite(output) && output > 0;
  if (!hasInput && !hasOutput) return null;
  return { input: hasInput ? Math.round(input) : 0, output: hasOutput ? Math.round(output) : 0 };
}

// 纯函数：提取上游前缀缓存命中 token 数（OpenAI 形 cached_tokens / Anthropic 形
// cache_read_input_tokens），缺失为 0。调用方取各 chunk 最大值记一次。
export function extractCachedTokens(parsed: ParsedChunk | null): number {
  const u = parsed?.usage;
  if (!u || typeof u !== "object") return 0;
  const n = (u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0) as number;
  return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0;
}

// OpenAI finish_reason -> Anthropic stop_reason 映射
// Anthropic 只有 end_turn / max_tokens / stop_sequence / tool_use 四种；
// content_filter（安全过滤截断）没有对应项，归为 end_turn（自然停止），
// 不能用 stop_sequence（那表示命中用户自定义停止序列，语义错误）。
export function finishReasonToAnthropic(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
    default:
      return "end_turn";
  }
}

export type ChunkEmission =
  | { kind: "error"; message: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; calls: Array<{ id: string | null; name: string; arguments: string }>; stopReason: "tool_use" }
  | null;

// 纯函数：把单个已解析的 OpenAI SSE chunk 归约为一条「发射指令」。
// 不做任何 I/O，只做分类与字段提取 —— 这是流式转译里最易回归、也最该被测试的部分。
// 返回 null 表示该 chunk 无需发射任何事件（如空 delta、[DONE] 已在外层过滤）。
export function reduceOpenAIChunk(parsed: ParsedChunk | null): ChunkEmission {
  if (!parsed || typeof parsed !== "object") return null;

  // 上游业务错误（Tencent code !== 0 或显式 error 字段）
  if (isUpstreamError(parsed)) {
    const msg = extractErrorMessage(parsed) || "Unknown error";
    return { kind: "error", message: msg };
  }

  const delta = parsed.choices?.[0]?.delta;
  const finishReason = parsed.choices?.[0]?.finish_reason;

  // 工具调用：可能在同一 chunk 内携带多个 tool_call
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    const calls = delta.tool_calls.map((tc) => ({
      id: tc.id || null,
      name: tc.function?.name || "tool",
      arguments: tc.function?.arguments || "",
    }));
    return { kind: "tool_use", calls, stopReason: "tool_use" };
  }

  // 思维链增量（兼容 DeepSeek reasoning_content 与 OpenCode / MiMo reasoning）
  const reasoningDelta = delta?.reasoning_content || delta?.reasoning;
  if (reasoningDelta) {
    return { kind: "thinking", text: reasoningDelta };
  }

  // 正文增量
  if (delta?.content) {
    return { kind: "text", text: delta.content };
  }

  // finish_reason 标记（无内容，但影响最终 stop_reason）
  if (finishReason === "tool_calls") {
    return { kind: "tool_use", calls: [], stopReason: "tool_use" };
  }

  return null;
}

// 上游流停滞熔断：连续该时长收不到上游任何字节即判定上游卡死（如某些模型只回 200 头然后静默），
// 主动收尾而不是让客户端挂到超时。只看「无字节」时长，持续吐 token 的慢模型不受影响。
export const UPSTREAM_STALL_MS = 180 * 1000;

export interface StreamDebugHeaders {
  "X-Gateway-Account"?: string;
  "X-Gateway-Model"?: string;
  "X-Gateway-Fallback"?: string;
  [key: string]: string | undefined;
}

/** 流结束时的精确用量回调（v3.9.3：新增来源字段；upstreamExact 保留向后兼容） */
export type UsageSource = "upstreamUsageFrame" | "estimated" | "unknown";
export interface StreamUsageReport {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** @deprecated v3.9.3 由 source 替代（保留兼容旧调用方）；语义：source !== "upstreamUsageFrame" */
  upstreamExact: boolean;
  /** v3.9.3：用量来源 —— upstreamUsageFrame=上游 usage 帧（精确）/ estimated=字符估算 / unknown=未记录 */
  source: UsageSource;
}

/** 字符数/token 估算比率（≈4 字符/token，与行业经验值一致） */
function estimateTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

// v3.0.3：协议透传分支（OpenAI 透传 / Anthropic 原生）的旁路 usage 统计。
// 不改动发往客户端的任何字节；仅旁路观察：
//   - OpenAI 透传：SSE usage 帧（stream_options.include_usage 尾帧）/ JSON 顶层 usage
//   - Anthropic 原生：message_delta 顶层 usage / message_start 嵌套 message.usage
//   - 上游未提供时按已发出正文字符数估算（与转译路径口径一致）
// 兼容形态：parsed.usage（OpenAI/Anthropic message_delta）与 parsed.message.usage（Anthropic message_start）
function usageFromFrame(parsed: ParsedChunk | null): { input: number; output: number; cached: number } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const candidates: unknown[] = [parsed.usage];
  const nestedMessage = (parsed as Record<string, unknown>).message as Record<string, unknown> | undefined;
  if (nestedMessage && typeof nestedMessage === "object") candidates.push(nestedMessage.usage);
  for (const u of candidates) {
    if (!u || typeof u !== "object") continue;
    const rawIn = (u as Record<string, unknown>).prompt_tokens ?? (u as Record<string, unknown>).input_tokens;
    const rawOut = (u as Record<string, unknown>).completion_tokens ?? (u as Record<string, unknown>).output_tokens;
    const input = Number(rawIn);
    const output = Number(rawOut);
    const hasInput = Number.isFinite(input) && input > 0;
    const hasOutput = Number.isFinite(output) && output > 0;
    if (hasInput || hasOutput) {
      const cachedRaw = (u as Record<string, unknown>).prompt_tokens_details
        ? ((u as Record<string, unknown>).prompt_tokens_details as Record<string, unknown>).cached_tokens
        : (u as Record<string, unknown>).cache_read_input_tokens;
      const cached = Number(cachedRaw);
      return {
        input: hasInput ? Math.round(input) : 0,
        output: hasOutput ? Math.round(output) : 0,
        cached: Number.isFinite(cached) && cached > 0 ? Math.round(cached) : 0,
      };
    }
  }
  return null;
}

// v3.0.3：透传 body 的旁路 usage tee —— 返回新的 ReadableStream（字节不变），
// 流结束（正常完成 / 上游错误 / 客户端中断）时回调 onUsage 一次。
export function passthroughUsageTee(
  body: ReadableStream<Uint8Array>,
  onUsage: (report: StreamUsageReport) => void
): ReadableStream<Uint8Array> {
  let reported = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let exact = false;
  let contentChars = 0;
  const decoder = new TextDecoder();
  const scanner = new ChunkLineScanner(); // v3.9.3：chunk 数组 + 增量扫描（替代全量拼接/全量 slice）

  const scanLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as ParsedChunk;
      const usage = usageFromFrame(parsed);
      if (usage) {
        exact = true;
        if (usage.input > inputTokens) inputTokens = usage.input;
        if (usage.output > outputTokens) outputTokens = usage.output;
        if (usage.cached > cachedTokens) cachedTokens = usage.cached;
      }
      // 已发出正文字符（估算兜底口径：delta.content / message.content）
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string") contentChars += delta.length;
      const msgContent = parsed.choices?.[0]?.message?.content;
      if (typeof msgContent === "string") contentChars += msgContent.length;
    } catch {
      /* 非 JSON 行忽略 */
    }
  };

  const report = (): void => {
    if (reported) return;
    reported = true;
    try {
      onUsage({
        inputTokens: exact ? inputTokens : 0,
        outputTokens: exact ? outputTokens : estimateTokensFromChars(contentChars),
        cachedTokens,
        upstreamExact: exact,
        source: exact ? "upstreamUsageFrame" : "estimated",
      });
    } catch {
      /* noop */
    }
  };

  const consumeBuffer = (): void => {
    for (let line = scanner.nextLine(); line !== null; line = scanner.nextLine()) {
      scanLine(line);
    }
  };

  // Transformer.cancel 在运行时支持（Web Streams 规范），但当前 TS DOM lib 类型未收录 —— 显式扩展
  interface TeeTransformer extends Transformer<Uint8Array, Uint8Array> {
    cancel?: (reason?: unknown) => void | Promise<void>;
  }
  const transformer: TeeTransformer = {
    transform(chunk, controller): void {
      try {
        scanner.push(decoder.decode(chunk, { stream: true }));
        consumeBuffer();
      } catch {
        /* 统计失败不影响透传 */
      }
      try {
        controller.enqueue(chunk);
      } catch {
        /* 客户端已取消：cancel() 兜底上报 */
      }
    },
    flush(): void {
      try {
        const remainder = scanner.drainRemainder();
        if (remainder.trim()) scanLine(remainder);
      } catch {
        /* noop */
      }
      report();
    },
    cancel(): void {
      report(); // 客户端中断：按已观察到的部分上报
    },
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(transformer));
}

// v3.0.3：透传非流式 JSON 响应的 usage 解析（一次性缓冲全文后调用）。
// 上游提供 usage → 精确；未提供 → 按响应正文字符估算；解析失败 → null（不落用量）。
export function passthroughUsageFromJson(text: string): StreamUsageReport | null {
  let parsed: ParsedChunk | null = null;
  try {
    parsed = JSON.parse(text) as ParsedChunk;
  } catch {
    return null;
  }
  const usage = usageFromFrame(parsed);
  if (usage) {
    return { inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cached, upstreamExact: true, source: "upstreamUsageFrame" };
  }
  let contentChars = 0;
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content === "string") contentChars = content.length;
  else if (parsed && typeof parsed === "object") {
    const raw = (parsed as Record<string, unknown>).content;
    if (typeof raw === "string") contentChars = raw.length; // Anthropic 原生非流式
  }
  if (contentChars === 0) return null;
  return { inputTokens: 0, outputTokens: estimateTokensFromChars(contentChars), cachedTokens: 0, upstreamExact: false, source: "estimated" };
}

// ---- v4.2.0（R6）：透传 SSE 保活 ping + 停滞熔断 ----
// 结构性缺口（Task 33 诊断 R6）：keep-alive ping 与停滞熔断此前只存在于转译分支
// （streamOpenAIToAnthropic）；OpenAI 协议透传与 Anthropic 原生透传既无 ping 也无熔断，
// 上游静默时客户端方向零字节 → 中间层（nginx 默认 60s read timeout / 云 LB idle timeout）
// 先断连接；上游挂死则挂到 undici bodyTimeout。
//
// 保活帧协议适配：
//   - Anthropic 客户端：独立 ping 事件（`event: ping\ndata: {"type":"ping"}`，Anthropic
//     协议原生帧，Claude Code 等客户端原生忽略；与转译分支 KEEP_ALIVE_BYTES 同款）
//   - OpenAI 客户端：SSE 注释行（`: keep-alive`，SSE 规范合法注释，所有合规解析器忽略）
//
// 注入安全性：仅在「事件边界」注入（上一完整行是空行）——半开事件（data: 行已到、
// 结束空行未到）期间注入会提前派发事件，多行 data 事件（JSON 跨行）场景会被截断。
// 事件边界注入：注释行被解析器完全忽略，独立 ping 事件本身就是完整事件。
const SSE_COMMENT_PING_BYTES = textEncoder.encode(": keep-alive\n\n");

export interface PassthroughKeepAliveOptions {
  /** 停滞熔断阈值（ms）；缺省用 UPSTREAM_STALL_MS */
  stallMs?: number;
  /** ping 间隔（ms，默认 4000，最小 1000） */
  pingIntervalMs?: number;
  /** 客户端协议（决定保活帧格式）：anthropic=ping 事件 / openai=SSE 注释行 */
  clientProtocol: "openai" | "anthropic";
  /** 客户端请求（signal 级联中断上游） */
  request?: Request | null;
}

/**
 * v4.2.0（R6）：透传 SSE 流的保活 + 熔断 + 旁路 usage 统计（替代裸 passthroughUsageTee）。
 * 返回新的 ReadableStream —— 上游字节原样透传，仅在安全时机插入保活帧；
 * 上游停滞超阈值时补协议终帧后干净收尾：
 *   - OpenAI：`data: [DONE]`（客户端按正常完成处理，内容为已收到的部分）
 *   - Anthropic：`event: message_stop`（与转译分支熔断语义一致）
 * 客户端中断（request.signal abort）级联取消上游读取并释放全部资源。
 */
export function passthroughSseWithKeepAlive(
  body: ReadableStream<Uint8Array>,
  onUsage: (report: StreamUsageReport) => void,
  options: PassthroughKeepAliveOptions
): ReadableStream<Uint8Array> {
  const stallMs =
    Number.isFinite(options?.stallMs) && (options?.stallMs as number) > 0
      ? (options.stallMs as number)
      : UPSTREAM_STALL_MS;
  const pingIntervalMs =
    Number.isFinite(options?.pingIntervalMs) && (options?.pingIntervalMs as number) >= 1000
      ? (options.pingIntervalMs as number)
      : 4000;
  const isAnthropicClient = options?.clientProtocol === "anthropic";
  // 排障开关：UAG_SSE_DEBUG=1 时输出生效参数（默认静默）
  if (process.env.UAG_SSE_DEBUG === "1") {
    console.log(`[SSE-Debug] passthrough: stallMs=${stallMs} pingIntervalMs=${pingIntervalMs} client=${isAnthropicClient ? "anthropic" : "openai"}`);
  }
  const pingBytes = isAnthropicClient ? KEEP_ALIVE_BYTES : SSE_COMMENT_PING_BYTES;
  const stallCloseBytes = isAnthropicClient
    ? EVENT_MSG_STOP_BYTES
    : textEncoder.encode("data: [DONE]\n\n");

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = body.getReader();

  // ---- 旁路 usage 统计（与 passthroughUsageTee 同款口径） ----
  let reported = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let exact = false;
  let contentChars = 0;
  const decoder = new TextDecoder();
  const scanner = new ChunkLineScanner();
  let atEventBoundary = true; // 初始处于事件边界（流刚起步）

  const scanLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as ParsedChunk;
      const usage = usageFromFrame(parsed);
      if (usage) {
        exact = true;
        if (usage.input > inputTokens) inputTokens = usage.input;
        if (usage.output > outputTokens) outputTokens = usage.output;
        if (usage.cached > cachedTokens) cachedTokens = usage.cached;
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string") contentChars += delta.length;
      const msgContent = parsed.choices?.[0]?.message?.content;
      if (typeof msgContent === "string") contentChars += msgContent.length;
    } catch {
      /* 非 JSON 行忽略 */
    }
  };

  const report = (): void => {
    if (reported) return;
    reported = true;
    try {
      onUsage({
        inputTokens: exact ? inputTokens : 0,
        outputTokens: exact ? outputTokens : estimateTokensFromChars(contentChars),
        cachedTokens,
        upstreamExact: exact,
        source: exact ? "upstreamUsageFrame" : "estimated",
      });
    } catch {
      /* noop */
    }
  };

  // ---- 保活 + 熔断定时器 ----
  let stalled = false;
  let finished = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const cleanupTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  let lastUpstreamByteAt = Date.now();

  timer = setInterval(() => {
    if (finished) {
      cleanupTimer();
      return;
    }
    // 停滞熔断：上游长时间零字节 → cancel 上游读取（读循环以 done 收尾），
    // finally 分支补协议终帧后干净关闭（比裸断连/挂到 bodyTimeout 对客户端更友好）
    if (!stalled && Date.now() - lastUpstreamByteAt > stallMs) {
      stalled = true;
      console.warn(
        `[Passthrough Stall] No upstream bytes for ${stallMs}ms, closing SSE stream (${isAnthropicClient ? "anthropic" : "openai"} protocol)`
      );
      cleanupTimer();
      try {
        void reader.cancel(new Error("Upstream stalled")).catch(() => {});
      } catch {
        /* noop */
      }
      return;
    }
    // 保活 ping：仅在事件边界注入（半开事件期间注入会截断多行 data 帧，见函数头注释）
    if (stalled || !atEventBoundary) return;
    try {
      void writer.write(pingBytes).catch(() => {
        /* 下游已断：读循环 write 分支会 break */
      });
    } catch {
      /* noop */
    }
  }, pingIntervalMs);

  // ---- 客户端中断级联（Ctrl+C / 停止生成 / 中间层断开） ----
  const clientSignal = options?.request?.signal ?? null;
  const onClientAbort = () => {
    cleanupTimer();
    try {
      void reader.cancel(new Error("Client aborted")).catch(() => {});
    } catch {
      /* noop */
    }
    try {
      void writer.abort(new Error("Client aborted")).catch(() => {});
    } catch {
      /* noop */
    }
  };
  if (clientSignal) {
    if (clientSignal.aborted) onClientAbort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }

  // ---- 透传读循环 ----
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastUpstreamByteAt = Date.now();
        try {
          scanner.push(decoder.decode(value, { stream: true }));
          for (let line = scanner.nextLine(); line !== null; line = scanner.nextLine()) {
            if (line === "") {
              atEventBoundary = true; // 空行 = 事件结束
            } else {
              atEventBoundary = false;
              scanLine(line);
            }
          }
          // 关键：chunk 以半行结尾（无完整行产出，循环体不执行，边界标记停留在旧值）
          // → 残行未闭合期间必须视为非边界，否则 ping 会注入到半行中间截断帧
          if (scanner.bufferedChars > 0) atEventBoundary = false;
        } catch {
          /* 统计失败不影响透传 */
        }
        try {
          await writer.write(value);
        } catch {
          break; // 下游已断（abort 级联或框架关闭）
        }
      }
    } catch {
      /* 上游错误：走 finally 收尾 */
    } finally {
      finished = true;
      cleanupTimer();
      if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
      // 停滞熔断收尾：补协议终帧（客户端拿到干净的流结束，内容为已收到的部分）
      if (stalled) {
        try {
          await writer.write(stallCloseBytes);
        } catch {
          /* noop */
        }
      }
      // 残行扫描（上游意外截断时最后的半行可能有 usage）
      try {
        const remainder = scanner.drainRemainder();
        if (remainder.trim()) scanLine(remainder);
      } catch {
        /* noop */
      }
      report();
      try {
        await writer.close();
      } catch {
        /* noop */
      }
    }
  })();

  return readable;
}

export function streamOpenAIToAnthropic(
  upstreamResponse: Response,
  requestedModel: string,
  clientSignal: AbortSignal | null = null,
  extraHeaders: StreamDebugHeaders = {},
  options: { stallMs?: number; request?: Request | null; onUsage?: (report: StreamUsageReport) => void } = {}
): Response {
  const stallMs =
    Number.isFinite(options?.stallMs) && (options?.stallMs as number) > 0
      ? (options.stallMs as number)
      : UPSTREAM_STALL_MS;
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const requestRef = options.request ?? null;
  const definedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v !== undefined) definedHeaders[k] = v;
  }
  const sse = sseHeaders(definedHeaders) as Record<string, string>;

  (async () => {
    let lastUpstreamByteAt = Date.now();
    let stalled = false;
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let pingInterval: ReturnType<typeof setInterval> = setInterval(async () => {
      // 停滞熔断：上游长时间零字节 → 取消上游读取，读循环以 done 收尾走正常闭环
      //（不 abort writer，否则下游收不到 message_stop）。客户端看到空内容而非无限挂起。
      if (!stalled && Date.now() - lastUpstreamByteAt > stallMs) {
        stalled = true;
        console.warn(
          `[Stream Stall] No upstream bytes for ${stallMs}ms, closing stream for model "${requestedModel}"`
        );
        clearInterval(pingInterval);
        try {
          // v3.8.1：cancel() 返回 Promise，流已关闭时会 reject —— 不接住就是 unhandledRejection
          void upstreamReader?.cancel(new Error("Upstream stalled")).catch(() => {});
        } catch {
          /* noop */
        }
        return;
      }
      try {
        await writer.write(KEEP_ALIVE_BYTES);
      } catch {
        /* noop */
      }
    }, 4000);

    // 监听客户端主动中断取消（Ctrl+C / 停止生成），级联终止上游读取与保活定时器。
    // 上游 reader 必须同步 cancel：否则协程卡在 reader.read()（上游停顿）或 writer.write()
    //（下游已断、背压永不释放），定时器与 IIFE 泄漏到进程结束。
    const abortUpstream = (reason: unknown) => {
      clearInterval(pingInterval);
      try {
        // v3.8.1：cancel()/abort() 均返回 Promise —— 客户端中断时流已被框架 error（ResponseAborted），
        // 此处二次取消的 promise 必然 reject；此前未接住 → dev.log 出现 unhandledRejection（Task 29 QA 发现）
        void upstreamReader?.cancel(reason).catch(() => {});
      } catch {
        /* noop */
      }
      try {
        void writer
          .abort(reason instanceof Error ? reason : new Error("Client aborted"))
          .catch(() => {});
      } catch {
        /* noop */
      }
    };
    if (clientSignal) {
      if (clientSignal.aborted) {
        abortUpstream(clientSignal.reason);
        return;
      }
      clientSignal.addEventListener("abort", () => abortUpstream(clientSignal.reason), {
        once: true,
      });
    }

    // reader 必须在首次 await 之前创建并挂到 upstreamReader：
    // abort 事件只能交错在 await 处，若赋值在 message_start 写之后，abort 恰落进来就 cancel 不到。
    const reader = (upstreamResponse.body as ReadableStream<Uint8Array>).getReader();
    upstreamReader = reader;

    // message_start 在 try 之外：若下游恰在此刻断开，write 直接抛错，
    // 必须就地清理后返回，否则跳过下面的 try/finally 泄漏定时器。
    try {
      await writer.write(
        textEncoder.encode(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: requestedModel || "claude-3-5-sonnet-20241022",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 15, output_tokens: 1 },
            },
          })}\n\n`
        )
      );
    } catch {
      clearInterval(pingInterval);
      return;
    }

    const streamDecoder = new TextDecoder();
    const scanner = new ChunkLineScanner(); // v3.9.3：chunk 数组 + 增量扫描（替代全量拼接/全量 slice）

    let currentBlockIndex = -1;
    let currentBlockType: string | null = null;
    let finalStopReason = "end_turn";
    // 本次响应见到的最大缓存命中 token 数（上游 usage 逐 chunk 到达，取最大记一次）
    let maxCachedTokens = 0;
    // —— 精确 usage 追踪（v3.0.2）：上游 SSE usage 帧优先；未提供时字符估算兑底 ——
    let upstreamInputTokens = 0;
    let upstreamOutputTokens = 0;
    let emittedChars = 0; // text + thinking 累计字符数（估算兑底用）

    const closeCurrentBlock = async () => {
      if (currentBlockType !== null && currentBlockIndex >= 0) {
        await writer.write(
          textEncoder.encode(
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: currentBlockIndex,
            })}\n\n`
          )
        );
        currentBlockType = null;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) lastUpstreamByteAt = Date.now();

        scanner.push(streamDecoder.decode(value, { stream: true }));
        for (let rawLine = scanner.nextLine(); rawLine !== null; rawLine = scanner.nextLine()) {
          const line = rawLine.trim();
          if (!line || !line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (jsonStr === "[DONE]") continue;

          try {
            const parsed: ParsedChunk = JSON.parse(jsonStr);
            const cached = extractCachedTokens(parsed);
            if (cached > maxCachedTokens) maxCachedTokens = cached;

            // usage 帧拦截（须在 delta 判空 continue 之前）：OpenAI stream_options.include_usage
            // 的末尾 chunk 无 choices 但携带精确 usage；部分上游逐 chunk 累进上报，取最大值。
            const upstreamUsage = extractUsageUpstream(parsed);
            if (upstreamUsage) {
              if (upstreamUsage.input > 0) upstreamInputTokens = Math.max(upstreamInputTokens, upstreamUsage.input);
              if (upstreamUsage.output > 0) upstreamOutputTokens = Math.max(upstreamOutputTokens, upstreamUsage.output);
            }

            // 检查上游是否嵌入了业务错误（如 Tencent code !== 0 或 error 字段）
            // 委托纯函数 reducer 判定与提取错误消息，避免此分支逻辑与 reducer 分叉
            const errorEmission = reduceOpenAIChunk(parsed);
            if (errorEmission?.kind === "error") {
              const errMsg = errorEmission.message;
              console.warn(`[Stream Upstream Error] ${errMsg}`);
              if (currentBlockType !== "text") {
                await closeCurrentBlock();
                currentBlockIndex = Math.max(0, currentBlockIndex + 1);
                currentBlockType = "text";
                await writer.write(
                  textEncoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: currentBlockIndex,
                      content_block: { type: "text", text: "" },
                    })}\n\n`
                  )
                );
              }
              await writer.write(
                textEncoder.encode(
                  `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"text_delta","text":${JSON.stringify(
                    `\n[Upstream Notice: ${errMsg}]\n`
                  )}}}\n\n`
                )
              );
              continue;
            }

            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // 思维链 (DeepSeek reasoning_content / OpenCode reasoning)
            const reasoningChunk = delta.reasoning_content || delta.reasoning || "";
            if (reasoningChunk) {
              emittedChars += reasoningChunk.length;
              if (currentBlockType !== "thinking") {
                await closeCurrentBlock();
                currentBlockIndex++;
                currentBlockType = "thinking";
                await writer.write(
                  textEncoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: currentBlockIndex,
                      content_block: { type: "thinking", thinking: "" },
                    })}\n\n`
                  )
                );
              }
              await writer.write(
                textEncoder.encode(
                  `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"thinking_delta","thinking":${JSON.stringify(
                    reasoningChunk
                  )}}}\n\n`
                )
              );
            }

            // 正文内容
            const textChunk = delta.content || "";
            if (textChunk) {
              emittedChars += textChunk.length;
              if (currentBlockType !== "text") {
                await closeCurrentBlock();
                currentBlockIndex++;
                currentBlockType = "text";
                await writer.write(
                  textEncoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: currentBlockIndex,
                      content_block: { type: "text", text: "" },
                    })}\n\n`
                  )
                );
              }
              await writer.write(
                textEncoder.encode(
                  `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"text_delta","text":${JSON.stringify(
                    textChunk
                  )}}}\n\n`
                )
              );
            }

            // 工具调用
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              finalStopReason = "tool_use";
              for (const tc of delta.tool_calls) {
                if (tc.id || tc.function?.name) {
                  await closeCurrentBlock();
                  currentBlockIndex++;
                  currentBlockType = "tool_use";
                  await writer.write(
                    textEncoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: currentBlockIndex,
                        content_block: {
                          type: "tool_use",
                          id: tc.id || "call_" + Math.random().toString(36).substring(2, 9),
                          name: tc.function?.name || "tool",
                          input: {},
                        },
                      })}\n\n`
                    )
                  );
                }
                if (tc.function?.arguments) {
                  await writer.write(
                    textEncoder.encode(
                      `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(
                      tc.function.arguments
                    )}}}\n\n`
                    )
                  );
                }
              }
            }

            if (parsed.choices?.[0]?.finish_reason === "tool_calls") {
              finalStopReason = "tool_use";
            }
          } catch {
            /* JSON parse 失败的行静默跳过（与原版一致） */
          }
        }
        // v3.9.3：残行保留在 scanner 内（已消费 chunk 已移出），无需 slice 拷贝
      }

      // 若流结束时 scanner 尚存非 SSE 格式内容（如上游返回单一 JSON）
      const bufferTail = scanner.drainRemainder();
      if (currentBlockIndex === -1 && bufferTail.trim()) {
        try {
          const parsed: ParsedChunk = JSON.parse(bufferTail.trim());
          const text =
            parsed.choices?.[0]?.message?.content ||
            parsed.choices?.[0]?.delta?.content ||
            parsed.error?.message ||
            parsed.msg ||
            (parsed.code ? `Upstream error ${parsed.code}` : bufferTail.trim());
          if (text) {
            currentBlockIndex = 0;
            currentBlockType = "text";
            await writer.write(
              textEncoder.encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                })}\n\n`
              )
            );
            await writer.write(
              textEncoder.encode(
                `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(
                  text
                )}}}\n\n`
              )
            );
          }
        } catch {
          /* noop */
        }
      }

      // 核心协议保障：若整个流未产生任何 content_block，强制合成 1 个空 text 块闭环，
      // 绝不让 Claude Code 触发 ph.length === 0 的流式回退报警。
      // 停滞熔断触发时带一句明示，避免客户端把「上游卡死」误读成「模型回了空答案」。
      if (currentBlockIndex === -1) {
        currentBlockIndex = 0;
        await writer.write(
          textEncoder.encode(
            `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
          )
        );
        if (stalled) {
          await writer.write(
            textEncoder.encode(
              `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(
                `\n[Gateway Warning: Upstream stalled, no data for ${Math.round(stallMs / 1000)}s]\n`
              )}}}\n\n`
            )
          );
        }
        await writer.write(
          textEncoder.encode(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`)
        );
      } else {
        await closeCurrentBlock();
      }

      await writer.write(
        textEncoder.encode(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: finalStopReason, stop_sequence: null },
            // 精确化（v3.0.2）：上游 usage 帧优先；未提供时字符估算（≈4 字符/token）
            usage: { output_tokens: upstreamOutputTokens > 0 ? upstreamOutputTokens : estimateTokensFromChars(emittedChars) },
          })}\n\n`
        )
      );

      await writer.write(EVENT_MSG_STOP_BYTES);
    } catch (err) {
      // v3.8.1：客户端主动中断（curl | head / 浏览器停止生成）时 writer.write 抛 ResponseAborted，
      // 属正常断连而非上游故障 —— 降级为单行 warn，不再以 error 级别刷屏（QA 误报源）
      const errMsg = (err as Error)?.message || String(err);
      const isClientAbort =
        /ResponseAborted|AbortError|The stream was aborted|signal is aborted/i.test(errMsg) ||
        (err as Error)?.name === "AbortError";
      if (isClientAbort) {
        console.warn(`[Stream] Client disconnected mid-stream for model "${requestedModel}"`);
      } else {
        console.error("[Stream Error]", err);
      }
      // 容灾输出：即使网络或上游异常断流，也输出结构化友好提示并优雅闭环，不直接 crash 客户端
      try {
        if (currentBlockType !== "text") {
          await closeCurrentBlock();
          currentBlockIndex = Math.max(0, currentBlockIndex + 1);
          currentBlockType = "text";
          await writer.write(
            textEncoder.encode(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: currentBlockIndex,
                content_block: { type: "text", text: "" },
              })}\n\n`
            )
          );
        }
        await writer.write(
          textEncoder.encode(
            `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"text_delta","text":${JSON.stringify(
              `\n[Gateway Warning: Upstream stream interrupted (${(err as Error)?.message || "EOF"})]\n`
            )}}}\n\n`
          )
        );
        await closeCurrentBlock();
        await writer.write(
          textEncoder.encode(
            `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n`
          )
        );
        await writer.write(EVENT_MSG_STOP_BYTES);
      } catch {
        /* noop */
      }
    } finally {
      clearInterval(pingInterval);
      // 无论正常收尾还是异常断流都记一次：命中率 = cachedResponses / responses
      try {
        recordUpstreamCache(maxCachedTokens);
      } catch {
        /* noop */
      }
      // 精确 usage 回调（dispatch 据此落库请求日志；上游未提供时为估算值）
      try {
        options.onUsage?.({
          inputTokens: upstreamInputTokens,
          outputTokens:
            upstreamOutputTokens > 0 ? upstreamOutputTokens : estimateTokensFromChars(emittedChars),
          cachedTokens: maxCachedTokens,
          upstreamExact: upstreamOutputTokens > 0 || upstreamInputTokens > 0,
          source:
            upstreamOutputTokens > 0 || upstreamInputTokens > 0 ? "upstreamUsageFrame" : "estimated",
        });
      } catch {
        /* noop */
      }
      try {
        await writer.close();
      } catch {
        /* noop */
      }
    }
  })().catch((err) => {
    try {
      // v3.8.1：IIFE 兑底 abort 同样接住 promise 拒绝（流已关闭时 abort 必 reject）
      void writer.abort(err).catch(() => {});
    } catch {
      /* noop */
    }
  });

  return new Response(readable, {
    status: 200,
    headers: sse,
  });
}

// 内部非流式转译：OpenAI -> Anthropic JSON (优化：增量流式读取，零全量内存拷贝)
// 导出给 dispatch 的非流式路径使用（对外仍经 exchange 门面）。
export async function formatOpenAIToAnthropicJson(
  upstreamResponse: Response,
  requestedModel: string,
  extraHeaders: StreamDebugHeaders = {},
  request: Request | null = null,
  onUsage?: (report: StreamUsageReport) => void
): Promise<Response> {
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const reader = (upstreamResponse.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let accumulatedThinking = "";
  let accumulatedToolCalls: Array<{ id: string | null; name: string; args: string }> = [];
  const scanner = new ChunkLineScanner(); // v3.9.3：chunk 数组 + 增量扫描（替代全量拼接/全量 slice）
  let inputTokens = 20;
  let outputTokens = 1;
  let usageFromUpstream = false; // v3.0.2：上游是否提供了精确 usage（决定是否估算兑底）
  let accumulatedFinishReason: string | null = null;
  let maxCachedTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      scanner.push(decoder.decode(value, { stream: true }));
      for (let rawLine = scanner.nextLine(); rawLine !== null; rawLine = scanner.nextLine()) {
        const line = rawLine.trim();
        if (!line || !line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (jsonStr === "[DONE]") continue;
        try {
          const parsed: ParsedChunk = JSON.parse(jsonStr);
          if (isUpstreamError(parsed)) {
            const errMsg = extractErrorMessage(parsed) || "Unknown error";
            accumulated += `\n[Upstream Notice: ${errMsg}]\n`;
            continue;
          }
          const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || parsed.choices?.[0]?.delta?.reasoning;
          if (reasoning) accumulatedThinking += reasoning;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) accumulated += delta;
          const usage = extractUsage(parsed, { input: inputTokens, output: outputTokens });
          if (usage.input !== inputTokens || usage.output !== outputTokens) usageFromUpstream = true;
          inputTokens = usage.input;
          outputTokens = usage.output;
          const cached = extractCachedTokens(parsed);
          if (cached > maxCachedTokens) maxCachedTokens = cached;
        } catch {
          /* noop */
        }
      }
      // v3.9.3：残行保留在 scanner 内（已消费 chunk 已移出），无需 slice 拷贝
    }

    const bufferTail = scanner.drainRemainder();
    if (!accumulated && bufferTail.trim()) {
      try {
        const parsed: ParsedChunk = JSON.parse(bufferTail.trim());
        const message = parsed.choices?.[0]?.message;
        const reasoning =
          message?.reasoning_content ||
          message?.reasoning ||
          parsed.choices?.[0]?.delta?.reasoning_content ||
          parsed.choices?.[0]?.delta?.reasoning;
        if (reasoning) accumulatedThinking = reasoning;
        if (message && message.content !== undefined && message.content !== null) {
          accumulated = message.content;
        } else if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
          // 纯工具调用响应（content 为 null）：正文为空，
          // 不把原始响应 JSON 当文本兜底（否则客户端会把 JSON 包当作正文显示）
          accumulated = "";
        } else if (parsed.choices?.[0]?.delta?.content) {
          accumulated = parsed.choices[0].delta.content;
        } else {
          accumulated = extractErrorMessage(parsed) || (accumulatedThinking ? "" : bufferTail.trim());
        }
        // 提取非流式响应中的工具调用（直接存归一化形态，避免二次嵌套 OpenAI 包裹层）
        if (Array.isArray(message?.tool_calls)) {
          for (const tc of message.tool_calls) {
            accumulatedToolCalls.push({
              id: tc.id || null,
              name: tc.function?.name || "tool",
              args: tc.function?.arguments ?? "{}",
            });
          }
        }
        const usage = extractUsage(parsed, { input: inputTokens, output: outputTokens });
        if (usage.input !== inputTokens || usage.output !== outputTokens) usageFromUpstream = true;
        inputTokens = usage.input;
        outputTokens = usage.output;
        const cachedTail = extractCachedTokens(parsed);
        if (cachedTail > maxCachedTokens) maxCachedTokens = cachedTail;
        // 保存 finish_reason 用于正确映射 Anthropic stop_reason
        if (parsed.choices?.[0]) {
          accumulatedFinishReason = parsed.choices[0].finish_reason ?? null;
        }
      } catch {
        accumulated = bufferTail.trim();
      }
    }
  } finally {
    reader.releaseLock();
  }

  accumulated = accumulated || " ";
  // v3.0.2 修复：仅当上游未提供精确 usage 时才用字符估算；
  // 原实现 Math.max 会用估算值覆盖上游精确值（如上游报 10 而字符估算 50 → 错记 50）
  if (!usageFromUpstream) {
    outputTokens = Math.max(
      outputTokens,
      estimateTokensFromChars(accumulated.length + accumulatedThinking.length)
    );
  }
  try {
    onUsage?.({
      inputTokens: usageFromUpstream ? inputTokens : 0,
      outputTokens,
      cachedTokens: maxCachedTokens,
      upstreamExact: usageFromUpstream,
      source: usageFromUpstream ? "upstreamUsageFrame" : "estimated",
    });
  } catch {
    /* noop */
  }

  const content: Array<Record<string, unknown>> = [];
  if (accumulatedThinking) {
    content.push({ type: "thinking", thinking: accumulatedThinking });
  }

  // 工具调用：映射 OpenAI tool_calls 到 Anthropic tool_use content blocks
  // Anthropic tool_use.input 必须是 object；OpenAI arguments 是 JSON 字符串，需解析
  if (Array.isArray(accumulatedToolCalls) && accumulatedToolCalls.length > 0) {
    for (const tc of accumulatedToolCalls) {
      let toolInput: Record<string, unknown> = {};
      const rawArgs = tc.args;
      if (rawArgs && typeof rawArgs === "object") {
        toolInput = rawArgs as Record<string, unknown>;
      } else if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
          toolInput = JSON.parse(rawArgs);
        } catch {
          toolInput = {};
        }
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name || "tool",
        input: toolInput,
      });
    }
  }

  content.push({ type: "text", text: accumulated });

  try {
    recordUpstreamCache(maxCachedTokens);
  } catch {
    /* noop */
  }

  return new Response(
    JSON.stringify({
      id: msgId,
      type: "message",
      role: "assistant",
      content: content,
      model: requestedModel || "claude-3-5-haiku-20241022",
      stop_reason: finishReasonToAnthropic(accumulatedFinishReason),
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeadersFor(request),
        ...extraHeaders,
      },
    }
  );
}

// v3.2.1：非流式聚合 —— forceStream 提供商（workbuddy/qwenweb）对 stream:false 请求也返回 SSE，
// 旧逻辑原样透传导致标准 OpenAI 客户端（openai-python / openai-node / CC-Switch 非流式模式）
// 解析失败。本函数把上游 OpenAI 形 SSE 帧聚合成一份标准 chat.completion JSON：
//   - content / reasoning_content 全量拼接
//   - tool_calls 按 delta.index 增量拼接（id/name 首帧登记，arguments 跨帧追加）
//   - finish_reason 取末帧；usage 上游精确优先（stream_options.include_usage 尾帧兼容）
//   - 上游直接返回 JSON（理论不发生，防御兜底）：直接解析 message 字段
export async function aggregateOpenAIToChatJson(
  upstreamResponse: Response,
  requestedModel: string,
  extraHeaders: StreamDebugHeaders = {},
  request: Request | null = null,
  onUsage?: (report: StreamUsageReport) => void,
  options: { stallMs?: number } = {}
): Promise<Response> {
  const completionId = "chatcmpl-" + Math.random().toString(36).substring(2, 15);
  const created = Math.floor(Date.now() / 1000);
  const reader = (upstreamResponse.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  // v4.2.0（R6）：SSE→JSON 聚合路径的停滞熔断 —— 此前挂死会一直等到 undici bodyTimeout；
  // 现在：上游零字节超阈值 → cancel 上游 → 用已聚合内容拼装 JSON 响应（附警告注记）
  const stallMs =
    Number.isFinite(options?.stallMs) && (options?.stallMs as number) > 0
      ? (options.stallMs as number)
      : 0;
  let stalled = false;
  let lastUpstreamByteAt = Date.now();
  /** 带停滞看门狗的 read：每 1s 轮询一次字节间隔；停滞 → cancel 上游并以 done 收尾 */
  const readWithStallWatchdog = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let pending = reader.read();
    for (;;) {
      const winner = await Promise.race([
        pending,
        new Promise<"tick">((resolve) => {
          const t = setTimeout(() => resolve("tick"), 1000);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (winner !== "tick") return winner as ReadableStreamReadResult<Uint8Array>;
      if (Date.now() - lastUpstreamByteAt > (stallMs as number)) {
        stalled = true;
        console.warn(`[Aggregate Stall] No upstream bytes for ${stallMs}ms, aggregating partial SSE to JSON for model "${requestedModel}"`);
        try {
          void reader.cancel(new Error("Upstream stalled")).catch(() => {});
        } catch {
          /* noop */
        }
        // cancel 后 pending read 以 done/错误收尾（不等会泄漏未决 promise；releaseLock 也会拒绝）
        try {
          return (await pending) as ReadableStreamReadResult<Uint8Array>;
        } catch {
          return { done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>;
        }
      }
    }
  };

  let accumulated = "";
  let accumulatedThinking = "";
  let accumulatedFinishReason: string | null = null;
  let inputTokens = 20;
  let outputTokens = 1;
  let usageFromUpstream = false;
  let maxCachedTokens = 0;
  // 工具调用按 index 增量拼接（OpenAI 流式形态：首帧带 id/name，后续帧只带 arguments 片段）
  const toolCalls = new Map<number, { id: string | null; name: string; args: string }>();
  let sawSseFrame = false; // 是否解析到过任何 data: 帧（区分 SSE 与意外 JSON/纯文本响应）
  let upstreamNotice: string | null = null; // SSE 帧内业务错误摘要（有真实内容时降级为正文注记）

  const absorbToolDelta = (tcs: NonNullable<NonNullable<ParsedChunk["choices"]>[number]["delta"]>["tool_calls"]) => {
    if (!Array.isArray(tcs)) return;
    for (const tc of tcs) {
      const idx = (tc as { index?: number }).index ?? 0;
      const cur = toolCalls.get(idx) ?? { id: null, name: "tool", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      toolCalls.set(idx, cur);
    }
  };

  const absorbParsed = (parsed: ParsedChunk) => {
    if (isUpstreamError(parsed)) {
      const errMsg = extractErrorMessage(parsed) || "Unknown error";
      // 有正文时注记到正文；无正文时作为错误摘要返回（空响应比报错更让调用方困惑）
      if (accumulated) accumulated += `\n[Upstream Notice: ${errMsg}]\n`;
      else upstreamNotice = upstreamNotice ? `${upstreamNotice}; ${errMsg}` : errMsg;
      return;
    }
    const choice = parsed.choices?.[0];
    const reasoning = choice?.delta?.reasoning_content || choice?.delta?.reasoning ||
      (choice?.message as { reasoning_content?: string; reasoning?: string } | undefined)?.reasoning_content ||
      (choice?.message as { reasoning_content?: string; reasoning?: string } | undefined)?.reasoning;
    if (reasoning) accumulatedThinking += reasoning;
    const deltaContent = choice?.delta?.content ?? choice?.message?.content;
    if (deltaContent) accumulated += deltaContent;
    if (choice?.delta?.tool_calls) absorbToolDelta(choice.delta.tool_calls);
    if (Array.isArray(choice?.message?.tool_calls)) {
      // 非 SSE JSON 兜底路径：直接是完整 tool_calls（归一化进 Map）
      for (const tc of choice.message.tool_calls) {
        const idx = toolCalls.size;
        toolCalls.set(idx, { id: tc.id || null, name: tc.function?.name || "tool", args: tc.function?.arguments ?? "{}" });
      }
    }
    if (choice?.finish_reason) accumulatedFinishReason = choice.finish_reason;
    const usage = extractUsage(parsed, { input: inputTokens, output: outputTokens });
    if (usage.input !== inputTokens || usage.output !== outputTokens) usageFromUpstream = true;
    inputTokens = usage.input;
    outputTokens = usage.output;
    const cached = extractCachedTokens(parsed);
    if (cached > maxCachedTokens) maxCachedTokens = cached;
  };

  try {
    while (true) {
      const { done, value } = stallMs > 0 ? await readWithStallWatchdog() : await reader.read();
      if (done) break;
      lastUpstreamByteAt = Date.now();
      const text = decoder.decode(value, { stream: true });
      // 逐行扫 data: 帧（与 formatOpenAIToAnthropicJson 同款解析口径）
      let lineStart = 0;
      let lineEnd;
      while ((lineEnd = text.indexOf("\n", lineStart)) !== -1) {
        const line = text.slice(lineStart, lineEnd).trim();
        lineStart = lineEnd + 1;
        if (!line || !line.startsWith("data:")) continue;
        sawSseFrame = true;
        const jsonStr = line.slice(5).trim();
        if (jsonStr === "[DONE]") continue;
        try {
          absorbParsed(JSON.parse(jsonStr) as ParsedChunk);
        } catch {
          /* 单帧坏 JSON 跳过 */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // 防御兜底：上游没给任何 data: 帧（意外返回 JSON/纯文本）→ 整体解析
  if (!sawSseFrame) {
    const raw = decoder.decode();
    const trimmed = raw.trim();
    if (trimmed) {
      try {
        absorbParsed(JSON.parse(trimmed) as ParsedChunk);
      } catch {
        accumulated = accumulated || trimmed; // 纯文本兜底
      }
    }
  }

  // v4.2.0：停滞熔断时在正文附警告注记（与转译分支 [Gateway Warning: ...] 口径一致）
  if (stalled) {
    const warn = `[Gateway Warning: Upstream stalled, no data for ${Math.round((stallMs as number) / 1000)}s, response may be truncated]`;
    accumulated = accumulated ? `${accumulated}\n${warn}` : warn;
  }

  const finalContent = accumulated || upstreamNotice || " ";
  // v3.0.2 口径：仅当上游未提供精确 usage 时才按字符估算
  if (!usageFromUpstream) {
    outputTokens = Math.max(outputTokens, estimateTokensFromChars(finalContent.length + accumulatedThinking.length));
  }
  try {
    onUsage?.({
      inputTokens: usageFromUpstream ? inputTokens : 0,
      outputTokens,
      cachedTokens: maxCachedTokens,
      upstreamExact: usageFromUpstream,
      source: usageFromUpstream ? "upstreamUsageFrame" : "estimated",
    });
  } catch {
    /* noop */
  }
  try {
    recordUpstreamCache(maxCachedTokens);
  } catch {
    /* noop */
  }

  // 组装标准 OpenAI chat.completion 响应
  const message: Record<string, unknown> = { role: "assistant", content: finalContent };
  if (accumulatedThinking) message.reasoning_content = accumulatedThinking;
  if (toolCalls.size > 0) {
    message.tool_calls = Array.from(toolCalls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({
        id: tc.id ?? `call_${Math.random().toString(36).substring(2, 10)}`,
        type: "function",
        function: { name: tc.name, arguments: tc.args || "{}" },
      }));
    if (!finalContent || finalContent === " ") message.content = finalContent === " " ? null : finalContent;
  }

  return new Response(
    JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: accumulatedFinishReason ?? (toolCalls.size > 0 ? "tool_calls" : "stop"),
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        ...(maxCachedTokens > 0
          ? { prompt_tokens_details: { cached_tokens: maxCachedTokens } }
          : {}),
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeadersFor(request),
        ...extraHeaders,
      },
    }
  );
}
