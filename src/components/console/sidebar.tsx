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

function NavList({
  active,
  onSelect,
}: {
  active: ConsoleTab;
  onSelect: (t: ConsoleTab) => void;
}) {
  return (
    <nav aria-label="控制台导航" className="space-y-1">
      {TAB_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-stone-900 text-white shadow-sm"
                : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
            )}
          >
            <Icon className={cn("size-4 shrink-0", isActive ? "text-emerald-300" : "text-stone-400")} />
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
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-stone-900 text-white">
        <Network className="size-4.5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-stone-900">Universal AI Gateway</p>
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

  const select = (t: ConsoleTab) => {
    onSelect(t);
    setMobileOpen(false);
  };

  return (
    <div className="flex min-h-screen flex-col bg-stone-50">
      <div className="flex flex-1">
        {/* 桌面侧边栏 */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-stone-200 bg-white px-3 py-5 lg:flex">
          <BrandBlock />
          <NavList active={active} onSelect={select} />
          <div className="mt-auto px-2 pt-4">
            <p className="text-[11px] text-muted-foreground">
              Universal AI Gateway
              <br />
              本地部署 · SQLite
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 顶栏 */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-stone-200 bg-white/90 px-4 backdrop-blur lg:px-6">
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
                </div>
              </SheetContent>
            </Sheet>

            <Badge variant="outline" className="hidden border-stone-300 bg-white font-mono text-xs text-stone-600 sm:inline-flex">
              v{version}
            </Badge>
            {/* 会话通道徽标：Cookie（常规部署）/ 令牌（iframe 嵌入环境兑底） */}
            {authVia === "bearer" ? (
              <Badge
                variant="outline"
                className="hidden border-amber-200 bg-amber-50 text-[11px] text-amber-700 md:inline-flex"
                title="当前经会话令牌认证（嵌入环境 Cookie 被浏览器拦截时的兑底通道）"
              >
                令牌会话
              </Badge>
            ) : authVia === "cookie" ? (
              <Badge
                variant="outline"
                className="hidden border-emerald-200 bg-emerald-50 text-[11px] text-emerald-700 md:inline-flex"
                title="当前经 Cookie 会话认证（HttpOnly + SameSite=Lax）"
              >
                Cookie 会话
              </Badge>
            ) : null}
            <span className="text-sm font-medium text-stone-500 lg:hidden">UAG 控制台</span>

            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <span className="hidden text-sm text-muted-foreground sm:inline">
                管理员 <span className="font-medium text-stone-800">{username}</span>
              </span>
              <Button variant="outline" size="sm" onClick={onLogout}>
                <LogOut /> <span className="hidden sm:inline">登出</span>
              </Button>
            </div>
          </header>

          <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">
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

      <footer className="mt-auto border-t border-stone-200 bg-white py-4 text-center text-xs text-muted-foreground">
        Universal AI Gateway v{version} · 管理控制台 · 会话滑动续期 12 小时
      </footer>
    </div>
  );
}
