// 账号冷却持久层 —— 内存写穿缓存 + SQLite 跨重启落盘 + 退避标记的唯一写入口。
// （原版为 KV 跨 isolate 落盘；单进程常驻后语义等价转换为 SQLite 跨重启落盘，
//  重启后冷却不丢失 —— 验收要求四.3。）
// 调度决策（选谁、退避多久）在 scheduler.ts；这里只管状态的存取。
import { db } from "@/lib/db";
import { computeCooldown, backoffMinutesForStreak, type CooldownMap, type SchedulableAccount } from "../../core/scheduler";
import { BoundedMap } from "../../core/boundedMap";

// 账号 429 / 额度耗尽动态退避记录: accountId -> { expiresAt: number, streak: number }
// 进程内为写穿缓存；跨重启的真实状态落在 SQLite Account 表。
// 由调用方（orderAccounts 排序）读取，唯一写入口是 setAccountCooldown。
// v3.9.3：BoundedMap 有界化（上限 1000，防异常 providerId 枚举撑爆；账号为有限集合，
// 正常业务永不触顶；驱逐直接丢弃——真实状态以 SQLite Account 表为准，安全）。
export const accountCooldownRecord: CooldownMap = new BoundedMap({ maxEntries: 1000 });

// 复合定位：冷却记录的内存键沿用原版裸 accountId，但落库时以 (providerId, accountId) 定位，
// 避免跨 provider 的账号 id 碰撞写错行。
function dbWhere(providerId: string, accountId: string) {
  return { providerId_id: { providerId, id: accountId } };
}

let lastHydrateTimestamp = 0;
const HYDRATE_THROTTLE_MS = 5 * 1000; // 5 秒防抖：同批高并发下只水合一次 DB，消除无谓往返

// 把 SQLite 中的冷却记录水合进进程缓存（5 秒内节流；强制水合供外部修改后调用）
export async function hydrateCooldowns(
  providerId: string | null,
  accounts: SchedulableAccount[],
  force = false
): Promise<void> {
  if (!accounts?.length) return;
  const now = Date.now();
  if (!force && now - lastHydrateTimestamp < HYDRATE_THROTTLE_MS) {
    return;
  }
  lastHydrateTimestamp = now;

  try {
    const rows = providerId
      ? await db.account.findMany({
          where: {
            providerId,
            cooldownUntil: { gt: new Date(now) },
          },
          select: { id: true, cooldownUntil: true, cooldownStreak: true, cooldownReason: true },
        })
      : await db.account.findMany({
          where: { cooldownUntil: { gt: new Date(now) } },
          select: { id: true, providerId: true, cooldownUntil: true, cooldownStreak: true, cooldownReason: true },
        });
    for (const row of rows) {
      // 已过期的不写入缓存；以更晚的过期时间为准，避免陈旧内存覆盖 DB 的更新
      const expiresAt = row.cooldownUntil?.getTime() || 0;
      if (expiresAt < now) continue;
      const record = { expiresAt, streak: row.cooldownStreak, reason: row.cooldownReason ?? null };
      const local = accountCooldownRecord.get(row.id);
      if (!local || local.expiresAt < record.expiresAt) {
        accountCooldownRecord.set(row.id, record);
      }
    }
  } catch (e) {
    console.error("[Cooldown] hydrate from SQLite failed:", e);
  }
}

async function persistCooldown(
  providerId: string,
  accountId: string,
  record: { expiresAt: number; streak: number; reason?: string | null }
): Promise<void> {
  try {
    await db.account.update({
      where: dbWhere(providerId, accountId),
      data: {
        cooldownUntil: new Date(record.expiresAt),
        cooldownStreak: record.streak,
        cooldownReason: record.reason?.slice(0, 300) ?? null,
      },
    });
  } catch (e) {
    console.error(`Failed to persist cooldown for ${providerId}/${accountId}:`, e);
  }
}

async function markAccountRateLimited(
  providerId: string,
  account: SchedulableAccount,
  reason?: string | null
): Promise<void> {
  const record = computeCooldown(account.id, accountCooldownRecord);
  if (reason) record.reason = reason.slice(0, 300);
  accountCooldownRecord.set(account.id, record);
  // 可靠落盘 SQLite 冷却记录（await 确保写入完成），重启后冷却仍然生效
  await persistCooldown(providerId, account.id, record);
  console.warn(
    `[WorkBuddy] Account "${account.name || account.id}" 429/rate-limited (streak ${record.streak}${reason ? `, reason: ${reason.slice(0, 80)}` : ""}), cooling down for ${backoffMinutesForStreak(record.streak)}m...`
  );
}

async function clearAccountCooldown(providerId: string, account: SchedulableAccount): Promise<void> {
  // 本进程无记录时跳过 DB 写：成功路径每次调用都来清一次，99% 是删寂寞（原版取舍保留）。
  if (!accountCooldownRecord.delete(account.id)) return;
  try {
    await db.account.updateMany({
      where: { providerId, id: account.id, OR: [{ cooldownUntil: { not: null } }, { cooldownStreak: { not: 0 } }] },
      data: { cooldownUntil: null, cooldownStreak: 0, cooldownReason: null },
    });
  } catch (e) {
    console.error(`Failed to clear cooldown for ${account.id}:`, e);
  }
}

// 冷却状态唯一写入口：调用方只传动作，不直接碰 Map / DB。
// action "cooldown" = 惩罚性退避并落盘（可附原因摘要）；"clear" = 清除惩罚标记。
export async function setAccountCooldown(
  providerId: string,
  account: SchedulableAccount,
  action: "cooldown" | "clear",
  reason?: string | null
): Promise<void> {
  if (action === "cooldown") {
    await markAccountRateLimited(providerId, account, reason);
  } else {
    await clearAccountCooldown(providerId, account);
  }
}

// 测试隔离：清空进程级冷却缓存
export function resetCooldownCacheForTest(): void {
  accountCooldownRecord.clear();
  lastHydrateTimestamp = 0;
}

// v3.2.3：过期冷却残留清扫（调度器每小时节流调用）。
// orderAccounts 已将 expiresAt < now 视为健康，过期行对调度零影响；
// 本函数只做数据卫生：DB 中 cooldownUntil < now 的行归零（含 streak/reason），
// 进程内 Map 中已过期的记录一并移除（防长期运行缓慢积累）。
// 只触碰「已过期」的行/记录，绝不会影响仍在冷却期的账号。
export async function purgeExpiredCooldowns(): Promise<{ db: number; mem: number }> {
  const now = Date.now();
  let dbCount = 0;
  try {
    const r = await db.account.updateMany({
      where: { cooldownUntil: { lt: new Date(now) } },
      data: { cooldownUntil: null, cooldownStreak: 0, cooldownReason: null },
    });
    dbCount = r.count;
  } catch (e) {
    console.error("[Cooldown] purge expired cooldown rows failed:", e);
  }
  let memCount = 0;
  for (const [id, rec] of accountCooldownRecord) {
    if (rec.expiresAt < now) {
      accountCooldownRecord.delete(id);
      memCount++;
    }
  }
  return { db: dbCount, mem: memCount };
}

// v3.4.0：管理员强制清除指定账号冷却（总览 / 账号管理页「一键清冷却」）。
// 与调度内部 clear（setAccountCooldown "clear"）语义不同：
// - 调度内部 clear：成功调用后顺带清标记，「本进程无记录则跳过 DB 写」的优化在此不适用——
//   管理员看到的冷却状态可能来自 DB 水合（如重启后），必须无条件清 DB 才能保证 UI 状态一致；
// - 同时删进程内缓存记录（若存在），避免调度器继续读到内存中的旧退避。
// 返回是否真的清掉了冷却中的账号（供 API/审计判定；对健康账号调用返回 false，幂等无害）。
export async function adminClearCooldown(providerId: string, accountId: string): Promise<boolean> {
  accountCooldownRecord.delete(accountId);
  const r = await db.account.updateMany({
    where: {
      providerId,
      id: accountId,
      OR: [{ cooldownUntil: { not: null } }, { cooldownStreak: { not: 0 } }],
    },
    data: { cooldownUntil: null, cooldownStreak: 0, cooldownReason: null },
  });
  return r.count > 0;
}
