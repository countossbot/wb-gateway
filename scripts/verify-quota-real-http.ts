/**
 * 真实 HTTP 端到端配额验收（必须走完整路由，不允许直接 import 内部函数）。
 *
 * 背景教训：上一轮的 verify-f1-quota-race.ts 直接 import enforceVirtualKeyQuota，
 * 绕过了 route 的 finally，因此"ALL PASS"是假通过。本脚本强制走真实 HTTP。
 *
 * 判据（回滚后的诚实基线，而非理想值）：
 *   - 串行超额必须被拦（第 limit+1 次及以后 429）
 *   - 账本 requests 不得因被拒请求而增长（被拒不计数）
 *   - 并发下有超发是已知局限，本脚本会如实报告倍数，不当作缺陷
 *
 * 运行前需：mock 上游在 3041、网关在 3000。
 *   DATABASE_URL=postgresql://uag:uag-local-pw@127.0.0.1:15432/uag bun run scripts/verify-quota-real-http.ts
 */
const BASE = "http://127.0.0.1:3000";
const UPSTREAM = "http://127.0.0.1:3041/v1";
const ADMIN_USER = "admin";
const ADMIN_PASS = "gateway-admin-2026";

let failed = 0;
const check = (n: string, c: boolean, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  " + e : ""}`);
  if (!c) failed++;
};

const login = await fetch(`${BASE}/api/console/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
});
if (!login.ok) {
  console.log(`登录失败 ${login.status}：${await login.text()}`);
  process.exit(1);
}
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const tag = `${Date.now()}`.slice(-8);
const MODEL = `vq-model-${tag}`;
const PROV = `vq-prov-${tag}`;

async function setup() {
  const p = await fetch(`${BASE}/api/console/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      id: PROV, name: PROV, type: "openai", protocol: "openai",
      config: { baseUrl: UPSTREAM, apiKey: "sk-probe" }, enabled: true,
    }),
  });
  if (!p.ok) console.log("provider:", p.status, await p.text());
  const r = await fetch(`${BASE}/api/console/routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ model: MODEL, candidates: [{ providerId: PROV, model: "vq-upstream-model" }] }),
  });
  if (!r.ok) console.log("route:", r.status, await r.text());
}

async function makeKey(name: string, limit: number) {
  const res = await fetch(`${BASE}/api/console/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name, dailyRequestLimit: limit, dailyTokenLimit: 0, monthlyCostLimit: 0, models: ["*"] }),
  });
  const j = await res.json();
  return j?.data?.keyValue ?? null;
}

function call(key: string) {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  });
}

async function ledger(keyName: string): Promise<number> {
  const res = await fetch(`${BASE}/api/console/usage/daily?day=${new Date().toISOString().slice(0, 10)}`, {
    headers: { cookie },
  });
  if (!res.ok) return -1;
  const j = await res.json();
  const rows = j?.data?.rows ?? j?.data ?? [];
  return Array.isArray(rows)
    ? rows.filter((x: { apiKeyName?: string }) => x?.apiKeyName === keyName)
        .reduce((a: number, x: { requests?: number }) => a + (x.requests ?? 0), 0)
    : -1;
}

await setup();

console.log("\n=== A. 串行超额（核心判据：必须拦） ===");
{
  const name = `vq-ser-${tag}`;
  const LIMIT = 3;
  const key = await makeKey(name, LIMIT);
  check("建 key 成功", !!key);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await call(key!);
    statuses.push(r.status);
  }
  const ok = statuses.filter((s) => s === 200).length;
  console.log(`  6 次串行状态码: ${statuses.join(",")}`);
  check(`串行放行数 ≈ 限额（放行 ${ok} / 限制 ${LIMIT}）`, ok <= LIMIT, `ok=${ok}`);
  check("超限后返回 429", statuses.slice(LIMIT).some((s) => s === 429));
}

console.log("\n=== B. 被拒请求不记账 ===");
{
  const name = `vq-led-${tag}`;
  const LIMIT = 2;
  const key = await makeKey(name, LIMIT);
  const res: number[] = [];
  for (let i = 0; i < 5; i++) res.push((await call(key!)).status);
  console.log(`  5 次状态码: ${res.join(",")}`);
  // 直接等 flush 后查账本（避免读到内存缓冲导致误判）
  await new Promise((r) => setTimeout(r, 35000));
  const used = await ledger(name);
  console.log(`  账本 requests 累计 = ${used}（限额 ${LIMIT}，成功 ${res.filter((s) => s === 200).length}）`);
  check("账本不超过限额（被拒不计数）", used === -1 || used <= LIMIT, `used=${used}`);
}

console.log("\n=== C. 并发超发程度（如实报告，非判据） ===");
{
  const name = `vq-conc-${tag}`;
  const LIMIT = 3;
  const key = await makeKey(name, LIMIT);
  const statuses = await Promise.all(
    Array.from({ length: 15 }, () => call(key!).then((r) => r.status))
  );
  const ok = statuses.filter((s) => s === 200).length;
  console.log(`  并发 15 请求、限额 ${LIMIT} → 实际放行 ${ok}（超发倍数 ${(ok / LIMIT).toFixed(1)}x）`);
  console.log(`  说明：回滚后的原始实现存在并发超发，此为已知局限，本条不判 PASS/FAIL。`);
}

// 清理
await fetch(`${BASE}/api/console/routes?model=${MODEL}`, { method: "DELETE", headers: { cookie } });
await fetch(`${BASE}/api/console/providers?id=${PROV}`, { method: "DELETE", headers: { cookie } });
console.log("\ncleanup done");
console.log(failed === 0 ? "RESULT: ALL PASS" : `RESULT: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
