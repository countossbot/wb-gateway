// 全局命令面板（⌘K / Ctrl+K）—— 快速页面跳转 + 外观切换 + 运维快捷操作。
// 纯客户端增量能力：不触碰任何后端与数据流；导航复用 ConsoleShell 的 onSelect 管道。
"use client";

import * as React from "react";
import {
  Activity,
  ExternalLink,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Sun,
  Zap,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { TAB_ITEMS, type ConsoleTab } from "@/components/console/sidebar";

const TAB_HOTKEYS: Record<ConsoleTab, string> = {
  overview: "⌘1",
  accounts: "⌘2",
  providers: "⌘3",
  keys: "⌘4",
  routes: "⌘5",
  jobs: "⌘6",
  logs: "⌘7",
  settings: "⌘8",
};

const THEME_META: Array<{ value: "light" | "dark" | "system"; label: string; icon: React.ElementType }> = [
  { value: "light", label: "浅色主题", icon: Sun },
  { value: "dark", label: "深色主题", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

export function CommandPalette({
  open,
  onOpenChange,
  active,
  onSelectTab,
  onLogout,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  active: ConsoleTab;
  onSelectTab: (t: ConsoleTab) => void;
  onLogout: () => void;
}) {
  const { setTheme } = useTheme();

  const run = React.useCallback(
    (fn: () => void) => {
      onOpenChange(false);
      // 等面板关闭动画完成再执行跳转，避免布局跳动被面板遮挡
      window.setTimeout(fn, 80);
    },
    [onOpenChange]
  );

  // ⌘K / Ctrl+K 全局开关 + ⌘1..8 直达页面（面板打开时）
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (e.key.toLowerCase() === "k" && meta) {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (open && meta && /^[1-8]$/.test(e.key)) {
        e.preventDefault();
        const idx = Number(e.key) - 1;
        const target = TAB_ITEMS[idx];
        if (target) run(() => onSelectTab(target.id));
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange, onSelectTab, run]);

  const jump = (id: ConsoleTab) => run(() => onSelectTab(id));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="搜索页面或操作…（如：日志 / 主题 / 状态）" />
      <CommandList className="max-h-[360px]">
        <CommandEmpty>没有匹配的结果</CommandEmpty>

        <CommandGroup heading="页面导航">
          {TAB_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.id}
                value={`${item.label} ${item.id}`}
                onSelect={() => jump(item.id)}
                className="gap-2.5"
              >
                <Icon className="size-4 text-muted-foreground" />
                <span className="flex-1">{item.label}</span>
                {active === item.id && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    当前
                  </span>
                )}
                <CommandShortcut className="font-mono">{TAB_HOTKEYS[item.id]}</CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="外观">
          {THEME_META.map(({ value, label, icon: Icon }) => (
            <CommandItem key={value} value={`主题 ${label} theme ${value}`} onSelect={() => run(() => setTheme(value))}>
              <Icon className="size-4 text-muted-foreground" />
              切换为「{label}」
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="运维快捷操作">
          <CommandItem
            value="测试提供商连通性 连通 测试 providers 上游"
            onSelect={() =>
              run(() => {
                try {
                  sessionStorage.setItem("uag:pending-test-all", "1");
                } catch {
                  /* 无痕模式下降级为纯事件通道 */
                }
                onSelectTab("providers");
                window.dispatchEvent(new CustomEvent("uag:run-provider-test-all"));
              })
            }
          >
            <Activity className="size-4 text-muted-foreground" />
            测试提供商连通性（全部实测）
          </CommandItem>
          <CommandItem
            value="测试模型路由 全部测试 路由连通 routes 快测"
            onSelect={() =>
              run(() => {
                try {
                  sessionStorage.setItem("uag:pending-route-test-all", "1");
                } catch {
                  /* 无痕模式下降级为纯事件通道 */
                }
                onSelectTab("routes");
                window.dispatchEvent(new CustomEvent("uag:run-route-test-all"));
              })
            }
          >
            <Zap className="size-4 text-muted-foreground" />
            测试模型路由（全部快测）
          </CommandItem>
          <CommandItem
            value="网关状态 status json"
            onSelect={() => run(() => window.open("/status", "_blank", "noopener"))}
          >
            <Activity className="size-4 text-muted-foreground" />
            查看网关状态（/status）
            <CommandShortcut>
              <ExternalLink className="size-3" />
            </CommandShortcut>
          </CommandItem>
          <CommandItem
            value="存活探针 healthz 健康"
            onSelect={() => run(() => window.open("/healthz", "_blank", "noopener"))}
          >
            <Zap className="size-4 text-muted-foreground" />
            存活探针（/healthz）
            <CommandShortcut>
              <ExternalLink className="size-3" />
            </CommandShortcut>
          </CommandItem>
          <CommandItem value="退出登录 登出 logout" onSelect={() => run(onLogout)}>
            <LogOut className="size-4 text-destructive" />
            <span className="text-destructive">退出登录</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>

      {/* 底部操作提示条 —— 面板自身的可用性细节 */}
      <div className="flex items-center gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↑</kbd>
          <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↓</kbd>
          导航
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↵</kbd>
          选择
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">esc</kbd>
          关闭
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">⌘</kbd>
          <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">1-8</kbd>
          直达页面
        </span>
      </div>
    </CommandDialog>
  );
}

/** 「PaletteIcon + ⌘K」触发按钮 —— 顶栏内使用（外观与版本徽标一致的描边风格）。 */
export function CommandPaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="打开命令面板（⌘K）"
      title="命令面板（⌘K）— 快速跳转页面与操作"
      className="inline-flex h-8 items-center gap-2 rounded-lg border border-stone-200 bg-white px-2.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
    >
      <Palette className="size-3.5" />
      <span className="hidden md:inline">快速跳转…</span>
      <kbd className="rounded border border-stone-200 bg-stone-50 px-1 font-mono text-[10px] dark:border-stone-700 dark:bg-stone-800">
        ⌘K
      </kbd>
    </button>
  );
}
