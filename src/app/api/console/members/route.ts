// /api/console/members —— 轻量多成员管理 API（v4.9.0）
// 权限：GET -> member.read（仅 ADMIN，因 VIEWER 无此权限）；POST/PUT/action -> member.write（仅 ADMIN）。
// 合并式路由减少动态段；POST=创建，PUT=编辑，POST /action=enable/disable/reset-password。
// 审计：全部操作记录操作者（SessionPrincipal.userId + username）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { hashPassword } from "@/lib/gateway/session/session";
import { auditCreate, auditUpdate, auditDelete } from "@/lib/gateway/console/auditService";

export const dynamic = "force-dynamic";

const VALID_ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;
type ValidRole = (typeof VALID_ROLES)[number];

function isValidRole(role: unknown): role is ValidRole {
  return typeof role === "string" && (VALID_ROLES as readonly string[]).includes(role);
}

// GET —— 成员列表（member.read = 仅 ADMIN）
export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "member.read");
  if (session instanceof Response) return session;

  const users = await db.adminUser.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      enabled: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  // 会话计数（轻量：group by userId）
  const sessionCounts = await db.session.groupBy({
    by: ["userId"],
    _count: { id: true },
  });
  const sessionMap = new Map(sessionCounts.map((s) => [s.userId, s._count.id]));

  return ok({
    members: users.map((u) => ({
      ...u,
      sessionCount: sessionMap.get(u.id) || 0,
    })),
    currentUser: {
      id: session.userId,
      username: (await db.adminUser.findUnique({ where: { id: session.userId } }))?.username || "",
      role: session.role,
    },
  });
}

// POST —— 新增成员（member.write = 仅 ADMIN）
export async function POST(request: NextRequest) {
  const session = await requirePermission(request, "member.write");
  if (session instanceof Response) return session;

  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    displayName?: string;
    role?: string;
    password?: string;
  };
  const username = (body.username || "").trim();
  const displayName = (body.displayName || "").trim() || null;
  const role = body.role || "";
  const password = body.password || "";

  if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
    return fail("用户名必须为 1-64 位字母数字或 -_");
  }
  if (password.length < 8) {
    return fail("初始密码至少 8 位");
  }
  if (!isValidRole(role)) {
    return fail(`角色无效，只允许 ${VALID_ROLES.join(" / ")}`);
  }

  const exists = await db.adminUser.findUnique({ where: { username } });
  if (exists) return fail(`用户名 "${username}" 已存在`, 409);

  const passwordHash = await hashPassword(password);
  // enabled 必须显式写入：schema 默认值在「已有库增量迁移」场景下不生效
  // （ALTER TABLE ADD COLUMN 的默认值只作用于既有行，新建库由 init.sql 建表带默认值）。
  // 显式写入使两种路径行为一致，避免成员落库为 enabled=false 而无法登录。
  const user = await db.adminUser.create({
    data: { username, displayName, role, passwordHash, enabled: true },
  });

  const actor = await db.adminUser.findUnique({ where: { id: session.userId } });
  await auditCreate("member", user.id, user.username, { role, displayName }, request);

  return ok({
    id: user.id,
    username: user.username,
    role: user.role,
  });
}

// PUT —— 编辑成员（displayName / role / enabled）
export async function PUT(request: NextRequest) {
  const session = await requirePermission(request, "member.write");
  if (session instanceof Response) return session;

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    displayName?: string | null;
    role?: string;
    enabled?: boolean;
  };
  if (!body.id) return fail("缺少成员 id");
  const user = await db.adminUser.findUnique({ where: { id: body.id } });
  if (!user) return fail("成员不存在", 404);

  const patch: Record<string, unknown> = {};
  if (body.displayName !== undefined) {
    patch.displayName = (body.displayName || "").trim() || null;
  }
  if (body.role !== undefined) {
    if (!isValidRole(body.role)) {
      return fail(`角色无效，只允许 ${VALID_ROLES.join(" / ")}`);
    }
    patch.role = body.role;
  }
  if (body.enabled !== undefined) {
    patch.enabled = !!body.enabled;
  }

  // 保护规则：不能禁用自己；不能降级/禁用最后一个启用的 ADMIN
  if (body.id === session.userId && patch.enabled === false) {
    return fail("不能禁用自己");
  }
  const activeAdminCount = await db.adminUser.count({ where: { role: "ADMIN", enabled: true } });
  if (
    activeAdminCount <= 1 &&
    user.role === "ADMIN" &&
    user.enabled &&
    ((patch.role !== undefined && patch.role !== "ADMIN") || patch.enabled === false)
  ) {
    return fail("不能移除最后一个启用的管理员");
  }

  const updated = await db.adminUser.update({
    where: { id: body.id },
    data: patch,
  });

  // 禁用成员 → 立即失效其全部会话 + 禁用其名下虚拟密钥
  if (patch.enabled === false) {
    await db.session.deleteMany({ where: { userId: body.id } });
    await db.virtualKey.updateMany({
      where: { ownerUserId: body.id, enabled: true },
      data: { enabled: false },
    });
  }

  const actor = await db.adminUser.findUnique({ where: { id: session.userId } });
  await auditUpdate("member", user.id, user.username, { ...patch, actor: actor?.username || session.name }, request);

  return ok({ id: updated.id, role: updated.role, enabled: updated.enabled });
}

// POST /api/console/members/action —— 子操作（enable / disable / reset-password）
export async function PATCH(request: NextRequest) {
  const session = await requirePermission(request, "member.write");
  if (session instanceof Response) return session;

  const body = (await request.json().catch(() => ({}))) as {
    action?: "enable" | "disable" | "reset-password";
    id?: string;
    newPassword?: string;
  };
  if (!body.action || !body.id) return fail("缺少 action 或 id");
  const user = await db.adminUser.findUnique({ where: { id: body.id } });
  if (!user) return fail("成员不存在", 404);

  const actor = await db.adminUser.findUnique({ where: { id: session.userId } });
  const actorName = actor?.username || session.name;

  if (body.action === "enable") {
    await db.adminUser.update({ where: { id: body.id }, data: { enabled: true } });
    await auditUpdate("member", user.id, user.username, { enabled: true, actor: actorName }, request);
    return ok({ id: user.id, enabled: true });
  }

  if (body.action === "disable") {
    if (body.id === session.userId) return fail("不能禁用自己");
    const activeAdminCount = await db.adminUser.count({ where: { role: "ADMIN", enabled: true } });
    if (activeAdminCount <= 1 && user.role === "ADMIN" && user.enabled) {
      return fail("不能移除最后一个启用的管理员");
    }
    await db.adminUser.update({ where: { id: body.id }, data: { enabled: false } });
    await db.session.deleteMany({ where: { userId: body.id } });
    await db.virtualKey.updateMany({
      where: { ownerUserId: body.id, enabled: true },
      data: { enabled: false },
    });
    await auditUpdate("member", user.id, user.username, { enabled: false, actor: actorName, keysDisabled: true }, request);
    return ok({ id: user.id, enabled: false });
  }

  if (body.action === "reset-password") {
    // 生成 12 位随机密码（大小写+数字，够 8 位最低要求）
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let newPassword = "";
    for (let i = 0; i < 12; i++) {
      newPassword += chars[Math.floor(Math.random() * chars.length)];
    }
    const passwordHash = await hashPassword(newPassword);
    await db.adminUser.update({ where: { id: body.id }, data: { passwordHash } });
    await db.session.deleteMany({ where: { userId: body.id } });
    await auditUpdate("member", user.id, user.username, { action: "reset-password", actor: actorName }, request);
    return ok({ id: user.id, newPassword });
  }

  return fail("未知 action");
}

// DELETE —— 删除成员（仅 ADMIN，且不删除最后一个启用 ADMIN）
export async function DELETE(request: NextRequest) {
  const session = await requirePermission(request, "member.write");
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return fail("缺少 id 参数");
  if (id === session.userId) return fail("不能删除自己");

  const user = await db.adminUser.findUnique({ where: { id } });
  if (!user) return fail("成员不存在", 404);

  const activeAdminCount = await db.adminUser.count({ where: { role: "ADMIN", enabled: true } });
  if (activeAdminCount <= 1 && user.role === "ADMIN" && user.enabled) {
    return fail("不能删除最后一个启用的管理员");
  }

  await db.session.deleteMany({ where: { userId: id } });
  await db.adminUser.delete({ where: { id } });
  await auditDelete("member", user.id, user.username, { deletedBy: session.name }, request);

  return ok({ deleted: user.id });
}
