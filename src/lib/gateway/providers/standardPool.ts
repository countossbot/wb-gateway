// 标准适配器账号池 —— openai / anthropic 兼容提供商的多密钥轮换共享执行器。
// （Task 41：清偿 Task 15 起顺延 20+ 轮的「标准适配器多账号轮换」。）
//
// 设计对齐 workbuddy 既有模式（两级故障转移架构）：
//   账号级（本模块，runFailover）→ 候选级（dispatch.ts，runFailover）——
//   账号池耗尽返回 502，dispatch 层 classify(502)=retry 自动切下一候选，语义天然级联。
//
// 调度语义（与 workbuddy 完全一致，复用同一套纯函数与冷却持久层）：
//   - 会话粘性（affinityKeyForCall）：同一会话固定同一健康账号（上游 prompt cache 按 key 组织，保持热）
//   - 无会话标识 → round-robin 轮转（per-provider 计数器）
//   - 冷却账号排后（orderAccounts）；全部冷却 → 按到期时间升序兜底（宁可试冷却账号也不直接失败）
//   - 429/403/402/额度文本 → 惩罚性退避（setAccountCooldown 落 SQLite，重启不丢）+ 切下一账号
//   - 5xx → retry 切换不惩罚；400 参数错 → fatal 直返（换账号无意义，交给候选级处理模型级转移）
//   - 401 → key 失效（标准协议无刷新能力）：惩罚退避（下次避开）+ 切换（本次继续）
//
// 向后兼容（关键契约）：provider 无账号池（config.accounts 为空或全无 apiKey）时，
// 回退 provider 级 config.apiKey 单密钥直发 —— 与 v4.2.1 行为零差异，不注入
// X-Gateway-Account 头（dispatch 层维持 "default" 落日志口径）。
import { orderAccounts } from "../core/scheduler";
import { runFailover, type FailOutcome } from "../core/failover";
import { accountCooldownRecord, hydrateCooldowns, setAccountCooldown } from "./workbuddy/cooldown";
import { affinityKeyForCall, summarizeFailReason } from "./workbuddy/index";
import { buildResponseHeaders } from "../http/headers";
import type { AccountConfig, CallOptions, ChatPayload } from "../core/types";

/** 标准适配器账号：credentials 展开后含 apiKey（控制台账号页 CRED_FIELDS.openai/anthropic） */
export interface StandardPoolAccount extends AccountConfig {
  apiKey?: string;
}

/** 提取启用的、具备 apiKey 的账号池（空池 = 回退单密钥形态） */
export function poolAccounts(config: Record<string, unknown>): StandardPoolAccount[] {
  const accounts = config.accounts as StandardPoolAccount[] | undefined;
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  return accounts.filter(
    (acc) => acc && acc.enabled !== false && typeof acc.apiKey === "string" && acc.apiKey.trim() !== ""
  );
}

// per-provider round-robin 计数器（provider 为有限配置集合，普通 Map 不做有界化）
const roundRobinCounters = new Map<string, number>();

function nextRoundRobin(providerId: string): number {
  const cur = roundRobinCounters.get(providerId) || 0;
  roundRobinCounters.set(providerId, cur + 1);
  return cur;
}

/** 测试隔离：清空轮换计数器 */
export function resetStandardPoolForTest(): void {
  roundRobinCounters.clear();
}

export interface CallWithAccountPoolOptions {
  providerId: string;
  /** 已提取的账号池（poolAccounts 结果）。空数组 = 单密钥回退形态 */
  accounts: StandardPoolAccount[];
  /** 单密钥回退：provider 级 apiKey（无池时使用；两者都空 → 500 明确报错） */
  fallbackApiKey?: string;
  payload: ChatPayload | Record<string, unknown>;
  options?: CallOptions;
  /** 单次请求构造（适配器注入协议头差异：Bearer vs x-api-key） */
  makeRequest: (apiKey: string) => Promise<Response>;
  /** 日志标签（如 "OpenAI my-relay"） */
  label: string;
}

/**
 * 多密钥轮换执行入口。有池走 runFailover 账号循环；无池单密钥直发（兼容形态）。
 * 返回的 Response 由调用方（dispatch）按 ok / 非 ok 继续候选级处理。
 */
export async function callWithAccountPool(opts: CallWithAccountPoolOptions): Promise<Response> {
  const { providerId, accounts, payload, options, makeRequest, label } = opts;
  const signal = options?.signal ?? undefined;

  // ---- 单密钥回退形态（向后兼容：v4.2.1 行为零变化）----
  if (!accounts || accounts.length === 0) {
    const key = (opts.fallbackApiKey || "").trim();
    if (!key) {
      return new Response(
        JSON.stringify({
          error: {
            type: "gateway_config_error",
            message: `Provider "${providerId}" has no API key: add an account in the console (账号管理) or set provider-level apiKey.`,
          },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    return makeRequest(key);
  }

  // ---- 账号池形态：水合 DB 冷却 → 排序（粘性/轮转/冷却排后）→ runFailover ----
  await hydrateCooldowns(providerId, accounts);
  const ordered = orderAccounts(
    accounts,
    accountCooldownRecord,
    Date.now(),
    nextRoundRobin(providerId),
    affinityKeyForCall(payload as ChatPayload, options)
  );

  return await runFailover<StandardPoolAccount>(ordered, {
    isAbort: (err) => (err as Error)?.name === "AbortError",
    onRetryable: async (account, action, fail: FailOutcome) => {
      const name = account.name || account.id;
      if (action === "retry") {
        // 5xx 瞬时故障：切下一账号，不惩罚
        console.warn(`[${label}] Account "${name}" returned ${fail.status}, switching to next key...`);
        return;
      }
      console.warn(
        `[${label}] Account "${name}" rate/quota limited (${fail.status}: ${String(fail.text).slice(0, 80)}), cooling down and switching...`
      );
      await setAccountCooldown(providerId, account, "cooldown", summarizeFailReason(fail.status, fail.text));
    },
    renderExhausted: ({ lastError, lastFail }) =>
      new Response(
        JSON.stringify({
          error: {
            type: "gateway_pool_exhausted",
            message: `All ${accounts.length} API keys failed for "${providerId}". Last error: ${
              lastFail ? summarizeFailReason(lastFail.status, lastFail.text) : lastError?.message || "none"
            }`,
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      ),
    attempt: async (account) => {
      const apiKey = (account.apiKey || "").trim();
      if (!apiKey) return null; // 缺 key 跳过（不记失败）

      let resp: Response;
      try {
        resp = await makeRequest(apiKey);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        // 传输失败（网络层）：抛给驱动器记录后试下一账号
        console.warn(`[${label}] Account "${account.name || account.id}" transport error: ${(err as Error).message}`);
        throw err;
      }

      if (resp.ok) {
        // 成功即清除冷却标记（幂等；与 workbuddy 同语义）
        await setAccountCooldown(providerId, account, "clear");
        return {
          done: new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: buildResponseHeaders(resp.headers, {
              "X-Gateway-Account": account.id,
            }),
          }),
        };
      }

      // 401 = key 失效（标准协议无刷新能力）：惩罚退避（避免后续请求反复先打无效 key）+ 切换
      if (resp.status === 401) {
        const text = await resp.text();
        console.warn(
          `[${label}] Account "${account.name || account.id}" 401 (invalid key), cooling down and switching...`
        );
        await setAccountCooldown(providerId, account, "cooldown", summarizeFailReason(401, text));
        return {
          fail: {
            status: 401,
            text,
            force: "retry" as const, // 401 对 classify 是 fatal；此处显式要求切换下一账号
            response: new Response(text, {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
          },
        };
      }

      // 其余非 ok（429/402/403/5xx/400…）：交驱动器 classify 定去留
      const text = await resp.text();
      let parsedJson: Record<string, unknown> | null = null;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        /* noop */
      }
      return {
        fail: {
          status: resp.status,
          text,
          json: parsedJson,
          response: new Response(text, {
            status: resp.status,
            headers: { "Content-Type": "application/json" },
          }),
        },
      };
    },
  });
}
