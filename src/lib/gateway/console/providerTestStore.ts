// 提供商连通性测试结果持久化 —— SystemSetting providerTestResults 键。
// v4.9.12-local-r12：仅 providerId 模式（已保存配置实测）落库；draft 是未保存草稿不产生持久状态。
// 结构 { [providerId]: { last, history[] } }；history cap 10，最新在前（供后续排障 UI 使用）。
// 读写失败静默降级：测试主流程不因持久化故障阻断（结果已返回给调用方）。
import { db } from "@/lib/db";
import type { ProviderTestResult } from "@/lib/console/types";

export const TEST_RESULTS_KEY = "providerTestResults";
export const TEST_HISTORY_CAP = 10;

export interface ProviderTestStoreEntry {
  last: ProviderTestResult;
  history: ProviderTestResult[];
}

export type ProviderTestStore = Record<string, ProviderTestStoreEntry>;

export async function readTestStore(): Promise<ProviderTestStore> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: TEST_RESULTS_KEY } });
    const raw = row?.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as ProviderTestStore;
  } catch {
    return {};
  }
}

/** 提供商删除时清理其测试记录（孤儿键）：读取失败/写失败均静默，不阻断删除主流程 */
export async function deleteTestResult(providerId: string): Promise<void> {
  try {
    const store = await readTestStore();
    if (!(providerId in store)) return; // 无记录时避免无谓写入
    delete store[providerId];
    await db.systemSetting.upsert({
      where: { key: TEST_RESULTS_KEY },
      create: { key: TEST_RESULTS_KEY, value: store as never },
      update: { value: store as never },
    });
  } catch {
    // 清理失败不影响删除；残留键体积极小且读取端按存在提供商过滤（GET /providers 回读 lastTest 时天然隔离）
  }
}

export async function persistTestResult(providerId: string, result: ProviderTestResult): Promise<void> {
  try {
    const store = await readTestStore();
    const prev = store[providerId];
    store[providerId] = {
      last: result,
      history: [result, ...(prev?.history ?? [])].slice(0, TEST_HISTORY_CAP),
    };
    await db.systemSetting.upsert({
      where: { key: TEST_RESULTS_KEY },
      create: { key: TEST_RESULTS_KEY, value: store as never },
      update: { value: store as never },
    });
  } catch {
    // 持久化失败不阻断测试响应（下次测试会重试写入）
  }
}
