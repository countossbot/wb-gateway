// Responses 响应侧回译 —— Chat Completions（JSON / SSE）→ OpenAI Responses 协议。
// 纯转译 + 流式重排版；请求侧转译见 ./translate.ts，路由编排见 app/v1/responses/route.ts。
//
// 非流式：chat.completion JSON → Responses response 对象（合法完整形态）。
//
// 流式（v4.6.1 严格 Responses SSE 生命周期契约）：
//   Responses 流绝不允许以「连接 EOF」作为成功结束 —— 任何结束路径必须先发协议终点事件
//   再关闭 SSE（否则 OpenAI SDK / Codex 判定 "stream closed before response.completed"）：
//     - 上游正常 EOF（含 [DONE] 与停滞熔断合成 [DONE]）→ response.completed
//     - finish_reason=length / content_filter → response.incomplete（incomplete_details 回明原因）
//     - 上游读取异常 / passthrough 层上游错误标记（": uag-upstream-error" 注释行）→ response.failed
//     - SSE data 帧携带 error 对象（部分兼容上游的流内错误回传）→ response.failed
//     - 客户端断连（request.signal abort / 下游 cancel）→ 不发终点（对端已不可达），仅记日志
//   每个事件携带单调递增 sequence_number（起点 0，SSE 注释行不占号）；
//   每条流结束时记录完整性日志：response_id / terminal / last_event / seq / events / bytes /
//   upstream_error / client_aborted / finish_frame / duration_ms —— Codex 报流断开时可据此
//   直接区分「网关没发终点」「发完被中间层吃掉」还是「客户端自身断开」。
//   事件序列：response.created → response.in_progress → output_item.added → content_part.added →
//   output_text.delta* → output_text.done → content_part.done → output_item.done →
//   response.completed（工具调用项在流尾以完整 item 形态 added → done 背靠背输出）。

import { sseHeaders } from "../http/headers";

const encoder = new TextEncoder();

export interface ResponseEchoContext {
  /** 网关侧生成的 response id（resp_ 前缀） */
  requestId: string;
  /** 客户端请求的模型名（路由名，回显） */
  model: string;
  /** 请求 echo 字段（仅回显客户端显式提供的字段） */
  echo: {
    instructions?: string;
    tools?: unknown;
    tool_choice?: unknown;
    temperature?: number;
    top_p?: number;
    max_output_tokens?: number;
    parallel_tool_calls?: boolean;
    reasoning?: unknown;
  };
  /** 请求声明的 custom(freeform) 工具名集合 —— tool_call 名命中时回译为 custom_tool_call 项 */
  customToolNames: Set<string>;
  /** 请求声明的 function 工具名集合 —— 用于区分合成 shell 调用 */
  functionToolNames: Set<string>;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface ChatChoiceMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

function randSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Responses usage 对象（token 字段名与 chat 不同：input_tokens / output_tokens / total_tokens） */
function mapUsage(usage: ChatUsage | undefined): Record<string, unknown> {
  const input = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const output = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
  const total = typeof usage?.total_tokens === "number" ? usage.total_tokens : input + output;
  const cached = typeof usage?.prompt_tokens_details?.cached_tokens === "number" ? usage.prompt_tokens_details.cached_tokens : 0;
  const reasoningTokens =
    typeof usage?.completion_tokens_details?.reasoning_tokens === "number" ? usage.completion_tokens_details.reasoning_tokens : 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: total,
  };
}

/** 把 chat tool_call 回译为 Responses output item（function_call / custom_tool_call / local_shell_call） */
function toolCallToResponsesItem(
  tc: NonNullable<ChatChoiceMessage["tool_calls"]>[number],
  ctx: ResponseEchoContext
): Record<string, unknown> {
  const callId = typeof tc.id === "string" && tc.id ? tc.id : `call_${randSuffix()}`;
  const name = typeof tc.function?.name === "string" && tc.function.name ? tc.function.name : "tool";
  const args = typeof tc.function?.arguments === "string" ? tc.function.arguments : "{}";

  if (ctx.customToolNames.has(name)) {
    // custom(freeform) 工具调用 → custom_tool_call（input 从 {"input": <文本>} 参数解包）
    let inputText = "";
    try {
      const parsed = JSON.parse(args) as { input?: unknown };
      inputText = typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input ?? "");
    } catch {
      inputText = args; // 参数非 JSON：原文保底
    }
    return {
      type: "custom_tool_call",
      id: `ct_${randSuffix()}`,
      call_id: callId,
      name,
      input: inputText,
      status: "completed",
    };
  }

  if (name === "shell" && !ctx.functionToolNames.has("shell")) {
    // 历史中的合成 shell 调用（local_shell 转译产物）被模型回放 → local_shell_call 项
    let command: string[] = [];
    try {
      const parsed = JSON.parse(args) as { command?: unknown };
      if (Array.isArray(parsed.command)) command = parsed.command.map((c) => String(c));
    } catch {
      /* 保底空 command */
    }
    return {
      type: "local_shell_call",
      id: `ls_${randSuffix()}`,
      call_id: callId,
      action: { type: "exec", command },
      status: "completed",
    };
  }

  return {
    type: "function_call",
    id: `fc_${randSuffix()}`,
    call_id: callId,
    name,
    arguments: args,
    status: "completed",
  };
}

/** chat assistant 消息（含 tool_calls / reasoning_content）→ Responses output items 数组 */
function messageToOutputItems(message: ChatChoiceMessage | undefined, ctx: ResponseEchoContext): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (!message) return items;

  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    items.push({
      type: "reasoning",
      id: `rs_${randSuffix()}`,
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }

  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const text = typeof message.content === "string" ? message.content : "";

  if (text.length > 0 || !hasToolCalls) {
    // 有正文，或既无正文也无工具调用（空回包仍需合法 message 项）
    items.push({
      type: "message",
      id: `msg_${randSuffix()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  if (hasToolCalls) {
    for (const tc of message.tool_calls as NonNullable<ChatChoiceMessage["tool_calls"]>) {
      items.push(toolCallToResponsesItem(tc, ctx));
    }
  }
  return items;
}

/** 响应对象骨架（echo 字段仅回显客户端显式提供的） */
function responsesSkeleton(ctx: ResponseEchoContext, status: string): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: ctx.requestId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: ctx.echo.instructions ?? null,
    metadata: {},
    model: ctx.model,
    output: [],
    previous_response_id: null,
    store: false,
    temperature: ctx.echo.temperature ?? 1,
    top_p: ctx.echo.top_p ?? 1,
    truncation: "none",
    usage: null,
  };
  if (ctx.echo.tools !== undefined) response.tools = ctx.echo.tools;
  if (ctx.echo.tool_choice !== undefined) response.tool_choice = ctx.echo.tool_choice;
  if (ctx.echo.max_output_tokens !== undefined) response.max_output_tokens = ctx.echo.max_output_tokens;
  if (ctx.echo.parallel_tool_calls !== undefined) response.parallel_tool_calls = ctx.echo.parallel_tool_calls;
  if (ctx.echo.reasoning !== undefined) response.reasoning = ctx.echo.reasoning;
  return response;
}

/** output 数组的 output_text 便捷拼接（SDK 侧同款语义；额外字段对严格客户端无影响） */
function joinOutputText(output: Array<Record<string, unknown>>): string {
  const texts: string[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    const content = item.content as Array<{ type?: string; text?: string }> | undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.join("");
}

/** finish_reason → Responses incomplete_details 原因（null = 正常完成） */
function incompleteReasonFromFinish(finishReason: string | null): "max_output_tokens" | "content_filter" | null {
  if (finishReason === "length") return "max_output_tokens";
  if (finishReason === "content_filter") return "content_filter";
  return null;
}

/**
 * 非流式：chat.completion JSON → Responses response 对象。
 * 解析失败（上游返回非 JSON）抛 Error（路由层 502 兜底）。
 * finish_reason=length / content_filter → status incomplete（incomplete_details 回明原因）。
 */
export function chatCompletionToResponsesResponse(
  chatJson: Record<string, unknown>,
  ctx: ResponseEchoContext
): Record<string, unknown> {
  const choices = Array.isArray(chatJson.choices) ? (chatJson.choices as Array<Record<string, unknown>>) : [];
  const choice = choices.length > 0 ? (choices[0] as { message?: ChatChoiceMessage; finish_reason?: string }) : {};
  const message = choice.message;
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";

  const output = messageToOutputItems(message, ctx);
  const usage = mapUsage(chatJson.usage as ChatUsage | undefined);

  const incompleteReason = incompleteReasonFromFinish(finishReason);
  const status = incompleteReason ? "incomplete" : "completed";
  const response = responsesSkeleton(ctx, status);
  if (incompleteReason) {
    response.incomplete_details = { reason: incompleteReason };
  }
  response.output = output;
  response.usage = usage;
  response.output_text = joinOutputText(output);
  return response;
}

// ---- 流式：chat SSE → Responses SSE ----

interface StreamToolCallAccumulator {
  chatId: string;
  name: string;
  arguments: string;
  outputIndex?: number; // Responses 流内 output_index（首片段 added 时分配）
  item?: Record<string, unknown>; // added 事件里已发出的 item（done 时复用同一 id/name）
}

/** SSE 计量发射器：统一 sequence_number 分配 + 流完整性计量（events / bytes / last_event） */
interface SseMeter {
  event(eventType: string, payload: Record<string, unknown>): void;
  comment(text: string): void;
  readonly sequenceNumber: number;
  readonly eventsEmitted: number;
  readonly bytesWritten: number;
  readonly lastEvent: string | null;
}

function createSseMeter(sink: (bytes: Uint8Array) => void): SseMeter {
  let seq = 0;
  let events = 0;
  let bytes = 0;
  let last: string | null = null;
  return {
    event(eventType, payload) {
      const frame = encoder.encode(
        `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, sequence_number: seq, ...payload })}\n\n`
      );
      seq++;
      events++;
      bytes += frame.byteLength;
      last = eventType;
      sink(frame);
    },
    comment(text) {
      // SSE 注释行（keep-alive / ping）：合法注释，所有合规解析器忽略，不占事件序号
      const frame = encoder.encode(`: ${text}\n\n`);
      bytes += frame.byteLength;
      sink(frame);
    },
    get sequenceNumber() {
      return seq;
    },
    get eventsEmitted() {
      return events;
    },
    get bytesWritten() {
      return bytes;
    },
    get lastEvent() {
      return last;
    },
  };
}

interface TranslateStreamOptions {
  /** 客户端断连信号（透传取消上游读取） */
  signal: AbortSignal | null;
  /** 客户端空闲保活间隔（毫秒；0 = 关闭） */
  pingIntervalMs?: number;
}

/** passthrough 层注入的上游错误标记注释行前缀（见 exchange/stream.ts） */
const UPSTREAM_ERROR_MARKER = "uag-upstream-error";

/**
 * 流式回译：消费 chat SSE（含网关注入的 ": keep-alive" 注释行），产出 Responses SSE 事件流。
 * 严格生命周期：任何结束路径先发终点事件（completed / incomplete / failed）再关流 —— 详见模块头注释。
 */
export function chatSseToResponsesStream(
  body: ReadableStream<Uint8Array>,
  ctx: ResponseEchoContext,
  options: TranslateStreamOptions
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const startedAt = Date.now();

  // ---- 共享流状态（start 读取循环 / cancel 回调 / abort 监听三路共用） ----
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let abortListener: (() => void) | null = null;
  let ended = false; // 任一路径已收尾（幂等护栏）
  let clientAborted = false;
  let upstreamError: string | null = null;
  let finishReason: string | null = null;
  let sawFinishFrame = false;
  let logged = false;

  // 流内累积状态机
  let nextOutputIndex = 0; // 动态 output_index 分配器：reasoning/message/tool 按实际出现顺序编号
  let reasoningItemOpen = false; // 思维链 reasoning 项已 added（delta.reasoning_content → 标准 reasoning item）
  let reasoningItemId = `rs_${randSuffix()}`;
  let reasoningOutputIndex = -1;
  let reasoningText = "";
  let reasoningPartAdded = false;
  let messageItemOpen = false; // 正文 message 项已 added
  let messageOutputIndex = -1; // 正文项的 output_index（reasoning 先出现时不再是 0）
  let messageItemId = `msg_${randSuffix()}`;
  let fullText = "";
  const toolAccumulators = new Map<number, StreamToolCallAccumulator>();
  const toolOrder: number[] = [];
  let textDoneEmitted = false;
  let usage: Record<string, unknown> | null = null; // 上游 usage 帧（finalize 时映射）

  const meter = createSseMeter((bytes) => {
    try {
      controllerRef?.enqueue(bytes);
    } catch {
      /* 下游已关闭：读循环 break / ended 兜底 */
    }
  });
  const emitEvent = (eventType: string, payload: Record<string, unknown>): void => {
    meter.event(eventType, payload);
  };

  // ---- 终点事件 ----
  /** terminal 状态：null = 尚未发出任何终点（幂等护栏兼观测字段） */
  let terminal: "response.completed" | "response.incomplete" | "response.failed" | null = null;

  const openMessageItem = (): void => {
    if (messageItemOpen) return;
    messageItemOpen = true;
    messageOutputIndex = nextOutputIndex++;
    emitEvent("response.output_item.added", {
      output_index: messageOutputIndex,
      item: {
        type: "message",
        id: messageItemId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    emitEvent("response.content_part.added", {
      item_id: messageItemId,
      output_index: messageOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  /** 思维链增量 → 标准 Responses reasoning item（added → summary_text.delta → done） */
  const openReasoningItem = (): void => {
    if (reasoningItemOpen) return;
    reasoningItemOpen = true;
    reasoningOutputIndex = nextOutputIndex++;
    emitEvent("response.output_item.added", {
      output_index: reasoningOutputIndex,
      item: { type: "reasoning", id: reasoningItemId, summary: [], content: [] },
    });
  };
  const ensureReasoningPart = (): void => {
    if (!reasoningItemOpen || reasoningPartAdded) return;
    reasoningPartAdded = true;
    emitEvent("response.reasoning_summary_part.added", {
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
  };
  const closeReasoningItem = (): void => {
    if (!reasoningItemOpen) return;
    reasoningItemOpen = false;
    if (reasoningPartAdded) {
      emitEvent("response.reasoning_summary_text.done", {
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        text: reasoningText,
      });
      emitEvent("response.reasoning_summary_part.done", {
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: reasoningText },
      });
    }
    emitEvent("response.output_item.done", {
      output_index: reasoningOutputIndex,
      item: {
        type: "reasoning",
        id: reasoningItemId,
        summary: reasoningPartAdded ? [{ type: "summary_text", text: reasoningText }] : [],
        content: [],
      },
    });
  };
  const closeMessageItem = (): void => {
    if (!messageItemOpen || textDoneEmitted) return;
    textDoneEmitted = true;
    emitEvent("response.output_text.done", {
      item_id: messageItemId,
      output_index: messageOutputIndex,
      content_index: 0,
      text: fullText,
    });
    emitEvent("response.content_part.done", {
      item_id: messageItemId,
      output_index: messageOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: fullText, annotations: [] },
    });
    emitEvent("response.output_item.done", {
      output_index: messageOutputIndex,
      item: {
        type: "message",
        id: messageItemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fullText, annotations: [] }],
      },
    });
  };

  /** 成功终点：completed（length / content_filter → incomplete），含流尾工具项与完整 response 对象 */
  const finalizeSuccess = (): void => {
    if (ended || terminal !== null) return;
    closeMessageItem();
    closeReasoningItem();
    // 工具调用项：added 已在首片段到达时发出，这里补 args.done + item.done（标准增量事件序列）
    for (const idx of toolOrder) {
      const acc = toolAccumulators.get(idx)!;
      const args = acc.arguments || "{}";
      const item = acc.item ?? toolCallToResponsesItem(
        { id: acc.chatId, type: "function", function: { name: acc.name || "tool", arguments: args } },
        ctx
      );
      emitEvent("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: acc.outputIndex,
        arguments: args,
      });
      emitEvent("response.output_item.done", {
        output_index: acc.outputIndex,
        item: { ...item, function: { ...(item as any).function, arguments: args }, status: "completed" },
      });
    }
    const incompleteReason = incompleteReasonFromFinish(finishReason);
    const output: Array<Record<string, unknown>> = [];
    if (reasoningText || reasoningPartAdded) {
      output.push({
        type: "reasoning",
        id: reasoningItemId,
        summary: reasoningPartAdded ? [{ type: "summary_text", text: reasoningText }] : [],
        content: [],
      });
    }
    if (messageItemOpen) {
      output.push({
        type: "message",
        id: messageItemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fullText, annotations: [] }],
      });
    }
    for (const idx of toolOrder) {
      const acc = toolAccumulators.get(idx)!;
      const args = acc.arguments || "{}";
      const item = acc.item ?? toolCallToResponsesItem(
        { id: acc.chatId, type: "function", function: { name: acc.name || "tool", arguments: args } },
        ctx
      );
      output.push({ ...item, function: { ...(item as any).function, arguments: args }, status: "completed" });
    }
    const response = responsesSkeleton(ctx, incompleteReason ? "incomplete" : "completed");
    if (incompleteReason) response.incomplete_details = { reason: incompleteReason };
    response.output = output;
    response.usage = usage ?? mapUsage(undefined);
    response.output_text = joinOutputText(output);
    terminal = incompleteReason ? "response.incomplete" : "response.completed";
    emitEvent(terminal, { response });
  };

  /** 失败终点：response.failed（部分文本安全保留；半成品工具调用不输出 —— arguments 可能残缺） */
  const finalizeFailed = (message: string, code = "upstream_error"): void => {
    if (ended || terminal !== null) return;
    upstreamError = message;
    closeMessageItem(); // 文本项生命周期闭合（已发出的 delta 序列有始有终）
    closeReasoningItem();
    const response = responsesSkeleton(ctx, "failed");
    response.error = { code, message };
    const output: Array<Record<string, unknown>> = [];
    if (reasoningText || reasoningPartAdded) {
      output.push({
        type: "reasoning",
        id: reasoningItemId,
        summary: reasoningPartAdded ? [{ type: "summary_text", text: reasoningText }] : [],
        content: [],
      });
    }
    if (messageItemOpen) {
      output.push({
        type: "message",
        id: messageItemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fullText, annotations: [] }],
      });
    }
    response.output = output;
    response.usage = usage ?? mapUsage(undefined);
    terminal = "response.failed";
    emitEvent("response.failed", { response });
  };

  /** 流完整性日志（每流一条；异常路径 warn，正常路径 info）—— Codex 报流断开时的第一诊断入口 */
  const logIntegrity = (): void => {
    if (logged) return;
    logged = true;
    const line =
      `[Responses] stream end: response_id=${ctx.requestId} terminal=${terminal ?? "none"} ` +
      `last_event=${meter.lastEvent ?? "none"} seq=${meter.sequenceNumber} events=${meter.eventsEmitted} ` +
      `bytes=${meter.bytesWritten} upstream_error=${upstreamError ?? "nil"} client_aborted=${clientAborted} ` +
      `finish_frame=${sawFinishFrame} duration_ms=${Date.now() - startedAt}`;
    if (terminal === null || terminal === "response.failed") console.warn(line);
    else console.log(line);
  };

  const stopPing = (): void => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  /** 幂等收尾：停 ping → 拆上游读取 → 记日志 → 关下游（终点事件必须在此前已发出） */
  const endStream = (): void => {
    if (ended) return;
    ended = true;
    stopPing();
    // 断连监听需显式摘除：signal 的生命周期长于本流（HTTP keep-alive 连接复用同一
    // signal），不移除会随请求数线性累积闭包（controller/reader 无法回收）。
    if (abortListener && options.signal) {
      options.signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }
    if (reader) {
      try {
        void reader.cancel(new Error("Responses stream ended")).catch(() => {});
      } catch {
        /* 已释放 */
      }
    }
    logIntegrity();
    try {
      controllerRef?.close();
    } catch {
      /* 已关闭 */
    }
  };

  /** 立即失败（流内 error 帧 / passthrough 错误标记）：发 response.failed 后收尾 */
  const failStream = (message: string, code?: string): void => {
    if (ended || terminal !== null) return;
    finalizeFailed(message, code);
    endStream();
  };

  /** 处理一条已解析的 chat SSE data JSON */
  const handleDataJson = (payload: string): void => {
    if (!payload || payload === "[DONE]") return;
    let parsed: {
      error?: { message?: string; code?: string; type?: string };
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
        message?: ChatChoiceMessage;
      }>;
      usage?: ChatUsage;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // 非 JSON data 行忽略
    }

    // 流内错误帧（部分兼容上游以 data 帧回传 error 对象而非断流）→ response.failed
    if (parsed.error && !parsed.choices) {
      const err = parsed.error;
      failStream(`upstream error frame: ${err.message || "unknown error"}`, err.code || err.type || "upstream_error");
      return;
    }

    const choice = parsed.choices?.[0];
    if (choice && typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
      sawFinishFrame = true;
    }
    if (choice?.delta) {
      const delta = choice.delta;
      // 思维链增量（DeepSeek reasoning_content / OpenCode、MiMo reasoning）→ 标准 reasoning item 增量事件
      const reasoningDelta =
        typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0
          ? delta.reasoning_content
          : typeof delta.reasoning === "string" && delta.reasoning.length > 0
            ? delta.reasoning
            : "";
      if (reasoningDelta) {
        openReasoningItem();
        ensureReasoningPart();
        reasoningText += reasoningDelta;
        emitEvent("response.reasoning_summary_text.delta", {
          item_id: reasoningItemId,
          output_index: reasoningOutputIndex,
          summary_index: 0,
          delta: reasoningDelta,
        });
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        openMessageItem();
        fullText += delta.content;
        emitEvent("response.output_text.delta", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: delta.content,
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          const idx = typeof fragment.index === "number" ? fragment.index : toolAccumulators.size;
          let acc = toolAccumulators.get(idx);
          if (!acc) {
            acc = {
              chatId: fragment.id || `call_${randSuffix()}`,
              name: "",
              arguments: "",
            };
            toolAccumulators.set(idx, acc);
            toolOrder.push(idx);
            // 首片段即产出 added 事件 + 后续逐片段 arguments.delta（客户端可实时组装工具调用）
            acc.outputIndex = nextOutputIndex++;
            acc.item = toolCallToResponsesItem(
              { id: acc.chatId, type: "function", function: { name: "", arguments: "" } },
              ctx
            );
            emitEvent("response.output_item.added", {
              output_index: acc.outputIndex,
              item: { ...acc.item, status: "in_progress" },
            });
          }
          if (fragment.id && fragment.id !== acc.chatId) acc.chatId = fragment.id;
          if (fragment.function?.name) {
            acc.name += fragment.function.name;
            if (acc.item) {
              (acc.item as any).function = { ...(acc.item as any).function, name: acc.name };
            }
          }
          if (fragment.function?.arguments) {
            acc.arguments += fragment.function.arguments;
            emitEvent("response.function_call_arguments.delta", {
              item_id: (acc.item as any).id,
              output_index: acc.outputIndex,
              delta: fragment.function.arguments,
            });
          }
        }
      }
    } else if (choice?.message) {
      // 整段 message 帧（部分兼容上游不产 delta、单帧回完整消息）：仅在尚无增量时采纳，避免双计
      const rcText = typeof choice.message.reasoning_content === "string" ? choice.message.reasoning_content : "";
      if (rcText && !reasoningPartAdded && reasoningText === "") {
        openReasoningItem();
        ensureReasoningPart();
        reasoningText = rcText;
        emitEvent("response.reasoning_summary_text.delta", {
          item_id: reasoningItemId,
          output_index: reasoningOutputIndex,
          summary_index: 0,
          delta: rcText,
        });
      }
      const text = typeof choice.message.content === "string" ? choice.message.content : "";
      if (text.length > 0 && fullText === "") {
        openMessageItem();
        fullText = text;
        emitEvent("response.output_text.delta", {
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: text,
        });
      }
      if (Array.isArray(choice.message.tool_calls) && toolOrder.length === 0) {
        for (const tc of choice.message.tool_calls) {
          const idx = toolAccumulators.size;
          const acc: StreamToolCallAccumulator = {
            chatId: tc.id || `call_${randSuffix()}`,
            name: typeof tc.function?.name === "string" ? tc.function.name : "",
            arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : "{}",
          };
          toolAccumulators.set(idx, acc);
          toolOrder.push(idx);
          acc.outputIndex = nextOutputIndex++;
          acc.item = toolCallToResponsesItem(
            { id: acc.chatId, type: "function", function: { name: acc.name, arguments: acc.arguments } },
            ctx
          );
        }
      }
    }
    if (parsed.usage) {
      usage = mapUsage(parsed.usage);
    }
  };

  // ---- 逐行解析上游 SSE（跳过注释行与 event: 行；识别 passthrough 上游错误标记） ----
  let buffer = "";
  let dataLines: string[] = [];
  let sawData = false;

  const processLine = (line: string): void => {
    if (line === "") {
      // 空行 = 事件边界：聚合 data 行为一个事件
      if (sawData) {
        handleDataJson(dataLines.join("\n"));
        dataLines = [];
        sawData = false;
      }
      return;
    }
    if (line.startsWith(":")) {
      // SSE 注释行：passthrough 层的上游错误标记（该流将被干净关闭 —— 转译为 response.failed
      // 而非把截断内容伪装成 completed）；其余注释（keep-alive ping）忽略
      const comment = line.slice(1).trim();
      if (comment.startsWith(UPSTREAM_ERROR_MARKER)) {
        const message = comment.slice(UPSTREAM_ERROR_MARKER.length).trim() || "aborted";
        failStream(`upstream stream aborted: ${message}`);
      }
      return;
    }
    if (line.startsWith("event:")) return; // chat SSE 事件名行（data 载荷自含类型）
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
      sawData = true;
    }
  };

  const pump = (): Promise<void> =>
    reader!.read().then(({ done, value }) => {
      if (ended) return;
      if (done) {
        // 上游流结束：刷新残行 → 终点事件（无 finish 帧也保证 completed —— 流尾兜底，
        // 上游静默停滞由 passthrough 层熔断补 [DONE] 后同样走到这里）
        if (buffer.length > 0) processLine(buffer);
        processLine("");
        if (!ended) {
          finalizeSuccess();
          endStream();
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        if (ended) return;
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        processLine(line);
      }
      if (ended) return;
      return pump();
    });

  const onPumpError = (err: unknown): void => {
    // 上游读取异常：客户端断连不发终点（对端不可达）；真上游错误发 response.failed
    if (ended) return;
    if (clientAborted || options.signal?.aborted) {
      clientAborted = true;
      endStream();
      return;
    }
    const message = (err instanceof Error ? err.message : String(err)) || "read failed";
    finalizeFailed(`upstream stream aborted: ${message}`);
    endStream();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      reader = body.getReader();

      // 客户端在流启动前就已断开：直接收尾（不发任何事件，无 ping 定时器可泄漏）
      if (options.signal?.aborted) {
        clientAborted = true;
        endStream();
        return;
      }

      // ---- 首帧：response.created + response.in_progress（流开始即发，客户端立刻获得 response id） ----
      const initialResponse = responsesSkeleton(ctx, "in_progress");
      emitEvent("response.created", { response: initialResponse });
      emitEvent("response.in_progress", { response: initialResponse });

      // ---- 客户端空闲保活（SSE 注释行，客户端零感知）----
      const pingIntervalMs = options.pingIntervalMs ?? 0;
      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          if (ended) return;
          meter.comment("ping");
        }, pingIntervalMs);
      }

      // ---- 客户端断连：不发终点（对端不可达），拆除上游读取并记录 ----
      if (options.signal) {
        abortListener = (): void => {
          clientAborted = true;
          endStream();
        };
        options.signal.addEventListener("abort", abortListener, { once: true });
      }

      pump().catch(onPumpError);
    },
    cancel() {
      // 下游取消（运行时侧客户端断连信号）：与 signal abort 同语义
      clientAborted = true;
      endStream();
    },
  });
}

/** 流式响应头（sseHeaders + 网关落点头透传 + dropped-tools 头） */
export function responsesSseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return sseHeaders(extra);
}

/**
 * 流式兜底：客户端请求 stream 但上游返回 JSON（provider 忽略 stream 或聚合路径）——
 * 把完整 JSON 合成为最小完整事件序列（created → in_progress → item.added → delta(整段) →
 * done → completed；status=incomplete 时终点为 response.incomplete）。
 */
export function chatJsonToResponsesStream(chatJson: Record<string, unknown>, ctx: ResponseEchoContext): ReadableStream<Uint8Array> {
  const full = chatCompletionToResponsesResponse(chatJson, ctx);
  const output = (full.output as Array<Record<string, unknown>>) || [];
  const messageItem = output.find((i) => i.type === "message") as
    | { id?: string; content?: Array<{ type?: string; text?: string }> }
    | undefined;
  const text = joinOutputText(output);
  const terminalEvent = full.status === "incomplete" ? "response.incomplete" : "response.completed";

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const meter = createSseMeter((bytes) => {
        try {
          controller.enqueue(bytes);
        } catch {
          /* 下游已关闭 */
        }
      });
      try {
        const itemId = (messageItem?.id as string) || `msg_${randSuffix()}`;
        meter.event("response.created", { response: { ...full, status: "in_progress", output: [] } });
        meter.event("response.in_progress", { response: { ...full, status: "in_progress", output: [] } });
        if (text.length > 0 || !messageItem) {
          meter.event("response.output_item.added", {
            output_index: 0,
            item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
          });
          meter.event("response.content_part.added", {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          if (text.length > 0) {
            meter.event("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: text });
          }
          meter.event("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text });
          meter.event("response.content_part.done", {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
          });
          meter.event("response.output_item.done", {
            output_index: 0,
            item: {
              type: "message",
              id: itemId,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          });
        }
        // 工具调用项
        let idx = text.length > 0 || !messageItem ? 1 : 0;
        for (const item of output) {
          if (item.type === "message") continue;
          meter.event("response.output_item.added", { output_index: idx, item: { ...item, status: "in_progress" } });
          meter.event("response.output_item.done", { output_index: idx, item });
          idx++;
        }
        meter.event(terminalEvent, { response: full });
      } catch (err) {
        // 防御：合成流本身异常也必须给终点（response.failed）再关流
        try {
          meter.event("response.failed", {
            response: {
              ...responsesSkeleton(ctx, "failed"),
              error: { code: "gateway_error", message: (err instanceof Error ? err.message : String(err)) || "synthesis failed" },
            },
          });
        } catch {
          /* 尽力而为 */
        }
      }
      try {
        controller.close();
      } catch {
        /* 已关闭 */
      }
    },
  });
}
