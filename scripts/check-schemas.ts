// 双 schema 一致性校验：prisma/schema.prisma（PostgreSQL）与 prisma/mysql/schema.prisma（MySQL）
// 必须除「头部注释 / generator.client.output / datasource.provider」外逐字节一致。
//
// 为什么需要：两份 schema 是同一份逻辑模型的两份物理映射，业务代码只按 dbDialect 选 client，
// 不感知差异。一旦有人只改了一份（例如只给 PG 加了字段），MySQL 侧就会静默缺列，
// 直到线上报 P2022 才暴露。此脚本把这种漂移变成构建期可发现的失败。
//
// 用法：bun run db:check-schemas   （由 db:dump-schema 与 CI 调用；退出码非 0 表示漂移）

import { readFileSync } from 'node:fs'

const PG = 'prisma/schema.prisma'
const MYSQL = 'prisma/mysql/schema.prisma'

// 允许的差异：这些行在两侧本就应当不同（provider 决定物理方言，output 决定生成位置）
const PROVIDER_PG = 'provider = "postgresql"'
const PROVIDER_MY = 'provider = "mysql"'

function normalize(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    // 去掉行注释（两份文件头部注释不同，且注释不参与语义）
    .map((l) => l.replace(/\s*\/\/.*$/, '').trimEnd())
    // 忽略 provider / output 这两行：它们按设计必须不同
    .filter((l) => {
      const t = l.trim()
      if (t === PROVIDER_PG || t === PROVIDER_MY) return false
      if (t.startsWith('output')) return false
      return t.length > 0
    })
}

const pg = normalize(PG)
const mysql = normalize(MYSQL)

if (pg.length !== mysql.length) {
  console.error(`❌ 双 schema 行数不一致（已忽略注释/provider/output）：${PG}=${pg.length} vs ${MYSQL}=${mysql.length}`)
  process.exit(1)
}

const diffs: string[] = []
for (let i = 0; i < pg.length; i += 1) {
  if (pg[i] !== mysql[i]) {
    diffs.push(`  第 ${i + 1} 处:\n    ${PG}:   ${pg[i]}\n    ${MYSQL}: ${mysql[i]}`)
  }
}

if (diffs.length > 0) {
  console.error(`❌ 双 schema 已漂移（PRISMA schema 必须保持逐字段一致，仅 provider/output 可不同）：`)
  console.error(diffs.slice(0, 20).join('\n'))
  if (diffs.length > 20) console.error(`  ...其余 ${diffs.length - 20} 处省略`)
  console.error(`\n修复：把缺失的改动同步到另一份 schema，或重新用 prisma/schema.prisma 派生 prisma/mysql/schema.prisma。`)
  process.exit(1)
}

console.log(`✅ 双 schema 一致（忽略注释/provider/output 后逐行相同，共 ${pg.length} 行有效内容）`)
