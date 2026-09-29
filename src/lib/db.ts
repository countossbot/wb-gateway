/**
 * v4.2.0：双数据库支持（PostgreSQL / MySQL，按 DATABASE_URL 协议自动选择）。
 *
 * 背景：Prisma 的 datasource.provider 是编译期定型的，单个 @prisma/client 无法同时
 * 支持两种库（provider = ["postgresql","mysql"] 会报 P1012）。因此仓库维护两份 schema：
 *   - prisma/schema.prisma        → PostgreSQL，client 生成到 node_modules/.prisma-pg
 *   - prisma/mysql/schema.prisma  → MySQL，client 生成到 node_modules/.prisma-mysql
 * 两者除 provider / output 外完全一致（scripts 内可校验）。
 *
 * 连接配置（唯一需要设置的环境变量）：
 *   PostgreSQL: DATABASE_URL="postgresql://user:pw@host:5432/db?sslmode=require"
 *   MySQL:      DATABASE_URL="mysql://user:pw@host:3306/db"
 * 以 postgres:// 或 postgresql:// 开头 → PG；以 mysql:// 开头 → MySQL。
 *
 * 实现约束：必须用「静态 import 两条 + 运行时二选一」，不能用 createRequire/动态字符串——
 * Turbopack 无法静态分析动态 require（构建期报 "expression is too dynamic"），
 * 也无法把它们追踪进 .next/standalone 产物。
 */
import { PrismaClient as PgPrismaClient } from '.prisma-pg/client'
import { PrismaClient as MysqlPrismaClient } from '.prisma-mysql/client'

export type DbDialect = 'postgresql' | 'mysql'

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

const globalForPrisma = globalThis as unknown as {
  prisma: PgPrismaClient | undefined
}

// 两份 schema 除 provider / output 外完全一致，生成的 Client API 同形；为让 TS 得到确定类型
// （三元表达式会推断成 Pg|Mysql 联合，导致 db.xxx 不可调用），此处断言为 PG Client 类型。
const PrismaClientCtor = (dbDialect === 'mysql' ? MysqlPrismaClient : PgPrismaClient) as typeof PgPrismaClient

/**
 * 运行期配置校验：延迟到第一次访问 db 时才要求 DATABASE_URL 合法。
 * 这样 `next build`（无运行期配置）可正常完成，而一旦真连库、配置缺失会立刻给出明确报错。
 */
function assertConfigured(): void {
  if (rawUrl.length === 0) {
    throw new Error(
      '[DB] 未设置 DATABASE_URL。请配置为 postgresql://user:pw@host:5432/db?sslmode=require 或 mysql://user:pw@host:3306/db'
    )
  }
  if (detected === null) {
    throw new Error(
      `[DB] DATABASE_URL 无法识别数据源类型（需以 postgresql:// 或 mysql:// 开头），当前值前缀: "${rawUrl.slice(0, 24)}"`
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
// 数据源只支持 PostgreSQL / MySQL（均无 PRAGMA 概念）。以下保留兼容符号：
//   - isSqlite：恒为 false，供 scheduler 中「仅 SQLite 需要的 WAL 治理」分支短路，
//     避免为一次能力下线改动调度器多处逻辑。
//   - applySqlitePragmas：no-op，保留供 instrumentation 调用不报错。
export const isSqlite = false

/** 历史遗留：SQLite PRAGMA 初始化。SQLite 已不再支持，此函数为空操作。 */
export async function applySqlitePragmas(): Promise<void> {
  /* no-op：数据源为 PostgreSQL / MySQL 时 PRAGMA 无意义 */
}
