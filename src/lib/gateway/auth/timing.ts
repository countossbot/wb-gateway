// 常数时间字符串比较：先比较长度，再对每个字符做等价的按位累加，避免 === 短路泄露前缀信息。
// 攻击者通过响应耗时逐字节推断 token 的时序侧信道即被消除。
// （Node 环境另有 crypto.timingSafeEqual，但要求等长 Buffer 且长度泄露语义不同，
//  此处保留与原版完全一致的纯 JS 实现。）

export function timingSafeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;

  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}
