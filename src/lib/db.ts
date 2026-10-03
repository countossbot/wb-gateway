/**
 * v4.2.0：双数据库支持（PostgreSQL / MySQL，按 DATABASE_URL 协议自动选择）。
 * v4.11.0-local：重新引入 SQLite 本地单机支持（第三方言）。
 *
 * 背景：Prisma 的 datasource.provider 是编译期定型的，单个 @prisma/client 无法同时
 * 支持两种库（provider = ["postgresql","mysql"] 会报 P1012）。因此仓库维护多份 schema：
 *   - prisma/schema.prisma         → PostgreSQL，client 生成到 node_modules/.prisma-pg
 *   - prisma/mysql/schema.prisma   → MySQL，client 生成到 node_modules/.prisma-mysql
 *   - prisma/sqlite/schema.prisma  → SQLite（本地单机），client 生成到 node_modules/.prisma-sqlite
 * 三者除 provider / output 外完全一致。
 *
 * 连接配置（唯一需要设置的环境变量）：
 *   PostgreSQL: DATABASE_URL="postgresql://user:pw@host:5432/db?sslmode=require"
 *   MySQL:      DATABASE_URL="mysql://user:pw@host:3306/db"
 *   SQLite:     DATABASE_URL="file:/abs/path/custom.db"（本地部署，建议绝对路径避免歧义）
 * 以 postgres:// 或 postgresql:// 开头 → PG；以 mysql:// 开头 → MySQL；
 * 以 file: 开头 → SQLite。
 *
 * 实现约束：必须用「静态 import 多条 + 运行时多选一」，不能用 createRequire/动态字符串——
 * Turbopack 无法静态分析动态 require（构建期报 "expression is too dynamic"），
 * 也无法把它们追踪进 .next/standalone 产物。
 */
import { PrismaClient as PgPrismaClient, Prisma } from '.prisma-pg/client'
import { PrismaClient as MysqlPrismaClient } from '.prisma-mysql/client'
// v4.11.0-local：重新引入 SQLite 本地单机支持（第三方言，schema 见 prisma/sqlite/schema.prisma）
import { PrismaClient as SqlitePrismaClient } from '.prisma-sqlite/client'

/**
 * v4.2+ 修复：双 schema 生成到自定义 output 后，`@prisma/client` 不再导出 `Prisma` 命名空间
 * （它只 re-export 默认 output 的那个 Client）。两处调用方（backup 路由的 JsonNull、
 * requestLog 的 WhereInput 过滤类型）原本从 '@prisma/client' 取 `Prisma`，导致 TS2305。
 * 统一改从本模块转发：方言无关的纯类型/哨兵值，取 PG 侧与 `db` 的类型断言保持同源。
 */
export { Prisma }

export type DbDialect = 'postgresql' | 'mysql' | 'sqlite'

const rawUrl = (process.env.DATABASE_URL ?? '').trim()

/**
 * 识别连接串方言。返回 null 表示「未配置或无法识别」——不在模块加载时抛错。
 *
 * v4.2.3 修复：原实现于模块顶层立即抛错，导致 `next build` 阶段（collecting page data
 * 会 import 本模块）在没有 DATABASE_URL 的环境直接构建失败——CI/Docker 构建期本就不该
 * 依赖运行期配置。现改为惰性：加载期得到 null，首次真正访问数据库时才校验并报错。
 */
function detectDialect(url: string): DbDialect | null {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgresql'
  if (url.startsWith('mysql://')) return 'mysql'
  if (url.startsWith('file:')) return 'sqlite'
  return null
}

const detected = detectDialect(rawUrl)

/**
 * 运行期方言。构建期未配置 DATABASE_URL 时回落为 'postgresql' 仅用于让类型与模块图成立，
 * 真正生效的行为由下面的 Proxy 在首次属性访问时再次校验（见 assertConfigured）。
 */
export const dbDialect: DbDialect = detected ?? 'postgresql'

/** 当前数据源是否为 MySQL（供少量方言差异分支使用）。 */
export const isMysql = dbDialect === 'mysql'

/** 当前数据源是否为 SQLite（v4.11.0-local 恢复：供 scheduler 的 WAL 治理分支与 system-info 使用）。 */
export const isSqlite = dbDialect === 'sqlite'

const globalForPrisma = globalThis as unknown as {
  prisma: PgPrismaClient | undefined
}

// 三份 schema 除 provider / output 外完全一致，生成的 Client API 同形；为让 TS 得到确定类型
// （三元表达式会推断成联合类型，导致 db.xxx 不可调用），此处断言为 PG Client 类型。
const PrismaClientCtor = (
  dbDialect === 'mysql'
    ? MysqlPrismaClient
    : dbDialect === 'sqlite'
      ? SqlitePrismaClient
      : PgPrismaClient
) as typeof PgPrismaClient

/**
 * 运行期配置校验：延迟到第一次访问 db 时才要求 DATABASE_URL 合法。
 * 这样 `next build`（无运行期配置）可正常完成，而一旦真连库、配置缺失会立刻给出明确报错。
 */
function assertConfigured(): void {
  if (rawUrl.length === 0) {
    throw new Error(
      '[DB] 未设置 DATABASE_URL。请配置为 postgresql://user:pw@host:5432/db?sslmode=require 或 mysql://user:pw@host:3306/db 或 file:/path/custom.db'
    )
  }
  if (detected === null) {
    throw new Error(
      `[DB] DATABASE_URL 无法识别数据源类型（需以 postgresql:// / mysql:// / file: 开头），当前值前缀: "${rawUrl.slice(0, 24)}"`
    )
  }
}

const realDb: PgPrismaClient =
  globalForPrisma.prisma ??
  new PrismaClientCtor({
    // v3.9.3：query 日志改为显式开启（PRISMA_LOG_QUERIES=1 重启生效）——此前每条 SQL 同步
    // console 输出是调度器「每 30s tick 一组重复日志」的主要噪声源（每天数万行同步 I/O，
    // 与 dev.log 写竞争）。error/warn 恒开；SQL 级调试时设环境变量。
    log: process.env.PRISMA_LOG_QUERIES === '1' ? ['query', 'error', 'warn'] : ['error', 'warn'],
  })

/**
 * 代理：首次访问任意属性时先校验配置，再转发给真实 Client。
 * 这样既保留了「配置错误立即暴露」的保护，又不把校验提前到模块加载/构建期。
 */
export const db: PgPrismaClient = new Proxy(realDb, {
  get(target, prop, receiver) {
    assertConfigured()
    const value = Reflect.get(target, prop, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = realDb

// ---- v4.11.0-local：恢复 SQLite PRAGMA 初始化（历史实现，见 v3.9.3 / v4.0.0 版本） ----
// WAL 模式 + 体积治理 + 自动 checkpoint 调优（仅 SQLite 方言生效）：
//   - journal_mode=WAL：并发读写友好（写不阻塞读），网关长驻进程的基础配置。
//     库级持久属性，必须在事务外切换（SQLite 禁止事务内切 WAL）；冲突时短重试。
//   - journal_size_limit：WAL 收缩上限 64MB（防 -wal 只增不减）
//   - wal_autocheckpoint：每 256 页（≈1MB）自动 checkpoint
//   - synchronous=NORMAL：WAL 推荐搭配（崩溃不丢已 checkpoint 数据，性能远优于 FULL）
//   - busy_timeout：写锁竞争时的等待上限
//   - foreign_keys：Prisma 关系完整性兜底

const PRAGMA_KEY = '__uag_sqlite_pragmas_applied__'
const JOURNAL_MODE_PRAGMA = { name: 'journal_mode', value: 'WAL' }
const PRAGMAS: Array<{ name: string; value: string }> = [
  { name: 'journal_size_limit', value: '67108864' },
  { name: 'wal_autocheckpoint', value: '256' },
  { name: 'busy_timeout', value: '5000' },
  { name: 'foreign_keys', value: 'ON' },
]

/**
 * 应用 SQLite PRAGMA 并回读校验（仅 SQLite 方言；其他方言 no-op）。
 * 失败不抛出（pragma 失败不应阻断服务启动），仅 console.error 留痕。
 * globalThis 标记防 dev HMR 重载后重复切换 journal_mode 与旧连接竞态。
 */
export async function applySqlitePragmas(): Promise<void> {
  if (!isSqlite) return
  const g = globalThis as unknown as Record<string, unknown>
  if (g[PRAGMA_KEY]) return
  g[PRAGMA_KEY] = true
  try {
    // journal_mode 是库级持久属性：事务外设置一次即全局生效；与其他连接的活动事务冲突时短重试
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const mode = (await db.$queryRawUnsafe(`PRAGMA ${JOURNAL_MODE_PRAGMA.name} = ${JOURNAL_MODE_PRAGMA.value}`)) as Array<Record<string, unknown>>
        console.log(`[DB] SQLite journal_mode: ${JSON.stringify(mode[0] ?? {})}`)
        break
      } catch (e) {
        if (attempt === 4) throw e
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }
    // 其余 per-connection pragma：放事务外执行（synchronous 禁止事务内修改）
    for (const p of PRAGMAS) {
      try {
        await db.$queryRawUnsafe(`PRAGMA ${p.name} = ${p.value}`)
      } catch (e) {
        console.warn(`[DB] PRAGMA ${p.name} failed:`, (e as Error).message)
      }
    }
    const synchronous = (await db.$queryRawUnsafe(`PRAGMA synchronous`)) as Array<Record<string, unknown>>
    const limit = (await db.$queryRawUnsafe(`PRAGMA journal_size_limit`)) as Array<Record<string, unknown>>
    // Prisma SQLite 会把部分 PRAGMA 返回值映射为 BigInt，JSON.stringify 无法直接序列化
    const jsonSafe = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x))
    console.log(
      `[DB] SQLite PRAGMAs applied (synchronous=${jsonSafe(synchronous[0] ?? {})}, journal_size_limit=${jsonSafe(limit[0] ?? {})})`
    )
  } catch (e) {
    console.error('[DB] SQLite PRAGMA init failed (non-fatal):', (e as Error).message)
  }
}
