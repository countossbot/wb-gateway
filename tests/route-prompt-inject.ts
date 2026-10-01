// v4.6.0 QA：路由级系统提示词注入 —— 纯函数级验证。
// 覆盖：
//   1. 模板变量渲染（已知变量替换 / 未知变量原样保留 / 空模板跳过）
//   2. Anthropic body.system 三种形态（string / block 数组 / 缺省）的「追加不覆盖」
//   3. OpenAI body.messages 两种形态（首条 system / 首条非 system）的「追加不覆盖」
//   4. 幂等性说明：注入基于浅拷贝，原 body 不被改写
import {
  renderRoutePrompt,
  injectIntoAnthropicBody,
  injectIntoOpenAIBody,
  injectRoutePrompt,
} from "../src/lib/gateway/exchange/promptInject.ts";
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-03-04T05:06:07.000Z");
const ctx = {
  model: "deepseek-v4.1-flash",
  provider: "workbuddy",
  upstreamModel: "deepseek-chat",
  apiKeyName: "team-a",
  now: NOW,
};

console.log("\n[1] renderRoutePrompt");

check(
  "已知变量全部替换",
  renderRoutePrompt("m={{model}} p={{provider}} u={{upstreamModel}} k={{apiKeyName}}", ctx) ===
    "m=deepseek-v4.1-flash p=workbuddy u=deepseek-chat k=team-a"
);

check(
  "未识别变量原样保留",
  renderRoutePrompt("hello {{unknown}} {{model}}", ctx) ===
    "hello {{unknown}} deepseek-v4.1-flash"
);

check("变量内允许空格", renderRoutePrompt("{{ model }}", ctx) === "deepseek-v4.1-flash");

check(
  "date/time 为本地时区格式",
  /^\d{4}-\d{2}-\d{2}$/.test(renderRoutePrompt("{{date}}", ctx)) &&
    /^\d{2}:\d{2}:\d{2}$/.test(renderRoutePrompt("{{time}}", ctx)),
  `date=${renderRoutePrompt("{{date}}", ctx)} time=${renderRoutePrompt("{{time}}", ctx)}`
);

check(
  "datetime 为 ISO 8601",
  renderRoutePrompt("{{datetime}}", ctx) === NOW.toISOString()
);

check("空模板返回空串", renderRoutePrompt("", ctx) === "");
check("纯空白模板返回空串", renderRoutePrompt("   \n\t ", ctx) === "");
check("缺失上下文变量替换为空串", renderRoutePrompt("[{{requestId}}]", ctx) === "[]");
check(
  "非 {{}} 花括号不受影响",
  renderRoutePrompt("{a} {{b} {{}} {{model}}", ctx) === "{a} {{b} {{}} deepseek-v4.1-flash"
);

console.log("\n[2] injectIntoAnthropicBody");

{
  const body: Record<string, unknown> = { system: "客户端原始提示" };
  const injected = injectIntoAnthropicBody(body, "路由注入");
  check("返回 true 表示已注入", injected === true);
  check(
    "string system 追加（原内容保留在前）",
    body.system === "客户端原始提示\n\n路由注入",
    String(body.system)
  );
}
{
  const body: Record<string, unknown> = { system: "   " };
  injectIntoAnthropicBody(body, "路由注入");
  check("空白 string system 被替换为注入内容", body.system === "路由注入", String(body.system));
}
{
  const body: Record<string, unknown> = {
    system: [{ type: "text", text: "块1", cache_control: { type: "ephemeral" } }],
  };
  injectIntoAnthropicBody(body, "路由注入");
  const sys = body.system as Array<Record<string, unknown>>;
  check("block 数组长度 +1", Array.isArray(sys) && sys.length === 2, JSON.stringify(sys));
  check("原有块与其元信息保留", sys[0].text === "块1" && !!sys[0].cache_control);
  check("新块为 text 类型且内容正确", sys[1].type === "text" && sys[1].text === "路由注入");
}
{
  const body: Record<string, unknown> = {};
  injectIntoAnthropicBody(body, "路由注入");
  check("无 system 字段时新建", body.system === "路由注入", String(body.system));
}
{
  const body: Record<string, unknown> = { system: "原始" };
  const ret = injectIntoAnthropicBody(body, "");
  check("空 rendered 不注入且返回 false", ret === false && body.system === "原始");
}

console.log("\n[3] injectIntoOpenAIBody");

{
  const body: Record<string, unknown> = {
    messages: [{ role: "system", content: "客户端原始提示" }, { role: "user", content: "hi" }],
  };
  const injected = injectIntoOpenAIBody(body, "路由注入");
  const msgs = body.messages as Array<{ role: string; content: string }>;
  check("返回 true 表示已注入", injected === true);
  check("首条 system 追加而非覆盖", msgs[0].content === "客户端原始提示\n\n路由注入", msgs[0].content);
  check("消息条数不变（未新增 system）", msgs.length === 2, String(msgs.length));
  check("后续 user 消息未被改动", msgs[1].content === "hi");
}
{
  const body: Record<string, unknown> = { messages: [{ role: "user", content: "hi" }] };
  injectIntoOpenAIBody(body, "路由注入");
  const msgs = body.messages as Array<{ role: string; content: string }>;
  check("首条非 system 时头部插入", msgs.length === 2 && msgs[0].role === "system");
  check("插入内容正确", msgs[0].content === "路由注入" && msgs[1].content === "hi");
}
{
  const body: Record<string, unknown> = {};
  injectIntoOpenAIBody(body, "路由注入");
  const msgs = body.messages as Array<{ role: string; content: string }>;
  check("无 messages 字段时新建数组", Array.isArray(msgs) && msgs.length === 1 && msgs[0].role === "system");
}
{
  const body: Record<string, unknown> = {
    messages: [{ role: "system", content: [{ type: "text", text: "blocks" }] }],
  };
  injectIntoOpenAIBody(body, "路由注入");
  const msgs = body.messages as Array<Record<string, unknown>>;
  check(
    "首条 system 但 content 为数组时，改为头部插入独立 system",
    msgs.length === 2 && msgs[0].content === "路由注入",
    JSON.stringify(msgs)
  );
}
{
  const body: Record<string, unknown> = { messages: [{ role: "system", content: "" }] };
  injectIntoOpenAIBody(body, "路由注入");
  const msgs = body.messages as Array<{ role: string; content: string }>;
  check("空 content 的 system 被替换为注入内容", msgs[0].content === "路由注入", msgs[0].content);
}

console.log("\n[4] 调用方约定：dispatch 传浅拷贝，原 body 不被改写");

{
  const original: Record<string, unknown> = { system: "原始" };
  const copy = { ...original };
  injectIntoAnthropicBody(copy, "路由注入");
  check("原对象保持不变（浅拷贝约定）", original.system === "原始", String(original.system));
  check("拷贝体已注入", copy.system === "原始\n\n路由注入");
}

console.log("\n[5] injectRoutePrompt —— 协议分发（防双重注入）");

{
  // Anthropic 形态：只应有 system 字段被追加，不得凭空多出 system 消息
  const body: Record<string, unknown> = {
    system: "原始",
    messages: [{ role: "user", content: "hi" }],
  };
  injectRoutePrompt(body, "注入");
  const msgs = body.messages as Array<{ role: string; content: unknown }>;
  check("Anthropic 形态：system 字段被追加", body.system === "原始\n\n注入", String(body.system));
  check(
    "Anthropic 形态：messages 未被插入 system（无双重注入）",
    msgs.length === 1 && msgs[0].role === "user",
    JSON.stringify(msgs)
  );
}
{
  // OpenAI 形态：只应有 messages[0] 被追加，不得凭空多出 system 字段
  const body: Record<string, unknown> = {
    messages: [{ role: "system", content: "原始" }, { role: "user", content: "hi" }],
  };
  injectRoutePrompt(body, "注入");
  const msgs = body.messages as Array<{ role: string; content: string }>;
  check("OpenAI 形态：messages[0] 被追加", msgs[0].content === "原始\n\n注入", msgs[0].content);
  check("OpenAI 形态：未新增 system 字段", body.system === undefined, String(body.system));
}
{
  const body: Record<string, unknown> = {
    system: [{ type: "text", text: "块" }],
    messages: [{ role: "user", content: "hi" }],
  };
  injectRoutePrompt(body, "注入");
  const sys = body.system as Array<Record<string, unknown>>;
  const msgs = body.messages as Array<{ role: string }>;
  check("block 数组形态分派到 Anthropic 路径", sys.length === 2 && sys[1].text === "注入");
  check("block 数组形态不污染 messages", msgs.length === 1);
}
{
  const body: Record<string, unknown> = {};
  const ret = injectRoutePrompt(body, "");
  check(
    "空 rendered 不注入且返回 false",
    ret === false && body.system === undefined && body.messages === undefined
  );
}


console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exit(1);
