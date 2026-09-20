// v3.9.3：优雅关闭钩子 —— 仅 Node.js runtime 加载（由 instrumentation 的 NEXT_RUNTIME
// 分支动态 import，避免 Edge bundle 静态分析 process API 报 Ecmascript error）。
//
// 职责：
//   1. SIGTERM/SIGINT 时停调度器（清理主定时器）
//   2. flush UsageDaily 内存聚合（批量 flush 的退出兜底：缓冲数据不随进程丢失）
//   3. process.once 防重复触发；globalThis 标记防 dev HMR 重复注册
const HOOKS_KEY = "__uag_shutdown_hooks_registered__";

export function registerShutdownHooks(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[HOOKS_KEY]) return;
  g[HOOKS_KEY] = true;
  const gracefulShutdown = (signal: string) => {
    void (async () => {
      console.log(`[Instrumentation] ${signal} received, shutting down gracefully...`);
      try {
        const { stopScheduler } = await import("./scheduler");
        stopScheduler();
      } catch {
        /* noop */
      }
      try {
        const { flushUsageDaily } = await import("../config/requestLog");
        const flushed = await flushUsageDaily();
        if (flushed > 0) console.log(`[Instrumentation] Flushed ${flushed} UsageDaily aggregate cell(s) before exit`);
      } catch {
        /* noop */
      }
    })().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
}
