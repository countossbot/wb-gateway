// 登录页 —— 用户名 + 密码；错误提示含锁定剩余时间（429 场景由后端文案直接给出）。
// v3.0.8：会话通道徽标 —— 实时探测 Cookie 可写性与本地令牌状态，
// iframe 嵌入环境下提前告知用户「Cookie 受限但令牌通道可用」，消除「登录后弹回」疑虑。
"use client";

import * as React from "react";
import { Cookie, KeyRound, Loader2, LogIn, Network, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errMessage, readSessionToken, saveSessionToken } from "@/lib/console/api";

/** v3.0.8：会话通道状态徽标 —— Cookie 可写性探测 + 本地令牌检测 */
function SessionChannelBadge() {
  const [cookieOk, setCookieOk] = React.useState<boolean | null>(null);
  const [hasToken, setHasToken] = React.useState(false);

  React.useEffect(() => {
    // Cookie 可写性探测：写入再读回（跨站 iframe 中 SameSite 策略会丢弃）
    try {
      document.cookie = "uag_cookie_probe=1; path=/; SameSite=Lax";
      setCookieOk(document.cookie.includes("uag_cookie_probe=1"));
      // 清理探针
      document.cookie = "uag_cookie_probe=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    } catch {
      setCookieOk(false);
    }
    // 本地令牌检测（跨站 iframe 中 Cookie 被丢弃时的兑底通道）
    setHasToken(!!readSessionToken());
  }, []);

  return (
    <div
      role="status"
      aria-label="会话通道状态"
      className="mt-4 space-y-2 rounded-lg border border-stone-200 bg-stone-50/80 p-3 text-xs"
    >
      <p className="font-medium text-stone-600">会话通道状态</p>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-stone-600">
          <Cookie className="size-3.5 shrink-0" aria-hidden />
          Cookie 通道
        </span>
        {cookieOk === null ? (
          <span className="text-stone-400">检测中…</span>
        ) : cookieOk ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">可用</span>
        ) : (
          <span
            className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700"
            title="跨站 iframe 嵌入环境会丢弃 Set-Cookie；登录后将自动改用令牌通道"
          >
            受限 · 将用令牌兑底
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-stone-600">
          <KeyRound className="size-3.5 shrink-0" aria-hidden />
          令牌通道
        </span>
        <span
          className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700"
          title={hasToken ? "localStorage 中存在历史令牌，登录后自动续用同一会话" : "localStorage 可用，登录后将保存会话令牌作为兑底通道"}
        >
          {hasToken ? "可用 · 检测到历史令牌" : "可用"}
        </span>
      </div>
    </div>
  );
}

export function LoginPage({ onLoginSuccess }: { onLoginSuccess: (username: string) => void }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError("");
    if (!username.trim() || !password) {
      setError("请输入用户名与密码");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/console/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        data?: { username?: string; sessionToken?: string };
      };
      if (!body.ok) {
        setError(body.error || `登录失败（HTTP ${res.status}）`);
        return;
      }
      // 双通道：令牌落 localStorage（跨站 iframe 中 Cookie 被丢弃时的兑底通道）
      saveSessionToken(body.data?.sessionToken);
      onLoginSuccess(body.data?.username || username.trim());
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-stone-50">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-stone-900 text-white shadow-lg">
              <Network className="size-7" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Universal AI Gateway</h1>
            <p className="mt-2 text-sm text-muted-foreground">Web 管理控制台 · 请登录以继续</p>
          </div>

          <form
            onSubmit={submit}
            className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm"
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="login-username">用户名</Label>
                <Input
                  id="login-username"
                  autoComplete="username"
                  placeholder="管理员用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="login-password">密码</Label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="管理员密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                />
              </div>

              {error && (
                <Alert variant="destructive">
                  <ShieldCheck />
                  <AlertDescription className="break-all">{error}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" className="w-full bg-stone-900 hover:bg-stone-800" disabled={loading}>
                {loading ? <Loader2 className="animate-spin" /> : <LogIn />}
                {loading ? "登录中…" : "登 录"}
              </Button>
            </div>

            <SessionChannelBadge />

            <p className="mt-4 text-center text-xs text-muted-foreground">
              连续 5 次失败将临时锁定 15 分钟
            </p>
          </form>
        </div>
      </main>

      <footer className="mt-auto py-6 text-center text-xs text-muted-foreground">
        Universal AI Gateway · 本地部署 · 会话有效 12 小时（滑动续期）
        <br />
        <span className="text-stone-400">双通道会话：Cookie（常规部署）+ 令牌兑底（iframe 嵌入环境亦可用）</span>
      </footer>
    </div>
  );
}
