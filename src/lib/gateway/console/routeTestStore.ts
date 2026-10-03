// 路由快测结果持久化 —— SystemSetting routeTestResults 键。
// v4.9.13-local-r16：路由页「全部测试」批测与单路由快测对话框共用；
// 结构 { [model]: { last, history[] } }，history cap 10 最新在前（与 providerTestResults 同构）。
// 读写失败静默降级：测试主流程不因持久化故障阻断（结果已返回给调用方）。
import { db } from "@/lib/db";
import type { RouteTestRecord } from "@/lib/console/types";

export const ROUTE_TEST_RESULTS_KEY = "routeTestResults";
export const ROUTE_TEST_HISTORY_CAP = 10;

export interface RouteTestStoreEntry {
  last: RouteTestRecord;
  history: RouteTestRecord[];
}

export type RouteTestStore = Record<string, RouteTestStoreEntry>;

export async function readRouteTestStore(): Promise<RouteTestStore> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: ROUTE_TEST_RESULTS_KEY } });
    const raw = row?.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as RouteTestStore;
  } catch {
    return {};
  }
}

/** 批量写入（批测一次调用避免 N 次读改写）；单测传数组长度 1 即可 */
export async function persistRouteTestResults(results: Array<{ model: string; record: RouteTestRecord }>): Promise<number> {
  if (results.length === 0) return 0;
  try {
    const store = await readRouteTestStore();
    for (const { model, record } of results) {
      if (!model) continue;
      const prev = store[model];
      store[model] = {
        last: record,
        history: [record, ...(prev?.history ?? [])].slice(0, ROUTE_TEST_HISTORY_CAP),
      };
    }
    await db.systemSetting.upsert({
      where: { key: ROUTE_TEST_RESULTS_KEY },
      create: { key: ROUTE_TEST_RESULTS_KEY, value: store as never },
      update: { value: store as never },
    });
    return results.filter((r) => r.model).length;
  } catch {
    // 持久化失败不阻断测试响应（下次测试会重试写入）
    return 0;
  }
}

/** 路由删除时清理其测试记录（孤儿键）：读取失败/无记录/写失败均静默，不阻断删除主流程 */
export async function deleteRouteTestResult(model: string): Promise<void> {
  try {
    const store = await readRouteTestStore();
    if (!(model in store)) return; // 无记录时避免无谓写入
    delete store[model];
    await db.systemSetting.upsert({
      where: { key: ROUTE_TEST_RESULTS_KEY },
      create: { key: ROUTE_TEST_RESULTS_KEY, value: store as never },
      update: { value: store as never },
    });
  } catch {
    // 清理失败不影响删除；残留键体积极小且读取端按存在路由过滤（GET /routes 回读 lastTest 时天然隔离）
  }
}
