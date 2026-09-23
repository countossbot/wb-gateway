// 控制台操作审计服务（v3.2.0）—— Task 17「路由全删」生产事故的防御闭环。
//
// 设计原则：
// 1. 绝不影响主流程：写入失败只 console.error，不向调用方抛错；
// 2. 删除操作落完整快照（凭据脱敏）：审计追溯 + 结构恢复参考（凭据需人工重录）；
// 3. 凭据字段（SECRET_FIELDS）递归脱敏，审计表可被设置页展示而不泄露密钥。
import { db } from "@/lib/db";
import { SECRET_FIELDS } from "./consoleHelpers";

export type AuditAction = "delete" | "create" | "update" | "toggle" | "regenerate" | "restore";
export type AuditEntity = "provider" | "account" | "route" | "key" | "setting" | "system";

export interface AuditInput {
  action: AuditAction;
  entity: AuditEntity;
  entityId?: string | number | null;
  entityName?: string | null;
  detail?: unknown;
  actor?: string;
}

// 提取客户端 IP（网关/Caddy 转发场景优先 x-forwarded-for 首段）
export function extractIp(request: Request): string {
  const h = request.headers;
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64);
  return (h.get("x-real-ip") || "").slice(0, 64);
}

// 递归脱敏：SECRET_FIELDS 命中的字符串值替换为掩码提示（保留长度信息便于审计）
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[深度截断]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELDS.includes(k) && typeof v === "string" && v) {
        out[k] = `<脱敏，共 ${v.length} 位>`;
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// 系统设置审计摘要：代理地址中的 user:pass@ 段脱敏（其余键值原样）
export function sanitizeAuditValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === "proxy" && v && typeof v === "object") {
      const p = { ...(v as Record<string, unknown>) };
      if (typeof p.list === "string") {
        p.list = p.list.replace(/(\/\/)([^@\s/]+)@/g, "$1<已脱敏>@");
      }
      out[k] = p;
    } else if (SECRET_FIELDS.includes(k) && typeof v === "string" && v) {
      out[k] = `<脱敏，共 ${v.length} 位>`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 写审计记录（绝不抛错）。request 可选（后台任务触发的操作无 request）。
export async function recordAudit(input: AuditInput, request?: Request): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: input.action,
        entity: input.entity,
        entityId: input.entityId != null ? String(input.entityId) : "",
        entityName: input.entityName || "",
        detail: (sanitize(input.detail) ?? null) as never,
        ip: request ? extractIp(request) : "",
        actor: input.actor || "admin",
      },
    });
  } catch (e) {
    console.error("[audit] 写入审计日志失败（不影响主流程）:", e instanceof Error ? e.message : e);
  }
}

// 便捷封装：删除操作埋点（删除成功后调用，detail 传删除前快照）
export function auditDelete(
  entity: AuditEntity,
  entityId: string | number | null,
  entityName: string,
  snapshot: unknown,
  request?: Request
): Promise<void> {
  return recordAudit({ action: "delete", entity, entityId, entityName, detail: snapshot }, request);
}

// 便捷封装：创建操作埋点（detail 传创建后的对象摘要）
export function auditCreate(
  entity: AuditEntity,
  entityId: string | number | null,
  entityName: string,
  detail: unknown,
  request?: Request
): Promise<void> {
  return recordAudit({ action: "create", entity, entityId, entityName, detail }, request);
}

// 便捷封装：更新/启停操作埋点
export function auditUpdate(
  entity: AuditEntity,
  entityId: string | number | null,
  entityName: string,
  detail: unknown,
  request?: Request
): Promise<void> {
  return recordAudit({ action: "update", entity, entityId, entityName, detail }, request);
}

// 便捷封装：启停切换操作埋点
export function auditToggle(
  entity: AuditEntity,
  entityId: string | number | null,
  entityName: string,
  enabled: boolean,
  request?: Request
): Promise<void> {
  return recordAudit({ action: "toggle", entity, entityId, entityName, detail: { enabled } }, request);
}

// 便捷封装：从审计快照恢复操作埋点（v3.2.3，detail 记录来源审计条目与恢复结果）
export function auditRestore(
  entity: AuditEntity,
  entityId: string | number | null,
  entityName: string,
  detail: unknown,
  request?: Request
): Promise<void> {
  return recordAudit({ action: "restore", entity, entityId, entityName, detail }, request);
}
