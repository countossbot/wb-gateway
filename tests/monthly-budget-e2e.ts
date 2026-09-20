// v4.5.0 QA：月度成本预算 + 月度账单 —— 端到端实测
// 规程：自建测试中转/路由/密钥/单价（qa-budget-*，零业务数据触碰）→ 网关真实调用（mock 零成本）→
//       验证预算执行/头组/热更新/未计价语义/账本口径/billing API 数学 → 全部自清理 → healthz 等价
// 验证点：
//   A. 月预算执行：预算 0.0001（mock 每请求 55 tk × 单价 1$/1M = 0.000055/次）→
//      第 1/2 次 200（预检按已累计拒绝）、第 3/4 次 429（rate_limit_error + X-Budget-* 头组 +
//      Retry-After ≤ 31 天）；被拒请求不计数不增成本（无「越拒越超」死锁）
//   B. 未计价模型不计成本：同预算密钥调用无单价路由 3 连 200（成本恒 0，预算永不触发）
//   C. 预算热更新：PUT 提高预算 → 下一请求恢复 200；降回 → 恢复 429（config_version 传播）
//   D. 账本口径（flush 后）：UsageDaily 当月行 requests=3、估算成本 3×0.000055=0.000165；
//      keys API 回显 monthlyCostLimit + monthCost 同口径
//   E. billing API 数学：rows 含 qa-budget 密钥（cost/byModel/monthlyCostLimit 联动）、
//      未计价密钥 pricedRequests=0、totals 覆盖、月份校验回落、未登录 401
//   F. 清理：自建资产全删（单价表精确恢复原状）+ healthz 前后等价
const BASE = "http://127.0.0.1:3000";

// 轮次唯一后缀（预算账本按密钥名持久累积，同名重跑继承当月用量 —— 唯一名保证从零断言）
const RUN = String(Date.now()).slice(-6);
const NAME_BUD = `qa-budget-bud-${RUN}`;
const NAME_UNPR = `qa-budget-unpr-${RUN}`;
const MODEL_PRICED = `qa-budget-model-${RUN}`;
const MODEL_UNPRICED = `qa-budget-unpr-model-${RUN}`;
const BUDGET = 0.0001; // 2 次请求（0.00011）后耗尽
const COST_PER_REQ = 55 / 1_000_000; // mock：42 入 + 13 出 × 1$/1M（cached 单价 0）

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

// ---- 0. 前置：healthz 基线 + 单价表原状快照（清理时精确恢复） + 自建测试资产 ----
const healthzBefore = await (await fetch(`${BASE}/healthz`)).json();
console.log("healthz before:", JSON.stringify(healthzBefore));

const pricingBefore = await (await fetch(`${BASE}/api/console/pricing`, { headers: { cookie } })).json() as {
  data?: { rows?: Array<{ model: string; inputPerMTok: number; outputPerMTok: number; cachedPerMTok: number }> };
};
const originalPricingRows = pricingBefore.data?.rows || [];
console.log("pricing rows before:", originalPricingRows.length);

const putPricing = async (rows: Array<{ model: string; inputPerMTok: number; outputPerMTok: number; cachedPerMTok: number }>) => {
  return fetch(`${BASE}/api/console/pricing`, {
    method: "PUT", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ rows }),
  });
};

// 单价表 = 原有行 + 测试行（清理时精确恢复原状；当前表通常为空）
const pr = await putPricing([
  ...originalPricingRows,
  { model: MODEL_PRICED, inputPerMTok: 1, outputPerMTok: 1, cachedPerMTok: 0 },
]);
console.log("put pricing:", pr.status);

const provRes = await fetch(`${BASE}/api/console/providers`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    id: "qa-budget", name: "qa-budget", type: "openai", enabled: true,
    config: { baseUrl: "http://127.0.0.1:3040/v1", apiKey: "sk-qa-budget-key" },
  }),
});
console.log("create qa-budget provider:", provRes.status);
for (const [model, note] of [[MODEL_PRICED, "priced"], [MODEL_UNPRICED, "unpriced"]] as const) {
  const r = await fetch(`${BASE}/api/console/routes`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ model, candidates: [{ providerId: "qa-budget", model: "mock-chat" }] }),
  });
  console.log(`create route ${note} ${model}:`, r.status);
}

const mkKey = async (name: string, monthlyCostLimit: number): Promise<string> => {
  const r = await fetch(`${BASE}/api/console/keys`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name, models: ["*"], monthlyCostLimit }),
  });
  const j = await r.json() as { data?: { keyValue?: string } };
  if (!j.data?.keyValue) throw new Error(`create key ${name} failed: ${JSON.stringify(j)}`);
  return j.data.keyValue;
};

const chat = async (key: string, model: string) => {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
  });
};

try {
  // ---- A. 月预算执行 ----
  console.log("\n[A] 月预算执行（monthlyCostLimit=0.0001，每请求 0.000055）");
  const keyA = await mkKey(NAME_BUD, BUDGET);
  const s1 = await chat(keyA, MODEL_PRICED), s2 = await chat(keyA, MODEL_PRICED);
  check("第 1/2 次 200（预检按已累计 0/0.000055 < 0.0001 放行）", s1.status === 200 && s2.status === 200, `${s1.status}/${s2.status}`);
  const s3 = await chat(keyA, MODEL_PRICED);
  const j3 = await s3.json() as { error?: { type?: string; message?: string } };
  check("第 3 次 429（累计 0.00011 ≥ 0.0001）", s3.status === 429, String(s3.status));
  check("错误类型 rate_limit_error", j3.error?.type === "rate_limit_error", JSON.stringify(j3.error));
  check("消息含密钥名 + Monthly cost budget exhausted", (j3.error?.message || "").includes(NAME_BUD) && (j3.error?.message || "").includes("Monthly cost budget exhausted"), j3.error?.message);
  check("消息含估算口径说明（model pricing table basis）", (j3.error?.message || "").includes("model pricing table basis"), j3.error?.message);
  check("X-RateLimit-Limit=budget", s3.headers.get("x-ratelimit-limit") === "budget", String(s3.headers.get("x-ratelimit-limit")));
  check("X-RateLimit-Remaining=0", s3.headers.get("x-ratelimit-remaining") === "0", String(s3.headers.get("x-ratelimit-remaining")));
  check("X-Budget-Limit=0.0001", s3.headers.get("x-budget-limit") === "0.0001", String(s3.headers.get("x-budget-limit")));
  check("X-Budget-Remaining=0.0000", s3.headers.get("x-budget-remaining") === "0.0000", String(s3.headers.get("x-budget-remaining")));
  const ra = Number(s3.headers.get("retry-after"));
  const br = Number(s3.headers.get("x-budget-reset"));
  check("Retry-After / X-Budget-Reset = 下月 1 日秒数（> 0 且 ≤ 31 天）", ra > 0 && ra <= 31 * 86400 && br === ra, `${ra}/${br}`);
  const s4 = await chat(keyA, MODEL_PRICED);
  check("第 4 次仍 429（持续拒绝；被拒不增成本）", s4.status === 429, String(s4.status));

  // ---- B. 未计价模型不计成本 ----
  console.log("\n[B] 未计价模型不计成本（无单价路由 × 同预算密钥 3 连 200）");
  const keyB = await mkKey(NAME_UNPR, 0.000001);
  const u1 = await chat(keyB, MODEL_UNPRICED), u2 = await chat(keyB, MODEL_UNPRICED), u3 = await chat(keyB, MODEL_UNPRICED);
  check("未计价模型 3 连 200（成本恒 0，预算永不触发）", [u1, u2, u3].every((r) => r.status === 200), [u1.status, u2.status, u3.status].join("/"));

  // ---- C. 预算热更新 ----
  console.log("\n[C] 预算热更新（PUT 提高预算 → 恢复 200；降回 → 恢复 429）");
  const keyRow = await db.virtualKey.findFirst({ where: { name: NAME_BUD } });
  if (!keyRow) throw new Error("key row not found");
  const putUp = await fetch(`${BASE}/api/console/keys`, {
    method: "PUT", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ id: keyRow.id, name: NAME_BUD, enabled: true, models: ["*"], monthlyCostLimit: 1 }),
  });
  check("PUT 提高预算 200", putUp.status === 200, String(putUp.status));
  const s5 = await chat(keyA, MODEL_PRICED);
  check("提高预算后下一请求恢复 200", s5.status === 200, String(s5.status));
  const putDown = await fetch(`${BASE}/api/console/keys`, {
    method: "PUT", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ id: keyRow.id, name: NAME_BUD, enabled: true, models: ["*"], monthlyCostLimit: BUDGET }),
  });
  const s6 = await chat(keyA, MODEL_PRICED);
  check("降回后恢复 429（已计 0.000165 ≥ 0.0001）", putDown.status === 200 && s6.status === 429, `${putDown.status}/${s6.status}`);

  // ---- D. 账本口径（flush 后） ----
  console.log("  … 等待 32s flush 周期后核对账本");
  await new Promise((r) => setTimeout(r, 32_000));
  const month = new Date();
  const monthKey = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
  const rowsBud = await db.usageDaily.findMany({ where: { day: { startsWith: monthKey }, apiKeyName: NAME_BUD } });
  const reqBud = rowsBud.reduce((s, r) => s + r.requests, 0);
  check("账本 NAME_BUD 当月 requests=3（2+1 热更新后；被拒不计数）", reqBud === 3, String(reqBud));
  const tkBud = rowsBud.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  check("账本 tokens=165（3 × 55）", tkBud === 165, String(tkBud));
  const costBud = rowsBud.reduce((s, r) => s + (r.inputTokens * 1 + r.outputTokens * 1 + r.cachedTokens * 0) / 1_000_000, 0);
  check("账本估算成本=0.000165（3 × 0.000055）", Math.abs(costBud - 3 * COST_PER_REQ) < 1e-9, String(costBud));

  // keys API 回显
  const keysList = await (await fetch(`${BASE}/api/console/keys`, { headers: { cookie } })).json() as {
    data?: { keys?: Array<{ name: string; monthlyCostLimit?: number; monthCost?: number }> };
  };
  const rowBud = keysList.data?.keys?.find((k) => k.name === NAME_BUD);
  const rowUnpr = keysList.data?.keys?.find((k) => k.name === NAME_UNPR);
  check("keys API 回显 monthlyCostLimit=0.0001", rowBud?.monthlyCostLimit === BUDGET, String(rowBud?.monthlyCostLimit));
  check("keys API monthCost≈0.000165（预算进度条数据源，同口径）", Math.abs((rowBud?.monthCost ?? -1) - 3 * COST_PER_REQ) < 1e-9, String(rowBud?.monthCost));
  check("未计价密钥 monthCost=0", rowUnpr?.monthCost === 0, String(rowUnpr?.monthCost));

  // ---- E. billing API 数学 ----
  console.log("\n[E] billing API 数学");
  const billing = await (await fetch(`${BASE}/api/console/usage/billing`, { headers: { cookie } })).json() as {
    data?: {
      month: string; prevMonth: string; months: string[];
      rows?: Array<{ apiKeyName: string; requests: number; cost: { cost: number; pricedRequests: number; unpricedRequests: number }; monthlyCostLimit: number; byModel?: Array<{ model: string; requests: number; cost: { cost: number } }> }>;
      totals?: { requests: number; cost: { cost: number; pricedRequests: number; unpricedRequests: number } };
      unpricedModels?: Array<{ model: string }>;
    };
  };
  const bd = billing.data;
  check("billing 默认当前月", bd?.month === monthKey, `${bd?.month} vs ${monthKey}`);
  check("months 含当前月", (bd?.months || []).includes(monthKey), JSON.stringify(bd?.months));
  const billBud = bd?.rows?.find((r) => r.apiKeyName === NAME_BUD);
  const billUnpr = bd?.rows?.find((r) => r.apiKeyName === NAME_UNPR);
  check("billing rows 含 NAME_BUD 且 cost≈0.000165", billBud !== undefined && Math.abs(billBud.cost.cost - 3 * COST_PER_REQ) < 1e-9, JSON.stringify(billBud?.cost));
  check("billing 行附带月预算 0.0001（VirtualKey join 打通）", billBud?.monthlyCostLimit === BUDGET, String(billBud?.monthlyCostLimit));
  check("billing byModel 明细含计价模型行", billBud?.byModel?.some((m) => m.model === MODEL_PRICED && Math.abs(m.cost.cost - 3 * COST_PER_REQ) < 1e-9) === true, JSON.stringify(billBud?.byModel));
  check("billing 未计价密钥 pricedRequests=0 / unpricedRequests=3", billUnpr?.cost.pricedRequests === 0 && billUnpr?.cost.unpricedRequests === 3, JSON.stringify(billUnpr?.cost));
  check("billing unpricedModels 含未计价模型", (bd?.unpricedModels || []).some((u) => u.model === MODEL_UNPRICED), JSON.stringify(bd?.unpricedModels?.slice(0, 3)));
  check("billing totals.requests ≥ 6（3+3 qa 请求）", (bd?.totals?.requests ?? 0) >= 6, String(bd?.totals?.requests));

  // 月份校验：非法回落当前月
  const billingBad = await (await fetch(`${BASE}/api/console/usage/billing?month=2099-13`, { headers: { cookie } })).json() as { data?: { month: string } };
  check("非法月份回落当前月", billingBad.data?.month === monthKey, String(billingBad.data?.month));
  // 未登录 401
  const noAuth = await fetch(`${BASE}/api/console/usage/billing`);
  check("未登录 401", noAuth.status === 401, String(noAuth.status));
} finally {
  // ---- F. 清理（无条件执行；单价表精确恢复原状） ----
  console.log("\n[F] 清理自建资产");
  for (const name of [NAME_BUD, NAME_UNPR]) {
    const k = await db.virtualKey.findFirst({ where: { name } });
    if (k) {
      const d = await fetch(`${BASE}/api/console/keys?id=${k.id}`, { method: "DELETE", headers: { cookie } });
      console.log(`  delete key ${name}:`, d.status);
    }
  }
  for (const model of [MODEL_PRICED, MODEL_UNPRICED]) {
    const r = await fetch(`${BASE}/api/console/routes?model=${encodeURIComponent(model)}`, { method: "DELETE", headers: { cookie } });
    console.log(`  delete route ${model}:`, r.status);
  }
  const provDel = await fetch(`${BASE}/api/console/providers?id=qa-budget`, { method: "DELETE", headers: { cookie } });
  console.log("  delete provider qa-budget:", provDel.status);
  const restore = await putPricing(originalPricingRows);
  console.log("  restore pricing rows:", restore.status, `(${originalPricingRows.length} 行)`);
  await db.$disconnect();
  const healthzAfter = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz 前后等价（providers/models 不变）",
    healthzAfter.providers_active === healthzBefore.providers_active && healthzAfter.models_available === healthzBefore.models_available,
    `${JSON.stringify(healthzBefore)} → ${JSON.stringify(healthzAfter)}`);
  // 单价表恢复核对
  const pricingAfter = await (await fetch(`${BASE}/api/console/pricing`, { headers: { cookie } })).json() as { data?: { rows?: Array<{ model: string }> } };
  const afterModels = (pricingAfter.data?.rows || []).map((r) => r.model).sort();
  const beforeModels = originalPricingRows.map((r) => r.model).sort();
  check("单价表精确恢复原状", JSON.stringify(afterModels) === JSON.stringify(beforeModels), `${afterModels.length} 行 vs ${beforeModels.length} 行`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
