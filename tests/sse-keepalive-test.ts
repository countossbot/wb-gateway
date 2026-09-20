// v4.2.0 QA：passthroughSseWithKeepAlive 直接功能测试（不经 HTTP，纯流验证）
// 覆盖：① OpenAI 协议保活注释帧注入 ② Anthropic 协议 ping 事件注入
//       ③ 停滞熔断（协议终帧 + 流关闭 + cancel 上游）④ usage 精确帧旁路统计
//       ⑤ 原始字节透传不变形 ⑥ 半开事件期间不注入 ping（事件边界保护）
import { passthroughSseWithKeepAlive, type StreamUsageReport } from "../src/lib/gateway/exchange/stream.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);

function makeStallingUpstream(chunks: string[], stallAfterMs: number, totalHoldMs: number) {
  // 发送 chunks 后静默 totalHoldMs（远超 stallAfterMs，触发网关熔断）
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc(c));
        await sleep(20);
      }
      cancelled = new Promise((resolve) => { cancelResolve = resolve; });
      await sleep(totalHoldMs);
      // 若未被 cancel，说明熔断失效 —— 继续发终帧会让测试 2/3 的断言混乱
      controller.enqueue(enc("data: {\"late\":\"should-not-arrive\"}\n\n"));
      controller.close();
    },
    cancel() {
      cancelResolve?.();
    },
  });
}

let cancelResolve: (() => void) | null = null;
let cancelled: Promise<void> | null = null;

async function collectOutput(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " —— " + detail : ""}`); }
}

// ---------- 测试 1：OpenAI 协议（注释 ping + [DONE] 终帧 + usage 精确） ----------
console.log("\n[测试 1] OpenAI 协议透传：保活注释 + 熔断终帧 + usage");
{
  let usage: StreamUsageReport | null = null;
  const upstream = makeStallingUpstream(
    [
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    ],
    2000, // stallMs 2s
    8000  // 上游静默 8s（必触发熔断）
  );
  const t0 = Date.now();
  const out = await collectOutput(
    passthroughSseWithKeepAlive(upstream, (u) => { usage = u; }, {
      stallMs: 2000,
      pingIntervalMs: 1000,
      clientProtocol: "openai",
    })
  );
  const elapsed = Date.now() - t0;
  check("原始 data 帧透传不变形", out.includes('"content":"hel"') && out.includes('"content":"lo"'));
  check("保活注释帧注入（: keep-alive）", (out.match(/: keep-alive/g) || []).length >= 1);
  check("熔断补 [DONE] 终帧", out.trimEnd().endsWith("data: [DONE]"));
  check("熔断后无迟到的上游帧", !out.includes("should-not-arrive"));
  check("流在熔断后及时关闭（<6s）", elapsed < 6000, `elapsed=${elapsed}ms`);
  check("上游被 cancel（级联）", await Promise.race([cancelled.then(() => true), sleep(500).then(() => false)]));
  check("usage 精确统计缺失时按字符估算", usage !== null && usage.source === "estimated" && usage.outputTokens > 0, JSON.stringify(usage));
}

// ---------- 测试 2：Anthropic 协议（ping 事件 + message_stop 终帧） ----------
console.log("\n[测试 2] Anthropic 协议透传：ping 事件 + message_stop 终帧");
{
  const upstream = makeStallingUpstream(
    ['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'],
    2000,
    8000
  );
  const out = await collectOutput(
    passthroughSseWithKeepAlive(upstream, () => {}, {
      stallMs: 2000,
      pingIntervalMs: 1000,
      clientProtocol: "anthropic",
    })
  );
  check("原始 Anthropic 帧透传", out.includes("content_block_delta"));
  check("Anthropic ping 事件注入", out.includes('event: ping') && out.includes('{"type":"ping"}'));
  check("熔断补 message_stop 终帧", out.includes("event: message_stop") && out.trimEnd().endsWith('event: message_stop\ndata: {"type":"message_stop"}'));
  check("无 OpenAI 风格注释帧混入", !out.includes(": keep-alive"));
}

// ---------- 测试 3：正常完成流（无熔断、usage 精确帧） ----------
console.log("\n[测试 3] 正常完成流：无熔断注入终帧、usage 精确统计");
{
  let usage: StreamUsageReport | null = null;
  const upstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc('data: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
      controller.enqueue(enc('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":42,"completion_tokens":13,"prompt_tokens_details":{"cached_tokens":20}}}\n\n'));
      controller.enqueue(enc("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const out = await collectOutput(
    passthroughSseWithKeepAlive(upstream, (u) => { usage = u; }, {
      stallMs: 60_000, // 不会触发
      pingIntervalMs: 4000,
      clientProtocol: "openai",
    })
  );
  check("透传三帧原样", out.split("data:").length - 1 === 3 && out.includes("[DONE]"));
  check("无熔断 → 不注入额外 [DONE]", (out.match(/\[DONE\]/g) || []).length === 1);
  check("快速完成 → 无 ping 注入", !out.includes(": keep-alive"));
  check("usage 精确帧统计", usage !== null && usage.source === "upstreamUsageFrame" && usage.inputTokens === 42 && usage.outputTokens === 13 && usage.cachedTokens === 20, JSON.stringify(usage));
}

// ---------- 测试 4：半开事件期间不注入 ping（事件边界保护） ----------
console.log("\n[测试 4] 事件边界保护：半开事件（无结束空行）期间不注入 ping");
{
  const upstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 发半行 data（无换行，事件未闭合）→ 静默 3.5s（跨多个 ping 周期）→ 补完
      controller.enqueue(enc('data: {"choices":[{"delta":{"content":"par'));
      await sleep(3500);
      controller.enqueue(enc('tial"}}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const out = await collectOutput(
    passthroughSseWithKeepAlive(upstream, () => {}, {
      stallMs: 60_000,
      pingIntervalMs: 1000,
      clientProtocol: "openai",
    })
  );
  check("半开事件期间零 ping 注入（不截断多行帧）", !out.includes(": keep-alive"));
  check("上游字节完整透传（拼接后 JSON 完好）", out.includes('"content":"partial"') && out.includes("[DONE]"));
}

console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
