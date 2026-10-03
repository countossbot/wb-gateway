// 系统运行时指标采样 —— 进程 RSS / Heap 历史环形缓冲（v4.9.2 新增）
//
// 用途：在 System Info 卡片中渲染 RSS 历史 sparkline，让管理员直观看到内存增长趋势，
// 提前预警 OOM（4GB 沙箱上限）。采样以 60s 为间隔，保留 30 个样本（30 分钟历史）。
//
// 设计取舍：
//   - 不落库（SystemSetting / 新表都不必要 —— 数据本身是「瞬时窗口」语义，进程重启后历史无意义）
//   - 进程内环形缓冲（globalThis 持有，dev HMR 跨重载沿用）
//   - 单 interval，60s tick；与 scheduler 的 30s tick 解耦（scheduler 关注业务任务，这里关注进程指标）
//   - 采样失败不抛错，仅跳过本次（避免 instrumentation 启动期失败阻塞主流程）

export interface MetricSample {
  /** 采样时间（ISO string，JSON 序列列化友好） */
  at: string;
  /** 采样时间戳（ms since epoch） */
  ts: number;
  /** RSS（bytes） —— 驻留集，进程实际占用物理内存 */
  rss: number;
  /** Heap Used（bytes） —— V8 已使用堆 */
  heapUsed: number;
  /** Heap Total（bytes） —— V8 已分配堆 */
  heapTotal: number;
  /** External（bytes） —— C++ 对象（Buffer 等） */
  external: number;
}

const SAMPLE_INTERVAL_MS = 60_000; // 60s
const MAX_SAMPLES = 30; // 30 分钟历史

const METRICS_KEY = "__uag_system_metrics__";
const TIMER_KEY = "__uag_system_metrics_timer__";

interface GlobalMetricsState {
  samples: MetricSample[];
  startedAt: number;
}

function getState(): GlobalMetricsState {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[METRICS_KEY]) {
    g[METRICS_KEY] = {
      samples: [],
      startedAt: Date.now(),
    } as GlobalMetricsState;
  }
  return g[METRICS_KEY] as GlobalMetricsState;
}

function takeSample(): MetricSample {
  const mem = process.memoryUsage();
  const ts = Date.now();
  return {
    at: new Date(ts).toISOString(),
    ts,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
  };
}

function pushSample(state: GlobalMetricsState, sample: MetricSample): void {
  state.samples.push(sample);
  // 环形缓冲：超容量则丢弃最旧
  if (state.samples.length > MAX_SAMPLES) {
    state.samples.splice(0, state.samples.length - MAX_SAMPLES);
  }
}

function tick(): void {
  try {
    const state = getState();
    pushSample(state, takeSample());
  } catch (e) {
    // 静默：采样失败不应触发可见错误（与 scheduler WAL checkpoint 同款防御性 catch）
    console.warn("[SystemMetrics] sample tick failed:", (e as Error).message);
  }
}

/**
 * 启动系统指标采样。instrumentation.register 调用一次（幂等：HMR 跨重载沿用同一 globalThis）。
 */
export function startSystemMetricsSampler(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[TIMER_KEY]) return; // 已启动（幂等）
  // 首启立即采一次，避免 30 分钟内只有空 sparkline
  try {
    const state = getState();
    pushSample(state, takeSample());
  } catch {
    // 忽略
  }
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  // 避免阻止进程退出
  (timer as unknown as { unref?: () => void }).unref?.();
  g[TIMER_KEY] = true;
  console.log(`[SystemMetrics] Started (60s interval, max ${MAX_SAMPLES} samples / ${MAX_SAMPLES}min history)`);
}

/**
 * 停止采样（仅在测试 / 显式关闭时调用）。
 */
export function stopSystemMetricsSampler(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[TIMER_KEY]) {
    delete g[TIMER_KEY];
  }
}

/**
 * 获取当前 RSS 历史样本（最早 → 最新，最多 30 个）。供 /api/console/system-info 调用。
 * 返回副本，避免外部修改污染内部状态。
 */
export function getRssHistory(): MetricSample[] {
  const state = getState();
  return state.samples.map((s) => ({ ...s }));
}

/**
 * 采样启动时间（ISO string）。供 UI 显示「采样已运行 X 分钟」。
 */
export function getMetricsStartedAt(): string {
  return new Date(getState().startedAt).toISOString();
}
