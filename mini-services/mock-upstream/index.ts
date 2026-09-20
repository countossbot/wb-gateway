// Mock OpenAI 兼容上游 —— 网关端到端冒烟验证专用（端口固定 3040）。
// 能力：
//   POST /v1/chat/completions：stream=false 返回标准 chat.completion JSON；
//     stream=true 返回 SSE（先 reasoning_content 思维链、再 content 正文、带 usage cached_tokens、[DONE] 收尾）
//   GET /v1/models：返回模型目录
//   可控失败：header X-Mock-Status: 429 → 返回 429（验证网关冷却与故障转移）
const PORT = 3040;

const server = Bun.serve({
  port: PORT,
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

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      // 可控失败注入：验证网关 classify 冷却 / failover
      const mockStatus = req.headers.get("x-mock-status");
      if (mockStatus) {
        return Response.json(
          { error: { message: `mock injected failure ${mockStatus}` } },
          { status: Number(mockStatus) }
        );
      }

      const body = await req.json().catch(() => ({}));
      const model = body.model || "mock-chat";
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
      // OpenAI 规范：stream 默认 false，显式 stream === true 才流式
      // （v3.0.8 修复：旧实现 `!== false` 把省略 stream 的请求也当流式，偏离规范默认值）
      const stream = body.stream === true;

      if (!stream) {
        // 非流式：标准 chat.completion（带 tool_calls 若用户文本包含 "USE_TOOL"）
        const message: Record<string, unknown> = {
          role: "assistant",
          content: `Hello from mock upstream! You said: ${userText.slice(0, 80)}`,
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
      const encoder = new TextEncoder();
      const chunks: Array<Record<string, unknown>> = [
        { choices: [{ delta: { reasoning_content: "Let me think about the request... " } }] },
        { choices: [{ delta: { reasoning_content: "mock thinking done." } }] },
        { choices: [{ delta: { content: `Hello from mock upstream stream! You said: ${userText.slice(0, 60)}` } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ];
      const readable = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            await new Promise((r) => setTimeout(r, 30));
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 13, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
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
