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

// ---- 上游模型目录（v4.7.1：/api/console/providers/models 的真实拉取结果） ----
// WorkBuddy Web 端 /console/enterprises/{personal|企业ID}/models（Task 57 逆向）：
// CLI 凭证 Bearer 可直调；响应含全量模型元数据 + 各端白名单（agents[].name==="cli"）。
export interface UpstreamModelDetail {
  id: string;
  name?: string | null;
  /** 上游展示文案原样透传："x0.29" / "x0.00 credits" / null（无固定倍率） */
  credits?: string | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  isDefault?: boolean;
  tags?: string[];
}
export interface UpstreamModelsResult {
  /** CLI 通道可用模型（白名单顺序，网关路由候选可直接使用） */
  models: string[];
  /** 与 models 一一对应的元数据（前端下拉富展示） */
  details: UpstreamModelDetail[];
  /** 实际调用的上游 URL（透明化） */
  url: string;
  /** 上游全量模型数（含白名单外旧模型），无意义时可缺省 */
  allCount?: number;
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
  /** 上游模型目录拉取（可选）：失败时调用方降级 derived 推导目录 */
  listUpstreamModels?: () => Promise<UpstreamModelsResult>;
}

// ---- 出站代理作用域 ----
export interface ProxyScope {
  // 提供商级覆盖：null=跟随全局；"direct"=强制直连；其他=专属代理（可逗号分隔池）
  override?: string | null;
}
