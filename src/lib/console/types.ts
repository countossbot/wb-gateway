// 控制台前端共享类型 —— 与后端 /api/console/* 的响应 data 形状一一对应。

// ---- 认证 ----
export interface SessionInfo {
  initialized: boolean;
  authenticated: boolean;
  username: string | null;
  /** 当前生效认证通道（v3.0.2：控制台顶栏徽标） */
  authVia?: "cookie" | "bearer" | null;
}

export interface SetupResult {
  message: string;
  master_key: string;
  cron_secret: string;
  client_key: string;
  createdProvider: string | null;
}

// ---- 总览 ----
export interface BalanceAccountDetail {
  id: string;
  name?: string;
  balance: number;
  total: number;
  success: boolean;
  [key: string]: unknown;
}

export interface BalanceSummary {
  balance: number | string | null;
  total: number | string | null;
  unit?: string;
  accounts?: BalanceAccountDetail[];
  error?: string;
  success?: boolean;
  [key: string]: unknown;
}

export interface CacheStats {
  responses: number;
  cachedResponses: number;
  cachedTokens: number;
  hitRate: number;
}

export interface AccountState {
  id: string;
  providerId: string;
  name: string;
  enabled: boolean;
  balance: Record<string, unknown> | null;
  cooldownUntil: string | null;
  cooldownStreak: number;
  /** v3.2.2：最近一次进入冷却的原因摘要（tooltip 展示） */
  cooldownReason?: string | null;
  lastCheckinAt: string | null;
  lastCheckinOk: boolean | null;
  lastRefreshAt: string | null;
}

export interface OverviewData {
  version: string;
  balance: BalanceSummary;
  accounts_total: number;
  accounts_enabled: number;
  providers_count: number;
  providers_total: number;
  routes_count: number;
  routes_total?: number;
  cache: CacheStats;
  /** v3.0.3：今日消耗聚合（服务器本地时区 0 点起） */
  today_stats?: TodayStats;
  /** v3.1.1：今日 Top 密钥排行（Top 5 按请求数降序；无调用时空数组） */
  today_top_keys?: TopKeyRow[];
  /** v3.2.0：Top 密钥数据归属日期（YYYY-MM-DD）—— 今日零调用时兕底展示昨日，前端据此标注 */
  top_keys_date?: string;
  /** v3.9.0：今日 Top 模型排行（Top 5 按请求数降序；RequestLog 聚合，无调用时空数组） */
  today_top_models?: TopModelRow[];
  /** v3.9.0：Top 模型数据归属日期（YYYY-MM-DD）—— 今日零调用时兕底展示昨日 */
  top_models_date?: string;
  /** v3.0.4：近 24h 逐小时趋势（24 桶） */
  trend24h?: TrendBucket[];
  /** v3.0.6：近 7 天日趋势（UsageDaily 聚合，含今日） */
  trend7d?: Trend7Day[];
  /** v3.5.0：上一个 7 天汇总（环比对比用；与 trend7d 等长窗口不重叠） */
  trend7d_prev?: Trend7DayPrev;
  /** v4.2.1：近 7 天 Top 提供商排行（UsageDaily providerId 维度聚合，Top 5 按请求数） */
  top_providers_7d?: TopProviderRow[];
  /** v4.2.1：模型健康 sparkline（近 7 天 RequestLog 模型 × 日点阵，Top 6 按请求数） */
  model_health?: ModelHealthData;
  /** v4.3.2：服务质量 SLO（近 24h 种子；切窗口走独立 insights API） */
  slo?: SloData;
  /** v4.4.0：用量成本估算（今日 + 近 7 天窗口 + 逐日趋势 + Top 成本模型 + 覆盖率） */
  cost?: CostData;
  last_checkin: {
    time: string;
    provider: string;
    details: Array<{ accountId: string; accountName: string; success: boolean }>;
  } | null;
  last_refresh: string | null;
  available_models: string[];
  accounts: AccountState[];
}

export interface TodayStats {
  requests: number;
  successRate: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** v3.0.4：近 24h 逐小时趋势桶（总览趋势 mini 图数据源） */
export interface TrendBucket {
  hour: string; // 桶起始整点 ISO
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
}

/** v3.0.6：近 7 天日趋势桶（UsageDaily 按日聚合；不受滚动日志窗口截断） */
export interface Trend7Day {
  day: string; // YYYY-MM-DD（服务器本地时区）
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
}

/** v3.5.0：上一个 7 天汇总（环比对比；与 trend7d 窗口不重叠） */
export interface Trend7DayPrev {
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
}

/** v3.6.0：余额按日快照 —— 单账号时间序列（GET /api/console/balances/history） */
export interface BalanceHistoryAccount {
  providerId: string;
  providerName: string;
  accountId: string;
  accountName: string;
  /** 与 days 轴对齐的余额点（null=当日无快照） */
  points: Array<number | null>;
  /** 窗口内首次非空快照值 */
  first: number | null;
  /** 窗口内最后非空快照值 */
  last: number | null;
  /** last - first（保留 2 位；first/last 任一缺失时为 null） */
  delta: number | null;
}

/** v3.6.0：余额历史响应（days 为完整日期轴，最旧 → 今日） */
export interface BalanceHistoryData {
  days: string[];
  accounts: BalanceHistoryAccount[];
  fetchedAt: string;
}

/** v3.1.1：今日 Top 密钥排行行（UsageDaily 按密钥名聚合；剔除未知调用方） */
export interface TopKeyRow {
  apiKeyName: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** v3.9.0（v4.2.3 改源）：今日 Top 模型排行行（UsageDaily 模型维度聚合；与 Top 密钥同源） */
export interface TopModelRow {
  model: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** v4.2.1：近 7 天 Top 提供商排行行（UsageDaily providerId 维度聚合；未命中提供商不参与排行） */
export interface TopProviderRow {
  providerId: string;
  providerName: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** 占近 7 天总请求数份额（%，1 位小数） */
  share: number;
  /** v4.4.0：窗口内估算成本（$；未计价 = requests - pricedRequests） */
  cost: number;
  /** v4.4.0：已计价请求数 */
  pricedRequests: number;
}

/** v4.2.1（v4.2.3 改源）：模型健康单日点（UsageDaily 模型 × 日聚合，跨滚动窗口持久） */
export interface ModelHealthPoint {
  day: string; // YYYY-MM-DD
  requests: number;
  okRequests: number;
}

/** v4.2.1：模型健康单模型行（7 个日点 + 7 天汇总） */
export interface ModelHealthModel {
  model: string;
  points: ModelHealthPoint[];
  requests7d: number;
  okRequests7d: number;
}

/** v4.2.1（v4.2.3 改源）：模型健康 sparkline 数据（GET /api/console/overview 附带；UsageDaily 模型维度） */
export interface ModelHealthData {
  days: string[]; // 日期轴（最旧 → 今日；长度 = 窗口天数 7/14/30）
  models: ModelHealthModel[]; // 按窗口内请求数 Top 6
  windowDays?: number; // v4.2.3b：窗口长度（7/14/30；缺省 7 向后兼容）
}

/** v4.3.2：服务质量 SLO —— 延迟分布直方图单桶（右开区间 [fromMs, toMs)；末桶闭区间含 max） */
export interface SloHistogramBucket {
  fromMs: number;
  toMs: number;
  count: number;
}

/** v4.3.2：服务质量 SLO（GET /api/console/overview 附带 24h 种子；insights?...&slo_hours= 切窗口） */
/** v4.4.0：成本聚合口径（与后端 CostAgg 同形；未计价请求单独回显，不估值） */
export interface CostAggShape {
  cost: number;
  pricedRequests: number;
  unpricedRequests: number;
}

/** v4.4.0：总览成本估算数据（GET /api/console/overview 附带；估算非计费） */
export interface CostData {
  today: { cost: number; pricedRequests: number; unpricedRequests: number };
  window7d: { cost: number; pricedRequests: number; unpricedRequests: number };
  window7dPrev: { cost: number };
  trend7d: Array<{ day: string; cost: number; unpricedRequests: number }>;
  topModels: Array<{ model: string; cost: number; requests: number }>;
  /** 已配置单价的模型数（0 = 空态引导去设置页） */
  pricingRows: number;
}

/** v4.4.0：模型单价行（GET/PUT /api/console/pricing；$/1M tokens） */
export interface PricingRow {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok: number;
  updatedAt: string;
  updatedBy: string;
}

/** v4.4.0：近 30 天未配置单价的模型（设置页一键补录 chips） */
export interface UnpricedModel {
  model: string;
  requests: number;
}

export interface PricingData {
  rows: PricingRow[];
  unpricedModels: UnpricedModel[];
}

// ---- v4.5.0：月度账单（GET /api/console/usage/billing?month=YYYY-MM） ----
export interface BillingModelRow {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: { cost: number; pricedRequests: number; unpricedRequests: number };
}

export interface BillingKeyRow {
  apiKeyName: string;
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  successRate: number | null;
  cost: { cost: number; pricedRequests: number; unpricedRequests: number };
  /** 该密钥的月度成本预算（$；0 = 未设/无同名虚拟密钥） */
  monthlyCostLimit: number;
  byModel: BillingModelRow[];
}

export interface BillingMonthTotals {
  requests: number;
  okRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  successRate: number | null;
  cost: { cost: number; pricedRequests: number; unpricedRequests: number };
}

export interface BillingData {
  month: string;
  prevMonth: string;
  /** 有数据的月份清单（降序 ≤ 12；当前月恒在） */
  months: string[];
  rows: BillingKeyRow[];
  totals: BillingMonthTotals;
  prevTotals: BillingMonthTotals;
  /** 当月未计价模型提示（补录引导） */
  unpricedModels: UnpricedModel[];
}

export interface PricingSaveResult {
  rows: PricingRow[];
  saved: number;
  deleted: number;
}

export interface SloData {
  windowHours: number; // 1/6/24
  /** 窗口内日志总条数（含错误请求） */
  samples: number;
  okCount: number;
  errCount: number;
  /** 成功率 0-100（1 位小数；samples=0 时 null） */
  successRate: number | null;
  /** 延迟分位数（毫秒；仅统计成功且有耗时记录的请求；样本 <5 时 null 避免误导） */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** 平均耗时（毫秒；口径同分位数） */
  avgMs: number | null;
  /** 流式请求数与占比 0-100 */
  streamCount: number;
  streamShare: number | null;
  /** 延迟分布直方图（线性等宽 20 桶；样本 <8 时为空数组） */
  histogram: SloHistogramBucket[];
}

/** v4.2.4：总览洞察独立 API 响应（GET /api/console/overview/insights?mh_days=&tp_days=&slo_hours=）——
 * 窗口切换不再触发整页 overview 重载（Task 42b 遗留清偿）；字段与主响应同形可作种子无缝切换 */
export interface OverviewInsightsData {
  model_health: ModelHealthData;
  /** 窗口内 Top 提供商（share 语义随窗口联动：占该窗口内全部请求数份额） */
  top_providers_7d: TopProviderRow[];
  /** Top 提供商实际窗口天数回显（7/14/30） */
  top_providers_window_days?: number;
  /** v4.3.2：服务质量 SLO（窗口回显 slo.windowHours） */
  slo?: SloData;
}

// ---- 账号管理 ----
export interface ConsoleAccount {
  id: string;
  providerId: string;
  name: string;
  enabled: boolean;
  credentials: Record<string, unknown>; // 掩码值
  balance: Record<string, unknown> | null;
  cooldownUntil: string | null;
  cooldownStreak?: number;
  /** v3.2.2：最近一次进入冷却的原因摘要（tooltip 展示） */
  cooldownReason?: string | null;
  lastCheckinAt: string | null;
  lastCheckinOk: boolean | null;
  lastRefreshAt: string | null;
  /** v3.0.4：近 24h 调用统计（无调用时 null）；v3.1.0 增 failures 精确失败次数 */
  stats24h?: { requests: number; successRate: number; failures?: number } | null;
  /** v3.8.0：最后调用时间（RequestLog 滚动窗口 MAX(createdAt)，按 providerId+accountId 复合维度） */
  lastUsedAt?: string | null;
  /** v3.0.6：今日 token 聚合（UsageDaily 按密钥名维度；账号行无密钥维度时不适用，保持 null） */
  todayStats?: { requests: number; inputTokens: number; outputTokens: number } | null;
}

export interface AccountsData {
  grouped: Array<{
    provider: { id: string; name: string; type: string };
    accounts: ConsoleAccount[];
  }>;
  total: number;
  enabled: number;
}

export interface ImportLineResult {
  index: number;
  status: "success" | "skipped" | "failed";
  providerId?: string;
  accountId?: string;
  reason?: string;
}

export interface ImportResult {
  success: number;
  skipped: number;
  failed: number;
  details: ImportLineResult[];
  /** v3.0.9：识别到的导入源格式（如 wb-switch-accounts） */
  format?: string;
  /** 格式说明与注意事项（识别到特殊格式时返回） */
  formatNote?: string;
}

// ---- API 中转（提供商） ----
export type ProviderType = "workbuddy" | "openai" | "anthropic" | "opencode" | "qwenweb";

export interface ProviderAccount {
  id: string;
  name: string;
  enabled: boolean;
  credentials: Record<string, unknown>; // 掩码值
  balance?: Record<string, unknown> | null;
  cooldownUntil?: string | null;
  lastCheckinAt?: string | null;
  lastCheckinOk?: boolean | null;
  lastRefreshAt?: string | null;
}

export interface ConsoleProvider {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  sortOrder?: number;
  proxyOverride: string | null;
  config: Record<string, unknown>; // 敏感字段掩码
  accounts: ProviderAccount[];
  accountCount: number;
  accountEnabledCount: number;
  /** v3.0.3：近 24h 调用统计（无调用时 null） */
  stats24h?: ProviderStats24h | null;
}

export interface ProviderStats24h {
  requests: number;
  successRate: number;
  avgDurationMs: number | null;
}

export interface NativeProviderPreset {
  id: string;
  type: string;
  label: string;
  region?: "cn" | "intl";
  baseUrl?: string;
}

export interface ProvidersData {
  providers: ConsoleProvider[];
  supportedTypes: ProviderType[];
  /** 原生项目预设提供商清单（提供商 ID 下拉框数据源；排序/展示与原生一致） */
  nativePresets?: NativeProviderPreset[];
  /** v3.8.0：模型健康一览（对外模型 × 路由候选 × 24h 调用健康） */
  modelHealth?: ModelHealthRow[];
}

/** v3.8.0：模型健康一览行（API 中转页） */
export interface ModelHealthRow {
  /** 对外模型名（ModelRoute.model） */
  model: string;
  enabled: boolean;
  /** 路由候选（failover 顺序） */
  candidates: Array<{ providerId: string; model: string; enabled: boolean; sortOrder: number }>;
  /** 近 24h 调用次数（无调用时 null，区别于真实 0） */
  calls24h: number | null;
  successRate24h: number | null;
  avgDurationMs: number | null;
  /** 滚动窗口内最后调用时间（全窗口 MAX(createdAt)） */
  lastUsedAt: string | null;
}

export interface ProviderTestResult {
  success: boolean;
  elapsedMs: number;
  message: string;
  balance?: number;
  modelsCount?: number;
  models?: string[];
  freeModels?: string[];
  region?: string;
  hasCredentials?: boolean;
  [key: string]: unknown;
}

// ---- 虚拟密钥 ----
export interface VirtualKeyRow {
  id: string;
  name: string;
  keyMasked: string;
  keyPrefix: string;
  enabled: boolean;
  models: string[];
  role: string;
  remark: string | null;
  /** v4.3.0：日配额（0 = 不限额）；超限网关入口 429（本地时区日自然重置） */
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  /** v4.5.0：月度成本预算（$/估算口径；0 = 不限）；超限网关入口 429（下月 1 日重置） */
  monthlyCostLimit?: number;
  /** v4.5.0：本月已累计估算成本（$，UsageDaily 当月行 × 单价表；与网关预算执行同口径） */
  monthCost?: number;
  createdAt: string;
  updatedAt?: string;
  /** v3.0.4：近 24h 调用统计（无调用时 null）；v3.1.0 增 failures 精确失败次数 */
  stats24h?: { requests: number; successRate: number; failures?: number } | null;
  /** v3.0.6：今日 token 聚合（UsageDaily 按日聚合，不受滚动日志窗口截断；无调用时 null） */
  todayStats?: {
    requests: number;
    okRequests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  } | null;
  /** v3.7.0：最后使用时间（RequestLog 滚动窗口 MAX(createdAt)；窗口中无记录时 null） */
  lastUsedAt?: string | null;
}

export interface KeysData {
  keys: VirtualKeyRow[];
}

export interface CreatedKey {
  id: string;
  keyValue: string;
}

// ---- 模型路由 ----
export interface RouteCandidateRow {
  id: number;
  providerId: string;
  model: string;
  enabled: boolean;
  sortOrder: number;
}

export interface RouteRow {
  id: number;
  model: string;
  enabled: boolean;
  candidates: RouteCandidateRow[];
}

export interface RoutesData {
  routes: RouteRow[];
  providers: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  /** 原生模型目录（按适配器类型归组；模型 ID 原样透传，候选项「模型」下拉框数据源） */
  providerModels?: Record<string, string[]>;
}

// ---- 路由试跑（v4.3.1 控制台调试工具）----
export interface RouteTestTraceEvent {
  type: "noroute" | "attempt" | "fatal" | "error" | "fail" | "retry" | "success" | "exhausted";
  /** 距 dispatch 开始的毫秒数 */
  t: number;
  index?: number;
  provider?: string;
  model?: string;
  status?: number;
  message?: string;
  summary?: string;
  action?: "cooldown" | "retry";
  account?: string | null;
  fallback?: boolean;
  contentType?: string;
  available?: string[];
  lastError?: string | null;
}

export interface RouteTestUsage {
  input?: number | null;
  output?: number | null;
  cached?: number | null;
}

/** 非流式响应结构（/api/console/routes/test JSON 信封内层） */
export interface RouteTestResult {
  status: number;
  latencyMs: number;
  meta: {
    account: string | null;
    upstreamModel: string | null;
    fallback: boolean;
    contentType: string;
  };
  trace: RouteTestTraceEvent[];
  body?: unknown;
  rawLength?: number;
  /** 以下为流式模式前端增量组装字段 */
  streamText?: string;
  sseEvents?: number;
  pings?: number;
  streamDone?: boolean;
  usage?: RouteTestUsage;
}

// ---- 定时任务 ----
export interface JobsConfig {
  checkinEnabled: boolean;
  checkinCron: string;
  checkinTz: string;
  /** v4.1.0：签到提供商白名单（空数组 = 全部支持签到的提供商） */
  checkinProviders: string[];
  keepaliveEnabled: boolean;
  keepaliveCron: string;
  keepaliveTz: string;
}

/** v4.1.0：可签到提供商候选（GET /api/console/jobs 下发，下拉选项数据源） */
export interface CheckinCandidate {
  id: string;
  name: string;
  type: string;
}

export interface JobRunRow {
  job: string;
  triggered: string;
  success: boolean;
  detail: string;
  startedAt: string;
}

export interface CheckinDetailRow {
  providerId: string;
  accountId: string;
  accountName: string;
  success: boolean;
  manual: boolean;
  result: string;
  createdAt: string;
  /** v3.1.0：幂等成功（上游 10001「今天已签到」等业务态，非真失败）——UI 显示灰色「已签到」徽标而非红色失败 */
  idempotentOk?: boolean;
  /** v3.1.1：失败原因分类（Task 16 遗留 #3）：idempotent=已签到 / activity_inactive=活动未开启 / credentials=凭据失效 / network=网络异常 / failure=真失败；成功行为 null */
  category?: string | null;
}

export interface JobsData {
  config: JobsConfig;
  /** v4.1.0：可签到提供商候选（下拉选项） */
  checkinCandidates?: CheckinCandidate[];
  recentRuns: JobRunRow[];
  lastCheckinDetail: CheckinDetailRow[];
}

export interface JobRunResult {
  job: string;
  detail: string;
}

// ---- 运行日志 ----
export interface LogRow {
  id: number;
  createdAt: string;
  model: string;
  protocol: string;
  providerId: string | null;
  accountId: string | null;
  durationMs: number | null;
  status: number | null;
  stream: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  apiKeyName: string | null;
  error: string | null;
  /** v3.0.3：true=上游精确 usage；false=网关字符估算；null=未知/未记录 */
  usageExact?: boolean | null;
  /** v4.4.0：行级成本估算（$；模型未配置单价 → null；前端淡态显示） */
  cost?: number | null;
}

export interface LogsData {
  items: LogRow[];
  total: number;
  /** v3.0.4：日志中出现过的提供商去重清单（按调用次数降序；筛选下拉数据源） */
  providers?: string[];
  /** v3.0.5：日志中出现过的密钥主体去重清单（按调用次数降序；筛选下拉数据源） */
  keys?: string[];
  /** v3.0.6：日志中出现过的（提供商 × 账号）组合去重清单（按调用次数降序；筛选下拉数据源） */
  accounts?: Array<{ providerId: string; accountId: string; label: string; requests: number }>;
  /** v3.9.0：日志中出现过的对外模型去重清单（按调用次数降序；模型筛选 datalist 数据源） */
  models?: string[];
}

// ---- 设置 ----
export interface ProxyLastTest {
  ok: boolean;
  exitIp?: string;
  elapsedMs?: number;
  error?: string;
  at: string;
}

export interface ProxySettings {
  enabled: boolean;
  list: string | string[];
  bypass: string[];
  lastTest?: ProxyLastTest | null;
  poolSize?: number;
}

export interface SettingsData {
  proxy: ProxySettings | null;
  corsAllowedOrigins: string[];
  listenLan: boolean;
  logLevel: string;
  checkinEnabled: boolean;
  checkinCron: string;
  checkinTz: string;
  keepaliveEnabled: boolean;
  keepaliveCron: string;
  keepaliveTz: string;
  maxContextTurns: number;
  usageProviderId: string | null;
  /** v3.2.2：操作审计保留天数（0 = 永久保留） */
  auditRetentionDays?: number;
  /** v3.7.0：余额快照保留天数（0 = 永久保留） */
  balanceRetentionDays?: number;
  /** v4.2.0：上游停滞熔断阈值 ms（0 = 默认 180s） */
  streamStallMs?: number;
  /** v4.2.0：undici 等待响应头超时 ms */
  upstreamHeadersTimeoutMs?: number;
  /** v4.2.0：undici body 字节间隔超时 ms */
  upstreamBodyTimeoutMs?: number;
  hasMasterKey: boolean;
  hasCronSecret: boolean;
  configVersion: number;
}

export interface ProxyTestResult {
  ok: boolean;
  exitIp?: string;
  elapsedMs: number;
  error?: string;
  scope?: string | { providerId: string; override: string | null };
  poolPreview?: string[];
  diagnostics?: { poolSize: number; currentIndex: number; cachedDispatchers: string[] };
  /** v3.6.0：测试模式（draft=按草稿逐地址实测 / direct=直连出口 / global=按生效配置） */
  mode?: "draft" | "direct" | "global";
  /** v3.6.0：draft 模式逐地址实测明细（地址已掩码，不回显凭据） */
  pool?: Array<{ masked: string; ok: boolean; elapsedMs: number; exitIp?: string; error?: string }>;
  /** v3.6.0：POST 响应附带更新后的测试历史（cap 20） */
  history?: ProxyTestRecord[];
}

/** v3.6.0：代理测试历史条目（设置页「测试历史」面板；SystemSetting proxyTestHistory 键） */
export interface ProxyTestRecord {
  ok: boolean;
  exitIp?: string;
  elapsedMs: number;
  error?: string;
  mode: "draft" | "direct" | "global";
  pool?: Array<{ masked: string; ok: boolean; elapsedMs: number; exitIp?: string; error?: string }>;
  at: string;
}

export interface MigrateReport {
  summary: {
    createdProviders: number;
    createdAccounts: number;
    skippedProviders: number;
    createdRoutes: number;
    createdKeys: number;
    skippedKeys: number;
    warnings: string[];
  };
  report: Array<{ section: string; action: string; detail: string }>;
  message: string;
}

// ---- 备份导入（v4.1.0：POST /api/console/backup，uag-backup-v1 整包恢复）----
export interface ImportCounts {
  providers: number;
  accounts: number;
  routes: number;
  candidates: number;
  keys: number;
  settings: number;
  checkinLogs: number;
  requestLogs: number;
}

export interface ImportReport {
  mode: "merge" | "overwrite";
  counts: ImportCounts;
  warnings: string[];
  report: Array<{ section: string; action: string; detail: string }>;
  message: string;
}

/** 备份文件客户端解析预览（选择文件/粘贴后立即展示分区条数，不做任何写入） */
export interface BackupPreview {
  format: string;
  version: string;
  exportedAt: string;
  containsSecrets: boolean;
  sections: {
    providers: number;
    accounts: number;
    routes: number;
    candidates: number;
    virtualKeys: number;
    settings: number;
    checkinLogs: number;
    requestLogs: number;
  };
}

export interface SettingsSaveResult {
  updated: string[];
  regenerated?: string[];
  message?: string;
}
