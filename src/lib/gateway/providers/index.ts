// 内置供应商接线：新增供应商时加一行 registerProvider 即可，createProvider 逻辑零改动。
import { WorkBuddyProvider } from "./workbuddy/index";
import { OpenAIStandardProvider } from "./openaiStandard";
import { AnthropicStandardProvider } from "./anthropicStandard";
import { registerProvider, supportedProviderTypes, createProvider } from "./registry";
import type { ProviderAdapter, ProviderConfig } from "../core/types";

// 内置供应商接线：新增供应商时加一行 registerProvider 即可，createProvider 逻辑零改动。
registerProvider("workbuddy", WorkBuddyProvider as unknown as new (config: ProviderConfig) => ProviderAdapter);
registerProvider("openai", OpenAIStandardProvider as unknown as new (config: ProviderConfig) => ProviderAdapter);
registerProvider("anthropic", AnthropicStandardProvider as unknown as new (config: ProviderConfig) => ProviderAdapter);

export { registerProvider, supportedProviderTypes, createProvider };
export { WorkBuddyProvider, OpenAIStandardProvider, AnthropicStandardProvider };
