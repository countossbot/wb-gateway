// Universal AI Gateway · Web 管理控制台（单页应用）
// 路由守卫：GET /api/console/auth/session → 未初始化 = 引导页；未登录 = 登录页；已登录 = 控制台。
"use client";

import * as React from "react";
import { Network } from "lucide-react";
import { setUnauthorizedHandler, authHeaders, clearSessionToken } from "@/lib/console/api";
import { parseTabParam, syncTabToUrl } from "@/lib/console/urlState";
import type { AdminRole, SessionInfo } from "@/lib/console/types";
import { LoginPage } from "@/components/console/login";
import { SetupWizard } from "@/components/console/setup-wizard";
import { ConsoleShell, type ConsoleTab } from "@/components/console/sidebar";
import { OverviewModule } from "@/components/console/overview";
import { AccountsModule } from "@/components/console/accounts";
import { ProvidersModule } from "@/components/console/providers";
import { KeysModule } from "@/components/console/keys";
import { RoutesModule } from "@/components/console/routes";
import { JobsModule } from "@/components/console/jobs";
import { LogsModule, type TimeRangeJump } from "@/components/console/logs";
import { SettingsModule } from "@/components/console/settings";

type Phase = "loading" | "setup" | "login" | "console";

export default function Home() {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [username, setUsername] = React.useState("");
  const [userRole, setUserRole] = React.useState<AdminRole | null>(null);
  const [authVia, setAuthVia] = React.useState<"cookie" | "bearer" | null>(null);
  const [version, setVersion] = React.useState("—");
  // v3.4.0：初始 tab 支持 URL 深链（如 /?tab=logs 直接落到运行日志页）
  const [tab, setTabState] = React.useState<ConsoleTab>(() => {
    if (typeof window === "undefined") return "overview";
    return parseTabParam(window.location.search) ?? "overview";
  });
  // 所有 tab 切换统一走 switchTab：state + URL 同步（replaceState，不触发导航）
  const setTab = React.useCallback((t: ConsoleTab) => {
    setTabState(t);
    syncTabToUrl(t);
  }, []);
  // v3.0.4：跨模块跳转携带的日志筛选（提供商统计条 → 运行日志按提供商过滤）
  const [logsProvider, setLogsProvider] = React.useState<string | null>(null);
  // v3.0.5：密钥徽标 → 按调用方密钥名过滤；趋势图柱 → 该小时窗口过滤
  const [logsKeyName, setLogsKeyName] = React.useState<string | null>(null);
  const [logsTimeRange, setLogsTimeRange] = React.useState<TimeRangeJump | null>(null);
  // v3.0.6：账号徽标 → 按（提供商 × 账号）组合过滤（组合键防跨提供商同名 default 串扰）
  const [logsAccount, setLogsAccount] = React.useState<{ providerId: string; accountId: string } | null>(null);
  // v3.8.0：模型健康行 → 按对外模型过滤（第八跳转通道）
  const [logsModel, setLogsModel] = React.useState<string | null>(null);

  const refreshSession = React.useCallback(async () => {
    try {
      // 双通道：Cookie 自动携带 + Bearer 令牌兑底（跨站 iframe 场景）
      const res = await fetch("/api/console/auth/session", {
        credentials: "same-origin",
        headers: authHeaders(),
      });
      const body = (await res.json()) as { ok?: boolean; data?: SessionInfo };
      const s = body.data;
      if (!s) throw new Error("会话接口异常");
      setUsername(s.displayName || s.username || "");
      setUserRole(s.role || null);
      setAuthVia(s.authVia ?? null);
      if (!s.initialized) setPhase("setup");
      else if (!s.authenticated) setPhase("login");
      else setPhase("console");
    } catch {
      // 网络异常等场景：保守起见停在 loading 全屏骨架
      setPhase("loading");
    }
  }, []);

  React.useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // 任意 API 401 → 会话失效，切回登录态
  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      setPhase((p) => (p === "console" ? "login" : p));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // 版本号（公开 /status 端点，无需鉴权）
  React.useEffect(() => {
    if (phase !== "console") return;
    let alive = true;
    fetch("/status")
      .then((r) => r.json())
      .then((j: { version?: string }) => {
        if (alive && j?.version) setVersion(j.version);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [phase]);

  const logout = React.useCallback(async () => {
    try {
      // 带 Bearer：令牌指向的会话记录一并销毁（即使 Cookie 通道已被浏览器丢弃）
      await fetch("/api/console/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders(),
      });
    } catch {
      /* ignore */
    }
    clearSessionToken();
    setPhase("login");
  }, []);

  if (phase === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-stone-50">
        <div className="flex size-14 animate-pulse items-center justify-center rounded-2xl bg-stone-900 text-white">
          <Network className="size-7" />
        </div>
        <p className="text-sm text-muted-foreground">正在加载控制台…</p>
      </div>
    );
  }

  if (phase === "setup") {
    return <SetupWizard onCompleted={() => void refreshSession()} />;
  }

  if (phase === "login") {
    return <LoginPage onLoginSuccess={(u) => { setUsername(u); void refreshSession(); }} />;
  }

  return (
    <ConsoleShell
      version={version}
      username={username || "admin"}
      role={userRole}
      authVia={authVia}
      active={tab}
      onSelect={(t) => {
        // 侧边栏直达「运行日志」时清除跨模块携带的筛选（来自统计条/趋势柱/密钥徽标/账号徽标的跳转才保留筛选）
        if (t === "logs") {
          setLogsProvider(null);
          setLogsKeyName(null);
          setLogsTimeRange(null);
          setLogsAccount(null);
          setLogsModel(null);
        }
        setTab(t);
      }}
      onLogout={logout}
    >
      {tab === "overview" && (
        <OverviewModule
          onHourClick={(hourIso) => {
            const from = Date.parse(hourIso);
            if (!Number.isFinite(from)) return;
            const d = new Date(from);
            // 跳转意图单一：时间窗口跳转时清空其他跨模块筛选，避免叠加残留
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsTimeRange({
              from,
              to: from + 3600_000,
              label: `${String(d.getHours()).padStart(2, "0")}:00 小时`,
            });
            setTab("logs");
          }}
          onDayClick={(dayKey) => {
            // v3.0.6：近 7 天趋势柱 → 该天 0 点-24 点窗口（本地时区；YYYY-MM-DD）
            const [y, m, d] = dayKey.split("-").map(Number);
            if (!y || !m || !d) return;
            const from = new Date(y, m - 1, d).getTime();
            if (!Number.isFinite(from)) return;
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsTimeRange({
              from,
              to: from + 86_400_000,
              label: `${m}/${d} 全天`,
            });
            setTab("logs");
          }}
          onTodayClick={() => {
            // v3.0.7：今日消耗卡 → 今日 0 点-24 点窗口（第五跨模块跳转通道）
            const d0 = new Date();
            d0.setHours(0, 0, 0, 0);
            const from = d0.getTime();
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsAccount(null);
            setLogsTimeRange({
              from,
              to: from + 86_400_000,
              label: "今日全天",
            });
            setTab("logs");
          }}
          onKeyClick={(keyName) => {
            // v3.1.1：今日 Top 密钥排行行 → 该密钥 + 今日全天窗口（第六跨模块跳转通道，单一意图）
            const d0 = new Date();
            d0.setHours(0, 0, 0, 0);
            const from = d0.getTime();
            setLogsProvider(null);
            setLogsKeyName(keyName);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsTimeRange({
              from,
              to: from + 86_400_000,
              label: "今日全天",
            });
            setTab("logs");
          }}
          onModelClick={(model) => {
            // v3.9.0：今日 Top 模型排行行 → 该模型 + 今日全天窗口（第九跳转通道，单一意图；
            // 与第八通道共用 logsModel state，但本通道额外携今日全天时间窗）
            const d0 = new Date();
            d0.setHours(0, 0, 0, 0);
            const from = d0.getTime();
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsAccount(null);
            setLogsModel(model);
            setLogsTimeRange({
              from,
              to: from + 86_400_000,
              label: "今日全天",
            });
            setTab("logs");
          }}
        />
      )}
      {tab === "accounts" && (
        <AccountsModule
          onViewLogs={(target) => {
            // 跳转意图单一：账号跳转时清空其他跨模块筛选
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsTimeRange(null);
            setLogsAccount(target);
            setLogsModel(null);
            setTab("logs");
          }}
        />
      )}
      {tab === "providers" && (
        <ProvidersModule
          onViewLogs={(pid) => {
            // 跳转意图单一：提供商跳转时清空其他跨模块筛选
            setLogsKeyName(null);
            setLogsTimeRange(null);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsProvider(pid);
            setTab("logs");
          }}
          onViewLogsForModel={(model) => {
            // v3.8.0：模型健康行 → 按对外模型过滤（第八跳转通道，单一意图）
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsTimeRange(null);
            setLogsAccount(null);
            setLogsModel(model);
            setTab("logs");
          }}
        />
      )}
      {tab === "keys" && (
        <KeysModule
          onViewLogs={(keyName) => {
            // 跳转意图单一：密钥跳转时清空其他跨模块筛选
            setLogsProvider(null);
            setLogsTimeRange(null);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsKeyName(keyName);
            setTab("logs");
          }}
        />
      )}
      {tab === "routes" && <RoutesModule />}
      {tab === "jobs" && <JobsModule />}
      {tab === "logs" && (
        <LogsModule
          initialProvider={logsProvider}
          initialKeyName={logsKeyName}
          initialTimeRange={logsTimeRange}
          initialAccount={logsAccount}
          initialModel={logsModel}
        />
      )}
      {tab === "settings" && <SettingsModule onPasswordChanged={() => { clearSessionToken(); setPhase("login"); }} />}
    </ConsoleShell>
  );
}
