/**
 * F3 回归验证：formatOpenAIToAnthropicJson 必须把流式 delta.tool_calls 聚合进 Anthropic tool_use 块。
 *
 * 修复前：只聚合 delta.content/reasoning，tool_calls 完全丢弃 → 输出中无 tool_use。
 * 修复后：按 index 归并（首帧 id/name，后续仅 arguments 片段）→ 输出含完整 tool_use。
 *
 * 运行：bun run scripts/verify-f3-tool-calls.ts
 */
import { formatOpenAIToAnthropicJson } from "../src/lib/gateway/exchange/stream";

function sse(lines: string[]): Response {
  const body = lines.join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 典型 OpenAI 流式工具调用：第 1 帧带 id/name，第 2/3 帧只带 arguments 片段（分片到达） */
const upstream = sse([
  `data: ${JSON.stringify({
    id: "chatcmpl-f3",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } },
          ],
        },
      },
    ],
  })}\n\n`,
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }],
  })}\n\n`,
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }] } }],
  })}\n\n`,
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })}\n\n`,
  "data: [DONE]\n\n",
]);

const res = await formatOpenAIToAnthropicJson(upstream, "claude-3-5-sonnet", {}, null);
const json = (await res.json()) as {
  content?: Array<{ type: string; name?: string; input?: unknown; id?: string }>;
  stop_reason?: string;
};

const toolUses = (json.content ?? []).filter((b) => b.type === "tool_use");
const blocks = json.content ?? [];

console.log("blocks:", JSON.stringify(blocks, null, 2));
console.log("stop_reason:", json.stop_reason);

let failed = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
}

check("存在 tool_use 块（修复前为 0）", toolUses.length === 1);
check("工具名保持 get_weather", toolUses[0]?.name === "get_weather");
check("tool_use id 保持 call_abc", toolUses[0]?.id === "call_abc");
check(
  "参数分片被完整拼接为 {city: Tokyo}",
  JSON.stringify(toolUses[0]?.input) === JSON.stringify({ city: "Tokyo" })
);
check("stop_reason 映射为 tool_use", json.stop_reason === "tool_use");

// 回归面：纯文本流仍正常工作（不应因本次改动回归）
const textOnly = await formatOpenAIToAnthropicJson(
  sse([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hello " } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "world" }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]),
  "claude-3-5-sonnet",
  {},
  null
);
const textJson = (await textOnly.json()) as { content?: Array<{ type: string; text?: string }> };
check(
  "纯文本流未回归（text 块拼接正确）",
  (textJson.content ?? []).some((b) => b.type === "text" && b.text === "hello world")
);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
