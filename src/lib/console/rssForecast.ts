// RSS 趋势预测 —— 线性回归外推（v4.9.6 新增）
//
// 用途：在 System Info 的 RSS sparkline 上叠加一条「预测延伸线」，让管理员看到
// 当前内存增长趋势若持续，30 分钟后 RSS 会达到多少 —— 提前预警 OOM。
//
// 算法：最小二乘法线性回归（ordinary least squares）
//   输入：N 个样本 (ts_ms, rss_bytes)
//   拟合：rss = a + b * ts（b 为斜率 bytes/ms，a 为截距）
//   外推：取最新样本时间戳 t_now，预测 t_now + horizonMs 的 RSS = a + b * (t_now + horizonMs)
//
// 设计取舍：
//   - 用样本数 ≥ 3 才计算（避免过拟合噪声）；< 3 返回 null（UI 不渲染预测线）
//   - 仅用最近 N 个样本拟合（默认全部，但若历史超过 30 个则取最近 15 个，反映近期趋势而非全程平均）
//   - 预测结果限制在 [0, limitBytes * 1.2] —— 防止异常值把 sparkline y 轴撑爆；上限放宽 20% 让「超过 4GB」可视化可见
//   - 斜率 b ≤ 0（RSS 在下降）→ 不渲染预测线（趋势向好，无需预警）

export interface ForecastResult {
  /** 预测的 RSS 字节数（限制在 [0, limitBytes * 1.2]） */
  projectedBytes: number;
  /** 预测时间点的时间戳（ms since epoch） */
  projectedTs: number;
  /** 斜率 bytes/ms（正数表示 RSS 在增长，负数表示在下降） */
  slopeBytesPerMs: number;
  /** 拟合优度 R²（0-1，越接近 1 越准确） */
  rSquared: number;
  /** 参与拟合的样本数 */
  sampleCount: number;
  /** 预测是否可信（sampleCount ≥ 3 且 rSquared ≥ 0.3 才为 true） */
  reliable: boolean;
}

/**
 * 对 RSS 样本做线性回归并外推 horizonMs 后的预测值。
 *
 * @param samples 样本数组（最早 → 最新）
 * @param horizonMs 外推时长（默认 30 分钟 = 1800000ms）
 * @param limitBytes y 轴上限（用于截断异常预测值，默认 4GB）
 * @returns ForecastResult 或 null（样本数 < 3 时）
 */
export function forecastRss(
  samples: Array<{ ts: number; rss: number }>,
  horizonMs: number = 30 * 60 * 1000,
  limitBytes: number = 4 * 1024 * 1024 * 1024
): ForecastResult | null {
  if (!samples || samples.length < 3) return null;

  // 取最近 15 个样本反映近期趋势（避免早期启动期的大幅增长拉偏斜率）
  const recent = samples.length > 15 ? samples.slice(-15) : samples;
  const n = recent.length;

  // 最小二乘法：拟合 y = a + b * x
  // b = (n * Σ(xy) - Σx * Σy) / (n * Σ(x²) - (Σx)²)
  // a = (Σy - b * Σx) / n
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (const s of recent) {
    sumX += s.ts;
    sumY += s.rss;
    sumXY += s.ts * s.rss;
    sumX2 += s.ts * s.ts;
    sumY2 += s.rss * s.rss;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null; // 所有 ts 相同（不可能但防御性）
  const b = (n * sumXY - sumX * sumY) / denom; // 斜率 bytes/ms
  const a = (sumY - b * sumX) / n; // 截距 bytes

  // R² = (n * Σ(xy) - Σx * Σy)² / ((n * Σ(x²) - (Σx)²) * (n * Σ(y²) - (Σy)²))
  const denomY = n * sumY2 - sumY * sumY;
  if (denomY === 0) return null; // 所有 rss 相同（无趋势）
  const rSquared = Math.max(0, Math.min(1, ((n * sumXY - sumX * sumY) ** 2) / (denom * denomY)));

  // 外推：从最新样本时间戳 + horizonMs
  const latest = recent[n - 1];
  const projectedTs = latest.ts + horizonMs;
  const rawProjected = a + b * projectedTs;
  // 截断：[0, limitBytes * 1.2]（允许超过上限 20% 让可视化可见）
  const projectedBytes = Math.max(0, Math.min(rawProjected, limitBytes * 1.2));

  // 斜率 ≤ 0 → RSS 在下降，不预测（返回 null 让 UI 不渲染）
  if (b <= 0) return null;

  return {
    projectedBytes,
    projectedTs,
    slopeBytesPerMs: b,
    rSquared,
    sampleCount: n,
    reliable: n >= 3 && rSquared >= 0.3,
  };
}

/**
 * 把预测结果格式化为人类可读的提示文案。
 */
export function formatForecastHint(f: ForecastResult, limitBytes: number): string {
  const projectedMB = f.projectedBytes / 1024 / 1024;
  const projectedPercent = (f.projectedBytes / limitBytes) * 100;
  const minutesToProject = Math.round((f.projectedTs - Date.now()) / 60000);
  const slopePerMin = f.slopeBytesPerMs * 60 * 1000; // bytes/min
  const slopeMBPerMin = slopePerMin / 1024 / 1024;
  return (
    `预测 ${minutesToProject} 分钟后：${projectedMB.toFixed(0)}MB（${projectedPercent.toFixed(1)}%）\n` +
    `增长率：${slopeMBPerMin.toFixed(1)}MB/分钟\n` +
    `拟合优度 R²=${f.rSquared.toFixed(2)}${f.reliable ? "（可信）" : "（仅供参考）"}\n` +
    `样本数：${f.sampleCount}`
  );
}
