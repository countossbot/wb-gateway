// GET /api/console/accounts/export —— 账号导出（完整 / 脱敏两模式）。
// 完整导出：含凭据，可再次导入形成闭环（前端需二次确认）。
// 脱敏导出：凭据置空 + redacted: true 标记，用于分享；系统导入时识别该标记并拒绝。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";

export const dynamic = "force-dynamic";

const SECRET_FIELDS = ["accessToken", "refreshToken", "apiKey", "token", "cookie", "jwtToken"];

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const mode = request.nextUrl.searchParams.get("mode") === "redacted" ? "redacted" : "full";
  const providerId = request.nextUrl.searchParams.get("providerId"); // 可选：仅导出某提供商

  const providers = await db.provider.findMany({
    where: providerId ? { id: providerId } : undefined,
    orderBy: { sortOrder: "asc" },
  });
  const accounts = await db.account.findMany({
    where: providerId ? { providerId } : undefined,
  });

  const exportProviders = providers.map((p) => {
    const config = { ...(p.config as Record<string, unknown>) };
    if (mode === "redacted") {
      for (const field of SECRET_FIELDS) {
        if (config[field]) config[field] = null;
      }
    }
    const providerAccounts = accounts
      .filter((a) => a.providerId === p.id)
      .map((a) => {
        const credentials = { ...(a.credentials as Record<string, unknown>) };
        if (mode === "redacted") {
          for (const field of SECRET_FIELDS) {
            if (credentials[field]) credentials[field] = null;
          }
        }
        return {
          id: a.id,
          name: a.name,
          enabled: a.enabled,
          credentials,
        };
      });
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      enabled: p.enabled,
      config,
      accounts: providerAccounts,
    };
  });

  const payload = {
    format: "uag-export-v1",
    exportedAt: new Date().toISOString(),
    redacted: mode === "redacted",
    // 脱敏导出说明：凭据已被移除，仅用于结构参考/分享；系统将拒绝作为导入源。
    notice:
      mode === "redacted"
        ? "此为脱敏导出（凭据已移除），仅用于分享与结构参考，无法作为导入源。"
        : "完整导出（含凭据）。请妥善保管；可通过「账号导入」再次导入恢复。",
    providers: exportProviders,
  };

  const filename = `uag-accounts-${mode}-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// HEAD 用于前端预检（返回导出条数；完整导出前的二次确认弹窗展示）
export async function HEAD(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const count = await db.account.count();
  return new Response(null, {
    status: 200,
    headers: { "X-Accounts-Count": String(count) },
  });
}

export async function POST() {
  return fail("请使用 GET 方式导出", 405);
}
