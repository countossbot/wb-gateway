// Mock OpenAI 兼容上游 —— 网关端到端冒烟验证专用（端口固定 3040）。
// 能力：
//   POST /v1/chat/completions：stream=false 返回标准 chat.completion JSON；
//     stream=true 返回 SSE（先 reasoning_content 思维链、再 content 正文、带 usage cached_tokens、[DONE] 收尾）
//   GET /v1/models：返回模型目录
//   可控失败：header X-Mock-Status: 429 → 返回 429（验证网关冷却与故障转移）
//   v4.2.2 多账号池验证：
//     Authorization: Bearer <key> 感知 —— key 前缀注入失败 / 指纹 echo / per-key 计数
//     sk-bad-*   → 401 invalid_api_key（验证网关账号级切换 + 冷却）
//     sk-quota-* → 429 quota exceeded（验证惩罚性退避）
//     正常 key → 响应正文附 [key:后4位] 指纹（验证轮换落点均匀）
//     GET /__stats 返回 { cancelledCount, perKey, lastChatRequest }
//     POST /__stats/reset 清零（测试隔离）
//   v4.6.0 Responses 入站端点验证支撑：
//     严格 tool_calls 配对校验（复刻真实严格上游 11148 tool_call_sequence_broken 行为）：
//       - 悬空 tool_call（无结果）/ 孤儿 tool 结果 / 重复应答 / 未应答即转入下一条消息 → 400 code 11148
//     tool_choice 强制形态 + 无 tools 声明 → 400（复刻「无工具请求 + 强制 tool_choice」非法形态拒绝）
//     lastChatRequest 回显：最近一次 chat 请求的 {model, messages, tools, tool_choice, stream}（字节级断言网关转译产物）
//     用户文本含 USE_CUSTOM_TOOL → 返回 apply_patch 工具调用（custom 工具回译验证）
const PORT = 3040;

// v4.2.0：网关停滞熔断 cancel 计数（GET /__stats 查询，验证级联取消生效）
let cancelledCount = 0;
// v4.2.2：per-key 请求计数（验证多账号轮换均匀性）
const perKeyCounts = new Map<string, number>();
// v4.6.0：最近一次 chat 请求回显（网关转译产物字节级断言）
let lastChatRequest: Record<string, unknown> | null = null;

/** v4.6.0：严格 tool_calls 配对校验（复刻真实严格上游行为 —— 网关 Responses 转译层修复验证的裁判） */
function validateToolCallSequence(body: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { ok: true };

  const pending = new Set<string>(); // 已声明未应答的 tool_call id
  for (const m of messages as Array<Record<string, unknown>>) {
    const role = m?.role;
    if (role === "tool") {
      const callId = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      if (!callId || !pending.has(callId)) {
        return {
          ok: false,
          message: "tool calls and tool results do not match, please start a new conversation and retry",
        };
      }
      pending.delete(callId);
      continue;
    }
    // 任何非 tool 消息出现时，此前声明的 tool_call 必须全部已应答（严格形态）
    if (pending.size > 0) {
      return {
        ok: false,
        message: "tool calls and tool results do not match, please start a new conversation and retry",
      };
    }
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ id?: string }>) {
        if (tc?.id) pending.add(tc.id);
      }
    }
  }
  if (pending.size > 0) {
    return { ok: false, message: "tool calls and tool results do not match, please start a new conversation and retry" };
  }
  return { ok: true };
}

/** v4.6.0：「无工具请求 + 强制 tool_choice」非法形态拒绝（网关 tool_choice 降级验证的裁判） */
function toolChoiceViolatesNoTools(body: Record<string, unknown>): boolean {
  const toolsDeclared = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0;
  if (toolsDeclared) return false;
  const tc = body.tool_choice;
  return tc === "required" || (tc !== null && typeof tc === "object");
}

function bearerKey(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : "";
}

function keyFingerprint(key: string): string {
  return key.length > 4 ? key.slice(-4) : key || "none";
}

function stallMsCap(ms: number): number {
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 600_000) : 0;
}

const server = Bun.serve({
  port: PORT,
  // v4.2.0：Bun.serve 默认 idleTimeout=10s —— 流式验证时上游静默（STALL 注入）10s 即被
  // Bun 杀连接，干扰网关侧停滞熔断测试（会被误判为网关 10s 断流）。放宽到上限 255s。
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          { id: "mock-chat", object: "model", created: 1700000000, owned_by: "mock" },
          { id: "mock-chat-free", object: "model", created: 1700000000, owned_by: "mock" },
        ],
      });
    }

    if (req.method === "GET" && url.pathname === "/__stats") {
      return Response.json({ cancelledCount, perKey: Object.fromEntries(perKeyCounts), lastChatRequest });
    }

    if (req.method === "POST" && url.pathname === "/__stats/reset") {
      cancelledCount = 0;
      perKeyCounts.clear();
      lastChatRequest = null;
      return Response.json({ ok: true });
    }

    // v4.2.2：Anthropic 原生 /v1/messages 端点（x-api-key 感知，与 chat 端点同款 key 行为）
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const apiKey = req.headers.get("x-api-key") || "";
      if (apiKey) perKeyCounts.set(apiKey, (perKeyCounts.get(apiKey) || 0) + 1);
      if (apiKey.startsWith("sk-bad")) {
        return Response.json(
          { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${apiKey.slice(0, 8)}***` } },
          { status: 401 }
        );
      }
      if (apiKey.startsWith("sk-quota")) {
        return Response.json(
          { type: "error", error: { type: "rate_limit_error", message: `quota exceeded for ${apiKey.slice(0, 8)}***` } },
          { status: 429 }
        );
      }
      const body = await req.json().catch(() => ({}));
      const userText = extractUserText(body.messages);
      return Response.json({
        id: "msg_mock_" + Date.now(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: `Hello from mock anthropic! [key:${keyFingerprint(apiKey)}] You said: ${userText.slice(0, 60)}` }],
        model: body.model || "mock-anthropic",
        stop_reason: "end_turn",
        usage: { input_tokens: 25, output_tokens: 12 },
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      // v4.2.2：per-key 计数（轮换均匀性验证；所有 chat 请求都计入，包括失败注入路径）
      const apiKey = bearerKey(req);
      if (apiKey) perKeyCounts.set(apiKey, (perKeyCounts.get(apiKey) || 0) + 1);

      // 可控失败注入：验证网关 classify 冷却 / failover
      const mockStatus = req.headers.get("x-mock-status");
      if (mockStatus) {
        return Response.json(
          { error: { message: `mock injected failure ${mockStatus}` } },
          { status: Number(mockStatus) }
        );
      }

      // v4.2.2：按 key 前缀注入失败（多账号池切换/冷却验证）
      if (apiKey.startsWith("sk-bad")) {
        return Response.json(
          { error: { type: "invalid_api_key", message: `Incorrect API key provided: ${apiKey.slice(0, 8)}***` } },
          { status: 401 }
        );
      }
      if (apiKey.startsWith("sk-quota")) {
        return Response.json(
          { error: { type: "insufficient_quota", message: `You exceeded your current quota for ${apiKey.slice(0, 8)}***` } },
          { status: 429 }
        );
      }

      const body = await req.json().catch(() => ({}));
      const model = body.model || "mock-chat";

      // v4.6.0：lastChatRequest 回显（验证后立即查询断言网关转译产物；失败路径也回显便于排障）
      lastChatRequest = {
        model,
        messages: body.messages,
        tools: body.tools ?? null,
        tool_choice: body.tool_choice ?? null,
        stream: body.stream === true,
      };

      // v4.6.0：严格 tool_calls 配对校验（11148 行为复刻 —— Responses 转译层规范形态的裁判）
      const seq = validateToolCallSequence(body);
      if (!seq.ok) {
        return Response.json(
          { code: 11148, extError: { code: "tool_call_sequence_broken", message: seq.message } },
          { status: 400 }
        );
      }
      // v4.6.0：「无工具请求 + 强制 tool_choice」非法形态拒绝（网关 tool_choice 降级的裁判）
      if (toolChoiceViolatesNoTools(body)) {
        return Response.json(
          {
            code: 11148,
            extError: {
              code: "tool_choice_without_tools",
              message: "tool_choice is forced but no tools are declared; remove tool_choice or declare tools",
            },
          },
          { status: 400 }
        );
      }

      // 模型名触发失败：fail429-* → 429（验证候选级故障转移与冷却分类）
      if (model.startsWith("fail429-")) {
        return Response.json(
          { error: { message: "mock rate limit hit for " + model } },
          { status: 429 }
        );
      }
      if (model.startsWith("fail500-")) {
        return Response.json(
          { error: { message: "mock server error for " + model } },
          { status: 500 }
        );
      }
      const userText = extractUserText(body.messages);
      // v4.2.2：响应正文附 key 指纹（客户端可断言轮换落点）
      const keyTag = `[key:${keyFingerprint(apiKey)}]`;
      // OpenAI 规范：stream 默认 false，显式 stream === true 才流式
      // （v3.0.8 修复：旧实现 `!== false` 把省略 stream 的请求也当流式，偏离规范默认值）
      const stream = body.stream === true;

      if (!stream) {
        // 非流式：标准 chat.completion（带 tool_calls 若用户文本包含 "USE_TOOL"）
        const message: Record<string, unknown> = {
          role: "assistant",
          content: `Hello from mock upstream! ${keyTag} You said: ${userText.slice(0, 80)}`,
        };
        let finish = "stop";
        if (userText.includes("USE_TOOL")) {
          message.tool_calls = [
            {
              id: "call_mock_1",
              type: "function",
              function: { name: "get_weather", arguments: JSON.stringify({ city: "Beijing" }) },
            },
          ];
          message.content = null;
          finish = "tool_calls";
        } else if (userText.includes("USE_CUSTOM_TOOL")) {
          // v4.6.0：custom(freeform) 工具调用回放（Responses 回译 custom_tool_call 项验证）
          message.tool_calls = [
            {
              id: "call_mock_2",
              type: "function",
              function: { name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) },
            },
          ];
          message.content = null;
          finish = "tool_calls";
        }
        return Response.json({
          id: "chatcmpl-mock-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 13,
            total_tokens: 55,
            prompt_tokens_details: { cached_tokens: 20 }, // 供网关前缀缓存统计
          },
        });
      }

      // 流式 SSE：thinking → text → [DONE]
      // 可控静默注入（v4.2.0 SSE 验证）：用户文本含 STALL:<ms> → 发送首帧后静默该时长再继续
      //（模拟长思考模型 / 上游卡死；网关侧验证保活 ping 与停滞熔断。用消息内容而非 header
      //  触发 —— 网关不透传客户端自定义 header，但消息体会原样到达上游）
      // ⚠️ Bun 1.3.14 实测（2026-09-20 排障）：async start() 内 await 后再 enqueue 会停滞
      //（首帧后挂死，直连 curl / bun fetch 均只收到首帧；旧实现因此全流卡死）。
      // 改用「定时器外部 enqueue」：start() 同步返回，帧调度由 setTimeout 链驱动
      //（网关 passthrough 的 ping 定时器同款模式，实测可靠）；cancel() 清理挂起定时器。
      const stallMatch = /STALL:(\d{1,6})/.exec(userText);
      const stallMs = stallMsCap(Number(stallMatch ? stallMatch[1] : 0));
      const encoder = new TextEncoder();
      const chunks: Array<Record<string, unknown>> = [
        { choices: [{ delta: { reasoning_content: "Let me think about the request... " } }] },
        { choices: [{ delta: { reasoning_content: "mock thinking done." } }] },
        { choices: [{ delta: { content: `Hello from mock upstream stream! ${keyTag} You said: ${userText.slice(0, 60)}` } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 13, prompt_tokens_details: { cached_tokens: 20 } } },
      ];
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
      let frameTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      const finishStream = () => {
        if (closed) return;
        closed = true;
        if (frameTimer) clearTimeout(frameTimer);
        try { ctrl?.close(); } catch { /* 已关闭 */ }
      };
      const sendFrame = (payload: string) => {
        if (closed || !ctrl) return;
        try { ctrl.enqueue(encoder.encode(`data: ${payload}\n\n`)); } catch { closed = true; }
      };
      const pump = (i: number) => {
        if (closed || !ctrl) return;
        if (i >= chunks.length) {
          sendFrame("[DONE]");
          finishStream();
          return;
        }
        sendFrame(JSON.stringify(chunks[i]));
        // 首帧后注入可控静默（上游字节间隔模拟）；其余帧 30ms 间隔保持节奏
        const gap = stallMs > 0 && i === 0 ? stallMs : 30;
        frameTimer = setTimeout(() => pump(i + 1), gap);
      };
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          ctrl = controller;
          pump(0);
        },
        cancel() {
          // 网关停滞熔断会 cancel 上游流：清理挂起定时器并计数验证
          closed = true;
          if (frameTimer) clearTimeout(frameTimer);
          cancelledCount++;
        },
      });
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    return Response.json({ error: { message: "not found" } }, { status: 404 });
  },
});

function extractUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role === "user") {
      return typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    }
  }
  return "";
}

console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}`);
export default server;
