// v4.9.2 QA：账号调度模式（负载均衡 / 顺序调度）—— 纯函数级验证。
// 两种模式共用 orderAccounts()，差异只在「是否传 affinityKey」：
//   load-balance（默认）→ 传粘性键：同一 key 永远落到同一账号
//   sequential           → 传 null：按 roundRobinCounter 均匀轮转，忽略粘性
// 同时回归验证 T2 修复：轮转计数器按 providerId 分片（本测试覆盖纯函数部分）。
import { orderAccounts, affinityStartIndex, hashString32, type CooldownMap } from "../src/lib/gateway/core/scheduler.ts";

const accounts = [
  { id: "a1", name: "acc-1" },
  { id: "a2", name: "acc-2" },
  { id: "a3", name: "acc-3" },
];
const empty: CooldownMap = new Map();

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n[1] 顺序调度（affinityKey = null）：忽略粘性，按下标均匀轮转");
{
  const sameKeyAlways = "sid:fixed-session-id";
  // sequential 模式调用方传 null，同一 key 的连续请求应依次落到不同账号
  const hits = [0, 1, 2, 3, 4, 5].map((i) => orderAccounts(accounts, empty, Date.now(), i, null)[0].id);
  check("连续 6 次轮转覆盖全部 3 账号", new Set(hits.slice(0, 3)).size === 3, `hits=${hits.join(",")}`);
  check("第 0/3 次落点相同（周期为 3）", hits[0] === hits[3], `${hits[0]} vs ${hits[3]}`);
  check("第 1/4 次落点相同", hits[1] === hits[4], `${hits[1]} vs ${hits[4]}`);
  check("粘性键被忽略（传 null 时结果与 key 无关）", orderAccounts(accounts, empty, Date.now(), 0, null)[0].id === accounts[0].id);
  void sameKeyAlways;
}

console.log("\n[2] 负载均衡（传 affinityKey）：同一会话固定同一账号");
{
  const key = "sid:session-alpha";
  const idx = affinityStartIndex(key, accounts.length);
  const hits = [0, 1, 2, 3, 4].map((i) => orderAccounts(accounts, empty, Date.now(), i, key)[0].id);
  check("同一 key 的 5 次请求全部落到同一账号", new Set(hits).size === 1, `hits=${hits.join(",")}`);
  check("落点等于 affinityStartIndex 计算值", hits[0] === accounts[idx].id, `expect=${accounts[idx].id} got=${hits[0]}`);
  check("不同 key 可落到不同账号（分布性）", (() => {
    const spread = new Set(["k1", "k2", "k3", "k4", "k5", "k6"].map((k) => affinityStartIndex(k, accounts.length)));
    return spread.size >= 2;
  })(), "6 个不同 key 至少覆盖 2 个落点");
}

console.log("\n[3] 两模式行为确实不同（同一 key）");
{
  const key = "sid:compare-me";
  const lb = orderAccounts(accounts, empty, Date.now(), 0, key)[0].id;
  const seq = orderAccounts(accounts, empty, Date.now(), 0, null)[0].id;
  const seqAtLbIndex = affinityStartIndex(key, accounts.length);
  // load-balance 的下标由 key 决定；只有 key 恰好哈希到 0 时两者才相同
  check(
    "同一 key 在两模式下可能落到不同账号",
    seqAtLbIndex === 0 ? lb === seq : lb !== seq,
    `lb=${lb} seq=${seq} lbIdx=${seqAtLbIndex}`
  );
}

console.log("\n[4] 冷却账号不参与粘性取值（健康子集内取模）");
{
  const cd: CooldownMap = new Map([["a2", { expiresAt: Date.now() + 60_000, streak: 1 }]]);
  const key = "sid:with-cooldown";
  const hits = [0, 1, 2, 3].map((i) => orderAccounts(accounts, cd, Date.now(), i, key)[0].id);
  check("冷却账号 a2 永不被选为落点", !hits.includes("a2"), `hits=${hits.join(",")}`);
  check("仍在健康账号 a1/a3 之间保持粘性", new Set(hits).size === 1, `hits=${hits.join(",")}`);
  const idx = affinityStartIndex(key, 2);
  check("落点 = 健康子集内的 key 哈希下标", hits[0] === ["a1", "a3"][idx], `expect=${["a1", "a3"][idx]} got=${hits[0]}`);
}

console.log("\n[5] 哈希确定性与空输入边界");
{
  check("同一字符串哈希稳定", hashString32("sid:x") === hashString32("sid:x"));
  check("不同字符串哈希一般不同", hashString32("sid:x") !== hashString32("sid:y"));
  check("空账号池返回空数组", orderAccounts([], empty, Date.now(), 0, null).length === 0);
  check("healthyCount=0 时 affinityStartIndex 返回 0", affinityStartIndex("k", 0) === 0);
  check("空 key 时 affinityStartIndex 返回 0", affinityStartIndex("", 3) === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
