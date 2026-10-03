/**
 * 全表行数 + 7 个新字段填充情况只读统计（COUNT/SELECT，零写入）
 * 运行：export DATABASE_URL=<PG串> && bun scripts/pg-survey.ts
 */
import { PrismaClient as PgPrismaClient } from ".prisma-pg/client";

const db = new PgPrismaClient({ log: ["error"] });

const TABLES = [
  "SchemaVersion", "AdminUser", "Session", "LoginAudit", "Provider",
  "Account", "ModelRoute", "RouteCandidate", "VirtualKey", "SystemSetting",
  "CheckinLog", "RequestLog", "JobRun", "UsageDaily", "ModelPricing",
  "BalanceSnapshot", "AuditLog",
];

async function main() {
  console.log("=== 外部库 17 表行数 ===");
  for (const t of TABLES) {
    try {
      const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "${t}"`
      );
      console.log(`${t.padEnd(18)} = ${rows[0]?.n ?? "?"}`);
    } catch (e) {
      console.log(`${t.padEnd(18)} = ERROR: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  console.log("\n=== 7 个 schema 缺失列的数据填充情况 ===");
  const queries: Array<{ label: string; sql: string }> = [
    { label: "AdminUser.displayName非空", sql: `SELECT COUNT(*)::int AS n FROM "AdminUser" WHERE "displayName" IS NOT NULL` },
    { label: "AdminUser.role非默认(VIEWER)", sql: `SELECT COUNT(*)::int AS n FROM "AdminUser" WHERE "role" <> 'VIEWER'` },
    { label: "AdminUser.enabled=false", sql: `SELECT COUNT(*)::int AS n FROM "AdminUser" WHERE "enabled" = false` },
    { label: "AdminUser.lastLoginAt非空", sql: `SELECT COUNT(*)::int AS n FROM "AdminUser" WHERE "lastLoginAt" IS NOT NULL` },
    { label: "VirtualKey.ownerUserId非空", sql: `SELECT COUNT(*)::int AS n FROM "VirtualKey" WHERE "ownerUserId" IS NOT NULL` },
    { label: "RequestLog.ownerUserId非空", sql: `SELECT COUNT(*)::int AS n FROM "RequestLog" WHERE "ownerUserId" IS NOT NULL` },
    { label: "UsageDaily.ownerUserId非空串", sql: `SELECT COUNT(*)::int AS n FROM "UsageDaily" WHERE "ownerUserId" <> ''` },
  ];
  for (const q of queries) {
    try {
      const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(q.sql);
      console.log(`${q.label.padEnd(36)} = ${rows[0]?.n ?? "?"}`);
    } catch (e) {
      console.log(`${q.label.padEnd(36)} = ERROR: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  console.log("\n=== SchemaVersion 当前版本 ===");
  try {
    const rows = await db.$queryRawUnsafe<Array<{ version: number; name: string; appliedAt: Date }>>(
      `SELECT version, name, "appliedAt" FROM "SchemaVersion" ORDER BY version DESC LIMIT 5`
    );
    for (const r of rows) console.log(`v${r.version} ${r.name} (${r.appliedAt})`);
  } catch (e) {
    console.log(`ERROR: ${(e as Error).message.split("\n")[0]}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
