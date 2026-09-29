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

# 缓存键必须包含 prisma/schema.prisma：Prisma Client 会把 datasource provider 与 schema
# 指纹编译进 node_modules/.prisma/client。若 schema 在 install 之后才 COPY，改动 schema
# 而 package.json/bun.lock 未变时，BuildKit 会命中 install 缓存层并跳过 regenerate，
# 导致镜像内残留旧方言的 Client（表现为运行时读到旧 provider，如 PG 项目报「必须 file:」）。
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
RUN bunx prisma generate

# Build with Node directly; Bun is only used for dependency installation and Prisma generation.
# Copy the static assets and init SQL required by the standalone runtime.
COPY . .
RUN --mount=type=cache,target=/app/.next/cache node_modules/.bin/next build \
    && cp -r .next/static .next/standalone/.next/ \
    && cp -r public .next/standalone/ \
    && mkdir -p .next/standalone/prisma \
    && cp prisma/init.sql .next/standalone/prisma/init.sql


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
# DATABASE_URL 由平台注入（Render / Aiven / 自建 PG），镜像内不设默认值以免误连。
# 仅 SQLite 单机部署时需要显式提供 file: 形式连接串。

# Prisma 的 libssl 依赖 + 出站 HTTPS 所需 CA 证书。
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# Next.js standalone output already contains the traced production dependencies.
# The build script has also placed static assets, public assets, and init.sql here.
COPY --from=builder --chown=node:node /app/.next/standalone ./

USER node

EXPOSE 18787

CMD ["node", "server.js"]
