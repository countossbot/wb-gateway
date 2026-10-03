// 主题提供者 —— next-themes 封装（class 策略，跟随系统 + 手动三档切换）。
// 全局仅此一处挂载（layout.tsx）；控制台内通过 theme-toggle.tsx 切换。
"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
