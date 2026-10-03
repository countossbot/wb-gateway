// 快速入门引导清单（v4.9.7 新增）—— 冷启动状态的分步引导
//
// 用途：当网关处于冷启动状态（无 provider / 无 account）时，在总览页顶部显示一个
// 分步引导清单，让新用户一目了然地知道需要完成哪些步骤才能开始使用网关。
// 替代原有的「一堆 0 的 KPI 卡片」体验，转化为「引导式配置」体验。
//
// 显示条件：providers_count === 0 && accounts_total === 0（纯冷启动）
// 隐藏条件：一旦配置了 provider 或 account，清单自动消失，让位给正常仪表盘
//
// 步骤自动检测：
//   1. ✅ 部署网关（always done — 你正在看这个页面）
//   2. ⬜ 添加提供商 → 检测 providers_count > 0
//   3. ⬜ 添加账号 → 检测 accounts_total > 0
//   4. ⬜ 创建模型路由 → 检测 routes_count > 0
//   5. ⬜ 创建虚拟密钥 → 检测 hasVirtualKey（从 today_top_keys 或独立查询推断）
//   6. ⬜ 发送首个请求 → 检测 today_stats.requests > 0
"use client";

import * as React from "react";
import {
  Check,
  ChevronRight,
  KeyRound,
  Network,
  Plug,
  Route as RouteIcon,
  Rocket,
  Terminal,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type OnboardingTab = "providers" | "accounts" | "routes" | "keys";

interface OnboardingStep {
  id: string;
  icon: React.ElementType;
  title: string;
  description: string;
  done: boolean;
  /** 点击「前往」按钮导航到的 tab（null = 无导航，如最终步骤） */
  navigateTo?: OnboardingTab | null;
  /** 可选的命令示例（用于展示 curl 等操作指引） */
  command?: string;
}

export function OnboardingChecklist({
  providersCount,
  accountsTotal,
  routesCount,
  hasVirtualKey,
  hasRequestToday,
  onNavigate,
}: {
  providersCount: number;
  accountsTotal: number;
  routesCount: number;
  hasVirtualKey: boolean;
  hasRequestToday: boolean;
  onNavigate: (tab: OnboardingTab) => void;
}) {
  // 如果已有 provider 或 account，说明用户已开始配置，不再显示引导
  if (providersCount > 0 || accountsTotal > 0) {
    return null;
  }

  const steps: OnboardingStep[] = [
    {
      id: "deploy",
      icon: Rocket,
      title: "部署网关",
      description: "网关已成功部署并运行 —— 你正在看到这个控制台！",
      done: true,
      navigateTo: null,
    },
    {
      id: "provider",
      icon: Network,
      title: "添加提供商",
      description: "在「API 中转」中添加 WorkBuddy / OpenAI / Anthropic 兼容端点",
      done: providersCount > 0,
      navigateTo: "providers",
    },
    {
      id: "account",
      icon: Users,
      title: "添加账号",
      description: "在「账号管理」中为提供商添加上游账号（支持批量导入）",
      done: accountsTotal > 0,
      navigateTo: "accounts",
    },
    {
      id: "route",
      icon: RouteIcon,
      title: "创建模型路由",
      description: "在「模型路由」中定义对外模型名 → 上游模型的映射",
      done: routesCount > 0,
      navigateTo: "routes",
    },
    {
      id: "key",
      icon: KeyRound,
      title: "创建虚拟密钥",
      description: "在「虚拟密钥」中生成客户端调用密钥（支持模型白名单与配额）",
      done: hasVirtualKey,
      navigateTo: "keys",
    },
    {
      id: "request",
      icon: Terminal,
      title: "发送首个请求",
      description: "用虚拟密钥调用 /v1/chat/completions 或 /v1/messages 端点",
      done: hasRequestToday,
      navigateTo: null,
      command: 'curl -X POST http://localhost:3000/v1/chat/completions \\\n  -H "Authorization: Bearer sk-uag-xxx" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}\'',
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const totalCount = steps.length;
  const progressPercent = (doneCount / totalCount) * 100;

  return (
    <section className="overflow-hidden rounded-xl border border-stone-200 bg-gradient-to-br from-stone-50 to-white p-5 lg:p-6">
      {/* 标题区 */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-stone-900 text-white shadow-sm">
            <Plug className="size-4.5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-stone-900">快速入门</h2>
            <p className="text-xs text-muted-foreground">按以下步骤配置网关，开始使用 AI 中转服务</p>
          </div>
        </div>
        <Badge variant="outline" className="border-stone-300 bg-white px-2 py-0.5 text-[11px] tabular-nums">
          {doneCount} / {totalCount}
        </Badge>
      </div>

      {/* 进度条 */}
      <div className="mb-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* 步骤列表 */}
      <div className="space-y-2">
        {steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <div
              key={step.id}
              className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                step.done
                  ? "border-emerald-200 bg-emerald-50/50"
                  : "border-stone-200 bg-white hover:border-stone-300"
              }`}
            >
              {/* 步骤序号 / 完成图标 */}
              <div className="relative flex shrink-0">
                <div
                  className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
                    step.done
                      ? "bg-emerald-500 text-white"
                      : "bg-stone-100 text-stone-500"
                  }`}
                >
                  {step.done ? <Check className="size-3.5" /> : i + 1}
                </div>
                {/* 连接线 */}
                {i < steps.length - 1 && (
                  <div
                    className={`absolute left-1/2 top-7 h-[calc(100%-12px)] w-px -translate-x-1/2 ${
                      step.done ? "bg-emerald-200" : "bg-stone-200"
                    }`}
                  />
                )}
              </div>

              {/* 步骤内容 */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Icon className={`size-3.5 ${step.done ? "text-emerald-600" : "text-stone-400"}`} />
                  <span className={`text-xs font-semibold ${step.done ? "text-emerald-800" : "text-stone-700"}`}>
                    {step.title}
                  </span>
                  {step.done && (
                    <Badge variant="outline" className="border-emerald-200 bg-emerald-50 px-1 py-0 text-[9px] text-emerald-600">
                      完成
                    </Badge>
                  )}
                </div>
                <p className={`mt-0.5 text-[11px] leading-relaxed ${step.done ? "text-emerald-600/80" : "text-muted-foreground"}`}>
                  {step.description}
                </p>
                {/* 命令示例（仅最终步骤且未完成时显示） */}
                {step.command && !step.done && (
                  <pre className="mt-2 overflow-x-auto rounded-md border border-stone-200 bg-stone-900 p-2 text-[10px] leading-relaxed text-stone-100">
                    <code>{step.command}</code>
                  </pre>
                )}
              </div>

              {/* 导航按钮 */}
              {step.navigateTo && !step.done && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 border-stone-300 text-[11px]"
                  onClick={() => step.navigateTo && onNavigate(step.navigateTo)}
                >
                  前往
                  <ChevronRight className="size-3" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部提示 */}
      <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50/80 p-2.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-stone-600">💡 提示：</span>
        默认路由已自动回填常见模型（deepseek-v4.1-flash / claude-3-7-sonnet / glm-5.2 等），
        添加提供商与账号后即可直接调用。
      </div>
    </section>
  );
}
