/**
 * F1-3 验证：流式响应的配额占位必须持续到 body 消费结束，而非 handler 返回时。
 *
 * 修复前：路由 finally 在 handler 返回瞬间释放占位 → 流式期间 pending 归零，
 *         并发长流式请求全部放行（审查发现的真实缺陷）。
 * 修复后：bindQuotaSlotToResponse 把释放绑定到 body 的结束/取消。
 */
import { enforceVirtualKeyQuota, releaseQuotaSlot, bindQuotaSlotToResponse } from "../src/lib/gateway/auth/quota";
import type { AuthResult } from "../src/lib/gateway/auth/auth";

const KEY_NAME = `f13-stream-${Date.now()}`;
const LIMIT = 3;

function makeAuth(): AuthResult {
  return {
    ok: true,
    principal: {
      name: KEY_NAME,
      virtualKey: { dailyRequestLimit: LIMIT, dailyTokenLimit: 0, monthlyCostLimit: 0 },
    },
  } as unknown as AuthResult;
}
const req = () => new Request("http://localhost/v1/chat/completions", { method: "POST" });

let failed = 0;
const check = (n: string, c: boolean, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  " + e : ""}`);
  if (!c) failed++;
};

// 模拟 3 个「流式」请求占位，包装成流式 Response 但**不消费 body**
const wrapped: Response[] = [];
for (let i = 0; i < LIMIT; i++) {
  const v = await enforceVirtualKeyQuota(req(), makeAuth());
  if (!v.ok) break;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: chunk${i}\n\n`));
      // 故意不 close：模拟长连接中的流
    },
  });
  wrapped.push(bindQuotaSlotToResponse(new Response(stream), makeAuth()));
}

// 关键断言：流未结束时，占位必须仍然生效 → 第 4 个请求应被拒
const duringStream = await enforceVirtualKeyQuota(req(), makeAuth());
check(
  "流未结束时第 4 个请求被拒（修复前会放行 → 超发）",
  duringStream.ok === false,
  `ok=${duringStream.ok}`
);

// 消费并关闭第一个流 → 应释放 1 个位置
const reader = wrapped[0].body!.getReader();
await reader.read();
await reader.cancel();

const afterCancel = await enforceVirtualKeyQuota(req(), makeAuth());
check("流被取消后释放 1 个位置（可再放行）", afterCancel.ok === true);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
