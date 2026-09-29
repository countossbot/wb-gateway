# Grok / xAI 提供商融合方案（调研文档 · 未实施）

> 状态：**仅调研与设计，未修改任何代码**。
> 目标仓库：`universal-ai-gateway` @ `ea415c8`（v0.2.1，TypeScript / Next.js 15 + Prisma + SQLite）
> 来源仓库：**`chenyme/grok2api` @ v3.1.6（Go，MIT 许可）** —— 已替换原 `AuuCoder/gptGrok2api`
> 调研方式：两个 explorer 子智能体并行审计 + 主对话逐点核验行号。
>
> **本次范围**：**仅文本对话**（Chat Completions / Responses / Anthropic Messages）。**图片、视频、语音、媒体一律不做。**

---

## 0. 一句话方案

**在「API 中转」里新增一个独立的提供商 ID `grok`，走既有的插件化扩展点接入，只做文本对话。**

```ts
// src/lib/gateway/providers/index.ts —— 加 1 行 import + 1 行 register
import { GrokProvider } from "./grok/index";
registerProvider("grok", GrokProvider);
// 新增 src/lib/gateway/providers/grok/ 目录，与 openaiStandard.ts 平级
// 现有 openaiStandard.ts / anthropicStandard.ts / workbuddy/ 零改动
```

这不是折中，而是仓库自己设计好的扩展方式。`providers/index.ts:1` 注释原文：

> `// 内置供应商接线：新增供应商时加一行 registerProvider 即可，createProvider 逻辑零改动。`

---

## 1. 为什么换来源：chenyme/grok2api 明显更合适

| 维度 | 原 `AuuCoder/gptGrok2api` | **新 `chenyme/grok2api`** |
|:---|:---|:---|
| 语言 | Python（逆向脚本风格） | **Go，462 个文件，工程化** |
| 许可 | 未确认 | **MIT（`LICENSE:1`，Copyright (c) 2026 Chenyme）** |
| 版本 | — | **v3.1.6**（`VERSION`） |
| 提供商抽象 | 散落的 `xai_*.py` | **声明式 `Definition` 能力注册表**（`provider/definition.go`） |
| 文本路径 | Web 逆向 + Console | **Build（OAuth 设备码）/ Web / Console 三条** |
| OAuth | 有但未确认 | **完整实现**，`client_id` 与我方 JSON **完全一致** |
| Anthropic | 自述「❌ 待实现」 | **原生支持**（`conversation/messages_*.go`） |
| 图片/视频/语音 | 有（**本次不需要**） | 有（**本次直接忽略**） |
| 工程参考价值 | 低 | **高**：可直接对照实现 TS 版 |

**关键**：新项目的 `provider/definition.go` 把「一个 provider 必须声明什么能力」做成了**显式结构化声明**（含 `InferencePolicy`），这正是本网关 `contract.ts` 想做的事。两者理念一致，移植路径清晰。

---

## 2. 新来源的三重 Provider 架构（文本相关部分）

### 2.1 三条路径对比

| | **Grok Build**（推荐） | Grok Web | Grok Console |
|:---|:---|:---|:---|
| 目录 | `infra/provider/cli/` | `infra/provider/web/` | `infra/provider/console/` |
| 上游端点 | `https://cli-chat-proxy.grok.com/v1` | `https://grok.com` | `https://api.x.ai/v1` |
| 鉴权 | **OAuth Bearer**（设备码） | SSO cookie + Statsig 签名 | API Key |
| 需要浏览器 | ❌ 不需要 | ✅ 需要（`egress` + FlareSolverr） | ❌ 不需要 |
| 模型清单 | **动态发现**（读上游 `/models`） | 内置目录 | 内置目录 |
| 实现规模 | `cli/` 约 **18000 行**（含测试） | 中等 | 较小 |
| **本次建议** | **✅ 首选，唯一必做** | ❌ 不做 | ⚠️ 可选兜底 |

### 2.2 选路逻辑

`provider/provider.go`（1468 行）是注册表与能力矩阵中心；每个 provider 通过 `Definition` 声明能力边界，由统一网关按能力选路。**README:145「Provider 边界」**明确三者隔离。

> **移植结论**：TS 版**只需实现 Build 一条路径**。Web / Console 留作将来的独立 provider 类型（`grok-web` / `grok-console`），与 `grok` 平级，互不影响。

---

## 3. Grok Build 协议细节（可直接移植，全部常量已核验）

### 3.1 端点

```
主端点:  https://cli-chat-proxy.grok.com/v1/responses     （对话，SSE）
模型发现: https://cli-chat-proxy.grok.com/v1/models
余额:    https://cli-chat-proxy.grok.com/v1/billing
刷新:    https://auth.x.ai/oauth2/token                   （grant_type=refresh_token）
设备码:  https://auth.x.ai/oauth2/device/code
```

配置默认值（`infra/config/config.go:893-905`）：`BaseURL: "https://cli-chat-proxy.grok.com/v1"`，另有 `FallbackBaseURL`（`cli/adapter.go:40`）与 `responses_compaction_forward.go:67` 的 `primaryBaseURL()` 兜底机制。

### 3.2 请求头（`cli/adapter.go:1111` 的 `applyHeaders`，**完整原文核验**）

函数签名：`applyHeaders(req, credential, accessToken, model, promptCacheKey string, trace bool)`

```go
req.Header.Set("Authorization", "Bearer " + accessToken)
req.Header.Set("X-XAI-Token-Auth", cfg.TokenAuth)                  // 默认 "xai-grok-cli"
req.Header.Set("x-grok-client-version", cfg.ClientVersion)         // 默认 "1.0.40"
req.Header.Set("x-grok-client-identifier", cfg.ClientIdentifier)   // "grok-shell"
req.Header.Set("x-grok-client-mode", cfg.ClientMode)               // 模式头
req.Header.Set("Accept", "application/json")
req.Header.Set("Accept-Encoding", "gzip")
req.Header.Set("User-Agent", cfg.UserAgent)                        // "grok-shell/<version>"
if model != "" { req.Header.Set("x-grok-model-override", model) }  // 指定模型时
if credential.Email != "" { req.Header.Set("x-email", credential.Email) }
```

调用点与 `trace` 取值：

| 行号 | 场景 | trace |
|:---|:---|:--:|
| `:618` | **对话请求（`/responses`）** | **`true`** |
| `:924` | `/models` 模型发现 | `false` |
| `:1260` / `:1289` | billing 等辅助请求 | `false` |

**`trace = true` 时额外注入的头**（对话请求必带）：

```go
req.Header.Set("x-authenticateresponse", "authenticate-response")
req.Header.Set("x-grok-agent-id", a.agentID)
if sessionID != "" {                                  // 仅在存在稳定会话时
    req.Header.Set("x-grok-session-id", sessionID)
    req.Header.Set("x-grok-conv-id", sessionID)
    req.Header.Set("x-grok-conv-group-id", grokConversationGroupID(sessionID))
}
req.Header.Set("x-grok-req-id", requestID)            // 每请求新 UUID
if credential.UserID != "" { req.Header.Set("x-grok-user-id", credential.UserID) }
// + W3C traceparent 的 trace-id / span-id（randomHex(16) / randomHex(8)）
```

> ⚠️ **关键坑（源码注释原文，`adapter.go:1121-1123`）**：
> `// Never generate a random UUID per request; it breaks xAI session affinity and keeps cached_tokens at zero.`
> —— **绝不能每请求随机生成 session id**，否则会破坏 xAI 的会话亲和性，导致 prompt cache 完全不命中（`cached_tokens` 恒为 0）。session id 必须由稳定的 key 派生（`grokSessionID()`：UUID 直接规范化，否则 `uuid.NewHash(sha256, NAMESPACE_URL, "grok2api:session:"+key, 8)` 派生）。
>
> 另有 `x-grok-turn-idx`（`applyGrokTurnIndexHeader`，`adapter.go:670`）：**仅在已有 `x-grok-session-id` 时才转发**，且官方协议里该字段可选 —— **不要伪造**。

> ⚠️ **必须带的头共 9 个**：`Authorization`、`X-XAI-Token-Auth`、`x-grok-client-version`、`x-grok-client-identifier`、`x-grok-client-mode`、`Accept`、`Accept-Encoding`、`User-Agent`，以及 `x-grok-model-override`（当指定模型时）。**文档初稿曾漏掉 `x-grok-client-mode` 与 `x-grok-model-override`**，以本节为准。

**`x-grok-client-surface` 不在对话头里**（`oauth.go:338` 仅设备码流程使用，值 `"ui"`，见 `oauth.go:24`）—— 对话请求**不需要**它。

配置默认值（`config.go:32-33`）：

```go
RecommendedBuildClientVersion = "1.0.40"
```

> ⚠️ **与旧来源（gptGrok2api）的差异**：旧来源写死 `x-grok-client-version: 0.2.93`，**新来源推荐 `1.0.40`**。以新来源为准，且应做成**可配置**（上游会变，`config.go:32` 命名为 `Recommended*` 也说明这点）。

### 3.3 OAuth 常量（`cli/oauth.go:20-21`，原文）

```go
defaultOAuthClientID = "b1a00492-073a-47ea-816f-4c329264a828"
defaultOAuthScope    = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write"
```

**与我方 JSON 样本对照**：`client_id` **完全一致** ✅；scope 我方 JSON 缺 `workspaces:read workspaces:write`（说明我方 JSON 是**子集**，`grok-cli:access` 等关键项都在，**可用**）。

另有 `x-grok-client-surface` 头（`oauth.go:338`，`deviceClientSurface`）。

### 3.4 模型清单：动态发现，不要硬编码

**README:243 原文**：

> Build 不使用全局固定模型清单。账号同步会读取上游 `/models`，不同账号、订阅等级或灰度批次可能返回不同模型，网关按账号能力参与调度，不会用单个账号覆盖全局目录。

**移植结论**：TS 版 **必须**调 `/models` 动态发现，**不要**在代码里写死模型 id 列表。这正好对应本网关 `ProviderAdapter` 注释里预留的能力位：

> `/** 上游模型目录拉取（可选）：失败时调用方降级 derived 推导目录 */`

### 3.5 工具调用：原生支持

`cli/` 目录下有完整的工具调用实现（**非 prompt 注入**）：

- `responses_tools.go` / `responses_tool_declarations.go` / `responses_tool_choice.go` / `responses_tool_types.go` / `responses_tool_state.go`
- `responses_codex_tools.go`（Codex 兼容）
- `responses_arguments.go`（参数解析）

**移植结论**：这是**原生 tools 通路**，直接映射到网关 `ChatPayload.tools`，**无需**旧来源那套 `tool_prompt/parser/sieve`。工作量大幅下降。

### 3.6 其他有用机制（文本相关）

| 文件 | 作用 | 移植价值 |
|:---|:---|:---|
| `cli/responses_reasoning_recovery.go` | 推理内容恢复 | 中（映射到网关 reasoning 通道） |
| `cli/responses_compaction.go` | 长上下文压缩 | 低（阶段二+） |
| `cli/responses_history.go` | 对话历史管理 | 中 |
| `cli/responses_cache_route.go` | **Prompt Cache 路由** | 中（对应 README:294） |
| `cli/streamidle.go` / `semantic_streamidle.go` | 流式空闲超时检测 | **高**（防上游挂起） |
| `cli/session_id_test.go`（对应 `adapter.go:671`） | `x-grok-session-id` / `x-grok-conv-id` 会话粘性 | 中 |
| `cli/fallback.go` | 主/备 baseURL 切换 | **高** |
| `cli/normalize.go` | 请求归一化 | 中 |
| `cli/billing.go` | 余额查询 | 高（映射 `getBalance`） |

---

## 4. 限流与错误处理（关键的语义差异）

### 4.1 上游机制（`infra/provider/rate_limit.go`，171 行）

- 解析上游返回的**限流元数据**（JSON + 正则 + header 多来源）
- `parseRetryAfterHeader`（`:162`）解析 `Retry-After`
- 把 `RetryAfter` 回写成响应头给客户端（`:47`）
- **429 是限流，不是账号失效**

### 4.2 账号状态机（`domain/account/account.go:109-110`）

```go
AuthStatusActive         AuthStatus = "active"
AuthStatusReauthRequired AuthStatus = "reauthRequired"
```

凭证结构（`account.go:145-175`）关键字段：

```go
AuthType                      AuthType
Email / UserID / TeamID       string
OIDCClientID                  string     // ← 对应我方 JSON 的 client_id
EncryptedAccessToken          string
EncryptedRefreshToken         string
EncryptedCloudflareCookie     string     // ← Web 路径用，本次不需要
ExpiresAt                     time.Time
RefreshDueAt                  *time.Time // ← 提前刷新锚点
RefreshFailureCount           int
RefreshPermanent              bool
AuthStatus                    AuthStatus
ReauthMarkedAt                *time.Time
Priority / MaxConcurrent      int
```

**亮点**：`RefreshDueAt`（**到期前主动刷新**）+ `RefreshFailureCount`（**连续失败计数**）+ `RefreshPermanent`（**永久失败标记**）+ `ReauthMarkedAt`（**需重新授权的时间锚点**）。这套设计比本网关现有的 `cooldownStreak` 更精细，**建议借鉴**。

### 4.3 ⚠️ 与本网关的语义冲突（必须处理）

本网关 `core/scheduler.ts` 的错误分类（已核验）：

```
HTTP 429 或 bizCode 403  →  "cooldown"
```

而 grok2api 的语义是：**429 = 限流（可恢复，短冷却）**，**不是失效**。

| 场景 | grok2api 语义 | 本网关现状 | 风险 |
|:---|:---|:---|:---|
| 429 | 限流，短冷却，账号保留 | `cooldown` | ⚠️ 若冷却时间过长，**白白浪费账号** |
| 401/403 | 先刷新 token 重试；再失败才标记失效 | `cooldown`（403） | ⚠️ 未区分「可刷新」与「真失效」 |

**处理建议**：不要改 `scheduler.ts` 的全局语义（会影响现有 3 个 provider）。**在 grok 适配器内部自行处理**——捕获 401/403 先走一次 token 刷新重试，把结果归一化后再抛给 framework，让 429 落到短冷却。

---

## 5. 网关侧落点（已逐行核验）

### 5.1 注册表（`providers/registry.ts` 全文 41 行）

```ts
const registry = new Map<string, ProviderClass>();

export function registerProvider(type: string, ProviderClass): void {   // :11-26
  // :15-19  非空字符串 type + 构造函数校验（会抛错）
  // :21-24  「同类型不同构造器」抛错；同一构造器重复注册幂等（测试/热重载安全）
  registry.set(type, ProviderClass);                                    // :25
}
export function supportedProviderTypes(): string[] { return [...registry.keys()]; }  // :28-30
export function createProvider(providerConfig, env) {                   // :32-41
  const ProviderClass = registry.get(providerConfig.type);              // :34
  if (!ProviderClass) {
    // :36-37  不是抛错：console.warn + return null（历史 DB 残留类型时跳过，避免整条网关启动失败）
    console.warn(`Skip unsupported provider type "..." (...).`);
    return null;
  }
  return new ProviderClass(providerConfig, env);                        // :40
}
```

**结论**：能自由注册 `"grok"`，且自带防呆。

### 5.2 契约（权威文件是 `core/contract.ts`，**不是** `types.ts`）

`core/contract.ts:1-3` 注释原文：

> `// Provider 契约 —— 把「一个 provider 适配器必须实现什么」从散落在 fleet.js 各处的鸭子类型探测，收敛为单一、有文档、可测试的定义。`

`core/types.ts:134` 的 `ProviderAdapter` 是**能力子集**，全部方法可选：

```ts
export interface ProviderAdapter {
  id: string; name: string; type: string;
  forceStream?: boolean;
  callChat?: (payload: ChatPayload, options?: CallOptions) => Promise<Response>;
  callMessages?: (payload: Record<string, unknown>, options?: CallOptions) => Promise<Response>;
  getBalance?: () => Promise<BalanceResult>;
  onSchedule?: () => Promise<unknown>;
  doDailyCheckin?: () => Promise<unknown>;
  refreshAccessToken?: (account?: unknown) => Promise<unknown>;
  /** 上游模型目录拉取（可选）：失败时调用方降级 derived 推导目录 */
}
```

**阶段一只需实现**：`callChat` + `callMessages` + `getBalance` + `refreshAccessToken`。

### 5.3 数据模型（零 migration）

```prisma
model Provider {                    // schema.prisma:53
  id             String   @id       // :55  自由主键 → "grok" 就是独立条目
  type           String             // :56  // workbuddy | openai | anthropic ← 加 "grok"
  config         Json               // baseUrl / 客户端版本等非凭据配置
  proxyOverride  ...
}
model Account {                     // :67
  credentials     Json   // :73  {userId,accessToken,refreshToken} | {apiKey} | {token,cookie,fingerprint} | {}
  balance         Json?  // :74
  cooldownUntil / cooldownStreak / cooldownReason   // 冷却字段已有
}
```

**结论**：`Provider.type` 自由字符串、`Account.credentials` 是 `Json` → **新增 grok 无需任何 migration**。

### 5.4 配置常量（`config/configService.ts`）

```ts
// :59  注释原文：---- 原生项目预设提供商清单（「新增中转」提供商 ID 下拉框数据源） ----
export const NATIVE_PROVIDER_PRESETS = [
  { id: "workbuddy",      type: "workbuddy", label: "WorkBuddy（国内站）", region: "cn" },   // :70
  { id: "workbuddy-intl", type: "workbuddy", label: "WorkBuddy（国际站）", region: "intl" }, // :71
  { id: "openrouter",     type: "openai",    label: "OpenRouter（OpenAI 兼容）",
    baseUrl: "https://openrouter.ai/api/v1" },                                                // :72
];

// :75-80  NATIVE_PRESET_TYPE —— ⚠️ 全仓 Grep 验证：**无任何引用，死代码**，别改它

// ---- 脱敏契约 ----
const SECRET_FIELDS = ["accessToken", "refreshToken", "apiKey", "cookie", "token", "jwtToken"];  // :83
```

**安全必改**：`SECRET_FIELDS` 需补 `clientId`、`sso`、`cfClearance`（`cookie`/`token` 已在）。

### 5.5 前端类型与硬编码

```ts
// src/lib/console/types.ts:406
export type ProviderType = "workbuddy" | "openai" | "anthropic";   // ← 加 | "grok"

// src/lib/console/format.ts:163
export const PROVIDER_TYPE_META: Record<string, {label;desc;defaultBaseUrl?;icon}> = {...};
// Record<string,…> → 加键不改类型

// src/components/console/providers.tsx:66-70
const TYPE_ICONS: Record<string, React.ElementType> = { workbuddy:…, openai:…, anthropic:… };
// :526  TYPE_ICONS[p.type] || Server     ← ✅ 有兜底
// :767  TYPE_ICONS[t]                    ← ❌ **无兜底！必改**
```

> ⚠️ **最易漏的必改项**：`:767` 渲染类型下拉框时用 `Object.entries(PROVIDER_TYPE_META)` 驱动，加了 `grok` 键就必然执行 `TYPE_ICONS["grok"]`。缺了会渲染 `<undefined />` 报错。**`TYPE_ICONS.grok` 是必须项，不是可选美化。**

### 5.6 账号池复用

`providers/standardPool.ts`（198 行）的 `callWithAccountPool` 提供：取账号 → 调 adapter → 失败分类 → 记冷却 → 试下一个。**grok 直接复用，不重复造。**

### 5.7 签到白名单（不涉及）

`jobs/scheduler.ts` 有 `CHECKIN_CAPABLE_TYPES` 集合，仅用于控制台下拉候选与白名单预检 —— **grok 不做签到，无需加入**。

---

## 6. 完整改动清单

### A. 全新文件（不触碰任何现有代码）

| 文件 | 内容 | 规模估计 |
|:---|:---|:---|
| `providers/grok/index.ts` | `GrokProvider implements ProviderAdapter` | ~150 行 |
| `providers/grok/buildClient.ts` | `cli-chat-proxy.grok.com/v1` 客户端（请求头、SSE、错误归一化） | ~250 行 |
| `providers/grok/oauth.ts` | token 刷新 + 设备码流程 | ~150 行 |
| `providers/grok/models.ts` | 动态模型目录发现 | ~80 行 |
| `providers/grok/types.ts` | 凭据/配置类型定义 | ~60 行 |
| `providers/grok/importJson.ts` | 接受 §7 的 JSON 凭据包 | ~80 行 |

### B. 注册接线（2 行）

| 文件 | 改动 |
|:---|:---|
| `providers/index.ts` | `+ import { GrokProvider } from "./grok/index";`<br>`+ registerProvider("grok", GrokProvider);` |

### C. 控制台呈现（**6 处**，其中 3 处是硬性必改）

> ⚠️ 本节已被 §11 修正。下表为**修正后**的完整清单，比初稿多 2 处（`ui.tsx` 的两处穷尽映射，不补会导致 `tsc` 编译失败）。

| 文件 | 改动 | 性质 |
|:---|:---|:---|
| `config/configService.ts:70-72` | 数组加 1 项 `{ id:"grok", type:"grok", label:"Grok / xAI", baseUrl:"https://cli-chat-proxy.grok.com/v1" }` | 加数组元素 |
| `console/types.ts:406` | `ProviderType` 加 `\| "grok"` | 加联合成员 |
| **`console/ui.tsx:271`** | **`TYPE_BADGE_STYLE` 加 `grok`** | **必须（穷尽映射，编译失败）** |
| **`console/ui.tsx:274`** | **`TYPE_LABEL` 加 `grok`** | **必须（穷尽映射，编译失败）** |
| `console/format.ts:163` | `PROVIDER_TYPE_META` 加 `grok` 键 | 加 Record 键（宽松） |
| `console/providers.tsx:66-70` | `TYPE_ICONS` 加 `grok` | **必须**（`:767` 无兜底） |
| **`console/setup-wizard.tsx:67`** | **`buildSetupProvider` 加 `grok` 凭据分支** | 必须（若向导引导 grok） |

### D. 安全必改

| 文件 | 改动 |
|:---|:---|
| `config/configService.ts:83` | `SECRET_FIELDS` 补 `clientId`、`sso`、`cfClearance` |

### E. 文档/注释

| 文件 | 改动 |
|:---|:---|
| `prisma/schema.prisma:56` | `type` 注释补 `\| grok`（纯注释，无迁移） |

### F. 明确不改

`registry.ts`、`contract.ts`、`core/scheduler.ts`（错误语义不动，在适配器内消化）、`standardPool.ts`、`openaiStandard.ts`、`anthropicStandard.ts`、`workbuddy/*`、`proxy/*`、`exchange/*`、`responses/*`、`app/v1/**` 全部路由、`auth/*`、`quota.ts`、`jobs/scheduler.ts`。

**改动总量**：新建 6 个文件（约 770 行 TS）+ 修改 **11 处**、合计约 20 行（详见 §11.7）。

> 📌 **运行前置条件（非代码改动）**：grok 的每个模型必须在控制台**显式配置 ModelRoute**，否则 `/v1/*` 一律 404（`dispatch.ts:104-124`）。详见 §11.2。

---

## 7. 凭据格式定稿

### 7.1 沿用已确认的 OAuth JSON（第二份样本）

`client_id` 与 grok2api 的 `defaultOAuthClientID` **完全一致**，scope 是其子集但关键项齐全 → **可用**。

```json
{ "accounts": [ {
  "provider": "grok_build", "name": "…", "email": "…",
  "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
  "access_token": "<ES256 JWT, TTL 6h>",
  "refresh_token": "<86 字符>",
  "token_type": "Bearer", "expires_at": "<RFC3339>",
  "user_id": "<UUID>"
} ] }
```

实测：106 个账号，`access_token` TTL 恒 6 小时，scope 含 `offline_access`（可续期），`sub`/`jti` 各 106 唯一值。

> 样本中 access_token **已全部过期**，但 refresh_token 可复活。

### 7.2 `GrokCredentials`（定稿）

```ts
// providers/grok/types.ts
export interface GrokCredentials {
  accessToken: string;      // ES256 JWT
  refreshToken: string;     // offline_access
  clientId: string;         // 默认 b1a00492-073a-47ea-816f-4c329264a828
  expiresAt?: string;       // RFC3339；据此提前刷新
  userId?: string;
  email?: string;           // 元数据
  provider?: string;        // "grok_build"
}

export interface GrokProviderConfig {
  baseUrl: string;              // https://cli-chat-proxy.grok.com/v1
  fallbackBaseUrl?: string;     // 主端点失败时切换
  clientVersion: string;        // 默认 "1.0.40"（可配置，上游会变）
  clientIdentifier: string;     // "grok-shell"
  tokenAuth: string;            // "xai-grok-cli"
}
```

**本次不含** `sso` / `cfClearance`（那是 Web 路径，本次不做）。

### 7.3 刷新策略（借鉴 grok2api 的 `RefreshDueAt`）

- 存 `expiresAt`，**到期前提前刷新**（建议提前 10–15 分钟，对应 `RefreshDueAt` 语义）
- 记录 `refreshFailureCount`，连续失败 N 次标记永久失效（对应 `RefreshPermanent`）
- 401/403 → 先刷新重试一次 → 仍失败才交给 framework 冷却
- **429 → 短冷却，账号保留**

---

## 8. 分阶段实施计划（已按「不做多模态」裁剪）

### 阶段一：Grok Build 文本链路（唯一必做阶段）

1. 新建 `providers/grok/`：`types.ts` → `oauth.ts` → `buildClient.ts` → `models.ts` → `index.ts`
2. `providers/index.ts` 加 2 行
3. `configService.ts` 加预设 + **`SECRET_FIELDS` 补字段（安全项）**
4. `console/types.ts:406` 加 `| "grok"`
5. `console/format.ts:163` 加元数据
6. `console/providers.tsx:66` 加 `TYPE_ICONS.grok`（**必须**）
7. `importJson.ts` 支持导入 §7.1 的 JSON

**验收**：
- 控制台「API 中转」出现独立条目 `grok`
- 导入 JSON → 账号入库且 token 自动刷新
- `POST /v1/chat/completions` 返回流式内容
- `POST /v1/messages`（Anthropic 格式）同样可用
- 401 时自动刷新重试；429 时短冷却不废号
- `GET /v1/models` 返回动态发现的 grok 模型

### 阶段二：健壮性增强（可选）
- 流式空闲超时（借鉴 `streamidle.go`）
- 主/备 baseURL 切换（借鉴 `fallback.go`）
- 会话粘性 `x-grok-session-id` / `x-grok-conv-id`
- Prompt Cache 路由（借鉴 `responses_cache_route.go`）

### ❌ 明确不做（本次范围外）
- **图片生成 / 图片编辑**（`cli/` 有实现，不做）
- **视频生成**（`cli/video.go`，不做）
- **语音 / LiveKit**（不做）
- **媒体素材上传**（不做）
- **Grok Web 路径**（需 FlareSolverr + Statsig 签名 + TLS 指纹，成本高）
- **Grok Console 路径**（可选兜底，阶段一不做）
- 任何 Python 来源的组件（已整体弃用旧来源）

---

## 9. 风险与待确认项

### 9.1 风险

| 风险 | 等级 | 缓解 |
|:---|:--:|:---|
| **错误语义冲突（429）** | **高** | 适配器内归一化，不依赖 `scheduler.ts` 的全局语义（§4.3） |
| **clientVersion 会过期** | 中 | 做成可配置（`config.go:32` 又名 `Recommended*`），不要硬编码 |
| **refresh_token 泄露** | **高** | 长期有效可换新 token；`SECRET_FIELDS` 必须覆盖 |
| **上游协议变化** | 中 | 只走官方 CLI 端点（非逆向），有主/备 baseURL |
| **动态模型目录失败** | 低 | 降级用 derived 推导目录（契约已预留） |
| **Go→TS 移植偏差** | 中 | 对照具体文件逐函数移植，不凭记忆 |

### 9.2 实施前需核验

1. `cli/oauth.go` 的**设备码流程完整步骤**（本次先支持导入已有 token，设备码可后置）
2. `/billing` 返回结构（用于 `getBalance`）
3. grok2api 的 **Prompt Cache** 机制细节（`responses_cache_route.go`，阶段二）
4. `x-grok-session-id` / `x-grok-conv-id` 的确切生成规则（阶段二）
5. 是否需要 `x-grok-client-surface` 头（`oauth.go:338` 仅设备码流程用，对话请求未必需）

---

## 10. 附：证据边界

- 来源代码：`git clone --depth 1` 至会话 scratch 目录，**只读**，未执行任何 Go 代码。
- 目标代码：**只读**遍历，未修改任何文件。
- 本文所有行号引用均来自本次实际读取，可直接复核。
- **凭据安全**：用户提供的两份样本（106 组 OAuth 凭证、30 组账号密码）**均未写入本仓库**，已用脚本逐字段比对确认零泄漏。
- 旧来源 `AuuCoder/gptGrok2api` 的调研结论（原 §11/§12）已作废；其唯一仍有效的结论是「那份三段式账号密码格式不可用」，理由为：`session_id` 在该仓库零命中、无 refresh_token、无 `exp`。

---

## 11. 对抗式审查结论（对本文档的修正）

> 由一个独立的 code-reviewer 子智能体对本方案做**证伪**审查，主对话逐条复核。
> 下列 4 项是**真实遗漏**，已修正；未修正的一律不写入。

### 11.1 🔴 严重 · 漏了前端穷尽映射（会导致 `tsc` 编译失败）

我原先只找到 `format.ts` 与 `providers.tsx` 的 `Record<string, …>`（宽松），**漏了真正穷尽的那两个**：

```ts
// src/components/console/ui.tsx:271-279
const TYPE_BADGE_STYLE: Record<ProviderType, string> = { workbuddy:…, openai:…, anthropic:… };
const TYPE_LABEL:       Record<ProviderType, string> = { workbuddy:…, openai:…, anthropic:… };
```

`Record<ProviderType, …>` 是**穷尽映射**（不是 `Record<string,…>`）。而 `tsconfig.json:11` 是 `"strict": true`。

**后果**：只加 `ProviderType |= "grok"` 而不补这两个常量 → **`tsc` 直接报错**（缺 `grok` 属性），构建失败。

**必改项新增 2 处**：`ui.tsx:271` 的 `TYPE_BADGE_STYLE`、`ui.tsx:274` 的 `TYPE_LABEL`。

> 附带发现：`TypeBadge`（`ui.tsx:281`）有 `in TYPE_LABEL` 守卫兜底，所以**运行时**不会崩；但**编译期**会崩。两者都要过。

### 11.2 🔴 严重 · 漏了「模型路由必须显式配置」

`src/lib/gateway/exchange/dispatch.ts:104-124` 原文逻辑：

```ts
const candidates = routes[model] || routes[cleanModel];
if (!candidates || candidates.length === 0) {
  finishLog(404, `No route configured for model "${model}"`);
  return new Response(JSON.stringify({ error: { message:
    `No route configured for model "${model}". Available models: …. To use this model, please add an explicit route in the configuration.` } }),
    { status: 404, … });
}
```

注释原文（`dispatch.ts:107-108`）：
> `// 路由模糊回退已改为显式 opt-in（issue #04）。仅当 routes 中存在精确匹配时才使用配置的路由，否则返回 404 错误并提供可用模型建议。`

**后果**：光注册 provider **不够**。grok 的每个模型都必须在 `ModelRoute` 里有**显式路由**，否则 `/v1/chat/completions` 一律 404 —— 且报错信息会把「未配置路由」说成模型不存在，**极易误判为 provider 没接好**。

**新增前置条件**：`DEFAULT_ROUTES`（`configService.ts:23`）是否要把 grok 加进去？**建议不要**——该常量是「与原生项目保持一致的默认路由」，硬塞 grok 会改变现有用户的路由行为。改为：**在控制台引导用户手动建路由，或在 `importJson.ts` 导入账号后顺带提示/预建路由**。

### 11.3 🟠 中等 · `classify` 的语义可被 adapter 绕过（结论修正）

我原先说「在适配器内归一化」但没说清**怎么做**。实际机制在 `core/failover.ts:5-14` 注释里有：

```ts
//   - `{ fail: { status, text, json?, response?, force? } }` —— 失败；由 classify 定去留。
//       force: "retry" —— 调用方断言「这次失败是当前项特有的」，即使 classify 判 fatal 也切换。
//       只用于调用方能证明换项有用的场景。
//       被 force 的失败在 onRetryable 里按 "retry" 上报（不惩罚，只切换）。
```

实现：`failover.ts:71` `if (action === "fatal" && fail.force !== "retry") return fail.response;`

**修正后的正确做法**（grok 适配器内部）：

1. 收到 401/403 → **先自行刷新 token 并用同一账号重试一次**
2. 刷新仍失败 → 抛 `{ fail: { status, text, response, force: "retry" } }`
   —— **使用 `force: "retry"` 跳过 `classify` 的 fatal 判定**（否则 403 会被当 fatal 直接返回给客户端，账号也不会切换）
3. 429 → 让 framework 按原样处理（`cooldown`）

> 这修正了我原方案 §4.3 的表述：**不需要改 `scheduler.ts`**，`force: "retry"` 就是官方留的逃生舱。

### 11.4 🟠 中等 · 漏了初始化向导

`src/components/console/setup-wizard.tsx:63-72` 的 `buildSetupProvider()` 按 type 分支构造凭据：

```ts
if (d.type === "workbuddy") { p.region, p.userId, p.accessToken, p.refreshToken }
else if (d.type === "openai" || d.type === "anthropic") { p.apiKey }
```

**后果**：若首次初始化时选 grok，会走到 `else` 分支落空 → 凭据为空。

**必改项新增**：`setup-wizard.tsx:67` 加 `grok` 分支（`accessToken` / `refreshToken` / `clientId`）。**若不做首屏向导引导 grok，可延后**，但需在文档中标注为已知缺口。

### 11.5 🟡 轻 · 源侧请求头漏项（已修正，见 §3.2）

审查确认并**加强了**我先前的修正：对话路径（`adapter.go:618`，`trace=true`）**必需**的头比我文档初稿多得多，包括：

`x-authenticateresponse`、`x-grok-agent-id`、`x-grok-req-id`、`x-grok-user-id`、`traceparent`（W3C trace-id/span-id），以及**会话亲和性三件套** `x-grok-session-id` / `x-grok-conv-id` / `x-grok-conv-group-id`。

**最关键的坑**（`adapter.go:1121-1123` 源码注释原文）：
> `// Never generate a random UUID per request; it breaks xAI session affinity and keeps cached_tokens at zero.`

即：**每请求随机生成 session id 会导致 prompt cache 永不命中**（`cached_tokens` 恒为 0），表现为「能通但很慢很贵」。session id 必须由稳定 key 派生。

> 此项已在 §3.2 完整修正。

### 11.6 审查确认「无需改」的项

以下经独立核实，**确认文档说法正确**：

- ✅ `NATIVE_PRESET_TYPE`（`configService.ts:75`）确实**全仓无引用**，是死代码
- ✅ `providers.tsx:767` 的 `TYPE_ICONS[t]` 确实**无兜底**（`:526` 有 `|| Server`）
- ✅ `prisma/schema.prisma` 的 `Provider.type` 是自由 `String`，**无需 migration**
- ✅ `registry.ts` 的 `registerProvider` / `createProvider` 行为与文档一致（含 `createProvider` 返回 `null` 而非抛错）
- ✅ `core/types.ts:134` 的 `ProviderAdapter` 全部方法可选

### 11.7 修正后的完整必改清单

| # | 文件 | 改动 | 必要性 |
|:--:|:---|:---|:--:|
| 1 | `providers/index.ts` | +2 行（import + register） | 必须 |
| 2 | `config/configService.ts:70-72` | `NATIVE_PROVIDER_PRESETS` 加 grok | 必须 |
| 3 | `config/configService.ts:83` | `SECRET_FIELDS` 补 `clientId`/`sso`/`cfClearance` | **安全** |
| 4 | `console/types.ts:406` | `ProviderType` 加 `\| "grok"` | 必须 |
| 5 | **`console/ui.tsx:271`** | **`TYPE_BADGE_STYLE` 加 grok** | **必须（编译）** |
| 6 | **`console/ui.tsx:274`** | **`TYPE_LABEL` 加 grok** | **必须（编译）** |
| 7 | `console/format.ts:163` | `PROVIDER_TYPE_META` 加 grok | 必须 |
| 8 | `console/providers.tsx:66-70` | `TYPE_ICONS` 加 grok | **必须（`:767` 无兜底）** |
| 9 | **`console/setup-wizard.tsx:67`** | **凭据分支加 grok** | 必须（若向导含 grok） |
| 10 | `prisma/schema.prisma:56` | 注释补 `\| grok` | 建议 |
| 11 | 运行时（非代码） | **为 grok 模型显式建 ModelRoute** | **必须（否则 404）** |

> 相比本文档初稿的 8 项，审查后**新增 3 项**（#5、#6、#9），并新增 1 项**运行前置条件**（#11）。

### 11.8 本方案仍然成立的部分

审查未推翻方案主体：

- ✅ 新增独立 provider 类型 `grok` 的总体思路正确
- ✅ 走 `cli-chat-proxy.grok.com/v1` + OAuth 的设备码路线正确
- ✅ 三条路径（Build/Web/Console）的取舍正确：只做 Build
- ✅ 不做图片/视频/语音的范围裁剪正确
- ✅ `client_id` 与凭据 JSON 匹配的判断正确
- ✅ 复用 `standardPool` / `callWithAccountPool` 的判断正确

**结论：方案骨架不动，补齐上述 4 项遗漏即可进入实施。**
