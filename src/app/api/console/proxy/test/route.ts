// /api/console/proxy/test —— 全局代理连通性实测（设置页「测试代理 / 测试历史」）。
//
// v3.6.0：此前设置页「测试代理」按钮 POST 本路径但 route 缺失，Next.js 直接 404；本次补齐接线。
//
// 契约（前端 settings.tsx 依赖）：
// - POST  体 { proxyList?, bypass? }：测试「未保存草稿」；list 非空则逐地址并行实测（cap 5），
//         空 list 走直连出口，空 body 测当前生效配置。
//         返回 { ...ProxyTestResult, history } —— history 供历史面板即时刷新。
// - GET   返回 { lastTest, history, diagnostics }。
// - DELETE 仅清空测试历史（SystemSetting key = proxyTestHistory，非业务数据），不动代理配置。
//
// 业务逻辑全部复用 lib/gateway/proxy/proxyAgent.ts 的既有实现（testProxy 已内置草稿模式）。
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { saveRuntimeSettings, getRuntimeSettingsAsync } from "@/lib/gateway/config/runtimeSettings";
import { testProxy, proxyDiagnostics, parseProxyList } from "@/lib/gateway/proxy/proxyAgent";
import type { ProxyTestRecord } from "@/lib/console/types";

// 测试历史在 SystemSetting 表中的键名（与前端 v3.6.0 约定一致）
const HISTORY_KEY = "proxyTestHistory";
// 历史条数上限（cap 20，最新的在前）
const HISTORY_CAP = 20;

/**
 * 读取代理测试历史（SystemSetting 表）。
 * 防抖：任何读取/解析异常都降级为空数组，不阻塞测试主流程。
 */
async function readHistory(): Promise<ProxyTestRecord[]> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: HISTORY_KEY } });
    const raw = row?.value;
    return Array.isArray(raw) ? (raw as unknown as ProxyTestRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * 追加一条测试记录（最新的在前，cap 20）。
 * 返回追加后的完整历史，供 POST 响应直接回给前端。
 */
async function appendHistory(record: ProxyTestRecord): Promise<ProxyTestRecord[]> {
  const prev = await readHistory();
  const next = [record, ...prev].slice(0, HISTORY_CAP);
  await db.systemSetting.upsert({
    where: { key: HISTORY_KEY },
    create: { key: HISTORY_KEY, value: next as never },
    update: { value: next as never },
  });
  return next;
}

// ---- GET：返回最近一次测试结果、测试历史、调度器诊断 ----
export async function GET(req: Request) {
  const g = await requireSessionOr401(req);
  if (g) return g;
  try {
    // lastTest 从运行时设置（SystemSetting 写穿缓存的 proxy 键）读取
    const runtime = await getRuntimeSettingsAsync();
    const lastTest = runtime.proxy?.lastTest ?? null;
    const history = await readHistory();
    // diagnostics 复用 proxyAgent 的 dispatcher 缓存状态只读导出
    const diagnostics = proxyDiagnostics();
    return ok({ lastTest, history, diagnostics });
  } catch (e) {
    // 异常兜底：不让裸栈冒泡成 500
    return fail(e instanceof Error ? e.message : "代理测试信息读取失败", 500);
  }
}

// ---- POST：实测代理连通性（支持未保存草稿） ----
export async function POST(req: Request) {
  const g = await requireSessionOr401(req);
  if (g) return g;
  try {
    // 空 body / 解析失败 → 按生效配置实测（draft 传 null）
    let body: { proxyList?: unknown; bypass?: unknown } = {};
    try {
      body = (await req.json()) as { proxyList?: unknown; bypass?: unknown };
    } catch {
      body = {};
    }

    const hasDraft = typeof body.proxyList === "string" || Array.isArray(body.proxyList);
    // draft：list 非空 → 逐地址并行实测；list 为空 → 直连出口测试；无 draft → 生效配置实测
    // 复用 parseProxyList（逗号/分号/换行分隔）规范化草稿，与前端保存路径同一套解析
    const draftList = parseProxyList(
      Array.isArray(body.proxyList)
        ? (body.proxyList as string[]).join("\n")
        : String(body.proxyList ?? "")
    );
    const draft = hasDraft
      ? { list: draftList, bypass: Array.isArray(body.bypass) ? (body.bypass as string[]) : [] }
      : null;

    // testProxy(targetUrl, scope, draft)：targetUrl/scope 用默认值，仅传 draft
    const result = await testProxy(undefined, null, draft);

    // 测试模式：draft 且 list 非空 = draft；draft 且 list 空 = direct；无 draft = global
    const mode: ProxyTestRecord["mode"] = !draft ? "global" : draft.list.length > 0 ? "draft" : "direct";

    // 归一化逐地址明细（testProxy 的 pool 已掩码，类型与 ProxyTestRecord.pool 一致）
    const pool = result.pool?.map((p) => ({
      masked: p.masked,
      ok: p.ok,
      elapsedMs: p.elapsedMs,
      exitIp: p.exitIp,
      error: p.error,
    }));

    const lastTest = {
      ok: result.ok,
      exitIp: result.exitIp,
      elapsedMs: result.elapsedMs,
      error: result.error,
      at: new Date().toISOString(),
    };

    // 持久化：仅当已有代理配置时回写 proxy.lastTest（供总览展示）。
    // 注意：saveRuntimeSettings 是按 key 整体 upsert，故未保存过配置时绝不写入，
    // 否则会凭空造出一份 enabled=false 的代理配置、污染用户真实状态 —— 测试是只读探针。
    const runtime = await getRuntimeSettingsAsync();
    if (runtime.proxy) {
      await saveRuntimeSettings({ proxy: { ...runtime.proxy, lastTest } });
    }

    // 追写测试历史（cap 20，最新在前），并随响应返回
    const history = await appendHistory({
      ok: result.ok,
      exitIp: result.exitIp,
      elapsedMs: result.elapsedMs,
      error: result.error,
      mode,
      pool,
      at: lastTest.at,
    });

    // scope / poolPreview / diagnostics：前端 settings.tsx 有三处展示位读取它们，
    // 不返回会让那三行信息永久空白（ProxyTestResult 类型亦已声明这三个字段）。
    // poolPreview 直接取自 pool[] 已算好的掩码地址（proxyAgent 内部完成掩码，不回显凭据）。
    return ok({
      ...result,
      mode,
      pool,
      scope: null,
      poolPreview: (pool ?? []).map((p) => p.masked),
      diagnostics: proxyDiagnostics(),
      history,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "代理测试失败", 500);
  }
}

// ---- DELETE：仅清空测试历史（非业务数据） ----
export async function DELETE(req: Request) {
  const g = await requireSessionOr401(req);
  if (g) return g;
  try {
    // 只删历史键，不动 proxy 生效配置
    await db.systemSetting.deleteMany({ where: { key: HISTORY_KEY } });
    return ok({ history: [] });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "代理测试历史清空失败", 500);
  }
}
