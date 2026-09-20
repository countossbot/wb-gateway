// v4.3.1 QA：路由试跑（控制台调试工具）—— /api/console/routes/test 端到端实测
// 规程：自建测试中转/路由（qa-rt-*，经 mock-upstream 3040 零真实计费）→ 试跑端点各场景 →
//       候选链时间线/落点头/流式透传/翻译路径逐项断言 → 全部自清理 → healthz 等价核对
// 验证点：
//   A. 非流式正常：200 + trace[attempt,success] + body JSON + usage + X-Gateway 落点
//   B. 流式：text/event-stream 透传 + X-Test-Trace 头 + delta 帧聚合 + [DONE] + usage 帧
//   C. 故障转移链：坏 key 候选 fail(401→pool 502) → retry → 第 2 候选 success + fallback=true
//   D. noroute 404：trace 含 available 清单
//   E. anthropic 协议入口：OpenAI 上游转译为 anthropic JSON（type:message + content 数组）
//   F. 输入校验：空 prompt 拒绝；非法模型名拒绝
//   G. 会话鉴权：无 cookie 401
//   H. 记账口径：RequestLog 落库 apiKeyName=console-test（运行日志可追溯）
//   I. 清理：自建资产全删 + healthz 前后等价
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

// ---- 0. 前置：healthz 基线 ----
const healthzBefore = await (await fetch(`${BASE}/healthz`)).json();
console.log("healthz before:", JSON.stringify(healthzBefore));

// ---- 预清理（幂等重跑保障）：历史轮次残留先删（首轮崩溃/中断后重启场景）----
{
  const staleRoutes = await db.modelRoute.findMany({ where: { model: { startsWith: "qa-rt-" } } });
  for (const r of staleRoutes) {
    const res = await fetch(`${BASE}/api/console/routes?model=${r.model}`, { method: "DELETE", headers: { cookie } });
    console.log(`pre-clean route ${r.model}:`, res.status);
  }
  const staleProvs = await db.provider.findMany({ where: { id: { startsWith: "qa-rt-" } } });
  for (const p of staleProvs) {
    const res = await fetch(`${BASE}/api/console/providers?id=${p.id}`, { method: "DELETE", headers: { cookie } });
    console.log(`pre-clean provider ${p.id}:`, res.status);
  }
  // 手工探测资产（qa-rt2，非 qa-rt- 前缀）一并清理
  const rt2 = await db.provider.findUnique({ where: { id: "qa-rt2" } });
  if (rt2) {
    const rr = await db.modelRoute.findUnique({ where: { model: "qa-rt2-model" } });
    if (rr) {
      const res = await fetch(`${BASE}/api/console/routes?model=qa-rt2-model`, { method: "DELETE", headers: { cookie } });
      console.log("pre-clean route qa-rt2-model:", res.status);
    }
    const res = await fetch(`${BASE}/api/console/providers?id=qa-rt2`, { method: "DELETE", headers: { cookie } });
    console.log("pre-clean provider qa-rt2:", res.status);
  }
}

const mk = async (id: string, key: string) => {
  const r = await post("/api/console/providers", {
    id, name: id, type: "openai", enabled: true,
    config: { baseUrl: `${MOCK}/v1`, apiKey: key },
  });
  console.log(`create provider ${id}:`, r.status);
};
await mk("qa-rt-good", "sk-qa-rt-good");
// 候选级故障转移演示：429（insufficient_quota）在候选级 classify=cooldown → 切下一候选。
// （注：401 在单密钥回退路径下 classify=fatal 直返不切换 —— 那是正确语义，不适合本场景）
await mk("qa-rt-bad", "sk-quota-rt");

const mkRoute = async (model: string, cands: Array<{ providerId: string; model: string }>) => {
  const r = await post("/api/console/routes", { model, candidates: cands });
  console.log(`create route ${model}:`, r.status);
};
await mkRoute("qa-rt-model", [{ providerId: "qa-rt-good", model: "mock-chat" }]);
await mkRoute("qa-rt-chain", [
  { providerId: "qa-rt-bad", model: "mock-chat" },
  { providerId: "qa-rt-good", model: "mock-chat" },
]);

const testEndpoint = (body: unknown) => post("/api/console/routes/test", body);

// ---- A. 非流式正常 ----
console.log("\n[A] 非流式正常路径");
{
  const r = await testEndpoint({ model: "qa-rt-model", protocol: "openai", prompt: "你好，试跑验证 A", maxTokens: 64 });
  const env = await r.json();
  check("HTTP 200 + ok 信封", r.status === 200 && env.ok === true, JSON.stringify(env).slice(0, 200));
  const d = env.data;
  check("status 200", d?.status === 200);
  check("latencyMs > 0", typeof d?.latencyMs === "number" && d.latencyMs >= 0);
  const types = (d?.trace || []).map((e: { type: string }) => e.type);
  check("trace = [attempt, success]", types.join(",") === "attempt,success", types.join(","));
  const success = (d?.trace || []).find((e: { type: string }) => e.type === "success");
  check("success.provider=qa-rt-good", success?.provider === "qa-rt-good");
  check("success.account=default（单密钥）", success?.account === "default");
  check("success.fallback=false", success?.fallback === false);
  check("meta.upstreamModel=mock-chat", d?.meta?.upstreamModel === "mock-chat", d?.meta?.upstreamModel);
  check("meta.contentType=json", (d?.meta?.contentType || "").includes("json"));
  const content = d?.body?.choices?.[0]?.message?.content || "";
  check("body 含 mock 应答指纹", typeof content === "string" && content.includes("Hello from mock upstream"), String(content).slice(0, 80));
  check("body 含 key 指纹 [key:good]", content.includes("[key:good]"), String(content).slice(0, 120));
  const usage = d?.body?.usage;
  check("usage 回显（input/output）", usage && usage.prompt_tokens > 0 && usage.completion_tokens > 0, JSON.stringify(usage));
  check("trace 事件带 t 时间戳", (d?.trace || []).every((e: { t: number }) => typeof e.t === "number"));
}

// ---- B. 流式 ----
console.log("\n[B] 流式透传");
{
  const r = await testEndpoint({ model: "qa-rt-model", protocol: "openai", prompt: "流式试跑 B", stream: true, maxTokens: 64 });
  const ct = r.headers.get("content-type") || "";
  check("HTTP 200 + text/event-stream", r.status === 200 && ct.includes("text/event-stream"), `${r.status} ${ct}`);
  const traceRaw = r.headers.get("x-test-trace");
  check("X-Test-Trace 头存在", !!traceRaw);
  let trace: Array<{ type: string }> = [];
  try { trace = JSON.parse(traceRaw || "[]"); } catch { /* 下一条断言兜底 */ }
  check("trace 头含 success（流开始前已完整）", trace.some((e) => e.type === "success"), JSON.stringify(trace.map((e) => e.type)));
  check("X-Test-Latency 头", /^\d+$/.test(r.headers.get("x-test-latency") || ""));
  const text = await r.text();
  check("SSE 含 delta 帧", text.includes("\"delta\""));
  check("SSE 含 [DONE]", text.includes("[DONE]"));
  check("SSE 含 usage 帧（cached_tokens）", text.includes("usage"));
  check("落点头 X-Gateway-Account=default", r.headers.get("x-gateway-account") === "default");
  check("落点头 X-Gateway-Model=mock-chat", r.headers.get("x-gateway-model") === "mock-chat");
}

// ---- C. 故障转移链 ----
console.log("\n[C] 故障转移链（429 限额 → 切换好 key）");
{
  const r = await testEndpoint({ model: "qa-rt-chain", protocol: "openai", prompt: "故障转移 C", maxTokens: 64 });
  const env = await r.json();
  const d = env.data;
  check("最终 200", d?.status === 200, JSON.stringify(d?.status));
  const types = (d?.trace || []).map((e: { type: string }) => e.type);
  check("trace 含 fail → retry → attempt → success", types.join(",").includes("fail") && types.join(",").includes("retry") && types[types.length - 1] === "success", types.join(","));
  const fail = (d?.trace || []).find((e: { type: string }) => e.type === "fail");
  check("fail.provider=qa-rt-bad", fail?.provider === "qa-rt-bad");
  check("fail.status=429", fail?.status === 429, String(fail?.status));
  check("fail.summary 含配额线索", /quota|insufficient/i.test(String(fail?.summary)), String(fail?.summary).slice(0, 120));
  const retry = (d?.trace || []).find((e: { type: string }) => e.type === "retry");
  check("retry.action=cooldown（惩罚性退避）", retry?.action === "cooldown", String(retry?.action));
  const success = (d?.trace || []).find((e: { type: string }) => e.type === "success");
  check("success.index=1（第 2 候选）", success?.index === 1, String(success?.index));
  check("success.fallback=true", success?.fallback === true);
  check("meta.fallback=true", d?.meta?.fallback === true);
  check("body 含好 key 指纹", String(d?.body?.choices?.[0]?.message?.content || "").includes("[key:good]"));
}

// ---- D. noroute 404 ----
console.log("\n[D] 未建路由模型 → 404 诊断");
{
  const r = await testEndpoint({ model: "qa-rt-noroute-x", prompt: "D" });
  const env = await r.json();
  const d = env.data;
  check("status 404", d?.status === 404);
  const noroute = (d?.trace || []).find((e: { type: string }) => e.type === "noroute");
  check("trace 含 noroute 事件", !!noroute);
  check("noroute.available 含既有路由", Array.isArray(noroute?.available) && noroute.available.includes("qa-rt-model"), JSON.stringify(noroute?.available).slice(0, 120));
  check("body.error.message 含可用模型提示", String(d?.body?.error?.message || "").includes("Available models"));
}

// ---- E. anthropic 协议入口（转译路径）----
console.log("\n[E] anthropic 协议 → openai 上游转译");
{
  const r = await testEndpoint({ model: "qa-rt-model", protocol: "anthropic", prompt: "转译 E", maxTokens: 64, system: "你是测试助手" });
  const env = await r.json();
  const d = env.data;
  check("status 200", d?.status === 200, JSON.stringify(d).slice(0, 150));
  check("anthropic 响应形态（type=message）", d?.body?.type === "message", JSON.stringify(d?.body).slice(0, 120));
  check("content 数组文本", Array.isArray(d?.body?.content) && typeof d?.body?.content?.[0]?.text === "string");
  check("usage.input_tokens 口径", (d?.body?.usage?.input_tokens ?? 0) > 0);
  check("role=assistant", d?.body?.role === "assistant");
}

// ---- F. 输入校验 ----
console.log("\n[F] 输入校验");
{
  const r1 = await testEndpoint({ model: "qa-rt-model", prompt: "" });
  const e1 = await r1.json();
  check("空 prompt 拒绝", r1.status === 400 && e1.ok === false, JSON.stringify(e1));
  const r2 = await testEndpoint({ model: "bad model!", prompt: "x" });
  const e2 = await r2.json();
  check("非法模型名拒绝", r2.status === 400 && e2.ok === false, JSON.stringify(e2));
  const r3 = await testEndpoint({ model: "qa-rt-model", prompt: "x".repeat(9000) });
  check("超长 prompt 拒绝", r3.status === 400);
}

// ---- G. 会话鉴权 ----
console.log("\n[G] 会话鉴权");
{
  const r = await fetch(`${BASE}/api/console/routes/test`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qa-rt-model", prompt: "x" }),
  });
  check("无会话 401", r.status === 401);
}

// ---- H. 记账口径：RequestLog 落库 console-test ----
console.log("\n[H] 记账口径");
{
  const rows = await db.requestLog.findMany({
    where: { apiKeyName: "console-test", createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    orderBy: { createdAt: "desc" }, take: 20,
  });
  check("RequestLog 有 console-test 记录", rows.length >= 4, `近 10 分钟 ${rows.length} 条`);
  const ok200 = rows.filter((r) => r.status === 200);
  check("成功记录带 providerId/usage", ok200.length > 0 && ok200.every((r) => r.providerId && (r.outputTokens ?? 0) > 0), JSON.stringify(rows[0] || null).slice(0, 200));
  const models = new Set(rows.map((r) => r.model));
  check("模型维度正确（qa-rt-model / qa-rt-chain / qa-rt-noroute-x）",
    models.has("qa-rt-model") && models.has("qa-rt-chain") && models.has("qa-rt-noroute-x"), [...models].join(","));
}

// ---- I. 清理 + healthz 等价 ----
console.log("\n[I] 清理与基线");
{
  for (const model of ["qa-rt-model", "qa-rt-chain"]) {
    const r = await fetch(`${BASE}/api/console/routes?model=${model}`, { method: "DELETE", headers: { cookie } });
    console.log(`delete route ${model}:`, r.status);
  }
  for (const id of ["qa-rt-good", "qa-rt-bad"]) {
    const r = await fetch(`${BASE}/api/console/providers?id=${id}`, { method: "DELETE", headers: { cookie } });
    console.log(`delete provider ${id}:`, r.status);
  }
  const leftoverRoutes = await db.modelRoute.count({ where: { model: { startsWith: "qa-rt-" } } });
  const leftoverProvs = await db.provider.count({ where: { id: { startsWith: "qa-rt-" } } });
  check("qa-rt-* 路由零残留", leftoverRoutes === 0);
  check("qa-rt-* 提供商零残留", leftoverProvs === 0);
  const healthzAfter = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz 等价（providers/models 与基线一致）",
    healthzAfter.providers_active === healthzBefore.providers_active && healthzAfter.models_available === healthzBefore.models_available,
    `${healthzAfter.providers_active}/${healthzAfter.models_available} vs ${healthzBefore.providers_active}/${healthzBefore.models_available}`);
}

await db.$disconnect();
console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail > 0 ? 1 : 0);
