import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // v3.9.3：query 日志改为显式开启（PRISMA_LOG_QUERIES=1 重启生效）——此前每条 SQL 同步
    // console 输出是调度器「每 30s tick 一组重复日志」的主要噪声源（每天数万行同步 I/O，
    // 与 dev.log 写竞争）。error/warn 恒开；SQL 级调试时设环境变量。
    log: process.env.PRISMA_LOG_QUERIES === "1" ? ["query", "error", "warn"] : ["error", "warn"],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ---- v3.9.3：SQLite PRAGMA 初始化（连接建立后执行一次） ----
// WAL 模式 + 体积治理 + 自动 checkpoint 调优：
//   - journal_mode=WAL：并发读写友好（写不阻塞读），网关长驻进程的基础配置
//   - journal_size_limit：WAL 收缩上限（64MB）——此前 -1（不收缩）导致 -wal 文件只增不减
//   - wal_autocheckpoint：每 256 页（≈1MB）自动 checkpoint——此前默认 1000 页（≈4MB），
//     高频小写入下 WAL 增速远超 checkpoint 频率
//   - synchronous=NORMAL：WAL 推荐搭配（崩溃不丢已 checkpoint 数据，性能远优于 FULL）
//   - busy_timeout：写锁竞争时的等待上限（配合调度器分段删除的短事务策略）
//   - foreign_keys：Prisma 关系完整性兜底
const PRAGMAS: Array<{ name: string; value: string; description: string }> = [
  // journal_mode 已上移事务外（v4.0.0，见 JOURNAL_MODE_PRAGMA）
  { name: 'journal_size_limit', value: '67108864', description: 'WAL 收缩上限 64MB（防 -wal 只增不减）' },
  { name: 'wal_autocheckpoint', value: '256', description: '每 256 页（约 1MB）自动 checkpoint' },
  { name: 'busy_timeout', value: '5000', description: '写锁等待 5s（配合分段删除短事务）' },
  { name: 'foreign_keys', value: 'ON', description: '关系完整性' },
]

// SQLite 禁止事务内修改 synchronous（Safety level may not be changed inside a transaction）
// —— 必须在事务外执行；若连接池扩容导致部分连接缺失，默认 FULL（更保守方向，可接受）
const PRAGMAS_OUTSIDE_TX: Array<{ name: string; value: string }> = [
  { name: 'synchronous', value: '1' }, // NORMAL
]

// v4.0.0 修复：journal_mode 切换必须在事务外（SQLite 禁止「在事务内切入 WAL」）。
// 既有实现把全部 pragma 放交互式事务内 —— 对已有 WAL 库是 no-op 不报错（掩盖了 bug），
// 但容器空卷首启的新库 journal_mode 默认 delete，事务内切换必然失败并停留 delete 模式
//（WAL 治理在首启场景静默失效）。journal_mode 是库级持久属性（非 per-connection），
// 任意连接事务外设置一次即全局生效；切换若与其他连接的活动事务（如建表 DDL）冲突，
// 短暂重试即可。
const JOURNAL_MODE_PRAGMA = { name: 'journal_mode', value: 'WAL', description: 'WAL 并发模式（库级持久；事务外切换，冲突短重试）' }

/** 已初始化标记 —— 放 globalThis（跨 dev HMR 模块重载存活）：
 *  journal_mode 切换要求「无其他连接持有事务」，HMR 重载本模块时旧连接池仍在，
 *  重复切换会与旧连接竞态导致 SQLITE_READONLY_ROLLBACK（本轮实测踩坑）。
 *  进程生命周期内只执行一次；journal_mode 是数据库持久属性，切换一次即可。 */
const PRAGMA_KEY = "__uag_sqlite_pragmas_applied__"

/**
 * v3.9.3：应用 SQLite PRAGMA 并回读校验。
 * 失败不抛出（pragma 失败不应阻断服务启动），仅 console.error 留痕。
 * 回读日志打印 journal_size_limit / wal_autocheckpoint 等实际生效值，
 * 供运维直接核对（验收：PRAGMA journal_size_limit 返回 67108864）。
 */
export async function applySqlitePragmas(): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>
  if (g[PRAGMA_KEY]) return
  g[PRAGMA_KEY] = true
  try {
    // 事务外：synchronous（事务内被 SQLite 禁止）+ journal_mode（事务内禁止切入 WAL）
    for (const p of [...PRAGMAS_OUTSIDE_TX, JOURNAL_MODE_PRAGMA]) {
      // journal_mode 与其他连接活动事务（如首启建表 DDL）冲突时短重试（库级属性，重试幂等）
      const attempts = p.name === 'journal_mode' ? 3 : 1;
      for (let i = 1; i <= attempts; i++) {
        try {
          await db.$queryRawUnsafe(`PRAGMA ${p.name} = ${p.value}`)
          break
        } catch (e) {
          if (i < attempts) {
            await new Promise((r) => setTimeout(r, 300))
            continue
          }
          console.error(`[DB] PRAGMA ${p.name}=${p.value} failed after ${attempts} attempt(s):`, (e as Error).message)
        }
      }
    }
    // 交互式事务把「设置 + 回读」钉在同一个池连接上（普通 $queryRawUnsafe 可能被池
    // 调度到不同连接，per-connection pragma 会分散失效——本轮实测踩坑）。
    // 事务连接归还池后为热连接，后续查询大概率复用同一连接。
    await db.$transaction(async (tx) => {
      for (const p of PRAGMAS) {
        try {
          // pragma 常量均为模块内字面量（无注入面）
          await tx.$queryRawUnsafe(`PRAGMA ${p.name} = ${p.value}`)
        } catch (e) {
          console.error(`[DB] PRAGMA ${p.name}=${p.value} failed:`, (e as Error).message)
        }
      }
      // 回读校验（同一连接）：打印实际生效值（验收：journal_size_limit = 67108864）
      const readback: string[] = []
      for (const p of ['journal_mode', 'journal_size_limit', 'wal_autocheckpoint', 'synchronous', 'cache_size']) {
        const rows = (await tx.$queryRawUnsafe(`PRAGMA ${p}`)) as Array<Record<string, unknown>>
        const v = rows[0] ? String(Object.values(rows[0])[0]) : 'n/a'
        readback.push(`${p}=${v}`)
      }
      console.log(`[DB] SQLite pragmas applied (readback): ${readback.join(', ')}`)
    })
  } catch (e) {
    console.error('[DB] PRAGMA init failed:', (e as Error).message)
  }
}

// 进程启动时自动应用（module import 即生效；instrumentation.register 之前 PRAGMA 已就绪）
void applySqlitePragmas()
