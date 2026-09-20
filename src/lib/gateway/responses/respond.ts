// Responses 响应侧回译 —— Chat Completions（JSON / SSE）→ OpenAI Responses 协议。
// 纯转译 + 流式重排版；请求侧转译见 ./translate.ts，路由编排见 app/v1/responses/route.ts。
//
// 非流式：chat.completion JSON → Responses response 对象（合法完整形态）。
// 流式：chat SSE chunks → Responses SSE 事件流，序列完整：
//   response.created → response.output_item.added → response.content_part.added →
//   response.output_text.delta* → response.output_text.done → response.content_part.done →
//   response.output_item.done → response.completed
// 工具调用项在 finish 后以完整 item 形态输出（added → done 背靠背，合法事件序列）。

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

/**
 * 非流式：chat.completion JSON → Responses response 对象。
 * 解析失败（上游返回非 JSON）抛 Error（路由层 502 兜底）。
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

  const status = finishReason === "length" ? "incomplete" : "completed";
  const response = responsesSkeleton(ctx, status);
  if (finishReason === "length") {
    response.incomplete_details = { reason: "max_output_tokens" };
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
}

/** SSE 事件帧（event: 行 + data: 行 —— 最大化兼容：两种消费方式都能解析） */
function sseFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...payload })}\n\n`);
}

interface TranslateStreamOptions {
  /** 客户端断连信号（透传取消上游读取） */
  signal: AbortSignal | null;
  /** 客户端空闲保活间隔（毫秒；0 = 关闭） */
  pingIntervalMs?: number;
}

/**
 * 流式回译：消费 chat SSE（含网关注入的 ": keep-alive" 注释行），产出 Responses SSE 事件流。
 * 事件序列：created → output_item.added → content_part.added → output_text.delta* →
 * output_text.done → content_part.done → output_item.done → completed。
 */
export function chatSseToResponsesStream(
  body: ReadableStream<Uint8Array>,
  ctx: ResponseEchoContext,
  options: TranslateStreamOptions
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (bytes: Uint8Array): void => {
        try {
          controller.enqueue(bytes);
        } catch {
          /* 下游已关闭：读循环 break 兜底 */
        }
      };
      const emitEvent = (eventType: string, payload: Record<string, unknown>): void => {
        emit(sseFrame(eventType, payload));
      };

      // ---- 流内状态机 ----
      let messageItemOpen = false; // 正文 message 项已 added
      let messageItemId = `msg_${randSuffix()}`;
      let fullText = "";
      let finished = false;
      let usage: Record<string, unknown> | null = null;
      const toolAccumulators = new Map<number, StreamToolCallAccumulator>();
      const toolOrder: number[] = [];
      let textDoneEmitted = false;
      let streamClosed = false;

      const openMessageItem = (): void => {
        if (messageItemOpen) return;
        messageItemOpen = true;
        emitEvent("response.output_item.added", {
          output_index: 0,
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
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      };

      const closeMessageItem = (): void => {
        if (!messageItemOpen || textDoneEmitted) return;
        textDoneEmitted = true;
        emitEvent("response.output_text.done", {
          item_id: messageItemId,
          output_index: 0,
          content_index: 0,
          text: fullText,
        });
        emitEvent("response.content_part.done", {
          item_id: messageItemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: fullText, annotations: [] },
        });
        emitEvent("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: messageItemId,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: fullText, annotations: [] }],
          },
        });
      };

      /** 处理一条已解析的 chat SSE data JSON */
      const handleDataJson = (payload: string): void => {
        if (!payload || payload === "[DONE]") return;
        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
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

        const choice = parsed.choices?.[0];
        if (choice?.delta) {
          const delta = choice.delta;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            openMessageItem();
            fullText += delta.content;
            emitEvent("response.output_text.delta", {
              item_id: messageItemId,
              output_index: 0,
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
                  name: fragment.function?.name || "",
                  arguments: "",
                };
                toolAccumulators.set(idx, acc);
                toolOrder.push(idx);
              }
              if (fragment.id && fragment.id !== acc.chatId) acc.chatId = fragment.id;
              if (fragment.function?.name) acc.name += fragment.function.name;
              if (fragment.function?.arguments) acc.arguments += fragment.function.arguments;
            }
          }
          // delta.reasoning_content：流式思维链无 Responses 增量事件等价物 —— 忽略（completed 前不掺正文）
        }
        if (parsed.usage) {
          usage = mapUsage(parsed.usage);
        }
      };

      const finalize = (): void => {
        if (finished) return;
        finished = true;
        closeMessageItem();
        // 工具调用项：以完整 item 形态在流尾输出（added → done 背靠背，合法事件序列）
        let outputIndex = messageItemOpen ? 1 : 0;
        for (const idx of toolOrder) {
          const acc = toolAccumulators.get(idx)!;
          const item = toolCallToResponsesItem(
            { id: acc.chatId, type: "function", function: { name: acc.name || "tool", arguments: acc.arguments || "{}" } },
            ctx
          );
          emitEvent("response.output_item.added", { output_index: outputIndex, item: { ...item, status: "in_progress" } });
          emitEvent("response.output_item.done", { output_index: outputIndex, item });
          outputIndex++;
        }
        // completed：完整 response 对象（output + usage）
        const output: Array<Record<string, unknown>> = [];
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
          output.push(
            toolCallToResponsesItem(
              { id: acc.chatId, type: "function", function: { name: acc.name || "tool", arguments: acc.arguments || "{}" } },
              ctx
            )
          );
        }
        const response = responsesSkeleton(ctx, "completed");
        response.output = output;
        response.usage = usage ?? mapUsage(undefined);
        response.output_text = joinOutputText(output);
        emitEvent("response.completed", { response });
      };

      // ---- 客户端空闲保活（SSE 注释行，客户端零感知）----
      const pingIntervalMs = options.pingIntervalMs ?? 0;
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          if (streamClosed) return;
          emit(encoder.encode(": ping\n\n"));
        }, pingIntervalMs);
      }
      const cleanup = (): void => {
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      };

      // ---- 首帧：response.created（流开始即发，客户端立刻获得 response id）----
      emitEvent("response.created", { response: responsesSkeleton(ctx, "in_progress") });

      // ---- 逐行解析上游 SSE（跳过网关注入的 ": keep-alive" 注释行与 event: 行）----
      const reader = body.getReader();
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
        if (line.startsWith(":")) return; // SSE 注释（keep-alive ping）
        if (line.startsWith("event:")) return; // chat SSE 事件名行（data 载荷自含类型）
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
          sawData = true;
        }
      };

      const pump = (): Promise<void> =>
        reader.read().then(({ done, value }) => {
          if (streamClosed) return;
          if (done) {
            // 上游流结束：刷新残行 + 兜底收尾（无 finish 帧也保证 completed 事件发出）
            buffer += "";
            if (buffer.length > 0) processLine(buffer);
            processLine("");
            finalize();
            streamClosed = true;
            cleanup();
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            processLine(line);
          }
          return pump();
        });

      // 客户端断连：取消上游读取，流自然收尾
      if (options.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            if (streamClosed) return;
            streamClosed = true;
            cleanup();
            void reader.cancel(new Error("Client aborted")).catch(() => {});
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
          },
          { once: true }
        );
      }

      pump().catch((err: unknown) => {
        // 上游读取异常：尽力发出 completed（含已积累内容），再关闭
        if (!streamClosed) {
          finalize();
          streamClosed = true;
        }
        cleanup();
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
        if (err) console.warn(`[Responses] upstream stream read error: ${(err as Error).message}`);
      });
    },
  });
}

/** 流式响应头（sseHeaders + 网关落点头透传 + dropped-tools 头） */
export function responsesSseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return sseHeaders(extra);
}

/**
 * 流式兜底：客户端请求 stream 但上游返回 JSON（provider 忽略 stream 或聚合路径）——
 * 把完整 JSON 合成为最小完整事件序列（created → item.added → delta(整段) → done → completed）。
 */
export function chatJsonToResponsesStream(chatJson: Record<string, unknown>, ctx: ResponseEchoContext): ReadableStream<Uint8Array> {
  const full = chatCompletionToResponsesResponse(chatJson, ctx);
  const output = (full.output as Array<Record<string, unknown>>) || [];
  const messageItem = output.find((i) => i.type === "message") as
    | { id?: string; content?: Array<{ type?: string; text?: string }> }
    | undefined;
  const text = joinOutputText(output);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (eventType: string, payload: Record<string, unknown>): void => {
        controller.enqueue(sseFrame(eventType, payload));
      };
      const itemId = (messageItem?.id as string) || `msg_${randSuffix()}`;
      push("response.created", { response: { ...full, status: "in_progress", output: [] } });
      if (text.length > 0 || !messageItem) {
        push("response.output_item.added", {
          output_index: 0,
          item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
        });
        push("response.content_part.added", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        if (text.length > 0) {
          push("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: text });
        }
        push("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text });
        push("response.content_part.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        });
        push("response.output_item.done", {
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
        push("response.output_item.added", { output_index: idx, item: { ...item, status: "in_progress" } });
        push("response.output_item.done", { output_index: idx, item });
        idx++;
      }
      push("response.completed", { response: full });
      controller.close();
    },
  });
}
