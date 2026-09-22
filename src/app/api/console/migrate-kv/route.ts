// POST /api/console/migrate-kv —— 原项目 Cloudflare KV 配置一次性迁移工具（验收要求六.8）。
//
// 输入：原 GATEWAY_CONFIG 键的 JSON 全文（wrangler kv key get GATEWAY_CONFIG 或控制台导出）。
// 行为：解析原格式（providers / routes / virtual_keys / config_version / master_key / cron_secret /
//       max_context_turns / usage_provider_id）→ 写入新的表结构 → 输出迁移报告。
// 安全：仅迁移，不删除任何已有数据；重复执行按「已存在 → 跳过」处理（幂等）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { invalidateConfigChanged } from "@/lib/gateway/config/configService";
import { supportedProviderTypes } from "@/lib/gateway/providers";

export const dynamic = "force-dynamic";

interface KVConfig {
  config_version?: number;
  master_key?: string;
  cron_secret?: string;
  max_context_turns?: number;
  usage_provider_id?: string;
  providers?: Array<{
    id: string;
    name?: string;
    type?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }>;
  routes?: Record<string, Array<{ provider: string; model: string }>>;
  virtual_keys?: Record<string, { name?: string; enabled?: boolean; models?: string[]; role?: string }>;
}

export async function POST(request: NextRequest) {
  const session = await requirePermission(request, "provider.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as { text?: string; mode?: "merge" | "replace" };
  const text = (body.text || "").trim();
  if (!text) return fail("请粘贴原 GATEWAY_CONFIG 的 JSON 全文");

  let kv: KVConfig;
  try {
    kv = JSON.parse(text) as KVConfig;
  } catch (e) {
    return fail(`JSON 解析失败：${(e as Error).message}`);
  }
  if (!kv.providers && !kv.routes && !kv.virtual_keys) {
    return fail("JSON 结构无法识别：未找到 providers / routes / virtual_keys 字段（需为原 GATEWAY_CONFIG 键值）");
  }

  const report: Array<{ section: string; action: string; detail: string }> = [];
  let createdProviders = 0;
  let createdAccounts = 0;
  let skippedProviders = 0;
  let createdRoutes = 0;
  let createdKeys = 0;
  let skippedKeys = 0;
  const warnings: string[] = [];

  // ---- providers + accounts ----
  const providers = Array.isArray(kv.providers) ? kv.providers : [];
  for (const p of providers) {
    if (!p?.id) {
      warnings.push(`跳过一个缺少 id 的 provider 条目`);
      continue;
    }
    const existing = await db.provider.findUnique({ where: { id: p.id } });
    if (existing) {
      skippedProviders++;
      report.push({ section: "provider", action: "skip", detail: `"${p.id}" 已存在（幂等跳过）` });
    } else {
      const type = p.type || "openai";
      if (!supportedProviderTypes().includes(type)) {
        warnings.push(`provider "${p.id}" 类型 "${type}" 不受支持，跳过`);
        continue;
      }
      const cfg = { ...(p.config || {}) };
      const accountsRaw = Array.isArray(cfg.accounts) ? (cfg.accounts as Array<Record<string, unknown>>) : [];
      delete cfg.accounts;
      const maxOrder = await db.provider.aggregate({ _max: { sortOrder: true } });
      await db.provider.create({
        data: {
          id: p.id,
          name: p.name || p.id,
          type,
          enabled: p.enabled !== false,
          sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
          config: cfg as never,
        },
      });
      createdProviders++;
      report.push({ section: "provider", action: "create", detail: `"${p.id}"（类型 ${type}，${p.enabled !== false ? "启用" : "停用"}）` });

      // 账号池（含内联凭据归一）
      for (const acc of accountsRaw) {
        const accId = (acc.id as string) || "primary";
        const { id, name, enabled, ...credentials } = acc;
        await db.account.create({
          data: {
            id: accId,
            providerId: p.id,
            name: (name as string) || accId,
            enabled: enabled !== false,
            credentials: credentials as never,
          },
        });
        createdAccounts++;
      }
      // 单账号内联形态（config.userId 三件套）
      if (accountsRaw.length === 0 && (cfg.userId || cfg.accessToken)) {
        await db.account.create({
          data: {
            id: "primary",
            providerId: p.id,
            name: "主账号",
            enabled: true,
            credentials: {
              userId: cfg.userId || "",
              accessToken: cfg.accessToken || "",
              refreshToken: cfg.refreshToken || "",
            } as never,
          },
        });
        createdAccounts++;
      }
    }
  }

  // ---- routes ----
  if (kv.routes && typeof kv.routes === "object") {
    for (const [model, routeList] of Object.entries(kv.routes)) {
      if (!Array.isArray(routeList) || routeList.length === 0) continue;
      // 引用检查：候选引用的 provider 必须已存在（与 backfillMissingRoutes 同一约束）
      const valid = routeList.every((r) => {
        void r;
        return true;
      });
      void valid;
      const existing = await db.modelRoute.findUnique({ where: { model } });
      if (existing) {
        report.push({ section: "route", action: "skip", detail: `"${model}" 已存在（幂等跳过）` });
        continue;
      }
      let createdCandidates = 0;
      const route = await db.modelRoute.create({ data: { model, enabled: true } });
      let order = 0;
      for (const rc of routeList) {
        const providerExists = await db.provider.findUnique({ where: { id: rc.provider } });
        if (!providerExists) {
          warnings.push(`路由 "${model}" 的候选引用不存在的 provider "${rc.provider}"，该候选被丢弃`);
          continue;
        }
        await db.routeCandidate.create({
          data: { routeId: route.id, providerId: rc.provider, model: rc.model, enabled: true, sortOrder: order++ },
        });
        createdCandidates++;
      }
      if (createdCandidates > 0) {
        createdRoutes++;
        report.push({ section: "route", action: "create", detail: `"${model}"（${createdCandidates} 个候选）` });
      } else {
        await db.modelRoute.delete({ where: { id: route.id } });
      }
    }
  }

  // ---- virtual_keys ----
  if (kv.virtual_keys && typeof kv.virtual_keys === "object") {
    for (const [key, entry] of Object.entries(kv.virtual_keys)) {
      const existing = await db.virtualKey.findUnique({ where: { keyValue: key } });
      if (existing) {
        skippedKeys++;
        report.push({ section: "virtual_key", action: "skip", detail: `密钥 ${key.slice(0, 6)}… 已存在` });
        continue;
      }
      await db.virtualKey.create({
        data: {
          name: entry?.name || "Migrated Key",
          keyValue: key,
          keyPrefix: key.slice(0, 6),
          enabled: entry?.enabled !== false,
          models: (entry?.models || ["*"]) as never,
          role: entry?.role || "client",
          remark: "KV 迁移导入",
        },
      });
      createdKeys++;
      report.push({ section: "virtual_key", action: "create", detail: `密钥 ${key.slice(0, 6)}…（${entry?.name || "未命名"}）` });
    }
  }

  // ---- 顶层设置 ----
  const topSettings: Array<[string, unknown]> = [];
  if (kv.master_key) topSettings.push(["master_key", kv.master_key]);
  if (kv.cron_secret) topSettings.push(["cron_secret", kv.cron_secret]);
  if (kv.max_context_turns !== undefined) topSettings.push(["max_context_turns", kv.max_context_turns]);
  if (kv.usage_provider_id) topSettings.push(["usage_provider_id", kv.usage_provider_id]);
  for (const [key, value] of topSettings) {
    const existing = await db.systemSetting.findUnique({ where: { key } });
    if (existing) {
      report.push({ section: "setting", action: "skip", detail: `${key} 已存在（保留现值）` });
      continue;
    }
    await db.systemSetting.create({ data: { key, value: value as never } });
    report.push({ section: "setting", action: "create", detail: key });
  }

  await invalidateConfigChanged();
  return ok({
    summary: {
      createdProviders,
      createdAccounts,
      skippedProviders,
      createdRoutes,
      createdKeys,
      skippedKeys,
      warnings,
    },
    report,
    message: `迁移完成：${createdProviders} 个提供商、${createdAccounts} 个账号、${createdRoutes} 条路由、${createdKeys} 把密钥${
      warnings.length > 0 ? `；${warnings.length} 条警告（见 warnings）` : ""
    }`,
  });
}
