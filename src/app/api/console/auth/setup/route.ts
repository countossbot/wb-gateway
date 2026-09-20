// POST /api/console/auth/setup —— 初始化引导：设置管理员密码并引导配置首个上游提供商。
//
// 防抢占（验收要求五.7）：仅当「尚无管理员账号」且「请求来自本机（127.0.0.1）」时可用，
// 未授权者无法远程抢先初始化。完成后返回一次性生成的 Master Key 与默认客户端密钥
// （拒绝硬编码兜底：密钥一律强随机生成）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  isLocalRequest,
  clientIp,
  auditLogin,
} from "@/lib/gateway/session/session";
import { ensureSystemSecrets } from "@/lib/gateway/config/configService";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

interface SetupBody {
  username?: string;
  password?: string;
  provider?: {
    id?: string;
    name?: string;
    type?: string;
    baseUrl?: string;
    // 各类型凭据字段
    userId?: string;
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
    token?: string;
    cookie?: string;
    region?: string;
  };
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  // 防抢占：无管理员 + 本机请求，二者缺一不可
  const adminCount = await db.adminUser.count();
  if (adminCount > 0) {
    await auditLogin(ip, request.headers.get("user-agent") || "", false, "setup rejected: admin already exists");
    return Response.json(
      { ok: false, error: "系统已初始化，请直接登录。如需重置请查阅 README 的恢复流程。" },
      { status: 409 }
    );
  }
  if (!isLocalRequest(request)) {
    await auditLogin(ip, request.headers.get("user-agent") || "", false, "setup rejected: non-local origin");
    return Response.json(
      { ok: false, error: "初始化仅允许来自本机（127.0.0.1）的请求，远程访问无法抢先初始化。" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as SetupBody;
  const username = (body.username || "admin").trim().slice(0, 64);
  const password = body.password || "";
  if (password.length < 8) {
    return Response.json({ ok: false, error: "管理员密码至少 8 位" }, { status: 400 });
  }

  // 创建管理员（scrypt 强哈希，禁止明文或普通哈希）
  const passwordHash = await hashPassword(password);
  await db.adminUser.create({ data: { username, passwordHash } });

  // 生成系统密钥（强随机；拒绝硬编码兜底）
  const { master_key, cron_secret } = await ensureSystemSecrets();

  // 引导配置的首个上游提供商（可选；也可跳过后在控制台配置）
  let createdProvider: string | null = null;
  const p = body.provider;
  if (p && p.type && (p.apiKey || p.accessToken || p.token || p.cookie)) {
    const providerId = (p.id || `provider-${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9_-]/g, "");
    const credentials: Record<string, unknown> = {};
    const config: Record<string, unknown> = {};
    if (p.type === "workbuddy") {
      config.region = p.region === "intl" ? "intl" : "cn";
      credentials.userId = p.userId || "";
      credentials.accessToken = p.accessToken || "";
      credentials.refreshToken = p.refreshToken || "";
    } else if (p.type === "qwenweb") {
      config.baseUrl = p.baseUrl || "https://chat.qwen.ai";
      credentials.token = p.token || "";
      credentials.cookie = p.cookie || "";
    } else {
      // openai / anthropic / opencode
      config.baseUrl = p.baseUrl || "";
      if (p.apiKey) credentials.apiKey = p.apiKey;
    }
    await db.provider.create({
      data: {
        id: providerId,
        name: p.name || providerId,
        type: p.type,
        enabled: true,
        sortOrder: 0,
        config: config as never,
      },
    });
    await db.account.create({
      data: {
        id: "primary",
        providerId: providerId,
        name: "主账号",
        enabled: true,
        credentials: credentials as never,
      },
    });
    createdProvider = providerId;
  }

  // 生成默认客户端虚拟密钥（Claude Code / CC-Switch 接入用）
  const clientKey = "sk-uag-" + randomBytes(20).toString("base64url");
  await db.virtualKey.create({
    data: {
      name: "Default Client Key (Claude Code / CC-Switch)",
      keyValue: clientKey,
      keyPrefix: clientKey.slice(0, 6),
      enabled: true,
      models: ["*"] as never,
      role: "client",
      remark: "初始化时自动生成",
    },
  });
  await db.systemSetting.upsert({
    where: { key: "config_version" },
    create: { key: "config_version", value: 1 as never },
    update: { value: 1 as never },
  });

  await auditLogin(ip, request.headers.get("user-agent") || "", true, "setup completed");

  return Response.json({
    ok: true,
    data: {
      message: "初始化完成",
      master_key: master_key,
      cron_secret: cron_secret,
      client_key: clientKey,
      createdProvider,
    },
  });
}
