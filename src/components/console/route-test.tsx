// 路由试跑对话框（v4.3.1 控制台调试工具）——「模型路由」页每行的 FlaskConical 按钮打开。
// 左侧：请求构造（路由/协议/系统提示/用户消息/参数/流式开关）+ 最近试跑历史（v4.3.2）；
// 右侧：结果面板（状态/耗时/落点徽标/候选链时间线/响应体查看）。
// 流式模式：fetch 增量读取 SSE，实时渲染 token 输出（含 ping 保活计数与原始帧查看）。
"use client";

import * as React from "react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleStop,
  FlaskConical,
  History as HistoryIcon,
  Loader2,
  OctagonX,
  Play,
  RotateCcw,
  Snowflake,
  StopCircle,
  Timer,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CopyButton } from "@/components/console/ui";
import { authHeaders, errMessage } from "@/lib/console/api";
import { relativeTime } from "@/lib/console/format";
import type { RouteRow, RouteTestResult, RouteTestTraceEvent, RouteTestUsage } from "@/lib/console/types";

/** 手动输入哨兵值：与候选编辑器同款约定（冒号不在模型名字符集内） */
const MODEL_MANUAL_SENTINEL = "custom:manual";

// ---- 表单状态跨开合持久（模块级缓存；对话框关闭再打开不丢草稿）----
interface TestFormState {
  model: string;
  modelCustom: boolean;
  protocol: "openai" | "anthropic";
  system: string;
  prompt: string;
  maxTokens: string;
  temperature: string;
  stream: boolean;
}
let lastFormState: TestFormState | null = null;

const DEFAULT_FORM: TestFormState = {
  model: "",
  modelCustom: false,
  protocol: "openai",
  system: "",
  prompt: "你好！请用一句话介绍你自己。",
  maxTokens: "128",
  temperature: "",
  stream: false,
};

type BodyView = "pretty" | "text" | "sse";

// ---- v4.3.2：最近试跑历史（localStorage 持久化，跨开合/跨会话；上限 8 条 FIFO）----

interface RouteTestHistoryEntry {
  id: string;
  /** 完成时刻（epoch ms） */
  at: number;
  /** 该次试跑的完整表单参数（「同参数重跑」恢复用） */
  form: TestFormState;
  status: number | null;
  latencyMs: number | null;
  /** 流式总时长（非流式缺省） */
  totalMs?: number | null;
  /** 失败/中止原因 */
  errorText?: string;
  trace: RouteTestTraceEvent[];
  hit?: { provider?: string; model?: string; account?: string | null; fallback: boolean } | null;
  usage?: RouteTestUsage | null;
  sseEvents?: number;
  /** 流式聚合文本（截断 2KB） */
  streamText?: string;
  /** 非流式响应体 JSON 序列化截断（4KB） */
  bodyPreview?: string;
}

const HISTORY_KEY = "uag_route_test_history";
const HISTORY_MAX = 8;

function readHistory(): RouteTestHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e): e is RouteTestHistoryEntry => !!e && typeof (e as RouteTestHistoryEntry).id === "string")
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function persistHistory(entries: RouteTestHistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
  } catch {
    /* 配额满等异常静默（历史属增强体验，不阻断主流程） */
  }
}

function newHistoryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- SSE 帧解析（OpenAI delta / Anthropic text_delta 双协议）----
function extractSseDelta(obj: unknown, protocol: "openai" | "anthropic"): string {
  const o = obj as Record<string, any> | null;
  if (!o || typeof o !== "object") return "";
  if (protocol === "openai") {
    const d = o.choices?.[0]?.delta?.content;
    return typeof d === "string" ? d : "";
  }
  if (o.type === "content_block_delta" && o.delta?.type === "text_delta") {
    return typeof o.delta.text === "string" ? o.delta.text : "";
  }
  return "";
}

function extractSseUsage(obj: unknown, protocol: "openai" | "anthropic"): Partial<RouteTestUsage> | null {
  const o = obj as Record<string, any> | null;
  if (!o || typeof o !== "object") return null;
  if (protocol === "openai" && o.usage && typeof o.usage === "object") {
    return {
      input: o.usage.prompt_tokens ?? null,
      output: o.usage.completion_tokens ?? null,
      cached: o.usage.prompt_tokens_details?.cached_tokens ?? null,
    };
  }
  if (protocol === "anthropic") {
    if (o.type === "message_start" && o.message?.usage) {
      return {
        input: o.message.usage.input_tokens ?? null,
        cached: o.message.usage.cache_read_input_tokens ?? null,
      };
    }
    if (o.type === "message_delta" && o.usage) {
      return { output: o.usage.output_tokens ?? null };
    }
  }
  return null;
}

/** 非流式 JSON 响应体中的 usage 字段（OpenAI / Anthropic 双口径） */
function extractJsonUsage(body: unknown): RouteTestUsage | undefined {
  const b = body as Record<string, any> | null;
  const u = b?.usage;
  if (!u || typeof u !== "object") return undefined;
  return {
    input: u.prompt_tokens ?? u.input_tokens ?? null,
    output: u.completion_tokens ?? u.output_tokens ?? null,
    cached:
      u.prompt_tokens_details?.cached_tokens ??
      u.cache_read_input_tokens ??
      u.cache_creation_input_tokens ??
      null,
  };
}

/** 从 trace 的 success 事件取命中候选序号（第 N 候选） */
function successCandidateIndex(trace: RouteTestTraceEvent[]): number | null {
  const s = trace.find((e) => e.type === "success");
  return s && typeof s.index === "number" ? s.index : null;
}

function statusPillClass(status: number): string {
  if (status >= 200 && status < 300) return "bg-emerald-100 text-emerald-800 border-emerald-300";
  if (status >= 300 && status < 400) return "bg-stone-100 text-stone-700 border-stone-300";
  if (status >= 400 && status < 500) return "bg-amber-100 text-amber-800 border-amber-300";
  return "bg-red-100 text-red-800 border-red-300";
}

// ---- 单条 trace 事件渲染 ----
function TraceRow({ ev, providerName }: { ev: RouteTestTraceEvent; providerName: (id?: string) => string }) {
  const t = `+${ev.t}ms`;
  let icon: React.ReactNode;
  let tone = "text-stone-500";
  let title = "";
  let detail: React.ReactNode = null;

  switch (ev.type) {
    case "noroute":
      icon = <Ban className="size-3.5 text-red-500" />;
      tone = "text-red-700";
      title = `未找到路由「${ev.model}」——404`;
      detail =
        ev.available && ev.available.length > 0 ? (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {ev.available.slice(0, 10).map((m) => (
              <code key={m} className="rounded bg-stone-100 px-1 py-px font-mono text-[10px] text-stone-600">{m}</code>
            ))}
            {ev.available.length > 10 && <span className="text-[10px] text-stone-400">等 {ev.available.length} 个</span>}
          </span>
        ) : (
          <span className="mt-0.5 text-[11px] text-stone-500">当前没有任何已启用路由</span>
        );
      break;
    case "attempt":
      icon = <Circle className="size-3.5 text-stone-400" />;
      title = `尝试候选 #${(ev.index ?? 0) + 1} · ${providerName(ev.provider)}`;
      detail = <code className="font-mono text-[10px] text-stone-500">{ev.model}</code>;
      break;
    case "error":
      icon = <AlertTriangle className="size-3.5 text-amber-500" />;
      tone = "text-amber-800";
      title = `${providerName(ev.provider)} 传输异常`;
      detail = <span className="text-[11px] text-stone-600">{ev.message}</span>;
      break;
    case "fail":
      icon = <StopCircle className="size-3.5 text-red-500" />;
      tone = "text-red-700";
      title = `${providerName(ev.provider)} 返回 HTTP ${ev.status}`;
      detail = <span className="break-all text-[11px] text-stone-600">{ev.summary}</span>;
      break;
    case "retry":
      icon = ev.action === "cooldown" ? <Snowflake className="size-3.5 text-sky-500" /> : <ArrowRight className="size-3.5 text-amber-500" />;
      title =
        ev.action === "cooldown"
          ? `${providerName(ev.provider)} 进入冷却，切换下一候选`
          : `${providerName(ev.provider)} 切换下一候选重试`;
      break;
    case "fatal":
      icon = <OctagonX className="size-3.5 text-red-500" />;
      tone = "text-red-700";
      title = `参数级错误直返（HTTP ${ev.status}，不进行故障转移）`;
      detail = <span className="break-all text-[11px] text-stone-600">{ev.message}</span>;
      break;
    case "success":
      icon = <CheckCircle2 className="size-3.5 text-emerald-600" />;
      tone = "text-emerald-800";
      title = `命中候选 #${(ev.index ?? 0) + 1} · ${providerName(ev.provider)}${ev.fallback ? "（故障转移后命中）" : ""}`;
      detail = (
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <code className="rounded bg-stone-100 px-1 py-px font-mono text-[10px] text-stone-600">{ev.model}</code>
          {ev.account && <Badge variant="outline" className="h-4 px-1 text-[9px] text-violet-700">账号 {ev.account}</Badge>}
          <span className="text-[10px] text-stone-400">{ev.contentType}</span>
        </span>
      );
      break;
    case "exhausted":
      icon = <OctagonX className="size-3.5 text-red-600" />;
      tone = "text-red-700";
      title = "候选链全部耗尽 —— 502";
      detail = <span className="break-all text-[11px] text-stone-600">{ev.lastError || "无最后错误信息"}</span>;
      break;
    default:
      icon = <Circle className="size-3" />;
  }

  return (
    <li className="flex gap-2 py-1">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-xs font-medium ${tone}`}>{title}</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-stone-400">{t}</span>
        </div>
        {detail}
      </div>
    </li>
  );
}

export function RouteTestDialog({
  open,
  onOpenChange,
  routes,
  providers,
  initialModel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  routes: RouteRow[];
  providers: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  /** 打开时预选的模型（点击行内「试跑」按钮传入） */
  initialModel?: string;
}) {
  const [form, setForm] = React.useState<TestFormState>(lastFormState ?? DEFAULT_FORM);
  const [formError, setFormError] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [result, setResult] = React.useState<RouteTestResult | null>(null);
  const [error, setError] = React.useState("");
  const [bodyView, setBodyView] = React.useState<BodyView>("pretty");
  const [rawSse, setRawSse] = React.useState<string[]>([]);
  const abortRef = React.useRef<AbortController | null>(null);
  // v4.3.2：最近试跑历史（localStorage 持久；成功/失败/手动停止均记录，供回看与同参数重跑）
  const [history, setHistory] = React.useState<RouteTestHistoryEntry[]>(() => readHistory());
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyDetailId, setHistoryDetailId] = React.useState("");

  /** 追加一条试跑历史（FIFO 截断；localStorage 同步持久化） */
  const pushHistory = React.useCallback((entry: RouteTestHistoryEntry) => {
    setHistory((h) => {
      const next = [entry, ...h].slice(0, HISTORY_MAX);
      persistHistory(next);
      return next;
    });
  }, []);

  const clearHistory = React.useCallback(() => {
    setHistory([]);
    setHistoryDetailId("");
    persistHistory([]);
  }, []);

  /** 「同参数重跑」：恢复该次的完整表单并折叠详情（用户点「发送试跑」执行） */
  const restoreForm = React.useCallback((e: RouteTestHistoryEntry) => {
    setForm({ ...e.form });
    setHistoryDetailId("");
    setFormError("");
    setHistoryOpen(false);
  }, []);

  // 打开时：预选模型 + 初始化视图态
  React.useEffect(() => {
    if (open) {
      if (initialModel) {
        const known = routes.some((r) => r.model === initialModel);
        setForm((f) => ({ ...f, model: initialModel, modelCustom: !known }));
      }
      setFormError("");
      setError("");
      setBodyView((f) => (f === "sse" ? "text" : f));
    }
  }, [open, initialModel, routes]);

  // 关闭或卸载时中断在途请求（联动上游断流，不泄漏）
  React.useEffect(() => {
    if (!open && running) abortRef.current?.abort();
  }, [open, running]);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const patch = (p: Partial<TestFormState>) => setForm((f) => ({ ...f, ...p }));

  const providerName = React.useCallback(
    (id?: string) => (id ? providers.find((p) => p.id === id)?.name || id : ""),
    [providers]
  );

  const selectedRoute = routes.find((r) => r.model === form.model);
  const useModelSelect = !form.modelCustom;

  const stop = () => abortRef.current?.abort();

  const run = async () => {
    setFormError("");
    setError("");
    const model = form.model.trim();
    if (!model) {
      setFormError("请选择或输入要试跑的模型名");
      return;
    }
    if (!form.prompt.trim()) {
      setFormError("用户消息不能为空");
      return;
    }
    const maxTokens = Math.min(Math.max(Math.floor(Number(form.maxTokens) || 128), 1), 4096);
    lastFormState = { ...form, model };
    setResult(null);
    setRawSse([]);
    setBodyView(form.stream ? "text" : "pretty");
    setRunning(true);
    setElapsed(0);
    const t0 = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - t0), 100);
    const ac = new AbortController();
    abortRef.current = ac;
    // v4.3.2：本轮流式路径是否已在流内 finally 记录历史（外层 catch 补录前检查，避免双记）
    let streamHistoryRecorded = false;
    const historyForm: TestFormState = { ...form, model, maxTokens: String(maxTokens) };
    try {
      const res = await fetch("/api/console/routes/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          model,
          protocol: form.protocol,
          system: form.system,
          prompt: form.prompt,
          stream: form.stream,
          maxTokens,
          temperature: form.temperature.trim() === "" ? undefined : Number(form.temperature),
        }),
        signal: ac.signal,
      });
      if (res.status === 401) {
        throw new Error("未登录或会话已过期，请重新登录后再试跑");
      }
      const ct = res.headers.get("content-type") || "";

      if (ct.includes("text/event-stream") && res.body) {
        // ---- 流式：trace/落点从头读取，SSE 增量消费 ----
        let trace: RouteTestTraceEvent[] = [];
        try {
          trace = JSON.parse(res.headers.get("x-test-trace") || "[]") as RouteTestTraceEvent[];
        } catch {
          /* trace 头损坏时降级为空时间线 */
        }
        const base: RouteTestResult = {
          status: res.status,
          latencyMs: Number(res.headers.get("x-test-latency") || 0),
          meta: {
            account: res.headers.get("x-gateway-account"),
            upstreamModel: res.headers.get("x-gateway-model"),
            fallback: res.headers.get("x-gateway-fallback") === "true",
            contentType: ct,
            providerBalance: (() => {
              try {
                const rawBalance = res.headers.get("x-test-balance");
                return rawBalance ? JSON.parse(rawBalance) : null;
              } catch {
                return null;
              }
            })(),
          },
          trace,
          streamText: "",
          sseEvents: 0,
          pings: 0,
          streamDone: false,
        };
        setResult(base);
        const tStreamStart = Date.now();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let text = "";
        let events = 0;
        let pings = 0;
        let usage: RouteTestUsage | undefined;
        let rawFrames: string[] = [];
        let lastPaint = 0;
        // v4.3.2：流中断原因（正常结束时为空串；进 finally 统一写入历史）
        let streamError = "";
        const paint = (force = false) => {
          // 节流实时渲染（≥120ms 一次）：token 增量立即可见，又不至于每帧触发 React 更新
          const now = Date.now();
          if (!force && now - lastPaint < 120) return;
          lastPaint = now;
          setResult((r) =>
            r
              ? { ...r, streamText: text, sseEvents: events, pings, usage, streamDone: false }
              : r
          );
        };
        const consume = (block: string) => {
          // 一个 SSE 事件块（\n\n 分隔）：抽 data 行
          const dataLines = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (block.includes("event: ping") || block.startsWith(":")) {
            pings += 1;
            return;
          }
          if (dataLines.length === 0) return;
          const data = dataLines.join("\n");
          if (data === "[DONE]") return;
          let obj: unknown;
          try {
            obj = JSON.parse(data);
          } catch {
            return;
          }
          events += 1;
          rawFrames.push(data);
          const delta = extractSseDelta(obj, form.protocol);
          if (delta) text += delta;
          const u = extractSseUsage(obj, form.protocol);
          if (u) usage = { ...usage, ...u } as RouteTestUsage;
          paint();
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              if (block.trim()) consume(block);
            }
          }
          if (buf.trim()) consume(buf);
        } catch (streamErr) {
          // v4.3.2：流中断/熔断/手动停止 —— 记录中断原因后统一收尾（不再向外抛，避免双重报错）
          streamError =
            streamErr instanceof Error && streamErr.name === "AbortError"
              ? "已手动停止"
              : errMessage(streamErr);
        } finally {
          // 流结束（正常 / 中断 / 熔断统一收尾）：聚合增量结果一次性落位
          setResult((r) =>
            r
              ? {
                  ...r,
                  streamText: text,
                  sseEvents: events,
                  pings,
                  usage,
                  streamDone: true,
                  rawLength: rawFrames.reduce((s, f) => s + f.length, 0),
                }
              : r
          );
          setRawSse(rawFrames);
          setElapsed(Date.now() - t0);
          // v4.3.2：流式历史落位（含部分输出的中断记录；streamText 截断 2KB）
          const successEv = trace.find((ev) => ev.type === "success");
          pushHistory({
            id: newHistoryId(),
            at: Date.now(),
            form: historyForm,
            status: base.status,
            latencyMs: base.latencyMs,
            totalMs: Date.now() - t0,
            errorText: streamError || undefined,
            trace,
            hit: successEv
              ? { provider: successEv.provider, model: successEv.model, account: base.meta.account, fallback: base.meta.fallback }
              : null,
            usage: usage ?? null,
            sseEvents: events,
            streamText: text.slice(0, 2048),
          });
          streamHistoryRecorded = true;
        }
      } else {
        // ---- 非流式：JSON 信封 ----
        const env = (await res.json().catch(() => null)) as { ok?: boolean; data?: RouteTestResult; error?: string } | null;
        if (!env) throw new Error(`服务端返回异常（HTTP ${res.status}）`);
        if (!env.ok) throw new Error(env.error || `试跑失败（HTTP ${res.status}）`);
        const data = env.data;
        if (!data) throw new Error("服务端返回数据缺失");
        const usageFinal = extractJsonUsage(data.body);
        setResult({ ...data, usage: usageFinal });
        // v4.3.2：非流式历史落位（响应体序列化截断 4KB）
        const successEv = (data.trace || []).find((ev) => ev.type === "success");
        let bodyPreview: string | undefined;
        try {
          bodyPreview = data.body === undefined || data.body === null ? undefined : JSON.stringify(data.body, null, 2)?.slice(0, 4096);
        } catch {
          bodyPreview = undefined;
        }
        pushHistory({
          id: newHistoryId(),
          at: Date.now(),
          form: historyForm,
          status: data.status,
          latencyMs: data.latencyMs,
          trace: data.trace || [],
          hit: successEv
            ? { provider: successEv.provider, model: successEv.model, account: data.meta?.account ?? null, fallback: !!data.meta?.fallback }
            : null,
          usage: usageFinal ?? null,
          bodyPreview,
        });
      }
    } catch (e) {
      const abortMsg = (e as Error).name === "AbortError";
      const msg = abortMsg ? "已手动停止（上游连接随之中断）" : errMessage(e);
      setError(msg);
      // v4.3.2：非流式失败 / 连接失败补录历史（流式部分数据已在流内 finally 记录，不双记）
      if (!streamHistoryRecorded) {
        pushHistory({
          id: newHistoryId(),
          at: Date.now(),
          form: historyForm,
          status: null,
          latencyMs: null,
          errorText: msg,
          trace: [],
          hit: null,
        });
      }
    } finally {
      window.clearInterval(timer);
      setElapsed((_) => Date.now() - t0);
      setRunning(false);
      abortRef.current = null;
    }
  };

  // ---- 渲染素材 ----
  const successIdx = result ? successCandidateIndex(result.trace) : null;
  const traceSuccess = result?.trace.find((e) => e.type === "success");
  const usage = result?.usage;
  const prettyJson = React.useMemo(() => {
    if (!result || result.body === undefined || result.body === null) return "";
    try {
      return typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2);
    } catch {
      return String(result.body);
    }
  }, [result]);

  const bodyViewButtons = form.stream && result?.streamText !== undefined
    ? (
      <div className="flex items-center gap-1">
        {(["text", "sse"] as BodyView[]).map((v) => (
          <Button
            key={v}
            type="button"
            size="sm"
            variant={bodyView === v ? "secondary" : "ghost"}
            className="h-6 px-2 text-[11px]"
            onClick={() => setBodyView(v)}
          >
            {v === "text" ? "聚合文本" : `原始 SSE（${result?.sseEvents ?? 0} 帧）`}
          </Button>
        ))}
      </div>
    )
    : result?.body !== undefined
      ? (
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant={bodyView === "pretty" ? "secondary" : "ghost"} className="h-6 px-2 text-[11px]" onClick={() => setBodyView("pretty")}>
            格式化 JSON
          </Button>
        </div>
      )
      : null;

  return (
    <Dialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-rose-600" />
            路由试跑
          </DialogTitle>
          <DialogDescription>
            以管理员身份发起一次真实链路调用：路由解析 → 候选故障转移 → 协议转译 → 上游（含代理/账号池/冷却），与生产流量同一条代码路径。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* ---------- 左：请求构造 ---------- */}
          <div className="space-y-3 lg:col-span-2">
            <div className="space-y-1.5">
              <Label>模型（路由名）</Label>
              {useModelSelect ? (
                <Select
                  value={routes.some((r) => r.model === form.model) ? form.model : undefined}
                  onValueChange={(v) => {
                    if (v === MODEL_MANUAL_SENTINEL) patch({ modelCustom: true, model: "" });
                    else patch({ model: v });
                  }}
                >
                  <SelectTrigger size="sm" className="font-mono text-xs">
                    <SelectValue placeholder="选择要试跑的路由" />
                  </SelectTrigger>
                  <SelectContent>
                    {routes.map((r) => (
                      <SelectItem key={r.model} value={r.model}>
                        <code className="font-mono text-xs">{r.model}</code>
                        <span className="ml-1 text-[10px] text-stone-400">{r.candidates.length} 候选</span>
                        {!r.enabled && <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px] text-stone-500">停用</Badge>}
                      </SelectItem>
                    ))}
                    <SelectItem value={MODEL_MANUAL_SENTINEL}>
                      <span className="text-xs text-muted-foreground">手动输入其他模型…</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex gap-1.5">
                  <Input
                    value={form.model}
                    onChange={(e) => patch({ model: e.target.value })}
                    placeholder="未建路由的模型名（将返回 404 诊断）"
                    className="h-8 font-mono text-xs"
                  />
                  <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => patch({ modelCustom: false, model: "" })}>
                    列表
                  </Button>
                </div>
              )}
              {selectedRoute && !selectedRoute.enabled && (
                <p className="text-[11px] text-amber-600">该路由已停用——停用路由不进调度，试跑将返回 404。</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>入口协议</Label>
              <Select value={form.protocol} onValueChange={(v) => patch({ protocol: v as "openai" | "anthropic" })}>
                <SelectTrigger size="sm" className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI · /v1/chat/completions</SelectItem>
                  <SelectItem value="anthropic">Anthropic · /v1/messages</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-stone-500">
                {form.protocol === "openai"
                  ? "与生产 OpenAI 客户端同构；若上游是 Anthropic 原生协议，网关自动转译。"
                  : "与 Claude Code 等客户端同构；若上游是 OpenAI 兼容协议，网关自动转译。"}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rtt-system">系统提示词（可选）</Label>
              <textarea
                id="rtt-system"
                value={form.system}
                onChange={(e) => patch({ system: e.target.value })}
                rows={2}
                placeholder="如：你是一个简洁的中文助手"
                className="w-full resize-y rounded-md border border-stone-200 bg-white px-2.5 py-1.5 font-mono text-xs shadow-xs placeholder:text-stone-400 focus-visible:border-stone-400 focus-visible:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rtt-prompt">用户消息</Label>
              <textarea
                id="rtt-prompt"
                value={form.prompt}
                onChange={(e) => patch({ prompt: e.target.value })}
                rows={3}
                placeholder="发送给模型的内容"
                className="w-full resize-y rounded-md border border-stone-200 bg-white px-2.5 py-1.5 font-mono text-xs shadow-xs placeholder:text-stone-400 focus-visible:border-stone-400 focus-visible:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="rtt-max">max_tokens</Label>
                <Input id="rtt-max" type="number" min={1} max={4096} value={form.maxTokens} onChange={(e) => patch({ maxTokens: e.target.value })} className="h-8 text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rtt-temp">temperature</Label>
                <Input id="rtt-temp" type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(e) => patch({ temperature: e.target.value })} placeholder="默认" className="h-8 text-xs" />
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2">
              <Switch id="rtt-stream" checked={form.stream} onCheckedChange={(v) => patch({ stream: v })} />
              <Label htmlFor="rtt-stream" className="font-normal leading-tight">
                流式（SSE）
                <span className="block text-[10px] text-stone-500">实时观察 token 增量、保活 ping 与断流熔断</span>
              </Label>
            </div>

            {formError && <p className="text-xs text-red-600" role="alert">{formError}</p>}

            <div className="flex items-center gap-2">
              {running ? (
                <>
                  <Button type="button" size="sm" className="flex-1 bg-stone-900 hover:bg-stone-800" disabled>
                    <Loader2 className="animate-spin" />
                    试跑中 · {(elapsed / 1000).toFixed(1)}s
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={stop} aria-label="停止试跑">
                    <CircleStop className="text-red-500" />
                    停止
                  </Button>
                </>
              ) : (
                <Button type="button" size="sm" className="flex-1 bg-stone-900 hover:bg-stone-800" onClick={() => void run()}>
                  <Play />
                  发送试跑
                </Button>
              )}
            </div>
            <p className="text-[10px] leading-relaxed text-stone-500">
              <Timer className="mr-0.5 inline size-3" />
              试跑走真实链路：上游正常计费，计入运行日志（密钥名 <code className="font-mono">console-test</code>）与今日统计。
            </p>

            {/* v4.3.2：最近试跑历史（localStorage 持久化，跨开合/跨会话；上限 8 条 FIFO；
                成功/失败/手动停止均记录；点击条目展开回看（trace 时间线 + 输出预览），RotateCcw 同参数重跑） */}
            <div className="rounded-lg border border-stone-200">
              <div className="flex items-center gap-1.5 border-b border-stone-100 px-3 py-2">
                <HistoryIcon className="size-3.5 shrink-0 text-stone-400" aria-hidden />
                <button
                  type="button"
                  onClick={() => setHistoryOpen((o) => !o)}
                  aria-expanded={historyOpen}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span className="text-[11px] font-medium text-stone-600">最近试跑</span>
                  {history.length > 0 && (
                    <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] tabular-nums text-stone-500">
                      {history.length}
                    </Badge>
                  )}
                  <ChevronRight
                    className={`ml-auto size-3.5 shrink-0 text-stone-400 transition-transform ${historyOpen ? "rotate-90" : ""}`}
                    aria-hidden
                  />
                </button>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={clearHistory}
                    title="清空试跑历史（仅本机浏览器记录，不影响运行日志）"
                    aria-label="清空试跑历史"
                    className="shrink-0 rounded p-1 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              {historyOpen && (
                <div className="max-h-80 overflow-y-auto">
                  {history.length === 0 ? (
                    <p className="px-3 py-3 text-[10px] leading-relaxed text-stone-400">
                      暂无试跑记录。完成一次试跑后，最近 8 次将保留在本机浏览器（跨会话持久），可随时回看候选链与输出。
                    </p>
                  ) : (
                    <ul className="divide-y divide-stone-50">
                      {history.map((h) => {
                        const isErr = h.status === null;
                        const successEv = h.trace.find((ev) => ev.type === "success");
                        const expanded = historyDetailId === h.id;
                        return (
                          <li key={h.id}>
                            {/* 摘要行：状态 pill + 模型 + 相对时间 */}
                            <div className="flex items-center gap-1.5 px-3 py-1.5">
                              <button
                                type="button"
                                onClick={() => setHistoryDetailId((cur) => (cur === h.id ? "" : h.id))}
                                aria-expanded={expanded}
                                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-stone-50"
                                title={expanded ? "收起详情" : "展开该次试跑详情（候选链时间线 + 输出预览）"}
                              >
                                <span
                                  className={`inline-flex shrink-0 items-center rounded border px-1 py-px text-[9px] font-semibold tabular-nums ${
                                    isErr
                                      ? "border-red-200 bg-red-50 text-red-600"
                                      : statusPillClass(h.status ?? 0)
                                  }`}
                                >
                                  {isErr ? "ERR" : h.status}
                                </span>
                                <span className="min-w-0 truncate font-mono text-[10px] text-stone-700">{h.form.model}</span>
                                {h.form.stream && (
                                  <Badge variant="outline" className="h-3.5 shrink-0 px-1 text-[8px] text-cyan-700">
                                    流式
                                  </Badge>
                                )}
                                <span className="ml-auto shrink-0 text-[9px] text-stone-400" title={new Date(h.at).toLocaleString()}>
                                  {relativeTime(new Date(h.at).toISOString())}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => restoreForm(h)}
                                title="以该次参数回填表单（回填后点「发送试跑」重跑）"
                                aria-label={`以 ${h.form.model} 的该次参数回填表单`}
                                className="shrink-0 rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
                              >
                                <RotateCcw className="size-3" />
                              </button>
                            </div>
                            {/* 展开详情：元信息徽标行 + trace 时间线 + 输出预览 */}
                            {expanded && (
                              <div className="space-y-1.5 px-3 pb-2.5 pt-0.5">
                                <div className="flex flex-wrap items-center gap-1 text-[9px]">
                                  <Badge variant="outline" className="h-4 px-1 text-stone-500">
                                    {h.form.protocol === "openai" ? "OpenAI" : "Anthropic"}
                                  </Badge>
                                  {h.latencyMs != null && (
                                    <Badge variant="outline" className="h-4 px-1 tabular-nums text-stone-500">
                                      {h.totalMs != null ? `首字节 ${h.latencyMs}ms · 总 ${h.totalMs}ms` : `耗时 ${h.latencyMs}ms`}
                                    </Badge>
                                  )}
                                  {successEv && (
                                    <Badge variant="outline" className="h-4 max-w-36 truncate px-1 text-emerald-700" title={`${successEv.provider} / ${successEv.model}`}>
                                      {providerName(successEv.provider)}
                                      <ChevronRight className="size-2.5" />
                                      <code className="font-mono">{successEv.model}</code>
                                    </Badge>
                                  )}
                                  {h.hit?.account && (
                                    <Badge variant="outline" className="h-4 max-w-28 truncate px-1 text-violet-700" title={`落点账号 ${h.hit.account}`}>
                                      账号 {h.hit.account}
                                    </Badge>
                                  )}
                                  {h.hit?.fallback && (
                                    <Badge variant="outline" className="h-4 px-1 border-amber-300 bg-amber-50 text-amber-700">
                                      故障转移
                                    </Badge>
                                  )}
                                  {h.usage && (h.usage.input != null || h.usage.output != null) && (
                                    <Badge variant="outline" className="h-4 px-1 tabular-nums text-stone-500">
                                      ↑{h.usage.input ?? "?"} / ↓{h.usage.output ?? "?"}{h.usage.cached ? `（缓存 ${h.usage.cached}）` : ""}
                                    </Badge>
                                  )}
                                  {h.sseEvents != null && h.sseEvents > 0 && (
                                    <Badge variant="outline" className="h-4 px-1 tabular-nums text-stone-500">
                                      SSE {h.sseEvents} 帧
                                    </Badge>
                                  )}
                                </div>
                                {h.errorText && (
                                  <p className="rounded border border-red-100 bg-red-50/70 px-2 py-1 text-[10px] text-red-600" role="note">
                                    {h.errorText}
                                  </p>
                                )}
                                {h.trace.length > 0 && (
                                  <div className="rounded border border-stone-100">
                                    <ScrollArea className="max-h-32">
                                      <ul className="divide-y divide-stone-50 px-2 py-0.5">
                                        {h.trace.map((ev, i) => (
                                          <TraceRow key={`${ev.type}-${i}-${ev.t}`} ev={ev} providerName={providerName} />
                                        ))}
                                      </ul>
                                    </ScrollArea>
                                  </div>
                                )}
                                {h.streamText != null && h.streamText !== "" && (
                                  <div>
                                    <p className="text-[9px] font-medium text-stone-400">输出预览（截断）</p>
                                    <pre className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded border border-stone-100 bg-stone-50/60 px-2 py-1 font-mono text-[9px] leading-relaxed text-stone-600">
                                      {h.streamText}
                                    </pre>
                                  </div>
                                )}
                                {h.bodyPreview != null && h.bodyPreview !== "" && (
                                  <div>
                                    <p className="text-[9px] font-medium text-stone-400">响应体（截断）</p>
                                    <pre className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded border border-stone-100 bg-stone-50/60 px-2 py-1 font-mono text-[9px] leading-relaxed text-stone-600">
                                      {h.bodyPreview}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ---------- 右：结果面板 ---------- */}
          <div className="flex min-w-0 flex-col gap-3 lg:col-span-3">
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {error}
              </div>
            )}

            {!result && !running && (
              <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-6 text-center">
                <FlaskConical className="size-6 text-stone-300" />
                <p className="text-xs text-stone-500">填写左侧表单，点击「发送试跑」</p>
                <p className="max-w-72 text-[10px] leading-relaxed text-stone-400">
                  结果面板将展示：HTTP 状态与耗时、命中的提供商/账号（含故障转移路径）、候选链时间线、响应体与 token 用量。
                </p>
              </div>
            )}

            {running && !result && (
              <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 rounded-lg border border-stone-200 bg-white p-6">
                <Loader2 className="size-5 animate-spin text-stone-400" />
                <p className="text-xs text-stone-500">正在调用上游 · {(elapsed / 1000).toFixed(1)}s</p>
              </div>
            )}

            {result && (
              <>
                {/* 状态行 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums ${statusPillClass(result.status)}`}>
                    HTTP {result.status}
                  </span>
                  <Badge variant="outline" className="text-[10px] text-stone-600">
                    {result.streamDone !== undefined && result.streamText !== undefined
                      ? `首字节 ${result.latencyMs}ms · 总 ${(elapsed / 1000).toFixed(1)}s`
                      : `耗时 ${result.latencyMs}ms`}
                  </Badge>
                  {traceSuccess && (
                    <Badge variant="outline" className="max-w-44 truncate text-[10px] text-emerald-700" title={`${traceSuccess.provider} / ${traceSuccess.model}`}>
                      {providerName(traceSuccess.provider)}
                      <ChevronRight className="size-2.5" />
                      <code className="font-mono">{traceSuccess.model}</code>
                    </Badge>
                  )}
                  {result.meta.account && (
                    <Badge variant="outline" className="max-w-36 truncate text-[10px] text-violet-700" title={`落点账号 ${result.meta.account}`}>
                      账号 {result.meta.account}
                    </Badge>
                  )}
                  {result.meta.providerBalance && (
                    <Badge variant="outline" className="text-[10px]">
                      提供商总余额：{result.meta.providerBalance.total} {result.meta.providerBalance.unit}
                    </Badge>
                  )}
                  {result.meta.fallback && successIdx !== null && (
                    <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10px] text-amber-700">
                      故障转移 · 第 {successIdx + 1} 候选命中
                    </Badge>
                  )}
                  {usage && (usage.input != null || usage.output != null) && (
                    <Badge variant="outline" className="text-[10px] text-stone-600">
                      ↑{usage.input ?? "?"} / ↓{usage.output ?? "?"} tokens{usage.cached ? `（缓存 ${usage.cached}）` : ""}
                    </Badge>
                  )}
                  {result.streamText !== undefined && result.streamDone && (
                    <Badge variant="outline" className="text-[10px] text-stone-600">
                      SSE {result.sseEvents ?? 0} 帧{result.pings ? ` · ping ×${result.pings}` : ""}
                    </Badge>
                  )}
                </div>

                {/* 候选链时间线 */}
                {result.trace.length > 0 && (
                  <div className="rounded-lg border border-stone-200 bg-white">
                    <div className="border-b border-stone-100 px-3 py-1.5 text-[11px] font-medium text-stone-600">
                      候选链时间线（{result.trace.length} 事件）
                    </div>
                    <ScrollArea className="max-h-44">
                      <ul className="divide-y divide-stone-50 px-3 py-1">
                        {result.trace.map((ev, i) => (
                          <TraceRow key={`${ev.type}-${i}-${ev.t}`} ev={ev} providerName={providerName} />
                        ))}
                      </ul>
                    </ScrollArea>
                  </div>
                )}

                {/* 响应体 */}
                <div className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white">
                  <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3 py-1.5">
                    <span className="text-[11px] font-medium text-stone-600">
                      响应体{result.rawLength != null ? <span className="ml-1 font-mono text-[10px] text-stone-400">{result.rawLength} B</span> : null}
                    </span>
                    <div className="flex items-center gap-1">
                      {bodyViewButtons}
                      <CopyButton
                        size="sm"
                        variant="ghost"
                        text={
                          bodyView === "sse"
                            ? rawSse.map((f) => `data: ${f}`).join("\n\n")
                            : bodyView === "text"
                              ? result.streamText ?? ""
                              : prettyJson
                        }
                      />
                    </div>
                  </div>
                  <ScrollArea className="max-h-72">
                    {bodyView === "sse" ? (
                      <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10px] leading-relaxed text-stone-700">
                        {rawSse.length > 0
                          ? rawSse.map((f, i) => (
                              <React.Fragment key={i}>
                                <span className="select-none text-stone-400">data: </span>
                                {f}
                                {"\n"}
                              </React.Fragment>
                            ))
                          : "（无帧）"}
                      </pre>
                    ) : bodyView === "text" ? (
                      <div className="px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-stone-800">
                        {result.streamText || (result.streamDone ? "（空输出）" : "等待输出…")}
                        {!result.streamDone && running && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-stone-400 align-middle" />}
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10px] leading-relaxed text-stone-700">
                        {prettyJson || "（空响应体）"}
                      </pre>
                    )}
                  </ScrollArea>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
