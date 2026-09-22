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
const MIGRATE_ADMIN_USER_KEY = "__uag_migrate_admin_user_promise__";

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
    await db.adminUser.create({ data: { username, passwordHash, role: "ADMIN" } });
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


// ---- v4.9.0：AdminUser 多成员改造的幂等列迁移与角色回填 ----
// 背景：已有库（v4.9.0 之前创建）的 AdminUser 表没有 displayName / role / enabled / lastLoginAt 列，
// 且历史管理员没有角色。直接跑 Prisma 查询会因缺列报错，必须先补列再回填。
//
// 与 ensureDatabaseSchema 的分工：
//   - ensureDatabaseSchema：仅空库建表（执行 init.sql）
//   - migrateAdminUserColumns：已有库的增量列补齐 + 角色回填（幂等，可重复执行）
export interface AdminUserMigrationResult {
  columnsAdded: string[];
  promoted: number;
  reason: string;
}

const VIRTUAL_KEY_OWNER_COLUMN = "ownerUserId";

const ADMIN_USER_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "displayName", ddl: `ALTER TABLE "AdminUser" ADD COLUMN "displayName" TEXT` },
  { name: "role", ddl: `ALTER TABLE "AdminUser" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'VIEWER'` },
  { name: "enabled", ddl: `ALTER TABLE "AdminUser" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true` },
  { name: "lastLoginAt", ddl: `ALTER TABLE "AdminUser" ADD COLUMN "lastLoginAt" DATETIME` },
];

/**
 * 幂等迁移 AdminUser 表：
 *   1. 逐列探测，缺失则 ADD COLUMN（SQLite 无 IF NOT EXISTS for ADD COLUMN，需先读 PRAGMA）。
 *   2. 把角色非法（历史库空值/未知值）的用户回填为 ADMIN —— 保证升级后原管理员仍可管理。
 *   3. 兜底：若不存在启用的 ADMIN，则把最早创建的启用用户提升为 ADMIN。
 * 空库场景由 ensureDatabaseSchema 处理，这里遇到表不存在时直接跳过。
 */
export async function migrateAdminUserColumns(): Promise<AdminUserMigrationResult> {
  const g = globalThis as unknown as Record<string, unknown>;
  const pending = g[MIGRATE_ADMIN_USER_KEY] as Promise<AdminUserMigrationResult> | undefined;
  if (pending) return pending;

  const run = (async (): Promise<AdminUserMigrationResult> => {
    const tables = (await db.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='AdminUser'`
    )) as Array<{ name: string }>;
    if (tables.length === 0) {
      return { columnsAdded: [], promoted: 0, reason: "table-missing" };
    }

    const existing = (await db.$queryRawUnsafe(`PRAGMA table_info("AdminUser")`)) as Array<{ name: string }>;
    const existingNames = new Set(existing.map((c) => c.name));
    const columnsAdded: string[] = [];
    for (const col of ADMIN_USER_COLUMNS) {
      if (existingNames.has(col.name)) continue;
      await db.$executeRawUnsafe(col.ddl);
      columnsAdded.push(col.name);
    }
    if (columnsAdded.length > 0) {
      console.log(`[SchemaInit] AdminUser migrated: added columns ${columnsAdded.join(", ")}`);
    }

    // 角色回填逻辑（v4.9.0）：
    //   1. 首次加 role 列 → 该库此前从未有多角色概念，所有用户都是历史管理员，全部升 ADMIN。
    //   2. role 列已存在但值非法（NULL 或非三态枚举）→ 回填为 ADMIN。
    // 两种情况互不重叠：首次加列时新列默认值就是合法的 VIEWER，不满足条件 2。
    let promoted = 0;
    if (columnsAdded.includes("role")) {
      promoted = await db.$executeRawUnsafe(`UPDATE "AdminUser" SET "role" = 'ADMIN'`);
    } else {
      promoted = await db.$executeRawUnsafe(
        `UPDATE "AdminUser" SET "role" = 'ADMIN' WHERE "role" IS NULL OR "role" NOT IN ('ADMIN','OPERATOR','VIEWER')`
      );
    }

    // 兜底：不存在启用的 ADMIN 时，提升最早创建的启用用户。
    const adminCount = (await db.$queryRawUnsafe(
      `SELECT count(*) as n FROM "AdminUser" WHERE "role" = 'ADMIN' AND "enabled" = true`
    )) as Array<{ n: number | bigint }>;
    const hasActiveAdmin = Number(adminCount[0]?.n ?? 0) > 0;
    let rescued = 0;
    if (!hasActiveAdmin) {
      const rescue = await db.$executeRawUnsafe(
        `UPDATE "AdminUser" SET "role" = 'ADMIN', "enabled" = true WHERE "id" = (
           SELECT "id" FROM "AdminUser" WHERE "enabled" = true ORDER BY "createdAt" ASC, "id" ASC LIMIT 1
         )`
      );
      rescued = Number(rescue ?? 0);
      if (rescued > 0) {
        console.warn("[SchemaInit] AdminUser migrated: no active ADMIN found, promoted the earliest enabled user");
      }
    }

    // v4.9.0 Task 7：RequestLog / UsageDaily ownerUserId 列补齐（幂等）
    for (const table of ["RequestLog", "UsageDaily"]) {
      const cols = (await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has("ownerUserId")) {
        const ddl = table === "UsageDaily"
          ? `ALTER TABLE "${table}" ADD COLUMN "ownerUserId" TEXT NOT NULL DEFAULT ''`
          : `ALTER TABLE "${table}" ADD COLUMN "ownerUserId" TEXT`;
        await db.$executeRawUnsafe(ddl);
        columnsAdded.push(`${table}.ownerUserId`);
        console.log(`[SchemaInit] ${table} migrated: added column ownerUserId`);
      }
    }

    // v4.9.0 Task 6：VirtualKey.ownerUserId 列补齐（幂等）
    const vkColumns = (await db.$queryRawUnsafe(`PRAGMA table_info("VirtualKey")`)) as Array<{ name: string }>;
    const vkNames = new Set(vkColumns.map((c) => c.name));
    if (!vkNames.has(VIRTUAL_KEY_OWNER_COLUMN)) {
      await db.$executeRawUnsafe(`ALTER TABLE "VirtualKey" ADD COLUMN "ownerUserId" TEXT`);
      columnsAdded.push(VIRTUAL_KEY_OWNER_COLUMN);
      console.log(`[SchemaInit] VirtualKey migrated: added column ${VIRTUAL_KEY_OWNER_COLUMN}`);
    }

    return {
      columnsAdded,
      promoted: Number(promoted ?? 0),
      reason: columnsAdded.length > 0 ? "columns-added" : hasActiveAdmin ? "already-migrated" : "rescued-admin",
    };
  })().catch((err) => {
    g[MIGRATE_ADMIN_USER_KEY] = undefined;
    throw err;
  });

  g[MIGRATE_ADMIN_USER_KEY] = run;
  return run;
}
