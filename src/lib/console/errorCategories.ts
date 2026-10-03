// v4.9.13-local-r3：错误分类共享工具（服务端聚合与前端展开区徽标同口径，单一实现防漂移）。
// 本模块必须保持中立：无 "use client"、无 server-only 依赖（db 等）—— 供
// src/lib/gateway/config/requestLog.ts（服务端错误模式聚合）与
// src/components/console/logs.tsx（客户端展开区分类徽标）共同导入。

/** 按关键字推断错误大类（中文短标签；顺序即优先级，命中即返回） */
export function categorizeError(msg: string): string {
  const s = msg.toLowerCase();
  if (s.includes("all providers")) return "全候选失败";
  if (s.includes("aborted") || s.includes("timeout") || s.includes("etimedout") || s.includes("econnreset")) return "中断/超时";
  if (s.includes("401") || s.includes("unauthorized") || s.includes("invalid api key") || s.includes("authentication")) return "上游鉴权";
  if (s.includes("429") || s.includes("rate limit") || s.includes("quota")) return "限流/配额";
  if (s.includes("404") || s.includes("not found") || s.includes("no route")) return "路由/模型缺失";
  if (s.includes("529") || s.includes("overloaded")) return "上游过载";
  return "其他";
}

/** 分类 → 徽标配色（客户端展示用；与日志页红色系错误语义一致，按类别微调色相） */
export const ERROR_CATEGORY_TONE: Record<string, string> = {
  全候选失败: "border-red-200 bg-red-50 text-red-700",
  "中断/超时": "border-orange-200 bg-orange-50 text-orange-700",
  上游鉴权: "border-rose-200 bg-rose-50 text-rose-700",
  "限流/配额": "border-amber-200 bg-amber-50 text-amber-700",
  "路由/模型缺失": "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
  上游过载: "border-violet-200 bg-violet-50 text-violet-700",
  其他: "border-stone-300 bg-stone-50 text-stone-600",
};

/**
 * v4.9.13-local-r9：从归一化错误模式中提取「模式检索词」。
 * 用途：点击错误模式（日志页模式芯片 / 总览错误卡行 / 密钥·账号页失败徽标 tooltip 行）时，
 * 把整组错误一键转为日志页 error 关键字筛选的检索词 —— 比状态大类下钻更精准（只命中该组），
 * 且解锁跨状态大类的模式组（此前跨类组不可下钻）。
 *
 * 原理：normalizeErrorPattern（requestLog.ts，服务端聚合用）只折叠三类形态 ——
 * 引号串 → "…" / '…'、密钥形态 → sk-uag-…、数字 → #；其余骨架文本在组内每一行的
 * 原始错误里逐字出现。把模式按这些占位切开，取「最长骨架片段」（≥5 字符）做 contains
 * 检索即可命中整组。例：
 *   `All providers for model "…" failed. Last error: The operation was aborted`
 *     → 片段 [`All providers for model `, ` failed. Last error: The operation was aborted`]
 *     → 取最长 → "failed. Last error: The operation was aborted"
 *   `No route configured for model "…"` → "No route configured for model"
 * 无 ≥5 字符片段（如模式整体就是一个引号串）返回 null —— 调用方回落既有状态大类下钻。
 */
export function patternSearchKeyword(pattern: string): string | null {
  const pieces = pattern
    .split(/"(?:…)"|'(?:…)'|sk-uag-…|#+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5);
  if (pieces.length === 0) return null;
  // 最长片段 = 字符最多 = 约束最强（contains 误报最少）
  return pieces.reduce((a, b) => (b.length > a.length ? b : a));
}
