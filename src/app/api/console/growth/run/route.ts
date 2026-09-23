// POST /api/console/growth/run —— 成长中心：手动立即执行（SSE 实时日志流）
//
// 请求体：{ accountId: string; groups: GrowthGroup[] }
// 响应：text/event-stream，逐条推送 GrowthRunEvent（同时 append 进 GrowthLog 表）。
//
// 约束（按需求）：
//   - 仅 CN workbuddy 账号；国际站（workbuddy-intl）明确拒绝
//   - 全局互斥（方案 a）：任何时刻全站只允许一个账号执行
//   - status='done' 的账号拒绝再次执行（防重复手动执行）
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, fail } from "@/lib/gateway/console/consoleHelpers";
import { runGrowthTasks } from "@/lib/gateway/growth/runner";
import { currentRun } from "@/lib/gateway/growth/state";
import { GROWTH_GROUPS } from "@/lib/gateway/growth/tasks";
import type { GrowthGroup, GrowthRunEvent } from "@/lib/gateway/growth/types";

export const dynamic = "force-dynamic";

const VALID_GROUPS = GROWTH_GROUPS.map((g) => g.id);

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const body = (await request.json().catch(() => ({}))) as {
    accountId?: unknown;
    groups?: unknown;
  };

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  if (!accountId) return fail("缺少 accountId");

  // 组校验：必须是已知组，且至少一组
  if (!Array.isArray(body.groups)) return fail("groups 必须为数组");
  const groups = body.groups.filter((g): g is GrowthGroup =>
    typeof g === "string" && VALID_GROUPS.includes(g as GrowthGroup),
  );
  if (groups.length === 0) return fail("请至少勾选一组任务");
  if (groups.length !== body.groups.length) return fail("groups 含未知分组");

  // 账号校验：必须属于 CN workbuddy
  const account = await db.account.findUnique({
    where: { providerId_id: { providerId: "workbuddy", id: accountId } },
    select: { id: true, name: true, enabled: true, credentials: true },
  });
  if (!account) return fail("账号不存在或不属于 workbuddy（CN）；国际站账号不支持成长任务");
  if (!account.enabled) return fail("该账号已禁用");

  // done 锁定：已完成账号不再手动执行
  const state = await db.growthAccountState.findUnique({ where: { accountId } });
  if (state?.status === "done") {
    return fail(`该账号本次已全部完成（${state.completedCount}/${state.totalCount}），无需重复执行`);
  }

  // 全局互斥：提前拒绝，避免建立 SSE 连接后再报错
  const running = currentRun();
  if (running) {
    return fail(`已有账号正在执行（${running.accountId}），请等待完成`);
  }

  const token = String(
    (account.credentials as { accessToken?: unknown } | null)?.accessToken || "",
  );
  if (!token) return fail("该账号缺少 accessToken，请在「API 中转」页重新登录");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (e: GrowthRunEvent | { level: string; message: string; done?: boolean }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true; // 客户端已断开
        }
      };

      // 心跳：SSE 长时间无数据会被中间层切断
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      void (async () => {
        try {
          const result = await runGrowthTasks({
            accountId: account.id,
            accountName: account.name || account.id,
            accessToken: token,
            groups,
            sink: (e) => send(e),
          });
          send({
            level: result.ok ? "ok" : "error",
            message: result.ok
              ? `执行结束：${result.completedCount}/${result.totalCount}${result.status === "done" ? "（已锁定）" : ""}`
              : `执行失败：${result.error || "未知错误"}`,
            done: true,
          });
        } catch (e) {
          send({
            level: "error",
            message: `执行异常：${e instanceof Error ? e.message : String(e)}`,
            done: true,
          });
        } finally {
          clearInterval(heartbeat);
          closed = true;
          try {
            controller.close();
          } catch {
            // 已关闭
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
