// GET /api/console/models/catalog —— 上游模型目录缓存快照（观测）。
// POST /api/console/models/catalog —— 手动失效目录缓存（v4.9.12-local-r9）。
//
// 背景：/v1/models 的上游元数据缓存有 5min 新鲜期（上游失败时最长回退 30min 陈旧值）。
// 管理员在「模型路由」页新增/修改提供商或候选后，新模型的 description / context_window
// 元数据最长要等 5min 才出现；提供手动失效入口后 Playground 重新加载模型列表即可见。
//
// POST 可选 ?providerId=<id> 精准失效单个提供商；省略时清空全部。返回失效条数 + 失效后快照。
import { NextRequest } from "next/server";
import { requireSessionOr401, ok } from "@/lib/gateway/console/consoleHelpers";
import { catalogCacheSnapshot, invalidateCatalogCache } from "@/lib/gateway/catalog";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  return ok({ cache: catalogCacheSnapshot() });
}

export async function POST(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;
  const providerId = request.nextUrl.searchParams.get("providerId") || undefined;
  const invalidated = invalidateCatalogCache(providerId);
  return ok({
    invalidated,
    scope: providerId ? "provider" : "all",
    cache: catalogCacheSnapshot(),
  });
}
