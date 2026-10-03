// 虚拟密钥管理 —— 客户端接入密钥（模型白名单 / 角色限权）。
// 密钥明文只在创建时一次性返回；列表与编辑均显示掩码。
"use client";

import * as React from "react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  Code2,
  Gauge,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Copy,
  Eye,
  EyeOff,
  Trash2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CopyButton,
  EmptyState,
  ErrorAlert,
  HealthBadge,
  LastUsedCell,
  LoadingBlock,
  MiniBars,
  PageHeader,
  TagInput,
} from "@/components/console/ui";
import { apiDelete, apiGet, apiPost, apiPut, errMessage } from "@/lib/console/api";
import { absoluteTime, fmtUsd } from "@/lib/console/format";
import type { BillingData, CreatedKey, KeysData, VirtualKeyRow } from "@/lib/console/types";
import { QuickTestPanel } from "@/components/console/quick-test-panel";

/** v3.5.0：密钥名 → 近 7 天逐日用量（sparkline 数据源）；v4.4.0：附带当日估算成本（$，未计价行不计） */
type Usage7dMap = Map<string, Array<{ day: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cost: number }>>;

/** v4.3.0：配额用量占比条颜色档（与模型健康日柱同套三档语义：<80 安全 / ≥80 临近 / ≥100 已限额） */
function quotaBarClass(pct: number): string {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-emerald-500";
}

/** v4.5.0：月度预算进度条颜色档（lime 系「钱」语义三档：<80 安全 / ≥80 临近 / ≥100 已超预算） */
function budgetBarClass(pct: number): string {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-lime-500";
}

/**
 * v4.3.0：密钥日配额用量单元（列表「今日配额」列）。
 * - 仅对设置了任一限额的密钥渲染；未设限额显示「不限」淡态
 * - 两行进度条：请求 N/限额 · token N/限额（今日累计，本地时区日）
 * - 三档色：绿 <80% / 黄 ≥80% / 红 ≥100%（已限额，网关入口拒绝中）
 * - 用量口径与网关配额执行同源（UsageDaily + 缓冲，约 30s 内同步）；
 *   被拒请求不计入（未触达上游）
 */
function QuotaBars({ k }: { k: VirtualKeyRow }) {
  const reqLimit = k.dailyRequestLimit || 0;
  const tokLimit = k.dailyTokenLimit || 0;
  if (reqLimit <= 0 && tokLimit <= 0) {
    return <span className="text-xs text-stone-400">不限</span>;
  }
  const todayReq = k.todayStats?.requests ?? 0;
  const todayTok = (k.todayStats?.inputTokens ?? 0) + (k.todayStats?.outputTokens ?? 0);
  const reqPct = reqLimit > 0 ? Math.min(100, (todayReq / reqLimit) * 100) : 0;
  const tokPct = tokLimit > 0 ? Math.min(100, (todayTok / tokLimit) * 100) : 0;
  const reqCapped = reqLimit > 0 && todayReq >= reqLimit;
  const tokCapped = tokLimit > 0 && todayTok >= tokLimit;
  const fmt = (n: number) => n.toLocaleString();
  return (
    <div className="w-36 space-y-1.5">
      {reqLimit > 0 && (
        <div>
          <div className="flex items-baseline justify-between gap-1">
            <span className={`text-[10px] tabular-nums ${reqCapped ? "font-semibold text-red-600" : "text-stone-500"}`}>
              {fmt(todayReq)}/{fmt(reqLimit)} 次
            </span>
            {reqCapped && <span className="text-[9px] font-medium text-red-600">已限额</span>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuemin={0} aria-valuemax={reqLimit} aria-valuenow={Math.min(todayReq, reqLimit)} aria-label={`密钥 ${k.name} 今日请求 ${todayReq}/${reqLimit}`}>
            <div className={`h-full rounded-full transition-all ${quotaBarClass(reqPct)}`} style={{ width: `${Math.max(2, reqPct)}%` }} />
          </div>
        </div>
      )}
      {tokLimit > 0 && (
        <div>
          <div className="flex items-baseline justify-between gap-1">
            <span className={`text-[10px] tabular-nums ${tokCapped ? "font-semibold text-red-600" : "text-stone-500"}`}>
              {fmt(todayTok)}/{fmt(tokLimit)} tk
            </span>
            {tokCapped && <span className="text-[9px] font-medium text-red-600">已限额</span>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuemin={0} aria-valuemax={tokLimit} aria-valuenow={Math.min(todayTok, tokLimit)} aria-label={`密钥 ${k.name} 今日 token ${todayTok}/${tokLimit}`}>
            <div className={`h-full rounded-full transition-all ${quotaBarClass(tokPct)}`} style={{ width: `${Math.max(2, tokPct)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * v4.5.0：密钥月度成本预算单元（列表「本月预算」列）。
 * - 仅对设置了月预算的密钥渲染；未设预算显示「—」淡态
 * - 进度条：本月估算成本 $N/预算（lime 三档；≥100% 红档 + 「已超预算」红字）
 * - 成本口径与网关预算执行同源（UsageDaily 当月 × 单价表 + 30s 内缓冲同步）；
 *   被拒请求不计入；未配置单价的模型不计成本（单价表为空时预算永不触发，脚注说明）
 */
function BudgetCell({ k }: { k: VirtualKeyRow }) {
  const limit = k.monthlyCostLimit || 0;
  if (limit <= 0) return <span className="text-xs text-stone-400">—</span>;
  const used = k.monthCost || 0;
  const pct = Math.min(100, (used / limit) * 100);
  const capped = used >= limit;
  return (
    <div className="w-36 space-y-1.5">
      <div className="flex items-baseline justify-between gap-1">
        <span className={`text-[10px] tabular-nums ${capped ? "font-semibold text-red-600" : "text-stone-500"}`}>
          {fmtUsd(used)} / {fmtUsd(limit)}
        </span>
        {capped && <span className="text-[9px] font-medium text-red-600">已超预算</span>}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-stone-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-label={`密钥 ${k.name} 本月估算成本 ${fmtUsd(used)} / 预算 ${fmtUsd(limit)}`}
      >
        <div className={`h-full rounded-full transition-all ${budgetBarClass(pct)}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <p className="text-[9px] leading-tight text-stone-400" title="成本按设置页模型单价表估算（非计费）；未配置单价的模型不计入；预算耗尽后网关入口 429，下月 1 日 0 点重置">
        估算口径 · 本地月重置
      </p>
    </div>
  );
}

// v4.9.12：密钥单元格 —— 「查看/复制完整密钥」按钮。
// 修复点：列表接口只回掩码（k.keyMasked），旧实现直接复制掩码，用户拿到的是 sk-uag-••••XXXX。
// 现在点击时才按 id 向后端换一次明文（单个密钥粒度，不批量下发），并可切换明文显示。
function RevealAndCopyButton({ keyId, masked }: { keyId: string; masked: string }) {
  const [state, setState] = React.useState<"idle" | "loading" | "copied" | "error">("idle");
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const [showPlain, setShowPlain] = React.useState(false);
  // 审查修复：卸载后 setState 会触发 React 警告；且 reveal 未完成时不应显示「加载中…」覆盖已有掩码。
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
  const flashState = (s: "copied" | "error", ms: number) => {
    if (!mountedRef.current) return;
    setState(s);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (mountedRef.current) setState("idle");
    }, ms);
  };

  const fetchPlain = React.useCallback(async (): Promise<string> => {
    if (revealed) return revealed;
    const r = await apiGet<{ keyValue: string }>(`/api/console/keys?reveal=${encodeURIComponent(keyId)}`);
    setRevealed(r.keyValue);
    return r.keyValue;
  }, [keyId, revealed]);

  const onCopy = async () => {
    setState("loading");
    try {
      const plain = await fetchPlain();
      // 坑 2：非 HTTPS / 非 user-gesture 环境下 clipboard API 可能抛 NotAllowedError，用 execCommand 兜底
      try {
        await navigator.clipboard.writeText(plain);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = plain;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      flashState("copied", 1500);
    } catch {
      flashState("error", 2500);
    }
  };

  const onToggle = async () => {
    if (showPlain) {
      setShowPlain(false);
      return;
    }
    setState("loading");
    try {
      await fetchPlain();
      setShowPlain(true);
      setState("idle");
    } catch {
      flashState("error", 2500);
    }

  };
  return (
    <div className="flex items-center gap-1.5">
      <code
        className={showPlain ? "font-mono text-xs font-semibold text-stone-900" : "font-mono text-xs text-stone-700"}
        title={showPlain ? "完整密钥（点眼睛可隐藏）" : masked}
      >
        {state === "loading" ? "加载中…" : showPlain && revealed ? revealed : masked}
      </code>
      <Button
        size="icon"
        variant="ghost"
        onClick={onToggle}
        title={showPlain ? "隐藏密钥" : "显示完整密钥"}
        aria-label={showPlain ? "隐藏密钥" : "显示完整密钥"}
      >
        {showPlain ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={onCopy}
        disabled={state === "loading"}
        title={state === "error" ? "复制失败，请重试" : "复制完整密钥"}
        aria-label="复制完整密钥"
      >
        {state === "copied" ? (
          <Check className="size-3.5 text-emerald-600" />
        ) : state === "error" ? (
          <AlertTriangle className="size-3.5 text-red-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

export function KeysModule({ onViewLogs }: { onViewLogs?: (keyName: string) => void } = {}) {
  const [data, setData] = React.useState<KeysData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  // 新建 / 编辑
  const [editOpen, setEditOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<VirtualKeyRow | null>(null);
  // v4.3.0：配额输入用字符串态（空串=不限额；允许临时清空编辑）；提交时统一清洗
  // v4.5.0：月预算同为字符串态（空串=不限；允许小数）
  const [form, setForm] = React.useState<{ name: string; keyValue: string; models: string[]; role: string; remark: string; dailyRequestLimit: string; dailyTokenLimit: string; monthlyCostLimit: string }>({
    name: "",
    keyValue: "",
    models: ["*"],
    role: "client",
    remark: "",
    dailyRequestLimit: "",
    dailyTokenLimit: "",
    monthlyCostLimit: "",
  });
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");

  // 一次性明文展示
  const [created, setCreated] = React.useState<CreatedKey | null>(null);

  // 删除
  const [delTarget, setDelTarget] = React.useState<VirtualKeyRow | null>(null);
  const [delSaving, setDelSaving] = React.useState(false);
  // v4.9.12-local-r2：接入示例 Dialog（按密钥生成 cURL / Python / Node.js / 环境变量代码片段）
  const [sampleKey, setSampleKey] = React.useState<VirtualKeyRow | null>(null);
  // v4.9.12-local-r6：密钥月度用量明细
  const [usageKey, setUsageKey] = React.useState<VirtualKeyRow | null>(null);

  // v3.5.0：近 7 天用量 sparkline 数据（UsageDaily 按密钥名 × 日聚合；一次拉取全局复用）
  const [usage7d, setUsage7d] = React.useState<Usage7dMap | null>(null);
  const [usage7dDays, setUsage7dDays] = React.useState<string[]>([]);
  React.useEffect(() => {
    let alive = true;
    apiGet<{
      range: { from: string; to: string };
      rows: Array<{ day: string; providerId: string | null; apiKeyName: string | null; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cost?: number | null }>;
    }>("/api/console/usage/daily?days=7", { quiet: true })
      .then((d) => {
        if (!alive) return;
        // 补齐 7 天完整日期轴（含今日；与 usage/daily 的本地日口径一致）
        const days: string[] = [];
        for (let i = 6; i >= 0; i--) {
          const dt = new Date();
          dt.setDate(dt.getDate() - i);
          const mm = String(dt.getMonth() + 1).padStart(2, "0");
          const dd = String(dt.getDate()).padStart(2, "0");
          days.push(`${dt.getFullYear()}-${mm}-${dd}`);
        }
        setUsage7dDays(days);
        const m: Usage7dMap = new Map<string, Array<{ day: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number; cost: number }>>();
        for (const r of d.rows) {
          const name = r.apiKeyName || "(unknown)";
          const arr = m.get(name) || [];
          const found = arr.find((x) => x.day === r.day);
          if (found) {
            found.requests += r.requests;
            found.okRequests += r.okRequests;
            found.inputTokens += r.inputTokens;
            found.outputTokens += r.outputTokens;
            found.cost += r.cost ?? 0;
          } else {
            arr.push({ day: r.day, requests: r.requests, okRequests: r.okRequests, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost: r.cost ?? 0 });
          }
          m.set(name, arr);
        }
        setUsage7d(m);
      })
      .catch(() => {
        /* sparkline 是增强展示，拉取失败静默（列内显示淡态） */
      });
    return () => {
      alive = false;
    };
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<KeysData>("/api/console/keys");
      setData(d);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", keyValue: "", models: ["*"], role: "client", remark: "", dailyRequestLimit: "", dailyTokenLimit: "", monthlyCostLimit: "" });
    setFormError("");
    setEditOpen(true);
  };

  const openEdit = (k: VirtualKeyRow) => {
    setEditing(k);
    setForm({
      name: k.name,
      keyValue: "",
      models: k.models?.length ? k.models : ["*"],
      role: k.role || "client",
      remark: k.remark || "",
      dailyRequestLimit: k.dailyRequestLimit && k.dailyRequestLimit > 0 ? String(k.dailyRequestLimit) : "",
      dailyTokenLimit: k.dailyTokenLimit && k.dailyTokenLimit > 0 ? String(k.dailyTokenLimit) : "",
      monthlyCostLimit: k.monthlyCostLimit && k.monthlyCostLimit > 0 ? String(k.monthlyCostLimit) : "",
    });
    setFormError("");
    setEditOpen(true);
  };

  /** v4.3.0：配额输入清洗（空串/非正整数 → 0 不限额；上限 1 亿与后端一致） */
  const parseLimitInput = (s: string): number | "invalid" => {
    const t = s.trim();
    if (t === "") return 0;
    if (!/^\d{1,9}$/.test(t)) return "invalid";
    const n = parseInt(t, 10);
    return n > 100_000_000 ? "invalid" : n;
  };

  /** v4.5.0：月预算输入清洗（空串/非正数 → 0 不限；保留两位小数；上限 1 亿） */
  const parseBudgetInput = (s: string): number | "invalid" => {
    const t = s.trim();
    if (t === "") return 0;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return "invalid";
    const n = parseFloat(t);
    return !Number.isFinite(n) || n <= 0 || n > 100_000_000 ? "invalid" : Math.round(n * 100) / 100;
  };

  const save = async () => {
    setFormError("");
    if (!form.name.trim()) {
      setFormError("请填写密钥名称");
      return;
    }
    if (form.models.length === 0) {
      setFormError("模型白名单不能为空（可填 * 表示全部）");
      return;
    }
    if (form.keyValue.trim() && form.keyValue.trim().length < 16) {
      setFormError("自定义密钥至少 16 位");
      return;
    }
    const reqLimit = parseLimitInput(form.dailyRequestLimit);
    const tokLimit = parseLimitInput(form.dailyTokenLimit);
    if (reqLimit === "invalid" || tokLimit === "invalid") {
      setFormError("配额必须为正整数（留空或 0 表示不限额，上限 1 亿）");
      return;
    }
    const monthlyBudget = parseBudgetInput(form.monthlyCostLimit);
    if (monthlyBudget === "invalid") {
      setFormError("月度预算必须为正数（最多两位小数，留空表示不限）");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await apiPut("/api/console/keys", {
          id: editing.id,
          name: form.name.trim(),
          enabled: editing.enabled,
          models: form.models,
          role: form.role,
          remark: form.remark.trim() || null,
          dailyRequestLimit: reqLimit,
          dailyTokenLimit: tokLimit,
          monthlyCostLimit: monthlyBudget,
        });
        setNotice("密钥已更新");
      } else {
        const r = await apiPost<CreatedKey>("/api/console/keys", {
          name: form.name.trim(),
          keyValue: form.keyValue.trim() || undefined,
          models: form.models,
          role: form.role,
          remark: form.remark.trim() || undefined,
          dailyRequestLimit: reqLimit,
          dailyTokenLimit: tokLimit,
          monthlyCostLimit: monthlyBudget,
        });
        setCreated(r);
      }
      setEditOpen(false);
      await load();
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (k: VirtualKeyRow, enabled: boolean) => {
    setData((d) => (d ? { ...d, keys: d.keys.map((x) => (x.id === k.id ? { ...x, enabled } : x)) } : d));
    try {
      await apiPut("/api/console/keys", {
        id: k.id,
        name: k.name,
        enabled,
        models: k.models,
        role: k.role,
        remark: k.remark,
      });
    } catch (e) {
      setError(errMessage(e));
      await load();
    }
  };

  const confirmDelete = async () => {
    if (!delTarget) return;
    setDelSaving(true);
    try {
      await apiDelete(`/api/console/keys?id=${encodeURIComponent(delTarget.id)}`);
      setDelTarget(null);
      setNotice("密钥已删除");
      await load();
    } catch (e) {
      setError(errMessage(e));
      setDelTarget(null);
    } finally {
      setDelSaving(false);
    }
  };

  const keys = data?.keys ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="虚拟密钥"
        description={`客户端接入密钥（Bearer 鉴权 · 模型白名单与角色限权）· 共 ${keys.length} 把`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
            </Button>
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={openCreate}>
              <Plus />
              新增密钥
            </Button>
          </>
        }
      />

      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <Check className="size-4" />
          {notice}
        </div>
      )}
      <ErrorAlert message={error} onRetry={load} />

      {loading && !data ? (
        <LoadingBlock rows={3} />
      ) : keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="size-6" />}
          title="尚无虚拟密钥"
          description="创建虚拟密钥供 Claude Code / CC-Switch 等客户端接入；可限制模型白名单与角色。"
          action={
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={openCreate}>
              <Plus />
              新增密钥
            </Button>
          }
        />
      ) : (
        <TooltipProvider delayDuration={150}>
        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead className="hidden md:table-cell">模型白名单</TableHead>
                  <TableHead className="hidden sm:table-cell">角色</TableHead>
                  {/* v4.3.0：今日配额用量（双进度条；未设限额显示「不限」） */}
                  <TableHead className="hidden lg:table-cell">今日配额</TableHead>
                  {/* v4.5.0：本月预算（月度成本进度条；未设预算显示 —） */}
                  <TableHead className="hidden xl:table-cell">本月预算</TableHead>
                  <TableHead className="hidden xl:table-cell">健康面板</TableHead>
                  {/* v3.7.0：最后使用时间（RequestLog 滚动窗口 MAX(createdAt)） */}
                  <TableHead className="hidden lg:table-cell">最后使用</TableHead>
                  {/* v3.5.0：近 7 天用量 sparkline；v4.4.0：附带估算成本（≈$） */}
                  <TableHead className="hidden xl:table-cell">近 7 天用量</TableHead>
                  {/* r3：xl→2xl（1280-1535px 视口 12 列过宽，备注列被截断；上移断点后 1440px 免横向滚动） */}
                  <TableHead className="hidden 2xl:table-cell">备注</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-stone-800">{k.name}</span>
                          {/* v4.3.0：设了任一限额或月预算的密钥名旁加 Gauge 小徽标（一目了然谁在护栏约束下） */}
                          {(k.dailyRequestLimit || 0) > 0 || (k.dailyTokenLimit || 0) > 0 || (k.monthlyCostLimit || 0) > 0 ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="border-violet-200 bg-violet-50 px-1 py-0 text-[9px] font-medium text-violet-700">
                                  <Gauge className="mr-0.5 size-2.5" />
                                  限额
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                该密钥设置了护栏：
                                {(k.dailyRequestLimit || 0) > 0 ? `请求 ${k.dailyRequestLimit!.toLocaleString()} 次/日` : ""}
                                {(k.dailyRequestLimit || 0) > 0 && (k.dailyTokenLimit || 0) > 0 ? " · " : ""}
                                {(k.dailyTokenLimit || 0) > 0 ? `token ${k.dailyTokenLimit!.toLocaleString()}/日` : ""}
                                {((k.dailyRequestLimit || 0) > 0 || (k.dailyTokenLimit || 0) > 0) && (k.monthlyCostLimit || 0) > 0 ? " · " : ""}
                                {(k.monthlyCostLimit || 0) > 0 ? `月预算 ${fmtUsd(k.monthlyCostLimit!)}` : ""}
                                （超限 429）
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                        <span className="text-[11px] text-stone-400">{absoluteTime(k.createdAt)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* v4.9.12：改为「查看/复制完整密钥」—— 旧实现直接复制 k.keyMasked（掩码），用户拿不到可用密钥 */}
                      <RevealAndCopyButton keyId={k.id} masked={k.keyMasked} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex max-w-56 flex-wrap gap-1">
                        {(k.models?.length ? k.models : ["*"]).map((m) => (
                          <Badge
                            key={m}
                            variant="outline"
                            className={m === "*" ? "border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700" : "border-stone-200 bg-stone-50 font-mono text-[10px] text-stone-600"}
                          >
                            {m}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant={k.role === "cron" ? "outline" : "secondary"} className={k.role === "cron" ? "border-amber-200 bg-amber-50 text-amber-700" : ""}>
                        {k.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <QuotaBars k={k} />
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <BudgetCell k={k} />
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HealthBadge
                            stats24h={k.stats24h}
                            todayTokens={
                              k.todayStats && k.todayStats.requests > 0
                                ? k.todayStats.inputTokens + k.todayStats.outputTokens
                                : null
                            }
                            onClick={onViewLogs ? () => onViewLogs(k.name) : undefined}
                            ariaLabel={`查看密钥 ${k.name} 近 24h 请求日志`}
                            tooltipTitle={`近 24 小时使用该密钥的请求：${k.stats24h?.requests ?? 0} 次，成功率 ${k.stats24h?.successRate ?? 0}%`}
                          />
                        </TooltipTrigger>
                        {(k.stats24h?.requests ?? 0) > 0 && (
                          <TooltipContent>
                            近 24 小时使用该密钥的请求：{k.stats24h!.requests} 次，成功率 {k.stats24h!.successRate}%，失败 {k.stats24h?.failures ?? 0} 次
                            {k.todayStats && k.todayStats.requests > 0 && (
                              <span className="block tabular-nums text-muted-foreground">
                                今日：{k.todayStats.requests} 次 · 输入 {k.todayStats.inputTokens.toLocaleString()} / 输出 {k.todayStats.outputTokens.toLocaleString()}
                                {k.todayStats.cachedTokens > 0 ? ` · 缓存命中 ${k.todayStats.cachedTokens.toLocaleString()}` : ""} tokens
                              </span>
                            )}
                            {onViewLogs ? " · 点击查看请求日志 →" : ""}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {/* v3.8.0：改用共享 LastUsedCell（与账号页「最后调用」同款组件，样式统一） */}
                      <LastUsedCell at={k.lastUsedAt} noun="调用" />
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      {(() => {
                        const days = usage7d?.get(k.name);
                        if (!usage7d || !days) return <MiniBars values={[0, 0, 0, 0, 0, 0, 0]} ariaLabel={`密钥 ${k.name} 近 7 天用量`} />;
                        const per = usage7dDays.map((day) => days.find((x) => x.day === day)?.requests ?? 0);
                        const totalCost = days.reduce((s, x) => s + (x.cost || 0), 0);
                        const details = usage7dDays.map((day, i) => {
                          const rec = days.find((x) => x.day === day);
                          const tk = rec ? rec.inputTokens + rec.outputTokens : 0;
                          const dayCost = rec?.cost ?? 0;
                          return (
                            <span key={i} className="block tabular-nums">
                              {day.slice(5).replace("-", "/")}：{per[i]} 次
                              {tk > 0 ? ` · ${tk.toLocaleString()} tk` : ""}
                              {dayCost > 0 ? ` · ${fmtUsd(dayCost)}` : ""}
                            </span>
                          );
                        });
                        return (
                          <div className="space-y-0.5">
                            <MiniBars values={per} details={details} ariaLabel={`密钥 ${k.name} 近 7 天用量，共 ${per.reduce((s, v) => s + v, 0)} 次`} />
                            {/* v4.4.0：近 7 天估算成本（单价表口径；未配置单价时淡态 —） */}
                            <span
                              className={`block text-[10px] tabular-nums ${totalCost > 0 ? "text-lime-700" : "text-stone-300"}`}
                              title={`近 7 天估算成本：${totalCost > 0 ? fmtUsd(totalCost) : "$0（模型未配置单价或全未计价）"}（基于设置页模型单价表估算，非计费）`}
                            >
                              {totalCost > 0 ? `≈ ${fmtUsd(totalCost)}` : "—"}
                            </span>
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="hidden max-w-44 truncate text-xs text-muted-foreground 2xl:table-cell" title={k.remark || undefined}>
                      {k.remark || "—"}
                    </TableCell>
                    <TableCell>
                      <Switch checked={k.enabled} onCheckedChange={(v) => void toggleEnabled(k, v)} aria-label={`启用 ${k.name}`} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" onClick={() => setUsageKey(k)} aria-label={`查看 ${k.name} 的月度用量明细`} title="月度用量明细（分模型 token/成本）">
                          <BarChart3 className="text-stone-500" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setSampleKey(k)} aria-label={`查看 ${k.name} 的接入示例`} title="接入示例（cURL / Python / Node.js）">
                          <Code2 className="text-stone-500" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(k)} aria-label="编辑密钥">
                          <Pencil className="text-stone-500" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDelTarget(k)} aria-label="删除密钥">
                          <Trash2 className="text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        </TooltipProvider>
      )}

      <p className="text-xs text-muted-foreground">
        提示：列表显示的是掩码，复制按钮复制的也是掩码（用于核对身份）。完整密钥仅在创建时一次性展示。
        「健康面板」按请求日志聚合该密钥 24h 调用量与成功率（进度条为成功率三色档），今日 token 数来自按日聚合表（不受滚动日志窗口截断）；
        「今日配额」为密钥级日用量护栏（v4.3.0：设置限额后超限请求在入口被 429 拒绝，不触上游；被拒请求不计入用量；本地时区日零点重置，统计与网关执行同源，约 30 秒内同步）；
        「本月预算」为密钥级月度成本护栏（v4.5.0：当月估算成本到达预算后入口 429，下月 1 日 0 点重置；成本按设置页模型单价表估算，未配置单价的模型不计入，未配置任何单价时预算不生效；统计与网关执行同源）；
        「最后使用」取自请求日志滚动窗口内的最近一次调用（v3.7.0；窗口仅保留近期 5000 条，长期闲置的密钥可能显示为「从未使用」，语义为近期未调用）；
        「近 7 天用量」为该密钥逐日请求数迷你图（UsageDaily 聚合，悬停 ⓘ 查看每日明细，v4.4.0：明细与图下徽标附带按模型单价表估算的 $ 成本，非计费口径），仅供全量/估算 token 的场景参考。
        {onViewLogs ? "，点击徽标可跳转该密钥的请求日志" : ""}。
      </p>

      {/* ---------- 新增 / 编辑 Dialog ---------- */}
      <Dialog open={editOpen} onOpenChange={(o) => !o && setEditOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑密钥 · ${editing.name}` : "新增虚拟密钥"}</DialogTitle>
            <DialogDescription>
              {editing ? "密钥值不可修改；可调整名称、白名单、角色与启停。" : "自定义密钥留空将自动生成（推荐）。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="vk-name">名称</Label>
              <Input id="vk-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如 Claude Code 主力机" />
            </div>
            {!editing && (
              <div className="space-y-1.5">
                <Label htmlFor="vk-value">自定义密钥（可选）</Label>
                <Input id="vk-value" value={form.keyValue} onChange={(e) => setForm((f) => ({ ...f, keyValue: e.target.value }))} placeholder="留空自动生成 sk-uag-…" className="font-mono text-xs" autoComplete="off" spellCheck={false} />
                <p className="text-xs text-muted-foreground">至少 16 位；留空自动生成强随机密钥</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>模型白名单</Label>
              <TagInput tags={form.models} onChange={(models) => setForm((f) => ({ ...f, models }))} allowStar placeholder="如 claude-3-5-sonnet-20241022，* 表示全部" />
              <p className="text-xs text-muted-foreground">使用 * 允许全部模型；指定模型名则仅放行这些模型</p>
            </div>
            <div className="space-y-1.5">
              <Label>角色</Label>
              <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client">client · 客户端（完整调用权限）</SelectItem>
                  <SelectItem value="cron">cron · 定时任务（降权）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* v4.3.0：日配额（可选成本护栏；超限 429 + 本地时区日自然重置） */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Gauge className="size-3.5 text-violet-500" />
                日配额（可选）
              </Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Input
                    id="vk-req-limit"
                    inputMode="numeric"
                    value={form.dailyRequestLimit}
                    onChange={(e) => setForm((f) => ({ ...f, dailyRequestLimit: e.target.value.replace(/[^\d]/g, "") }))}
                    placeholder="不限"
                    aria-describedby="vk-req-limit-hint"
                  />
                  <p id="vk-req-limit-hint" className="text-[11px] leading-tight text-muted-foreground">请求次数 / 日</p>
                </div>
                <div className="space-y-1">
                  <Input
                    id="vk-tok-limit"
                    inputMode="numeric"
                    value={form.dailyTokenLimit}
                    onChange={(e) => setForm((f) => ({ ...f, dailyTokenLimit: e.target.value.replace(/[^\d]/g, "") }))}
                    placeholder="不限"
                    aria-describedby="vk-tok-limit-hint"
                  />
                  <p id="vk-tok-limit-hint" className="text-[11px] leading-tight text-muted-foreground">token 总量 / 日</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                留空 = 不限额。到达限额后网关入口直接返回 429（不触上游、零成本），本地时区每日零点自然重置；token 按入口统计（input+output，缓存命中不重复计）。
              </p>
            </div>
            {/* v4.5.0：月度成本预算（$/估算口径；超限 429 + 下月 1 日重置） */}
            <div className="space-y-1.5">
              <Label htmlFor="vk-monthly-budget" className="flex items-center gap-1.5">
                <Wallet className="size-3.5 text-lime-600" />
                月度成本预算（可选，$）
              </Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Input
                    id="vk-monthly-budget"
                    inputMode="decimal"
                    value={form.monthlyCostLimit}
                    onChange={(e) => setForm((f) => ({ ...f, monthlyCostLimit: e.target.value.replace(/[^\d.]/g, "") }))}
                    placeholder="不限"
                    aria-describedby="vk-monthly-budget-hint"
                  />
                  <p id="vk-monthly-budget-hint" className="text-[11px] leading-tight text-muted-foreground">当月估算成本上限 / $</p>
                </div>
                <div className="space-y-1 self-end">
                  <p className="text-[11px] leading-tight text-muted-foreground">
                    按设置页模型单价表估算（非计费）；未配置单价的模型不计入，未配置任何单价时预算不生效。
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                留空 = 不限。当月累计估算成本到达预算后入口直接 429（不触上游），下月 1 日 0 点自然重置；被拒请求不计入成本。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vk-remark">备注</Label>
              <Textarea id="vk-remark" value={form.remark} onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))} placeholder="用途说明（可选）" rows={2} />
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving} className="bg-stone-900 hover:bg-stone-800">
              {saving && <Loader2 className="animate-spin" />}
              {editing ? "保存修改" : "创建密钥"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 一次性明文展示 ---------- */}
      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="size-5" />
              密钥已创建 · 仅此一次展示
            </DialogTitle>
            <DialogDescription>
              关闭后无法再次查看完整密钥，请立即复制保存。丢失只能删除重建。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
              <code className="block break-all font-mono text-base font-semibold text-stone-900">{created?.keyValue}</code>
            </div>
            <div className="flex justify-center">
              <CopyButton text={created?.keyValue || ""} label="复制完整密钥" size="default" />
            </div>
            <p className="text-center text-xs text-muted-foreground">
              客户端接入方式：Bearer Token（或 x-api-key）请求 /v1/messages 与 /v1/chat/completions
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreated(null)}>
              我已保存，关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 删除确认 ---------- */}
      <AlertDialog open={!!delTarget} onOpenChange={(o) => !o && setDelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除密钥「{delTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              使用该密钥的客户端将立即失去访问权限。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={delSaving}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              {delSaving && <Loader2 className="animate-spin" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* v4.9.12-local-r2：接入示例 Dialog —— 按密钥生成四种语言的接入代码片段 */}
      <IntegrationSamplesDialog sampleKey={sampleKey} onClose={() => setSampleKey(null)} />
      <KeyUsageDialog usageKey={usageKey} onClose={() => setUsageKey(null)} />

      {/* v4.9.8：快速测试面板 —— 粘贴密钥 + 选模型 + 发送请求 + 看响应 */}
      <QuickTestPanel />
    </div>
  );
}

/**
 * v4.9.12-local-r2：接入示例 Dialog。
 * 按所选协议（OpenAI / Anthropic 兼容）生成 cURL / Python / Node.js / 环境变量 四类片段，
 * 供管理员快速把客户端接入网关。密钥仅显示掩码 —— 示例统一使用占位符，
 * 提醒替换为创建密钥时保存的完整密钥（明文不回传，符合密钥治理口径）。
 */
const SAMPLE_MODEL = "glm-4.6"; // 网关当前主力路由；新建其他路由后可自行替换
const KEY_PLACEHOLDER = "sk-uag-【替换为完整密钥】";

function buildSamples(origin: string, protocol: "openai" | "anthropic"): { curl: string; python: string; node: string; env: string } {
  const userMsg = "你好，用一句话介绍你自己";
  if (protocol === "openai") {
    return {
      curl: `curl -X POST ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${SAMPLE_MODEL}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "${userMsg}"}]
  }'`,
      python: `# pip install openai>=1.0
from openai import OpenAI

client = OpenAI(
    base_url="${origin}/v1",   # 网关 OpenAI 兼容端点
    api_key="${KEY_PLACEHOLDER}",
)

resp = client.chat.completions.create(
    model="${SAMPLE_MODEL}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "${userMsg}"}],
)
print(resp.choices[0].message.content)
print(resp.usage)  # 网关透传的真实 token 用量`,
      node: `// Node.js 18+（原生 fetch）
const res = await fetch("${origin}/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${KEY_PLACEHOLDER}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "${SAMPLE_MODEL}",
    max_tokens: 1024,
    messages: [{ role: "user", content: "${userMsg}" }],
  }),
});
const data = await res.json();
console.log(data.choices[0].message.content);
console.log(data.usage);`,
      env: `# OpenAI 兼容 SDK / 通用工具（LangChain、LobeChat、Open WebUI 等）
OPENAI_BASE_URL=${origin}/v1
OPENAI_API_KEY=${KEY_PLACEHOLDER}`,
    };
  }
  return {
    curl: `curl -X POST ${origin}/v1/messages \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${SAMPLE_MODEL}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "${userMsg}"}]
  }'`,
    python: `# pip install anthropic
import anthropic

client = anthropic.Anthropic(
    base_url="${origin}",      # 网关 Anthropic 兼容端点
    auth_token="${KEY_PLACEHOLDER}",
)

msg = client.messages.create(
    model="${SAMPLE_MODEL}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "${userMsg}"}],
)
print(msg.content[0].text)
print(msg.usage)`,
    node: `// Node.js 18+（原生 fetch · Anthropic 协议）
const res = await fetch("${origin}/v1/messages", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${KEY_PLACEHOLDER}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "${SAMPLE_MODEL}",
    max_tokens: 1024,
    messages: [{ role: "user", content: "${userMsg}" }],
  }),
});
const data = await res.json();
console.log(data.content[0].text);
console.log(data.usage);`,
    env: `# Anthropic 兼容（Claude Code / Claude SDK）
ANTHROPIC_BASE_URL=${origin}
ANTHROPIC_AUTH_TOKEN=${KEY_PLACEHOLDER}`,
  };
}

function IntegrationSamplesDialog({ sampleKey, onClose }: { sampleKey: VirtualKeyRow | null; onClose: () => void }) {
  const [protocol, setProtocol] = React.useState<"openai" | "anthropic">("openai");
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const samples = React.useMemo(() => buildSamples(origin, protocol), [origin, protocol]);

  React.useEffect(() => {
    if (sampleKey) setProtocol("openai");
  }, [sampleKey]);

  const tabs: Array<{ id: string; label: string; code: string }> = [
    { id: "curl", label: "cURL", code: samples.curl },
    { id: "python", label: "Python", code: samples.python },
    { id: "node", label: "Node.js", code: samples.node },
    { id: "env", label: "环境变量", code: samples.env },
  ];

  return (
    <Dialog open={!!sampleKey} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Code2 className="size-4.5 text-stone-600" />
            接入示例 · {sampleKey?.name}
          </DialogTitle>
          <DialogDescription>
            复制片段后把 {KEY_PLACEHOLDER} 替换为创建该密钥时保存的完整密钥（列表中仅显示掩码，明文不可回溯）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 协议切换 + 端点说明 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="接入协议" className="flex rounded-lg border border-stone-200 bg-stone-50 p-0.5">
              {(["openai", "anthropic"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={protocol === p}
                  onClick={() => setProtocol(p)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    protocol === p ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"
                  }`}
                >
                  {p === "openai" ? "OpenAI 兼容" : "Anthropic 兼容"}
                </button>
              ))}
            </div>
            <code className="rounded bg-stone-100 px-2 py-1 font-mono text-[10px] text-stone-500">
              POST {protocol === "openai" ? "/v1/chat/completions" : "/v1/messages"}
            </code>
          </div>

          <Tabs defaultValue="curl" key={protocol}>
            <TabsList className="h-8 w-full justify-start gap-0.5 bg-stone-100 p-0.5">
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="h-7 px-2.5 text-[11px] data-[state=active]:bg-white data-[state=active]:shadow-sm">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((t) => (
              <TabsContent key={t.id} value={t.id} className="mt-2">
                <div className="relative">
                  <div className="absolute right-2 top-2 z-10">
                    <CopyButton text={t.code} size="sm" variant="outline" label="复制" />
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-stone-700 bg-stone-900 p-3 pt-9 text-[11px] leading-relaxed text-stone-100 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-600 [&::-webkit-scrollbar]:w-1.5">
                    <code>{t.code}</code>
                  </pre>
                </div>
              </TabsContent>
            ))}
          </Tabs>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            两种协议共用同一把虚拟密钥与路由（网关自动转译请求/响应格式）；鉴权同时支持 <code className="rounded bg-stone-100 px-1 font-mono">Authorization: Bearer</code> 与 <code className="rounded bg-stone-100 px-1 font-mono">x-api-key</code> 头。
            示例模型 {SAMPLE_MODEL} 需已在「模型路由」中配置，其他模型名按路由清单替换。
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- v4.9.12-local-r6：密钥月度用量明细对话框 ----
// 复用 /api/console/usage/billing（月度账单按密钥 × 模型聚合），零后端改动：
// 展示该密钥本月分模型的请求/token/缓存/估算成本，支持切换历史月份（≤12 个月）。
function KeyUsageDialog({ usageKey, onClose }: { usageKey: VirtualKeyRow | null; onClose: () => void }) {
  const [data, setData] = React.useState<BillingData | null>(null);
  const [month, setMonth] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  const load = React.useCallback(async (m?: string) => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<BillingData>(`/api/console/usage/billing${m ? `?month=${encodeURIComponent(m)}` : ""}`);
      setData(d);
      setMonth(d.month);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (usageKey) void load();
  }, [usageKey, load]);

  const row = data?.rows.find((r) => r.apiKeyName === usageKey?.name);
  const monthLabel = (m: string) => `${parseInt(m.slice(0, 10).slice(0, 4), 10)} 年 ${parseInt(m.slice(5, 7), 10)} 月${m === data?.month && m === data?.prevMonth ? "" : ""}`;
  const pricedCoverage = row && row.requests > 0 ? Math.round((row.cost.pricedRequests / row.requests) * 100) : null;
  const budgetPct = row && row.monthlyCostLimit > 0 ? Math.min(100, Math.round((row.cost.cost / row.monthlyCostLimit) * 100)) : null;

  return (
    <Dialog open={!!usageKey} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="size-4.5 text-stone-600" />
            月度用量明细 · {usageKey?.name}
          </DialogTitle>
          <DialogDescription>
            分模型 token 与估算成本（模型单价表口径，非计费）；预算护栏进度同步展示。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 月份切换 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              value={month}
              onValueChange={(v) => void load(v)}
              disabled={loading || !data || data.months.length === 0}
            >
              <SelectTrigger className="w-44 text-xs">
                <SelectValue placeholder="选择月份" />
              </SelectTrigger>
              <SelectContent>
                {(data?.months ?? []).map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">
                    {monthLabel(m)}{m === data?.month ? "（本月）" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loading && <Loader2 className="size-4 animate-spin text-stone-400" />}
          </div>

          <ErrorAlert message={error} onRetry={() => void load(month || undefined)} />

          {loading && !data ? (
            <LoadingBlock rows={4} />
          ) : !row || row.requests === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 px-4 py-8 text-center">
              <BarChart3 className="mx-auto size-5 text-stone-300" />
              <p className="mt-2 text-xs font-medium text-stone-400">{monthLabel(month)}无调用记录</p>
              <p className="mt-1 text-[11px] text-stone-300">该密钥当月未产生任何请求</p>
            </div>
          ) : (
            <>
              {/* 汇总 chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] tabular-nums text-stone-600">
                  {row.requests} 次请求
                </Badge>
                {row.successRate != null && (
                  <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] tabular-nums text-stone-600">
                    成功率 {row.successRate}%
                  </Badge>
                )}
                <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] tabular-nums text-stone-600">
                  ↑ {row.inputTokens.toLocaleString()} / ↓ {row.outputTokens.toLocaleString()} tok
                </Badge>
                {row.cachedTokens > 0 && (
                  <Badge variant="outline" className="border-stone-200 bg-stone-50 px-1.5 py-0 text-[10px] tabular-nums text-stone-600">
                    缓存 {row.cachedTokens.toLocaleString()}
                  </Badge>
                )}
                <Badge variant="outline" className="border-lime-200 bg-lime-50 px-1.5 py-0 text-[10px] tabular-nums text-lime-700">
                  ≈ {fmtUsd(row.cost.cost)}
                </Badge>
                {pricedCoverage != null && pricedCoverage < 100 && (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] tabular-nums text-amber-700" title={`${row.cost.unpricedRequests} 次请求的模型未配置单价，不计入成本估算`}>
                    计价覆盖 {pricedCoverage}%
                  </Badge>
                )}
              </div>

              {/* 预算进度（仅设置了月度预算时） */}
              {budgetPct != null && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-stone-500">
                    <span>月度预算 {fmtUsd(row.monthlyCostLimit)}</span>
                    <span className="tabular-nums">{budgetPct}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-stone-100">
                    <div className={`h-full rounded-full ${budgetBarClass(budgetPct)}`} style={{ width: `${budgetPct}%` }} />
                  </div>
                </div>
              )}

              {/* 分模型明细表 */}
              <div className="overflow-hidden rounded-lg border border-stone-200">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-stone-50/80">
                      <TableHead className="text-xs">模型</TableHead>
                      <TableHead className="text-right text-xs">请求</TableHead>
                      <TableHead className="text-right text-xs">输入 tok</TableHead>
                      <TableHead className="text-right text-xs">输出 tok</TableHead>
                      <TableHead className="hidden text-right text-xs sm:table-cell">缓存</TableHead>
                      <TableHead className="text-right text-xs">估算成本</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {row.byModel.map((m) => (
                      <TableRow key={m.model}>
                        <TableCell>
                          <code className="block max-w-40 truncate font-mono text-xs text-stone-800" title={m.model}>
                            {m.model}
                          </code>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-stone-600">{m.requests}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-stone-600">{m.inputTokens.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-stone-600">{m.outputTokens.toLocaleString()}</TableCell>
                        <TableCell className="hidden text-right font-mono text-xs tabular-nums text-stone-400 sm:table-cell">
                          {m.cachedTokens > 0 ? m.cachedTokens.toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className={`text-right font-mono text-xs tabular-nums ${m.cost.cost > 0 ? "text-lime-700" : "text-stone-300"}`}>
                          {m.cost.cost > 0 ? fmtUsd(m.cost.cost) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
