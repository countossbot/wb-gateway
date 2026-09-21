# syntax=docker/dockerfile:1

LABEL org.opencontainers.image.source="https://github.com/countossbot/wb-gateway"

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

# Dependency layer for maximum BuildKit cache reuse.
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

# Prisma Client must be generated for the target architecture during that architecture's build.
COPY prisma ./prisma
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

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=18787
ENV DATABASE_URL=file:/app/db/custom.db

# Prisma's SQLite engine needs the system OpenSSL libraries; CA certificates are
# needed for the gateway's outbound HTTPS requests.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# SQLite database directory. The container runs as the non-root node user.
RUN mkdir -p /app/db \
    && chown node:node /app/db

# Next.js standalone output already contains the traced production dependencies.
# The build script has also placed static assets, public assets, and init.sql here.
COPY --from=builder --chown=node:node /app/.next/standalone ./

USER node

EXPOSE 18787

CMD ["node", "server.js"]
