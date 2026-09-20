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
    <Section
      icon={<BadgeDollarSign className="size-4.5" />}
      title="模型单价 · 成本估算"
      description="按上游实际结算价填写 $/百万 tokens；总览成本卡 / 用量透视 / 密钥与日志的估算均基于此表（仅估算展示，不做计费）"
      actions={
        <div className="flex gap-2">
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
            配置后总览页将新增「成本估算」卡片，用量透视支持 Tokens ⇄ 成本切换，日志与密钥页显示估算金额。可点击下方「未计价模型」快速补录，或用「批量粘贴」导入。
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
  );
}
