// responses-tool-translate-regression.ts
// 嵌套 function 工具必须保留；指定函数的 tool_choice 必须变成 string，不能变成对象。

import { translateResponsesRequest } from "../src/lib/gateway/responses/translate";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " —— " + detail : ""}`); }
}

const weatherParams = { type: "object", properties: { city: { type: "string" } } };

const nested = translateResponsesRequest({
  model: "m",
  input: "Tokyo weather",
  tools: [{
    type: "function",
    function: { name: "get_weather", description: "weather", parameters: weatherParams },
  }],
  tool_choice: { type: "function", name: "get_weather" },
});
const nestedTools = nested.chatBody.tools as Array<{ function: { name: string; description: string; parameters: unknown } }>;
check("嵌套工具不被丢掉", nested.droppedTools.length === 0 && nestedTools?.length === 1, JSON.stringify(nested.droppedTools));
check("嵌套工具读到 function.name", nestedTools?.[0]?.function.name === "get_weather");
check("嵌套工具带上 parameters", JSON.stringify(nestedTools?.[0]?.function.parameters) === JSON.stringify(weatherParams));
check("指定函数 tool_choice 是字符串 required", nested.chatBody.tool_choice === "required", JSON.stringify(nested.chatBody.tool_choice));

const two = translateResponsesRequest({
  model: "m",
  input: "go",
  tools: [
    { type: "function", name: "get_weather", parameters: weatherParams },
    { type: "function", name: "get_time", parameters: { type: "object", properties: {} } },
  ],
  tool_choice: { type: "function", function: { name: "get_time" } },
});
const twoTools = two.chatBody.tools as Array<{ function: { name: string } }>;
check("多工具时只留下被点名的工具", twoTools?.length === 1 && twoTools[0]?.function.name === "get_time", JSON.stringify(twoTools));
check("嵌套 tool_choice 也是 required", two.chatBody.tool_choice === "required");

const kept = translateResponsesRequest({
  model: "m",
  input: "go",
  tools: [
    { type: "function", name: "get_weather", description: "w", parameters: weatherParams },
    { type: "function", name: "get_time", parameters: { type: "object", properties: {} } },
  ],
  tool_choice: "required",
});
const keptTools = kept.chatBody.tools as unknown[];
check("字符串 required 不改写、不删工具", kept.chatBody.tool_choice === "required" && keptTools.length === 2);

const unnamed = translateResponsesRequest({
  model: "m",
  input: "go",
  tools: [{ type: "function", description: "no name" }],
});
check("真的无名函数仍然剥离", unnamed.droppedTools.includes("function(unnamed)") && unnamed.chatBody.tools === undefined);

const loop = translateResponsesRequest({
  model: "m",
  input: [
    { type: "message", role: "user", content: "weather in Tokyo" },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
    { type: "function_call_output", call_id: "call_1", output: "sunny" },
  ],
  tools: [{ type: "function", name: "get_weather", parameters: weatherParams }],
});
const messages = loop.chatBody.messages as Array<Record<string, unknown>>;
const assistant = messages.find((m) => Array.isArray(m.tool_calls));
const toolMsg = messages.find((m) => m.role === "tool");
const call = (assistant?.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined)?.[0];
check("function_call 回放成 assistant tool_call", call?.id === "call_1" && call.function.name === "get_weather" && call.function.arguments === "{\"city\":\"Tokyo\"}");
check("function_call_output 用同一个 call_id", toolMsg?.tool_call_id === "call_1" && toolMsg?.content === "sunny");

const custom = translateResponsesRequest({
  model: "m",
  input: "note this",
  tools: [{ type: "custom", name: "note", description: "freeform" }],
  tool_choice: { type: "custom", name: "note" },
});
const customTool = (custom.chatBody.tools as Array<{ function: { name: string; parameters: { properties?: { input?: unknown } } } }>)?.[0];
check("custom 工具合成 input 参数", customTool?.function.name === "note" && !!customTool?.function.parameters?.properties?.input);
check("custom tool_choice 也是 required", custom.chatBody.tool_choice === "required");

console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
