-- CreateTable
CREATE TABLE "SchemaVersion" (
    "version" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LoginAudit" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "proxyOverride" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "credentials" JSONB NOT NULL,
    "balance" JSONB,
    "cooldownUntil" DATETIME,
    "cooldownStreak" INTEGER NOT NULL DEFAULT 0,
    "cooldownReason" TEXT,
    "lastCheckinAt" DATETIME,
    "lastCheckinOk" BOOLEAN,
    "lastRefreshAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Account_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelRoute" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "model" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RouteCandidate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "routeId" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,
    CONSTRAINT "RouteCandidate_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "ModelRoute" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VirtualKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "keyValue" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "models" JSONB NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'client',
    "remark" TEXT,
    "dailyRequestLimit" INTEGER NOT NULL DEFAULT 0,
    "dailyTokenLimit" INTEGER NOT NULL DEFAULT 0,
    "monthlyCostLimit" REAL NOT NULL DEFAULT 0,
    "ownerUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CheckinLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT,
    "accountName" TEXT,
    "success" BOOLEAN NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RequestLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'openai',
    "providerId" TEXT,
    "accountId" TEXT,
    "durationMs" INTEGER,
    "status" INTEGER,
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedTokens" INTEGER,
    "apiKeyName" TEXT,
    "error" TEXT,
    "usageExact" BOOLEAN
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "job" TEXT NOT NULL,
    "triggered" TEXT NOT NULL DEFAULT 'cron',
    "success" BOOLEAN NOT NULL,
    "detail" JSONB,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UsageDaily" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "day" TEXT NOT NULL,
    "providerId" TEXT NOT NULL DEFAULT '',
    "apiKeyName" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "requests" INTEGER NOT NULL DEFAULT 0,
    "okRequests" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModelPricing" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "model" TEXT NOT NULL,
    "inputPerMTok" REAL NOT NULL DEFAULT 0,
    "outputPerMTok" REAL NOT NULL DEFAULT 0,
    "cachedPerMTok" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT NOT NULL DEFAULT 'admin'
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelPricing_model_key" ON "ModelPricing"("model");

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "day" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL DEFAULT '',
    "balance" REAL NOT NULL DEFAULT 0,
    "total" REAL NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL DEFAULT '',
    "entityName" TEXT NOT NULL DEFAULT '',
    "detail" JSONB,
    "ip" TEXT NOT NULL DEFAULT '',
    "actor" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "LoginAudit_createdAt_idx" ON "LoginAudit"("createdAt");

-- CreateIndex
CREATE INDEX "Account_providerId_idx" ON "Account"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_id_key" ON "Account"("providerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRoute_model_key" ON "ModelRoute"("model");

-- CreateIndex
CREATE INDEX "RouteCandidate_routeId_idx" ON "RouteCandidate"("routeId");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualKey_keyValue_key" ON "VirtualKey"("keyValue");

-- CreateIndex
CREATE INDEX "CheckinLog_createdAt_idx" ON "CheckinLog"("createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_createdAt_idx" ON "RequestLog"("createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_model_idx" ON "RequestLog"("model");

-- CreateIndex
CREATE INDEX "RequestLog_providerId_idx" ON "RequestLog"("providerId");

-- CreateIndex
CREATE INDEX "RequestLog_apiKeyName_createdAt_idx" ON "RequestLog"("apiKeyName", "createdAt");

-- CreateIndex
CREATE INDEX "RequestLog_accountId_createdAt_idx" ON "RequestLog"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_startedAt_idx" ON "JobRun"("startedAt");

-- CreateIndex
CREATE INDEX "UsageDaily_day_idx" ON "UsageDaily"("day");

-- CreateIndex
CREATE UNIQUE INDEX "UsageDaily_day_providerId_apiKeyName_model_key" ON "UsageDaily"("day", "providerId", "apiKeyName", "model");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_day_idx" ON "BalanceSnapshot"("day");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_providerId_accountId_idx" ON "BalanceSnapshot"("providerId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceSnapshot_day_providerId_accountId_key" ON "BalanceSnapshot"("day", "providerId", "accountId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_action_idx" ON "AuditLog"("entity", "action");

