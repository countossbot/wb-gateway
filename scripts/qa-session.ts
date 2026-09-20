// QA 辅助脚本：为 admin 创建一个控制台会话，输出 token（供 agent-browser 注入 Cookie）
// 用法：bun run scripts/qa-session.ts
import { randomBytes, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

const admin = await db.adminUser.findFirst();
if (!admin) {
  console.error("NO_ADMIN");
  process.exit(1);
}
await db.session.create({ data: { tokenHash, userId: admin.id, expiresAt } });
console.log(JSON.stringify({ token, expiresAt: expiresAt.toISOString(), username: admin.username }));
await db.$disconnect();
