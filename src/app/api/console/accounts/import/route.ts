// POST /api/console/accounts/import —— 账号批量导入（粘贴文本 / 上传文件统一为 text 载荷）。
//
// 能力（验收要求三.4）：
//   - JSON 为主（uag-export-v1 完整导出格式 或 原项目 providers 数组），支持 CSV（workbuddy 凭据四列）
//   - v3.0.9：原生识别 WorkBuddy 账号切换器（wb-switch-accounts）导出格式 —— 自动按域名分组为
//     CN（*.cn → workbuddy，region cn）/ INTL（*.ai → workbuddy-intl，region intl）两个提供商
//   - 导入前逐行校验；导入后返回成功、跳过、失败数量与逐行原因
//   - 冲突策略可选：skip（跳过）/ overwrite（覆盖）/ newid（生成新 ID 追加）
//   - 脱敏导出（redacted: true）被系统识别并拒绝作为导入源
//   - 完整导出 → 再导入形成闭环
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { supportedProviderTypes } from "@/lib/gateway/providers";
import { invalidateConfigChanged } from "@/lib/gateway/config/configService";

export const dynamic = "force-dynamic";

interface ImportAccount {
  id: string;
  name: string;
  enabled: boolean;
  credentials: Record<string, unknown>;
}

interface ImportProvider {
  id: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  accounts?: Array<{
    id?: string;
    name?: string;
    enabled?: boolean;
    credentials?: Record<string, unknown>;
    // 兼容原项目内联凭据形态
    userId?: string;
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
    token?: string;
    cookie?: string;
  }>;
  // 兼容原项目单账号内联形态
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
}

interface LineResult {
  index: number;
  status: "success" | "skipped" | "failed";
  providerId?: string;
  accountId?: string;
  reason?: string;
}

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const body = (await request.json().catch(() => ({}))) as {
    text?: string;
    conflict?: "skip" | "overwrite" | "newid";
    targetProviderId?: string; // CSV 导入时的目标提供商
  };
  const text = (body.text || "").trim();
  const conflict = ["skip", "overwrite", "newid"].includes(body.conflict || "") ? body.conflict! : "skip";
  if (!text) return fail("导入内容为空");

  // ---- 格式识别：JSON（对象或数组）或 CSV ----
  let providersToImport: ImportProvider[] = [];
  let detectedFormat = "json";
  let redacted = false;
  // wb-switch 导出中无法归组的账号（非 *.cn / *.ai 域）：以失败行透明呈现，不精猜测归属
  let unknownDomainAccounts: Array<{ nickname?: string; uid?: string; domain?: string }> = [];

  if (text.startsWith("{") || text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return fail(`JSON 解析失败：${(e as Error).message}`);
    }
    if (Array.isArray(parsed)) {
      // v3.0.9：wb-switch-accounts 导出格式探测（数组每项均有 access_token + domain + uid）。
      // 实测 2026-09-18：该格式 refresh token 可被网关续签协议复活（X-Refresh-Token 头），
      // 即使工具内标记 needs_relogin 也可导入后由 /admin/api/refresh 或 401 无感续签自动换新。
      const arr = parsed as Array<Record<string, unknown>>;
      const isWbSwitch =
        arr.length > 0 &&
        arr.every(
          (x) =>
            !!x &&
            typeof x.access_token === "string" &&
            typeof x.domain === "string" &&
            typeof x.uid === "string" &&
            (typeof x.refresh_token === "string" || x.refresh_token === undefined)
        );
      if (isWbSwitch) {
        const grouped = wbSwitchToProviders(arr);
        providersToImport = grouped.providers;
        unknownDomainAccounts = grouped.unknownDomainAccounts;
        detectedFormat = "wb-switch-accounts";
      } else {
        providersToImport = parsed as ImportProvider[];
      }
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (obj.redacted === true) {
        // 脱敏导出识别：明确拒绝作为导入源（验收要求三.4）
        return fail(
          "检测到这是「脱敏导出」文件（凭据已被移除），无法作为导入源。请使用完整导出的文件导入。",
          400
        );
      }
      if (Array.isArray(obj.providers)) {
        providersToImport = obj.providers as ImportProvider[];
      } else if (Array.isArray(obj.accounts) && typeof obj.id === "string") {
        providersToImport = [obj as unknown as ImportProvider];
      } else {
        return fail("JSON 结构无法识别：需要 uag-export-v1 导出格式或 providers 数组");
      }
      redacted = obj.redacted === true;
    }
  } else {
    // CSV：列序 name,userId,accessToken,refreshToken（首行可为表头）
    detectedFormat = "csv";
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return fail("CSV 内容为空");
    const targetProviderId = body.targetProviderId;
    if (!targetProviderId) {
      return fail("CSV 导入需要指定目标提供商（targetProviderId）");
    }
    const provider = await db.provider.findUnique({ where: { id: targetProviderId } });
    if (!provider) return fail(`目标提供商 "${targetProviderId}" 不存在`);
    const start = lines[0].toLowerCase().startsWith("name") || lines[0].includes("userId") ? 1 : 0;
    providersToImport = [
      {
        id: targetProviderId,
        type: provider.type,
        name: provider.name,
        accounts: lines.slice(start).map((line, i) => {
          const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
          return {
            id: `csv-${Date.now().toString(36)}-${i}`,
            name: cols[0] || `CSV 账号 ${i + 1}`,
            credentials: {
              userId: cols[1] || "",
              accessToken: cols[2] || "",
              refreshToken: cols[3] || "",
            },
          };
        }),
      },
    ];
  }
  void redacted;

  // ---- 逐行校验与导入 ----
  const results: LineResult[] = [];
  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let pi = 0; pi < providersToImport.length; pi++) {
    const p = providersToImport[pi];
    if (!p || typeof p !== "object" || !p.id) {
      results.push({ index: pi, status: "failed", reason: "条目缺少 provider id" });
      failedCount++;
      continue;
    }
    // 提供商存在性：不存在则连同创建（类型必须合法）
    let provider = await db.provider.findUnique({ where: { id: p.id } });
    let providerCreated = false;
    if (!provider) {
      const type = p.type || "openai";
      if (!supportedProviderTypes().includes(type)) {
        results.push({ index: pi, status: "failed", providerId: p.id, reason: `未知提供商类型 "${type}"（支持 ${supportedProviderTypes().join(", ")}）` });
        failedCount++;
        continue;
      }
      const maxOrder = await db.provider.aggregate({ _max: { sortOrder: true } });
      provider = await db.provider.create({
        data: {
          id: p.id,
          name: p.name || p.id,
          type,
          enabled: p.enabled !== false,
          sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
          config: (p.config || {}) as never,
        },
      });
      providerCreated = true;
      results.push({ index: pi, status: "success", providerId: p.id, reason: `新建提供商 "${p.id}"（类型 ${type}）` });
      successCount++;
    }

    // 账号归一：accounts 数组或单账号内联形态
    let accountList: Array<NonNullable<ImportProvider["accounts"]>[number]> = [];
    if (Array.isArray(p.accounts) && p.accounts.length > 0) {
      accountList = p.accounts;
    } else if (p.userId || p.accessToken) {
      accountList = [
        {
          id: "primary",
          name: "主账号",
          userId: p.userId,
          accessToken: p.accessToken,
          refreshToken: p.refreshToken,
        },
      ];
    }

    for (let ai = 0; ai < accountList.length; ai++) {
      const acc = accountList[ai];
      const lineIndex = results.length;
      const accId = acc.id || `import-${Date.now().toString(36)}-${pi}-${ai}`;
      // 逐行校验：账号必须有 id 与至少一个凭据字段
      const creds: Record<string, unknown> = {
        ...((acc.credentials as Record<string, unknown>) || {}),
        ...(acc.userId !== undefined ? { userId: acc.userId } : {}),
        ...(acc.accessToken !== undefined ? { accessToken: acc.accessToken } : {}),
        ...(acc.refreshToken !== undefined ? { refreshToken: acc.refreshToken } : {}),
        ...(acc.apiKey !== undefined ? { apiKey: acc.apiKey } : {}),
        ...(acc.token !== undefined ? { token: acc.token } : {}),
        ...(acc.cookie !== undefined ? { cookie: acc.cookie } : {}),
      };
      const hasCredential = ["userId", "accessToken", "refreshToken", "apiKey", "token", "cookie"].some(
        (f) => creds[f]
      );
      if (!hasCredential) {
        results.push({ index: lineIndex, status: "failed", providerId: p.id, accountId: accId, reason: "账号无任何凭据字段（脱敏数据？）" });
        failedCount++;
        continue;
      }

      const existing = await db.account.findUnique({
        where: { providerId_id: { providerId: p.id, id: accId } },
      });
      if (existing) {
        if (conflict === "skip") {
          results.push({ index: lineIndex, status: "skipped", providerId: p.id, accountId: accId, reason: "账号已存在（冲突策略：跳过）" });
          skippedCount++;
          continue;
        }
        if (conflict === "newid") {
          const newId = `${accId}-${Date.now().toString(36)}`;
          await db.account.create({
            data: {
              id: newId,
              providerId: p.id,
              name: acc.name || newId,
              enabled: acc.enabled !== false,
              credentials: creds as never,
            },
          });
          results.push({ index: lineIndex, status: "success", providerId: p.id, accountId: newId, reason: `已存在，按新 ID 追加为 "${newId}"` });
          successCount++;
          continue;
        }
        // overwrite：凭据合并语义（导入的空字段不抹掉已有值 —— 与保存回填契约一致）
        const merged = { ...(existing.credentials as Record<string, unknown>) };
        for (const [k, v] of Object.entries(creds)) {
          if (v !== null && v !== undefined && v !== "") merged[k] = v;
        }
        await db.account.update({
          where: { providerId_id: { providerId: p.id, id: accId } },
          data: {
            name: acc.name || existing.name,
            enabled: acc.enabled !== undefined ? acc.enabled !== false : existing.enabled,
            credentials: merged as never,
          },
        });
        results.push({ index: lineIndex, status: "success", providerId: p.id, accountId: accId, reason: "已存在，覆盖更新（空字段保留原值）" });
        successCount++;
        continue;
      }

      await db.account.create({
        data: {
          id: accId,
          providerId: p.id,
          name: acc.name || accId,
          enabled: acc.enabled !== false,
          credentials: creds as never,
        },
      });
      results.push({ index: lineIndex, status: "success", providerId: p.id, accountId: accId });
      successCount++;
    }
    void providerCreated;
  }

  await invalidateConfigChanged();
  // 未知域名账号计入失败行（透明拒收，不猜测 region 归属）
  for (const u of unknownDomainAccounts) {
    results.push({
      index: results.length,
      status: "failed",
      reason: `域名 "${u.domain}" 无法归组（仅支持 *.cn → CN / *.ai → INTL），请人工确认后单独导入`,
    });
    failedCount++;
  }
  return ok({
    success: successCount,
    skipped: skippedCount,
    failed: failedCount,
    details: results,
    ...(detectedFormat === "wb-switch-accounts"
      ? {
          format: "wb-switch-accounts",
          formatNote:
            "已识别 WorkBuddy 账号切换器导出并按域名自动分组（*.cn → workbuddy CN / *.ai → workbuddy-intl INTL）。注意：导入后网关会在续签时轮换 refresh token，此源文件的旧 token 随之失效，请勿再次覆盖导入。",
        }
      : {}),
  });
}

// wb-switch-accounts 数组 → 网关 providers 载荷（CN / INTL 双分组）。
// 域名分组依据（实测 2026-09-18）：
//   - *.cn（www.workbuddy.cn / www.codebuddy.cn）→ copilot.tencent.com 端点（region cn）
//   - *.ai（www.workbuddy.ai / www.codebuddy.ai）→ www.codebuddy.ai 端点（region intl，两域同 realm）
function wbSwitchToProviders(arr: Array<Record<string, unknown>>): {
  providers: ImportProvider[];
  unknownDomainAccounts: Array<{ nickname?: string; uid?: string; domain?: string }>;
} {
  interface WbAcc {
    access_token: string;
    refresh_token?: string;
    domain: string;
    nickname?: string;
    uid: string;
    profile_raw?: { preferred_username?: string; nickname?: string };
  }
  const accounts = arr as unknown as WbAcc[];
  const slug = (a: WbAcc): string => {
    const name = a.profile_raw?.preferred_username || a.nickname || a.uid;
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s.slice(0, 32) || a.uid.slice(0, 8);
  };
  const toAcc = (a: WbAcc) => ({
    id: slug(a),
    name: `${a.nickname || a.uid}（${a.domain}）`,
    userId: a.uid,
    accessToken: a.access_token,
    refreshToken: a.refresh_token || "",
  });
  const cn = accounts.filter((a) => a.domain.endsWith(".cn"));
  const intl = accounts.filter((a) => a.domain.endsWith(".ai"));
  const unknown = accounts.filter((a) => !a.domain.endsWith(".cn") && !a.domain.endsWith(".ai"));
  const providers: ImportProvider[] = [];
  if (cn.length > 0) {
    providers.push({
      id: "workbuddy",
      type: "workbuddy",
      name: "WorkBuddy 腾讯代码助手（CN）",
      config: { region: "cn" },
      accounts: cn.map(toAcc),
    });
  }
  if (intl.length > 0) {
    providers.push({
      id: "workbuddy-intl",
      type: "workbuddy",
      name: "WorkBuddy 国际站（INTL）",
      config: { region: "intl" },
      accounts: intl.map(toAcc),
    });
  }
  return { providers, unknownDomainAccounts: unknown };
}
