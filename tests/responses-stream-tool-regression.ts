// responses-stream-tool-regression.ts
// 回归测试：验证 chatSseToResponsesStream 对 tool_calls 的处理
// 关键场景：工具名在首个片段之后才到达（DeepSeek 等常见），不应提前 emit "name":"tool"
// 要求：added/done 项使用真实 name/arguments；Responses 字段（无 function 回退字段）；无 "tool" 兜底名

import { chatSseToResponsesStream, type ResponseEchoContext } from "../src/lib/gateway/responses/respond";

const enc = (s: string) => new TextEncoder().encode(s);

async function collectOutput(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " —— " + detail : ""}`); }
}

function parseEvents(raw: string): Array<{ type: string; [k: string]: unknown }> {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const lines = raw.split("\n");
  let currentEvent: string | null = null;
  let dataBuf = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataBuf += line.slice(6);
    } else if (line === "" && currentEvent && dataBuf) {
      try {
        const payload = JSON.parse(dataBuf);
        events.push({ type: currentEvent, ...payload });
      } catch {}
      currentEvent = null;
      dataBuf = "";
    }
  }
  if (currentEvent && dataBuf) {
    try { events.push({ type: currentEvent, ...JSON.parse(dataBuf) }); } catch {}
  }
  return events;
}

// 构造最小 ctx（模拟 route.ts 中 echoContext）
const ctx: ResponseEchoContext = {
  requestId: "resp_test_tool_stream",
  model: "deepseek-v4.1-flash",
  echo: {},
  customToolNames: new Set<string>(),
  functionToolNames: new Set<string>(),
};

// 模拟 DeepSeek 风格：首个 tool fragment 只有 id，name 后到（真实 repro 场景）
const upstreamChunks = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_00_MRhKm7HAaAap588JMFKD4555"}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Beijing\\"}"}}]}}]}\n\n',
  "data: [DONE]\n\n",
];

console.log("\n[回归测试] 流式工具调用：name 延迟到达不应退化成 \"tool\"");

(async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of upstreamChunks) {
        controller.enqueue(enc(c));
      }
      controller.close();
    },
  });

  const out = await collectOutput(
    chatSseToResponsesStream(upstream, ctx, { signal: null, pingIntervalMs: 0 })
  );

  const events = parseEvents(out);

  // 收集所有 function_call 相关 item
  const addedItems = events
    .filter(e => e.type === "response.output_item.added" && (e as any).item?.type === "function_call")
    .map(e => (e as any).item);

  const doneItems = events
    .filter(e => e.type === "response.output_item.done" && (e as any).item?.type === "function_call")
    .map(e => (e as any).item);

  const argDeltas = events.filter(e => e.type === "response.function_call_arguments.delta");
  const argDones = events.filter(e => e.type === "response.function_call_arguments.done");

  // 断言 1: 至少有一个 added function_call
  check("存在 output_item.added (function_call)", addedItems.length > 0);

  // 断言 2: added 时 name 已是真实值（非 "tool"）
  const addedName = addedItems[0]?.name;
  check("added item name 为真实工具名（非 tool）", addedName === "get_weather", `name=${addedName}`);

  // 断言 3: 任何 function_call item 都不应有 "function" 字段
  const hasFunctionField = [...addedItems, ...doneItems].some(item => "function" in (item || {}));
  check("function_call 项不含 function 字段（使用 Responses 顶层 name/arguments）", !hasFunctionField);

  // 断言 4: 无任何 name === "tool"
  const hasToolName = [...addedItems, ...doneItems].some(item => item?.name === "tool");
  check("无 name=\"tool\" 兜底", !hasToolName);

  // 断言 5: done item 带完整 name + arguments
  const doneName = doneItems[0]?.name;
  const doneArgs = doneItems[0]?.arguments;
  check("done item name 正确", doneName === "get_weather", `name=${doneName}`);
  check("done item arguments 正确", doneArgs === '{"city":"Beijing"}', `arguments=${doneArgs}`);

  // 断言 6: 有 arguments delta 和 done
  check("存在 function_call_arguments.delta", argDeltas.length > 0);
  check("存在 function_call_arguments.done", argDones.length > 0);
  if (argDones.length > 0) {
    check("arguments.done 携带完整参数", (argDones[0] as any).arguments === '{"city":"Beijing"}');
  }

  // 额外：所有 function_call 事件均使用真实 name
  const allFunctionCallNames = [...addedItems, ...doneItems].map(i => i?.name);
  check("所有 function_call 事件均使用真实 name", allFunctionCallNames.every(n => n === "get_weather" || n === undefined));

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
})();
