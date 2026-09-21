// /api/console/settings —— 设置模块（全局代理 / CORS 白名单 / 监听范围 / 上下文轮数 / 日志级别等）。
// GET：聚合快照（密钥存在性布尔，不回明文）；PUT：更新（热生效）。
// 管理员密码修改走 /api/console/auth/password；数据备份走 /api/console/backup。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail, consoleSettingsSnapshot } from "@/lib/gateway/console/consoleHelpers";
import { saveRuntimeSettings } from "@/lib/gateway/config/runtimeSettings";
import { invalidateProxyDispatchers, parseProxyList } from "@/lib/gateway/proxy/proxyAgent";
import { recordAudit, sanitizeAuditValues } from "@/lib/gateway/console/auditService";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const snapshot = await consoleSettingsSnapshot();
  // 代理池脱敏展示（不含凭据）
  const proxy = snapshot.proxy as Record<string, unknown> | null;
  if (proxy && typeof proxy.list === "string") {
    const list = parseProxyList(proxy.list as string);
    snapshot.proxy = {
      ...proxy,
      list,
      poolSize: list.length,
    };
  }
  return ok(snapshot);
}

interface SettingsPayload {
  proxy?: {
    enabled?: boolean;
    list?: string;
    bypass?: string[];
  };
  corsAllowedOrigins?: string[];
  listenLan?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  maxContextTurns?: number;
  usageProviderId?: string;
  auditRetentionDays?: number;
  balanceRetentionDays?: number;
  // v4.2.0：SSE 流式保活与上游超时（热生效；超时变更后重建出站 dispatcher）
  streamStallMs?: number;
  upstreamHeadersTimeoutMs?: number;
  upstreamBodyTimeoutMs?: number;
  regenerateMasterKey?: boolean;
  regenerateCronSecret?: boolean;
}

export async function PUT(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as SettingsPayload;

  const updates: Record<string, unknown> = {};

  // 全局代理（热生效：写 DB + 失效 dispatcher 缓存，无需重启）
  if (body.proxy) {
    const current = (await consoleSettingsSnapshot()).proxy as Record<string, unknown> | null;
    const merged = {
      enabled: body.proxy.enabled ?? (current?.enabled ?? false),
      list: body.proxy.list ?? (current?.list ?? ""),
      bypass: body.proxy.bypass ?? (current?.bypass ?? []),
    };
    // 校验代理地址格式
    for (const addr of parseProxyList(merged.list as string)) {
      const okProtocol = /^(https?|socks5h?):\/\/.+/i.test(addr);
      if (!okProtocol) {
        return fail(`代理地址 "${addr}" 不合法（需 http:// / https:// / socks5:// / socks5h:// 开头，支持 user:pass@host:port）`);
      }
    }
    updates.proxy = merged;
    invalidateProxyDispatchers();
  }
  if (body.corsAllowedOrigins) {
    for (const o of body.corsAllowedOrigins) {
      if (o !== "*" && !/^https?:\/\/.+/.test(o)) {
        return fail(`CORS 白名单条目 "${o}" 不合法（需 http(s)://origin 或 *）`);
      }
    }
    updates.corsAllowedOrigins = body.corsAllowedOrigins;
  }
  if (body.listenLan !== undefined) updates.listenLan = body.listenLan;
  if (body.logLevel) updates.logLevel = body.logLevel;
  if (body.maxContextTurns !== undefined) {
    if (!Number.isFinite(body.maxContextTurns) || body.maxContextTurns < 0) {
      return fail("maxContextTurns 必须为 >= 0 的数字（0 = 不限）");
    }
    updates.maxContextTurns = Math.floor(body.maxContextTurns);
  }
  if (body.usageProviderId) {
    const provider = await db.provider.findUnique({ where: { id: body.usageProviderId } });
    if (!provider) return fail(`用量统计提供商 "${body.usageProviderId}" 不存在`);
    updates.usageProviderId = body.usageProviderId;
  }
  if (body.auditRetentionDays !== undefined) {
    const n = Math.floor(Number(body.auditRetentionDays));
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      return fail("auditRetentionDays 必须为 0~3650 的整数（0 = 永久保留）");
    }
    updates.auditRetentionDays = n;
  }
  if (body.balanceRetentionDays !== undefined) {
    const n = Math.floor(Number(body.balanceRetentionDays));
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      return fail("balanceRetentionDays 必须为 0~3650 的整数（0 = 永久保留）");
    }
    updates.balanceRetentionDays = n;
  }
  // ---- v4.2.0：SSE 流式保活与上游超时（范围与 runtimeSettings clampInt 一致） ----
  let timeoutsChanged = false;
  if (body.streamStallMs !== undefined) {
    const n = Math.floor(Number(body.streamStallMs));
    // 0 = 用默认 180s；有效范围 10s~900s
    if (!Number.isFinite(n) || (n !== 0 && (n < 10_000 || n > 900_000))) {
      return fail("停滞熔断阈值必须为 0（默认 180s）或 10000~900000 ms（10s~15min）");
    }
    updates.streamStallMs = n;
    timeoutsChanged = true;
  }
  if (body.upstreamHeadersTimeoutMs !== undefined) {
    const n = Math.floor(Number(body.upstreamHeadersTimeoutMs));
    if (!Number.isFinite(n) || n < 5_000 || n > 3_600_000) {
      return fail("响应头超时必须为 5000~3600000 ms（5s~1h）");
    }
    updates.upstreamHeadersTimeoutMs = n;
    timeoutsChanged = true;
  }
  if (body.upstreamBodyTimeoutMs !== undefined) {
    const n = Math.floor(Number(body.upstreamBodyTimeoutMs));
    if (!Number.isFinite(n) || n < 10_000 || n > 3_600_000) {
      return fail("body 字节间隔超时必须为 10000~3600000 ms（10s~1h）");
    }
    updates.upstreamBodyTimeoutMs = n;
    timeoutsChanged = true;
  }
  // 超时变更 → 重建出站 dispatcher（直连 Agent 与代理 Agent 均按新超时重建；close 优雅等待在途请求）
  if (timeoutsChanged) {
    invalidateProxyDispatchers();
  }

  await saveRuntimeSettings(updates);

  // 密钥再生成（强随机；旧密钥立即失效）
  const regenerated: string[] = [];
  if (body.regenerateMasterKey) {
    const masterKey = "uag-master_" + randomBytes(24).toString("base64url");
    await db.systemSetting.upsert({
      where: { key: "master_key" },
      create: { key: "master_key", value: masterKey as never },
      update: { value: masterKey as never },
    });
    regenerated.push(`master_key: ${masterKey}`);
    // v3.2.0：密钥再生成是高危操作，审计留痕（新密钥值本身不进审计）
    await recordAudit({ action: "regenerate", entity: "system", entityId: "master_key", entityName: "Master Key", detail: { note: "master_key 已再生成，旧密钥立即失效（新密钥值不进审计）" } }, request);
  }
  if (body.regenerateCronSecret) {
    const cronSecret = "uag-cron_" + randomBytes(24).toString("base64url");
    await db.systemSetting.upsert({
      where: { key: "cron_secret" },
      create: { key: "cron_secret", value: cronSecret as never },
      update: { value: cronSecret as never },
    });
    regenerated.push(`cron_secret: ${cronSecret}`);
    await recordAudit({ action: "regenerate", entity: "system", entityId: "cron_secret", entityName: "Cron Secret", detail: { note: "cron_secret 已再生成，旧密钥立即失效（新密钥值不进审计）" } }, request);
  }

  // v3.2.0：设置变更审计（仅记变更键名与脱敏摘要，不记代理凭据值）
  if (Object.keys(updates).length > 0) {
    await recordAudit({
      action: "update",
      entity: "setting",
      entityId: Object.keys(updates).join(","),
      entityName: "系统设置",
      detail: { keys: Object.keys(updates), values: sanitizeAuditValues(updates) },
    }, request);
  }

  return ok({
    updated: Object.keys(updates),
    regenerated,
    message: "设置已保存并热生效（代理 / CORS / 定时任务均无需重启）",
  });
}
