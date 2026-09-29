// v4.2.0：容器首启自动建表 + 默认管理员播种（PostgreSQL / MySQL 双方言，按 DATABASE_URL 自动选）。
//
// 背景：容器化部署时 /app/db 挂载的具名卷初始为空，不再依赖本地预先生成的 db 文件；
// /api/console/auth/setup 有防抢占设计（仅接受本机请求），容器化后访问者来自公网必然 403，
// 不播种默认管理员就无法进入控制台。
//
// 两段职责（均幂等，重复重启不重复执行、不报错）：
//   1. ensureDatabaseSchema() —— 检测 DATABASE_URL 指向的库是否存在/非空。
//      · PostgreSQL（Aiven 云托管）：查 information_schema.tables 判定，空库执行 prisma/init.postgres.sql。
//      · MySQL（远程 8.x）：同样查 information_schema，空库执行 prisma/init.mysql.sql。
//      init.sql 由 `prisma migrate diff --from-empty` 生成（纯 DDL 无业务数据），构建期随镜像分发。
//   2. seedDefaultAdmin() —— 仅当库内不存在任何管理员时创建默认管理员
//      （用户名 admin / 密码 gateway-admin-2026，可用环境变量覆盖；
//      生产环境应改为强口令）。已存在管理员则直接跳过，不覆盖不报错。
//
// 调用时机：instrumentation.register() 最前（nodejs runtime），先于一切业务 DB 访问。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { db, dbDialect } from "@/lib/db";

const SCHEMA_INIT_KEY = "__uag_schema_init_promise__";
const SEED_ADMIN_KEY = "__uag_seed_admin_promise__";

/**
 * 判定「schema 已就绪」的核心表集合（v4.2.1）。
 * 这些表任一缺失都会导致启动期 / 业务期查询失败，因此必须齐全才算初始化完成；
 * 取全量 17 张表的表名（以 init SQL 为准），避免半成品库被误判为已就绪。
 */
const CORE_TABLES = [
  "SchemaVersion", "AdminUser", "AuditLog", "BalanceSnapshot", "CheckinLog",
  "JobRun", "LoginAudit", "ModelPricing", "ModelRoute", "Provider",
  "RequestLog", "RouteCandidate", "Session", "SystemSetting", "UsageDaily",
  "VirtualKey", "Account",
] as const

// ---- 进程内幂等标记（防 instrumentation 与并发 route 双重执行；HMR 重载沿用同一 globalThis） ----

/**
 * 定位当前方言对应的 init.sql（dev 与容器 standalone 均以 cwd 为基准）。
 * v4.2.0：按 DATABASE_URL 方言选择 prisma/init.postgres.sql 或 prisma/init.mysql.sql。
 */
function resolveInitSqlPath(): string {
  const fileName = dbDialect === "mysql" ? "init.mysql.sql" : "init.postgres.sql";
  const candidates = [
    path.join(process.cwd(), "prisma", fileName),
    path.join(process.cwd(), ".next", "standalone", "prisma", fileName), // 从项目根以 node .next/standalone/server.js 直启的防呆兜底
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

/**
 * 判断 Prisma 抛出的错误是否属于「对象已存在」（幂等重放时应跳过）。
 * 覆盖 PostgreSQL 与 MySQL 两套 SQLSTATE：
 *   PG:    42P07 表已存在 / 42710 对象已存在（约束、索引）/ 42P06 schema 已存在
 *   MySQL: 1050 表已存在 / 1061 索引已存在 / 1826 外键已存在 / 1007 库已存在
 * 只放行这些可预期的重复错误；其余（权限、语法、连接）一律抛出，避免掩盖真实故障。
 */
function isAlreadyExistsError(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string }; message?: string }
  const code = err?.code ?? err?.meta?.code ?? ""
  if (["42P07", "42710", "42P06", "1050", "1061", "1826", "1007"].includes(code)) return true
  const msg = err?.message ?? ""
  // 兜底：Prisma 未透出 code 时按关键字识别（MySQL ER_TABLE_EXISTS_ERROR / PG duplicate_table）
  return /already exists|Duplicate table|Duplicate key name|Duplicate foreign key/i.test(msg)
}

export interface SchemaInitResult {
  initialized: boolean;
  /** 触发初始化的原因：file-missing / empty-database / already-initialized */
  reason: string;
  /** 执行的 DDL 语句数（未初始化时为 0） */
  statements: number;
}

/**
 * 从 init SQL 解析出「表名 → 列定义列表」。
 * 只取 CREATE TABLE 块内的列定义行（以 ` 或 " 包裹标识符开头），跳过 PRIMARY KEY /
 * UNIQUE / KEY / INDEX / CONSTRAINT / FOREIGN 等表级约束行；def 保留类型与默认值原文，
 * 供缺列时生成 ALTER TABLE ADD COLUMN 使用。
 */
function parseDeclaredColumns(sql: string): Map<string, Array<{ name: string; def: string }>> {
  const out = new Map<string, Array<{ name: string; def: string }>>()
  const tableRe = /CREATE TABLE\s+[`"]([A-Za-z_][A-Za-z0-9_]*)[`"]\s*\(([\s\S]*?)\n\)/g
  let m: RegExpExecArray | null
  while ((m = tableRe.exec(sql)) !== null) {
    const [, table, body] = m
    const cols: Array<{ name: string; def: string }> = []
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/,$/, "")
      if (!line.startsWith("`") && !line.startsWith('"')) continue
      const quote = line.startsWith("`") ? "`" : '"'
      const close = line.indexOf(quote, 1)
      if (close < 0) continue
      const col = line.slice(1, close)
      const def = line.slice(close + 1).trim()
      if (col && def) cols.push({ name: col, def })
    }
    out.set(dbDialect === "mysql" ? table.toLowerCase() : table, cols)
  }
  return out
}

/**
 * 比对 init SQL 声明列与数据库实际列，返回缺失列（含可执行的 ALTER 片段）。
 * v4.2.2：用于发现「表齐但缺列」的旧库（项目历史上用 db push 给已有表加过列）。
 * 只报缺失，不报多余——多余列不影响 Prisma 查询。
 */
async function findMissingColumnAlters(): Promise<string[]> {
  const initSqlPath = resolveInitSqlPath()
  if (!existsSync(initSqlPath)) return []
  const declared = parseDeclaredColumns(readFileSync(initSqlPath, "utf8"))
  if (declared.size === 0) return []

  const schemaExpr = dbDialect === "mysql" ? "DATABASE()" : "current_schema()"
  const rows = (await db.$queryRawUnsafe(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = ${schemaExpr}`
  )) as Array<{ t: string; c: string }>
  // 比对用小写 key（MySQL 表名大小写敏感性随 lower_case_table_names 变化），但生成 SQL
  // 必须用数据库返回的「真实名」——lower_case_table_names=0（Linux 默认）下表名区分大小写，
  // 用小写名 ALTER 会报「表不存在」。
  const actual = new Map<string, { realName: string; cols: Map<string, string> }>()
  for (const r of rows) {
    const t = dbDialect === "mysql" ? r.t.toLowerCase() : r.t
    if (!actual.has(t)) actual.set(t, { realName: r.t, cols: new Map() })
    actual.get(t)!.cols.set(dbDialect === "mysql" ? r.c.toLowerCase() : r.c, r.c)
  }

  const alters: string[] = []
  // 缺列的表补列；整表缺失交由 ensureDatabaseSchema 的 missing 分支处理，这里跳过。
  for (const [tableKey, cols] of declared) {
    const have = actual.get(tableKey)
    if (!have) continue
    for (const { name, def } of cols) {
      const key = dbDialect === "mysql" ? name.toLowerCase() : name
      if (have.cols.has(key)) continue
      const tq = dbDialect === "mysql" ? `\`${have.realName}\`` : `"${have.realName}"`
      const cq = dbDialect === "mysql" ? `\`${name}\`` : `"${name}"`
      alters.push(`ALTER TABLE ${tq} ADD COLUMN ${cq} ${def}`)
    }
  }
  return alters
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
    // v4.2.1：空库判定从「存在任意表」改为「核心表是否齐全」。
    // 原因：MySQL 的 DDL 会隐式提交（PG 可回滚），若上次建表中途失败（网络中断、
    // wait_timeout 掐断、单条 DDL 报错），会留下「只有前几张表」的半成品库。
    // 旧的 tables.length > 0 判据会把这种库误判为已初始化 → 永远跳过建表 →
    // 后续所有查询 P2021 且重启无法自愈。此处改为校验核心表集合，缺失则补齐
    // （replay init SQL 并忽略「已存在」错误，见 applyInitSql 的容错执行）。
    const schemaExpr = dbDialect === "mysql" ? "DATABASE()" : "current_schema()";
    const rows = (await db.$queryRawUnsafe(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${schemaExpr} AND table_type = 'BASE TABLE'`
    )) as Array<{ name: string }>;
    const existing = new Set(rows.map((r) => (dbDialect === "mysql" ? r.name.toLowerCase() : r.name)));
    const missing = (CORE_TABLES as readonly string[]).filter((t) =>
      dbDialect === "mysql" ? !existing.has(t.toLowerCase()) : !existing.has(t)
    );
    // v4.2.2：表齐不等于 schema 就绪——项目历史上多次用 `prisma db push` 给已有表加列
    // （如 RequestLog.usageExact，见 worklog）。旧库表齐但缺列时业务查询会报 P2022，
    // 且旧逻辑永远跳过建表、无法自愈。这里补一道列级校验并自动 ALTER 补齐。
    const colAlters = await findMissingColumnAlters();
    if (missing.length === 0 && colAlters.length === 0) {
      return { initialized: false, reason: "already-initialized", statements: 0 };
    }
    if (missing.length > 0) {
      // 有缺失表：可能是全新空库，也可能是上次中断的半成品库。replay 全部 DDL 并跳过
      // 「已存在」错误，两种情形都能收敛到完整 schema（幂等、可自愈）。
      const reason = rows.length === 0 ? "empty-database" : "incomplete-schema";
      const applied = await applyInitSql(reason, `(${dbDialect}, missing: ${missing.join(",")})`);
      // replay 之后表已齐，但中间被跳过的表可能缺列，再补一次列级修正。
      const after = await findMissingColumnAlters();
      if (after.length > 0) await applyColumnAlters(after);
      return { initialized: true, reason, statements: applied };
    }
    // 表齐、仅缺列：直接 ALTER 补齐（比重放 DDL 更精确，也不触碰已有数据）。
    await applyColumnAlters(colAlters);
    return { initialized: true, reason: "incomplete-columns", statements: colAlters.length };
  })().catch((err) => {
    // 清除缓存标记：失败允许下次调用重试（如启动竞态下 init.sql 暂不可读）
    g[SCHEMA_INIT_KEY] = undefined;
    throw err;
  });

  g[SCHEMA_INIT_KEY] = run;
  return run;
}

/**
 * 执行 init SQL 建表（事务内逐条 DDL，返回语句数）。方言由 DATABASE_URL 决定。
 *
 * v4.1.1 修复：原先未传事务选项，走 Prisma 默认 timeout=5000ms。init SQL 有 40+ 条 DDL，
 * 在 Aiven 等跨区托管库上单条往返就有数十毫秒，累计必然触发 P2028（transaction already closed），
 * 整个事务回滚 → 表未建成 → 后续全部查询 P2021。此处按语句数放大超时上限，并打印进度便于排障。
 */
async function applyInitSql(reason: string, dbPath: string): Promise<number> {
  const initSqlPath = resolveInitSqlPath();
  if (!existsSync(initSqlPath)) {
    throw new Error(
      `[SchemaInit] init SQL 不存在: ${initSqlPath}（构建镜像时需将 prisma/init.*.sql 复制进 standalone 产物）`
    );
  }
  const ddl = readFileSync(initSqlPath, "utf8");
  let statements = splitSqlStatements(ddl);
  if (statements.length === 0) {
    throw new Error(`[SchemaInit] ${initSqlPath} 中没有可执行语句`);
  }
  console.log(
    `[SchemaInit] ${reason}: initializing ${dbDialect} schema at ${dbPath} from ${initSqlPath} (${statements.length} statements)`
  );
  // v4.2.0：PG 与 MySQL 同为远程库，单条 DDL 往返数十毫秒，累积极易触发 P2028。
  // 按 2 秒/条预留，下限 5 分钟、上限 30 分钟。
  const txTimeout = Math.min(Math.max(statements.length * 2_000, 300_000), 1_800_000);
  let skipped = 0;
  // MySQL 的 DDL 会隐式提交事务（PG 可回滚），因此「事务 + 失败回滚」在 MySQL 上不成立：
  // 一旦中途失败，已执行的 DDL 已经落库。为让半成品库能够自愈，这里改为逐条执行 +
  // 忽略「对象已存在」错误（幂等重放）；其余错误照常抛出，避免掩盖真实问题。
  await db.$transaction(
    async (tx) => {
      let i = 0;
      for (const stmt of statements) {
        try {
          await tx.$executeRawUnsafe(stmt);
        } catch (e) {
          if (!isAlreadyExistsError(e)) throw e;
          skipped += 1;
        }
        i += 1;
        if (i % 10 === 0 || i === statements.length) {
          console.log(`[SchemaInit] DDL ${i}/${statements.length}${skipped ? ` (已存在跳过 ${skipped})` : ""}`);
        }
      }
    },
    { timeout: txTimeout, maxWait: 60_000 }
  );
  // 回读核对（启动日志可直接核对建表数量）。v4.2.0：PG 与 MySQL 均走 information_schema。
  const countSchemaExpr = dbDialect === "mysql" ? "DATABASE()" : "current_schema()";
  const countSql = `SELECT count(*) as n FROM information_schema.tables WHERE table_schema = ${countSchemaExpr} AND table_type = 'BASE TABLE'`;
  const tables = (await db.$queryRawUnsafe(countSql)) as Array<{ n: number | bigint }>;
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

/**
 * 执行缺列的 ALTER TABLE ADD COLUMN（同样容错「已存在」）。
 * 逐条执行：某个列补不上（如类型不兼容）不阻断其余列，但会在结尾汇总抛错，
 * 避免"补了一部分就静默通过"——相关查询仍会失败，必须让人看到。
 */
async function applyColumnAlters(alters: string[]): Promise<void> {
  console.log(
    `[SchemaInit] 检测到 ${alters.length} 处缺失列，执行 ALTER 补齐：${alters.slice(0, 6).join(" | ")}${alters.length > 6 ? ` | ...共 ${alters.length} 处` : ""}`
  );
  let ok = 0;
  const failed: string[] = [];
  for (const sql of alters) {
    try {
      await db.$executeRawUnsafe(sql);
      ok += 1;
    } catch (e) {
      if (isAlreadyExistsError(e)) continue;
      failed.push(`${sql}（${(e as Error).message.split("\n")[0]}）`);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `[SchemaInit] 有 ${failed.length} 处列补齐失败，请手工执行或运行 bun run db:push：\n  - ${failed.join("\n  - ")}`
    );
  }
  console.log(`[SchemaInit] 列补齐完成（成功 ${ok} / 跳过已存在 ${alters.length - ok}）`);
}
