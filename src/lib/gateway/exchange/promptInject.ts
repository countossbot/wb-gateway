// v4.6.0 —— 路由级系统提示词注入。
//
// 定位：把「模型路由」上配置的系统提示词，以**增量追加**方式并入即将发往上游的
// 请求体，与客户端自带的 system 提示词（Codex / Claude Code 等）共存，绝不覆盖。
//
// 设计约束：
//   1. 纯函数、无 I/O —— 便于单测；调用方（dispatch）负责读取配置与传入候选信息。
//   2. 单次注入 —— 在候选循环内对浅拷贝后的 body 注入，故障转移重试时基于同一份 body。
//   3. 双协议覆盖 —— Anthropic（body.system）与 OpenAI（body.messages[0]）两条路径。
//   4. 未识别变量原样保留 —— 避免误伤用户手写的 {{...}} 文字。

/** 提示词模板可用的运行时上下文。 */
export interface PromptRenderContext {
  /** 对外模型名（路由键）。 */
  model?: string;
  /** 实际命中的上游 provider id。 */
  provider?: string;
  /** 上游真实模型名。 */
  upstreamModel?: string;
  /** 虚拟键名（apiKeyName）。 */
  apiKeyName?: string;
  /** 本次请求 id。 */
  requestId?: string;
  /** 可注入的当前时间（测试用；缺省取 new Date()）。 */
  now?: Date;
}

const VAR_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** 两位补零。 */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时区 YYYY-MM-DD。 */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时区 HH:mm:ss。 */
function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 渲染提示词模板：替换已知变量，未知变量原样保留。
 * 模板为空（或全空白）时返回空串，调用方据此跳过注入。
 */
export function renderRoutePrompt(template: string, ctx: PromptRenderContext = {}): string {
  if (typeof template !== "string" || !template.trim()) return "";
  const now = ctx.now ?? new Date();

  const vars: Record<string, string> = {
    model: ctx.model ?? "",
    provider: ctx.provider ?? "",
    upstreamModel: ctx.upstreamModel ?? "",
    apiKeyName: ctx.apiKeyName ?? "",
    requestId: ctx.requestId ?? "",
    date: fmtDate(now),
    time: fmtTime(now),
    datetime: now.toISOString(),
  };

  return template.replace(VAR_PATTERN, (whole, name: string) => {
    const key = String(name);
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole;
  });
}

/** 消息形态的最小结构约束（兼容 Anthropic / OpenAI 两种 content 形态）。 */
type LoosyMessage = { role?: string; content?: unknown } & Record<string, unknown>;

/**
 * 把渲染后的提示词追加进 Anthropic 协议请求体（原地改写传入对象，调用方传浅拷贝）。
 *
 * 规则（追加，不覆盖）：
 *   - body.system 为 string        → 拼接为 `<原> + "\n\n" + <注入>`
 *   - body.system 为内容块数组      → push 一个 { type: "text", text } 块
 *   - body.system 缺省/空           → 设为注入内容
 *
 * @returns 是否真的发生了注入（false 表示无提示词、被跳过）。
 */
export function injectIntoAnthropicBody(body: Record<string, unknown>, rendered: string): boolean {
  if (!rendered) return false;

  const current = body.system;
  if (typeof current === "string") {
    body.system = current.trim() ? `${current}\n\n${rendered}` : rendered;
    return true;
  }
  if (Array.isArray(current)) {
    // 内容块数组：追加一个 text 块，保留原有缓存控制等元信息。
    body.system = [...current, { type: "text", text: rendered }];
    return true;
  }
  body.system = rendered;
  return true;
}

/**
 * 把渲染后的提示词追加进 OpenAI 协议请求体（原地改写传入对象，调用方传浅拷贝）。
 *
 * 规则（追加，不覆盖）：
 *   - messages[0].role === "system" 且 content 为 string → 追加到该条
 *   - 否则                                                → 头部插入一条 system
 */
export function injectIntoOpenAIBody(body: Record<string, unknown>, rendered: string): boolean {
  if (!rendered) return false;

  const messages = Array.isArray(body.messages) ? ([...body.messages] as LoosyMessage[]) : [];
  const head = messages[0];
  if (head && head.role === "system" && typeof head.content === "string") {
    messages[0] = {
      ...head,
      content: head.content.trim() ? `${head.content}\n\n${rendered}` : rendered,
    };
  } else {
    messages.unshift({ role: "system", content: rendered });
  }

  body.messages = messages;
  return true;
}

/** 协议判别结果：决定注入落在 body.system 还是 body.messages。 */
export type PromptBodyShape = "anthropic" | "openai";

/**
 * 判别请求体形态，决定提示词注入的目标字段。
 *
 * 判别依据是「上游请求体的结构」而非客户端协议 —— 因为同一份 body 会在
 * dispatch 里被转译成不同的上游形态：
 *   - 存在 `system` 字段（string 或内容块数组）→ Anthropic 形态
 *   - 否则有 `messages` 数组                 → OpenAI 形态
 *   - 两者都不满足                            → 兜底 OpenAI（新建 system 消息）
 *
 * 关键点：**必须二选一**。若同时跑两套注入器，Anthropic 形态的 body 会被
 * 额外塞进一条 system 消息（双重注入），OpenAI 形态的 body 会被凭空加上
 * `system` 字段。因此对外只暴露本函数做分发。
 */
export function detectPromptBodyShape(body: Record<string, unknown>): PromptBodyShape {
  const sys = body.system;
  if (typeof sys === "string" || Array.isArray(sys)) return "anthropic";
  return "openai";
}

/**
 * 按 body 形态选择唯一注入路径，把渲染后的提示词追加进请求体（原地改写浅拷贝）。
 * @returns 是否真的发生了注入。
 */
export function injectRoutePrompt(body: Record<string, unknown>, rendered: string): boolean {
  if (!rendered) return false;
  return detectPromptBodyShape(body) === "anthropic"
    ? injectIntoAnthropicBody(body, rendered)
    : injectIntoOpenAIBody(body, rendered);
}
