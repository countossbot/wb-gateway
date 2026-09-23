// Instrumentation —— Next.js 启动钩子：进程就绪时启动定时任务调度器（签到 / Token 保活）。
// 原 Cloudflare Cron Triggers 的 Node 常驻等价物；调度配置存 SQLite，热生效。
// v3.0.7：启动时自动执行 UsageDaily 历史回填（幂等，已有行的天跳过）。
// v4.0.0：容器首启自动建表（prisma/init.sql）+ 默认管理员播种（幂等），先于一切业务 DB 访问。
import { applySqlitePragmas } from "@/lib/db";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await applySqlitePragmas();
  // ---- v4.0.0：schema 初始化与默认管理员播种（必须最前：后续 refreshRuntimeSettings /
  // ensureSystemSecrets / startScheduler 均依赖业务表存在；空库/新卷首启即自动就绪） ----
  try {
    const { ensureDatabaseSchema, ensureAdditiveTables, seedDefaultAdmin } = await import("@/lib/schemaInit");
    const schema = await ensureDatabaseSchema();
    // v4.9.0：已有库的新增表（ensureDatabaseSchema 只处理空库），幂等
    await ensureAdditiveTables();
    if (schema.initialized) {
      console.log(`[Instrumentation] database schema initialized (${schema.reason})`);
    }
    const seeded = await seedDefaultAdmin();
    if (seeded.seeded) {
      console.log("[Instrumentation] default admin seeded (首次启动；用默认账号登录后请立即修改密码)");
    }
  } catch (e) {
    console.error("[Instrumentation] schema init / admin seed failed:", e);
  }
  const { startScheduler } = await import("@/lib/gateway/jobs/scheduler");
  const { refreshRuntimeSettings } = await import("@/lib/gateway/config/runtimeSettings");
  const { ensureSystemSecrets } = await import("@/lib/gateway/config/configService");
  const { backfillUsageDaily, splitUsageDailyModelDimension } = await import("@/lib/gateway/config/requestLog");
  try {
    await refreshRuntimeSettings();
    await ensureSystemSecrets(); // master_key / cron_secret 缺失时生成强随机值（拒绝硬编码兜底）
    startScheduler();
    console.log("[Instrumentation] Universal AI Gateway background services started");
    // v3.0.7：UsageDaily 历史回填（幂等：已有行的天跳过；升级后首次启动自动补齐滚动窗口内的历史）
    try {
      const r = await backfillUsageDaily();
      if (r.rows > 0) {
        console.log(`[UsageDaily] Backfilled ${r.rows} row(s) across ${r.days} day(s) from rolling RequestLog`);
      }
    } catch (e) {
      console.error("[UsageDaily] Backfill failed:", e);
    }
    // v4.2.3：模型维度拆分迁移（幂等；把 v4.2.3 前 model="" 的历史聚合行
    // 在 RequestLog 完整覆盖该天时安全重切为模型细分行）
    try {
      const s = await splitUsageDailyModelDimension();
      if (s.daysChecked > 0) {
        console.log(
          `[UsageDaily] Model-dimension split: ${s.daysSplit}/${s.daysChecked} day(s) re-split (${s.rowsBefore}→${s.rowsAfter} rows)` +
            (s.skipped.length > 0 ? `, skipped: ${s.skipped.map((d) => `${d.day}(${d.usageRequests}≠${d.logCount})`).join(",")}` : "")
        );
      }
    } catch (e) {
      console.error("[UsageDaily] Model-dimension split failed:", e);
    }
  } catch (e) {
    console.error("[Instrumentation] startup failed:", e);
  }

  // v3.9.3：优雅关闭钩子 —— SIGTERM/SIGINT 时停调度器 + flush UsageDaily 内存聚合。
  // 钩子实现在独立模块（shutdownHooks.ts）并仅在 nodejs runtime 动态加载：
  // process API 不进入 Edge bundle（instrumentation 会被双 runtime 编译）。
  try {
    const { registerShutdownHooks } = await import("@/lib/gateway/jobs/shutdownHooks");
    registerShutdownHooks();
  } catch (e) {
    console.error("[Instrumentation] shutdown hooks registration failed:", e);
  }
}
