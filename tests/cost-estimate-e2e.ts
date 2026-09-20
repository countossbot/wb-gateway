// v4.4.0 QA：用量成本估算 —— ModelPricing 单价表 → 各聚合端点数学一致性 端到端实测
// 规程：仅在自建的 ModelPricing 表写入临时单价（qa 成本验证后整表清空），零业务数据触碰；
//       数学基准取自 DB 直读（UsageDaily 窗口行），逐端点断言估算值在 1e-6 容差内一致。
// 验证点：
//   A. GET /api/console/pricing：初始 rows（清场）+ unpricedModels 含在用模型
//   B. PUT 定价（2 模型：含缓存单价 / 缓存 0 价）→ 回显 rows + saved/deleted 计数
//   C. PUT 输入校验：非法模型名 / 负单价 / 载荷内重复模型名 → 400
//   D. usage/daily?days=7 数学：byModel 行成本 = Σ tokens × 单价（1e-6）；totals 一致；
//      行级 rows cost 一致；未计价行 cost=null；桶级 priced/unpriced 计数守恒
//   E. overview 数学：cost.today / window7d / trend7d 逐日 / topModels[0] / 环比上期
//   F. insights?tp_days=7：top_providers_7d 桶级成本 = 该提供商 Σ 模型行成本
//   G. logs API：已计价模型行 cost>0 且与 tokens×单价一致；未计价模型行 cost=null
//   H. 日志 CSV 导出头含「估算成本$」列且首行数据格式合法
//   I. 审计：PUT 落 auditLog（entity=setting / model-pricing）
//   J. 清理：PUT rows=[] 全删 → GET rows=[] → overview cost.pricingRows=0；healthz 前后等价
const BASE = "http://127.0.0.1:3000";

const login = await fetch(`${BASE}/api/console/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "gateway-admin-2026" }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
console.log("login:", login.status);
if (login.status !== 200) process.exit(1);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " —— " + detail : ""}`); }
};
const api = async (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, { ...init, headers: { cookie, ...(init?.headers || {}) } });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

// ---------- healthz 基线 ----------
const hz0 = await (await fetch(`${BASE}/healthz`)).json();

// ---------- A. 初始状态（清场：删除历史 QA 残留，正常业务下应为空） ----------
await db.modelPricing.deleteMany({ where: { model: { startsWith: "qa-cost-" } } });
const getA = await (await api("/api/console/pricing")).json();
check("A1 GET pricing 返回 ok 结构", getA.ok === true && Array.isArray(getA.data.rows) && Array.isArray(getA.data.unpricedModels));
check("A2 rows 为空（清场后）", getA.data.rows.length === 0, JSON.stringify(getA.data.rows));
check("A3 unpricedModels 含近 30 天在用模型", getA.data.unpricedModels.length > 0, `n=${getA.data.unpricedModels.length}`);
const unpricedBefore = new Set(getA.data.unpricedModels.map((u: { model: string }) => u.model));

// ---------- 数学基准：DB 直读 7 天窗口（本地日键与后端同口径） ----------
const dayKeys = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - (6 - i));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
});
const winRows = await db.usageDaily.findMany({ where: { day: { in: dayKeys } } });
const aggBy = (fn: (r: (typeof winRows)[number]) => string) => {
  const m = new Map<string, { requests: number; in: number; out: number; cached: number }>();
  for (const r of winRows) {
    const k = fn(r);
    const b = m.get(k) || { requests: 0, in: 0, out: 0, cached: 0 };
    b.requests += r.requests; b.in += r.inputTokens; b.out += r.outputTokens; b.cached += r.cachedTokens;
    m.set(k, b);
  }
  return m;
};
const byModelDb = aggBy((r) => r.model || "(empty)");
const byProviderDb = aggBy((r) => r.providerId || "(empty)");
// 选两个有流量的模型：主模型（有缓存命中）+ 次模型（缓存 0 价验证）
const modelCandidates = Array.from(byModelDb.entries()).filter(([m]) => m && m !== "(empty)").sort((a, b) => b[1].requests - a[1].requests);
const M1 = modelCandidates[0][0];
const M2 = modelCandidates[1]?.[0] || M1;
const P1 = { input: 0.5, output: 2, cached: 0.1 }; // M1：缓存计价
const P2 = { input: 1, output: 3, cached: 0 };    // M2：缓存 0 价
const costOf = (m: string, inT: number, outT: number, cached: number) => {
  if (m === M1) return (inT * P1.input + outT * P1.output + cached * P1.cached) / 1e6;
  if (m === M2) return (inT * P2.input + outT * P2.output + cached * P2.cached) / 1e6;
  return null;
};
const r1 = byModelDb.get(M1)!;
const r2 = byModelDb.get(M2)!;
const costM1 = costOf(M1, r1.in, r1.out, r1.cached)!;
const costM2 = costOf(M2, r2.in, r2.out, r2.cached)!;
const totalWinCost = costM1 + costM2;
const pricedReq = r1.requests + r2.requests;
const totalReq = winRows.reduce((s, r) => s + r.requests, 0);
const unpricedReq = totalReq - pricedReq;
console.log(`基准：M1=${M1}（${r1.requests} 次，$${costM1.toFixed(4)}）M2=${M2}（${r2.requests} 次，$${costM2.toFixed(4)}）总计 $${totalWinCost.toFixed(4)}`);

// ---------- B. PUT 定价 ----------
const putB = await (await api("/api/console/pricing", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rows: [
    { model: M1, inputPerMTok: P1.input, outputPerMTok: P1.output, cachedPerMTok: P1.cached },
    { model: M2, inputPerMTok: P2.input, outputPerMTok: P2.output, cachedPerMTok: P2.cached },
  ] }),
})).json();
check("B1 PUT 定价成功", putB.ok === true && putB.data.saved === 2 && putB.data.deleted === 0, JSON.stringify(putB));
check("B2 回显 rows 2 行且单价精确", putB.data.rows.length === 2 && putB.data.rows.every((r: { model: string; inputPerMTok: number }) => (r.model === M1 && r.inputPerMTok === P1.input) || (r.model === M2 && r.inputPerMTok === P2.input)));

// ---------- C. PUT 输入校验 ----------
const badCases = [
  { name: "C1 非法模型名拒绝", body: { rows: [{ model: "bad name!", inputPerMTok: 1, outputPerMTok: 1, cachedPerMTok: 0 }] } },
  { name: "C2 负单价拒绝", body: { rows: [{ model: "ok-model", inputPerMTok: -1, outputPerMTok: 1, cachedPerMTok: 0 }] } },
  { name: "C3 载荷重复模型拒绝", body: { rows: [
    { model: "dup-model", inputPerMTok: 1, outputPerMTok: 1, cachedPerMTok: 0 },
    { model: "dup-model", inputPerMTok: 2, outputPerMTok: 1, cachedPerMTok: 0 },
  ] } },
];
for (const c of badCases) {
  const res = await api("/api/console/pricing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.body) });
  check(c.name, res.status === 400, `status=${res.status}`);
}

// ---------- D. usage/daily 数学 ----------
const pivot = await (await api("/api/console/usage/daily?days=7")).json();
const byModelApi = new Map(pivot.data.pivot.byModel.map((r: { model: string }) => [r.model, r]));
const rowM1 = byModelApi.get(M1);
const rowM2 = byModelApi.get(M2);
check("D1 byModel M1 成本数学（1e-6）", rowM1 && Math.abs(rowM1.cost.cost - costM1) < 1e-6, `api=${rowM1?.cost.cost} db=${costM1}`);
check("D2 byModel M2 成本数学（缓存 0 价）", rowM2 && Math.abs(rowM2.cost.cost - costM2) < 1e-6, `api=${rowM2?.cost.cost} db=${costM2}`);
const t = pivot.data.pivot.totals;
check("D3 totals 成本 = M1+M2", Math.abs(t.cost.cost - totalWinCost) < 1e-6, `api=${t.cost.cost} db=${totalWinCost}`);
check("D4 totals priced+unpriced 计数守恒", t.cost.pricedRequests === pricedReq && t.cost.unpricedRequests === unpricedReq, `api=${t.cost.pricedRequests}/${t.cost.unpricedRequests} db=${pricedReq}/${unpricedReq}`);
// 行级 & 桶级守恒（byProvider）
const byProviderApi = new Map(pivot.data.pivot.byProvider.map((r: { providerId: string }) => [r.providerId, r]));
let provCostOk = true, provDetail = "";
for (const [pid, b] of byProviderDb.entries()) {
  if (pid === "(empty)") continue;
  const api2 = byProviderApi.get(pid);
  let expect = 0;
  for (const r of winRows) {
    if ((r.providerId || "(empty)") !== pid) continue;
    const c = costOf(r.model || "(empty)", r.inputTokens, r.outputTokens, r.cachedTokens);
    if (c !== null) expect += c;
  }
  if (!api2 || Math.abs(api2.cost.cost - expect) > 1e-6) { provCostOk = false; provDetail = `${pid}: api=${api2?.cost.cost} expect=${expect}`; break; }
}
check("D5 byProvider 桶级成本逐桶数学", provCostOk, provDetail);
// 行级 rows：未计价模型行 cost=null；已计价行有值
const rawRowM1 = pivot.data.rows.find((r: { model: string }) => r.model === M1);
const rawRowOther = pivot.data.rows.find((r: { model: string }) => r.model !== M1 && r.model !== M2);
check("D6 行级 rows 已计价模型 cost 有值", rawRowM1 && typeof rawRowM1.cost === "number" && rawRowM1.cost > 0);
check("D7 行级 rows 未计价模型 cost=null", rawRowOther ? rawRowOther.cost === null : true, rawRowOther ? `model=${rawRowOther.model} cost=${rawRowOther.cost}` : "（全部模型均已计价）");

// ---------- E. overview 数学 ----------
const ov = await (await api("/api/console/overview")).json();
const cost = ov.data.cost;
check("E1 overview cost 结构完整", cost && cost.today && cost.window7d && Array.isArray(cost.trend7d) && Array.isArray(cost.topModels) && cost.pricingRows === 2);
check("E2 window7d 成本 = M1+M2（7 天口径）", Math.abs(cost.window7d.cost - totalWinCost) < 1e-6, `api=${cost.window7d.cost} db=${totalWinCost}`);
check("E3 window7d 计数守恒", cost.window7d.pricedRequests === pricedReq && cost.window7d.unpricedRequests === unpricedReq);
// 今日数学（今日行）
const todayKey = dayKeys[6];
const todayWin = winRows.filter((r) => r.day === todayKey);
let todayCostDb = 0;
for (const r of todayWin) {
  const c = costOf(r.model || "(empty)", r.inputTokens, r.outputTokens, r.cachedTokens);
  if (c !== null) todayCostDb += c;
}
check("E4 today 成本数学", Math.abs(cost.today.cost - todayCostDb) < 1e-6, `api=${cost.today.cost} db=${todayCostDb}`);
// trend7d 逐日数学
let trendOk = true, trendDetail = "";
for (const day of dayKeys) {
  let dbDay = 0;
  for (const r of winRows) {
    if (r.day !== day) continue;
    const c = costOf(r.model || "(empty)", r.inputTokens, r.outputTokens, r.cachedTokens);
    if (c !== null) dbDay += c;
  }
  const apiDay = cost.trend7d.find((x: { day: string }) => x.day === day);
  if (!apiDay || Math.abs(apiDay.cost - dbDay) > 1e-6) { trendOk = false; trendDetail = `${day}: api=${apiDay?.cost} db=${dbDay}`; break; }
}
check("E5 trend7d 逐日成本数学（7 天）", trendOk, trendDetail);
// topModels[0] 应为成本最高模型
const topCost = Math.max(costM1, costM2);
const topModelName = costM1 >= costM2 ? M1 : M2;
check("E6 topModels[0] = 成本最高模型", cost.topModels.length > 0 && cost.topModels[0].model === topModelName && Math.abs(cost.topModels[0].cost - topCost) < 1e-6, JSON.stringify(cost.topModels));
// top_providers_7d 种子行带成本
const tpSeed = ov.data.top_providers_7d || [];
check("E7 overview 种子 top_providers 行带 cost 字段", tpSeed.every((r: { cost: number }) => typeof r.cost === "number"));

// ---------- F. insights TopProviders 数学 ----------
const ins = await (await api("/api/console/overview/insights?mh_days=7&tp_days=7&slo_hours=24")).json();
const tpRows = ins.data.top_providers_7d;
check("F1 insights top_providers 行带 cost/pricedRequests", tpRows.every((r: { cost: number; pricedRequests: number }) => typeof r.cost === "number" && typeof r.pricedRequests === "number"));
let tpOk = true, tpDetail = "";
for (const r of tpRows) {
  let expect = 0;
  for (const w of winRows) {
    if ((w.providerId || "(empty)") !== r.providerId) continue;
    const c = costOf(w.model || "(empty)", w.inputTokens, w.outputTokens, w.cachedTokens);
    if (c !== null) expect += c;
  }
  if (Math.abs(r.cost - expect) > 1e-6) { tpOk = false; tpDetail = `${r.providerId}: api=${r.cost} expect=${expect}`; break; }
}
check("F2 insights Top 提供商桶级成本数学", tpOk, tpDetail);

// ---------- G. logs API 行级成本 ----------
const logs = await (await api("/api/console/logs?limit=50")).json();
const pricedLog = logs.data.items.find((l: { model: string; inputTokens: number | null; outputTokens: number | null }) => l.model === M1 && (l.inputTokens ?? 0) > 0);
const unpricedLog = logs.data.items.find((l: { model: string }) => l.model !== M1 && l.model !== M2);
if (pricedLog) {
  const expect = ((pricedLog.inputTokens || 0) * P1.input + (pricedLog.outputTokens || 0) * P1.output + (pricedLog.cachedTokens || 0) * P1.cached) / 1e6;
  check("G1 日志行成本数学（M1 行）", Math.abs(pricedLog.cost - expect) < 1e-6, `api=${pricedLog.cost} expect=${expect}`);
} else {
  check("G1 日志行成本数学（M1 行）", true, "（首页 50 行无 M1 行，跳过）");
}
check("G2 未计价模型日志行 cost=null", unpricedLog ? unpricedLog.cost === null : true, unpricedLog ? `model=${unpricedLog.model} cost=${unpricedLog.cost}` : "（全部行均已计价）");

// ---------- H. 日志 CSV 导出含成本列 ----------
const csvRes = await api("/api/console/logs/export");
const csvText = await csvRes.text();
check("H1 CSV 头含「估算成本$」列", csvText.includes("估算成本$"));
// BOM 字节级验证（fetch text() 按 Encoding 规范剥离前导 BOM，需 arrayBuffer 看原始字节 EF BB BF）
const csvBytes = new Uint8Array(await (await api("/api/console/logs/export")).arrayBuffer());
check("H2 CSV 含 UTF-8 BOM（EF BB BF）与 CRLF", csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf && csvText.includes("\r\n"));
const headerCells = csvText.split("\r\n")[0].split(",");
check("H3 CSV 列序：估算成本$ 在 用量来源 之后 错误 之前", headerCells.indexOf("估算成本$") === headerCells.indexOf("用量来源") + 1 && headerCells.indexOf("错误") === headerCells.indexOf("估算成本$") + 1);

// ---------- I. 审计落点 ----------
const audit = await db.auditLog.findFirst({ where: { entity: "setting", entityId: "model-pricing" }, orderBy: { id: "desc" } });
check("I1 PUT 落审计（setting/model-pricing）", audit !== null && (audit.detail as { saved?: number })?.saved === 2, JSON.stringify(audit?.detail));

// ---------- J. 清理 ----------
const putClear = await (await api("/api/console/pricing", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rows: [] }),
})).json();
check("J1 清空定价（saved=0 deleted=2）", putClear.ok === true && putClear.data.saved === 0 && putClear.data.deleted === 2, JSON.stringify(putClear));
const getAfter = await (await api("/api/console/pricing")).json();
check("J2 GET rows 为空", getAfter.data.rows.length === 0);
check("J3 unpricedModels 恢复（含 M1）", getAfter.data.unpricedModels.some((u: { model: string }) => u.model === M1));
const ovAfter = await (await api("/api/console/overview")).json();
check("J4 overview cost.pricingRows=0（空态引导）", ovAfter.data.cost.pricingRows === 0 && ovAfter.data.cost.window7d.cost === 0);
const pivotAfter = await (await api("/api/console/usage/daily?days=7")).json();
check("J5 透视 totals 成本归零且未计价=全部", pivotAfter.data.pivot.totals.cost.cost === 0 && pivotAfter.data.pivot.totals.cost.unpricedRequests === totalReq);

// ---------- healthz 等价 ----------
const hz1 = await (await fetch(`${BASE}/healthz`)).json();
check("J6 healthz 前后等价", hz0.version === hz1.version && hz0.providers_active === hz1.providers_active && hz0.models_available === hz1.models_available, `${JSON.stringify(hz0)} → ${JSON.stringify(hz1)}`);

await db.$disconnect();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
