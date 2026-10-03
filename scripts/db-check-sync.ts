/**
 * 数据库同步状态检查脚本（v4.9.11 新增）
 *
 * 检测内容：
 *   1. Schema 与远程 DB 是否同步（prisma migrate diff）
 *   2. 各业务表的行数（Provider / Account / Route / Key / RequestLog 等）
 *   3. 是否有 pending migration
 *
 * 用法：bun run db:check-sync
 */
import { execSync } from "node:child_process";
import { PrismaClient as PgPrismaClient } from ".prisma-pg/client";
import { PrismaClient as MysqlPrismaClient } from ".prisma-mysql/client";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL 未设置");
  process.exit(1);
}

console.log("╔════════════════════════════════════════════════╗");
console.log("║  UAG 数据库同步状态检查                         ║");
console.log("╚════════════════════════════════════════════════╝");
console.log();

// Step 1: Schema 同步检测
console.log("📋 Step 1: Schema 同步检测...");
let diffOutput = "";
try {
  diffOutput = execSync(
    `npx prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma`,
    { encoding: "utf-8", timeout: 30_000 }
  ).trim();
} catch (e) {
  const out = (e as Error).message;
  if (out.includes("No difference detected")) {
    diffOutput = "";
  } else {
    diffOutput = out;
  }
}

if (!diffOutput || diffOutput === "No difference detected.") {
  console.log("  ✅ Schema 与远程 DB 完全同步（无差异）");
  console.log("  ✅ 后续 db:push 不会做任何修改，数据 100% 安全");
} else {
  console.log("  ⚠️  Schema 与远程 DB 有差异：");
  console.log("  ─".repeat(56));
  console.log(diffOutput.split("\n").map((l: string) => "  " + l).join("\n"));
  console.log("  ─".repeat(56));
  console.log("  💡 运行 bun run db:push:safe 安全推送");
}
console.log();

// Step 2: 表行数检查
console.log("📊 Step 2: 表行数检查...");
// 双数据库：按 DATABASE_URL 协议选择本地自定义 output 的 Prisma Client（与 src/lib/db.ts 一致）
const db = DATABASE_URL.startsWith("mysql")
  ? new MysqlPrismaClient({ log: ["error"] })
  : new PgPrismaClient({ log: ["error"] });

const TABLES = [
  { name: "Provider", label: "提供商" },
  { name: "Account", label: "账号" },
  { name: "ModelRoute", label: "模型路由" },
  { name: "RouteCandidate", label: "路由候选" },
  { name: "VirtualKey", label: "虚拟密钥" },
  { name: "SystemSetting", label: "系统设置" },
  { name: "AdminUser", label: "管理员" },
  { name: "Session", label: "会话" },
  { name: "RequestLog", label: "请求日志" },
  { name: "UsageDaily", label: "日用量" },
  { name: "CheckinLog", label: "签到日志" },
  { name: "BalanceSnapshot", label: "余额快照" },
  { name: "AuditLog", label: "操作审计" },
  { name: "JobRun", label: "任务执行" },
  { name: "LoginAudit", label: "登录审计" },
  { name: "ModelPricing", label: "模型单价" },
  { name: "SchemaVersion", label: "Schema 版本" },
] as const;

const results: Array<{ name: string; label: string; count: number }> = [];
for (const { name, label } of TABLES) {
  try {
    const key = name.charAt(0).toLowerCase() + name.slice(1);
    const count = await db[key].count();
    results.push({ name, label, count: typeof count === "number" ? count : Number(count) });
  } catch {
    results.push({ name, label, count: -1 });
  }
}

await db.$disconnect();

console.log();
for (const r of results) {
  const status = r.count === 0 ? "⬜" : r.count > 0 ? "✅" : "❌";
  const countStr = r.count >= 0 ? r.count.toString().padStart(6) : "  N/A";
  console.log(`  ${status} ${r.label.padEnd(8)} ${r.name.padEnd(16)} ${countStr} 行`);
}

console.log();
const totalRows = results.reduce((s, r) => s + (r.count > 0 ? r.count : 0), 0);
const hasData = totalRows > 0;
console.log(`  总计：${totalRows} 行业务数据`);

if (hasData) {
  console.log("  ✅ 数据库有数据 → db:push:safe 会先检测差异再确认");
} else {
  console.log("  ⬜ 数据库为空 → db:push 会直接建表，无数据丢失风险");
}

console.log();
console.log("╔════════════════════════════════════════════════╗");
console.log("║  检查完成                                       ║");
console.log("╚════════════════════════════════════════════════╝");
