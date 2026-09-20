// v4.2.2 QA：标准适配器多账号轮换 —— 网关端到端实测
// 规程：自建测试中转/账号/路由（qa-pool / qa-solo）→ 实测 → 全部自清理 → healthz 等价核对
// 验证点：
//   A. 轮换均匀性：3 好账号发 6 次请求 → perKey 每账号恰 2 次（round-robin 均匀）
//   B. 401 失败切换：加入坏 key 账号 → 请求仍 200（自动切好账号）+ 坏 key 冷却
//   C. 冷却跳过：后续 6 次请求全部成功且坏 key 被打次数不增长（退避期内跳过）
//   D. X-Gateway-Account 落点上报：响应头返回真实账号 id；日志 accountId 非 default
//   E. 单密钥兼容回归：无账号池提供商 → 行为与 v4.2.1 零变化（X-Gateway-Account=default）
//   F. 熔断落库：请求日志的 accountId 字段记录真实账号
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

const chat = async (model: string, key: string, text = "hello") => {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, account: r.headers.get("x-gateway-account") || "", body };
};

const stats = async () => (await (await fetch(`${MOCK}/__stats`)).json()) as { cancelledCount: number; perKey: Record<string, number> };

// ---- 0. 前置 ----
const healthzBefore = await (await fetch(`${BASE}/healthz`)).json();
await fetch(`${MOCK}/__stats/reset`, { method: "POST" }).catch(() => {});

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const vk = await db.virtualKey.findFirst({ where: { name: "test" } });
const key = vk!.keyValue;

// ---- 1. 自建多账号池中转 + 路由 ----
const provRes = await fetch(`${BASE}/api/console/providers`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    id: "qa-pool", name: "qa-pool", type: "openai", enabled: true,
    config: { baseUrl: "http://127.0.0.1:3040/v1" },
    accounts: [
      { id: "qa-a", name: "Key A", credentials: { apiKey: "sk-pool-aaa1111" } },
      { id: "qa-b", name: "Key B", credentials: { apiKey: "sk-pool-bbb2222" } },
      { id: "qa-c", name: "Key C", credentials: { apiKey: "sk-pool-ccc3333" } },
    ],
  }),
});
console.log("create qa-pool provider:", provRes.status);
const routeRes = await fetch(`${BASE}/api/console/routes`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ model: "qa-pool-model", candidates: [{ providerId: "qa-pool", model: "mock-chat" }] }),
});
console.log("create qa-pool route:", routeRes.status);

// ---- 2. 单密钥兼容中转（E 用） ----
const soloRes = await fetch(`${BASE}/api/console/providers`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    id: "qa-solo", name: "qa-solo", type: "openai", enabled: true,
    config: { baseUrl: "http://127.0.0.1:3040/v1", apiKey: "sk-solo-direct" },
  }),
});
console.log("create qa-solo provider:", soloRes.status);
const soloRoute = await fetch(`${BASE}/api/console/routes`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ model: "qa-solo-model", candidates: [{ providerId: "qa-solo", model: "mock-chat" }] }),
});
console.log("create qa-solo route:", soloRoute.status);

try {
  // ---- A. 轮换均匀性 ----
  console.log("\n[A] 3 账号 round-robin 均匀性（6 次请求）");
  {
    const accountsHit: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await chat("qa-pool-model", key);
      if (r.status !== 200) { check(`请求 ${i + 1} 200`, false, `status=${r.status} ${JSON.stringify(r.body)}`); break; }
      accountsHit.push(r.account);
      check(`请求 ${i + 1} 带真实账号落点头`, ["qa-a", "qa-b", "qa-c"].includes(r.account), `X-Gateway-Account=${r.account}`);
    }
    const unique = new Set(accountsHit);
    check("3 账号全部被轮到", unique.size === 3, `unique=${[...unique].join(",")}`);
    const s = await stats();
    const counts = ["sk-pool-aaa1111", "sk-pool-bbb2222", "sk-pool-ccc3333"].map((k) => s.perKey[k] || 0);
    check("perKey 每账号恰 2 次（均匀）", counts.every((c) => c === 2), `counts=${counts.join(",")} perKey=${JSON.stringify(s.perKey)}`);
  }

  // ---- B. 401 失败切换 + 冷却（相位无关确定性设计） ----
  // 轮换 counter 是网关模块级延续状态（历次运行累积，相位不可知）——「多账号池里等 bad 轮到
  // 首选」依赖相位运气。改用确定性构造：独立单坏账号池（唯一账号必首选 → 401 必然发生），
  // 再中途添加好账号（唯一健康账号必首选 → 冷却中的坏账号必然被跳过）。
  console.log("\n[B] 401 key 失效 → 冷却落库 + 切换（独立池确定性验证）");
  {
    // 单坏账号池：401 必然发生
    await fetch(`${BASE}/api/console/providers`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        id: "qa-bad-pool", name: "qa-bad-pool", type: "openai", enabled: true,
        config: { baseUrl: "http://127.0.0.1:3040/v1" },
        accounts: [{ id: "only-bad", name: "Only Bad", credentials: { apiKey: "sk-bad-9999" } }],
      }),
    });
    await fetch(`${BASE}/api/console/routes`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ model: "qa-bad-model", candidates: [{ providerId: "qa-bad-pool", model: "mock-chat" }] }),
    });
    await fetch(`${MOCK}/__stats/reset`, { method: "POST" });
    const r401 = await chat("qa-bad-model", key);
    check("单坏账号池请求返回 401（唯一账号失败直返）", r401.status === 401, `status=${r401.status}`);
    const s1 = await stats();
    check("坏 key 被 mock 实打（perKey=1）", (s1.perKey["sk-bad-9999"] || 0) === 1, JSON.stringify(s1.perKey));

    // 冷却落库（SQLite 持久化）
    const badAcc = await db.account.findUnique({ where: { providerId_id: { providerId: "qa-bad-pool", id: "only-bad" } } });
    check("坏账号冷却已落库（cooldownUntil 非空 + reason 含 401/key）",
      !!badAcc?.cooldownUntil && /401|key/i.test(String(badAcc?.cooldownReason || "")),
      `cooldownUntil=${badAcc?.cooldownUntil} reason=${badAcc?.cooldownReason}`);
    const cdRemain = badAcc?.cooldownUntil ? badAcc.cooldownUntil.getTime() - Date.now() : 0;
    check("退避时长合理（30s ~ 8min 封顶内）", cdRemain > 30_000 && cdRemain < 8 * 60_000, `remain=${Math.round(cdRemain / 1000)}s`);

    // 中途添加好账号：冷却中的坏账号被跳过，请求落唯一健康账号（相位无关）
    const addGood = await fetch(`${BASE}/api/console/accounts`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ providerId: "qa-bad-pool", id: "only-good", name: "Only Good", credentials: { apiKey: "sk-pool-aaa1111" } }),
    });
    check("中途添加好账号（验证 config 增量传播）", addGood.status === 200 || addGood.status === 201, await addGood.text().catch(() => ""));

    // ---- C. 冷却跳过（合并在同池验证） ----
    let switched = false;
    for (let i = 0; i < 6; i++) {
      const r = await chat("qa-bad-model", key);
      if (r.status !== 200) { check(`请求 ${i + 1} 200（冷却跳过 + 好账号接管）`, false, `status=${r.status} ${JSON.stringify(r.body).slice(0, 120)}`); break; }
      if (r.account === "only-good") switched = true;
    }
    check("好账号接管：请求全部 200 且落 only-good", switched, "");
    const s2 = await stats();
    check("冷却期内坏 key 零重试（perKey 仍 1）", (s2.perKey["sk-bad-9999"] || 0) === 1, JSON.stringify(s2.perKey));
  }

  // ---- D. 日志落点（accountId 非 default） ----
  console.log("\n[D] 请求日志记录真实账号落点");
  {
    const logsRes = await fetch(`${BASE}/api/console/logs?limit=20&model=qa-pool-model`, { headers: { cookie } });
    const data = await logsRes.json() as { data?: { items?: Array<{ accountId?: string; providerId?: string; status?: number }> } };
    const logs = data.data?.items || [];
    check("拿到 qa-pool-model 日志", logs.length > 0, `count=${logs.length}`);
    const withAccount = logs.filter((l) => l.accountId && l.accountId !== "default");
    check("日志 accountId 为真实账号 id（非 default）", withAccount.length > 0,
      `sample=${logs.slice(0, 3).map((l) => l.accountId).join(",")}`);
    const distinctAccounts = new Set(withAccount.map((l) => l.accountId));
    check("日志可见多账号轮换痕迹（≥2 个不同落点）", distinctAccounts.size >= 2,
      `distinct=${[...distinctAccounts].join(",")}`);
  }

  // ---- E. 单密钥兼容回归 ----
  console.log("\n[E] 无账号池 → 单密钥直发（v4.2.1 行为零变化）");
  {
    const r = await chat("qa-solo-model", key);
    check("单密钥请求 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    check("密钥指纹正确（provider 级 key 直发）", JSON.stringify(r.body).includes("[key:rect]"), JSON.stringify(r.body).slice(0, 200));
    check("X-Gateway-Account=default（兼容口径不变）", r.account === "default", `got=${r.account}`);
  }

  // ---- F. Anthropic 适配器账号池（callMessages 原生通道） ----
  console.log("\n[F] Anthropic 原生 /v1/messages 多账号轮换");
  {
    await fetch(`${BASE}/api/console/providers`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        id: "qa-ant", name: "qa-ant", type: "anthropic", enabled: true,
        config: { baseUrl: "http://127.0.0.1:3040" },
        accounts: [
          { id: "ant-a", name: "Ant A", credentials: { apiKey: "sk-ant-aaa1111" } },
          { id: "ant-b", name: "Ant B", credentials: { apiKey: "sk-ant-bbb2222" } },
        ],
      }),
    });
    await fetch(`${BASE}/api/console/routes`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ model: "qa-ant-model", candidates: [{ providerId: "qa-ant", model: "mock-anthropic" }] }),
    });
    await fetch(`${MOCK}/__stats/reset`, { method: "POST" });

    const accountsHit: string[] = [];
    let antOk = true;
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${BASE}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "qa-ant-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status !== 200) { antOk = false; check(`请求 ${i + 1} 200`, false, `status=${r.status} ${JSON.stringify(body).slice(0, 150)}`); break; }
      accountsHit.push(r.headers.get("x-gateway-account") || "");
      const text = Array.isArray(body.content) ? String(body.content[0]?.text || "") : "";
      check(`请求 ${i + 1} Anthropic 响应格式 + 密钥指纹`, text.includes("[key:1111]") || text.includes("[key:2222]"), text.slice(0, 80));
    }
    if (antOk) {
      check("落点头在 ant-a/ant-b 间轮换", accountsHit.every((a) => ["ant-a", "ant-b"].includes(a)) && new Set(accountsHit).size >= 2,
        `hits=${accountsHit.join(",")}`);
      const s = await stats();
      const counts = ["sk-ant-aaa1111", "sk-ant-bbb2222"].map((k) => s.perKey[k] || 0);
      check("anthropic perKey 每账号恰 2 次（均匀）", counts.every((c) => c === 2), `counts=${counts.join(",")}`);
    }
  }

  // ---- 清理 ----
  console.log("\n[清理] 删除自建测试数据");
  {
    const delRoute1 = await fetch(`${BASE}/api/console/routes?model=qa-pool-model`, { method: "DELETE", headers: { cookie } });
    const delRoute2 = await fetch(`${BASE}/api/console/routes?model=qa-solo-model`, { method: "DELETE", headers: { cookie } });
    const delRoute3 = await fetch(`${BASE}/api/console/routes?model=qa-bad-model`, { method: "DELETE", headers: { cookie } });
    const delRoute4 = await fetch(`${BASE}/api/console/routes?model=qa-ant-model`, { method: "DELETE", headers: { cookie } });
    const delProv1 = await fetch(`${BASE}/api/console/providers?id=qa-pool`, { method: "DELETE", headers: { cookie } });
    const delProv2 = await fetch(`${BASE}/api/console/providers?id=qa-solo`, { method: "DELETE", headers: { cookie } });
    const delProv3 = await fetch(`${BASE}/api/console/providers?id=qa-bad-pool`, { method: "DELETE", headers: { cookie } });
    const delProv4 = await fetch(`${BASE}/api/console/providers?id=qa-ant`, { method: "DELETE", headers: { cookie } });
    check("删 qa-pool-model 路由", delRoute1.status === 200, String(delRoute1.status));
    check("删 qa-solo-model 路由", delRoute2.status === 200, String(delRoute2.status));
    check("删 qa-bad-model 路由", delRoute3.status === 200, String(delRoute3.status));
    check("删 qa-ant-model 路由", delRoute4.status === 200, String(delRoute4.status));
    check("删 qa-pool 提供商（连带 3 账号）", delProv1.status === 200, String(delProv1.status));
    check("删 qa-solo 提供商", delProv2.status === 200, String(delProv2.status));
    check("删 qa-bad-pool 提供商（连带 2 账号）", delProv3.status === 200, String(delProv3.status));
    check("删 qa-ant 提供商（连带 2 账号）", delProv4.status === 200, String(delProv4.status));
    const leftover = await db.account.findMany({ where: { providerId: { in: ["qa-pool", "qa-solo", "qa-bad-pool", "qa-ant"] } } });
    check("账号级联删除无残留", leftover.length === 0, `leftover=${leftover.length}`);
  }
} finally {
  await db.$disconnect();
}

// ---- healthz 等价核对 ----
const healthzAfter = await (await fetch(`${BASE}/healthz`)).json();
check("healthz providers 前后等价", healthzBefore.providers_active === healthzAfter.providers_active,
  `before=${healthzBefore.providers_active} after=${healthzAfter.providers_active}`);
check("healthz models 前后等价", healthzBefore.models_available === healthzAfter.models_available,
  `before=${healthzBefore.models_available} after=${healthzAfter.models_available}`);
check("版本 v4.2.2", healthzAfter.version === "4.2.2", `version=${healthzAfter.version}`);

console.log(`\n==== 结果：${pass} 通过 / ${fail} 失败 ====`);
if (fail > 0) process.exit(1);
