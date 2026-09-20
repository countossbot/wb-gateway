import type { ProviderAdapter, ProviderConfig, ChatPayload, CallOptions, BalanceResult } from "../core/types";
import { fetchWithProxy } from "../proxy/proxyAgent";

// OpenAI 兼容端点适配器（OpenRouter / DeepSeek 官方 / 硅基流动等）。
// 全部出站请求走 fetchWithProxy（全局代理作用域：提供商调用受代理覆盖/bypass 控制）。
export class OpenAIStandardProvider implements ProviderAdapter {
  id: string;
  name: string;
  type = "openai";
  config: Record<string, unknown>;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name || "OpenAI Compatible";
    this.config = (config.config || {}) as Record<string, unknown>;
  }

  get baseUrl(): string {
    const url = (this.config.baseUrl as string) || "https://api.openai.com/v1";
    return url.replace(/\/$/, "");
  }

  get apiKey(): string {
    return (this.config.apiKey as string) || "";
  }

  async callChat(payload: ChatPayload, options: CallOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      Connection: "keep-alive",
      ...((this.config.defaultHeaders as Record<string, string>) || {}),
    };

    return await fetchWithProxy(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: options.signal ?? undefined,
      },
      { providerId: this.id }
    );
  }

  async getBalance(): Promise<BalanceResult> {
    // 部分兼容服务支持 /dashboard/billing/credit_grants 或类似接口
    const balanceUrl = this.config.balanceUrl as string | undefined;
    if (balanceUrl) {
      try {
        const resp = await fetchWithProxy(
          balanceUrl,
          { headers: { Authorization: `Bearer ${this.apiKey}` } },
          { providerId: this.id }
        );
        const data = (await resp.json()) as Record<string, unknown>;
        return { success: true, balance: null, total: null, data } as BalanceResult;
      } catch (e) {
        return { success: false, balance: null, total: null, error: (e as Error).message };
      }
    }
    return { success: false, balance: null, total: null, extra: "暂不支持查询余额" };
  }

  async onSchedule(): Promise<void> {
    // 标准服务默认无定时操作
  }
}
