// 设置页通用 Section 容器（v4.4.0 从 settings.tsx 抽出共享 —— pricing-section 等独立
// 设置子模块复用同一版式，避免跨文件复制漂移）。
"use client";

import * as React from "react";

export function Section({
  icon,
  title,
  description,
  children,
  actions,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          {icon && <span className="flex size-9 items-center justify-center rounded-lg bg-stone-100 text-stone-600">{icon}</span>}
          <div>
            <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
