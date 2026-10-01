/**
 * 判定审查员 F3-1 是否成立：多工具并发（index 0/1/2）时，
 * formatOpenAIToAnthropicJson 是输出 3 个 tool_use 还是全部塌缩到 1 个。
 *
 * 关键：ParsedChunk 的 TS 类型里没有 index 字段，但运行时 JSON.parse 得到的对象
 * 会保留 index。因此「塌缩」只可能在 (a) 解析时丢字段，或 (b) 类型缺失导致的行为。
 * 本脚本用真实运行路径判定，不看类型。
 */
import { formatOpenAIToAnthropicJson } from "../src/lib/gateway/exchange/stream";

function sse(chunks: object[]): Response {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const frames: object[] = [
  // 三个工具的首帧（index 0/1/2）
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_A", type: "function", function: { name: "read_file", arguments: "" } },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, id: "call_B", type: "function", function: { name: "write_file", arguments: "" } },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 2, id: "call_C", type: "function", function: { name: "run_bash", arguments: "" } },
          ],
        },
      },
    ],
  },
  // 各自参数片段（乱序到达，考验按 index 归并）
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"b"}' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: '{"cmd":"ls"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

const res = await formatOpenAIToAnthropicJson(sse(frames), "claude-3-5-sonnet", {}, null);
const json = (await res.json()) as {
  content?: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
};

const toolUses = (json.content ?? []).filter((b) => b.type === "tool_use");
console.log("tool_use 块数:", toolUses.length);
console.log(JSON.stringify(toolUses, null, 2));
console.log("stop_reason:", json.stop_reason);

let failed = 0;
const check = (n: string, c: boolean, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  " + e : ""}`);
  if (!c) failed++;
};

check("输出 3 个 tool_use（塌缩到 1 则审查员 F3-1 成立）", toolUses.length === 3, `实际=${toolUses.length}`);
check("三个 id 各自正确", JSON.stringify(toolUses.map((t) => t.id)) === JSON.stringify(["call_A", "call_B", "call_C"]));
check("三个 name 各自正确", JSON.stringify(toolUses.map((t) => t.name)) === JSON.stringify(["read_file", "write_file", "run_bash"]));
check(
  "参数按 index 正确归位（乱序到达不乱配）",
  JSON.stringify(toolUses.map((t) => t.input)) ===
    JSON.stringify([{ path: "a" }, { path: "b" }, { cmd: "ls" }])
);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
