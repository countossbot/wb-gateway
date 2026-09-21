// 引擎共享类型 —— 内存 config 形态与原项目 KV JSON 完全同形（等价保留验收基线）。
// SQLite 只是持久层；getConfig() 从表组装出本文件定义的对象，核心引擎零语义改动消费。

export interface AccountConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  // 凭据字段（按提供商类型不同，存储于 DB credentials JSON）：
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  token?: string;
  cookie?: string;
  fingerprint?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProviderRuntimeConfig {
  [key: string]: unknown;
}

export interface ProviderConfig {
  id: string;
  name?: string;
  type: string;
  enabled?: boolean;
  config: ProviderRuntimeConfig;
  // 账号池（原形态：provider.config.accounts）
  accounts?: AccountConfig[];
}

export interface RouteCandidateConfig {
  provider: string;
  model: string;
}

export interface VirtualKeyEntry {
  name?: string;
  enabled?: boolean;
  models?: string[];
  role?: string;
  remark?: string;
  /** v4.3.0：密钥级日配额（0/缺省 = 不限额）；入口超限直接 429，不触上游 */
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  /** v4.5.0：密钥级月度成本预算（$/估算口径；0/缺省 = 不限）。当月估算成本 ≥ 预算入口 429 */
  monthlyCostLimit?: number;
}

export interface GatewayConfig {
  config_version: number;
  master_key?: string;
  cron_secret?: string;
  max_context_turns?: number;
  usage_provider_id?: string;
  providers: ProviderConfig[];
  routes: Record<string, RouteCandidateConfig[]>;
  virtual_keys: Record<string, VirtualKeyEntry>;
  [key: string]: unknown;
}

// ---- 出站调用 ----
export interface CallOptions {
  signal?: AbortSignal | null;
  request?: Request | null;
  [key: string]: unknown;
}

export interface ChatPayload {
  model: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  reasoning_effort?: string;
  reasoning?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BalanceAccountDetail {
  id: string;
  name?: string;
  balance: number;
  total: number;
  success: boolean;
  [key: string]: unknown;
}

export interface BalanceResult {
  success: boolean;
  balance: number | string | null;
  total: number | string | null;
  unit?: string;
  accounts_count?: number;
  accounts?: BalanceAccountDetail[];
  error?: string;
  extra?: string;
  [key: string]: unknown;
}

// ---- Provider 适配器契约（能力子集，见 contract.ts） ----
export interface ProviderAdapter {
  id: string;
  name: string;
  type: string;
  forceStream?: boolean;
  callChat?: (payload: ChatPayload, options?: CallOptions) => Promise<Response>;
  callMessages?: (payload: Record<string, unknown>, options?: CallOptions) => Promise<Response>;
  getBalance?: () => Promise<BalanceResult>;
  onSchedule?: () => Promise<unknown>;
  doDailyCheckin?: () => Promise<unknown>;
  refreshAccessToken?: (account?: unknown) => Promise<unknown>;
}

// ---- 出站代理作用域 ----
export interface ProxyScope {
  // 提供商级覆盖：null=跟随全局；"direct"=强制直连；其他=专属代理（可逗号分隔池）
  override?: string | null;
}
