// GET /api/console/balances/history?days=N —— 余额按日快照时间序列（v3.6.0 新增）。
// 数据源：BalanceSnapshot（fleet.getBalance 实测时顺带落库，零额外上游调用）。
// 返回：完整日期轴 + 每账号逐日余额点阵（缺失日为 null，前端画为空档），
//       另附 per-account 首末值与差值（delta = last - first，正=签到/充值，负=消耗）。
// 天数上限 90（与 UsageDaily 同口径）；无快照时返回空 accounts（前端优雅降级）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, ok } from "@/lib/gateway/console/consoleHelpers";
import { localDayKey } from "@/lib/gateway/config/requestLog";
import type { BalanceHistoryAccount } from "@/lib/console/types";

export const dynamic = "force-dynamic";

function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + deltaDays);
  return localDayKey(dt);
}

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "usage.read");
  if (session instanceof Response) return session;

  const daysParam = Number(request.nextUrl.searchParams.get("days"));
  const days = Math.min(90, Math.max(1, Number.isFinite(daysParam) ? Math.floor(daysParam) : 14));

  // 日期轴：最旧 → 今日（服务器本地时区，与 UsageDaily/快照写入同口径）
  const today = localDayKey();
  const axis: string[] = [];
  for (let i = days - 1; i >= 0; i--) axis.push(shiftDay(today, -i));
  const axisSet = new Map(axis.map((d, i) => [d, i]));

  const rows = await db.balanceSnapshot.findMany({
    where: { day: { gte: axis[0] } },
    orderBy: [{ day: "asc" }, { updatedAt: "asc" }],
  });

  // 维度键：providerId+accountId；同名展示信息取最新一条
  const meta = new Map<string, { providerName: string; accountName: string }>();
  const points = new Map<string, Array<number | null>>();
  for (const r of rows) {
    const key = `${r.providerId}\u0000${r.accountId}`;
    if (!points.has(key)) points.set(key, new Array(axis.length).fill(null));
    const idx = axisSet.get(r.day);
    if (idx === undefined) continue;
    const arr = points.get(key);
    if (arr) arr[idx] = r.success ? r.balance : null; // 失败实测不留值（避免脏点），但快照行保留
    meta.set(key, { providerName: r.providerId, accountName: r.accountName || r.accountId });
  }

  // 提供商展示名（providerId → name）
  const providers = await db.provider.findMany({ select: { id: true, name: true } });
  const providerNameMap = new Map(providers.map((p) => [p.id, p.name]));

  const accounts: BalanceHistoryAccount[] = [];
  for (const [key, arr] of points) {
    const [providerId, accountId] = key.split("\u0000");
    const nonNull = arr.filter((v): v is number => v !== null);
    const first = nonNull.length > 0 ? nonNull[0] : null;
    const last = nonNull.length > 0 ? nonNull[nonNull.length - 1] : null;
    const m = meta.get(key);
    accounts.push({
      providerId,
      providerName: providerNameMap.get(providerId) || providerId,
      accountId,
      accountName: m?.accountName || accountId,
      points: arr,
      first,
      last,
      delta: first !== null && last !== null ? Math.round((last - first) * 100) / 100 : null,
    });
  }
  accounts.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.accountName.localeCompare(b.accountName));

  return ok({ days: axis, accounts, fetchedAt: new Date().toISOString() });
}
