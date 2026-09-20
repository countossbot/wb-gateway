// 上游前缀缓存命中计数器（进程级，只记数不存内容）。
// 信号来源：OpenAI 形 usage.prompt_tokens_details.cached_tokens、
// Anthropic 形 usage.cache_read_input_tokens（见 stream.ts extractCachedTokens）。
// 供 /admin/api/status 可见与日志，命中率 = cachedResponses / responses。
const stats = {
  responses: 0,
  cachedResponses: 0,
  cachedTokens: 0,
};

export function recordUpstreamCache(cachedTokens: number = 0): void {
  stats.responses += 1;
  const n = Number(cachedTokens) || 0;
  if (n > 0) {
    stats.cachedResponses += 1;
    stats.cachedTokens += n;
  }
}

export function snapshotCacheStats() {
  const { responses, cachedResponses, cachedTokens } = stats;
  return {
    responses,
    cachedResponses,
    cachedTokens,
    hitRate:
      responses > 0 ? Math.round((cachedResponses / responses) * 1000) / 10 : 0,
  };
}

// 仅测试使用：隔离用例间的进程级计数。
export function resetCacheStats(): void {
  stats.responses = 0;
  stats.cachedResponses = 0;
  stats.cachedTokens = 0;
}
