// v4.2.1 QA 专用：临时为每个账号插入昨日/前日余额快照（验证「预计可用天数」外推渲染），
// 用法：bun run tests/bal-forecast-seed.ts seed   → 插入合成快照（day-1 / day-2）
//       bun run tests/bal-forecast-seed.ts clean  → 精确删除这两个合成日的全部快照行
// 安全性：只触碰 BalanceSnapshot（派生统计表，getBalance 例行重写），不触碰任何业务配置；
//        今日真实快照不动；clean 按 day 精确删除（当前库 day-1/day-2 无真实数据，插入前已核对为空）。
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function dayKey(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function main() {
  const mode = process.argv[2];
  const day1 = dayKey(-1);
  const day2 = dayKey(-2);

  if (mode === "seed") {
    // 核对目标日无真实数据（有则拒绝，防覆盖）
    for (const day of [day1, day2]) {
      const n = await db.balanceSnapshot.count({ where: { day } });
      if (n > 0) {
        console.log(`REFUSE: day ${day} already has ${n} rows, abort`);
        process.exit(1);
      }
    }
    const accounts = await db.account.findMany();
    let inserted = 0;
    for (const a of accounts) {
      const bal = a.balance as { balance?: number; total?: number } | null;
      const todayBal = typeof bal?.balance === "number" ? bal.balance : 100;
      const meta = a.name || a.id;
      // 合成轨迹：前日=今日+140，昨日=今日+70（净消耗 70/天/账号）
      for (const [day, extra] of [[day2, 140], [day1, 70]] as Array<[string, number]>) {
        await db.balanceSnapshot.create({
          data: {
            day,
            providerId: a.providerId,
            accountId: a.id,
            accountName: meta,
            balance: Math.round((todayBal + extra) * 100) / 100,
            total: typeof bal?.total === "number" ? bal.total : todayBal + extra + 500,
            success: true,
          },
        });
        inserted += 1;
      }
    }
    console.log(`SEEDED ${inserted} synthetic snapshots (${day2}=+140, ${day1}=+70) for ${accounts.length} accounts`);
  } else if (mode === "clean") {
    const del = await db.balanceSnapshot.deleteMany({ where: { day: { in: [day1, day2] } } });
    console.log(`CLEANED ${del.count} synthetic snapshots for days ${day2}/${day1}`);
  } else {
    console.log("usage: bun run tests/bal-forecast-seed.ts seed|clean");
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
