// Qwen 网页版 provider —— chat.qwen.ai 的网关适配。
//
// v1 取舍（诚实记录，等价保留原版）：
// - 每网关请求开一个新 chat，OpenAI messages[] 历史压成单轮 user 文本（role 标注保留），
//   只打一次上游 SSE。相对「逐轮回放链」省 N-1 次调用；代价是 tool_calls 结构变文本（qwen 网页通道本就无函数调用）。
// - 历史放尾部追加，前缀字节稳定；若上游按内容做前缀缓存则天然命中。
// - 鉴权重放账号配置的 cookie + 指纹头（fingerprint.ts），不做加解密逆向；
//   指纹失效表现为 WAF 拦截 → 本模块统一判 429 → 网关冷却漂移 + 人工刷新指纹。
// - 多账号 = 多个 provider 条目（id 不同），经 routes 候选做模型级故障转移；本模块只管单账号。
import {
  QWENWEB_DEFAULT_BASE_URL,
  parseChatNew,
  splitHistory,
  truncateHistory,
  buildTurn,
  buildCompletionsBody,
  parseQwenSSEObject,
  isWAFStatus,
  isWAFBody,
} from "./protocol";
import { buildQwenHeaders } from "./fingerprint";
import { headersFromParts, mintIdentity, type QwenIdentity } from "./antiBot";
import { createGate, withGate } from "../../core/mutex";
import { buildResponseHeaders, sseHeaders } from "../../http/headers";
import { fetchWithProxy } from "../../proxy/proxyAgent";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { ProviderAdapter, ProviderConfig, ChatPayload, CallOptions, BalanceResult } from "../../core/types";

// 身份有效期：ssxmod/bx-ua 约 15 分钟，提前到 10 分钟轮换（宁早勿晚，避开过期窗口被风控加权）
const IDENTITY_TTL_MS = 10 * 60 * 1000;

// bx-umidtoken 抓取缓存（对齐上游 100 次一换；进程级，失败则降级为不带该头）。
let cachedMidtoken: string | null = null;
let midtokenUses = 0;

async function fetchMidtoken(): Promise<string | null> {
  if (cachedMidtoken && midtokenUses < 100) {
    midtokenUses += 1;
    return cachedMidtoken;
  }
  try {
    const res = await fetchWithProxy("https://sg-wum.alibaba.com/w/wu.json", {
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const m = text.match(/(?:umx\.wu|__fycb)\('([^']+)'\)/);
    if (m) {
      cachedMidtoken = m[1];
      midtokenUses = 0;
      return cachedMidtoken;
    }
  } catch {
    /* noop */
  }
  return cachedMidtoken;
}

export class QwenWebProvider implements ProviderAdapter {
  id: string;
  name: string;
  type = "qwenweb";
  config: Record<string, unknown>;
  // 网页通道只走 SSE（与 workbuddy 同理，forceStream 让 dispatch 统一强制流式）
  forceStream = true;
  // 设备身份稳定复用（一台「设备」长期用，符合真机行为；默认自动指纹见 callChat）。
  // 无配置时按 provider id 确定性派生：重启不变、账号间不碰撞、无需持久化。
  deviceId: string;
  // 定时任务刷新的身份缓存（内存 + SQLite 双层，跨重启由 DB 兜底，原 KV QWEN_FP_* 语义）
  private identity: QwenIdentity | null = null;
  private identityAt = 0;
  // 单并发门：同一账号同时只放 1 个在途上游调用，Claude Code 式 burst 在网关侧排队，
  // 不把并发行直接打给风控。客户端 abort 即摘除，不死锁。
  private gate = createGate();

  constructor(config: ProviderConfig) {
    this.id = config.id || "qwenweb";
    this.name = config.name || "Qwen Web (chat.qwen.ai)";
    this.config = (config.config || {}) as Record<string, unknown>;
    this.deviceId =
      (this.config.deviceId as string) ||
      createHash("sha256").update(`qwenweb-device:${this.id}`, "utf8").digest("hex").slice(0, 20);
  }

  identityKey(): string {
    return `qwenfp_${this.id}`;
  }

  private async readDbIdentity(): Promise<QwenIdentity | null> {
    try {
      const row = await db.systemSetting.findUnique({ where: { key: this.identityKey() } });
      if (!row) return null;
      const stored = row.value as unknown as QwenIdentity | string;
      const parsed = typeof stored === "string" ? (JSON.parse(stored) as QwenIdentity) : stored;
      return parsed || null;
    } catch {
      return null;
    }
  }

  // 取可用身份：内存 → SQLite → 现场 mint（mint 后写透 DB 供跨重启复用）。
  // 调用方（callChat / 定时任务）只认「10 分钟内」的身份，过期即换。
  async ensureIdentity(): Promise<QwenIdentity> {
    const now = Date.now();
    if (this.identity && now - this.identityAt < IDENTITY_TTL_MS) return this.identity;

    const stored = await this.readDbIdentity();
    if (stored && stored.cookie && stored.bxua && now - (stored.mintedAt || 0) < IDENTITY_TTL_MS) {
      this.identity = stored;
      this.identityAt = now;
      return stored;
    }

    const minted = mintIdentity({ deviceId: this.deviceId });
    const identity: QwenIdentity = { ...minted, umidtoken: null };
    try {
      const mid = await fetchMidtoken().catch(() => null);
      if (mid) identity.umidtoken = mid;
    } catch {
      /* noop */
    }
    this.identity = identity;
    this.identityAt = now;
    try {
      await db.systemSetting.upsert({
        where: { key: this.identityKey() },
        create: { key: this.identityKey(), value: identity as never },
        update: { value: identity as never },
      });
    } catch {
      /* noop */
    }
    return identity;
  }

  // 定时保活（调度器调用）：身份过期才 mint，无 token 配置时直接跳过。
  // workbuddy 签到是每天；指纹 10 分钟一换由 TTL 门控，任务频率变化不影响行为。
  async onSchedule(): Promise<{ success: boolean; extra?: string; mintedAt?: number }> {
    if (!this.account.token) return { success: false, extra: "no token configured, skip" };
    const identity = await this.ensureIdentity();
    return { success: true, mintedAt: identity.mintedAt };
  }

  get baseUrl(): string {
    const url = (this.config.baseUrl as string) || QWENWEB_DEFAULT_BASE_URL;
    return String(url).replace(/\/$/, "");
  }

  get account(): { token: string; cookie: string; fingerprint: Record<string, unknown> } {
    return {
      token: (this.config.token as string) || "",
      cookie: (this.config.cookie as string) || "",
      fingerprint: (this.config.fingerprint as Record<string, unknown>) || {},
    };
  }

  async callChat(payload: ChatPayload, options: CallOptions = {}): Promise<Response> {
    // T3 决议：system 全留 + 最近 20 轮，中部静默丢弃（保前缀稳定）
    const split = splitHistory(payload?.messages as never);
    const { systemPrefix, turns } = truncateHistory(split.systemPrefix, split.turns);
    if (turns.length === 0) {
      return new Response(
        JSON.stringify({ error: { message: "No user/assistant turns to send" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const model = (payload?.model as string) || "qwen3.7-plus";
    // 历史压单轮：system + 逐轮 role 标注，最新轮在尾（前缀稳定、可缓存）
    const squashed = [
      systemPrefix ? `System: ${systemPrefix}` : null,
      ...turns.slice(0, -1).map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.content}`),
      turns[turns.length - 1].content,
    ]
      .filter(Boolean)
      .join("\n\n");
    const turn = buildTurn({ role: "user", content: squashed }, model, {});

    if (this.gate.queued > 0) {
      console.warn(`[QwenWeb] Account "${this.id}" busy, ${this.gate.queued} queued (serializing burst)`);
    }
    return withGate(this.gate, options.signal, async () => {
      try {
        // 1) 建 chat 取 chat_id。身份优先级：账号抄录重放（最稳）> 定时任务/DB 身份 > 现场生成。
        // 现场生成走 ensureIdentity（自动写透 DB，下一次同进程指纹一致）。
        const autoFp = this.config.autoFingerprint !== false;
        let headers: Record<string, string>;
        if (this.account.cookie) {
          headers = buildQwenHeaders({ fingerprint: { ...this.account.fingerprint, cookie: this.account.cookie } });
          if (this.account.token) headers["Authorization"] = `Bearer ${this.account.token}`;
        } else if (autoFp) {
          const identity = await this.ensureIdentity();
          headers = headersFromParts({
            cookie: identity.cookie,
            bxua: identity.bxua,
            umidtoken: identity.umidtoken || undefined,
            token: this.account.token,
          });
        } else {
          headers = buildQwenHeaders({ fingerprint: {} });
          if (this.account.token) headers["Authorization"] = `Bearer ${this.account.token}`;
        }
        const newChatRes = await fetchWithProxy(
          `${this.baseUrl}/api/v2/chats/new`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({}),
            signal: options.signal ?? undefined,
          },
          { providerId: this.id }
        );
        const newChatText = await newChatRes.text();
        if (!newChatRes.ok || isWAFBody(newChatText)) {
          return this.wafOrError(newChatRes.status, newChatText);
        }
        let chatId: string | null = null;
        try {
          chatId = parseChatNew(JSON.parse(newChatText));
        } catch {
          /* noop */
        }
        if (!chatId) {
          return this.fail(502, `QwenWeb: cannot obtain chat_id: ${newChatText.slice(0, 120)}`);
        }

        // 2) 流式 completions，原样透传上游 SSE（归一在边读边转中完成）
        const body = buildCompletionsBody({ chatId, parentId: null, model, turn });
        const upstreamRes = await fetchWithProxy(
          `${this.baseUrl}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: options.signal ?? undefined,
          },
          { providerId: this.id }
        );
        const ctype = upstreamRes.headers.get("content-type") || "";
        if (!upstreamRes.ok || !ctype.includes("text/event-stream")) {
          // 非 SSE（含 application/json 业务错误包，如 FAIL_SYS_USER_VALIDATE）一律走错误收口，
          // 绝不把 JSON 当 SSE 空转成 200 空流（live 抓到的真实坑）。
          const errText = await upstreamRes.text().catch(() => "");
          return this.wafOrError(upstreamRes.status, errText);
        }
        return new Response(this.toOpenAIStream(upstreamRes.body as ReadableStream<Uint8Array>, model), {
          status: 200,
          headers: buildResponseHeaders(
            upstreamRes.headers,
            sseHeaders({
              "X-Gateway-Account": this.id,
              "X-Gateway-Account-Id": this.id,
            })
          ),
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        return this.fail(502, `QwenWeb upstream transport failed: ${(err as Error)?.message || err}`);
      }
    });
  }

  // 错误收口：WAF/验证码特征 → 429（网关冷却漂移）；其他 → 透状态码
  wafOrError(status: number, text: string): Response {
    if (isWAFStatus(status) || isWAFBody(text)) {
      console.warn(`[QwenWeb] WAF/captcha challenge on provider "${this.id}", cooling down`);
      return this.fail(
        429,
        "QwenWeb anti-bot challenge (WAF/captcha): account cooling down, refresh fingerprint if persistent"
      );
    }
    return this.fail(status || 502, text.slice(0, 300) || "QwenWeb upstream error");
  }

  fail(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // qwen 自定义 SSE → OpenAI chat.completion.chunk SSE（下游现有转译器直接可用；
  // thinking 走 reasoning_content 键，与 opencode 通道约定一致）
  toOpenAIStream(upstreamBody: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const created = Math.floor(Date.now() / 1000);
        const head = (delta: Record<string, unknown>, finish: string | null = null) =>
          encoder.encode(
            `data: ${JSON.stringify({
              id: `qwen-${created}`,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`
          );
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              let obj: Record<string, any> | null = null;
              try {
                obj = JSON.parse(raw);
              } catch {
                continue;
              }
              const ev = parseQwenSSEObject(obj);
              if (ev.kind === "reasoning" && ev.text) {
                controller.enqueue(head({ reasoning_content: ev.text }));
              } else if (ev.kind === "content" && ev.text) {
                controller.enqueue(head({ content: ev.text }));
              } else if (ev.kind === "done") {
                controller.enqueue(head({}, "stop"));
              }
              // notice/unknown/usage：静默跳过（usage 不透传，下游用量为网关估算）
            }
          }
        } catch (e) {
          controller.error(e);
          return;
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* noop */
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  async getBalance(): Promise<BalanceResult> {
    return { success: false, balance: null, total: null, extra: "Qwen 网页版无余额接口（免费 Web 配额）" };
  }
}
