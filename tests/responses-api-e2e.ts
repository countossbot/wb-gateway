// v4.6.0 QA：/v1/responses 入站端点 —— Responses→Chat Completions 转译层端到端实测
// 规程：自建测试中转/路由/密钥（qa-resp-*，经 mock-upstream 3040 零真实计费）→ 网关真实调用 →
//       服务端工具剥离/tool_choice 降级/规范形态修复逐项断言 → 全部自清理 → healthz 等价核对
// mock-upstream v4.6.0 扮演「严格校验上游」：tool_calls 配对破坏 → 400 code 11148；
// 无工具强制 tool_choice → 400 —— 是本测试的裁判（修复前必 400 的行为复刻）。
// 验证点：
//   A. web_search 等服务端工具降级：剥离后 200（修复前 400）+ X-Gateway-Dropped-Tools 头
//      （流式/非流式均携带）+ mock 收到的 tools 已无 web_search + tool_choice 降级 auto
//   B. 六项序列用例全 200：custom_tool_call 配对 / 悬空 function_call 合成补齐 /
//      并行调用相邻合并 / 孤儿 tool 结果丢弃 / local_shell_call 配对 / 回归不受影响
//   C. 守卫回归：previous_response_id 400 / item_reference 400 / input 缺失 400 /
//      错误密钥 401 / function·custom 工具调用环回（Responses output item 形态）
//   D. 负对照：坏形态直打 mock → 400/11148（证明裁判生效，「修复前」行为可复现）
const BASE = "http://127.0.0.1:3000";
const MOCK = "http://127.0.0.1:3040";

const login = await fetch(`${BASE}/api/console/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "gateway-admin-2026" }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
console.log("login:", login.status);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " —— " + detail : ""}`); }
};

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });

const postResponses = (body: unknown, key: string) =>
  fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const mockStats = async () => {
  const r = await fetch(`${MOCK}/__stats`);
  return (await r.json()) as { lastChatRequest: Record<string, unknown> | null };
};

// ---- 0. 前置：healthz 基线 + mock 复位 ----
const healthzBefore = await (await fetch(`${BASE}/healthz`)).json();
console.log("healthz before:", JSON.stringify(healthzBefore));
await fetch(`${MOCK}/__stats/reset`, { method: "POST" });

// ---- 预清理（幂等重跑保障）：历史轮次残留先删 ----
{
  const staleRoutes = await db.modelRoute.findMany({ where: { model: { startsWith: "qa-resp-" } } });
  for (const r of staleRoutes) {
    const res = await fetch(`${BASE}/api/console/routes?model=${r.model}`, { method: "DELETE", headers: { cookie } });
    console.log(`pre-clean route ${r.model}:`, res.status);
  }
  const staleProvs = await db.provider.findMany({ where: { id: { startsWith: "qa-resp-" } } });
  for (const p of staleProvs) {
    const res = await fetch(`${BASE}/api/console/providers?id=${p.id}`, { method: "DELETE", headers: { cookie } });
    console.log(`pre-clean provider ${p.id}:`, res.status);
  }
  const staleKeys = await db.virtualKey.findMany({ where: { name: { startsWith: "qa-resp-key" } } });
  for (const k of staleKeys) {
    const res = await fetch(`${BASE}/api/console/keys?id=${k.id}`, { method: "DELETE", headers: { cookie } });
    console.log(`pre-clean key ${k.name}:`, res.status);
  }
}

// ---- 自建测试资产 ----
const provRes = await post("/api/console/providers", {
  id: "qa-resp", name: "qa-resp", type: "openai", enabled: true,
  config: { baseUrl: `${MOCK}/v1`, apiKey: "sk-qa-resp-upstream" },
});
console.log("create qa-resp provider:", provRes.status);
const routeRes = await post("/api/console/routes", {
  model: "qa-resp-model", candidates: [{ providerId: "qa-resp", model: "mock-chat" }],
});
console.log("create qa-resp-model route:", routeRes.status);
const keyRes = await post("/api/console/keys", { name: "qa-resp-key", models: ["*"] });
const keyJson = await keyRes.json() as { data?: { keyValue?: string } };
const KEY = keyJson.data?.keyValue || "";
check("虚拟密钥创建", !!KEY, JSON.stringify(keyJson).slice(0, 200));

const weatherFn = { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

try {
  // ================= D. 负对照：裁判生效证明（坏形态直打 mock = 修复前行为复现） =================
  console.log("\n[D] 负对照：mock 严格校验（11148 行为复刻）");
  {
    const r1 = await fetch(`${MOCK}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-qa-resp-upstream" },
      body: JSON.stringify({ model: "mock-chat", messages: [
        { role: "user", content: "hi" },
        { role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "assistant", tool_calls: [{ id: "b", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "a", content: "r1" },
        { role: "tool", tool_call_id: "b", content: "r2" },
      ] }),
    });
    const j1 = await r1.json() as { code?: number; extError?: { code?: string } };
    check("相邻单条 assistant tool_call（未合并形态）→ 400/11148", r1.status === 400 && j1.code === 11148 && j1.extError?.code === "tool_call_sequence_broken", JSON.stringify(j1).slice(0, 160));

    const r2 = await fetch(`${MOCK}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-qa-resp-upstream" },
      body: JSON.stringify({ model: "mock-chat", tool_choice: "required", messages: [{ role: "user", content: "hi" }] }),
    });
    const j2 = await r2.json() as { code?: number; extError?: { code?: string } };
    check("无工具强制 tool_choice → 400/11148", r2.status === 400 && j2.code === 11148 && j2.extError?.code === "tool_choice_without_tools", JSON.stringify(j2).slice(0, 160));
  }

  // ================= A. 服务端工具剥离 + 可观测降级 =================
  console.log("\n[A] web_search 服务端工具剥离（降级而非拒绝）");
  {
    // A1 复现请求：tools 含 web_search + 一个 function 工具 —— 修复前 400，修复后 200 + 头
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [{ type: "web_search" }, weatherFn],
      input: [userMsg("What is the weather in Beijing?")],
    }, KEY);
    check("A1 HTTP 200（修复前 400）", r.status === 200, `${r.status}`);
    check("A1 X-Gateway-Dropped-Tools: web_search", r.headers.get("x-gateway-dropped-tools") === "web_search", String(r.headers.get("x-gateway-dropped-tools")));
    const body = await r.json() as Record<string, any>;
    check("A1 合法 Responses response 对象", body.object === "response" && typeof body.id === "string" && body.id.startsWith("resp_") && body.status === "completed", JSON.stringify(body).slice(0, 160));
    const msgItem = (body.output || []).find((i: any) => i.type === "message");
    check("A1 output message 项 + output_text 含 mock 应答", msgItem?.content?.[0]?.type === "output_text" && String(msgItem.content[0].text).includes("Hello from mock upstream"), JSON.stringify(body.output || []).slice(0, 200));
    check("A1 usage 映射（input 42 / total 55）", body.usage?.input_tokens === 42 && body.usage?.total_tokens === 55, JSON.stringify(body.usage));
    check("A1 model 回显", body.model === "qa-resp-model", String(body.model));
    // mock 侧字节级断言：上游收到的 tools 已剥离 web_search
    const stats = await mockStats();
    const toolsSeen = stats.lastChatRequest?.tools as Array<any> | null;
    check("A1 上游收到 tools 仅剩 function（web_search 已剥离）", Array.isArray(toolsSeen) && toolsSeen.length === 1 && toolsSeen[0]?.type === "function" && toolsSeen[0]?.function?.name === "get_weather", JSON.stringify(toolsSeen));
    check("A1 上游收到 instructions→messages 形态合法", Array.isArray(stats.lastChatRequest?.messages) && (stats.lastChatRequest?.messages as any[]).length >= 1, JSON.stringify(stats.lastChatRequest?.messages || []).slice(0, 120));
  }
  {
    // A2 stream:true 同配置 —— SSE 事件序列完整 + header 同样携带
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [{ type: "web_search" }, weatherFn],
      input: [userMsg("Stream test with web_search degradation")],
      stream: true,
    }, KEY);
    check("A2 HTTP 200 + text/event-stream", r.status === 200 && (r.headers.get("content-type") || "").includes("text/event-stream"), `${r.status} ${r.headers.get("content-type")}`);
    check("A2 流式响应头 X-Gateway-Dropped-Tools: web_search", r.headers.get("x-gateway-dropped-tools") === "web_search", String(r.headers.get("x-gateway-dropped-tools")));
    const raw = await r.text();
    // 解析 SSE：event 行序列 + data JSON type 一致性
    const events: string[] = [];
    const dataByEvent = new Map<string, any[]>();
    for (const block of raw.split("\n\n")) {
      const evLine = block.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!evLine || !dataLine) continue;
      const ev = evLine.slice(6).trim();
      events.push(ev);
      try {
        const payload = JSON.parse(dataLine.slice(5).trim());
        if (!dataByEvent.has(ev)) dataByEvent.set(ev, []);
        dataByEvent.get(ev)!.push(payload);
      } catch { /* 忽略非 JSON 帧（keep-alive 注释等） */ }
    }
    check("A2 事件序列以 response.created 开始、response.completed 结束", events[0] === "response.created" && events[events.length - 1] === "response.completed", events.join(","));
    check("A2 含 output_item.added → delta(s) → output_item.done 完整链", events.includes("response.output_item.added") && events.includes("response.output_text.delta") && events.includes("response.output_text.done") && events.includes("response.output_item.done"), events.join(","));
    const deltas = (dataByEvent.get("response.output_text.delta") || []).map((d) => String(d.delta || ""));
    check("A2 delta 内容含 mock 流式应答", deltas.join("").includes("Hello from mock upstream stream"), deltas.join("").slice(0, 80));
    const completed = (dataByEvent.get("response.completed") || [])[0];
    check("A2 completed 事件含完整 response（usage + output）", completed?.response?.status === "completed" && completed?.response?.usage?.input_tokens === 42 && Array.isArray(completed?.response?.output), JSON.stringify(completed?.response?.usage));
    check("A2 created 事件含 resp_ id", String((dataByEvent.get("response.created") || [])[0]?.response?.id || "").startsWith("resp_"));
    const stats = await mockStats();
    const toolsSeen = stats.lastChatRequest?.tools as Array<any> | null;
    check("A2 上游收到 tools 仅剩 function + stream=true", Array.isArray(toolsSeen) && toolsSeen.length === 1 && stats.lastChatRequest?.stream === true, JSON.stringify({ tools: toolsSeen, stream: stats.lastChatRequest?.stream }));
  }
  {
    // A3 剥离后无剩余工具 + 强制 tool_choice → 降级 auto（mock 裁判：required+无 tools = 400）
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      input: [userMsg("No tools left after stripping")],
    }, KEY);
    check("A3 HTTP 200（tool_choice 已降级，修复前上游 400）", r.status === 200, `${r.status}`);
    check("A3 X-Gateway-Dropped-Tools: web_search", r.headers.get("x-gateway-dropped-tools") === "web_search", String(r.headers.get("x-gateway-dropped-tools")));
    const stats = await mockStats();
    check("A3 上游收到 tools=null + tool_choice=auto", stats.lastChatRequest?.tools === null && stats.lastChatRequest?.tool_choice === "auto", JSON.stringify({ tools: stats.lastChatRequest?.tools, tool_choice: stats.lastChatRequest?.tool_choice }));
  }
  {
    // A4 五类服务端工具全量剥离 + 头清单顺序
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [{ type: "code_interpreter" }, { type: "computer_use_preview" }, { type: "web_search_preview" }, weatherFn],
      input: [userMsg("All server-side tools")],
    }, KEY);
    check("A4 HTTP 200", r.status === 200, `${r.status}`);
    check("A4 头清单按出现顺序", r.headers.get("x-gateway-dropped-tools") === "code_interpreter, computer_use_preview, web_search_preview", String(r.headers.get("x-gateway-dropped-tools")));
    const stats = await mockStats();
    const toolsSeen = stats.lastChatRequest?.tools as Array<any> | null;
    check("A4 上游仅剩 function 工具", Array.isArray(toolsSeen) && toolsSeen.length === 1 && toolsSeen[0]?.function?.name === "get_weather", JSON.stringify(toolsSeen));
  }

  // ================= B. tool_call 序列修复（六项全 200） =================
  console.log("\n[B] tool_call 序列统一修复通道（规范形态产出）");
  {
    // B1 custom_tool_call + custom_tool_call_output 配对回放（原复现用例）
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "text" } }],
      input: [
        userMsg("Please apply a patch"),
        { type: "custom_tool_call", call_id: "cust1", name: "apply_patch", input: "*** Begin Patch\n*** Update File: main.rs\n*** End Patch" },
        { type: "custom_tool_call_output", call_id: "cust1", output: "Done! Patch applied." },
        userMsg("Continue"),
      ],
    }, KEY);
    check("B1 HTTP 200（修复前 400/11148 孤儿结果）", r.status === 200, `${r.status} ${JSON.stringify(await r.clone().text()).slice(0, 120)}`);
    const stats = await mockStats();
    const msgs = stats.lastChatRequest?.messages as Array<any> || [];
    const asst = msgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    const toolMsg = msgs.find((m) => m.role === "tool");
    check("B1 custom_tool_call → assistant tool_call（arguments 为 {\"input\": <文本>} JSON 形态）",
      asst?.tool_calls?.[0]?.id === "cust1" && asst?.tool_calls?.[0]?.function?.name === "apply_patch" &&
      (() => { try { return JSON.parse(asst.tool_calls[0].function.arguments).input === "*** Begin Patch\n*** Update File: main.rs\n*** End Patch"; } catch { return false; } })(),
      JSON.stringify(asst?.tool_calls || []).slice(0, 200));
    check("B1 custom_tool_call_output → role:tool（call_id 对应）", toolMsg?.tool_call_id === "cust1" && toolMsg?.content === "Done! Patch applied.", JSON.stringify(toolMsg || {}).slice(0, 160));
  }
  {
    // B2 悬空 function_call（无结果）→ 合成结果补齐
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [weatherFn],
      input: [
        userMsg("Check weather"),
        { type: "function_call", call_id: "fn1", name: "get_weather", arguments: "{\"city\":\"Beijing\"}" },
        userMsg("Actually never mind, just say hi"),
      ],
    }, KEY);
    check("B2 HTTP 200（修复前 400/11148 悬空调用）", r.status === 200, `${r.status}`);
    const stats = await mockStats();
    const msgs = stats.lastChatRequest?.messages as Array<any> || [];
    const asstIdx = msgs.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    const synth = msgs[asstIdx + 1];
    check("B2 悬空 tool_call 后紧跟合成 tool 结果（诚实标注中断语义）",
      synth?.role === "tool" && synth?.tool_call_id === "fn1" && synth?.content === "tool call was interrupted before execution; no result recorded",
      JSON.stringify(synth || {}).slice(0, 160));
  }
  {
    // B3 并行调用回放：相邻两条单 tool_call assistant → 合并为一条多 tool_call 消息
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [weatherFn, { type: "function", name: "get_time", description: "Get time", parameters: { type: "object", properties: {} } }],
      input: [
        userMsg("Weather and time in Beijing"),
        { type: "function_call", call_id: "callA", name: "get_weather", arguments: "{\"city\":\"Beijing\"}" },
        { type: "function_call", call_id: "callB", name: "get_time", arguments: "{}" },
        { type: "function_call_output", call_id: "callA", output: "sunny 24C" },
        { type: "function_call_output", call_id: "callB", output: "10:00" },
        userMsg("Thanks"),
      ],
    }, KEY);
    check("B3 HTTP 200（修复前 400/11148 未应答即转入下一条 assistant）", r.status === 200, `${r.status}`);
    const stats = await mockStats();
    const msgs = stats.lastChatRequest?.messages as Array<any> || [];
    const assistantToolCallMsgs = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    check("B3 合并为单条多 tool_call assistant 消息（A,B）", assistantToolCallMsgs.length === 1 && assistantToolCallMsgs[0]?.tool_calls?.length === 2 && assistantToolCallMsgs[0]?.tool_calls?.map((t: any) => t.id).join(",") === "callA,callB", JSON.stringify(assistantToolCallMsgs.map((m: any) => m.tool_calls.map((t: any) => t.id))));
    const asstIdx = msgs.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    check("B3 规范形态 assistant([A,B]) → tool(A) → tool(B)", msgs[asstIdx + 1]?.tool_call_id === "callA" && msgs[asstIdx + 2]?.tool_call_id === "callB", `${msgs[asstIdx + 1]?.tool_call_id},${msgs[asstIdx + 2]?.tool_call_id}`);
  }
  {
    // B4 孤儿 tool 结果（ghost call_id）→ 丢弃
    const r = await postResponses({
      model: "qa-resp-model",
      input: [
        userMsg("Hi"),
        { type: "function_call_output", call_id: "ghost1", output: "boo" },
        userMsg("Hello again"),
      ],
    }, KEY);
    check("B4 HTTP 200（修复前 400/11148 孤儿结果）", r.status === 200, `${r.status}`);
    const stats = await mockStats();
    const msgs = stats.lastChatRequest?.messages as Array<any> || [];
    check("B4 孤儿结果已丢弃（上游无 role:tool 消息）", msgs.every((m) => m.role !== "tool"), JSON.stringify(msgs.map((m) => m.role)));
  }
  {
    // B5 local_shell_call + local_shell_call_output 配对回放
    const r = await postResponses({
      model: "qa-resp-model",
      tools: [{ type: "local_shell" }],
      input: [
        userMsg("Run ls"),
        { type: "local_shell_call", call_id: "shell1", action: { type: "exec", command: ["ls", "-la"] } },
        { type: "local_shell_call_output", call_id: "shell1", output: "file1 file2" },
        userMsg("Done?"),
      ],
    }, KEY);
    check("B5 HTTP 200（修复前 400/11148 shell 结果丢失同型不配对）", r.status === 200, `${r.status}`);
    check("B5 local_shell 工具声明剥离 + 头暴露", r.headers.get("x-gateway-dropped-tools") === "local_shell", String(r.headers.get("x-gateway-dropped-tools")));
    const stats = await mockStats();
    const msgs = stats.lastChatRequest?.messages as Array<any> || [];
    const asst = msgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    const toolMsg = msgs.find((m) => m.role === "tool");
    check("B5 local_shell_call → assistant tool_call（shell 函数形态）", asst?.tool_calls?.[0]?.id === "shell1" && asst?.tool_calls?.[0]?.function?.name === "shell", JSON.stringify(asst?.tool_calls || []).slice(0, 160));
    check("B5 local_shell_call_output → role:tool（call_id 对应）", toolMsg?.tool_call_id === "shell1" && toolMsg?.content === "file1 file2", JSON.stringify(toolMsg || {}).slice(0, 160));
  }

  // ================= C. 守卫回归 + 工具调用环回 =================
  console.log("\n[C] 守卫回归与工具环回");
  {
    // C1 普通请求（无工具）不受影响
    const r = await postResponses({ model: "qa-resp-model", input: "Plain hello" }, KEY);
    const body = await r.json() as Record<string, any>;
    check("C1 普通请求 200 + 合法 response 对象", r.status === 200 && body.object === "response" && body.status === "completed", `${r.status} ${JSON.stringify(body).slice(0, 120)}`);
    check("C1 无剥离时无 X-Gateway-Dropped-Tools 头", r.headers.get("x-gateway-dropped-tools") === null, String(r.headers.get("x-gateway-dropped-tools")));

    // C2 previous_response_id 守卫不放松
    const r2 = await postResponses({ model: "qa-resp-model", input: "hi", previous_response_id: "resp_abc123" }, KEY);
    const b2 = await r2.json() as { error?: { message?: string } };
    check("C2 previous_response_id → 400（守卫不放松）", r2.status === 400 && /previous_response_id/i.test(String(b2.error?.message)), `${r2.status} ${JSON.stringify(b2).slice(0, 120)}`);

    // C3 item_reference → 400
    const r3 = await postResponses({ model: "qa-resp-model", input: [{ type: "item_reference", id: "msg_ref_1" }] }, KEY);
    check("C3 item_reference → 400", r3.status === 400, `${r3.status}`);

    // C4 input 缺失 → 400
    const r4 = await postResponses({ model: "qa-resp-model" }, KEY);
    check("C4 input 缺失 → 400", r4.status === 400, `${r4.status}`);

    // C5 错误密钥 → 401
    const r5 = await postResponses({ model: "qa-resp-model", input: "hi" }, "sk-wrong-key-000");
    check("C5 错误密钥 → 401", r5.status === 401, `${r5.status}`);

    // C6 function 工具调用环回：mock USE_TOOL → chat tool_calls → Responses function_call 项
    const r6 = await postResponses({
      model: "qa-resp-model",
      tools: [weatherFn],
      input: [userMsg("USE_TOOL please")],
    }, KEY);
    const b6 = await r6.json() as Record<string, any>;
    const fcItem = (b6.output || []).find((i: any) => i.type === "function_call");
    check("C6 function 环回：output 含 function_call 项（call_id/name/arguments）",
      fcItem?.call_id === "call_mock_1" && fcItem?.name === "get_weather" && (() => { try { return JSON.parse(fcItem.arguments).city === "Beijing"; } catch { return false; } })(),
      JSON.stringify(fcItem || {}).slice(0, 200));
    check("C6 环回 status=completed", b6.status === "completed", String(b6.status));

    // C7 custom 工具环回：USE_CUSTOM_TOOL → chat tool_calls(name=apply_patch) → Responses custom_tool_call 项
    const r7 = await postResponses({
      model: "qa-resp-model",
      tools: [{ type: "custom", name: "apply_patch", description: "Apply patch", format: { type: "text" } }],
      input: [userMsg("USE_CUSTOM_TOOL please")],
    }, KEY);
    const b7 = await r7.json() as Record<string, any>;
    const ctItem = (b7.output || []).find((i: any) => i.type === "custom_tool_call");
    check("C7 custom 环回：output 含 custom_tool_call 项（input 从 {\"input\"} 参数解包）",
      ctItem?.name === "apply_patch" && String(ctItem?.input || "").includes("*** Begin Patch") && ctItem?.call_id === "call_mock_2",
      JSON.stringify(ctItem || {}).slice(0, 220));

    // C8 无路由模型 → 404（错误透传）
    const r8 = await postResponses({ model: "qa-resp-no-such-model", input: "hi" }, KEY);
    check("C8 无路由 → 404（错误透传）", r8.status === 404, `${r8.status}`);

    // C9 instructions → system 消息
    const r9 = await postResponses({ model: "qa-resp-model", instructions: "You are a helpful gateway tester.", input: "with instructions" }, KEY);
    check("C9 instructions 请求 200", r9.status === 200, `${r9.status}`);
    const stats9 = await mockStats();
    const msgs9 = stats9.lastChatRequest?.messages as Array<any> || [];
    check("C9 instructions → 首条 system 消息", msgs9[0]?.role === "system" && msgs9[0]?.content === "You are a helpful gateway tester.", JSON.stringify(msgs9[0] || {}).slice(0, 120));
  }

  // ================= E. 严格 Responses SSE 生命周期（v4.6.1） =================
  // 契约：流绝不以裸 EOF 结束 —— 任何结束路径必须先发协议终点事件
  //（completed / incomplete / failed），每个事件携带单调递增 sequence_number。
  console.log("\n[E] 严格 SSE 生命周期：终点事件保证 + sequence_number + in_progress");
  {
    const parseSse = (raw: string) => {
      const events: string[] = [];
      const payloads = new Map<string, any[]>();
      for (const block of raw.split("\n\n")) {
        const evLine = block.split("\n").find((l) => l.startsWith("event:"));
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!evLine || !dataLine) continue;
        const ev = evLine.slice(6).trim();
        events.push(ev);
        try {
          const payload = JSON.parse(dataLine.slice(5).trim());
          if (!payloads.has(ev)) payloads.set(ev, []);
          payloads.get(ev)!.push(payload);
        } catch { /* 非 JSON 帧（keep-alive 注释等） */ }
      }
      return { events, payloads };
    };

    // E1 正常流：created → in_progress 起始 + sequence_number 单调递增（起点 0）+ completed 终点
    {
      const r = await postResponses({ model: "qa-resp-model", input: [userMsg("Lifecycle normal stream")], stream: true }, KEY);
      const raw = await r.text();
      const { events, payloads } = parseSse(raw);
      check("E1 HTTP 200 + text/event-stream", r.status === 200 && (r.headers.get("content-type") || "").includes("text/event-stream"), `${r.status} ${r.headers.get("content-type")}`);
      check("E1 事件序列以 created → in_progress 起始", events[0] === "response.created" && events[1] === "response.in_progress", events.slice(0, 3).join(","));
      check("E1 终点为 response.completed", events[events.length - 1] === "response.completed", events.join(","));
      const perTypeCount = new Map<string, number>();
      const seqs: unknown[] = [];
      for (const ev of events) {
        const n = perTypeCount.get(ev) || 0;
        perTypeCount.set(ev, n + 1);
        seqs.push(payloads.get(ev)![n]?.sequence_number);
      }
      const monotonic = seqs.every((s, i) => typeof s === "number" && (i === 0 || (s as number) > (seqs[i - 1] as number)));
      check("E1 sequence_number 严格单调递增（起点 0，无缺号）", seqs[0] === 0 && monotonic, JSON.stringify(seqs));
    }

    // E2 finish_reason=length → response.incomplete 终点（incomplete_details 回明原因）
    {
      const r = await postResponses({ model: "qa-resp-model", input: [userMsg("USE_LENGTH_TRUNCATE please")], stream: true }, KEY);
      const raw = await r.text();
      const { events, payloads } = parseSse(raw);
      const inc = (payloads.get("response.incomplete") || [])[0];
      check("E2 length → 终点为 response.incomplete（非 completed）", events[events.length - 1] === "response.incomplete", events.join(","));
      check("E2 incomplete 事件含 status=incomplete + reason=max_output_tokens",
        inc?.response?.status === "incomplete" && inc?.response?.incomplete_details?.reason === "max_output_tokens",
        JSON.stringify(inc?.response?.incomplete_details));
      check("E2 无 completed 事件（截断不伪装完成）", !events.includes("response.completed"), "");
      // 非流式 parity
      const r2 = await postResponses({ model: "qa-resp-model", input: [userMsg("USE_LENGTH_TRUNCATE non-stream")] }, KEY);
      const b2 = await r2.json() as Record<string, any>;
      check("E2 非流式 length → status=incomplete + reason", b2.status === "incomplete" && b2.incomplete_details?.reason === "max_output_tokens", JSON.stringify({ status: b2.status, d: b2.incomplete_details }));
    }

    // E3 content_filter → response.incomplete（reason=content_filter）+ 非流式 parity
    {
      const r = await postResponses({ model: "qa-resp-model", input: [userMsg("USE_CONTENT_FILTER please")], stream: true }, KEY);
      const raw = await r.text();
      const { events, payloads } = parseSse(raw);
      const inc = (payloads.get("response.incomplete") || [])[0];
      check("E3 content_filter → response.incomplete（reason=content_filter）",
        events[events.length - 1] === "response.incomplete" && inc?.response?.incomplete_details?.reason === "content_filter",
        events.join(","));
      const r2 = await postResponses({ model: "qa-resp-model", input: [userMsg("USE_CONTENT_FILTER non-stream")] }, KEY);
      const b2 = await r2.json() as Record<string, any>;
      check("E3 非流式 content_filter → status=incomplete + reason", b2.status === "incomplete" && b2.incomplete_details?.reason === "content_filter", JSON.stringify({ status: b2.status, d: b2.incomplete_details }));
    }

    // E4 上游真断流（raw TCP 3041：发 2 帧后无终止块 destroy socket）→ response.failed 终点
    //    链路：undici 读异常 → passthrough 层 uag-upstream-error 标记 → 转译层 response.failed
    {
      const provRaw = await post("/api/console/providers", {
        id: "qa-resp-raw", name: "qa-resp-raw", type: "openai", enabled: true,
        config: { baseUrl: "http://127.0.0.1:3041/v1", apiKey: "sk-qa-resp-raw-upstream" },
      });
      const routeRaw = await post("/api/console/routes", {
        model: "qa-resp-raw-model", candidates: [{ providerId: "qa-resp-raw", model: "mock-chat" }],
      });
      check("E4 前置：raw 断流提供商/路由创建", provRaw.status === 200 && routeRaw.status === 200, `${provRaw.status}/${routeRaw.status}`);
      const r = await postResponses({ model: "qa-resp-raw-model", input: [userMsg("ABORT_RAW please")], stream: true }, KEY);
      const raw = await r.text();
      const { events, payloads } = parseSse(raw);
      check("E4 HTTP 200（错误在流内以 response.failed 表达而非断流）", r.status === 200, `${r.status}`);
      check("E4 终点为 response.failed", events[events.length - 1] === "response.failed", events.join(","));
      const failed = (payloads.get("response.failed") || [])[0];
      check("E4 failed 事件含 status=failed + error 信息",
        failed?.response?.status === "failed" && typeof failed?.response?.error?.message === "string" && failed.response.error.message.length > 0,
        JSON.stringify(failed?.response?.error));
      check("E4 无 completed/incomplete 事件（截断不伪装完成）", !events.includes("response.completed") && !events.includes("response.incomplete"), "");
      check("E4 已流出部分文本生命周期闭合（output_text.done 在 failed 前）",
        events.includes("response.output_text.done") && events.indexOf("response.output_text.done") < events.indexOf("response.failed"),
        events.join(","));
      check("E4 部分文本保留（raw 注入的 partial text）",
        (payloads.get("response.output_text.delta") || []).map((d: any) => String(d.delta || "")).join("").includes("partial text before"),
        "");
    }

    // E5 流内 error 帧（INBAND_ERROR：data 帧携带 {"error":{...}}）→ response.failed 终点
    {
      const r = await postResponses({ model: "qa-resp-model", input: [userMsg("INBAND_ERROR please")], stream: true }, KEY);
      const raw = await r.text();
      const { events, payloads } = parseSse(raw);
      const failed = (payloads.get("response.failed") || [])[0];
      check("E5 流内 error 帧 → 终点为 response.failed",
        events[events.length - 1] === "response.failed" && /in-band/i.test(String(failed?.response?.error?.message || "")),
        `${events.join(",")} | ${JSON.stringify(failed?.response?.error)}`);
      check("E5 error.code 透传（mock_inband）", failed?.response?.error?.code === "mock_inband", JSON.stringify(failed?.response?.error));
    }

    // E6 上游中途断流（ABORT_STREAM：Bun 将流错误转为干净 chunked 终止 → 客户端 clean EOF）
    //   → 语义：截断内容不伪装成 completed。passthrough 层补 `: uag-upstream-error` 标记，
    //     转译层据此走 response.failed 终点（绝不裸 EOF）；截断前的部分文本仍已流出。
    //   对照：真「干净 EOF 且无错误标记」由 E7 钉住，那条仍兜底 response.completed。
    {
      const r = await postResponses({ model: "qa-resp-model", input: [userMsg("ABORT_STREAM please")], stream: true }, KEY);
      const raw = await r.text();
      const { events, payloads } = parseSse(raw);
      check("E6 终点为 response.failed（截断不伪装成 completed）", events[events.length - 1] === "response.failed", events.join(","));
      const deltas = (payloads.get("response.output_text.delta") || []).map((d: any) => String(d.delta || "")).join("");
      check("E6 截断前的部分文本已流出", deltas.includes("Hello from mock upstream stream"), deltas.slice(0, 80));
      const failedE6 = (payloads.get("response.failed") || [])[0];
      check(
        "E6 failed 事件带上游截断语义",
        !!failedE6?.response?.error && /abort|截断|upstream/i.test(String(failedE6.response.error.message || "")),
        JSON.stringify(failedE6?.response?.error)
      );
    }

    // E7 干净 EOF 但无 finish 帧（正常读完、无 [DONE]、无错误标记）→ 流尾兜底 completed
    //   与 E6 的关键区别：无 `: uag-upstream-error` 标记，必须仍以 response.completed 收尾。
    {
      const r = await postResponses({ model: "qa-resp-model", input: [userMsg("CLEAN_EOF_NO_FINISH please")], stream: true }, KEY);
      const raw = await r.text();
      const { events, payloads } = parseSse(raw);
      check("E7 干净 EOF 无 finish 帧 → 终点 response.completed", events[events.length - 1] === "response.completed", events.join(","));
      const deltas = (payloads.get("response.output_text.delta") || []).map((d: any) => String(d.delta || "")).join("");
      check("E7 截断前文本已流出", deltas.includes("Hello from mock upstream stream"), deltas.slice(0, 80));
      const completedE7 = (payloads.get("response.completed") || [])[0];
      check("E7 completed 含已累积文本与 usage", completedE7?.response?.output_text === deltas && typeof completedE7?.response?.usage?.input_tokens === "number", JSON.stringify(completedE7?.response?.usage));
    }
  }
} finally {
  // ---- 清理：自建资产全删 + mock 复位 + healthz 等价 ----
  console.log("\n[F] 清理自建资产");
  const k = await db.virtualKey.findFirst({ where: { name: "qa-resp-key" } });
  if (k) {
    const d = await fetch(`${BASE}/api/console/keys?id=${k.id}`, { method: "DELETE", headers: { cookie } });
    console.log("  delete key qa-resp-key:", d.status);
  }
  const routeDel = await fetch(`${BASE}/api/console/routes?model=qa-resp-model`, { method: "DELETE", headers: { cookie } });
  console.log("  delete route qa-resp-model:", routeDel.status);
  const routeRawDel = await fetch(`${BASE}/api/console/routes?model=qa-resp-raw-model`, { method: "DELETE", headers: { cookie } });
  console.log("  delete route qa-resp-raw-model:", routeRawDel.status);
  const provDel = await fetch(`${BASE}/api/console/providers?id=qa-resp`, { method: "DELETE", headers: { cookie } });
  console.log("  delete provider qa-resp:", provDel.status);
  const provRawDel = await fetch(`${BASE}/api/console/providers?id=qa-resp-raw`, { method: "DELETE", headers: { cookie } });
  console.log("  delete provider qa-resp-raw:", provRawDel.status);
  await db.$disconnect();
  await fetch(`${MOCK}/__stats/reset`, { method: "POST" });
  const healthzAfter = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz 前后等价（providers/models 不变）",
    healthzAfter.providers_active === healthzBefore.providers_active && healthzAfter.models_available === healthzBefore.models_available,
    `${JSON.stringify(healthzBefore)} → ${JSON.stringify(healthzAfter)}`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
