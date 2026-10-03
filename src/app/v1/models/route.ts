// GET /v1/models —— 模型列表接口（OpenAI 兼容目录结构）。
// v4.9.12-local-r7：元数据透传 —— 每个对外模型若能经由其首选启用的路由候选映射到
// 上游目录条目，则附带该上游的扩展元数据（description / context_window / capabilities），
// owned_by 改为最终命中的 providerId。标准 OpenAI 客户端忽略未知字段零影响；
// Playground 等自研前端可据此做富展示（模型画像、上下文窗口、能力标注）。
// v4.9.12-local-r8：gateway_routed 标记 —— 目录中的模型并非全部可调用：DEFAULT_ROUTES 键会
// 补进目录（信息展示），但其引用的 provider 未注册时 dispatch 实际会 404（No route）。
// 此处按 backfillMissingRoutes 同语义判定「真实可路由」（DB 启用路由 ∪ 引用 provider 全部
// 存在且启用的默认路由），透传布尔字段，前端据此区分「已路由 / 无路由」并提示。
// v4.9.12-local-r9：目录缓存抽取为共享模块 src/lib/gateway/catalog.ts（控制台「刷新模型目录」
// 与 Playground 模型列表刷新共用失效入口），本文件仅保留目录聚合逻辑。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { DEFAULT_ROUTES } from "@/lib/gateway/config/configService";
import { requireGatewayAuth } from "@/lib/gateway/http/routeHelpers";
import { corsHeadersFor } from "@/lib/gateway/http/headers";
import { loadCatalog } from "@/lib/gateway/catalog";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireGatewayAuth(request);
  if (!auth.ok) return auth.response;

  // 1. 先取 DB 中已启用、且有候选的模型路由（优先），候选按 failover 顺序
  const rows = await db.modelRoute.findMany({
    where: { enabled: true, candidates: { some: { enabled: true } } },
    select: {
      model: true,
      candidates: {
        where: { enabled: true },
        orderBy: { sortOrder: "asc" },
        select: { providerId: true, model: true },
      },
    },
    orderBy: { id: "asc" },
  });

  // v4.9.12-local-r8：可路由判定（与 backfillMissingRoutes 同语义）——
  // DB 启用路由直接可路由；DEFAULT_ROUTES 键仅当引用的 provider 全部存在且启用才可路由。
  const enabledProviders = await db.provider.findMany({ where: { enabled: true }, select: { id: true } });
  const enabledProviderIds = new Set(enabledProviders.map((p) => p.id));
  const routableModels = new Set<string>();
  for (const r of rows) routableModels.add(r.model);
  for (const [model, routeList] of Object.entries(DEFAULT_ROUTES)) {
    if (routableModels.has(model)) continue;
    if (routeList.length > 0 && routeList.every((c) => enabledProviderIds.has(c.provider))) routableModels.add(model);
  }

  // 2. 再取 DEFAULT_ROUTES 的全部键
  const defaults = Object.keys(DEFAULT_ROUTES);

  // 3. 去重合并：DB 路由在前，默认列表补齐缺失项
  const seen = new Set<string>();
  const configuredModels: string[] = [];
  for (const m of [...rows.map((row) => row.model), ...defaults]) {
    if (!seen.has(m)) {
      seen.add(m);
      configuredModels.push(m);
    }
  }

  // F4 修复：虚拟密钥的模型白名单必须作用到目录接口。
  // 原缺陷：本接口只做 requireGatewayAuth，未做模型级收敛，受限 Key 能枚举全量模型目录（信息越权）。
  // 语义与 authorizeModelForPrincipal 完全一致：仅虚拟密钥主体受限，master / cron 主体仍看全量；
  // 白名单含 "*" 视为不限制。
  const keyObj = auth.auth.principal?.virtualKey;
  const whitelist =
    keyObj && Array.isArray(keyObj.models) && !keyObj.models.includes("*")
      ? new Set(keyObj.models)
      : null;
  const visibleModels = whitelist ? configuredModels.filter((m) => whitelist.has(m)) : configuredModels;

  // v4.9.12-local-r7：元数据 enrich —— 需要目录的 provider 去重并发拉取（各带缓存）
  const routeByModel = new Map(rows.map((r) => [r.model, r]));
  const providerIds = new Set<string>();
  for (const m of visibleModels) {
    const r = routeByModel.get(m);
    if (r) for (const c of r.candidates) providerIds.add(c.providerId);
  }
  const catalogs = new Map<string, CatalogEntry>();
  if (providerIds.size > 0) {
    await Promise.all(
      Array.from(providerIds).map(async (pid) => {
        catalogs.set(pid, await loadCatalog(pid));
      })
    );
  }

  const data = visibleModels.map((id) => {
    const base: Record<string, unknown> = {
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "worker-gateway",
      // v4.9.12-local-r8：真实可路由标记（dispatch 会 404 的目录项为 false）
      gateway_routed: routableModels.has(id),
    };
    // 沿首选候选（failover 顺序）找第一个在上游目录中有元数据映射的候选
    const route = routeByModel.get(id);
    if (route) {
      for (const c of route.candidates) {
        const cat = catalogs.get(c.providerId);
        const meta = cat?.meta.get(c.model);
        if (!meta) continue;
        base.owned_by = c.providerId;
        if (meta.description) base.description = meta.description;
        if (meta.context_window != null) base.context_window = meta.context_window;
        if (meta.capabilities) base.capabilities = meta.capabilities;
        break;
      }
    }
    return base;
  });

  return new Response(
    JSON.stringify({ object: "list", data }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    },
  );
}
