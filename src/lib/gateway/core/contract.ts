// Provider 契约 —— 把「一个 provider 适配器必须实现什么」从散落在 fleet.js
// 各处的鸭子类型探测，收敛为单一、有文档、可测试的定义。
//
// 契约（每个具体 provider 可实现的子集，未实现的视为「不支持该能力」）：
//   callChat(payload, options) -> Response        —— OpenAI 风格上游（必选，主路径）
//   callMessages(payload, options) -> Response    —— Anthropic 风格上游（anthropic 主路径）
//   getBalance() -> { success, balance, total, ...} —— 余额查询（可选）
//   onSchedule() -> Promise                        —— 定时保活（可选）
//   doDailyCheckin() -> Promise<{...}>            —— 每日签到（可选）
//
// 能力探测统一收敛到这里的纯谓词，fleet / dispatch 不再手写 typeof 判断，
// 也不再 switch provider.type：调用方只探针，不认 tag。
// 注意：AnthropicStandardProvider 为兼容保留了一个 400 stub callChat，
// 因此「上游是否原生讲 Anthropic」以 hasCallMessages 为准，而非 hasCallChat。

import type { ProviderAdapter, ChatPayload, CallOptions, BalanceResult, UpstreamModelsResult } from "./types";

export function hasGetBalance(provider: unknown): provider is ProviderAdapter & { getBalance(): Promise<BalanceResult> } {
  return !!provider && typeof (provider as ProviderAdapter).getBalance === "function";
}

export function hasCallChat(provider: unknown): provider is ProviderAdapter {
  return !!provider && typeof (provider as ProviderAdapter).callChat === "function";
}

export function hasCallMessages(provider: unknown): provider is ProviderAdapter & {
  callMessages(payload: ChatPayload, options?: CallOptions): Promise<Response>;
} {
  return !!provider && typeof (provider as ProviderAdapter).callMessages === "function";
}

// 上游是否要求请求体强制 stream=true（如 WorkBuddy 非流式 JSON 可能是业务错误包）。
// 由 adapter 声明（forceStream === true），调用方只探针。
export function wantsStreamedChat(provider: unknown): boolean {
  return !!provider && (provider as ProviderAdapter).forceStream === true;
}

export function hasTokenRefresh(provider: unknown): provider is ProviderAdapter & {
  refreshAccessToken(account?: unknown): Promise<unknown>;
} {
  return !!provider && typeof (provider as ProviderAdapter).refreshAccessToken === "function";
}

// v4.7.1：上游模型目录拉取能力（WorkBuddy Web 端 /console/enterprises/*/models，Task 57 逆向）。
// 调用方（路由候选下拉 /api/console/providers/models）探针后调用；
// 无此能力的 provider（qwenweb 等）直接走 derived 推导目录。
export function hasUpstreamModels(provider: unknown): provider is ProviderAdapter & {
  listUpstreamModels(): Promise<UpstreamModelsResult>;
} {
  return !!provider && typeof (provider as ProviderAdapter).listUpstreamModels === "function";
}

export function hasOnSchedule(provider: unknown): provider is ProviderAdapter & {
  onSchedule(): Promise<unknown>;
} {
  return !!provider && typeof (provider as ProviderAdapter).onSchedule === "function";
}

export function hasDailyCheckin(provider: unknown): provider is ProviderAdapter & {
  doDailyCheckin(): Promise<unknown>;
} {
  return !!provider && typeof (provider as ProviderAdapter).doDailyCheckin === "function";
}
