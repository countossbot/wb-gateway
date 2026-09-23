// v4.0.0：容器首启自动建表 + 默认管理员播种。
//
// 背景：容器化部署时 /app/db 挂载的具名卷初始为空，不再依赖本地预先生成的 db 文件；
// /api/console/auth/setup 有防抢占设计（仅接受本机请求），容器化后访问者来自公网必然 403，
// 不播种默认管理员就无法进入控制台。
//
// 两段职责（均幂等，重复重启不重复执行、不报错）：
//   1. ensureDatabaseSchema() —— 检测 DATABASE_URL 指向的 SQLite 库是否存在/非空，
//      空库则执行 prisma/init.sql（由 `prisma migrate diff --from-empty` 生成，
//      纯 DDL 无业务数据；构建期随镜像分发，不提交任何 .db 文件进仓库）。
//   2. seedDefaultAdmin() —— 仅当库内不存在任何管理员时创建默认管理员
//      （用户名 admin / 密码 gateway-admin-2026，可用环境变量覆盖；
//      生产环境应改为强口令）。已存在管理员则直接跳过，不覆盖不报错。
//
// 调用时机：instrumentation.register() 最前（nodejs runtime），先于一切业务 DB 访问。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";

// ---- 进程内幂等标记（防 instrumentation 与并发 route 双重执行；HMR 重载沿用同一 globalThis） ----
const SCHEMA_INIT_KEY = "__uag_schema_init_promise__";
const SEED_ADMIN_KEY = "__uag_seed_admin_promise__";

/** 解析 DATABASE_URL 中的 SQLite 文件路径（剥离 file: 前缀与 query 串） */
function resolveDbFilePath(): string | null {
  const url = process.env.DATABASE_URL || "";
  if (!url.startsWith("file:")) return null;
  let p = url.slice(5);
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  p = p.trim();
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  // 相对路径：Prisma 运行时基准存在历史差异（schema 目录 / cwd），两处都探测；
  // 都不存在（新建场景）时按 cwd 解析
  const byCwd = path.resolve(process.cwd(), p);
  const byPrisma = path.resolve(process.cwd(), "prisma", p);
  if (existsSync(byCwd)) return byCwd;
  if (existsSync(byPrisma)) return byPrisma;
  return byCwd;
}

/** 定位 prisma/init.sql（dev 与容器 standalone 均以 cwd 为基准） */
function resolveInitSqlPath(): string {
  const candidates = [
    path.join(process.cwd(), "prisma", "init.sql"),
    path.join(process.cwd(), ".next", "standalone", "prisma", "init.sql"), // 从项目根以 node .next/standalone/server.js 直启的防呆兜底
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/** 把 init.sql 文本拆成单条 DDL 语句（Prisma diff 输出格式：-- 注释行 + 以 ; 结尾的多行语句） */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const rawLine of sql.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("--")) continue; // Prisma diff 注释行（DDL 体内不含注释行）
    current.push(rawLine);
    if (line.endsWith(";")) {
      const stmt = current.join("\n").trim();
      if (stmt) statements.push(stmt);
      current = [];
    }
  }
  const tail = current.join("\n").trim();
  if (tail) statements.push(tail);
  return statements;
}

export interface SchemaInitResult {
  initialized: boolean;
  /** 触发初始化的原因：file-missing / empty-database / already-initialized */
  reason: string;
  /** 执行的 DDL 语句数（未初始化时为 0） */
  statements: number;
}

/**
 * 确保数据库 schema 存在：库文件缺失或空库（无用户表）时执行 init.sql 建表。
 * 已有 schema 时直接跳过（重复重启不重复建表）。
 * 失败抛出（表结构缺失时后续一切 DB 访问都会失败，启动期即暴露优于静默降级）。
 */
export async function ensureDatabaseSchema(): Promise<SchemaInitResult> {
  const g = globalThis as unknown as Record<string, unknown>;
  const pending = g[SCHEMA_INIT_KEY] as Promise<SchemaInitResult> | undefined;
  if (pending) return pending;

  const run = (async (): Promise<SchemaInitResult> => {
    const dbPath = resolveDbFilePath();
    if (dbPath && !existsSync(dbPath)) {
      const applied = await applyInitSql("file-missing", dbPath);
      return { initialized: true, reason: "file-missing", statements: applied };
    }
    // 空库判定：无任何用户表（首次连接时 Prisma/引擎可能已创建 0 字节文件，文件存在性不可靠）
    const tables = (await db.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    )) as Array<{ name: string }>;
    if (tables.length > 0) {
      return { initialized: false, reason: "already-initialized", statements: 0 };
    }
    const applied = await applyInitSql("empty-database", dbPath || "(unknown)");
    return { initialized: true, reason: "empty-database", statements: applied };
  })().catch((err) => {
    // 清除缓存标记：失败允许下次调用重试（如启动竞态下 init.sql 暂不可读）
    g[SCHEMA_INIT_KEY] = undefined;
    throw err;
  });

  g[SCHEMA_INIT_KEY] = run;
  return run;
}

/** 执行 init.sql 建表（事务内逐条 DDL，返回语句数） */
async function applyInitSql(reason: string, dbPath: string): Promise<number> {
  const initSqlPath = resolveInitSqlPath();
  if (!existsSync(initSqlPath)) {
    throw new Error(
      `[SchemaInit] init.sql not found at ${initSqlPath}（构建镜像时需将 prisma/init.sql 复制进 standalone 产物）`
    );
  }
  const statements = splitSqlStatements(readFileSync(initSqlPath, "utf8"));
  if (statements.length === 0) {
    throw new Error(`[SchemaInit] init.sql at ${initSqlPath} contains no executable statements`);
  }
  console.log(
    `[SchemaInit] ${reason}: initializing SQLite schema at ${dbPath} from ${initSqlPath} (${statements.length} statements)`
  );
  await db.$transaction(async (tx) => {
    for (const stmt of statements) {
      await tx.$executeRawUnsafe(stmt);
    }
  });
  // 回读核对（启动日志可直接核对建表数量）
  const tables = (await db.$queryRawUnsafe(
    `SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  )) as Array<{ n: number | bigint }>;
  console.log(`[SchemaInit] schema ready: ${String(tables[0]?.n ?? "?")} tables created`);
  return statements.length;
}

export interface SeedAdminResult {
  seeded: boolean;
  /** 跳过原因或创建的管理员用户名 */
  detail: string;
}

/**
 * 播种默认管理员（幂等）：仅当库内不存在任何管理员记录时创建。
 * 用户名/密码可用环境变量覆盖（生产环境应改为强口令且仅首次启动生效）：
 *   UAG_DEFAULT_ADMIN_USERNAME（默认 admin）
 *   UAG_DEFAULT_ADMIN_PASSWORD（默认 gateway-admin-2026）
 * 密码经 scrypt 强哈希落库（与控制台 setup 同一套哈希与校验路径）。
 * 播种后 /api/console/auth/setup 的防抢占（adminCount > 0 → 409）天然生效。
 */
export async function seedDefaultAdmin(): Promise<SeedAdminResult> {
  const g = globalThis as unknown as Record<string, unknown>;
  const pending = g[SEED_ADMIN_KEY] as Promise<SeedAdminResult> | undefined;
  if (pending) return pending;

  const run = (async (): Promise<SeedAdminResult> => {
    const adminCount = await db.adminUser.count();
    if (adminCount > 0) {
      return { seeded: false, detail: `admin exists (${adminCount})` };
    }
    const { hashPassword } = await import("@/lib/gateway/session/session");
    const username = (process.env.UAG_DEFAULT_ADMIN_USERNAME || "admin").trim().slice(0, 64) || "admin";
    const password = process.env.UAG_DEFAULT_ADMIN_PASSWORD || "gateway-admin-2026";
    const passwordHash = await hashPassword(password);
    await db.adminUser.create({ data: { username, passwordHash } });
    console.log(
      `[SchemaInit] default admin seeded: username="${username}"（默认口令仅首次启动生效；生产环境请用 UAG_DEFAULT_ADMIN_PASSWORD 覆盖为强口令，并尽快在控制台修改）`
    );
    return { seeded: true, detail: username };
  })().catch((err) => {
    g[SEED_ADMIN_KEY] = undefined;
    throw err;
  });

  g[SEED_ADMIN_KEY] = run;
  return run;
}

// ---- v4.9.0：已有库的增量建表（幂等）----
// 背景：ensureDatabaseSchema() 仅处理「空库」（执行 init.sql），已存在的库会被整体跳过，
// 因此新增表必须走这条显式增量路径，否则老容器升级后 Prisma 查询会报 no such table。
// 幂等保证：先查 sqlite_master，表已存在则整段跳过（重复重启不重复执行、不报错）。
const ADDITIVE_TABLES_KEY = "__uag_additive_tables_promise__";

/** 成长中心相关表 DDL（与 prisma/schema.prisma 的 model 定义保持一致） */
const GROWTH_TABLE_DDL: Array<{ name: string; sql: string }> = [
  {
    name: "GrowthAccountState",
    sql: `CREATE TABLE "GrowthAccountState" (
      "accountId" TEXT NOT NULL PRIMARY KEY,
      "providerId" TEXT NOT NULL DEFAULT 'workbuddy',
      "status" TEXT NOT NULL DEFAULT 'idle',
      "completedCount" INTEGER NOT NULL DEFAULT 0,
      "totalCount" INTEGER NOT NULL DEFAULT 0,
      "groups" TEXT NOT NULL DEFAULT '',
      "lastRunAt" DATETIME,
      "lastError" TEXT NOT NULL DEFAULT '',
      "updatedAt" DATETIME NOT NULL
    )`,
  },
  {
    name: "GrowthLog",
    sql: `CREATE TABLE "GrowthLog" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "accountId" TEXT NOT NULL DEFAULT '',
      "accountName" TEXT NOT NULL DEFAULT '',
      "runId" TEXT NOT NULL DEFAULT '',
      "taskCode" TEXT NOT NULL DEFAULT '',
      "label" TEXT NOT NULL DEFAULT '',
      "level" TEXT NOT NULL DEFAULT 'info',
      "message" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "GrowthAccountState_status_idx",
    sql: `CREATE INDEX "GrowthAccountState_status_idx" ON "GrowthAccountState"("status")`,
  },
  {
    name: "GrowthLog_createdAt_idx",
    sql: `CREATE INDEX "GrowthLog_createdAt_idx" ON "GrowthLog"("createdAt")`,
  },
  {
    name: "GrowthLog_accountId_createdAt_idx",
    sql: `CREATE INDEX "GrowthLog_accountId_createdAt_idx" ON "GrowthLog"("accountId", "createdAt")`,
  },
  {
    name: "GrowthLog_runId_idx",
    sql: `CREATE INDEX "GrowthLog_runId_idx" ON "GrowthLog"("runId")`,
  },
];

/**
 * 增量建表（幂等）：逐个检查 sqlite_master，缺少才执行对应 DDL。
 * 返回本次实际新建的对象名，便于启动日志核对。
 */
export async function ensureAdditiveTables(): Promise<string[]> {
  const g = globalThis as unknown as Record<string, unknown>;
  const pending = g[ADDITIVE_TABLES_KEY] as Promise<string[]> | undefined;
  if (pending) return pending;

  const run = (async (): Promise<string[]> => {
    const created: string[] = [];
    for (const item of GROWTH_TABLE_DDL) {
      const kind = item.name.includes("_idx") ? "index" : "table";
      const rows = (await db.$queryRawUnsafe(
        `SELECT name FROM sqlite_master WHERE type='${kind}' AND name='${item.name}'`,
      )) as Array<{ name: string }>;
      if (rows.length > 0) continue; // 已存在 → 跳过（幂等）
      await db.$executeRawUnsafe(item.sql);
      created.push(item.name);
    }
    if (created.length > 0) {
      console.log(`[SchemaInit] additive tables created: ${created.join(", ")}`);
    }
    return created;
  })().catch((err) => {
    g[ADDITIVE_TABLES_KEY] = undefined; // 失败允许下次重试
    throw err;
  });

  g[ADDITIVE_TABLES_KEY] = run;
  return run;
}
