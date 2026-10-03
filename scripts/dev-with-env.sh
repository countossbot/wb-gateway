#!/usr/bin/env bash
# v4.11.1：dev 启动前从 .env 显式加载 DATABASE_URL（唯一事实来源 = .env）
#
# 背景：沙箱 /etc/profile.d/70-systemd-shell-extra.sh 给每个 shell 注入旧的
# DATABASE_URL=file:...（进程 env 优先级高于 .env；Next.js 内置 dotenv 只填充
# 不存在的变量、不会覆盖）。此前 supervisor.sh 的 start_dev 已有覆盖逻辑，
# 本脚本让手动 `bun run dev` 走同样的链路，两条启动路径行为一致。
#
# 只加载 .env 中以 DATABASE_URL= 开头的生效行（注释行以 # 开头天然不匹配）。

cd "$(dirname "$0")/.." || exit 1

while IFS= read -r line; do
  case "$line" in
    DATABASE_URL=*) export "${line}";;
  esac
done < .env

# 保持与原 dev 脚本完全一致的启动形态（next dev -p 3000 + tee dev.log），
# supervisor 的 pgrep 模式（next-server|next dev）与日志依赖均不受影响。
bun run next dev -p 3000 2>&1 | tee dev.log
