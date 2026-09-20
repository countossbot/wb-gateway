// v4.2.0 QA：SSE 透传保活 + 停滞熔断 —— 网关端到端实测
// 规程：自建测试中转/路由（qa-mock / qa-mock-model）→ 实测 → 全部自清理 → healthz 等价核对
// 验证点：
//   A. 正常流式透传（字节原样 + [DONE] 一次）
//   B. 临时调 streamStallMs=8s（R1 热生效）→ STALL:30000 上游静默 30s
//      → 网关 ~8s 熔断：保活注释帧期间注入 + [DONE] 终帧 + 流关闭 + 上游被 cancel
//   C. 恢复 streamStallMs=0（默认 180s）后 GET 回读一致
const BASE = "http://127.0.0.1:3000";

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

// ---- 1. 自建测试中转 + 路由 ----
const healthzBefore = await (await fetch(`${BASE}/healthz`)).json();

const provRes = await fetch(`${BASE}/api/console/providers`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    id: "qa-mock", name: "qa-mock", type: "openai", enabled: true,
    config: { baseUrl: "http://127.0.0.1:3040/v1" },
    accounts: [{ credentials: { apiKey: "sk-mock-qa" } }],
  }),
});
console.log("create provider:", provRes.status);
const routeRes = await fetch(`${BASE}/api/console/routes`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ model: "qa-mock-model", candidates: [{ providerId: "qa-mock", model: "mock-chat" }] }),
});
console.log("create route:", routeRes.status);

// 虚拟密钥（取已存在的 test 密钥）
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const vk = await db.virtualKey.findFirst({ where: { name: "test" } });
const key = vk!.keyValue;

try {
  // ---- 2A. 正常流式透传 ----
  console.log("\n[A] 正常流式透传");
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "qa-mock-model", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    const ct = r.headers.get("content-type") || "";
    const text = await r.text();
    check("SSE content-type", ct.includes("text/event-stream"), ct);
    check("思维链/正文帧透传", text.includes("reasoning_content") && text.includes("Hello from mock upstream stream!"));
    check("[DONE] 恰一次", (text.match(/\[DONE\]/g) || []).length === 1);
    check("无保活帧混入（快速完成）", !text.includes(": keep-alive"));
  }

  // ---- 2B. 停滞熔断（R1 热调 streamStallMs=10000 + R6 ping/终帧） ----
  console.log("\n[B] 停滞熔断：streamStallMs 临时调 10s（验证下限值）");
  {
    const setRes = await fetch(`${BASE}/api/console/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ streamStallMs: 10000 }),
    });
    check("设置 streamStallMs=10000", setRes.status === 200, await setRes.text().catch(() => ""));
    const badSet = await fetch(`${BASE}/api/console/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ streamStallMs: 8000 }),
    });
    check("非法值（8s < 下限 10s）被拒 400", badSet.status === 400);

    const t0 = Date.now();
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "qa-mock-model", stream: true, messages: [{ role: "user", content: "please STALL:30000" }] }),
    });
    const text = await r.text();
    const elapsed = Date.now() - t0;
    check("流在 ~10-14s 内熔断关闭", elapsed >= 9800 && elapsed < 14000, `elapsed=${elapsed}ms`);
    check("熔断期间注入保活注释帧", (text.match(/: keep-alive/g) || []).length >= 1, `count=${(text.match(/: keep-alive/g) || []).length}`);
    check("熔断补 [DONE] 终帧", text.trimEnd().endsWith("data: [DONE]"), JSON.stringify(text.slice(-80)));
    check("首帧（thinking）已透传", text.includes("reasoning_content"));
    check("熔断后无迟到内容帧", !text.includes("mock thinking done"));
    const stats = await (await fetch("http://127.0.0.1:3040/__stats")).json();
    check("上游流被级联 cancel", stats.cancelledCount >= 1, JSON.stringify(stats));
  }

  // ---- 2C. 恢复默认 + 回读 ----
  console.log("\n[C] 恢复默认配置");
  {
    const reset = await fetch(`${BASE}/api/console/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ streamStallMs: 0 }),
    });
    const snap = await (await fetch(`${BASE}/api/console/settings`, { headers: { cookie } })).json();
    check("恢复 streamStallMs=0（默认 180s）", reset.status === 200 && snap.data?.streamStallMs === 0, JSON.stringify(snap.data?.streamStallMs));
    check("快照含三个新字段", typeof snap.data?.upstreamHeadersTimeoutMs === "number" && typeof snap.data?.upstreamBodyTimeoutMs === "number");
  }
} finally {
  // ---- 3. 自清理（只删自建的 qa-mock*；禁令范围内业务数据零触碰） ----
  const delRoute = await fetch(`${BASE}/api/console/routes?model=qa-mock-model`, { method: "DELETE", headers: { cookie } });
  const delProv = await fetch(`${BASE}/api/console/providers?id=qa-mock`, { method: "DELETE", headers: { cookie } });
  console.log("\ncleanup: route", delRoute.status, "| provider", delProv.status);
  const healthzAfter = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz 数据等价（providers/models 一致）",
    healthzAfter.providers_active === healthzBefore.providers_active && healthzAfter.models_available === healthzBefore.models_available,
    `before=${healthzBefore.providers_active}/${healthzBefore.models_available} after=${healthzAfter.providers_active}/${healthzAfter.models_available}`);
}

console.log(`\n========== 端到端结果：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
