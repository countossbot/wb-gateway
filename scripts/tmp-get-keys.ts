import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const rows = await db.systemSetting.findMany();
for (const r of rows) console.log(r.key, '=', String(r.value).slice(0, 10) + '...');
await db.$disconnect();
