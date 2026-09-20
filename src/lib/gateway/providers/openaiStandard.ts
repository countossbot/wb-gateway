import type { ProviderAdapter, ProviderConfig, ChatPayload, CallOptions, BalanceResult } from "../core/types";
import { fetchWithProxy } from "../proxy/proxyAgent";
import { poolAccounts, callWithAccountPool } from "./standardPool";

// OpenAI 兼容端点适配器（OpenRouter / DeepSeek 官方 / 硅基流动等）。
// 全部出站请求走 fetchWithProxy（全局代理作用域：提供商调用受代理覆盖/bypass 控制）。
//
// v4.2.2：多账号池轮换 —— 控制台账号页为本提供商添加的账号（credentials.apiKey）
// 自动进入引擎调度：会话粘性 / round-robin / 冷却退避（SQLite 持久化） / 失败切换，
// 响应注入 X-Gateway-Account 供日志与排障定位落点。无账号池时回退 provider 级
// config.apiKey 单密钥直发（v4.2.1 行为零变化）。
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
    const defaultHeaders = (this.config.defaultHeaders as Record<string, string>) || {};

    const makeRequest = (apiKey: string): Promise<Response> =>
      fetchWithProxy(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            Connection: "keep-alive",
            ...defaultHeaders,
          },
          body: JSON.stringify(payload),
          signal: options.signal ?? undefined,
        },
        { providerId: this.id }
      );

    return await callWithAccountPool({
      providerId: this.id,
      accounts: poolAccounts(this.config),
      fallbackApiKey: this.apiKey,
      payload,
      options,
      makeRequest,
      label: `OpenAI:${this.id}`,
    });
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
