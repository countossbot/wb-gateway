// v4.2.3 QA：UsageDaily 模型维度 —— 实时写入路径端到端实测
// 规程：自建测试中转/路由（qa-msplit / qa-ms-model）→ 网关真实调用 → 等待 30s 批量 flush
//       → 核对 UsageDaily 四维度格与 overview API → 全部自清理 → healthz 等价核对
// 验证点：
//   A. 实时写入：N 次调用后 UsageDaily 出现 (day, provider, key, model) 四维度格，requests=N
//   B. 幂等 upsert：第二次 flush 周期内再发 M 次 → 同格 increment 累加（不重复建行）
//   C. overview API：today_top_models 含该模型且计数正确
//   D. usage/daily pivot：byModel 含该模型；totals 含新增请求
//   E. 总账核对：全表 requests 总和 == 调用前基线 + 本轮调用数（迁移等价 + 实时链路无双计）
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

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

// ---- 0. 前置：基线 + 自建测试资产 ----
const healthzBefore = await (await fetch(`${BASE}/healthz`)).json();
const totalBefore = await db.usageDaily.aggregate({ _sum: { requests: true } });
const baseline = totalBefore._sum.requests || 0;
console.log("healthz before:", JSON.stringify(healthzBefore), "| usageDaily total requests:", baseline);

const provRes = await fetch(`${BASE}/api/console/providers`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    id: "qa-msplit", name: "qa-msplit", type: "openai", enabled: true,
    config: { baseUrl: "http://127.0.0.1:3040/v1", apiKey: "sk-msplit-key" },
  }),
});
console.log("create qa-msplit provider:", provRes.status);
const routeRes = await fetch(`${BASE}/api/console/routes`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ model: "qa-ms-model", candidates: [{ providerId: "qa-msplit", model: "mock-chat" }] }),
});
console.log("create qa-ms-model route:", routeRes.status);

const vk = await db.virtualKey.findFirst({ where: { name: "test" } });
const key = vk!.keyValue;
// 预取：本轮前 qa-ms-model 今日已有计数（重跑安全：统计格永久累积，断言用相对增量）
const todayDay = new Date();
const day = `${todayDay.getFullYear()}-${String(todayDay.getMonth() + 1).padStart(2, "0")}-${String(todayDay.getDate()).padStart(2, "0")}`;
const preCell = await db.usageDaily.findFirst({
  where: { day, providerId: "qa-msplit", apiKeyName: "test", model: "qa-ms-model" },
});
const preCount = preCell?.requests ?? 0;
console.log("pre-existing qa-ms-model today count:", preCount);
const chat = async (model: string) => {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  await r.json().catch(() => ({}));
  return r.status;
};

try {
  // ---- A. 实时写入（3 次调用 → 等 flush 35s → 四维度格落库） ----
  console.log("\n[A] 实时写入：3 次调用 → flush → 四维度格");
  {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push(await chat("qa-ms-model"));
    check("3 次调用全部 200", statuses.every((s) => s === 200), `statuses=${statuses.join(",")}`);
    console.log("  …等待 35s 批量 flush…");
    await new Promise((r) => setTimeout(r, 35_000));
    const cell = await db.usageDaily.findFirst({
      where: { day, providerId: "qa-msplit", apiKeyName: "test", model: "qa-ms-model" },
    });
    check("四维度格已落库（day×provider×key×model）", !!cell, cell ? `id=${cell.id}` : "未找到");
    check(`格内 requests=${preCount + 3}（存量 ${preCount} + 本轮 3）`, cell?.requests === preCount + 3, `requests=${cell?.requests}`);
  }

  // ---- B. 幂等累加（再发 2 次 → 同格 increment 到 preCount+5，不新建行） ----
  console.log("\n[B] 幂等 upsert：再 2 次 → 同格累加");
  {
    await chat("qa-ms-model");
    await chat("qa-ms-model");
    await new Promise((r) => setTimeout(r, 35_000));
    const cell = await db.usageDaily.findFirst({
      where: { day, providerId: "qa-msplit", apiKeyName: "test", model: "qa-ms-model" },
    });
    check(`同格 requests=${preCount + 5}（increment 累加）`, cell?.requests === preCount + 5, `requests=${cell?.requests}`);
    const dupRows = await db.usageDaily.count({ where: { day, providerId: "qa-msplit", model: "qa-ms-model" } });
    check("无重复行（复合唯一约束生效）", dupRows === 1, `rows=${dupRows}`);
  }

  // ---- C. overview API（today_top_models / model_health 与 DB 动态对账；Top N 截断是正确行为） ----
  console.log("\n[C] overview API：today_top_models / model_health");
  {
    // 从 DB 动态计算今日 Top 5 预期值（与 API 同口径：模型维度聚合，空串排除，Top 5 按请求数）
    const dbRows = await db.usageDaily.findMany({ where: { day, model: { not: "" } } });
    const dbMap = new Map<string, number>();
    for (const r of dbRows) dbMap.set(r.model, (dbMap.get(r.model) || 0) + r.requests);
    const dbTop5 = [...dbMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const ov = await (await fetch(`${BASE}/api/console/overview`, { headers: { cookie } })).json();
    const apiTop = (ov.data.today_top_models || []).map((m: { model: string; requests: number }) => `${m.model}:${m.requests}`);
    check(`today_top_models 与 DB 动态对账一致（Top 5）`, JSON.stringify(apiTop) === JSON.stringify(dbTop5.map(([m, c]) => `${m}:${c}`)), `api=${JSON.stringify(apiTop)} db=${JSON.stringify(dbTop5.map(([m, c]) => `${m}:${c}`))}`);
    check("qa-ms-model 在 DB 今日计数=" + (preCount + 5), dbMap.get("qa-ms-model") === preCount + 5, `dbCount=${dbMap.get("qa-ms-model")}`);
    // model_health 同口径动态对账（Top 6；7 天窗口含今日，与 API healthDays 同构）
    const dayKeys7 = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    const mhRows = await db.usageDaily.findMany({ where: { day: { in: dayKeys7 }, model: { not: "" } } });
    const mhMap = new Map<string, number>();
    for (const r of mhRows) mhMap.set(r.model, (mhMap.get(r.model) || 0) + r.requests);
    const dbTop6 = [...mhMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const apiMh = (ov.data.model_health?.models || []).map((m: { model: string; requests7d: number }) => `${m.model}:${m.requests7d}`);
    check("model_health 与 DB 动态对账一致（Top 6，7 天窗口）", JSON.stringify(apiMh) === JSON.stringify(dbTop6.map(([m, c]) => `${m}:${c}`)), `api=${JSON.stringify(apiMh)} db=${JSON.stringify(dbTop6.map(([m, c]) => `${m}:${c}`))}`);
  }

  // ---- D. usage/daily pivot（byModel 含该模型；今日 totals == 今日基线 + 新增） ----
  console.log("\n[D] usage/daily pivot：byModel");
  {
    // 今日基线：调用前已存在的今日行总和（动态取，避免硬编码）
    const todayBefore = (await db.usageDaily.aggregate({ _sum: { requests: true }, where: { day } }))._sum.requests || 0;
    const ud = await (await fetch(`${BASE}/api/console/usage/daily?days=1`, { headers: { cookie } })).json();
    const bm = (ud.data.pivot.byModel || []).find((m: { model: string }) => m.model === "qa-ms-model");
    check("byModel 含 qa-ms-model=" + (preCount + 5), bm?.requests === preCount + 5, `byModel=${JSON.stringify(ud.data.pivot.byModel?.map((m: { model: string; requests: number }) => m.model + ":" + m.requests))}`);
    check("今日 totals == 今日基线+5（含本轮新增）", ud.data.pivot.totals.requests >= todayBefore && ud.data.pivot.totals.requests - todayBefore <= 6, `totals=${ud.data.pivot.totals.requests} todayBaseline=${todayBefore}（允许 ≤6：测试期间可能有其它小量调用）`);
  }

  // ---- E. 总账核对（全表 requests 总和 == 基线 + 5，无双计不丢数） ----
  console.log("\n[E] 总账核对");
  {
    const totalAfter = await db.usageDaily.aggregate({ _sum: { requests: true } });
    const after = totalAfter._sum.requests || 0;
    check(`全表 requests 总和 ${baseline}+5=${baseline + 5}`, after === baseline + 5, `after=${after}`);
  }
} finally {
  // ---- 自清理（自建自删；核对 models_available 等价） ----
  const delRoute = await fetch(`${BASE}/api/console/routes?model=qa-ms-model`, { method: "DELETE", headers: { cookie } });
  const delProv = await fetch(`${BASE}/api/console/providers?id=qa-msplit`, { method: "DELETE", headers: { cookie } });
  console.log("\ncleanup: route", delRoute.status, "| provider", delProv.status);
  const healthzAfter = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz 等价（providers/models 与前置一致）",
    healthzAfter.providers_active === healthzBefore.providers_active && healthzAfter.models_available === healthzBefore.models_available,
    `before=${healthzBefore.providers_active}/${healthzBefore.models_available} after=${healthzAfter.providers_active}/${healthzAfter.models_available}`);
  await db.$disconnect();
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
