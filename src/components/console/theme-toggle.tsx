// 主题切换按钮 —— 浅色 / 深色 / 跟随系统 三档（DropdownMenu）。
// 图标随当前主题联动（Sun / Moon / Monitor）；SSR 前渲染占位避免 hydration 抖动。
"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type ThemeOption = "light" | "dark" | "system";

const OPTIONS: Array<{ value: ThemeOption; label: string; hint: string }> = [
  { value: "light", label: "浅色", hint: "日间高对比" },
  { value: "dark", label: "深色", hint: "夜间低亮度" },
  { value: "system", label: "跟随系统", hint: "自动切换" },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  // next-themes 的 theme 值仅在客户端 hydration 后确定——挂载前渲染静态占位，
  // 避免 SSR HTML 与客户端首帧不一致导致的 React hydration 警告。
  React.useEffect(() => setMounted(true), []);

  const isDark = mounted ? resolvedTheme === "dark" : false;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label="切换主题"
          title="切换主题（浅色 / 深色 / 跟随系统）"
          className={cn("relative size-8", className)}
        >
          {/* 双图标交叉淡入淡出：挂载后按 resolvedTheme 显示其一 */}
          <Sun
            className={cn(
              "absolute size-4 transition-all duration-200",
              mounted && !isDark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-75 opacity-0"
            )}
          />
          <Moon
            className={cn(
              "absolute size-4 transition-all duration-200",
              mounted && isDark ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-75 opacity-0"
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup
          value={mounted ? (theme ?? "system") : "system"}
          onValueChange={(v) => setTheme(v as ThemeOption)}
        >
          {OPTIONS.map((opt) => (
            <DropdownMenuRadioItem key={opt.value} value={opt.value} className="gap-2">
              <span className="flex-1">
                {opt.label}
                <span className="ml-1.5 text-[10px] text-muted-foreground">{opt.hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuItem
          disabled
          className="text-[10px] text-muted-foreground"
        >
          偏好保存在浏览器本地
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
