// 成员管理 Section（v4.9.0 Task 5B）
// 仅 ADMIN 可见；列表 / 新增 / 编辑角色与启用 / 重置密码 / 删除。
"use client";

import * as React from "react";
import { Check, Loader2, Plus, RotateCcw, ShieldAlert, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiDelete, apiGet, apiPost, apiPut, errMessage } from "@/lib/console/api";
import { Section } from "@/components/console/settings-sections";
import { ErrorAlert } from "@/components/console/ui";
import { TypeBadge } from "@/components/console/ui";

interface Member {
  id: string;
  username: string;
  displayName: string | null;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  enabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  sessionCount: number;
}

interface CurrentUser {
  id: string;
  username: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
}

interface MembersData {
  members: Member[];
  currentUser: CurrentUser;
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "管理员",
  OPERATOR: "操作员",
  VIEWER: "观察者",
};

export function MembersSection() {
  const [data, setData] = React.useState<MembersData | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Member | null>(null);
  const [resetPasswordResult, setResetPasswordResult] = React.useState<{ username: string; newPassword: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Member | null>(null);
  const [deleteSaving, setDeleteSaving] = React.useState(false);
  const [form, setForm] = React.useState({ username: "", displayName: "", role: "OPERATOR", password: "" });
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<MembersData>("/api/console/members");
      setData(d);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const isCurrentUser = (m: Member) => data?.currentUser.id === m.id;
  const canManage = data?.currentUser.role === "ADMIN";
  const activeAdminCount = data?.members.filter((m) => m.role === "ADMIN" && m.enabled).length ?? 0;

  const openCreate = () => {
    setEditing(null);
    setForm({ username: "", displayName: "", role: "OPERATOR", password: "" });
    setFormError("");
    setDialogOpen(true);
  };

  const openEdit = (m: Member) => {
    setEditing(m);
    setForm({ username: m.username, displayName: m.displayName || "", role: m.role, password: "" });
    setFormError("");
    setDialogOpen(true);
  };

  const save = async () => {
    setFormError("");
    setSaving(true);
    try {
      if (editing) {
        await apiPut("/api/console/members", {
          id: editing.id,
          displayName: form.displayName,
          role: form.role,
        });
        setNotice(`成员「${editing.username}」已更新`);
      } else {
        await apiPost("/api/console/members", form);
        setNotice(`成员「${form.username}」已创建`);
      }
      setDialogOpen(false);
      await load();
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (m: Member) => {
    const action = m.enabled ? "disable" : "enable";
    try {
      await apiPost("/api/console/members/action", { action, id: m.id });
      setNotice(`成员「${m.username}」已${m.enabled ? "禁用" : "启用"}`);
      await load();
    } catch (e) {
      setError(errMessage(e));
    }
  };

  const resetPassword = async (m: Member) => {
    try {
      const d = await apiPost<{ newPassword: string }>("/api/console/members/action", { action: "reset-password", id: m.id });
      setResetPasswordResult({ username: m.username, newPassword: d.newPassword });
      await load();
    } catch (e) {
      setError(errMessage(e));
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setDeleteSaving(true);
    try {
      await apiDelete(`/api/console/members?id=${deleteTarget.id}`);
      setNotice(`成员「${deleteTarget.username}」已删除`);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setDeleteSaving(false);
    }
  };

  const canDisable = (m: Member) =>
    canManage && !isCurrentUser(m) && !(m.role === "ADMIN" && m.enabled && activeAdminCount <= 1);

  return (
    <Section
      icon={<UserRound className="size-4.5" />}
      title="成员管理"
      description="轻量多成员控制台：ADMIN 管理全部；OPERATOR 管理路由与密钥；VIEWER 只读"
    >
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <Check className="size-4" />
          {notice}
        </div>
      )}
      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            新增成员
          </Button>
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载中…
        </div>
      ) : data ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户名</TableHead>
                <TableHead className="hidden sm:table-cell">显示名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>启用</TableHead>
                <TableHead className="hidden md:table-cell">最近登录</TableHead>
                <TableHead className="hidden lg:table-cell">会话</TableHead>
                {canManage && <TableHead className="text-right">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => (
                <TableRow key={m.id} className={!m.enabled ? "opacity-50" : ""}>
                  <TableCell className="font-mono text-xs">
                    {m.username}
                    {isCurrentUser(m) && <Badge variant="outline" className="ml-1.5 text-[9px]">当前</Badge>}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">{m.displayName || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={m.role === "ADMIN" ? "default" : "secondary"} className="text-[10px]">
                      {ROLE_LABELS[m.role] || m.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {canManage && !isCurrentUser(m) ? (
                      <Switch checked={m.enabled} onCheckedChange={() => void toggleEnabled(m)} disabled={!canDisable(m)} />
                    ) : (
                      <Badge variant={m.enabled ? "default" : "secondary"} className="text-[10px]">
                        {m.enabled ? "启用" : "禁用"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString("zh-CN") : "从未登录"}
                  </TableCell>
                  <TableCell className="hidden text-xs tabular-nums text-muted-foreground lg:table-cell">{m.sessionCount}</TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(m)}>编辑</Button>
                        <Button variant="ghost" size="sm" onClick={() => void resetPassword(m)}>重置密码</Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-700"
                          onClick={() => setDeleteTarget(m)}
                          disabled={isCurrentUser(m) || (m.role === "ADMIN" && m.enabled && activeAdminCount <= 1)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {/* 新增 / 编辑成员 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !o && setDialogOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑成员 · ${editing.username}` : "新增成员"}</DialogTitle>
            <DialogDescription>
              {editing ? "修改显示名与角色；角色变更在下次请求生效。" : "创建新成员；初始密码至少 8 位。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!editing && (
              <div className="space-y-1.5">
                <Label htmlFor="member-username">用户名</Label>
                <Input id="member-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="如 alice" className="font-mono text-xs" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="member-displayname">显示名（可选）</Label>
              <Input id="member-displayname" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="如 Alice" />
            </div>
            <div className="space-y-1.5">
              <Label>角色</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })} disabled={!!editing && editing.role === "ADMIN" && activeAdminCount <= 1}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editing?.role === "ADMIN" && activeAdminCount <= 1 && (
                <p className="text-xs text-amber-600">最后一个启用管理员，角色不可更改</p>
              )}
            </div>
            {!editing && (
              <div className="space-y-1.5">
                <Label htmlFor="member-password">初始密码</Label>
                <Input id="member-password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 8 位" />
              </div>
            )}
            {formError && <p className="text-sm text-red-600">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              {editing ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置密码结果 Dialog */}
      <Dialog open={!!resetPasswordResult} onOpenChange={(o) => !o && setResetPasswordResult(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>密码已重置</DialogTitle>
            <DialogDescription>
              请将以下新密码安全地传递给 <code className="font-mono">{resetPasswordResult?.username}</code>。
              <br />该成员的旧会话已全部失效。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-stone-100 px-4 py-3">
            <code className="select-all font-mono text-sm font-bold">{resetPasswordResult?.newPassword}</code>
          </div>
          <DialogFooter>
            <Button onClick={() => setResetPasswordResult(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除成员</DialogTitle>
            <DialogDescription>
              确定要删除成员 <code className="font-mono">{deleteTarget?.username}</code> 吗？
              <br />该操作会同时删除该成员的全部会话。其名下的虚拟密钥不受影响，但会失去归属。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={() => void doDelete()} disabled={deleteSaving}>
              {deleteSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
