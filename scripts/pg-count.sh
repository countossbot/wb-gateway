#!/usr/bin/env bash
# 只读统计外部 PG 库各表行数（COUNT，零写入）
set -uo pipefail
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL 未设置。请先 export DATABASE_URL='postgresql://user:pass@host:port/db'" >&2
  exit 1
fi
PGURL="$DATABASE_URL"
# 凭据经环境变量提供（勿硬编码）；剥离 ? 及之后的全部参数（sslmode/connection_limit 等仅适用于 Prisma，psql 直连不需要）
CONN=$(echo "$PGURL" | sed 's|?.*$||')
TABLES="SchemaVersion AdminUser Session LoginAudit Provider Account ModelRoute RouteCandidate VirtualKey SystemSetting CheckinLog RequestLog JobRun UsageDaily ModelPricing BalanceSnapshot AuditLog"
if ! command -v psql >/dev/null 2>&1; then
  echo "psql not available"; exit 1
fi
for t in $TABLES; do
  n=$(psql "$CONN" -t -A -c "SELECT COUNT(*) FROM \"$t\";" 2>&1)
  echo "$t: $n"
done
