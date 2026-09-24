// Responses 入站转译层 —— OpenAI Responses API 请求 → Chat Completions 请求体。
// 纯数据变换，无 I/O；响应侧回译见 ./respond.ts，路由编排见 app/v1/responses/route.ts。
//
// 设计原则（v4.6.0 契约）：
//   1. 明确的 400 只用于「客户端可自行修复且有替代路径」的请求错误；
//      客户端无法避免的默认行为（如 Codex CLI 开启 web_search 后每个请求恒带
//      {"type":"web_search"} 工具声明）必须降级而非拒绝 —— 剥离后继续处理。
//   2. 能力降级必须可观测：每次剥离 / 每次序列修复动作 console.warn 落日志，
//      被剥离工具类型清单经 X-Gateway-Dropped-Tools 响应头暴露（流式/非流式均携带）。
//   3. 转译层必须产出规范形态（canonical form）而非透传历史原样 —— 不同上游对
//      OpenAI 宽松语义的实现差异（宽松 vs 严格校验，如 11148
//      tool_call_sequence_broken）是转译层的隐式契约：repairToolCallSequence
//      统一修复通道负责合并相邻 assistant tool_call 消息 / 丢弃孤儿工具结果 /
//      补齐未应答调用的合成结果。

import { HttpError } from "../exchange/transform";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

/**
 * OpenAI 服务端工具类型（由模型侧执行，Chat Completions 上游本无对应实现）：
 * 剥离后继续处理，绝不因它们拒绝整个请求（Codex CLI 无法避免的默认行为）。
 */
const SERVER_SIDE_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "code_interpreter",
  "computer_use_preview",
  "local_shell",
]);

/** custom(freeform) 工具合成的 function schema；与 custom_tool_call 历史项的 {"input": <文本>} 参数形态保持一致 */
function freeformToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      input: { type: "string", description: "Freeform text input for this tool." },
    },
    required: ["input"],
    additionalProperties: false,
  };
}

export interface TranslatedTools {
  /** Chat Completions tools 数组（无可保留工具时为 undefined） */
  tools: Array<Record<string, unknown>> | undefined;
  /** 被剥离工具类型清单（按出现顺序，含未知类型）——驱动 X-Gateway-Dropped-Tools 头与 warn 日志 */
  dropped: string[];
  /** 声明为 function 的工具名集合（响应侧回译 function_call 用） */
  functionToolNames: Set<string>;
  /** 声明为 custom(freeform) 的工具名集合（响应侧回译 custom_tool_call 用） */
  customToolNames: Set<string>;
}

/**
 * Responses tools → Chat Completions tools。
 *   - function 工具：全量保留转译为 {type:"function", function:{...}}；
 *   - custom(freeform) 工具：全量保留，合成 {"input": string} 参数 schema；
 *   - 五类服务端工具 + 未知类型：剥离 + warn + 记入 dropped（可观测降级）。
 */
export function translateResponsesTools(rawTools: unknown): TranslatedTools {
  const dropped: string[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const functionToolNames = new Set<string>();
  const customToolNames = new Set<string>();

  if (Array.isArray(rawTools)) {
    for (const entry of rawTools) {
      if (!entry || typeof entry !== "object") {
        console.warn('[Responses] dropping malformed tools entry (non-object)');
        dropped.push("(malformed)");
        continue;
      }
      const tool = entry as Record<string, unknown>;
      const type = typeof tool.type === "string" ? tool.type : "";
      const name = typeof tool.name === "string" ? tool.name : "";

      if (type === "function") {
        // Responses function 工具为扁平形态 {type,name,description,parameters} → chat 嵌套形态
        if (!name) {
          console.warn('[Responses] dropping function tool without a name (client-fixable)');
          dropped.push("function(unnamed)");
          continue;
        }
        functionToolNames.add(name);
        tools.push({
          type: "function",
          function: {
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            parameters:
              tool.parameters && typeof tool.parameters === "object"
                ? (tool.parameters as Record<string, unknown>)
                : { type: "object", properties: {} },
          },
        });
        continue;
      }

      if (type === "custom") {
        // freeform 工具：合成 function schema，参数恒为 {"input": <文本>}
        if (!name) {
          console.warn('[Responses] dropping custom tool without a name (client-fixable)');
          dropped.push("custom(unnamed)");
          continue;
        }
        customToolNames.add(name);
        tools.push({
          type: "function",
          function: {
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            parameters: freeformToolSchema(),
          },
        });
        continue;
      }

      // 服务端 OpenAI 工具 / 未知类型：剥离后继续（客户端无法避免的默认行为 → 降级而非拒绝）
      if (SERVER_SIDE_TOOL_TYPES.has(type)) {
        console.warn(
          `[Responses] dropping server-side OpenAI tool "${type}" — executed model-side with no Chat ` +
            `Completions equivalent; stripped by this gateway (capability degradation, see X-Gateway-Dropped-Tools)`
        );
      } else {
        console.warn(
          `[Responses] dropping unsupported tool type "${type || "(missing type)"}" — no Chat Completions ` +
            `equivalent; stripped by this gateway (see X-Gateway-Dropped-Tools)`
        );
      }
      dropped.push(type || "(missing type)");
    }
  }

  return {
    tools: tools.length > 0 ? tools : undefined,
    dropped,
    functionToolNames,
    customToolNames,
  };
}

/**
 * Responses tool_choice → Chat Completions tool_choice。
 * 防御：剥离后请求不再有任何工具时，强制形态（"required" 或指定函数对象）降级为 "auto"，
 * 避免「无工具请求 + 强制 tool_choice」这一非法形态再次触发上游 400。
 */
export function translateResponsesToolChoice(
  rawChoice: unknown,
  translated: TranslatedTools
): string | Record<string, unknown> | undefined {
  const hasTools = !!translated.tools && translated.tools.length > 0;

  if (rawChoice === undefined || rawChoice === null) return undefined;

  if (typeof rawChoice === "string") {
    if (rawChoice === "auto" || rawChoice === "none" || rawChoice === "required") {
      if (rawChoice === "required" && !hasTools) {
        console.warn('[Responses] tool_choice "required" downgraded to "auto" (no tools left after stripping)');
        return "auto";
      }
      // "auto"/"none" 在无工具时语义恒空：省略字段（避免严格上游对「无 tools + tool_choice」的形态挑剔）
      if (!hasTools) return undefined;
      return rawChoice;
    }
    console.warn(`[Responses] ignoring unrecognized tool_choice string "${rawChoice}"`);
    return undefined;
  }

  if (typeof rawChoice === "object") {
    const choice = rawChoice as Record<string, unknown>;
    const type = typeof choice.type === "string" ? choice.type : "";
    const name = typeof choice.name === "string" ? choice.name : "";

    // 指定函数对象的强制形态
    if (type === "function" || type === "custom") {
      if (!hasTools) {
        console.warn(
          `[Responses] tool_choice function object${name ? ` ("${name}")` : ""} downgraded to "auto" (no tools left after stripping)`
        );
        return "auto";
      }
      const refersSurvivingTool =
        (type === "function" && translated.functionToolNames.has(name)) ||
        (type === "custom" && translated.customToolNames.has(name));
      if (!refersSurvivingTool) {
        console.warn(
          `[Responses] tool_choice references dropped/unknown tool "${name}" — downgraded to "auto"`
        );
        return "auto";
      }
      return { type: "function", function: { name } };
    }

    // {type:"local_shell"} / {type:"web_search"} 等服务端工具引用：强制形态降级
    console.warn(
      `[Responses] tool_choice object of type "${type || "(missing)"}" refers to a stripped server-side tool — downgraded to "auto"`
    );
    return "auto";
  }

  console.warn(`[Responses] ignoring malformed tool_choice (${typeof rawChoice})`);
  return undefined;
}

/** tool 输出内容归一为字符串（Responses output 允许字符串或 {content} 对象形态） */
function outputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

/** 历史项 call_id 兜底（Responses 项理论上必带 call_id；防御性合成保证状态机不缺 id） */
function fallbackCallId(prefix: string, index: number): string {
  return `call_${prefix}_${index}`;
}

/**
 * Responses input（字符串或 item 数组）+ instructions → Chat Completions messages（未修复形态）。
 *
 * switch 全类型覆盖（含 v4.6.0 补齐的三类缺口）：
 *   - message：user/assistant/system/developer；content 为字符串或 parts 数组
 *     （input_text/output_text → text；input_image → image_url 透传给具备视觉能力的上游）
 *   - function_call → assistant tool_call
 *   - function_call_output → role:"tool"
 *   - custom_tool_call → assistant tool_call，参数 {"input": <文本>} JSON 形态
 *   - custom_tool_call_output → role:"tool"
 *   - local_shell_call → assistant tool_call（合成 shell 函数形态）
 *   - local_shell_call_output → role:"tool"（call_id 对应）
 *   - reasoning → 跳过（加密思维链无 Chat 等价物；不产生配对缺口）
 *   - item_reference → 400（客户端可修复：回放完整 item 而非引用）
 *
 * 鲁棒性保证（grok2api 风格）：无论如何处理，最终返回的 messages 数组长度 ≥ 1（空场景合成 {role:'user', content:''}）。
 */
export function translateResponsesInput(input: unknown, instructions: unknown): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // instructions → 首条 system 消息（Codex CLI 的系统提示走此字段）
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }

  // input 为纯字符串 → 单条 user 消息
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    throw new HttpError('Invalid request: "input" must be a string or an array of items.', 400);
  }

  let reasoningDropped = 0;

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") {
      console.warn(`[Responses] skipping malformed input item at index ${i} (non-object)`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    const callId =
      typeof item.call_id === "string" && item.call_id
        ? item.call_id
        : typeof item.id === "string" && item.id
          ? item.id
          : fallbackCallId(type || "item", i);

    switch (type) {
      case "message": {
        const role = typeof item.role === "string" ? item.role : "user";
        const chatRole =
          role === "developer"
            ? "system"
            : role === "user" || role === "system" || role === "assistant"
              ? role
              : "user";
        const content = translateMessageContent(item.content);
        if (content === null) {
          console.warn(`[Responses] skipping empty message item at index ${i} (no translatable content)`);
          break;
        }
        messages.push({ role: chatRole, content });
        break;
      }

      case "function_call": {
        // 历史函数调用 → assistant 消息（含单条 tool_call；相邻项由 repairToolCallSequence 合并为规范并行形态）
        const name = typeof item.name === "string" && item.name ? item.name : "tool";
        const args =
          typeof item.arguments === "string"
            ? item.arguments
            : item.arguments === undefined || item.arguments === null
              ? "{}"
              : JSON.stringify(item.arguments);
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
        });
        break;
      }

      case "function_call_output": {
        messages.push({ role: "tool", tool_call_id: callId, content: outputToString(item.output) });
        break;
      }

      case "custom_tool_call": {
        // v4.6.0 补齐：freeform 工具调用历史项 —— 参数按 {"input": <文本>} JSON 形态，
        // 与 translateResponsesTools 对 custom 工具合成的 function schema 严格一致
        const name = typeof item.name === "string" && item.name ? item.name : "tool";
        const inputText = typeof item.input === "string" ? item.input : outputToString(item.input);
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify({ input: inputText }) },
            },
          ],
        });
        break;
      }

      case "custom_tool_call_output": {
        messages.push({ role: "tool", tool_call_id: callId, content: outputToString(item.output) });
        break;
      }

      case "local_shell_call": {
        // v4.6.0：local_shell_call 历史项 → 合成 shell 函数 tool_call（保持配对完整性）
        const action = (item.action && typeof item.action === "object" ? item.action : {}) as Record<string, unknown>;
        const command = Array.isArray(action.command) ? action.command : [];
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name: "shell", arguments: JSON.stringify({ command }) },
            },
          ],
        });
        break;
      }

      case "local_shell_call_output": {
        // v4.6.0 补齐：shell 调用结果 → role:"tool"（call_id 对应，消除「调用已映射而结果丢失」的同型不配对）
        messages.push({ role: "tool", tool_call_id: callId, content: outputToString(item.output) });
        break;
      }

      case "reasoning": {
        // 模型思维链历史项（encrypted_content 无 Chat 等价物）：跳过；不产生孤儿/悬空（reasoning 无配对语义）
        reasoningDropped++;
        break;
      }

      case "item_reference": {
        // 客户端可自行修复（回放完整 item / 关闭 store 引用）→ 明确 400
        throw new HttpError(
          'Invalid request: "item_reference" items are not supported by this stateless gateway. ' +
            "Replay the full item content in input instead of referencing stored items.",
          400
        );
      }

      default: {
        // 未知类型：降级跳过（不拒绝整个会话），warn 可观测
        console.warn(
          `[Responses] skipping unsupported input item type "${type || "(missing type)"}" at index ${i}`
        );
        break;
      }
    }
  }

  if (reasoningDropped > 0) {
    console.warn(
      `[Responses] dropped ${reasoningDropped} reasoning item(s) from history (no Chat Completions equivalent; pairing unaffected)`
    );
  }

  // grok2api-style robustness (参考 responses_input.go + responses_history.go)：
  // 无论 input 是空数组、仅含 reasoning、或所有 message 内容为空，均在此合成一条最小的 user 消息，
  // 保证返回的 messages 数组长度 >=1 ，从根源杜绝传给上游 OpenAI Chat Completions 时出现 "zero messages" 400。
  if (messages.length === 0) {
    console.warn('[Responses] input translated to zero messages; synthesizing minimal user message ""');
    messages.push({ role: 'user', content: '' });
  }

  return messages;
}

/** Responses message content（字符串或 parts 数组）→ Chat content（字符串或多模态 parts） */
function translateMessageContent(content: unknown): string | Array<Record<string, unknown>> | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (content === null || content === undefined) return null;
  if (!Array.isArray(content)) {
    // 非规范形态：字符串化保底（不拒绝）
    return outputToString(content) || null;
  }

  const imageParts: Array<Record<string, unknown>> = [];
  const textParts: string[] = [];

  for (const rawPart of content) {
    if (typeof rawPart === "string") {
      textParts.push(rawPart);
      continue;
    }
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    const partType = typeof part.type === "string" ? part.type : "";

    if (
      partType === "input_text" ||
      partType === "output_text" ||
      partType === "summary_text" ||
      partType === "text"
    ) {
      const text = typeof part.text === "string" ? part.text : "";
      if (text) textParts.push(text);
      continue;
    }
    if (partType === "refusal") {
      const refusal = typeof part.refusal === "string" ? part.refusal : "";
      if (refusal) textParts.push(refusal);
      continue;
    }
    if (partType === "input_image") {
      // Responses input_image.image_url 为字符串（含 data URL）→ chat image_url 嵌套形态
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url && typeof (part.image_url as Record<string, unknown>).url === "string"
            ? ((part.image_url as Record<string, unknown>).url as string)
            : "";
      if (url) imageParts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    console.warn(`[Responses] skipping unsupported message content part type "${partType || "(missing)"}"`);
  }

  if (imageParts.length > 0) {
    // 多模态：text 与 image parts 混排（chat 多模态规范形态）
    const out: Array<Record<string, unknown>> = [];
    const joined = textParts.join("\n");
    if (joined) out.push({ type: "text", text: joined });
    out.push(...imageParts);
    return out;
  }
  const joined = textParts.join("\n");
  return joined.length > 0 ? joined : null;
}

/**
 * 统一修复通道：把转译产物修复为严格上游接受的规范形态。
 *
 * 三类动作（全部 console.warn 落日志，能力降级/历史修补必须可观测）：
 *   a) 相邻的 assistant tool_call 消息合并为一条多 tool_call 消息
 *      （规范形态：assistant([A,B]) → tool(A) → tool(B)；Codex 并行调用回放为相邻多条
 *       「单 tool_call」assistant 消息，严格校验视为 A 未应答就转入下一条 assistant → 拒绝）；
 *   b) 孤儿 tool 结果（tool_call_id 找不到任何已声明 tool_call）丢弃；
 *      重复应答（同一 call_id 多条结果）同样丢弃 —— 同型非法形态；
 *   c) 未应答的 tool_call 在其 assistant 消息之后补一条合成 tool 结果
 *      （ESC 中断轮次留下的悬空调用；content 诚实标注中断语义）。
 *
 * 写回判定用显式 changed 标志 —— 不用数组长度比较（孤儿丢弃 + 合成补齐数量可能恰好抵消）。
 */
export function repairToolCallSequence(messages: ChatMessage[]): { messages: ChatMessage[]; changed: boolean } {
  let changed = false;

  // ---- Pass A：合并相邻 assistant tool_call 消息 ----
  const passA: ChatMessage[] = [];
  for (const msg of messages) {
    const prev = passA.length > 0 ? passA[passA.length - 1] : null;
    const prevIsToolCallMsg =
      !!prev && prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0;
    const msgIsToolCallMsg = msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (prevIsToolCallMsg && msgIsToolCallMsg) {
      const mergedCalls = [...(prev!.tool_calls as ChatToolCall[]), ...(msg.tool_calls as ChatToolCall[])];
      const textA = typeof prev!.content === "string" ? prev!.content : "";
      const textB = typeof msg.content === "string" ? msg.content : "";
      const mergedText = [textA, textB].filter((s) => s.length > 0).join("\n");
      console.warn(
        `[Responses] merged adjacent assistant tool_call messages into one (${mergedCalls
          .map((c) => c.id)
          .join(", ")}) — canonical parallel-call form`
      );
      passA[passA.length - 1] = {
        ...prev!,
        content: mergedText.length > 0 ? mergedText : null,
        tool_calls: mergedCalls,
      };
      changed = true;
    } else {
      passA.push(msg);
    }
  }

  // ---- Pass B：孤儿 tool 结果丢弃 + 重复应答去重 ----
  const declaredIds = new Set<string>();
  for (const msg of passA) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id) declaredIds.add(tc.id);
      }
    }
  }
  const answeredIds = new Set<string>();
  const passB: ChatMessage[] = [];
  for (const msg of passA) {
    if (msg.role === "tool" && msg.tool_call_id) {
      if (!declaredIds.has(msg.tool_call_id)) {
        console.warn(
          `[Responses] orphan tool result dropped "${msg.tool_call_id}" (no matching tool_call declared in history)`
        );
        changed = true;
        continue;
      }
      if (answeredIds.has(msg.tool_call_id)) {
        console.warn(`[Responses] duplicate tool result dropped "${msg.tool_call_id}" (call already answered)`);
        changed = true;
        continue;
      }
      answeredIds.add(msg.tool_call_id);
      passB.push(msg);
      continue;
    }
    passB.push(msg);
  }

  // ---- Pass C：未应答 tool_call 补合成结果（紧随其 assistant 消息之后） ----
  const passC: ChatMessage[] = [];
  for (const msg of passB) {
    passC.push(msg);
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        if (tc.id && !answeredIds.has(tc.id)) {
          passC.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "tool call was interrupted before execution; no result recorded",
          });
          answeredIds.add(tc.id); // 防同 id 重复补齐
          console.warn(
            `[Responses] synthetic tool result repaired "${tc.id}" (call without result in history — interrupted turn)`
          );
          changed = true;
        }
      }
    }
  }

  // 显式 changed 标志判定写回（孤儿丢弃 + 合成补齐数量可能恰好抵消，禁止长度比较）
  return changed ? { messages: passC, changed } : { messages, changed };
}

export interface TranslatedRequest {
  /** Chat Completions 请求体（交 dispatchExchange 消费） */
  chatBody: Record<string, unknown>;
  /** 被剥离工具类型清单（驱动 X-Gateway-Dropped-Tools 头） */
  droppedTools: string[];
  /** 响应侧回译上下文：custom 工具名集合 */
  customToolNames: Set<string>;
  /** 响应侧回译上下文：function 工具名集合 */
  functionToolNames: Set<string>;
}

/**
 * Responses 请求 → Chat Completions 请求体（入口编排：tools 剥离 → tool_choice 防御降级 →
 * input 转译 → repairToolCallSequence 规范形态修复 → 采样参数映射）。
 *
 * 按 grok2api 风格重构：
 * - 明确 400 只用于客户端可自行修复的错误（缺失 input、item_reference、previous_response_id）
 * - 转译后零消息不再 400，而是由 translateResponsesInput 内部合成兜底
 */
export function translateResponsesRequest(body: Record<string, unknown>): TranslatedRequest {
  const input = body.input !== undefined ? body.input : body.prompt; // prompt 为旧版字段兜底
  if (input === undefined || input === null) {
    throw new HttpError('Invalid request: "input" is required (string or item array).', 400);
  }

  // 1. tools 转译（服务端工具剥离 + 可观测降级）
  const toolTranslation = translateResponsesTools(body.tools);
  // 2. tool_choice 防御降级（无剩余工具时强制形态 → "auto"）
  const toolChoice = translateResponsesToolChoice(body.tool_choice, toolTranslation);
  // 3. input items → messages（内部保证非空）
  let messages = translateResponsesInput(input, body.instructions);
  // 4. 统一修复通道 → 规范形态（严格上游 11148 隐式契约）
  const repaired = repairToolCallSequence(messages);
  messages = repaired.messages;

  // 5. 组装 Chat Completions 请求体
  const chatBody: Record<string, unknown> = {
    model: typeof body.model === "string" ? body.model : "deepseek-v4.1-flash",
    messages,
  };
  if (toolTranslation.tools) chatBody.tools = toolTranslation.tools;
  if (toolChoice !== undefined) chatBody.tool_choice = toolChoice;
  if (body.stream === true) {
    chatBody.stream = true;
    chatBody.stream_options = { include_usage: true };
  }
  if (typeof body.temperature === "number") chatBody.temperature = body.temperature;
  if (typeof body.top_p === "number") chatBody.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0) {
    chatBody.max_tokens = body.max_output_tokens;
  }
  if (typeof body.parallel_tool_calls === "boolean") chatBody.parallel_tool_calls = body.parallel_tool_calls;

  // Responses reasoning:{effort} → chat reasoning_effort
  const reasoning = body.reasoning as Record<string, unknown> | undefined;
  if (reasoning && typeof reasoning === "object" && typeof reasoning.effort === "string") {
    chatBody.reasoning_effort = reasoning.effort;
  }

  // Responses text.format → chat response_format
  const text = body.text as Record<string, unknown> | undefined;
  if (text && typeof text === "object" && text.format && typeof text.format === "object") {
    const format = text.format as Record<string, unknown>;
    if (format.type === "json_object") {
      chatBody.response_format = { type: "json_object" };
    } else if (format.type === "json_schema") {
      chatBody.response_format = {
        type: "json_schema",
        json_schema: {
          name: typeof format.name === "string" ? format.name : "response",
          ...(format.schema && typeof format.schema === "object" ? { schema: format.schema } : {}),
          ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
        },
      };
    }
  }

  if (body.background === true) {
    console.warn("[Responses] background=true is not supported by this gateway — request executed synchronously");
  }

  return {
    chatBody,
    droppedTools: toolTranslation.dropped,
    customToolNames: toolTranslation.customToolNames,
    functionToolNames: toolTranslation.functionToolNames,
  };
}
