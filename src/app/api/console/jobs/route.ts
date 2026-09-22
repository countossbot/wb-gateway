// /api/console/jobs —— 定时任务（签到 & Token 保活）配置与执行记录。
// GET：当前配置 + 可签到提供商候选 + 最近执行结果（含逐账号明细）+ 最近 JobRun 历史；
// PUT：更新开关 / cron / 时区 / 签到提供商白名单（热生效，写 SystemSetting 后调度器下个 tick 重读）。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { saveRuntimeSettings, getRuntimeSettingsAsync } from "@/lib/gateway/config/runtimeSettings";
import { parseCron, checkinCapableProviderTypes } from "@/lib/gateway/jobs/scheduler";

export const dynamic = "force-dynamic";

// CheckinLog.result 为 Json 类型（persistCheckinLogs 存账号级对象 {id, name, success, result}），
// 直接透传会在前端被当作 React child 渲染导致崩溃。此函数把任意 Json 归一为人类可读字符串：
// ① {result: {code, msg}} → 提取业务消息（如 "今天已签到，请明天再来"）
// ② 自带 msg/message/error → 原文
// ③ 其它 → JSON.stringify 截断 160 字符。
export function checkinResultText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    try {
      const o = v as Record<string, unknown>;
      const inner = o.result;
      if (inner && typeof inner === "object") {
        const m = (inner as Record<string, unknown>).msg ?? (inner as Record<string, unknown>).message;
        if (typeof m === "string" && m) return m;
      }
      if (typeof inner === "string" && inner) return inner;
      const own = o.msg ?? o.message;
      if (typeof own === "string" && own) return own;
      if (typeof o.error === "string" && o.error) return o.error;
      const s = JSON.stringify(o);
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    } catch {
      return "[unprintable]";
    }
  }
  return String(v);
}

// v3.1.0：幂等成功判定（Task 16 遗留 #2）。
// 上游 10001 =「今天已签到」属幂等成功业务态（持久化层记 success=false，但业务上该账号今日已领积分）。
// v3.1.1：注意 10001 还有另一业务态「签到活动未开启或已过期」（INTL 站，无积分发放），
// 该态不是幂等成功 —— 已由 classifyCheckinResult 精确区分，本函数保留为兼容导出。
export function checkinIdempotentOk(v: unknown): boolean {
  return classifyCheckinResult(v) === "idempotent";
}

// v3.1.1：签到结果分类（Task 16 遗留 #3：失败原因分类徽标）。
// 实测数据形态：CheckinLog.result = {id,name,success,result:{code,msg}}（persistCheckinLogs 写入），
// 亦有 msg/message 直接在顶层或字符串形态的兼容写入源。
export type CheckinCategory = "idempotent" | "activity_inactive" | "credentials" | "network" | "failure";

export function classifyCheckinResult(v: unknown): CheckinCategory {
  let code: unknown;
  let msg = "";
  if (typeof v === "string") {
    msg = v;
  } else if (v && typeof v === "object") {
    try {
      const o = v as Record<string, unknown>;
      const inner = (o.result && typeof o.result === "object" ? o.result : o) as Record<string, unknown>;
      code = inner.code;
      const m = inner.msg ?? inner.message;
      if (typeof m === "string") msg = m;
      else if (typeof o.error === "string") msg = o.error;
    } catch {
      /* fallthrough */
    }
  }
  // 优先按 msg 语义区分（同 code 10001 两种业务态）
  if (/(未开启|已过期|活动未|活动已)/.test(msg)) return "activity_inactive";
  if (/已签到|已经签到|already.?checked|checked.?in.?today/i.test(msg)) return "idempotent";
  if (typeof code === "number" || typeof code === "string") {
    if (code === 10001 || code === "10001") return "idempotent"; // 无 msg 时的保守兑底
    if (/invalid_grant|token|unauthorized|401|403/i.test(String(code))) return "credentials";
  }
  if (/invalid_grant|token.*(失效|过期)|unauthorized|401|403/i.test(msg)) return "credentials";
  if (/timeout|ECONN|ENOTFOUND|network|fetch failed|超时/i.test(msg)) return "network";
  return "failure";
}

export async function GET(request: NextRequest) {
  const session = await requirePermission(request, "settings.read");
  if (session instanceof Response) return session;

  const settings = await getRuntimeSettingsAsync();
  const recentRuns = await db.jobRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  const recentCheckins = await db.checkinLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  // v4.1.0：可签到提供商候选（已启用且类型在签到能力集合内；供前端下拉选项）
  const candidates = await db.provider.findMany({
    where: { enabled: true, type: { in: checkinCapableProviderTypes() } },
    select: { id: true, name: true, type: true },
    orderBy: { sortOrder: "asc" },
  });

  return ok({
    config: {
      checkinEnabled: settings.checkinEnabled,
      checkinCron: settings.checkinCron,
      checkinTz: settings.checkinTz,
      checkinProviders: settings.checkinProviders,
      keepaliveEnabled: settings.keepaliveEnabled,
      keepaliveCron: settings.keepaliveCron,
      keepaliveTz: settings.keepaliveTz,
    },
    // v4.1.0：下拉候选（id/name/type）+ 前端判断某 provider 已不在候选里时仍可回显
    checkinCandidates: candidates,
    recentRuns: recentRuns.map((r) => ({
      job: r.job,
      triggered: r.triggered,
      success: r.success,
      detail: r.detail,
      startedAt: r.startedAt,
    })),
    // 最近一次签到的逐账号明细（result 归一为字符串，前端 CheckinDetailRow.result: string 名实相符）
    lastCheckinDetail: recentCheckins.slice(0, 10).map((c) => {
      const category = classifyCheckinResult(c.result);
      return {
        providerId: c.providerId,
        accountId: c.accountId,
        accountName: c.accountName,
        success: c.success,
        manual: c.manual,
        result: checkinResultText(c.result),
        createdAt: c.createdAt,
        // v3.1.0/v3.1.1：幂等成功（10001 已签到）灰徽标；活动未开启/凭据/网络分类徽标（Task 16 遗留 #3）
        idempotentOk: !c.success && category === "idempotent",
        category: !c.success ? category : null,
      };
    }),
  });
}

export async function PUT(request: NextRequest) {
  const session = await requirePermission(request, "settings.write");
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => ({}))) as {
    checkinEnabled?: boolean;
    checkinCron?: string;
    checkinTz?: string;
    checkinProviders?: string[];
    keepaliveEnabled?: boolean;
    keepaliveCron?: string;
    keepaliveTz?: string;
  };

  // 校验 cron 表达式与时区
  for (const [field, value] of [
    ["checkinCron", body.checkinCron],
    ["keepaliveCron", body.keepaliveCron],
  ] as const) {
    if (value !== undefined && !parseCron(value)) {
      return fail(`${field} 不是合法的 5 字段 cron 表达式（分 时 日 月 周，如 "0 9 * * *"）`);
    }
  }
  for (const [field, value] of [
    ["checkinTz", body.checkinTz],
    ["keepaliveTz", body.keepaliveTz],
  ] as const) {
    if (value !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
      } catch {
        return fail(`${field} 不是合法的 IANA 时区（如 Asia/Shanghai）`);
      }
    }
  }

  const updates: Record<string, unknown> = {};
  if (body.checkinEnabled !== undefined) updates.checkinEnabled = body.checkinEnabled;
  if (body.checkinCron !== undefined) updates.checkinCron = body.checkinCron;
  if (body.checkinTz !== undefined) updates.checkinTz = body.checkinTz;
  // v4.1.0：签到提供商白名单（空数组 = 全部）；逐项校验存在性，防止手调 API 写入幽灵 ID
  if (body.checkinProviders !== undefined) {
    if (!Array.isArray(body.checkinProviders)) {
      return fail("checkinProviders 必须是字符串数组（空数组 = 全部支持签到的提供商）");
    }
    const ids = body.checkinProviders.filter((x) => typeof x === "string" && !!x);
    for (const id of ids) {
      const p = await db.provider.findUnique({ where: { id } });
      if (!p) return fail(`签到提供商白名单中的 "${id}" 不存在`);
      if (!checkinCapableProviderTypes().includes(p.type)) {
        return fail(`提供商 "${id}"（类型 ${p.type}）不支持签到，无法加入白名单`);
      }
    }
    updates.checkinProviders = ids;
  }
  if (body.keepaliveEnabled !== undefined) updates.keepaliveEnabled = body.keepaliveEnabled;
  if (body.keepaliveCron !== undefined) updates.keepaliveCron = body.keepaliveCron;
  if (body.keepaliveTz !== undefined) updates.keepaliveTz = body.keepaliveTz;

  await saveRuntimeSettings(updates);
  return ok({ updated: Object.keys(updates), message: "已保存并热生效（无需重启）" });
}
