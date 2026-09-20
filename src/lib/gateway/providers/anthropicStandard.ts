import type { ProviderAdapter, ProviderConfig, ChatPayload, CallOptions, BalanceResult } from "../core/types";
import { fetchWithProxy } from "../proxy/proxyAgent";
import { poolAccounts, callWithAccountPool } from "./standardPool";

// Anthropic 兼容端点适配器：原生 /v1/messages 上游。
//
// v4.2.2：多账号池轮换 —— 控制台账号页添加的账号（credentials.apiKey）进入引擎调度
//（会话粘性 / round-robin / 冷却退避 / 失败切换 / X-Gateway-Account 上报），
// 无账号池时回退 provider 级 config.apiKey 单密钥直发（v4.2.1 行为零变化）。
export class AnthropicStandardProvider implements ProviderAdapter {
  id: string;
  name: string;
  type = "anthropic";
  config: Record<string, unknown>;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.name = config.name || "Anthropic Compatible";
    this.config = (config.config || {}) as Record<string, unknown>;
  }

  get baseUrl(): string {
    const url = (this.config.baseUrl as string) || "https://api.anthropic.com";
    return url.replace(/\/$/, "");
  }

  get apiKey(): string {
    return (this.config.apiKey as string) || "";
  }

  // Anthropic 原生 messages
  async callMessages(payload: Record<string, unknown>, options: CallOptions = {}): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`;
    const defaultHeaders = (this.config.defaultHeaders as Record<string, string>) || {};

    const makeRequest = (apiKey: string): Promise<Response> =>
      fetchWithProxy(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": (this.config.anthropicVersion as string) || "2023-06-01",
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
      label: `Anthropic:${this.id}`,
    });
  }

  // 如果客户端发来 OpenAI 格式但上游是 Anthropic，由网关转换层处理；
  // 此 stub 保留原语义（contract 以 hasCallMessages 判定原生 Anthropic 通道）。
  async callChat(): Promise<Response> {
    return new Response(
      JSON.stringify({ error: { message: "Direct chat not supported on raw Anthropic provider" } }),
      { status: 400 }
    );
  }

  async getBalance(): Promise<BalanceResult> {
    return { success: false, balance: null, total: null, extra: "Anthropic 官方无公共余额 API" };
  }

  async onSchedule(): Promise<void> {}
}
