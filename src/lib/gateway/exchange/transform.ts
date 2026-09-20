// 请求侧转译 —— Anthropic ⇄ OpenAI 的请求体映射（transform / normalize / prune）。
// 纯数据变换，无 I/O；响应侧与路由见 ./stream.ts 与 ./dispatch.ts。
import { optimizeToolOutput } from "./sanitizer";
import { parseReasoningIntent, applyReasoningToPayload, type ReasoningIntent } from "./reasoning";
import type { GatewayConfig } from "../core/types";

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
}

export interface OpenAIMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface AnthropicRequestBody {
  model?: string;
  system?: string | Array<{ text?: string } | null>;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  thinking?: Record<string, unknown>;
  [key: string]: unknown;
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// 内部协议工具：Tools 转换
export function transformToolsToOpenAI(
  tools: AnthropicTool[] | undefined
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

// 核心状态机规范化：重构并对齐 OpenAI tool_calls 与 tool_results 顺序（根除 11148 tool_call_sequence_broken）
export function normalizeOpenAIMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const toolResultsMap = new Map<string, OpenAIMessage>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id) {
      toolResultsMap.set(m.tool_call_id, m);
    }
  }

  const result: OpenAIMessage[] = [];
  const seenToolResultIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      // 若该 tool 结果已被挂载在其对应的 assistant tool_calls 之后，则跳过
      if (seenToolResultIds.has(m.tool_call_id as string)) continue;
      // 孤儿 tool 结果（前置无对应 assistant tool_calls），降级为 user 消息避免上游 11148 序列破坏
      result.push({
        role: "user",
        content: `[Tool Result: ${m.content}]`,
      });
      continue;
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      result.push(m);
      // 强制将所有匹配的 tool_result 紧跟在当前的 assistant tool_calls 之后
      for (let j = 0; j < m.tool_calls.length; j++) {
        const tc = m.tool_calls[j];
        if (toolResultsMap.has(tc.id as string)) {
          result.push(toolResultsMap.get(tc.id as string) as OpenAIMessage);
          seenToolResultIds.add(tc.id as string);
        } else {
          // 缺失结果的孤儿 tool_call（如用户取消、中断或超时），补充合成结果闭环状态机
          result.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "[Result omitted or operation cancelled]",
          });
        }
      }
      continue;
    }

    result.push(m);
  }

  return result;
}

/**
 * 智能上下文窗口剪枝与管理：
 * 1. 根治超长会话在内存与延迟上的退化（原版为规避 Workers 1102 CPU 限制，Node 版保留同款策略）。
 * 2. 对长会话智能截取「首轮任务意图 + 最近活跃上下文」，并严格保证切片位于干净的 user 轮次，避免工具调用序列破坏 (11148)。
 * 3. 对历史工具执行结果（tool_result）的大块冗余终端输出进行两端保留式剪枝。
 */
function pruneMessageContents(messages: AnthropicMessage[], isCompact: boolean): AnthropicMessage[] {
  const total = messages.length;
  return messages.map((msg, idx) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const turnAge = total - idx;
    let modified = false;
    const newContent = (msg.content as AnthropicContentBlock[]).map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "tool_result") {
        let text =
          typeof part.content === "string"
            ? part.content
            : Array.isArray(part.content)
              ? (part.content as ContentPiece[]).map((c) => (typeof c === "string" ? c : c.text || JSON.stringify(c))).join("\n")
              : JSON.stringify(part.content ?? "");
        const optimized = optimizeToolOutput(text, turnAge, isCompact);
        if (optimized !== text) {
          modified = true;
          return { ...part, content: optimized };
        }
      }
      return part;
    });
    return modified ? { ...msg, content: newContent } : msg;
  });
}

interface ContentPiece {
  text?: string;
  [key: string]: unknown;
}

function pruneAnthropicMessages(
  messages: AnthropicMessage[],
  isCompact: boolean,
  maxTurnsLimit: number = 0
): AnthropicMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // 当 maxTurnsLimit <= 0 时，保留全部会话轮次（不限），但仍执行工具结果清洗（RTK 式 Token 压缩、测试成功项折叠与渐进式退火）
  if (maxTurnsLimit <= 0) {
    return pruneMessageContents(messages, isCompact);
  }

  const total = messages.length;
  const maxWindow = isCompact ? Math.max(maxTurnsLimit * 1.5, 70) : maxTurnsLimit;
  if (total <= maxWindow) return pruneMessageContents(messages, isCompact);

  let cutIdx = Math.max(1, total - maxWindow);
  while (cutIdx < total - 5) {
    const m = messages[cutIdx];
    const isToolResult =
      m &&
      m.role === "user" &&
      Array.isArray(m.content) &&
      (m.content as AnthropicContentBlock[]).some((c) => c && c.type === "tool_result");
    if (!isToolResult) break;
    cutIdx++;
  }

  const firstMsg = messages[0];
  const recentMsgs = messages.slice(cutIdx);
  const truncatedCount = cutIdx - 1;
  const firstRecent = recentMsgs[0];
  const bridgeMsg =
    firstRecent && firstRecent.role === "assistant"
      ? {
          role: "user",
          content: `[System Notice: Earlier conversation (${truncatedCount} messages) omitted to preserve context and latency limits. Resuming from active context.]`,
        }
      : {
          role: "assistant",
          content: `[System Notice: Earlier conversation (${truncatedCount} messages) omitted to preserve context and latency limits. Ready for next step.]`,
        };

  return pruneMessageContents([firstMsg, bridgeMsg, ...recentMsgs], isCompact);
}

// 内部协议工具：Anthropic 请求体 -> OpenAI 请求体
// intent 由 dispatch 预解析后传入（一请求只解析一次）；直接调用时传 null 自行解析。
export function transformAnthropicToOpenAI(
  body: AnthropicRequestBody,
  targetModel: string,
  config: Partial<GatewayConfig> = {},
  intent: ReasoningIntent | null = null
): Record<string, unknown> {
  const model = targetModel || body.model || "deepseek-v4.1-flash";
  const openaiMessages: OpenAIMessage[] = [];

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const totalMessages = rawMessages.length;
  const lastMsg = totalMessages > 0 ? rawMessages[totalMessages - 1] : null;
  const lastText =
    lastMsg && typeof lastMsg.content === "string"
      ? lastMsg.content
      : Array.isArray(lastMsg?.content)
        ? (lastMsg.content as AnthropicContentBlock[]).map((c) => c.text || "").join(" ")
        : "";

  // 检测是否为会话压缩 / 总结请求（如 Claude Code /compact）
  const systemStr = typeof body.system === "string" ? body.system : "";
  const isCompact =
    (typeof body.system === "string" && (
      systemStr.includes("Respond with TEXT ONLY") ||
      systemStr.includes("<analysis>") ||
      systemStr.includes("<summary>")
    )) || (
      lastText.includes("Respond with TEXT ONLY") ||
      lastText.includes("Do NOT use Read, Bash, Grep") ||
      lastText.includes("<analysis>")
    );

  // 动态上下文保留策略：默认 0（完全不剪枝，长上下文保真，Node 环境无 CPU 限制焦虑）
  const maxTurns =
    config?.max_context_turns !== undefined
      ? config.max_context_turns
      : 0;

  const messages = pruneAnthropicMessages(rawMessages, isCompact, maxTurns);

  if (body.system) {
    if (typeof body.system === "string") {
      openaiMessages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      // 校验 system 数组每个元素都必须是含 text 字符串的对象，否则 400
      const systemTexts: string[] = [];
      for (let i = 0; i < body.system.length; i++) {
        const sysBlock = body.system[i];
        if (!sysBlock || typeof sysBlock !== "object") {
          throw new HttpError(`system[${i}] must be an object`, 400);
        }
        if (typeof sysBlock.text !== "string") {
          throw new HttpError(`system[${i}].text must be a string`, 400);
        }
        systemTexts.push(sysBlock.text);
      }
      openaiMessages.push({ role: "system", content: systemTexts.join("\n") });
    } else {
      openaiMessages.push({ role: "system", content: String(body.system) });
    }
  }

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    if (!msg) continue;

    if (typeof msg.content === "string") {
      openaiMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    } else if (Array.isArray(msg.content)) {
      const toolUseBlocks: AnthropicContentBlock[] = [];
      const toolResultBlocks: AnthropicContentBlock[] = [];
      const textBlocks: AnthropicContentBlock[] = [];
      let imageBlocks = 0;

      for (let i = 0; i < (msg.content as AnthropicContentBlock[]).length; i++) {
        const b = (msg.content as AnthropicContentBlock[])[i];
        if (!b) continue;
        if (b.type === "tool_use") toolUseBlocks.push(b);
        else if (b.type === "tool_result") toolResultBlocks.push(b);
        else if (b.type === "image") {
          imageBlocks++;
        } else textBlocks.push(b);
      }

      // 显式拒绝图片块：上游不支持图片时返回 400，而不是静默丢弃
      if (imageBlocks > 0) {
        throw new HttpError(
          `Image content blocks are not supported by the target upstream provider. ` +
            `Please use a model/provider that supports multimodal input.`,
          400
        );
      }

      if (msg.role === "assistant" && toolUseBlocks.length > 0) {
        let textContent: string | null = null;
        if (textBlocks.length === 1) {
          textContent = textBlocks[0].text || null;
        } else if (textBlocks.length > 1) {
          textContent = textBlocks.map((b) => b.text || "").join("\n");
        }

        const toolCalls = toolUseBlocks.map((tb) => ({
          id: tb.id,
          type: "function",
          function: {
            name: tb.name as string,
            arguments: typeof tb.input === "string" ? tb.input : JSON.stringify(tb.input || {}),
          },
        }));
        openaiMessages.push({
          role: "assistant",
          content: textContent,
          tool_calls: toolCalls,
        });
      } else if (toolResultBlocks.length > 0) {
        for (let i = 0; i < toolResultBlocks.length; i++) {
          const rb = toolResultBlocks[i];
          let resContent = "";
          if (typeof rb.content === "string") {
            resContent = rb.content;
          } else if (Array.isArray(rb.content)) {
            resContent = (rb.content as ContentPiece[])
              .map((c) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
              .join("\n");
          } else {
            resContent = JSON.stringify(rb.content ?? "");
          }

          openaiMessages.push({
            role: "tool",
            tool_call_id: rb.tool_use_id as string,
            content: resContent,
          });
        }
      } else {
        let combined = "";
        if (textBlocks.length === 1) {
          combined = textBlocks[0].text || "";
        } else if (textBlocks.length > 1) {
          combined = textBlocks.map((b) => b.text || "").join("\n");
        }
        openaiMessages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: combined,
        });
      }
    }
  }

  // 若为总结压缩请求，剥离 tools 定义避免上游大模型生成 tool_calls 反射
  const upstreamTools = isCompact ? undefined : transformToolsToOpenAI(body.tools);
  const payload: Record<string, unknown> = {
    model: model,
    messages: normalizeOpenAIMessages(openaiMessages),
    stream: body.stream !== false,
  };

  if (upstreamTools && upstreamTools.length > 0) {
    payload.tools = upstreamTools;
    payload.tool_choice = "auto";
  }

  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  if (body.top_p !== undefined) payload.top_p = body.top_p;

  // 共享思维链与推理强度调度器：统一解析与注入
  const reasoningIntent = intent || parseReasoningIntent({ model: body.model || model, body: body as never });
  applyReasoningToPayload(payload, reasoningIntent, "openai", targetModel || model);

  return payload;
}
