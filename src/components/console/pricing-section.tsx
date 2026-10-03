// 模型单价管理（v4.4.0 成本估算配置面）—— 设置页独立 Section。
// - 表格编辑：模型名 + 输入/输出/缓存三单价（$/1M tokens）增删改；保存为整表语义（PUT）
// - 批量粘贴导入：每行 "model,输入,输出[,缓存]"（逗号/Tab 分隔；# 注释与空行忽略）
// - 未计价模型 chips：近 30 天出现但未配置单价的模型，点击即补一行（带请求量徽标）
// - 保存反馈：saved / deleted 计数 + 审计落点说明（操作审计 entity=setting/model-pricing）
"use client";

import * as React from "react";
import {
  BadgeDollarSign,
  Check,
  ClipboardPaste,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Section } from "@/components/console/settings-sections";
import { apiGet, apiPut, errMessage } from "@/lib/console/api";
import { relativeTime } from "@/lib/console/format";
import type { PricingData, PricingSaveResult, UnpricedModel } from "@/lib/console/types";

/** 编辑行（本地草稿；新增行 isNew=true 无 updatedAt） */
interface DraftRow {
  model: string;
  inputPerMTok: string;
  outputPerMTok: string;
  cachedPerMTok: string;
  updatedAt?: string;
}

const NUM_RE = /^\d*\.?\d*$/; // 输入态宽松校验（保存时服务端严格校验）

/**
 * 常见模型公开列表价参考表（$/1M tokens；v4.9.11-sandbox 新增）。
 * 用途：「参考价预填」一键初始化单价表 —— 消除空表冷启动摩擦；价格可修改，仅估算展示不参与计费。
 * 口径：以各厂商公开 API 定价为准（缓存价为缓存命中读价；0 = 免费/不计价档）。
 */
const REFERENCE_PRICES: Record<string, { input: number; output: number; cached: number }> = {
  // ---- GLM（智谱 / z.ai）----
  "glm-4.6": { input: 0.6, output: 2.2, cached: 0.11 },
  "glm-4.5": { input: 0.6, output: 2.2, cached: 0.11 },
  "glm-4.5-air": { input: 0.2, output: 0.66, cached: 0.04 },
  "glm-4.5-flash": { input: 0, output: 0, cached: 0 },
  "glm-4-flash": { input: 0, output: 0, cached: 0 },
  "glm-4-plus": { input: 7, output: 7, cached: 0 },
  "glm-4-long": { input: 1, output: 7, cached: 0 },
  // ---- DeepSeek ----
  "deepseek-chat": { input: 0.27, output: 1.1, cached: 0.07 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cached: 0.14 },
  "deepseek-v4.1": { input: 0.27, output: 1.1, cached: 0.07 },
  "deepseek-v4.1-flash": { input: 0.27, output: 1.1, cached: 0.07 },
  // ---- Claude（Anthropic）----
  "claude-opus-4.6": { input: 15, output: 75, cached: 1.5 },
  "claude-opus-4.1": { input: 15, output: 75, cached: 1.5 },
  "claude-sonnet-4.6": { input: 3, output: 15, cached: 0.3 },
  "claude-sonnet-4.5": { input: 3, output: 15, cached: 0.3 },
  "claude-haiku-4.5": { input: 1, output: 5, cached: 0.1 },
  // ---- GPT（OpenAI）----
  "gpt-5.2": { input: 1.25, output: 10, cached: 0.125 },
  "gpt-5.1": { input: 1.25, output: 10, cached: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cached: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cached: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cached: 0.005 },
  "gpt-4.1": { input: 2, output: 8, cached: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cached: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cached: 0.025 },
  "gpt-4o": { input: 2.5, output: 10, cached: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
  // ---- Qwen（阿里云）----
  "qwen-max": { input: 1.6, output: 6.4, cached: 0.4 },
  "qwen-plus": { input: 0.4, output: 1.2, cached: 0.1 },
  "qwen-flash": { input: 0.05, output: 0.2, cached: 0.01 },
  "qwen-turbo": { input: 0.05, output: 0.2, cached: 0.01 },
  // ---- Kimi / Gemini ----
  "kimi-k2": { input: 0.6, output: 2.5, cached: 0.1 },
  "kimi-k2-0905": { input: 0.6, output: 2.5, cached: 0.1 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cached: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.075 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4, cached: 0.025 },
};

/**
 * 参考价查询：精确命中优先；未命中时按「已知家族 + 档位关键词」保守推断
 * （仅覆盖 glm / deepseek / claude / gpt / qwen / gemini / kimi 前缀；其余返回 null 不猜测）。
 */
function lookupReferencePrice(model: string): { input: string; output: string; cached: string } | null {
  const m = model.toLowerCase().trim();
  if (!m) return null;
  const fmt = (p: { input: number; output: number; cached: number }) => ({
    input: String(p.input),
    output: String(p.output),
    cached: String(p.cached),
  });
  const exact = REFERENCE_PRICES[m];
  if (exact) return fmt(exact);
  if (m.startsWith("glm")) {
    if (m.includes("flash")) return fmt(REFERENCE_PRICES["glm-4-flash"]);
    if (m.includes("air") || m.includes("lite")) return fmt(REFERENCE_PRICES["glm-4.5-air"]);
    return fmt(REFERENCE_PRICES["glm-4.6"]); // glm 家族旗舰档兑底
  }
  if (m.startsWith("deepseek")) {
    return fmt(m.includes("reasoner") ? REFERENCE_PRICES["deepseek-reasoner"] : REFERENCE_PRICES["deepseek-chat"]);
  }
  if (m.startsWith("gpt-5")) {
    if (m.includes("nano")) return fmt(REFERENCE_PRICES["gpt-5-nano"]);
    if (m.includes("mini")) return fmt(REFERENCE_PRICES["gpt-5-mini"]);
    return fmt(REFERENCE_PRICES["gpt-5"]);
  }
  if (m.startsWith("gpt-4.1")) {
    if (m.includes("nano")) return fmt(REFERENCE_PRICES["gpt-4.1-nano"]);
    if (m.includes("mini")) return fmt(REFERENCE_PRICES["gpt-4.1-mini"]);
    return fmt(REFERENCE_PRICES["gpt-4.1"]);
  }
  if (m.startsWith("gpt-4o")) {
    return fmt(m.includes("mini") ? REFERENCE_PRICES["gpt-4o-mini"] : REFERENCE_PRICES["gpt-4o"]);
  }
  if (m.startsWith("claude")) {
    if (m.includes("opus")) return fmt(REFERENCE_PRICES["claude-opus-4.6"]);
    if (m.includes("haiku")) return fmt(REFERENCE_PRICES["claude-haiku-4.5"]);
    return fmt(REFERENCE_PRICES["claude-sonnet-4.6"]); // sonnet 档兑底
  }
  if (m.startsWith("qwen")) {
    if (m.includes("max")) return fmt(REFERENCE_PRICES["qwen-max"]);
    if (m.includes("flash") || m.includes("turbo")) return fmt(REFERENCE_PRICES["qwen-flash"]);
    return fmt(REFERENCE_PRICES["qwen-plus"]);
  }
  if (m.startsWith("gemini")) {
    return fmt(m.includes("pro") ? REFERENCE_PRICES["gemini-2.5-pro"] : REFERENCE_PRICES["gemini-2.5-flash"]);
  }
  if (m.startsWith("kimi")) return fmt(REFERENCE_PRICES["kimi-k2"]);
  return null;
}

function toDraftRow(r: { model: string; inputPerMTok: number; outputPerMTok: number; cachedPerMTok: number; updatedAt?: string }): DraftRow {
  return {
    model: r.model,
    inputPerMTok: String(r.inputPerMTok),
    outputPerMTok: String(r.outputPerMTok),
    cachedPerMTok: String(r.cachedPerMTok),
    updatedAt: r.updatedAt,
  };
}

/** 批量粘贴解析：每行 model,input,output[,cached]（Tab/逗号分隔；3 列 = 缓存单价缺省 0） */
function parsePasted(text: string): { rows: DraftRow[]; invalid: string[] } {
  const rows: DraftRow[] = [];
  const invalid: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[\t,，]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) {
      invalid.push(line);
      continue;
    }
    const [model, input, output, cached] = parts;
    const nums = [input, output, cached ?? "0"];
    if (nums.some((n) => !NUM_RE.test(n) || n === "")) {
      invalid.push(line);
      continue;
    }
    rows.push({
      model,
      inputPerMTok: input,
      outputPerMTok: output,
      cachedPerMTok: cached ?? "0",
    });
  }
  return { rows, invalid };
}

export function PricingSection() {
  const [rows, setRows] = React.useState<DraftRow[] | null>(null);
  const [unpriced, setUnpriced] = React.useState<UnpricedModel[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  const [pasteResult, setPasteResult] = React.useState("");
  const [flash, setFlash] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<PricingData>("/api/console/pricing");
      setRows(d.rows.map(toDraftRow));
      setUnpriced(d.unpricedModels || []);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // 总览「成本估算」空态 CTA 跳转：滚动定位 + 短暂高亮（CustomEvent 解耦，无 prop 钻透）
  React.useEffect(() => {
    const handler = () => {
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlash(true);
      window.setTimeout(() => setFlash(false), 2200);
    };
    window.addEventListener("uag:goto-pricing", handler);
    return () => window.removeEventListener("uag:goto-pricing", handler);
  }, []);

  const setCell = (i: number, key: keyof DraftRow, value: string) => {
    setRows((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[i] = { ...next[i], [key]: value };
      return next;
    });
    setNotice("");
  };

  const addRow = (model = "", input = "0", output = "0", cached = "0") => {
    setRows((prev) => [...(prev || []), { model, inputPerMTok: input, outputPerMTok: output, cachedPerMTok: cached }]);
    setNotice("");
  };

  const removeRow = (i: number) => {
    setRows((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
    setNotice("");
  };

  /**
   * 参考价一键预填：仅对「未计价清单里有参考价且尚未在表内」的模型补行。
   * 保守策略：家族外模型不猜测，留待手动/批量粘贴；预填后需手动保存生效。
   */
  const prefillReference = () => {
    if (!rows) return;
    const existing = new Set(rows.map((r) => r.model.trim().toLowerCase()));
    const filled: string[] = [];
    const additions: DraftRow[] = [];
    for (const u of unpriced) {
      const key = u.model.trim().toLowerCase();
      if (existing.has(key)) continue;
      const ref = lookupReferencePrice(u.model);
      if (!ref) continue;
      additions.push({ model: u.model, inputPerMTok: ref.input, outputPerMTok: ref.output, cachedPerMTok: ref.cached });
      existing.add(key);
      filled.push(u.model);
    }
    if (additions.length === 0) {
      setNotice("没有可预填的参考价（未计价模型均不在参考价库内，或已全部在表中）");
      return;
    }
    setRows((prev) => [...(prev || []), ...additions]);
    setNotice(`已按公开列表价预填 ${filled.length} 个模型：${filled.join("、")} —— 请核对后点「保存单价表」生效`);
  };

  /** 是否存在至少一个可预填的候选（控制按钮可用态，避免无效点击） */
  const prefillAvailable = React.useMemo(() => {
    if (!rows) return false;
    const existing = new Set(rows.map((r) => r.model.trim().toLowerCase()));
    return unpriced.some((u) => !existing.has(u.model.trim().toLowerCase()) && lookupReferencePrice(u.model) !== null);
  }, [rows, unpriced]);

  const applyPaste = () => {
    const { rows: parsed, invalid } = parsePasted(pasteText);
    if (parsed.length === 0) {
      setPasteResult("未解析到有效行（每行格式：模型名,输入单价,输出单价[,缓存单价]）");
      return;
    }
    setRows((prev) => {
      const merged = new Map<string, DraftRow>();
      for (const r of prev || []) merged.set(r.model, r);
      for (const r of parsed) merged.set(r.model, r); // 同名模型以粘贴值覆盖
      return Array.from(merged.values());
    });
    setPasteResult(`已导入 ${parsed.length} 行${invalid.length > 0 ? `；${invalid.length} 行格式无效已忽略` : ""}（同名模型已覆盖）`);
    setPasteText("");
  };

  const save = async () => {
    if (!rows) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = rows.map((r) => ({
        model: r.model.trim(),
        inputPerMTok: Number(r.inputPerMTok || 0),
        outputPerMTok: Number(r.outputPerMTok || 0),
        cachedPerMTok: Number(r.cachedPerMTok || 0),
      }));
      const d = await apiPut<PricingSaveResult>("/api/console/pricing", { rows: payload });
      setRows(d.rows.map(toDraftRow));
      // 保存后重拉未计价提示（新配置改变了口径）
      try {
        const fresh = await apiGet<PricingData>("/api/console/pricing");
        setUnpriced(fresh.unpricedModels || []);
      } catch {
        /* 提示清单非关键路径 */
      }
      setNotice(`已保存 ${d.saved} 个模型单价${d.deleted > 0 ? `，移除 ${d.deleted} 条过期行` : ""}`);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={rootRef} className={flash ? "rounded-xl ring-2 ring-lime-400/70 ring-offset-2 transition-shadow duration-500" : "rounded-xl transition-shadow duration-500"}>
    <Section
      icon={<BadgeDollarSign className="size-4.5" />}
      title="模型单价 · 成本估算"
      description="按上游实际结算价填写 $/百万 tokens；总览成本卡 / 用量透视 / 密钥与日志的估算均基于此表（仅估算展示，不做计费）"
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={prefillReference}
            disabled={!prefillAvailable}
            title="按公开列表价为未计价模型预填参考单价（可修改后保存）"
          >
            <Sparkles className="text-lime-600" />
            参考价预填
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPasteOpen((v) => !v)} aria-expanded={pasteOpen}>
            <ClipboardPaste />
            批量粘贴
          </Button>
          <Button variant="outline" size="sm" onClick={() => addRow()} disabled={!rows}>
            <Plus />
            加一行
          </Button>
          <Button
            size="sm"
            className="bg-stone-900 hover:bg-stone-800"
            onClick={() => void save()}
            disabled={saving || !rows || rows.length === 0}
          >
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            保存单价表
          </Button>
        </div>
      }
    >
      {loading && !rows ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> 正在加载单价表…
        </p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : rows && rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-4 text-sm text-muted-foreground">
          <p className="font-medium text-stone-700">尚未配置任何模型单价</p>
          <p className="mt-1">
            配置后总览页将新增「成本估算」卡片，用量透视支持 Tokens ⇄ 成本切换，日志与密钥页显示估算金额。可点击上方「参考价预填」一键按公开列表价初始化，或用「未计价模型」快速补录、「批量粘贴」导入。
          </p>
        </div>
      ) : rows ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-stone-200">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-9 text-xs">模型名</TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    输入 <span className="text-stone-400">$/1M</span>
                  </TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    输出 <span className="text-stone-400">$/1M</span>
                  </TableHead>
                  <TableHead className="h-9 text-right text-xs">
                    缓存命中 <span className="text-stone-400">$/1M</span>
                  </TableHead>
                  <TableHead className="h-9 text-xs">更新</TableHead>
                  <TableHead className="h-9 w-10 text-xs" aria-label="操作" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="py-1.5">
                      <Input
                        value={r.model}
                        onChange={(e) => setCell(i, "model", e.target.value)}
                        placeholder="如 deepseek-v4.1-flash"
                        className="h-8 w-56 max-w-full font-mono text-xs"
                        spellCheck={false}
                        aria-label={`第 ${i + 1} 行模型名`}
                      />
                    </TableCell>
                    <TableCell className="py-1.5 text-right">
                      <Input
                        value={r.inputPerMTok}
                        onChange={(e) => setCell(i, "inputPerMTok", e.target.value)}
                        className="h-8 w-24 text-right font-mono text-xs tabular-nums"
                        inputMode="decimal"
                        aria-label={`模型 ${r.model || "未命名"} 输入单价（美元/百万 tokens）`}
                      />
                    </TableCell>
                    <TableCell className="py-1.5 text-right">
                      <Input
                        value={r.outputPerMTok}
                        onChange={(e) => setCell(i, "outputPerMTok", e.target.value)}
                        className="h-8 w-24 text-right font-mono text-xs tabular-nums"
                        inputMode="decimal"
                        aria-label={`模型 ${r.model || "未命名"} 输出单价（美元/百万 tokens）`}
                      />
                    </TableCell>
                    <TableCell className="py-1.5 text-right">
                      <Input
                        value={r.cachedPerMTok}
                        onChange={(e) => setCell(i, "cachedPerMTok", e.target.value)}
                        className="h-8 w-24 text-right font-mono text-xs tabular-nums"
                        inputMode="decimal"
                        aria-label={`模型 ${r.model || "未命名"} 缓存命中单价（美元/百万 tokens；0=缓存命中不计价）`}
                        title="0 = 缓存命中 tokens 不计价（多数中转默认口径）"
                      />
                    </TableCell>
                    <TableCell className="py-1.5 text-xs text-muted-foreground">
                      {r.updatedAt ? (
                        <span title={`最后更新：${r.updatedAt.replace("T", " ").slice(0, 19)}`}>{relativeTime(r.updatedAt)}</span>
                      ) : (
                        <span className="text-stone-300">新行</span>
                      )}
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-7 p-0 text-stone-400 hover:text-red-600"
                        onClick={() => removeRow(i)}
                        aria-label={`删除模型 ${r.model || "未命名"} 的单价行`}
                        title="删除此行（保存后生效）"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-[11px] text-muted-foreground">
            共 {rows.length} 行 · 整表保存语义（保存后不在表内的模型行将被移除）· 成本 = 输入×输入单价 + 输出×输出单价 + 缓存命中×缓存单价（单位：$/1M tokens）
          </p>
        </>
      ) : null}

      {/* 批量粘贴导入 */}
      {pasteOpen && (
        <div className="space-y-1.5 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
          <Label htmlFor="pricing-paste" className="text-xs">
            批量粘贴导入（每行：<span className="font-mono">模型名,输入单价,输出单价[,缓存单价]</span>；3 列时缓存单价默认 0；Tab/逗号分隔，# 注释行忽略）
          </Label>
          <Textarea
            id="pricing-paste"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"# 例：\ndeepseek-v4.1-flash,0.27,1.1,0.07\nclaude-sonnet-4.6,3,15,0.3"}
            className="min-h-24 font-mono text-xs"
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={applyPaste} disabled={!pasteText.trim()}>
              <Check />
              解析并填入
            </Button>
            {pasteResult && <span className="text-xs text-muted-foreground">{pasteResult}</span>}
          </div>
        </div>
      )}

      {/* 未计价模型提示（近 30 天出现但未配置单价） */}
      {unpriced.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          <p className="text-xs font-medium text-amber-800">
            近 30 天有 {unpriced.length} 个模型的调用未配置单价（成本视图将显示为未计价）
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unpriced.map((u) => {
              const exists = (rows || []).some((r) => r.model === u.model);
              return (
                <button
                  key={u.model}
                  type="button"
                  onClick={() => {
                    if (!exists) addRow(u.model);
                  }}
                  disabled={exists}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    exists
                      ? "cursor-default border-stone-200 bg-white text-stone-400"
                      : "cursor-pointer border-amber-300 bg-white text-amber-800 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
                  }`}
                  title={exists ? "已在单价表中" : `点击补录 ${u.model} 的单价`}
                  aria-label={`补录模型 ${u.model} 单价（近 30 天 ${u.requests} 次调用）`}
                >
                  {u.model}
                  <span className="font-sans text-[10px] text-stone-400">{u.requests} 次</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 保存反馈 */}
      {notice && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-700">
          <Check className="size-3.5" aria-hidden /> {notice}
        </p>
      )}
      {error && !loading && <p className="text-sm text-red-600">{error}</p>}
    </Section>
    </div>
  );
}
