import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Universal AI Gateway · 控制台",
  description:
    "通用 AI 统一网关：Anthropic ⇄ OpenAI 双向协议转译、多提供商容灾、WorkBuddy 签到与 Token 保活、SQLite 本地部署、Web 管理控制台。",
  keywords: [
    "ai-gateway",
    "universal-ai-gateway",
    "anthropic",
    "openai",
    "claude-code",
    "cc-switch",
    "workbuddy",
    "nodejs",
    "sqlite",
  ],
  authors: [{ name: "Universal AI Gateway" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Universal AI Gateway",
    description: "Anthropic ⇄ OpenAI 双向转译的多提供商 AI 网关（Node.js + SQLite）",
    siteName: "Universal AI Gateway",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
