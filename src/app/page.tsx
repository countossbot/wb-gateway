// Universal AI Gateway · Web 管理控制台（单页应用）
// 路由守卫：GET /api/console/auth/session → 未初始化 = 引导页；未登录 = 登录页；已登录 = 控制台。
"use client";

import * as React from "react";
import { Network, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setUnauthorizedHandler, authHeaders, clearSessionToken } from "@/lib/console/api";
import { parseTabParam, syncTabToUrl } from "@/lib/console/urlState";
import type { SessionInfo } from "@/lib/console/types";
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

// v4.9.13-local：默认口令安全横幅的会话级关闭记忆（sessionStorage —— 关闭后未重开标签前不再打扰，
// 重开/新会话重现，保持安全提醒压力；改密后后端不再下发标志，横幅自然消失）
const DEFAULT_PWD_BANNER_DISMISSED = "uag-default-pwd-banner-dismissed";

export default function Home() {
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [username, setUsername] = React.useState("");
  const [authVia, setAuthVia] = React.useState<"cookie" | "bearer" | null>(null);
  const [version, setVersion] = React.useState("—");
  // v4.9.13-local：管理员口令仍为公开默认值 → 控制台顶部常驻安全横幅
  const [defaultPwdActive, setDefaultPwdActive] = React.useState(false);
  const [bannerDismissed, setBannerDismissed] = React.useState(false);
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
  // v4.9.13-local-r4：总览错误模式卡 → 按状态大类下钻（第十跳转通道，单一意图：仅设状态筛选）
  const [logsStatus, setLogsStatus] = React.useState<"2xx" | "4xx" | "5xx" | null>(null);
  // v4.9.13-local-r9：错误模式下钻通道携带的检索词（模式骨架片段；总览错误卡/失败徽标 tooltip 的
  // 关键字下钻落点，与 logsStatus 同构但优先级更高 —— 有检索词时状态清回 null）
  const [logsErrorKeyword, setLogsErrorKeyword] = React.useState<string | null>(null);
  // v4.9.13-local-r15：总览 Top 成本模型 chip → 模型路由页联动（第十一跳转通道）
  // 携带目标模型名切到路由页；RoutesModule 数据就绪后消费（编辑/克隆/预填新建三级回退）
  const [routesEditModel, setRoutesEditModel] = React.useState<string | null>(null);
  // r18：总览 Top 提供商行 → API 中转页联动（第十二跳转通道）
  // 携带目标提供商 ID 切页；ProvidersModule 数据就绪后消费（滚动定位 + 翡翠光环高亮）
  const [providersFocusId, setProvidersFocusId] = React.useState<string | null>(null);

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
      setUsername(s.username || "");
      setAuthVia(s.authVia ?? null);
      setDefaultPwdActive(!!s.defaultPasswordActive);
      // 会话恢复时重读关闭记忆（新标签页/新会话重现横幅，保持安全提醒压力）
      setBannerDismissed(sessionStorage.getItem(DEFAULT_PWD_BANNER_DISMISSED) === "1");
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
          setLogsStatus(null);
          setLogsErrorKeyword(null);
        }
        setTab(t);
      }}
      onLogout={logout}
    >
      {/* v4.9.13-local：公开默认口令安全横幅 —— 管理员口令仍为 gateway-admin-2026 时常驻提醒 */}
      {phase === "console" && defaultPwdActive && !bannerDismissed && (
        <div
          role="alert"
          aria-label="默认口令安全提醒"
          className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 px-4 py-3.5 shadow-sm sm:flex-row sm:items-center"
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100">
              <ShieldAlert className="size-4.5 text-amber-600" />
            </span>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-amber-900">安全提醒：管理员仍在使用公开默认口令</p>
              <p className="text-xs leading-relaxed text-amber-800/90">
                当前口令为代码内置公开值
                <code className="mx-1 rounded bg-amber-100/80 px-1.5 py-0.5 font-mono text-[11px] text-amber-900">gateway-admin-2026</code>
                —— 任何知道该值的人都可登录控制台（管理账号凭证、密钥与路由）。请立即前往「设置 → 管理员密码」修改为强口令。
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">
            <Button
              size="sm"
              className="h-8 bg-amber-600 px-3 text-xs text-white hover:bg-amber-700"
              onClick={() => setTab("settings")}
            >
              前往修改
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-amber-600 hover:bg-amber-100 hover:text-amber-800"
              aria-label="关闭默认口令提醒（本次会话内不再显示）"
              title="本次会话内不再显示；重新打开页面会再次提醒"
              onClick={() => {
                sessionStorage.setItem(DEFAULT_PWD_BANNER_DISMISSED, "1");
                setBannerDismissed(true);
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}
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
            setLogsStatus(null);
            setLogsErrorKeyword(null);
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
            setLogsStatus(null);
            setLogsErrorKeyword(null);
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
            // v4.9.13-local-r9：补齐与其他通道一致的全量清空（此前缺 model/status/errorKeyword 清理，
            // 旧筛选残留会叠加进今日窗口 —— 单一意图原则对齐）
            setLogsModel(null);
            setLogsStatus(null);
            setLogsErrorKeyword(null);
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
            setLogsStatus(null);
            setLogsErrorKeyword(null);
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
            setLogsStatus(null);
            setLogsErrorKeyword(null);
            setLogsTimeRange({
              from,
              to: from + 86_400_000,
              label: "今日全天",
            });
            setTab("logs");
          }}
          onErrorPatternsClick={(drill) => {
            // v4.9.13-local-r4：总览错误模式卡行 → 下钻运行日志（第十跳转通道，单一意图：不携带模型/密钥/时间）；
            // v4.9.13-local-r9 升级：优先错误关键字（模式骨架片段 contains 命中整组，比状态大类精准，
            // 且解锁跨状态大类的模式组）；无关键字时回落状态大类下钻（既有语义）
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsTimeRange(null);
            setLogsErrorKeyword(drill.keyword ?? null);
            setLogsStatus(drill.keyword ? null : drill.statusClass);
            setTab("logs");
          }}
          onNavigate={(t) => setTab(t)}
          onModelRouteClick={(model) => {
            // v4.9.13-local-r15：Top 成本模型 chip → 路由页（单一意图：只带目标模型名，不动其他筛选）
            setRoutesEditModel(model);
            setTab("routes");
          }}
          onProviderClick={(pid) => {
            // r18：Top 提供商行 → API 中转页定位高亮（单一意图：只带目标提供商 ID）
            setProvidersFocusId(pid);
            setTab("providers");
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
            setLogsStatus(null);
            setLogsErrorKeyword(null);
            setTab("logs");
          }}
          onDrillErrors={(target, errorKeyword) => {
            // v4.9.13-local-r5：健康面板「失败 N」徽标 → 该账号 + 5xx 组合下钻
            //（组合筛选两 state 同时设置，LogsModule 挂载初始化天然支持 account × status 组合）；
            // v4.9.13-local-r9：tooltip 模式行点击携 errorKeyword 时改走关键字下钻（精准命中该模式组，状态清回）
            setLogsProvider(null);
            setLogsKeyName(null);
            setLogsTimeRange(null);
            setLogsAccount(target);
            setLogsModel(null);
            setLogsErrorKeyword(errorKeyword ?? null);
            setLogsStatus(errorKeyword ? null : "5xx");
            setTab("logs");
          }}
        />
      )}
      {tab === "providers" && (
        <ProvidersModule
          focusProviderId={providersFocusId}
          onProviderFocusConsumed={() => setProvidersFocusId(null)}
          onViewLogs={(pid) => {
            // 跳转意图单一：提供商跳转时清空其他跨模块筛选
            setLogsKeyName(null);
            setLogsTimeRange(null);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsStatus(null);
            setLogsErrorKeyword(null);
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
            // v4.9.13-local-r9：补齐与其他通道一致的状态/关键字清空（此前缺失，旧 5xx 筛选会残留叠加）
            setLogsStatus(null);
            setLogsErrorKeyword(null);
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
            setLogsStatus(null);
            setLogsErrorKeyword(null);
            setLogsKeyName(keyName);
            setTab("logs");
          }}
          onDrillErrors={(keyName, errorKeyword) => {
            // v4.9.13-local-r6：密钥健康面板失败徽标下钻 —— 该密钥 × 5xx 组合筛选
            //（两 state 同时设置，LogsModule 挂载初始化天然支持 key × status 组合，与账号页 onDrillErrors 同构）；
            // v4.9.13-local-r9：tooltip 模式行点击携 errorKeyword 时改走关键字下钻（精准命中该模式组，状态清回）
            setLogsProvider(null);
            setLogsTimeRange(null);
            setLogsAccount(null);
            setLogsModel(null);
            setLogsErrorKeyword(errorKeyword ?? null);
            setLogsStatus(errorKeyword ? null : "5xx");
            setLogsKeyName(keyName);
            setTab("logs");
          }}
        />
      )}
      {tab === "routes" && (
        <RoutesModule
          editModelTarget={routesEditModel}
          onEditModelTargetConsumed={() => setRoutesEditModel(null)}
        />
      )}
      {tab === "jobs" && <JobsModule />}
      {tab === "logs" && (
        <LogsModule
          initialProvider={logsProvider}
          initialKeyName={logsKeyName}
          initialTimeRange={logsTimeRange}
          initialAccount={logsAccount}
          initialModel={logsModel}
          initialStatus={logsStatus}
          initialErrorKeyword={logsErrorKeyword}
        />
      )}
      {tab === "settings" && <SettingsModule onPasswordChanged={() => { clearSessionToken(); setPhase("login"); }} />}
    </ConsoleShell>
  );
}
