import type { ProviderAdapter, ProviderConfig, CallOptions, BalanceResult } from "../core/types";
import { fetchWithProxy } from "../proxy/proxyAgent";

// Anthropic 兼容端点适配器：原生 /v1/messages 上游。
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": (this.config.anthropicVersion as string) || "2023-06-01",
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
