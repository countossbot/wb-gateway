// WorkBuddy（腾讯云代码助手 / CodeBuddy）提供商 —— 深度适配。
// 能力：多账号池、会话粘性、401 无感续签、抖动重试、200 业务错误码检测、
//       余额并发聚合、每日签到、冷却指数退避（SQLite 持久化）。
import { sanitizeMessages } from "../../exchange/sanitizer";
import { buildResponseHeaders } from "../../http/headers";
import { orderAccounts, businessErrorCode, hashString32 } from "../../core/scheduler";
import { runFailover, type FailOutcome } from "../../core/failover";
import { accountCooldownRecord, hydrateCooldowns, setAccountCooldown } from "./cooldown";
import { fetchWithProxy } from "../../proxy/proxyAgent";
import { localDayKey } from "../../config/requestLog";
import { db } from "@/lib/db";
import type {
  ProviderAdapter,
  ProviderConfig,
  ChatPayload,
  CallOptions,
  BalanceResult,
  AccountConfig,
} from "../../core/types";

// 内存级多账号 Token 缓存字典: accountKey -> { token, timestamp }
const memoryTokenCache = new Map<string, { token: string; timestamp: number }>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟热缓存
let roundRobinCounter = 0;

// 抖动重试基准延迟：env RETRY_BASE_MS（.env），默认 600ms；非法值回退默认。
export const DEFAULT_RETRY_DELAY_MS = 600;
export function retryDelayMs(): number {
  const raw = Number(process.env.RETRY_BASE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.floor(raw);
}

// v3.5.0：INTL 兑底 system（Task 19 顺延项清偿）。
// 背景：INTL 站 WAF 要求首条消息必须是 system，缺失时报 11128 "first message is not system prompt"
// 并触发账号冷却（Task 16 实测：加 system 后恢复）。
// 注入条件（仅 intl region 且客户端消息首条非 system）：
// - Claude Code / CC-Switch 等真实流量本来就带固定 system（首条位置不变），不会走到这里，前缀缓存命中率零影响；
// - 只有「无 system 的简单调用」（curl / SDK 快速验证 / 脚本）原本必然 11128 失败，注入只赚不赔。
const INTL_FALLBACK_SYSTEM = "You are a helpful assistant.";

// WorkBuddy Desktop outbound identity，按 workbuddy2api-panel 当前实现对齐。
// Chat 的用量归属头使用官方桌面端形态；Web fingerprint 只在确实属于 Web endpoint
// 的请求上使用，不能再作为全局身份标识。
const WORKBUDDY_CLIENT_VERSION = "5.5.4";
const WORKBUDDY_CLI_VERSION = "2.137.1";

function workbuddyUserAgent(region: "cn" | "intl"): string {
  const platform = region === "intl" ? "WorkBuddy AI" : "WorkBuddy";
  return `WorkBuddy/${WORKBUDDY_CLIENT_VERSION} ${platform}/${WORKBUDDY_CLIENT_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`;
}

function workbuddyDesktopAttributionHeaders(): Record<string, string> {
  return {
    "X-Agent-Purpose": "conversation",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": WORKBUDDY_CLIENT_VERSION,
    "X-Product": "WorkBuddy",
  };
}

function workbuddyBillingUserAgent(): string {
  return `WorkBuddy/${WORKBUDDY_CLIENT_VERSION}`;
}

// 会话粘性键：优先客户端透传的会话头；回退 system+tools 指纹
// （同一编码会话内稳定；跨会话碰撞只影响落点、不影响正确性）。
// 取不到返回 null → orderAccounts 走纯轮询。只读不写。
export function affinityKeyForCall(payload: ChatPayload, options: CallOptions = {}): string | null {
  const headers = options?.request?.headers as Pick<Headers, "get"> | null | undefined;
  if (headers && typeof headers.get === "function") {
    const sid = headers.get("x-session-id") || headers.get("x-conversation-id") || headers.get("session-id");
    if (sid) return `sid:${sid}`;
  }
  try {
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    const first = msgs.length > 0 && msgs[0]?.role === "system" ? msgs[0].content : "";
    const sys = typeof first === "string" ? first : JSON.stringify(first ?? "");
    const tools = JSON.stringify(payload?.tools ?? []);
    const sig = sys + "\n" + tools;
    if (sig.trim().length > 8) return `sig:${hashString32(sig)}`;
  } catch {
    /* noop */
  }
  return null;
}

// v3.2.2：冷却原因摘要 —— 上游 JSON error.message 优先（人可读），原文兜底，统一截断 160 字符。
// 仅用于 Account.cooldownReason 落库与控制台展示，不影响任何调度决策。
export function summarizeFailReason(status: number | string | undefined, text: unknown): string {
  let body = "";
  if (typeof text === "string" && text.trim()) {
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string; msg?: string };
      const msg = typeof j.error === "string" ? j.error : j.error?.message || j.message || j.msg;
      body = msg ? String(msg) : text;
    } catch {
      body = text;
    }
  }
  const reason = body.trim() || (status ? `HTTP ${status}` : "unknown");
  return reason.slice(0, 160);
}

// Region 端点表（CN / intl 双 region）。模型目录必须走 /v2 CLI 通道；不要改成 /console。
export function normalizeWorkbuddyRegion(value: unknown): "cn" | "intl" {
  return String(value || "").toLowerCase() === "intl" ? "intl" : "cn";
}

export interface WorkbuddyEndpoints {
  region: "cn" | "intl";
  probed: boolean;
  models: string;
  refresh: string;
  chat: string;
  billing: string;
  checkin: string;
  origin: string;
  referer: string;
  userAgent: string;
}

export function resolveWorkbuddyEndpoints(region: unknown): WorkbuddyEndpoints {
  if (normalizeWorkbuddyRegion(region) === "intl") {
    // 国际版：按 workbuddy2api-panel 当前实现使用 www.workbuddy.ai；
    // Chat / refresh 使用 /v2，billing / checkin 使用无 /v2 的 billing 路径。
    return {
      region: "intl",
      probed: true,
      models: "https://www.codebuddy.ai/v2/enterprises/personal/models",
      refresh: "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
      chat: "https://www.workbuddy.ai/v2/chat/completions",
      billing: "https://www.workbuddy.ai/billing/meter/get-user-resource",
      checkin: "https://www.workbuddy.ai/billing/meter/daily-checkin",
      origin: "https://www.workbuddy.ai",
      referer: "https://www.workbuddy.ai/",
      userAgent: workbuddyUserAgent("intl"),
    };
  }
  return {
    region: "cn",
    probed: true,
    models: "https://www.codebuddy.cn/v2/enterprises/personal/models",
    refresh: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    chat: "https://copilot.tencent.com/v2/chat/completions",
    billing: "https://www.codebuddy.cn/v2/billing/meter/get-user-resource",
    checkin: "https://www.codebuddy.cn/v2/billing/meter/daily-checkin",
    origin: "https://www.codebuddy.cn",
    referer: "https://www.codebuddy.cn/",
    userAgent: workbuddyUserAgent("cn"),
  };
}

interface WorkbuddyAccount extends AccountConfig {
  id: string;
  name?: string;
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  [key: string]: unknown;
}

export interface UpstreamModelDetail {
  id: string;
  name: string | null;
  credits: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  supportsImages: boolean;
  supportsReasoning: boolean;
  supportsToolCall: boolean;
  isDefault: boolean;
}

export interface UpstreamModelsResult {
  models: string[];
  details: UpstreamModelDetail[];
  url: string;
  allCount: number;
}

export class WorkBuddyProvider implements ProviderAdapter {
  id: string;
  name: string;
  type = "workbuddy";
  config: Record<string, unknown>;
  region: "cn" | "intl";
  endpoints: WorkbuddyEndpoints;
  // 能力声明：上游非流式 JSON 可能是 200 业务错误包，调用方须强制 stream=true。
  // dispatch 经 contract.wantsStreamedChat 探针读取，不 switch type。
  forceStream = true;

  constructor(config: ProviderConfig) {
    this.id = config.id || "workbuddy";
    this.name = config.name || "WorkBuddy";
    this.config = (config.config || {}) as Record<string, unknown>;
    // region 决定整组端点：默认 cn；配 config.region: "intl" 切国际站。
    this.region = normalizeWorkbuddyRegion(this.config.region);
    this.endpoints = resolveWorkbuddyEndpoints(this.region);
  }

  // 取可用端点表：intl 未实测时抛明确错误（而不是静默打错域名）。
  ep(): WorkbuddyEndpoints {
    if (!this.endpoints?.probed) {
      throw new Error(
        `WorkBuddy provider "${this.id}" region "${this.region}" endpoints not probed yet — ` +
          `fill resolveWorkbuddyEndpoints() with measured intl paths first`
      );
    }
    return this.endpoints;
  }

  async listUpstreamModels(): Promise<UpstreamModelsResult> {
    const ep = this.ep();
    const accounts = this.getAccounts().slice(0, 3);
    if (accounts.length === 0) throw new Error("无可用账户（请先配置账户凭证）");
    let lastErr = "未知错误";
    for (const acc of accounts) {
      let token = await this.getActiveToken(acc);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!token) {
          lastErr = "账户 " + (acc.name || acc.id) + " 无 accessToken";
          break;
        }
        try {
          const resp = await fetchWithProxy(
            ep.models,
            {
              headers: {
                Authorization: "Bearer " + token,
                "X-Client-Platform": "web",
                Accept: "application/json, text/plain, */*",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
              },
              signal: AbortSignal.timeout(8_000),
            },
            { providerId: this.id }
          );
          if (resp.status === 401 && attempt === 0) {
            token = (await this.refreshAccessToken(acc)) || "";
            continue;
          }
          if (!resp.ok) throw new Error("HTTP " + resp.status + (resp.status === 500 ? "（上游服务错误）" : ""));
          const resJson = (await resp.json().catch(() => ({}))) as {
            code?: number;
            msg?: string;
            data?: {
              models?: Array<Record<string, unknown>>;
              agents?: Array<{ name?: string; models?: unknown }>;
            };
          };
          if (typeof resJson.code === "number" && resJson.code !== 0) {
            throw new Error(("业务错误 code=" + resJson.code + " " + (resJson.msg || "")).trim());
          }
          const all = (resJson.data?.models ?? []).filter(
            (m): m is Record<string, unknown> => typeof m?.id === "string" && !!m.id
          );
          if (all.length === 0) throw new Error("上游响应无模型数据");
          const byId = new Map(all.map((m) => [m.id as string, m]));
          const allow = resJson.data?.agents?.find((a) => a?.name === "cli")?.models;
          const allowIds = Array.isArray(allow) ? allow.filter((id): id is string => typeof id === "string") : [];
          const ids = allowIds.length > 0 ? allowIds.filter((id) => byId.has(id)) : all.map((m) => m.id as string);
          const details = ids.map((id) => {
            const m = byId.get(id);
            return {
              id,
              name: typeof m?.name === "string" ? m.name : null,
              credits: typeof m?.credits === "string" ? m.credits : null,
              maxInputTokens: typeof m?.maxInputTokens === "number" ? m.maxInputTokens : null,
              maxOutputTokens: typeof m?.maxOutputTokens === "number" ? m.maxOutputTokens : null,
              supportsImages: !!m?.supportsImages,
              supportsReasoning: !!m?.supportsReasoning,
              supportsToolCall: !!m?.supportsToolCall,
              isDefault: !!m?.isDefault,
            };
          });
          return { models: ids, details, url: ep.models, allCount: all.length };
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          break;
        }
      }
    }
    throw new Error(lastErr);
  }

  // 获取所有启用的账号列表（支持单账号与账号池双重兼容）
  getAccounts(): WorkbuddyAccount[] {
    const accounts = this.config.accounts as WorkbuddyAccount[] | undefined;
    if (Array.isArray(accounts) && accounts.length > 0) {
      return accounts.filter((acc) => acc.enabled !== false);
    }
    // intl 不得回退单账号形态：混用 region 凭证必然鉴权失败，还会污染风控
    if (this.region === "intl") return [];
    // 降级兼顾单一账号配置（原版语义：config.userId 三件套或 env 凭证）
    const defaultUserId = (this.config.userId as string) || process.env.USER_ID || "";
    const defaultAccess = (this.config.accessToken as string) || process.env.ACCESS_TOKEN || "";
    const defaultRefresh = (this.config.refreshToken as string) || process.env.REFRESH_TOKEN || "";
    if (defaultUserId) {
      return [
        {
          id: "primary",
          name: "主账号",
          enabled: true,
          userId: defaultUserId,
          accessToken: defaultAccess,
          refreshToken: defaultRefresh,
        },
      ];
    }
    return [];
  }

  // 获取特定账号的有效 Token（内存 5 分钟热缓存 → DB credentials）
  async getActiveToken(account: WorkbuddyAccount): Promise<string> {
    const cacheKey = `${this.id}_${account.id}`;
    const now = Date.now();
    const cached = memoryTokenCache.get(cacheKey);
    if (cached && now - cached.timestamp < TOKEN_CACHE_TTL_MS) {
      return cached.token;
    }

    // DB 中的最新凭据（refreshAccessToken 无感续签后写回 Account.credentials）
    try {
      const row = await db.account.findUnique({
        where: { providerId_id: { providerId: this.id, id: account.id } },
        select: { credentials: true },
      });
      const dbToken = (row?.credentials as Record<string, unknown> | null)?.accessToken as string | undefined;
      if (dbToken) {
        memoryTokenCache.set(cacheKey, { token: dbToken, timestamp: now });
        return dbToken;
      }
    } catch {
      /* noop */
    }

    const fallback = account.accessToken || "";
    if (fallback) {
      memoryTokenCache.set(cacheKey, { token: fallback, timestamp: now });
    }
    return fallback;
  }

  // 刷新特定账号或全部账号的 AccessToken（401 无感续签主路径 + /admin/api/refresh 手动触发）
  // 参数以 unknown 接收（契约逆变兼容），内部收窄为 WorkbuddyAccount
  async refreshAccessToken(accountArg?: unknown): Promise<string | null | Array<string | null>> {
    const account = (accountArg ?? null) as WorkbuddyAccount | null;
    if (!account) {
      const accounts = this.getAccounts();
      const results = await Promise.allSettled(accounts.map((acc) => this.refreshAccessToken(acc)));
      const list = results.map((r) => (r.status === "fulfilled" ? (r.value as string | null) : null));
      return list.filter((v): v is string => !!v);
    }
    let refreshToken =
      (account.refreshToken as string) ||
      // DB 中可能存有更新的 refreshToken（无感续签写回）
      (await this.readDbCredential(account.id, "refreshToken")) ||
      "";

    if (!refreshToken) return null;

    try {
      const ep = this.ep();
      const resp = await fetchWithProxy(
        ep.refresh,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Refresh-Token": refreshToken,
            "X-Auth-Refresh-Source": "workbuddy",
            "User-Agent": ep.userAgent,
            Origin: ep.origin,
            Referer: ep.referer,
            "X-CodeBuddy-Request": "1",
            "Accept-Language": this.region === "intl" ? "en-US" : "zh-CN",
            ...(this.region === "intl"
              ? { "X-No-Enterprise-Id": "1", "X-Domain": "www.workbuddy.ai" }
              : {}),
          },
        },
        { providerId: this.id }
      );
      const resJson = (await resp.json()) as { code?: number; data?: { accessToken?: string; refreshToken?: string } };
      if (resJson.code === 0 && resJson.data?.accessToken) {
        const newAccess = resJson.data.accessToken;
        const newRefresh = resJson.data.refreshToken || refreshToken;

        // 立即更新内存缓存
        memoryTokenCache.set(`${this.id}_${account.id}`, { token: newAccess, timestamp: Date.now() });

        // 写回 SQLite（原 KV WB_ACCESS_TOKEN_* 语义 → Account.credentials + lastRefreshAt）
        await this.writeDbCredentials(account.id, { accessToken: newAccess, refreshToken: newRefresh });

        return newAccess;
      }
    } catch (e) {
      console.error(`[WorkBuddy:${account.name || account.id}] Token refresh failed:`, e);
    }
    return null;
  }

  private async readDbCredential(accountId: string, field: string): Promise<string | undefined> {
    try {
      const row = await db.account.findUnique({
        where: { providerId_id: { providerId: this.id, id: accountId } },
        select: { credentials: true },
      });
      return (row?.credentials as Record<string, unknown> | null)?.[field] as string | undefined;
    } catch {
      return undefined;
    }
  }

  // 凭据写回（合并语义：只覆盖传入字段；同时记录 lastRefreshAt 供 /admin/api/status 展示）
  private async writeDbCredentials(accountId: string, patch: Record<string, unknown>): Promise<void> {
    try {
      const row = await db.account.findUnique({
        where: { providerId_id: { providerId: this.id, id: accountId } },
        select: { credentials: true },
      });
      const existing = (row?.credentials as Record<string, unknown> | null) || {};
      await db.account.update({
        where: { providerId_id: { providerId: this.id, id: accountId } },
        data: {
          credentials: { ...existing, ...patch } as never,
          lastRefreshAt: new Date(),
        },
      });
    } catch (e) {
      console.error(`[WorkBuddy] Failed to persist credentials for ${this.id}/${accountId}:`, e);
    }
  }

  // 核心 Chat 接口：会话粘性 + 自动故障转移（Failover on 429 / Quota Error）。
  // 同一会话固定打同一健康账号（上游按账号隔离的前缀缓存保持热，命中率不随账号数稀释）；
  // 无会话标识时回退 round-robin；命中冷却/限流时 failover 照常漂移到下一健康账号。
  async callChat(payload: ChatPayload, options: CallOptions = {}): Promise<Response> {
    const allAccounts = this.getAccounts();
    if (allAccounts.length === 0) {
      return new Response(
        JSON.stringify({ error: { message: "No active WorkBuddy accounts configured" } }),
        { status: 500 }
      );
    }

    // 先水合 DB 中的冷却记录（外部修改或重启后的状态），再做健康度筛选
    await hydrateCooldowns(this.id, allAccounts);

    // 账号排序委托给纯函数调度器：有粘性键时固定落点，无键时 round-robin，冷却账号按到期时间兜底
    const accounts = orderAccounts(
      allAccounts,
      accountCooldownRecord,
      Date.now(),
      roundRobinCounter,
      affinityKeyForCall(payload, options)
    );
    roundRobinCounter += 1;

    if (payload.messages) {
      payload.messages = sanitizeMessages(payload.messages as never) as never;
      // v3.5.0：intl region 无 system 头时注入兑底（防 11128 WAF 拒绝；见 INTL_FALLBACK_SYSTEM 注释）。
      // 在 sanitizeMessages 之后执行：注入的 system 不会被脱敏逻辑改写，且始终位于消息序列首部。
      if (this.region === "intl") {
        const msgs = payload.messages as unknown as Array<{ role: string; content: unknown }>;
        if (!Array.isArray(msgs) || msgs.length === 0 || msgs[0]?.role !== "system") {
          payload.messages = [
            { role: "system", content: INTL_FALLBACK_SYSTEM },
            ...(Array.isArray(msgs) ? msgs : []),
          ] as never;
          console.info(
            `[WorkBuddy] provider "${this.id}" (intl): client messages lack system head, injected fallback system (11128 WAF guard)`
          );
        }
      }
    }

    const serializedPayload = JSON.stringify(payload);

    // 账号级故障转移收敛到 runFailover：循环、分类、耗尽收尾
    // 由驱动器统一处理；单个账号的「试一次」（401 刷新、抖动重试、业务码检测）见 attemptAccount。
    return await runFailover<WorkbuddyAccount>(accounts, {
      isAbort: (err) => (err as Error)?.name === "AbortError",
      onRetryable: async (account, action, fail: FailOutcome) => {
        const label = account.name || account.id;
        if (action === "retry") {
          // 5xx 服务端瞬时故障：切换下一账号，不惩罚当前账号
          console.warn(
            `[WorkBuddy] Account "${label}" returned ${fail.status}, auto-switching to next account...`
          );
          return;
        }
        // 429 / 403 / 额度 / 风控：惩罚性退避后切换下一账号
        console.warn(
          `[WorkBuddy] Account "${label}" quota/safety filter triggered (${fail.status}: ${String(
            fail.text
          ).substring(0, 80)}), cooling down and auto-switching to next account...`
        );
        // v3.2.2：冷却原因摘要随退避落库（提取上游 JSON error.message 优先，原文兜底），控制台账号页 tooltip 可见
        await setAccountCooldown(this.id, account, "cooldown", summarizeFailReason(fail.status, fail.text));
      },
      renderExhausted: () =>
        new Response(
          JSON.stringify({ error: { message: "All WorkBuddy accounts in pool failed" } }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        ),
      attempt: (account) => this.attemptAccount(account, payload, serializedPayload, options),
    });
  }

  // 对单个账号试一次（runFailover 的 attempt）：{ done } 命中即返；
  // { fail } 由驱动器分类后 fatal 即返 / cooldown-retry 切换；null 跳过该账号。
  async attemptAccount(
    account: WorkbuddyAccount,
    payload: ChatPayload,
    serializedPayload: string,
    options: CallOptions
  ): Promise<{ done?: Response; fail?: FailOutcome } | null> {
    let token = await this.getActiveToken(account);
    const userId = account.userId;
    if (!token || !userId) return null;

    const makeRequest = async (tk: string): Promise<Response> => {
      const ep = this.ep();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Connection: "keep-alive",
        "X-Requested-With": "XMLHttpRequest",
        Origin: ep.origin,
        Referer: ep.referer,
        "User-Agent": ep.userAgent,
        Authorization: `Bearer ${tk}`,
        "X-User-Id": userId,
        ...workbuddyDesktopAttributionHeaders(),
        "X-CodeBuddy-Request": "1",
        "Accept-Language": this.region === "intl" ? "en-US" : "zh-CN",
        ...(this.region === "intl"
          ? { "X-No-Enterprise-Id": "1", "X-Domain": "www.workbuddy.ai" }
          : {}),
      };
      return await fetchWithProxy(
        ep.chat,
        {
          method: "POST",
          headers,
          body: serializedPayload,
          signal: options.signal ?? undefined,
        },
        { providerId: this.id }
      );
    };

    try {
      let resp = await makeRequest(token);
      if (resp.status === 401) {
        memoryTokenCache.delete(`${this.id}_${account.id}`);
        const refreshed = await this.refreshAccessToken(account);
        if (typeof refreshed === "string" && refreshed) {
          token = refreshed;
          resp = await makeRequest(token);
        } else {
          // 刷新失败：直接切换下一账号（不计入冷却 streak，401 通常是 token 过期而非额度问题）
          console.warn(
            `[WorkBuddy] Account "${account.name || account.id}" 401 token refresh failed, switching to next account...`
          );
          return null;
        }
      }

      // 遇到 502 / 503 / 504 服务端瞬时抖动，毫秒级原地快速重试一次（避开上游偶发拥塞）
      if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
        console.warn(
          `[WorkBuddy] Account "${account.name || account.id}" hit ${resp.status}, retrying in ${retryDelayMs()}ms...`
        );
        await new Promise((r) => setTimeout(r, retryDelayMs()));
        if (options.signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        const retryResp = await makeRequest(token);
        if (retryResp.ok) {
          await setAccountCooldown(this.id, account, "clear");
          return {
            done: new Response(retryResp.body, {
              status: retryResp.status,
              statusText: retryResp.statusText,
              headers: buildResponseHeaders(retryResp.headers, {
                "X-Gateway-Account": account.id || "primary",
                "X-Gateway-Account-Id": account.id || "primary",
              }),
            }),
          };
        }
        resp = retryResp;
      }

      // 成功响应直接返回（若请求 stream 但返回 application/json，检测是否为腾讯 200 业务错误码）
      if (resp.ok) {
        const contentType = resp.headers.get("content-type") || "";
        if (payload.stream && contentType.includes("application/json")) {
          const clone = resp.clone();
          try {
            const resJson = (await clone.json()) as Record<string, unknown>;
            if (businessErrorCode(resJson) !== 0) {
              // 200 包业务错误码：交驱动器分类（已知码 cooldown 惩罚并由 onRetryable 落盘，
              // 未知码 retry 只切换不惩罚）；预渲染响应在 fatal/耗尽时直接返回。
              return {
                fail: {
                  status: 200,
                  text: (resJson.msg as string) || (resJson.message as string) || JSON.stringify(resJson),
                  json: resJson,
                  response: new Response(JSON.stringify(resJson), {
                    status: 200,
                    headers: buildResponseHeaders(resp.headers, {
                      "Content-Type": "application/json",
                      "X-Gateway-Account": account.id || "primary",
                      "X-Gateway-Account-Id": account.id || "primary",
                    }),
                  }),
                },
              };
            }
          } catch {
            /* noop */
          }
        }
        // 请求成功，清除冷却与连续惩罚标记
        await setAccountCooldown(this.id, account, "clear");
        return {
          done: new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: buildResponseHeaders(resp.headers, {
              "X-Gateway-Account": account.id || "primary",
              "X-Gateway-Account-Id": account.id || "primary",
            }),
          }),
        };
      }

      const status = resp.status;

      // 失败收口：429 / 5xx / 403 / 额度耗尽等统一交驱动器分类
      //（fatal 即返预渲染响应，cooldown/retry 经 onRetryable 切换）。
      const errText = await resp.text();
      let parsedJson: Record<string, unknown> | null = null;
      try {
        parsedJson = JSON.parse(errText);
      } catch {
        /* noop */
      }
      return {
        fail: {
          status,
          text: errText,
          json: parsedJson,
          response: new Response(errText, {
            status: status,
            headers: buildResponseHeaders(resp.headers, {
              "Content-Type": "application/json",
              "X-Gateway-Account": account.id || "primary",
              "X-Gateway-Account-Id": account.id || "primary",
            }),
          }),
        },
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw err; // 客户端主动中断取消，直接抛出终止
      }
      console.warn(
        `[WorkBuddy] Account "${account.name || account.id}" network error: ${(err as Error).message}, retrying in ${retryDelayMs()}ms...`
      );
      try {
        await new Promise((r) => setTimeout(r, retryDelayMs()));
        if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const retryResp = await makeRequest(token);
        if (retryResp.ok) return { done: retryResp };
        const retryErrText = await retryResp.text();
        let retryJson: Record<string, unknown> | null = null;
        try {
          retryJson = JSON.parse(retryErrText);
        } catch {
          /* noop */
        }
        return {
          fail: {
            status: retryResp.status,
            text: retryErrText,
            json: retryJson,
            response: new Response(retryErrText, {
              status: retryResp.status,
              headers: buildResponseHeaders(retryResp.headers, {
                "Content-Type": "application/json",
                "X-Gateway-Account": account.id || "primary",
                "X-Gateway-Account-Id": account.id || "primary",
              }),
            }),
          },
        };
      } catch (retryErr) {
        if ((retryErr as Error).name === "AbortError") throw retryErr;
        console.warn(
          `[WorkBuddy] Account "${account.name || account.id}" retry failed: ${(retryErr as Error).message}, switching next...`
        );
        return null;
      }
    }
  }

  // 余额 / 积分查询：并发聚合账号池所有账号积分
  async getBalance(): Promise<BalanceResult> {
    const accounts = this.getAccounts();
    if (accounts.length === 0) {
      return { success: false, balance: 0, total: 0, unit: "积分", error: "No accounts configured" };
    }

    const now = new Date();
    const beginTime = now.toISOString().replace("T", " ").substring(0, 19);
    const endTime = new Date(now.getTime() + 10 * 365 * 86400000).toISOString().replace("T", " ").substring(0, 19);

    const queryAccountBalance = async (account: WorkbuddyAccount) => {
      const token = await this.getActiveToken(account);
      const userId = account.userId;
      if (!token || !userId)
        return { id: account.id, name: account.name, balance: 0, total: 0, success: false };

      try {
        const ep = this.ep();
        const resp = await fetchWithProxy(
          ep.billing,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-User-Id": userId,
              "User-Agent": workbuddyBillingUserAgent(),
              Origin: ep.origin,
              Referer: ep.referer,
              "X-CodeBuddy-Request": "1",
              "Accept-Language": this.region === "intl" ? "en-US" : "zh-CN",
              ...(this.region === "intl"
                ? { "X-No-Enterprise-Id": "1", "X-Domain": "www.workbuddy.ai" }
                : {}),
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              PageNumber: 1,
              PageSize: 100,
              ProductCode: "p_tcaca",
              Status: [0, 3],
              PackageEndTimeRangeBegin: beginTime,
              PackageEndTimeRangeEnd: endTime,
            }),
          },
          { providerId: this.id }
        );

        const data = (await resp.json()) as {
          code?: number;
          data?: { Response?: { Data?: { Accounts?: Array<Record<string, string>> } } };
        };
        if (data.code === 0 && data.data?.Response?.Data?.Accounts) {
          let totalRemain = 0;
          let totalSize = 0;
          for (const acc of data.data.Response.Data.Accounts) {
            const r = parseFloat(
              acc.CycleCapacityRemainPrecise || acc.CycleCapacityRemain || acc.CapacityRemain || "0"
            );
            const s = parseFloat(acc.CycleCapacitySizePrecise || acc.CycleCapacitySize || acc.CapacitySize || "0");
            totalRemain += r;
            totalSize += s;
          }
          return {
            id: account.id,
            name: account.name || account.id,
            balance: parseFloat(totalRemain.toFixed(2)),
            total: totalSize,
            success: true,
          };
        }
      } catch (e) {
        console.error(`[WorkBuddy] Balance fetch error for ${account.name}:`, e);
      }
      return { id: account.id, name: account.name, balance: 0, total: 0, success: false };
    };

    const results = await Promise.allSettled(accounts.map(queryAccountBalance));
    let sumBalance = 0;
    let sumTotal = 0;
    const accountDetails: Array<{ id: string; name?: string; balance: number; total: number; success: boolean }> = [];

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        sumBalance += r.value.balance || 0;
        sumTotal += r.value.total || 0;
        accountDetails.push(r.value);
      }
    }

    // 余额快照写回 DB（控制台「最近余额」展示，脱敏无凭据）
    this.persistBalanceSnapshot(accountDetails).catch(() => {});

    return {
      success: true,
      balance: parseFloat(sumBalance.toFixed(2)),
      total: sumTotal,
      unit: "积分",
      accounts_count: accounts.length,
      accounts: accountDetails,
      extra: `WorkBuddy 剩余积分 (${accounts.length}个账号池)`,
    };
  }

  private async persistBalanceSnapshot(
    details: Array<{ id: string; name?: string; balance: number; total: number; success: boolean }>
  ): Promise<void> {
    try {
      const day = localDayKey();
      for (const d of details) {
        await db.account.update({
          where: { providerId_id: { providerId: this.id, id: d.id } },
          data: {
            balance: { balance: d.balance, total: d.total, success: d.success, at: new Date().toISOString() } as never,
          },
        });
        // v3.6.0：余额按日快照（日 × 提供商 × 账号，同日刷新覆盖为最新值）——
        // 余额趋势 sparkline 数据源；零额外上游调用（仅在既有 getBalance 流程顺带落库）
        await db.balanceSnapshot.upsert({
          where: { day_providerId_accountId: { day, providerId: this.id, accountId: d.id } },
          create: {
            day,
            providerId: this.id,
            accountId: d.id,
            accountName: d.name || "",
            balance: d.balance,
            total: d.total,
            success: d.success,
          },
          update: {
            accountName: d.name || undefined,
            balance: d.balance,
            total: d.total,
            success: d.success,
            updatedAt: new Date(),
          },
        });
      }
    } catch {
      /* noop */
    }
  }

  // 每日签到：并发对账号池内所有账号自动签到领积分
  async doDailyCheckin(): Promise<{
    success: boolean;
    accounts_count: number;
    details: unknown[];
  }> {
    const accounts = this.getAccounts();
    if (accounts.length === 0) return { success: false, accounts_count: 0, details: [{ msg: "no accounts configured" }] };

    const checkinSingle = async (account: WorkbuddyAccount) => {
      const token = await this.getActiveToken(account);
      const userId = account.userId;
      if (!token || !userId)
        return { id: account.id, name: account.name, success: false, msg: "missing credentials" };

      try {
        const resp = await fetchWithProxy(
          this.ep().checkin,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-User-Id": userId,
              "User-Agent": workbuddyBillingUserAgent(),
              "X-CodeBuddy-Request": "1",
              "Accept-Language": this.region === "intl" ? "en-US" : "zh-CN",
              ...(this.region === "intl"
                ? { "X-No-Enterprise-Id": "1", "X-Domain": "www.workbuddy.ai" }
                : {}),
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: "{}",
          },
          { providerId: this.id }
        );
        const data = (await resp.json()) as { code?: number };
        return {
          id: account.id,
          name: account.name || account.id,
          success: data.code === 0,
          result: data,
        };
      } catch (e) {
        return { id: account.id, name: account.name, success: false, error: (e as Error).message };
      }
    };

    const results = await Promise.allSettled(accounts.map(checkinSingle));
    const checkinLogs: Array<Record<string, unknown>> = results.map((r) =>
      r.status === "fulfilled" ? (r.value as Record<string, unknown>) : { error: (r.reason as Error)?.message }
    );

    // 签到结果落库（CheckinLog 表 + Account.lastCheckinAt，替代原 KV LAST_CHECKIN）
    this.persistCheckinLogs(checkinLogs).catch(() => {});

    return {
      success: checkinLogs.some((l) => !!(l as { success?: boolean }).success),
      accounts_count: accounts.length,
      details: checkinLogs,
    };
  }

  private async persistCheckinLogs(logs: unknown[]): Promise<void> {
    const now = new Date();
    try {
      await db.checkinLog.createMany({
        data: logs.map((l) => {
          const entry = l as { id?: string; name?: string; success?: boolean };
          return {
            providerId: this.id,
            accountId: entry.id || null,
            accountName: entry.name || null,
            success: !!entry.success,
            result: l as never,
          };
        }),
      });
      for (const l of logs) {
        const entry = l as { id?: string; success?: boolean };
        if (entry.id) {
          await db.account.update({
            where: { providerId_id: { providerId: this.id, id: entry.id } },
            data: { lastCheckinAt: now, lastCheckinOk: !!entry.success },
          });
        }
      }
    } catch (e) {
      console.error("[WorkBuddy] persist checkin logs failed:", e);
    }
  }

  // 定时调度生命周期钩子：并发执行所有账号签到与 Token 保活
  async onSchedule(): Promise<void> {
    await this.doDailyCheckin();
    const accounts = this.getAccounts();
    await Promise.allSettled(accounts.map((acc) => this.refreshAccessToken(acc)));
  }
}

// 测试隔离：清空进程级 Token 缓存与轮转计数
export function resetWorkbuddyCacheForTest(): void {
  memoryTokenCache.clear();
  roundRobinCounter = 0;
}
