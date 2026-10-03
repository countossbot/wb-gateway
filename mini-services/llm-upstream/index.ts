// 真实 LLM OpenAI 兼容上游 —— z-ai-web-dev-sdk 包装层（端口固定 3030）。
//
// 用途：给 Universal-AI-Gateway 提供一个「真实可推理」的 OpenAI 兼容上游，
// 打通 客户端 → 网关（鉴权/路由/配额/审计）→ 本服务 → z-ai SDK（GLM 后端） 全链路。
//
// 能力：
//   GET  /healthz —— 存活探针
//   GET  /v1/models —— 模型目录（全部实测可用：glm-4.6 / glm-4.5-air / glm-4-flash）
//   POST /v1/chat/completions —— 标准 OpenAI 形状：
//     · stream=false → 透传 SDK 的 chat.completion JSON（自带真实 usage）
//     · stream=true  → 透传 SDK 返回的 SSE 字节流（text/event-stream）
//     · Bearer 认证（UPSTREAM_API_KEY，默认见 .env）
//     · 消息净化：SDK 仅接受 system/user/assistant 纯文本 —— tool/function/developer
//       角色折叠为 user 前缀文本、多模态 content 数组拍平为文本、剥离 tools/tool_calls
//     · thinking 映射：reasoning_effort ∈ {high,medium} 或 thinking.enabled 或
//       reasoning.effort → SDK thinking enabled；默认 disabled
//
// 备注：SDK 对未知模型名可能报错 —— 目录只列实测通过的名字（探测记录见 worklog）。
//       model 字段透传给 SDK；后端实际由 glm-4-plus 服务（SDK 内部映射）。
//
// v4.9.12-local-r3：并发限流 —— 防止突发流量打爆 SDK 后端：
//   · 信号量上限 UPSTREAM_MAX_CONCURRENCY（默认 4）：同一时刻最多 N 个在途推理
//   · 超出后排队，最长等 UPSTREAM_QUEUE_WAIT_MS（默认 15000），超时返回 OpenAI 风格 429
//   · /healthz 暴露 { active, queued, maxConcurrency, rejected } 观测指标
import ZAI from "z-ai-web-dev-sdk";

const PORT = 3030;
const API_KEY = process.env.UPSTREAM_API_KEY || "sk-uag-upstream-local-2026";

// ---- 并发限流参数（env 可覆盖） ----
// 默认 1（串行）：实测 z-ai 后端对并发立即 429（"Too many requests"），串行化 +
// 排队是唯一稳定策略；请求在网关侧表现为耗时变长而非失败，符合 OpenAI 客户端重试语义。
// MIN_GAP_MS：上游还有「每秒次数」型窗口限流（串行连发也会 429），请求起始间强制最小间隔。
// RETRIES：429 时指数退避重试（1.2s * 2^n），单请求最多重试 N 次。
const MAX_CONCURRENCY = Math.max(1, Number(process.env.UPSTREAM_MAX_CONCURRENCY) || 1);
const QUEUE_WAIT_MS = Math.max(0, Number(process.env.UPSTREAM_QUEUE_WAIT_MS) || 15_000);
const MIN_GAP_MS = Math.max(0, Number(process.env.UPSTREAM_MIN_GAP_MS) || 1_100);
const RETRIES_ON_429 = Math.max(0, Number(process.env.UPSTREAM_RETRIES) || 2);

// ---- 实测可用的模型目录（2026-10-03 探针：三个名字均 200，后端 glm-4-plus） ----
const MODELS = ["glm-4.6", "glm-4.5-air", "glm-4-flash"] as const;

// v4.9.12-local-r6：模型画像元数据（/v1/models 扩展字段；标注型信息，非硬约束）
const MODEL_META: Record<string, { description: string; context: number | null; capabilities: Record<string, boolean> }> = {
  "glm-4.6": {
    description: "旗舰模型，适合复杂推理 / 长文写作 / 代码（后端由 glm-4-plus 服务）",
    context: 128000,
    capabilities: { reasoning: true, streaming: true, vision: false },
  },
  "glm-4.5-air": {
    description: "轻量均衡模型，响应快、性价比高，适合日常对话与摘要",
    context: 128000,
    capabilities: { reasoning: false, streaming: true, vision: false },
  },
  "glm-4-flash": {
    description: "极速模型，超低延迟，适合分类 / 短回答 / 高频调用场景",
    context: 128000,
    capabilities: { reasoning: false, streaming: true, vision: false },
  },
};

type SanitizedMessage = { role: "system" | "user" | "assistant"; content: string };

/** 把网关转译来的 OpenAI 消息数组折叠成 SDK 可接受的 纯文本 三角色形态 */
function sanitizeMessages(messages: unknown): SanitizedMessage[] {
  const out: SanitizedMessage[] = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages as Array<Record<string, unknown>>) {
    const role = typeof m?.role === "string" ? m.role : "user";
    let content = m?.content;
    // 多模态数组 → 文本拼接（text 部分；图片等本上游不支持，取 alt/忽略）
    if (Array.isArray(content)) {
      content = content
        .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (content == null) content = "";
    if (typeof content !== "string") content = JSON.stringify(content);
    if (role === "system" || role === "user" || role === "assistant") {
      out.push({ role, content });
    } else if (role === "tool") {
      // 工具结果 → user 前缀文本（tool_call_id 保留引用便于模型关联）
      const callId = typeof m?.tool_call_id === "string" ? m.tool_call_id : "";
      out.push({ role: "user", content: `[工具结果${callId ? ` #${callId}` : ""}]\n${content}` });
    } else {
      // developer / function / 未知角色 → user 前缀
      out.push({ role: "user", content: `[${role}]\n${content}` });
    }
  }
  return out;
}

/** 思维链开关映射：显式请求思考（多种写法容错）→ enabled */
function mapThinking(body: Record<string, unknown>): { type: "enabled" | "disabled" } {
  const t = body.thinking as Record<string, unknown> | undefined;
  if (t?.type === "enabled" || t?.enabled === true) return { type: "enabled" };
  const effort = (body.reasoning_effort as string | undefined) ?? (body.reasoning as Record<string, unknown> | undefined)?.effort;
  if (effort === "high" || effort === "medium") return { type: "enabled" };
  return { type: "disabled" };
}

/** SDK 实例懒加载缓存（--hot 重载后重建） */
let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;
let zaiFailedAt = 0;
async function getZai() {
  if (zaiInstance) return zaiInstance;
  if (Date.now() - zaiFailedAt < 3000) throw new Error("upstream SDK init recently failed, retry later");
  zaiInstance = await ZAI.create();
  return zaiInstance;
}

function authOk(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${API_KEY}`;
}

function errJson(message: string, status: number, code?: string): Response {
  return Response.json({ error: { message, type: "upstream_error", code: code ?? null } }, { status });
}

// ---- 并发信号量：acquire() 拿槽位（可排队/可超时），release() 归还 ----
// 另含最小起始间隔（窗口型限流防护）：nextStartAt 之前的请求需等待。
const limiter = {
  active: 0,
  queued: 0,
  rejected: 0,
  maxActiveSeen: 0,
  waiters: [] as Array<() => void>,
  nextStartAt: 0,

  tryAcquireSync(): boolean {
    if (this.active < MAX_CONCURRENCY) {
      this.active++;
      this.maxActiveSeen = Math.max(this.maxActiveSeen, this.active);
      return true;
    }
    return false;
  },

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.tryAcquireSync()) {
      await this.gapWait();
      return true;
    }
    if (timeoutMs <= 0) return false;
    this.queued++;
    try {
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const waiter = () => {
          if (settled) return;
          settled = true;
          this.active++;
          this.maxActiveSeen = Math.max(this.maxActiveSeen, this.active);
          resolve(true);
        };
        this.waiters.push(waiter);
        setTimeout(() => {
          if (settled) return;
          settled = true;
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, timeoutMs);
      });
      if (ok) await this.gapWait();
      return ok;
    } finally {
      this.queued--;
    }
  },

  /** 最小起始间隔：等到本请求允许的最早启动时刻，并预约该时刻 */
  async gapWait(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const wait = Math.max(0, this.nextStartAt - now);
      this.nextStartAt = Math.max(this.nextStartAt, now) + MIN_GAP_MS;
      if (wait <= 0) return;
      await new Promise((r) => setTimeout(r, wait));
      return;
    }
  },

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next(); // 唤醒排队者（active 槽位在 waiter 内自增，此处不重复）
  },
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const startedAt = Date.now();

    // ---- 存活探针（免鉴权，网关/运维探活用） ----
    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "llm-upstream",
        models: MODELS,
        uptime: process.uptime(),
        concurrency: { active: limiter.active, queued: limiter.queued, max: MAX_CONCURRENCY, rejectedTotal: limiter.rejected },
      });
    }

    // ---- 模型目录 ----
    // v4.9.12-local-r6：附带 OpenAI 扩展元数据（description / context_window / 能力位），
    // 便于网关与客户端展示模型画像；标准 OpenAI 客户端忽略未知字段，兼容无影响。
    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (!authOk(req)) return errJson("Invalid API Key", 401, "invalid_api_key");
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        object: "list",
        data: MODELS.map((id) => ({
          id,
          object: "model",
          created: now,
          owned_by: "zai-local",
          description: MODEL_META[id]?.description ?? "",
          context_window: MODEL_META[id]?.context ?? null,
          capabilities: MODEL_META[id]?.capabilities ?? {},
        })),
      });
    }

    // ---- Chat Completions ----
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!authOk(req)) return errJson("Invalid API Key", 401, "invalid_api_key");
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return errJson("Invalid JSON body", 400, "invalid_request_error");
      }
      const model = typeof body.model === "string" ? body.model : MODELS[0];
      const messages = sanitizeMessages(body.messages);
      if (messages.length === 0) return errJson("messages is required", 400, "invalid_request_error");

      // 并发限流：满载时排队，等待超过 QUEUE_WAIT_MS 拒绝（OpenAI 风格 429）
      const gotSlot = await limiter.acquire(QUEUE_WAIT_MS);
      if (!gotSlot) {
        limiter.rejected++;
        console.warn(`[chat] model=${model} REJECTED: concurrency full (active=${limiter.active} max=${MAX_CONCURRENCY}, waited ${QUEUE_WAIT_MS}ms)`);
        return Response.json(
          {
            error: {
              message: `Upstream at max concurrency (${MAX_CONCURRENCY}); queue wait exceeded ${QUEUE_WAIT_MS}ms. Retry later.`,
              type: "rate_limit_error",
              code: "upstream_concurrency_limit",
            },
          },
          { status: 429, headers: { "Retry-After": "3" } }
        );
      }

      // v4.9.11-sandbox-r3：max_tokens 钳制 —— 客户端常按「上下文窗口」（如目录里的 128K）
      // 设置 max_tokens，但真实后端（glm-4-plus 系）输出上限为 [1, 98304]（GLM 错误码 1210）。
      // 上游 400 直传会变成 502 且每次都失败；此处钳制到合法区间，顺带容错 0/负数/小数。
      const MAX_TOKENS_CAP = 98_304;
      const rawMaxTokens = typeof body.max_tokens === "number" ? body.max_tokens : NaN;
      const maxTokensClamped = Number.isFinite(rawMaxTokens)
        ? Math.min(Math.max(1, Math.floor(rawMaxTokens)), MAX_TOKENS_CAP)
        : undefined;
      const sdkBody = {
        model,
        messages,
        stream: body.stream === true,
        thinking: mapThinking(body),
        // 采样参数透传（SDK body 允许扩展键；后端不识别则忽略）
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
        ...(maxTokensClamped !== undefined ? { max_tokens: maxTokensClamped } : {}),
        // v4.9.12-local-r5：停止序列透传（OpenAI stop 语义；后端不支持时忽略，不影响请求）
        ...(Array.isArray(body.stop) && body.stop.length > 0 ? { stop: body.stop } : {}),
        ...(typeof body.stop === "string" && body.stop ? { stop: body.stop } : {}),
      };

      // 幂等释放哨兵 + 所有权转移：同一次持槽仅释放一次。
      // transferred=true 表示槽位已移交给流生命周期（flush/cancel 释放）；
      // 其余路径（非流式/合成帧/异常/pipeThrough 抛错）由 finally 定型释放。
      const slot = { held: true, transferred: false };
      const safeRelease = () => {
        if (slot.held) {
          slot.held = false;
          limiter.release();
        }
      };

      try {
        const zai = await getZai();
        // 429 退避重试：上游窗口限流（"API request failed with status 429"）时指数退避重发
        let upstream: unknown;
        let attempt = 0;
        for (;;) {
          try {
            upstream = await (zai.chat.completions.create as (b: unknown) => Promise<unknown>)(sdkBody);
            break;
          } catch (e) {
            const m = (e as Error)?.message ?? "";
            if (attempt < RETRIES_ON_429 && /status 429/.test(m)) {
              attempt++;
              const backoff = 1200 * 2 ** (attempt - 1);
              console.warn(`[chat] model=${model} upstream 429 → retry ${attempt}/${RETRIES_ON_429} in ${backoff}ms`);
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            throw e;
          }
        }
        if (attempt > 0) console.log(`[chat] model=${model} succeeded after ${attempt} retry(ies)`);
        const tookMs = Date.now() - startedAt;

        // ---- 非流式：SDK 已返回标准 chat.completion JSON，直接透传 ----
        if (body.stream !== true) {
          safeRelease();
          console.log(`[chat] model=${model} msgs=${messages.length} stream=false ok=${tookMs}ms (active=${limiter.active})`);
          return Response.json(upstream);
        }

        // ---- 流式：SDK 返回 ReadableStream（SSE 字节流），加头透传 ----
        // 槽位持有贯穿整个流生命周期：flush（正常流尾）/ cancel（客户端中断）时才释放
        const stream = upstream as ReadableStream<Uint8Array>;
        if (!(stream instanceof ReadableStream)) {
          // 兜底：个别版本可能直接返回完整对象 —— 合成单帧 SSE（SDK 调用已完成，立即还槽）
          console.log(`[chat] model=${model} stream=true (synthesized single frame) ok=${tookMs}ms`);
          const enc = new TextEncoder();
          const payload = JSON.stringify({
            id: `chatcmpl-${Date.now().toString(36)}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: (upstream as Record<string, any>)?.choices?.[0]?.message?.content ?? "" }, finish_reason: "stop" }],
          });
          const s = new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(`data: ${payload}\n\n`));
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
            cancel() {
              safeRelease();
            },
          });
          safeRelease();
          return new Response(s, sseHeaders());
        }
        console.log(`[chat] model=${model} msgs=${messages.length} stream=true ok=${tookMs}ms (active=${limiter.active})`);
        const guarded = stream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            flush() {
              safeRelease();
            },
            cancel() {
              safeRelease();
            },
          })
        );
        slot.transferred = true; // 所有权移交：flush（正常流尾）/ cancel（客户端中断）负责还槽
        // 兜底保险：若流生命周期异常终止且 flush/cancel 均未触发，最迟 10 分钟强制回收
        setTimeout(safeRelease, 10 * 60_000).unref?.();
        return new Response(guarded, sseHeaders());
      } catch (e) {
        const msg = (e as Error)?.message ?? "upstream error";
        console.error(`[chat] model=${model} FAILED (${Date.now() - startedAt}ms):`, msg.slice(0, 300));
        return errJson(`Upstream LLM error: ${msg}`, 502, "upstream_failure");
      } finally {
        if (!slot.transferred) safeRelease();
      }
    }

    return errJson(`Not found: ${req.method} ${url.pathname}`, 404);
  },
});

function sseHeaders(): ResponseInit {
  return {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  };
}

console.log(`[llm-upstream] listening on http://localhost:${PORT} (models: ${MODELS.join(", ")})`);
