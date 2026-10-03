// 控制台共享 UI 原子组件 —— 页头、统计卡、复制按钮、Tag 输入、空态、错误条、类型徽章等。
"use client";

import * as React from "react";
import { Activity, Check, Copy, AlertCircle, Loader2, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { apiGet, apiPost, errMessage } from "@/lib/console/api";
import { ERROR_CATEGORY_TONE, patternSearchKeyword } from "@/lib/console/errorCategories";
import { absoluteTime, fmtCompact, fmtNum, relativeTime } from "@/lib/console/format";
import type { ProviderType } from "@/lib/console/types";

// ---- 模块页头 ----
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-stone-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---- 统计卡 ----
export function StatCard({
  label,
  value,
  unit,
  hint,
  icon,
  accent,
  onClick,
  clickHint,
  footer,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  accent?: "emerald" | "teal" | "amber" | "stone";
  /** v3.0.7：可选点击（如今日消耗卡 → 今日日志）；提供时卡片渲染为 button 并增加 hover 反馈 */
  onClick?: () => void;
  /** v3.0.7：点击提示文案（追加在 hint 尾部） */
  clickHint?: string;
  /** v3.6.0：卡片底部附加区（如余额趋势 sparkline；点击态卡同样渲染） */
  footer?: React.ReactNode;
}) {
  const iconColor: Record<string, string> = {
    emerald: "bg-emerald-50 text-emerald-600",
    teal: "bg-teal-50 text-teal-600",
    amber: "bg-amber-50 text-amber-600",
    stone: "bg-stone-100 text-stone-600",
  };
  const clickable = !!onClick;
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        {icon && (
          <span className={cn("flex size-8 items-center justify-center rounded-lg", iconColor[accent || "stone"])}>
            {icon}
          </span>
        )}
      </div>
      {/* v3.9.2：flex-wrap 防御——极端长 value 时单位换行而非溢出卡片 */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-stone-900">{value}</span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      {clickable && clickHint && (
        <div className={cn("mt-1 text-[10px] font-medium", "text-emerald-600")}>{clickHint}</div>
      )}
      {footer && <div className="mt-2">{footer}</div>}
    </>
  );
  if (!clickable) {
    // r3：统一交互质感 —— 不可点击卡片也带轻微 hover 边框过渡（可点击卡已有 emerald 反馈）
    return <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-xs transition-colors hover:border-stone-300">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-stone-200 bg-white p-4 text-left shadow-xs transition-colors hover:border-emerald-300 hover:bg-emerald-50/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
    >
      {content}
    </button>
  );
}

// ---- 复制按钮 ----
export function CopyButton({
  text,
  label,
  size = "sm",
  variant = "outline",
}: {
  text: string;
  label?: string;
  size?: "sm" | "default" | "icon";
  variant?: "outline" | "ghost" | "default" | "secondary";
}) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板 API 不可用时的兜底
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [text]);
  return (
    <Button type="button" variant={variant} size={size} onClick={onCopy} aria-label={label || "复制"}>
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
      {label && <span>{copied ? "已复制" : label}</span>}
    </Button>
  );
}

// ---- Tag 输入（模型白名单 / CORS 白名单 / 代理绕过列表） ----
export function TagInput({
  tags,
  onChange,
  placeholder,
  allowStar,
  className,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  allowStar?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const [focused, setFocused] = React.useState(false);

  const addDraft = React.useCallback(() => {
    const parts = draft
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...tags];
    for (const p of parts) {
      if (!next.includes(p)) next.push(p);
    }
    onChange(next);
    setDraft("");
  }, [draft, tags, onChange]);

  const remove = (t: string) => onChange(tags.filter((x) => x !== t));

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-xs",
        focused && "ring-[3px] ring-ring/50",
        className
      )}
      onClick={() => setFocused(true)}
    >
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-md bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700"
        >
          {t}
          <button
            type="button"
            className="rounded-sm text-stone-400 hover:text-stone-700 focus-visible:outline-none"
            onClick={(e) => {
              e.stopPropagation();
              remove(t);
            }}
            aria-label={`移除 ${t}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          addDraft();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addDraft();
          } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        placeholder={tags.length === 0 ? placeholder || (allowStar ? "输入后回车添加，* 表示全部" : "输入后回车添加") : ""}
        className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// ---- 空态 ----
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-stone-300 bg-stone-50/60 px-6 py-12 text-center", className)}>
      {icon && <div className="flex size-12 items-center justify-center rounded-full bg-white text-stone-400 shadow-xs">{icon}</div>}
      <div>
        <p className="text-sm font-medium text-stone-700">{title}</p>
        {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

// ---- 内联错误条 ----
export function ErrorAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" className="items-center">
      <AlertCircle />
      <AlertTitle>操作失败</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span className="break-all">{message}</span>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

// ---- 提供商类型徽章 ----
const TYPE_BADGE_STYLE: Record<ProviderType, string> = {
  workbuddy: "bg-emerald-50 text-emerald-700 border-emerald-200",
  openai: "bg-teal-50 text-teal-700 border-teal-200",
  anthropic: "bg-amber-50 text-amber-700 border-amber-200",
};
const TYPE_LABEL: Record<ProviderType, string> = {
  workbuddy: "WorkBuddy",
  openai: "OpenAI 兼容",
  anthropic: "Anthropic 兼容",
};

export function TypeBadge({ type, className }: { type: string; className?: string }) {
  const t = (type as ProviderType) in TYPE_LABEL ? (type as ProviderType) : undefined;
  return (
    <Badge variant="outline" className={cn(t && TYPE_BADGE_STYLE[t], "font-medium", className)}>
      {t ? TYPE_LABEL[t] : type}
    </Badge>
  );
}

// ---- 加载骨架 ----
export function LoadingBlock({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)} aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}

// ---- 掩码密钥展示 ----
export function MaskedValue({ value, className }: { value: string; className?: string }) {
  return (
    <code className={cn("block max-w-full truncate rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700", className)}>
      {value}
    </code>
  );
}

// ---- 内联保存按钮（带 loading） ----
export function SaveButton({
  saving,
  children,
  onClick,
  className,
}: {
  saving?: boolean;
  children?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <Button type="button" onClick={onClick} disabled={saving} className={cn("bg-stone-900 hover:bg-stone-800", className)}>
      {saving && <Loader2 className="animate-spin" />}
      {children || "保存"}
    </Button>
  );
}

// ---- 冷却红点 ----
export function CooldownDot({
  remaining,
  streak,
  reason,
  onClick,
  drillHint,
}: {
  remaining: string | null;
  streak?: number;
  /** v3.2.2：冷却原因摘要（最近一次进入冷却的上游报错），tooltip 展示 */
  reason?: string | null;
  /** v4.9.13-local-r5：可选点击下钻（点击冷却徽标 → 该账号请求日志，定位错误上下文） */
  onClick?: () => void;
  /** v4.9.13-local-r5：tooltip 中的下钻提示文案（不传则无下钻提示） */
  drillHint?: string;
}) {
  if (!remaining) return null;
  const title = [
    streak ? `连续失败 ${streak} 次，指数退避冷却中` : "冷却中",
    reason ? `原因：${reason}` : null,
    drillHint && onClick ? drillHint : null,
  ]
    .filter(Boolean)
    .join("\n");
  const inner = (
    <span
      className={
        onClick
          ? "inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400"
          : "inline-flex cursor-help items-center gap-1.5 rounded-md bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600"
      }
      {...(onClick
        ? {
            role: "button",
            tabIndex: 0,
            onClick,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            },
          }
        : {})}
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-red-500" />
      </span>
      冷却 {remaining}
      {streak ? `（连败 ${streak}）` : ""}
    </span>
  );
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent className="max-w-64 whitespace-pre-wrap text-xs">{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---- v3.4.0：一键清冷却按钮（总览账号状态表 / 账号管理页复用） ----
// 仅在账号处于冷却中时由调用方渲染；点击 → POST /api/console/accounts/cooldown/clear。
// 非破坏性：只清冷却标记，下次 429 会自动重建退避；成功后短暂显示 Check 态 + onCleared 回调给页面刷新数据。
export function ClearCooldownButton({
  providerId,
  accountId,
  accountName,
  onCleared,
  className,
}: {
  providerId: string;
  accountId: string;
  accountName?: string;
  /** 操作完成后回调（参数为提示消息，成功与失败都会回调，页面据此刷新数据 / 展示 notice） */
  onCleared?: (message: string, ok: boolean) => void;
  className?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const fire = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await apiPost<{ cleared: boolean; message: string }>(
        "/api/console/accounts/cooldown/clear",
        { providerId, accountId }
      );
      setDone(true);
      setTimeout(() => setDone(false), 2000);
      onCleared?.(r.message || "已清除冷却", true);
    } catch (e) {
      onCleared?.(`清除失败：${errMessage(e)}`, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void fire()}
            disabled={busy}
            aria-label={`清除账号 ${accountName || accountId} 的冷却状态`}
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors",
              "hover:bg-emerald-50 hover:text-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400",
              "disabled:cursor-not-allowed disabled:opacity-60",
              done && "bg-emerald-50 text-emerald-600",
              className
            )}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : done ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Snowflake className="size-3.5" aria-hidden />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          一键清冷却：立即恢复该账号调度（下次 429 将自动重新退避）
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---- v3.5.0：迷你柱状图（密钥页 7 天用量等紧凑场景复用） ----
// 纯 CSS 柱状（与总览趋势图同风格语言）；零总量显示淡态文案；
// 提供 details 时每根柱包 Tooltip 显示每日明细。
export function MiniBars({
  values,
  details,
  className,
  barColor = "bg-teal-500/70",
  emptyText = "无调用",
  ariaLabel,
}: {
  values: number[];
  /** 每根柱的 Tooltip 明细行（与 values 等长；不传则无 Tooltip） */
  details?: React.ReactNode[];
  className?: string;
  barColor?: string;
  emptyText?: string;
  ariaLabel?: string;
}) {
  const max = Math.max(1, ...values);
  const total = values.reduce((s, v) => s + v, 0);
  if (total === 0) {
    return <span className={cn("text-[11px] text-stone-300", className)}>{emptyText}</span>;
  }
  const bars = (
    <div
      className={cn("flex h-6 items-end gap-[3px]", className)}
      role="img"
      aria-label={ariaLabel || `近 ${values.length} 天用量，共 ${total} 次`}
    >
      {values.map((v, i) => (
        <span
          key={i}
          className={cn(
            "block w-1.5 flex-1 rounded-t-[2px] transition-colors",
            v === 0 ? "bg-stone-100" : cn(barColor, "group-hover/mb:bg-teal-500")
          )}
          style={{ height: `${Math.max(v > 0 ? 14 : 8, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
  if (!details) return bars;
  return (
    <TooltipProvider delayDuration={120}>
      <div className="group/mb flex items-center gap-2">
        {bars}
        {/* 悬停整行即显示每日明细（柱太小不便单独 hover） */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help text-[10px] text-stone-300 hover:text-stone-500" tabIndex={0}>
              ⓘ
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {details.map((d, i) => (
              <div key={i}>{d}</div>
            ))}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

// ---- v3.8.0：最后使用单元格（密钥页 / 账号页共用） ----
/**
 * 三色活跃点 + 相对时间：24h 内 emerald（活跃）/ 72h 内 amber（低频）/ 更久 stone-300（闲置）。
 * 无记录显示「从未使用」（title 说明滚动窗口语义）。悬停 title 显示绝对时间。
 */
export function LastUsedCell({
  at,
  noun = "调用",
  emptyTitle = "请求日志滚动窗口内无调用记录（窗口仅保留近期 5000 条，语义为近期未调用）",
}: {
  at?: string | null;
  /** 语义名词：密钥=调用，账号=命中 */
  noun?: string;
  emptyTitle?: string;
}) {
  if (!at) {
    return (
      <span className="text-xs text-stone-300" title={emptyTitle}>
        从未使用
      </span>
    );
  }
  const age = Date.now() - new Date(at).getTime();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-stone-600" title={`最后${noun}：${absoluteTime(at)}`}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          age < 24 * 3600_000 ? "bg-emerald-500" : age < 72 * 3600_000 ? "bg-amber-400" : "bg-stone-300"
        )}
        aria-hidden
      />
      {relativeTime(at)}
    </span>
  );
}

// ---- v3.6.0：余额趋势（余额按日快照的紧凑可视化） ----
/**
 * 缺失日 carry-forward：当日无快照时沿用最近一次已知值（余额是存量指标，
 * 「没测」不等于「归零」——直接补 0 会画出错误的断崖）。
 * 窗口起点之前的缺失（尚无任何已知值）保持 null，由调用方决定渲染为空档。
 */
export function carryForwardPoints(points: Array<number | null>): Array<number | null> {
  let last: number | null = null;
  return points.map((v) => {
    if (v !== null) last = v;
    return v !== null ? v : last;
  });
}

/**
 * 余额趋势迷你柱：语义是「水平高度 = 余额水位」（与 MiniBars 的「柱高 = 流量」不同源同形）。
 * 输入 null 档渲染为矮淡柱（无数据）；附 tooltip 明细（日期 + 值）。
 */
export function BalanceTrendBars({
  days,
  points,
  className,
  ariaLabel,
}: {
  days: string[];
  points: Array<number | null>;
  className?: string;
  ariaLabel?: string;
}) {
  const filled = carryForwardPoints(points);
  const known = filled.filter((v): v is number => v !== null);
  if (known.length === 0) {
    return <span className={cn("text-[11px] text-stone-300", className)}>暂无快照</span>;
  }
  const max = Math.max(...known);
  return (
    <TooltipProvider delayDuration={120}>
      <div className={cn("flex h-6 items-end gap-[3px]", className)} role="img" aria-label={ariaLabel || `近 ${days.length} 天余额趋势`}>
        {filled.map((v, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "block w-1.5 min-w-1 flex-1 rounded-t-[2px] transition-colors",
                  v === null ? "bg-stone-100" : "bg-emerald-500/70 hover:bg-emerald-500"
                )}
                style={{ height: v === null ? "12%" : `${Math.max(10, Math.round((v / max) * 100))}%` }}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {days[i]} · {v === null ? "无快照" : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

// ---- v3.6.0：Token 构成占比条（运行日志行内；输入/输出/缓存三段堆叠） ----
/**
 * 三段堆叠迷你条：teal=输入 / emerald=输出 / amber=缓存命中。
 * 仅在总量 > 0 时渲染；title 附精确数值与百分比（比 Tooltip 轻，行内高频渲染更稳）。
 */
export function TokenBar({
  input,
  output,
  cached,
  className,
}: {
  input: number | null | undefined;
  output: number | null | undefined;
  cached: number | null | undefined;
  className?: string;
}) {
  const i = Math.max(0, input || 0);
  const o = Math.max(0, output || 0);
  const c = Math.max(0, cached || 0);
  const total = i + o + c;
  if (total <= 0) return null;
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  const title = [
    `输入 ${i.toLocaleString()} (${pct(i)})`,
    `输出 ${o.toLocaleString()} (${pct(o)})`,
    c > 0 ? `缓存 ${c.toLocaleString()} (${pct(c)})` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className={cn("mt-0.5 flex h-1 w-20 overflow-hidden rounded-full bg-stone-100", className)}
      role="img"
      aria-label={`Token 构成：${title}`}
      title={title}
    >
      {i > 0 && <span className="h-full bg-teal-400/80" style={{ width: pct(i) }} />}
      {o > 0 && <span className="h-full bg-emerald-500/80" style={{ width: pct(o) }} />}
      {c > 0 && <span className="h-full bg-amber-400/90" style={{ width: pct(c) }} />}
    </span>
  );
}

// ---- 键值对编辑器（附加请求头等） ----
export function KVEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={row.key}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], key: e.target.value };
              onChange(next);
            }}
            placeholder={keyPlaceholder || "Header 名称"}
            className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <input
            value={row.value}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], value: e.target.value };
              onChange(next);
            }}
            placeholder={valuePlaceholder || "值"}
            className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label="删除此行"
          >
            <span className="text-stone-400 hover:text-red-600">×</span>
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        + 添加一行
      </Button>
    </div>
  );
}

// ---- v3.0.8：统一健康面板（密钥/账号共用） ----
// 24h 调用量 + 成功率 + 今日 tokens 合并为一个可点击视觉单元；
// 底部成功率进度条按三色档（≥90 emerald / ≥60 amber / <60 red）填充。
export function HealthBadge({
  stats24h,
  todayTokens,
  onClick,
  ariaLabel,
  tooltipTitle,
  tooltipDetail,
}: {
  /** v3.1.0：可选 failures 精确失败次数（Tooltip 明细） */
  stats24h?: { requests: number; successRate: number; failures?: number } | null;
  /** 今日 tokens（输入+输出合计）；null 表示该维度无数据（如账号维度无按日聚合） */
  todayTokens?: number | null;
  onClick?: () => void;
  ariaLabel: string;
  tooltipTitle: string;
  tooltipDetail?: React.ReactNode;
}) {
  if (!stats24h || stats24h.requests <= 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  // v3.1.0：失败次数明细（Task 14 遗留建议）——后端下发精确 failures 时自动拼入 title
  const failuresText =
    typeof stats24h.failures === "number"
      ? `，失败 ${stats24h.failures} 次`
      : `，失败约 ${Math.round((stats24h.requests * (100 - Math.max(0, Math.min(100, stats24h.successRate)))) / 100)} 次`;
  // v3.9.2：今日 tokens 紧凑显示 + title 保留精确值
  const composedTitle = [
    `${tooltipTitle}${failuresText}`,
    typeof todayTokens === "number" && todayTokens > 0 ? `今日精确 ${fmtNum(todayTokens)} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const rate = Math.max(0, Math.min(100, stats24h.successRate));
  const tier =
    rate >= 90
      ? { border: "border-emerald-200", bg: "bg-emerald-50", text: "text-emerald-700", bar: "bg-emerald-500", hover: "hover:border-emerald-400 hover:bg-emerald-100" }
      : rate >= 60
        ? { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-700", bar: "bg-amber-500", hover: "hover:border-amber-400 hover:bg-amber-100" }
        : { border: "border-red-200", bg: "bg-red-50", text: "text-red-700", bar: "bg-red-500", hover: "hover:border-red-400 hover:bg-red-100" };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex w-fit cursor-pointer flex-col gap-1 rounded-lg border px-2 py-1 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-stone-400 ${tier.border} ${tier.bg} ${tier.hover}`}
      aria-label={ariaLabel}
      title={composedTitle}
    >
      <span className={`flex items-center gap-1 text-[10px] font-medium tabular-nums ${tier.text}`}>
        <Activity className="size-3 shrink-0" aria-hidden />
        24h {stats24h.requests} 次 · {rate}%
        {typeof todayTokens === "number" && todayTokens > 0 && (
          <>
            <span className="opacity-40">|</span>
            <span className="font-normal">今日 {fmtCompact(todayTokens)} tk</span>
          </>
        )}
      </span>
      {/* 成功率进度条：三色档填充，直观暴露低成功率 */}
      <span className="block h-1 w-full min-w-20 overflow-hidden rounded-full bg-white/70" aria-hidden>
        <span className={`block h-full rounded-full transition-[width] ${tier.bar}`} style={{ width: `${rate}%` }} />
      </span>
      {tooltipDetail ? <span className="sr-only">{tooltipDetail}</span> : null}
    </button>
  );
}

// ---- v4.9.13-local-r8：失败徽标（密钥页/账号页共用；悬停即见该维度 24h 错误模式分布，免跳转） ----
// 升级路径：r5/r6 的失败徽标只有原生 title（"失败 N 次 · 点击下钻"），要知道"失败的是什么错"
// 必须跳日志页；本组件在 Tooltip 内联拉取 /api/console/logs/error-patterns（轻量端点，
// 只查 error 非空的行），分类徽标 + 归一化模式 + ×count 一眼可读 —— 与日志页/总览卡同口径。
export interface FailureBadgeQuery {
  /** 按调用方密钥过滤（密钥页） */
  key?: string;
  /** 按命中账号过滤（账号页；与 provider 组合防跨提供商同名串扰） */
  account?: string;
  provider?: string;
}

interface EpPatternRow {
  pattern: string;
  category: string;
  count: number;
  statuses: number[];
}

/** 悬停缓存（60s TTL）：悬停是高频短交互，同一维度短时间内反复悬停不重复打 API */
const epBadgeCache = new Map<string, { at: number; patterns: EpPatternRow[] }>();
const EP_BADGE_CACHE_TTL = 60_000;
/** Tooltip 内最多展示的模式组数（服务端返回 Top 6，徽标 tooltip 取前 4 防溢出） */
const EP_BADGE_MAX_ROWS = 4;

export function FailureBadge({
  count,
  ariaLabel,
  onClick,
  patternQuery,
  onPickPattern,
  drillHint = "点击按「5xx 服务端错误」下钻失败请求",
}: {
  /** 近 24 小时失败次数（调用方仅在 >0 时渲染本组件） */
  count: number;
  ariaLabel: string;
  /** 点击下钻 handler（跳转通道未接线时只读展示） */
  onClick?: () => void;
  /** 错误模式聚合维度（不传则退化为原生 title，向后兼容） */
  patternQuery?: FailureBadgeQuery;
  /** v4.9.13-local-r9：tooltip 模式行点击下钻 —— 把该模式的骨架片段作为 error 关键字检索词
   *  交给调用方（密钥/账号页跳转日志页时保留维度 × 关键字组合，比徽标自身的 5xx 下钻更精准）。
   *  未接线时模式行只读展示（向后兼容） */
  onPickPattern?: (keyword: string) => void;
  drillHint?: string;
}) {
  const [open, setOpen] = React.useState(false);
  // null = 尚未拉取（首次悬停触发）；空数组 = 已拉取但窗口内无错误文本
  const [patterns, setPatterns] = React.useState<EpPatternRow[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  // 缓存键（数值元组序列化，稳定身份供 useCallback 依赖）；查询对象本身经 ref 读取
  // （每次渲染都是新字面量，直接进依赖会令 ensurePatterns 身份变化）
  const cacheKey = patternQuery
    ? JSON.stringify([patternQuery.key ?? "", patternQuery.provider ?? "", patternQuery.account ?? ""])
    : "";
  const queryRef = React.useRef(patternQuery);

  const ensurePatterns = React.useCallback(async () => {
    const q = queryRef.current;
    if (!q) return;
    const cached = epBadgeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < EP_BADGE_CACHE_TTL) {
      setPatterns(cached.patterns);
      setFailed(false);
      return;
    }
    try {
      const params = new URLSearchParams();
      if (q.key) params.set("key", q.key);
      if (q.provider) params.set("provider", q.provider);
      if (q.account) params.set("account", q.account);
      params.set("hours", "24");
      const d = await apiGet<{ patterns: EpPatternRow[] }>(`/api/console/logs/error-patterns?${params.toString()}`);
      epBadgeCache.set(cacheKey, { at: Date.now(), patterns: d.patterns });
      setPatterns(d.patterns);
      setFailed(false);
    } catch {
      // 拉取失败不缓存：下次悬停自然重试；tooltip 内如实提示
      setFailed(true);
    }
  }, [cacheKey]);

  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel}
      title={
        patternQuery
          ? undefined // 富 tooltip 接管提示职责，避免原生 title 与 Radix tooltip 双层叠显
          : `近 24 小时失败 ${count} 次${onClick ? ` · ${drillHint}` : "（跳转通道未接线）"}`
      }
      className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-px text-[10px] font-medium text-red-700 transition-colors hover:border-red-300 hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400 disabled:cursor-default"
    >
      <span className="size-1.5 rounded-full bg-red-500" aria-hidden />
      失败 {count}
      {onClick ? <span className="text-red-400">→</span> : null}
    </button>
  );

  if (!patternQuery) return button;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          // 首次悬停（或上次失败后重试）才发起拉取；成功后 60s 内走缓存
          if (o && (patterns === null || failed)) void ensurePatterns();
        }}
      >
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-80 text-left leading-relaxed">
          <p className="text-xs font-medium">
            近 24 小时失败 {count} 次
            {onClick ? <span className="text-muted-foreground"> · {drillHint}</span> : null}
          </p>
          {failed ? (
            <p className="mt-1 text-[10px] text-stone-500">错误模式加载失败（稍后再次悬停重试）</p>
          ) : patterns === null ? (
            <p className="mt-1 text-[10px] text-stone-500">正在聚合该维度的错误模式…</p>
          ) : patterns.length === 0 ? (
            <p className="mt-1 text-[10px] text-stone-500">窗口内的失败请求未记录错误文本（或已被滚动窗口淘汰）</p>
          ) : (
            <div className="mt-1.5 space-y-1">
              {patterns.slice(0, EP_BADGE_MAX_ROWS).map((p, i) => {
                // v4.9.13-local-r9：模式行可点击下钻 —— 骨架片段作 error 关键字（精准命中该模式组）
                const kw = patternSearchKeyword(p.pattern);
                const pickable = !!onPickPattern && kw !== null;
                const kwShort = kw !== null && kw.length > 32 ? `${kw.slice(0, 32)}…` : kw;
                const row = (
                  <>
                    <Badge variant="outline" className={`shrink-0 px-1 py-0 text-[9px] leading-4 ${ERROR_CATEGORY_TONE[p.category] ?? ""}`}>
                      {p.category}
                    </Badge>
                    <span className={`min-w-0 flex-1 break-all text-[10px] ${pickable ? "text-stone-700" : "text-stone-600"}`}>{p.pattern}</span>
                    <span className="shrink-0 text-[10px] font-medium tabular-nums text-red-600">
                      ×{p.count}
                      {p.statuses.length > 0 ? <span className="text-stone-400">（{p.statuses.join("/")}）</span> : null}
                    </span>
                  </>
                );
                return pickable ? (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setOpen(false); // 关闭 tooltip 即将跳转（模块切换后自然卸载，此处提前收起防闪烁）
                      onPickPattern!(kw!);
                    }}
                    title={`点击按错误关键字「${kwShort}」查看该模式的请求日志（contains 命中整组）`}
                    className="flex w-full items-start gap-1.5 rounded px-0.5 py-px text-left transition-colors hover:bg-stone-100/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400"
                  >
                    {row}
                  </button>
                ) : (
                  <div key={i} className="flex items-start gap-1.5">
                    {row}
                  </div>
                );
              })}
              <p className="pt-0.5 text-[9px] text-stone-400">
                统计口径：近 24h · 同类错误归一化 · 悬停查看{onPickPattern ? "，点击模式行按错误关键字下钻" : "，点击徽标下钻"}
              </p>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
