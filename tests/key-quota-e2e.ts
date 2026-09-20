// v4.3.0 QA：虚拟密钥日配额 —— 入口执行路径端到端实测
// 规程：自建测试中转/路由/密钥（qa-quota-*，零业务数据触碰）→ 网关真实调用 →
//       验证 429 执行/头组/账本口径/限额热更新 → 全部自清理 → healthz 等价核对
// 验证点：
//   A. 请求次限额：限额 3 → 前 3 次 200、第 4/5 次 429（rate_limit_error + X-RateLimit 头组
//      + Retry-After）；被拒请求不计数（UsageDaily 该密钥今日 requests 恒 3，无「越拒越超」）
//   B. token 限额：限额 100 tk（mock 每请求 55 tk）→ 第 1/2 次 200（预检按已累计拒绝），
//      第 3 次 429（110 ≥ 100）；单请求自然越过量 = 1 次请求用量（业界通行语义）
//   C. 不限额密钥不受影响：同路由无限额密钥连续调用全 200
//   D. 限额热更新：PUT 提高限额 → 下一请求恢复 200（config_version 传播）
//   E. 账本口径：UsageDaily 今日 requests/token 与预期一致（DB+缓冲合并，同路由实例内精确）
//   F. 清理：自建资产全删 + healthz 前后等价
const BASE = "http://127.0.0.1:3000";

// 轮次唯一后缀：配额账本按密钥名持久累积（与统计页同口径），同名重跑会继承当日用量 ——
// 每轮用唯一名保证从零开始断言（「同名重建继承用量」语义本身正确，见 worklog）
const RUN = String(Date.now()).slice(-6);
const NAME_REQ = `qa-quota-req-${RUN}`;
const NAME_TOK = `qa-quota-tok-${RUN}`;
const NAME_FREE = `qa-quota-free-${RUN}`;

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

const todayDay = new Date();
const day = `${todayDay.getFullYear()}-${String(todayDay.getMonth() + 1).padStart(2, "0")}-${String(todayDay.getDate()).padStart(2, "0")}`;

// ---- 0. 前置：healthz 基线 + 自建测试资产 ----
const healthzBefore = await (await fetch(`${BASE}/healthz`)).json();
console.log("healthz before:", JSON.stringify(healthzBefore));

const provRes = await fetch(`${BASE}/api/console/providers`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    id: "qa-quota", name: "qa-quota", type: "openai", enabled: true,
    config: { baseUrl: "http://127.0.0.1:3040/v1", apiKey: "sk-qa-quota-key" },
  }),
});
console.log("create qa-quota provider:", provRes.status);
const routeRes = await fetch(`${BASE}/api/console/routes`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ model: "qa-quota-model", candidates: [{ providerId: "qa-quota", model: "mock-chat" }] }),
});
console.log("create qa-quota-model route:", routeRes.status);

const mkKey = async (name: string, reqLimit: number, tokLimit: number): Promise<string> => {
  const r = await fetch(`${BASE}/api/console/keys`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name, models: ["*"], dailyRequestLimit: reqLimit, dailyTokenLimit: tokLimit }),
  });
  const j = await r.json() as { data?: { keyValue?: string } };
  if (!j.data?.keyValue) throw new Error(`create key ${name} failed: ${JSON.stringify(j)}`);
  return j.data.keyValue;
};

const chat = async (key: string, model = "qa-quota-model") => {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
  });
};

try {
  // ---- A. 请求次限额 ----
  console.log("\n[A] 请求次限额（dailyRequestLimit=3）");
  const keyA = await mkKey(NAME_REQ, 3, 0);
  const s1 = await chat(keyA), s2 = await chat(keyA), s3 = await chat(keyA);
  check("前 3 次全部 200", s1.status === 200 && s2.status === 200 && s3.status === 200, `${s1.status}/${s2.status}/${s3.status}`);
  const s4 = await chat(keyA);
  const j4 = await s4.json() as { error?: { type?: string; message?: string } };
  check("第 4 次 429", s4.status === 429, String(s4.status));
  check("错误类型 rate_limit_error", j4.error?.type === "rate_limit_error", JSON.stringify(j4.error));
  check("X-RateLimit-Limit=3", s4.headers.get("x-ratelimit-limit") === "3", String(s4.headers.get("x-ratelimit-limit")));
  check("X-RateLimit-Remaining=0", s4.headers.get("x-ratelimit-remaining") === "0", String(s4.headers.get("x-ratelimit-remaining")));
  const ra = Number(s4.headers.get("retry-after"));
  check("Retry-After > 0（本地零点重置秒数）", ra > 0 && ra <= 86400, String(ra));
  check("消息含密钥名与配额说明（3/3）", (j4.error?.message || "").includes(NAME_REQ) && (j4.error?.message || "").includes("3/3"), j4.error?.message);
  const s5 = await chat(keyA);
  check("第 5 次仍 429（持续拒绝）", s5.status === 429, String(s5.status));
  // 等待 flush 后核对账本：被拒请求不计数
  console.log("  … 等待 32s flush 周期后核对账本");
  await new Promise((r) => setTimeout(r, 32_000));
  const rowsA = await db.usageDaily.findMany({ where: { day, apiKeyName: NAME_REQ } });
  const reqA = rowsA.reduce((s, r) => s + r.requests, 0);
  check("账本 requests 恒 3（被拒不计数，无越拒越超）", reqA === 3, String(reqA));

  // ---- B. token 限额 ----
  console.log("\n[B] token 限额（dailyTokenLimit=100，mock 每请求 55 tk）");
  const keyB = await mkKey(NAME_TOK, 0, 100);
  const t1 = await chat(keyB), t2 = await chat(keyB);
  check("第 1/2 次 200（预检按已累计 55 < 100 放行）", t1.status === 200 && t2.status === 200, `${t1.status}/${t2.status}`);
  const t3 = await chat(keyB);
  const jt3 = await t3.json() as { error?: { type?: string; message?: string } };
  check("第 3 次 429（累计 110 ≥ 100）", t3.status === 429, String(t3.status));
  check("token 429 消息含 110/100", (jt3.error?.message || "").includes("110/100"), jt3.error?.message);
  check("token 429 X-RateLimit-Limit=100", t3.headers.get("x-ratelimit-limit") === "100", String(t3.headers.get("x-ratelimit-limit")));
  console.log("  … 等待 32s flush 周期后核对账本");
  await new Promise((r) => setTimeout(r, 32_000));
  const rowsB = await db.usageDaily.findMany({ where: { day, apiKeyName: NAME_TOK } });
  const reqB = rowsB.reduce((s, r) => s + r.requests, 0);
  const tokB = rowsB.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  check("账本 requests=2、tokens=110（单请求自然越过量=55）", reqB === 2 && tokB === 110, `${reqB} req / ${tokB} tk`);

  // ---- C. 不限额密钥不受影响 ----
  console.log("\n[C] 不限额密钥（同路由连续 4 次全 200）");
  const keyC = await mkKey(NAME_FREE, 0, 0);
  const c1 = await chat(keyC), c2 = await chat(keyC), c3 = await chat(keyC), c4 = await chat(keyC);
  check("无限额密钥 4 连 200", [c1, c2, c3, c4].every((r) => r.status === 200), [c1.status, c2.status, c3.status, c4.status].join("/"));

  // ---- D. 限额热更新 ----
  console.log("\n[D] 限额热更新（PUT 提高限额 → 下一请求恢复）");
  const keyRows = await db.virtualKey.findMany({ where: { name: NAME_REQ } });
  const putRes = await fetch(`${BASE}/api/console/keys`, {
    method: "PUT", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ id: keyRows[0].id, name: NAME_REQ, enabled: true, models: ["*"], dailyRequestLimit: 100, dailyTokenLimit: 0 }),
  });
  check("PUT 提高限额 200", putRes.status === 200, String(putRes.status));
  // config_version 传播：下一请求 TTL 命中时版本交叉校验刷新（标准池 e2e 实证过的路径）
  const s6 = await chat(keyA);
  check("提高限额后下一请求恢复 200", s6.status === 200, String(s6.status));
  // 再降回 3：恢复拒绝（双向传播）
  const putRes2 = await fetch(`${BASE}/api/console/keys`, {
    method: "PUT", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ id: keyRows[0].id, name: NAME_REQ, enabled: true, models: ["*"], dailyRequestLimit: 3, dailyTokenLimit: 0 }),
  });
  const s7 = await chat(keyA);
  check("降回 3 后恢复 429（已计 4 ≥ 3）", putRes2.status === 200 && s7.status === 429, `${putRes2.status}/${s7.status}`);

  // ---- E. keys API 回显配额 ----
  console.log("\n[E] keys API 配额回显");
  const keysList = await (await fetch(`${BASE}/api/console/keys`, { headers: { cookie } })).json() as {
    data?: { keys?: Array<{ name: string; dailyRequestLimit?: number; dailyTokenLimit?: number; todayStats?: { requests: number; inputTokens: number; outputTokens: number } | null }> };
  };
  const qa = keysList.data?.keys?.filter((k) => k.name.startsWith("qa-quota-"));
  const qaReq = qa?.find((k) => k.name === NAME_REQ);
  const qaTok = qa?.find((k) => k.name === NAME_TOK);
  check("qa-quota-req 回显 dailyRequestLimit=3", qaReq?.dailyRequestLimit === 3, String(qaReq?.dailyRequestLimit));
  check("qa-quota-tok 回显 dailyTokenLimit=100", qaTok?.dailyTokenLimit === 100, String(qaTok?.dailyTokenLimit));
  check("qa-quota-tok 今日 token=110（进度条数据源）", (qaTok?.todayStats?.inputTokens ?? 0) + (qaTok?.todayStats?.outputTokens ?? 0) === 110, JSON.stringify(qaTok?.todayStats));
} finally {
  // ---- F. 清理（无条件执行） ----
  console.log("\n[F] 清理自建资产");
  for (const name of [NAME_REQ, NAME_TOK, NAME_FREE]) {
    const k = await db.virtualKey.findFirst({ where: { name } });
    if (k) {
      const d = await fetch(`${BASE}/api/console/keys?id=${k.id}`, { method: "DELETE", headers: { cookie } });
      console.log(`  delete key ${name}:`, d.status);
    }
  }
  const routeDel = await fetch(`${BASE}/api/console/routes?model=qa-quota-model`, { method: "DELETE", headers: { cookie } });
  console.log("  delete route qa-quota-model:", routeDel.status);
  const provDel = await fetch(`${BASE}/api/console/providers?id=qa-quota`, { method: "DELETE", headers: { cookie } });
  console.log("  delete provider qa-quota:", provDel.status);
  await db.$disconnect();
  const healthzAfter = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz 前后等价（providers/models 不变）",
    healthzAfter.providers_active === healthzBefore.providers_active && healthzAfter.models_available === healthzBefore.models_available,
    `${JSON.stringify(healthzBefore)} → ${JSON.stringify(healthzAfter)}`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
