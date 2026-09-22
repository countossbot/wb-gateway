# Universal-AI-Gateway 修复方法提示词集

> 来源：Task 57–60（v4.7.1 → v4.7.3）实战修复记录，2026-09-22 全矩阵实测验证。
> 用法：整段复制给 AI 编程助手（Z.ai Code / Claude Code 等）即可复现修复；占位符按项目实际情况替换。

---

## 提示词 1：WorkBuddy/CodeBuddy 上游模型目录拉取（CN + INTL 双区通用）

```text
【任务】在我的 AI 网关项目中实现「模型路由配置时自动拉取上游真实模型目录」。上游是腾讯 CodeBuddy/WorkBuddy（CN 与 INTL 两个 region，账户凭证为 CLI 刷新通道换取的 accessToken）。请严格按以下已实测验证的接口结论实现，不要自行猜测端点。

【接口结论（2026-09 实测矩阵验证，直接照用）】
1. 正确端点（/v2 CLI 通道，两区统一路径）：
   - CN：GET https://www.codebuddy.cn/v2/enterprises/personal/models
     （www.workbuddy.cn / copilot.tencent.com 三个 host 等价全通）
   - INTL：GET https://www.codebuddy.ai/v2/enterprises/personal/models
     （www.workbuddy.ai 等价）
2. ⚠️ 最大的坑：不要用 /console/enterprises/personal/models。
   该 /console 前缀是网页 cookie 会话专用路径。CLI Bearer 调 CN 的 /console 也会 200
   （纯属巧合，两端同源部署），但调 INTL 一律 500（响应头 X-APISIX-Upstream-Status: 500，
   是上游服务自身错误，不是网关/鉴权问题）。实测过 4 账户 × 2 host × 全头组合
   （x-user-id、accept: application/json、HTTP2 精确复刻网页 HAR 全头集、repos[] 参数、
   尾斜杠变体、全新刷新的 accessToken）全部 500；而同一批凭证调同域
   /console/enterprises 与 /console/accounts 均 200 —— 排除凭证与网络问题，
   实锤是路径鉴权面不同：CLI 凭证必须走 /v2 通道（与 /v2/chat、/v2/billing 同族）。
3. 请求头（与 /v2 家族兼容，实测两区均 200）：
   - Authorization: Bearer <accessToken>
   - X-Client-Platform: web
   - Accept: application/json, text/plain, */*
   - User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36
   - 超时 8 秒
4. 401 处理：用 refreshAccessToken 无感续签后重试一轮；仍失败换下一账户。

【响应结构与解析规则】
响应体形如：
{
  "code": 0,
  "data": {
    "models": [
      { "id": "hy3", "name": "Hunyuan 3", "credits": "x0.00 credits",
        "maxInputTokens": 192000, "maxOutputTokens": 64000,
        "supportsImages": true, "supportsReasoning": true,
        "supportsToolCall": true, "isDefault": false, "vendor": "tencent" }
    ],
    "agents": [
      { "name": "cli", "models": ["auto", "hy3", "hy4-preview", "..."] },
      { "name": "web", "models": ["..."] }
    ]
  }
}
解析规则：
- code 非 0 → 业务错误，直接抛（附 msg）
- CLI/网关可用模型 = data.agents 中 name === "cli" 的 models 白名单 ∩ data.models
  （按白名单顺序过滤、只保留能对上的；白名单为空 → 回退全量 models）
- 模型匹配键是 id（kebab-case 机器名），name 仅做展示名
- credits 即计费倍率："x0.29" → 0.29 倍；"x0.00 credits" → 免费模型；null → 无固定倍率
- 元数据逐模型映射透传：credits / maxInputTokens / maxOutputTokens /
  supportsImages / supportsReasoning / supportsToolCall / isDefault

【工程实现要求】
- 多账户容灾：逐账户尝试（上限 3 个），任一成功即返回；全部失败抛最后一个错误
- 60 秒内存缓存（实测首拉约 300ms，缓存命中约 10ms），支持 force 强刷
- 失败降级：回退静态/推导目录，并把失败原因（HTTP 状态、业务错误文案）透传前端透明展示
- 返回结构：{ models: string[] 有序白名单, details: 元数据数组一一对应, url, allCount: 全量目录数 }

【TypeScript 参考实现】
async listUpstreamModels(): Promise<UpstreamModelsResult> {
  const ep = this.ep();
  const accounts = this.getAccounts().slice(0, 3);
  if (accounts.length === 0) throw new Error("无可用账户（请先配置账户凭证）");
  let lastErr = "未知错误";
  for (const acc of accounts) {
    let token = await this.getActiveToken(acc);
    for (let attempt = 0; attempt < 2; attempt++) {   // 首轮现 token；401 续签后二轮
      if (!token) { lastErr = `账户 ${acc.name || acc.id} 无 accessToken`; break; }
      try {
        const resp = await fetch(ep.models, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Client-Platform": "web",
            Accept: "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 ... Chrome/128.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (resp.status === 401 && attempt === 0) {
          token = (await this.refreshAccessToken(acc)) || ""; continue;  // 无感续签重试
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}${resp.status === 500 ? "（上游服务错误）" : ""}`);
        const resJson = await resp.json().catch(() => ({}));
        if (typeof resJson.code === "number" && resJson.code !== 0)
          throw new Error(`业务错误 code=${resJson.code} ${resJson.msg || ""}`.trim());
        const all = (resJson.data?.models ?? []).filter((m) => typeof m?.id === "string" && m.id);
        if (all.length === 0) throw new Error("上游响应无模型数据");
        const byId = new Map(all.map((m) => [m.id, m]));
        const allow = (resJson.data?.agents ?? []).find((a) => a?.name === "cli")?.models ?? [];
        const ids = allow.length > 0 ? allow.filter((id) => byId.has(id)) : all.map((m) => m.id); // 有序过滤+回退
        const details = ids.map((id) => { const m = byId.get(id); return {
          id, name: m?.name ?? null, credits: m?.credits ?? null,
          maxInputTokens: m?.maxInputTokens ?? null, maxOutputTokens: m?.maxOutputTokens ?? null,
          supportsImages: !!m?.supportsImages, supportsReasoning: !!m?.supportsReasoning,
          supportsToolCall: !!m?.supportsToolCall, isDefault: !!m?.isDefault,
        };});
        return { models: ids, details, url: ep.models, allCount: all.length };
      } catch (e) { lastErr = e instanceof Error ? e.message : String(e); break; } // 换下一账户
    }
  }
  throw new Error(lastErr);
}

【验收标准】
- CN：source=upstream，16 个 CLI 可用模型，allCount=30（含 auto 默认/hy3 免费 ×0.00/hy4-preview ×0.29/deepseek-v4.1-flash ×0.03 等）
- INTL：source=upstream，18 个模型（含 GPT-5.6-Sol ×3.47/GPT-5.6-Terra ×1.39/GPT-5.6-Luna ×0.14、GPT-5.5/5.4/5.3-Codex、Gemini-3.5-Flash、5 个槽位模型 default-model/fast-model/balanced-model/primary-model/deep-model、hy3/hy4-preview 免费）
- 无账户凭证：明确报错并降级静态目录
```

---

## 提示词 2：上游同构端点「一区通、一区 500」排查方法论

```text
【场景】上游服务的同构 REST 端点在 A 区域 200、B 区域 500（响应头 X-APISIX-Upstream-Status: 500），凭证、网络、请求头都反复排查过仍无解。请按以下五步方法论排查（该流程在 WorkBuddy INTL 模型目录 500 问题中实战验证，最终定位出隐藏的正确端点 /v2/enterprises/personal/models）。

【五步法】
1. 对照实验定边界：用同一凭证打同域的其它端点（账户信息、企业信息等）。
   若均 200 → 排除凭证/网络/出口 IP 问题，锁定「该路径的鉴权面（auth plane）不同」，
   问题在路径族，而不是请求没复刻够。
2. HAR 抓包对照：请在能成功的客户端（网页端/CLI）抓 HAR（Chrome DevTools → Network
   面板 → 右键 → Save all as HAR with content），对比成功与失败请求的三要素：
   - 路径前缀差异（本案例：网页走 /console/*，CLI 走 /v2/*）
   - 鉴权方式差异（网页 cookie 会话 vs CLI Bearer）
   - 请求头全集（注意 HAR 导出会清洗 Authorization/Cookie，需结合 x-user-id 等痕迹确认会话归属）
3. JS bundle 逆向枚举端点：拉取前端页面 main bundle（React SPA 通常 5–10MB），
   在其中全文搜索 API 路径关键字（如 "enterprises"、"models"、"/v2/"），
   枚举出该服务暴露的全部 API 家族 —— 本案例由此发现 /v2/enterprises/* 隐藏端点族
   （与 /v2/chat、/v2/billing 同族 = CLI 通道专用）。
   注意：网页前端代码里只会出现网页自己用的路径，CLI 通道端点要在 CLI 安装包/产物里找。
4. 全矩阵实测：账户（多账户）× host（域名变体）× 头组合（x-user-id / accept /
   HTTP2 精确复刻 / referer / origin / 参数变体）逐格打并记录。若 500 在所有格子稳定复现
   → 与请求形态无关，是服务端对「该路径 + 该凭证类型」的固有行为，停止调头，回去换路径。
5. 结论验证：新端点响应与已知成功响应逐字段 diff（最好 byte 级一致），
   再多账户 × 多 host 复测确认；把结论写进代码注释防回归。

【本案例结论模板（可直接类比）】
- /console/* 前缀 = 网页 cookie 会话专用；/v2/* 前缀 = CLI Bearer 通道
- A 区两路都通是巧合（前后端同源部署、网关未区分），B 区严格区分
- 「同构端点一区通一区 500」优先怀疑路径族不对，而不是请求头没复刻够
```

---

## 提示词 3：Dialog 内 Select 下拉弹层溢出卡片修复（Radix collisionBoundary）

```text
【bug 现象】shadcn/ui（Radix）的 Select 放在 Dialog 弹窗卡片内使用，选项一多（16–18 项，弹层高约 440px）且触发器位于卡片下部时，弹层向上翻转直接冲出卡片顶部边界 200px+，视觉上悬浮到卡片外/页面外。

【根因】Radix SelectContent 默认 collisionBoundary 是浏览器视口（viewport），不是它所在的 Dialog 卡片。只要视口内放得下，Radix 就按视口做防碰撞翻转，完全不感知 Dialog 的 DOM 边界。

【修复三件套（照抄即可）】
1. collisionBoundary 指向所在 Dialog 元素：
   - SelectTrigger 挂 ref（React 19 直接 ref-as-prop，无需 forwardRef）
   - Select 的 onOpenChange 在展开时捕获对话框元素存入 state：
     if (open) setMenuBoundary(triggerRef.current?.closest("[role=dialog]") as HTMLDivElement | null ?? null);
   - 收起时不重置 state（保持引用稳定，避免重渲染丢边界）
   - SelectContent 传 collisionBoundary={menuBoundary ?? undefined}
2. SelectContent 加 collisionPadding={8}（弹层与碰撞边界留 8px 间距）
3. SelectContent 加内联样式：
   style={{ maxHeight: "min(18rem, var(--radix-select-content-available-height))" }}
   —— 内联 style 优先级高于组件库默认 max-height，双保险；
   --radix-select-content-available-height 是 Radix 注入的 CSS 变量（碰撞边界内的可用高度），
   长目录在弹层内部滚动。

【代码模板】
const triggerRef = React.useRef<HTMLButtonElement>(null);
const [menuBoundary, setMenuBoundary] = React.useState<HTMLDivElement | null>(null);

<Select
  value={value}
  onValueChange={setValue}
  onOpenChange={(open) => {
    // 展开时捕获所在 Dialog 元素作为弹层碰撞边界（收起不重置，保持引用稳定）
    if (open) setMenuBoundary(triggerRef.current?.closest("[role=dialog]") as HTMLDivElement | null ?? null);
  }}
>
  <SelectTrigger ref={triggerRef} size="sm"><SelectValue placeholder="选择模型" /></SelectTrigger>
  <SelectContent
    collisionBoundary={menuBoundary ?? undefined}
    collisionPadding={8}
    style={{ maxHeight: "min(18rem, var(--radix-select-content-available-height))" }}
  >
    {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
  </SelectContent>
</Select>

【验收标准】
- 桌面 1280×800：弹层上下边均在 Dialog 卡片边界内（测量 popup 与卡片 rect 无交叠越界）
- 移动端 390×700：垂直水平均不超出卡片，高度约 288px 封顶
- 长列表（16+ 项）弹层内部出现滚动条，不冲出卡片
```

---

## 提示词 4：模型下拉项展示精简（仅保留模型名 + 倍率徽章）

```text
【需求】模型下拉项从富展示（模型名 + 倍率 + 上下文徽章 + 能力徽章 + 默认徽章）精简为只显示「模型名 + 倍率徽章」。要求：API 层元数据仍完整透传（details 字段契约不变），仅前端展示层精简；下拉 placeholder 也不带「CLI 可用 x」之类的数量后缀。

【展示规则】
1. 下拉项 = 模型 ID（等宽字体 code）+ 倍率徽章，仅此两样：
   - credits === "x0.00 credits"（数值为 0）→ 绿色「免费」徽章（bg-emerald-50 text-emerald-700）
   - credits === "x0.29" → 灰色「×0.29」徽章（text-stone-500）
   - credits 为 null/undefined → 不显示徽章
2. placeholder 文案三态（不带 CLI 可用数量后缀）：
   - 上游实时拉取成功：「选择模型（上游实时 · N 个）」
   - 拉取失败降级目录：「选择模型（已知目录 · N 个）」
   - 朴素目录：「选择模型（N 个）」
3. 选中后 trigger 回显同步精简（如「gpt-5.6-luna ×0.14」，不带上下文/能力标注）
4. 删除仅为徽章服务的辅助函数（如 token 数格式化 1000000→1M 的 compactTokens）
5. details 数据结构字段全部保留（契约向后兼容，元数据完整透传，仅展示精简）

【倍率解析函数（照抄）】
function creditsBadgeLabel(credits: string | null | undefined): { text: string; tone: "free" | "normal" } | null {
  if (!credits) return null;
  const v = credits.replace(/\s*credits$/i, "").trim();
  if (!v) return null;
  if (/^x?0(?:\.0+)?$/i.test(v.replace("x", ""))) return { text: "免费", tone: "free" };
  return { text: v.startsWith("x") ? `×${v.slice(1)}` : `×${v}`, tone: "normal" };
}

【下拉项渲染模板】
{modelOptions.map((m) => {
  const det = detailMap.get(m);                    // id → 元数据 Map
  const cred = creditsBadgeLabel(det?.credits);
  return (
    <SelectItem key={m} value={m}>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <code className="truncate font-mono text-xs">{m}</code>
        {cred ? (
          <Badge variant="secondary"
            className={`h-4 shrink-0 px-1 text-[9px] ${cred.tone === "free" ? "bg-emerald-50 text-emerald-700" : "text-stone-500"}`}>
            {cred.text}
          </Badge>
        ) : null}
      </span>
    </SelectItem>
  );
})}

【验收标准】
- CN 下拉示例：auto（无徽章）/ hy4-preview ×0.29 / hy3 免费 / deepseek-v4.1-flash ×0.03 —— 无上下文（1M/128k）、无能力（图像·推理）、无「默认」标注
- INTL 下拉示例：default-model ×0.79 / gpt-5.6-sol ×3.47 / gpt-5.6-luna ×0.14 / hy3 免费
- API 响应 details 字段仍含 maxInputTokens/supportsImages 等全量元数据（展示精简 ≠ 数据裁剪）
```

---

## 附：三批修复对应的版本与文件（本项目内溯源）

| 批次 | 版本 | 修复内容 | 主要文件 |
|---|---|---|---|
| Task 58 | v4.7.1 | CN 模型目录接入（当时走 /console，INTL 降级 derived） | providers/workbuddy/index.ts、api/console/providers/models/route.ts、routes.tsx |
| Task 59 | v4.7.2 | INTL 打通（/console→/v2 CLI 通道）+ placeholder 精简 + 弹层溢出修复 | 同上 |
| Task 60 | v4.7.3 | 下拉项精简（去上下文/能力/默认标注，仅名称+倍率） | routes.tsx |
