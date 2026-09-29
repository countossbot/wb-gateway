# syntax=docker/dockerfile:1

# Build only. The final image contains no Bun, TypeScript, Prisma CLI, or source tree.
FROM node:22-bookworm-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Prisma generation needs OpenSSL available in the builder image.
RUN apt-get update \
    && apt-get install --no-install-recommends -y openssl \
    && rm -rf /var/lib/apt/lists/*

# Bun is used because this project is locked with bun.lock.
RUN --mount=type=cache,target=/root/.npm npm install --global bun@1.3.4

# 缓存键必须包含两份 schema：Prisma Client 会把 datasource provider 与 schema 指纹编译进
# 生成的 client。本项目支持 PostgreSQL 与 MySQL 双数据源（prisma/schema.prisma 与
# prisma/mysql/schema.prisma），各自生成到独立目录，运行时按 DATABASE_URL 协议选择。
# 若 schema 在 install 之后才 COPY，改动 schema 而 package.json/bun.lock 未变时，
# BuildKit 会命中 install 缓存层并跳过 regenerate，导致镜像内残留旧方言的 Client。
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
# 生成两份 client：PG → node_modules/.prisma-pg/client，MySQL → node_modules/.prisma-mysql/client
RUN bunx prisma generate && bunx prisma generate --schema prisma/mysql/schema.prisma

# Build with Node directly; Bun is only used for dependency installation and Prisma generation.
# Copy the static assets and init SQL required by the standalone runtime.
COPY . .
RUN --mount=type=cache,target=/app/.next/cache node_modules/.bin/next build \
    && cp -r .next/static .next/standalone/.next/ \
    && cp -r public .next/standalone/ \
    && mkdir -p .next/standalone/prisma \
    && cp prisma/init.postgres.sql prisma/init.mysql.sql .next/standalone/prisma/


# Minimal production runtime.
FROM node:22-bookworm-slim AS runner

# OCI source label 必须定义在最终 stage：多阶段构建中 builder 的 LABEL 不会继承到最终镜像，
# GHCR 仓库关联（commit d75cefd 意图）此前因放在 builder 而实际失效。
LABEL org.opencontainers.image.source="https://github.com/countossbot/wb-gateway"

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=18787
# DATABASE_URL 由平台注入，支持两种数据源（按协议自动识别）：
#   PostgreSQL: postgresql://user:pw@host:5432/db?sslmode=require
#   MySQL:      mysql://user:pw@host:3306/db
# 镜像内不设默认值以免误连。

# Prisma 的 libssl 依赖 + 出站 HTTPS 所需 CA 证书。
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# Next.js standalone output already contains the traced production dependencies.
# The build script has also placed static assets, public assets, and init SQL files here.
COPY --from=builder --chown=node:node /app/.next/standalone ./

USER node

EXPOSE 18787

CMD ["node", "server.js"]
