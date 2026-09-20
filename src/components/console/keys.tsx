// 虚拟密钥管理 —— 客户端接入密钥（模型白名单 / 角色限权）。
// 密钥明文只在创建时一次性返回；列表与编辑均显示掩码。
"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
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
import { absoluteTime } from "@/lib/console/format";
import type { CreatedKey, KeysData, VirtualKeyRow } from "@/lib/console/types";

/** v3.5.0：密钥名 → 近 7 天逐日用量（sparkline 数据源） */
type Usage7dMap = Map<string, Array<{ day: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number }>>;

export function KeysModule({ onViewLogs }: { onViewLogs?: (keyName: string) => void } = {}) {
  const [data, setData] = React.useState<KeysData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  // 新建 / 编辑
  const [editOpen, setEditOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<VirtualKeyRow | null>(null);
  const [form, setForm] = React.useState<{ name: string; keyValue: string; models: string[]; role: string; remark: string }>({
    name: "",
    keyValue: "",
    models: ["*"],
    role: "client",
    remark: "",
  });
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");

  // 一次性明文展示
  const [created, setCreated] = React.useState<CreatedKey | null>(null);

  // 删除
  const [delTarget, setDelTarget] = React.useState<VirtualKeyRow | null>(null);
  const [delSaving, setDelSaving] = React.useState(false);

  // v3.5.0：近 7 天用量 sparkline 数据（UsageDaily 按密钥名 × 日聚合；一次拉取全局复用）
  const [usage7d, setUsage7d] = React.useState<Usage7dMap | null>(null);
  const [usage7dDays, setUsage7dDays] = React.useState<string[]>([]);
  React.useEffect(() => {
    let alive = true;
    apiGet<{
      range: { from: string; to: string };
      rows: Array<{ day: string; providerId: string | null; apiKeyName: string | null; requests: number; okRequests: number; inputTokens: number; outputTokens: number }>;
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
        const m = new Map<string, Array<{ day: string; requests: number; okRequests: number; inputTokens: number; outputTokens: number }>>();
        for (const r of d.rows) {
          const name = r.apiKeyName || "(unknown)";
          const arr = m.get(name) || [];
          const found = arr.find((x) => x.day === r.day);
          if (found) {
            found.requests += r.requests;
            found.okRequests += r.okRequests;
            found.inputTokens += r.inputTokens;
            found.outputTokens += r.outputTokens;
          } else {
            arr.push({ day: r.day, requests: r.requests, okRequests: r.okRequests, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
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
    setForm({ name: "", keyValue: "", models: ["*"], role: "client", remark: "" });
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
    });
    setFormError("");
    setEditOpen(true);
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
        });
        setNotice("密钥已更新");
      } else {
        const r = await apiPost<CreatedKey>("/api/console/keys", {
          name: form.name.trim(),
          keyValue: form.keyValue.trim() || undefined,
          models: form.models,
          role: form.role,
          remark: form.remark.trim() || undefined,
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
                  <TableHead className="hidden xl:table-cell">健康面板</TableHead>
                  {/* v3.7.0：最后使用时间（RequestLog 滚动窗口 MAX(createdAt)） */}
                  <TableHead className="hidden lg:table-cell">最后使用</TableHead>
                  {/* v3.5.0：近 7 天用量 sparkline */}
                  <TableHead className="hidden lg:table-cell">近 7 天用量</TableHead>
                  <TableHead className="hidden lg:table-cell">备注</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-stone-800">{k.name}</span>
                        <span className="text-[11px] text-stone-400">{absoluteTime(k.createdAt)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <code className="max-w-40 truncate rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700" title={k.keyMasked}>
                          {k.keyMasked}
                        </code>
                        <CopyButton text={k.keyMasked} size="icon" variant="ghost" label="" />
                      </div>
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
                    <TableCell className="hidden lg:table-cell">
                      {(() => {
                        const days = usage7d?.get(k.name);
                        if (!usage7d || !days) return <MiniBars values={[0, 0, 0, 0, 0, 0, 0]} ariaLabel={`密钥 ${k.name} 近 7 天用量`} />;
                        const per = usage7dDays.map((day) => days.find((x) => x.day === day)?.requests ?? 0);
                        const details = usage7dDays.map((day, i) => {
                          const rec = days.find((x) => x.day === day);
                          const tk = rec ? rec.inputTokens + rec.outputTokens : 0;
                          return (
                            <span key={i} className="block tabular-nums">
                              {day.slice(5).replace("-", "/")}：{per[i]} 次
                              {tk > 0 ? ` · ${tk.toLocaleString()} tk` : ""}
                            </span>
                          );
                        });
                        return <MiniBars values={per} details={details} ariaLabel={`密钥 ${k.name} 近 7 天用量，共 ${per.reduce((s, v) => s + v, 0)} 次`} />;
                      })()}
                    </TableCell>
                    <TableCell className="hidden max-w-44 truncate text-xs text-muted-foreground lg:table-cell" title={k.remark || undefined}>
                      {k.remark || "—"}
                    </TableCell>
                    <TableCell>
                      <Switch checked={k.enabled} onCheckedChange={(v) => void toggleEnabled(k, v)} aria-label={`启用 ${k.name}`} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
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
        「最后使用」取自请求日志滚动窗口内的最近一次调用（v3.7.0；窗口仅保留近期 5000 条，长期闲置的密钥可能显示为「从未使用」，语义为近期未调用）；
        「近 7 天用量」为该密钥逐日请求数迷你图（UsageDaily 聚合，悬停 ⓘ 查看每日明细），仅供全量/估算 token 的场景参考。
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
    </div>
  );
}
