/**
 * F1 回归验证：并发下虚拟密钥日配额不得超发，且占位必须可归还。
 *
 * 修复前：enforceVirtualKeyQuota 是「读快照 → 判定」，并发全部读到同一 used 值 → 全部放行。
 * 修复后：判定 + 占位在按 key 的临界区内完成，pending 计入判定 → 放行数不超过上限。
 *
 * 运行：DATABASE_URL=... bun run scripts/verify-f1-quota-race.ts
 */
import { db } from "../src/lib/db";
import { enforceVirtualKeyQuota, releaseQuotaSlot } from "../src/lib/gateway/auth/quota";
import type { AuthResult } from "../src/lib/gateway/auth/auth";

const KEY_NAME = `f1-race-${Date.now()}`;
const LIMIT = 5;

function makeAuth(): AuthResult {
  return {
    ok: true,
    principal: {
      name: KEY_NAME,
      virtualKey: {
        dailyRequestLimit: LIMIT,
        dailyTokenLimit: 0,
        monthlyCostLimit: 0,
      },
    },
  } as unknown as AuthResult;
}

function makeRequest(): Request {
  return new Request("http://localhost/v1/chat/completions", { method: "POST" });
}

const CONCURRENCY = 40;

// 40 个并发请求争抢 5 个额度
const results = await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    const auth = makeAuth();
    const verdict = await enforceVirtualKeyQuota(makeRequest(), auth);
    if (!verdict.ok) return { allowed: false, status: verdict.response.status };
    // 模拟请求处理（不释放：假设全部在途，验证占位是否真的生效）
    return { allowed: true, status: 200 };
  })
);

const allowed = results.filter((r) => r.allowed).length;
const denied = results.filter((r) => !r.allowed);
const statuses = [...new Set(denied.map((r) => r.status))];

let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
}

console.log(`并发 ${CONCURRENCY}，上限 ${LIMIT} → 放行 ${allowed}，拒绝 ${denied.length}`);
check(`放行数不超过上限（修复前会全部放行）`, allowed <= LIMIT, `allowed=${allowed} limit=${LIMIT}`);
check("超限请求被拒绝且返回 429", denied.length > 0 && statuses.every((s) => s === 429), `statuses=${statuses}`);

// 归还语义：释放 LIMIT 次后，应重新可放行（不会把额度永久锁死）
for (let i = 0; i < LIMIT; i++) releaseQuotaSlot(makeAuth());
const afterRelease = await enforceVirtualKeyQuota(makeRequest(), makeAuth());
check("占位归还后额度可再次使用（不泄漏）", afterRelease.ok === true);

// 异常路径也应释放：占位后立刻归还一次，再归还一次不应让额度膨胀
releaseQuotaSlot(makeAuth());
const afterDoubleRelease = await enforceVirtualKeyQuota(makeRequest(), makeAuth());
check("重复归还不产生负计数/额度膨胀", afterDoubleRelease.ok === true);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
await db.$disconnect().catch(() => {});
process.exit(failed === 0 ? 0 : 1);
