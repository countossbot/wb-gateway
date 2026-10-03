// 控制台外壳 —— 左侧固定导航（桌面）/ 抽屉导航（移动）+ 顶栏（版本 / 用户名 / 登出）。
"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Clock,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Route as RouteIcon,
  ScrollText,
  Settings,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { RuntimeHealthBadge } from "@/components/console/runtime-health-badge";
import { RssAlertBanner } from "@/components/console/rss-alert-banner";
import { ThemeToggle } from "@/components/console/theme-toggle";
import { CommandPalette, CommandPaletteTrigger } from "@/components/console/command-palette";
import { useRuntimeHealth } from "@/lib/console/useRuntimeHealth";
import { cn } from "@/lib/utils";

export type ConsoleTab =
  | "overview"
  | "accounts"
  | "providers"
  | "keys"
  | "routes"
  | "jobs"
  | "logs"
  | "settings";

export const TAB_ITEMS: Array<{ id: ConsoleTab; label: string; icon: React.ElementType }> = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "accounts", label: "账号管理", icon: Users },
  { id: "providers", label: "API 中转", icon: Network },
  { id: "keys", label: "虚拟密钥", icon: KeyRound },
  { id: "routes", label: "模型路由", icon: RouteIcon },
  { id: "jobs", label: "定时任务", icon: Clock },
  { id: "logs", label: "运行日志", icon: ScrollText },
  { id: "settings", label: "设置", icon: Settings },
];

/**
 * v4.11.0-local：数据库方言徽标 —— 从 /api/console/system-info 真实读取。
 * 原实现直接 import 服务端 @/lib/db 的 dbDialect（客户端 bundle 中 process.env.DATABASE_URL
 * 不会被内联，恒为空 → 回落 'postgresql'），在 SQLite 本地部署下显示错误标签。
 */
function DatabaseBadge() {
  const { dbDialect, loading } = useRuntimeHealth();
  const label =
    dbDialect === "mysql" ? "MySQL" : dbDialect === "sqlite" ? "SQLite" : dbDialect === "postgresql" ? "PostgreSQL" : loading ? "…" : "—";
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">数据库</span>
      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700">
        {label}
      </Badge>
    </div>
  );
}

function NavList({
  active,
  onSelect,
}: {
  active: ConsoleTab;
  onSelect: (t: ConsoleTab) => void;
}) {
  // v4.9.11-sandbox-r4：WAI-ARIA roving tabindex —— Tab 键进入导航时焦点落在当前页项，
  // ↑/↓（或 ←/→）在项间循环移动，Home/End 跳首尾；Tab 离开导航后焦点正常续走，不困在菜单里。
  const listRef = React.useRef<HTMLElement>(null);
  const onNavKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-nav-item]") ?? []
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = idx < 0 ? 0 : (idx + 1) % items.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      items[next]?.focus();
    }
  };
  return (
    <nav ref={listRef} onKeyDown={onNavKeyDown} aria-label="控制台导航" className="space-y-1">
      {TAB_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            data-nav-item
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(e) => {
              // 焦点预览式移动后 Enter 已由原生 click 触发；此处保证 Space 同样激活（原生行为兜底）
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onSelect(item.id);
              }
            }}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-400",
              isActive
                ? "bg-stone-900 text-white shadow-sm dark:bg-emerald-500/15 dark:text-emerald-100 dark:ring-1 dark:ring-emerald-500/30"
                : "text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/70 dark:hover:text-stone-100"
            )}
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                isActive ? "text-emerald-300" : "text-stone-400 dark:text-stone-500"
              )}
            />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

function BrandBlock() {
  return (
    <div className="flex items-center gap-2.5 px-2 pb-6">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-stone-900 text-white dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-1 dark:ring-emerald-500/30">
        <Network className="size-4.5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">Universal AI Gateway</p>
        <p className="truncate text-xs text-muted-foreground">管理控制台</p>
      </div>
    </div>
  );
}

export function ConsoleShell({
  version,
  username,
  authVia,
  active,
  onSelect,
  onLogout,
  children,
}: {
  version: string;
  username: string;
  authVia?: "cookie" | "bearer" | null;
  active: ConsoleTab;
  onSelect: (t: ConsoleTab) => void;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const select = (t: ConsoleTab) => {
    onSelect(t);
    setMobileOpen(false);
  };

  return (
    <div className="flex min-h-screen flex-col bg-stone-50 dark:bg-stone-950">
      <div className="flex flex-1">
        {/* 桌面侧边栏 */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-stone-200 bg-white px-3 py-5 dark:border-stone-800 dark:bg-stone-900 lg:flex">
          <BrandBlock />
          <NavList active={active} onSelect={select} />
          <div className="mt-auto space-y-2 px-2 pt-4">
            <div className="space-y-1.5 rounded-lg border border-stone-200 bg-stone-50 p-2.5 dark:border-stone-800 dark:bg-stone-950/60">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-500">版本</span>
                <Badge variant="outline" className="border-stone-300 bg-white px-1.5 py-0 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
                  v{version}
                </Badge>
              </div>
              <DatabaseBadge />
              <RuntimeHealthBadge />
            </div>
            <p className="text-center text-[10px] leading-tight text-stone-400 dark:text-stone-600">
              Universal AI Gateway · 会话 12h 续期
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 顶栏 */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-stone-200 bg-white/90 px-4 backdrop-blur dark:border-stone-800 dark:bg-stone-900/90 lg:px-6">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开导航菜单">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 p-4">
                <SheetTitle className="sr-only">导航菜单</SheetTitle>
                <div className="pt-1">
                  <BrandBlock />
                  <NavList active={active} onSelect={select} />
                  <div className="mt-4 flex items-center justify-between border-t border-stone-200 pt-3 dark:border-stone-800">
                    <span className="text-xs text-muted-foreground">外观</span>
                    <ThemeToggle />
                  </div>
                </div>
              </SheetContent>
            </Sheet>

            <Badge variant="outline" className="hidden border-stone-300 bg-white font-mono text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 sm:inline-flex">
              v{version}
            </Badge>
            {/* 会话通道徽标：Cookie（常规部署）/ 令牌（iframe 嵌入环境兑底） */}
            {authVia === "bearer" ? (
              <Badge
                variant="outline"
                className="hidden border-amber-200 bg-amber-50 text-[11px] text-amber-700 md:inline-flex dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400"
                title="当前经会话令牌认证（嵌入环境 Cookie 被浏览器拦截时的兑底通道）"
              >
                令牌会话
              </Badge>
            ) : authVia === "cookie" ? (
              <Badge
                variant="outline"
                className="hidden border-emerald-200 bg-emerald-50 text-[11px] text-emerald-700 md:inline-flex dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
                title="当前经 Cookie 会话认证（HttpOnly + SameSite=Lax）"
              >
                Cookie 会话
              </Badge>
            ) : null}
            <span className="text-sm font-medium text-stone-500 dark:text-stone-400 lg:hidden">UAG 控制台</span>

            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              {/* ⌘K 命令面板触发器 —— 桌面优先，移动端仅图标 */}
              <CommandPaletteTrigger onOpen={() => setPaletteOpen(true)} />
              <span className="hidden text-sm text-muted-foreground sm:inline">
                管理员 <span className="font-medium text-stone-800 dark:text-stone-200">{username}</span>
              </span>
              <ThemeToggle />
              <Button variant="outline" size="sm" onClick={onLogout}>
                <LogOut /> <span className="hidden sm:inline">登出</span>
              </Button>
            </div>
          </header>

          <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">
            {/* v4.9.5：RSS 高水位告警横幅 —— 仅在 RSS > 2GB 时渲染，全局可见 */}
            <RssAlertBanner />
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {children}
            </motion.div>
          </main>
        </div>
      </div>

      <footer className="mt-auto border-t border-stone-200 bg-white py-4 text-center text-xs text-muted-foreground dark:border-stone-800 dark:bg-stone-900">
        Universal AI Gateway v{version} · 管理控制台 · 会话滑动续期 12 小时
      </footer>

      {/* ⌘K 全局命令面板 —— 页面导航 / 外观切换 / 运维快捷操作 */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        active={active}
        onSelectTab={select}
        onLogout={onLogout}
      />
    </div>
  );
}
