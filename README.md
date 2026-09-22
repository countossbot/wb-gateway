# ⚡ Universal-AI-Gateway（Node.js 重构版 v3.0）

<div align="center">

**通用全功能 AI 统一网关 —— 纯 Node.js 本地部署 + SQLite + Web 管理控制台**

[![Node](https://img.shields.io/badge/Node-%3E%3D22.5-339933?logo=node.js&logoColor=white)]()
[![Storage](https://img.shields.io/badge/Storage-SQLite-003B57?logo=sqlite&logoColor=white)]()
[![Protocol](https://img.shields.io/badge/Protocol-Anthropic%20%7C%20OpenAI-059669.svg)]()
[![Port](https://img.shields.io/badge/Port-18787-D97706.svg)]()

</div>

> 本仓库是 [Ericsunsk/Universal-AI-Gateway](https://github.com/Ericsunsk/Universal-AI-Gateway) v2.4.0 的彻底重构：
> 架构、目录、数据层、运行时全部重写为**纯 Node.js 常驻进程**（原 Cloudflare Workers + Vercel 双引擎），
> 配置与状态存储由云 KV 迁移为**本地 SQLite 单文件**，并新增自带 **Web 管理控制台**。
> 原项目的全部业务能力（协议转译、路由容灾、5 类上游提供商、鉴权、运维自动化）等价保留，对外 API 契约不变。
>
> 📘 **从零搭建操作手册**：[`docs/搭建指南.md`](docs/搭建指南.md) —— 安装 → WorkBuddy 凭证导入（原生识别 wb-switch-accounts 导出格式，自动按域名分组 CN/INTL）→ 路由 → 客户端接入 → 验证 → 运维，含 7 账号全链路实测记录。

---

## 📖 目录

- [核心能力](#-核心能力)
- [快速开始](#-快速开始)
- [Web 控制台](#-web-控制台)
- [客户端接入](#-客户端接入指南)
- [对外 API 契约](#-端点总览-api-reference)
- [全局代理](#-全局代理)
- [安全模型](#-安全模型)
- [数据存储与备份](#-数据存储)
- [从 v2.4.0 迁移](#-从-cloudflare-kv-迁移)
- [常驻部署](#-常驻部署)
- [架构变更说明](#-架构变更说明原-v240---v300)
- [FAQ](#-常见问题-faq)

---

## ✨ 核心能力

| 能力 | 说明 |
| :--- | :--- |
| **双向协议转译** | `/v1/messages`（Anthropic）⇄ `/v1/chat/completions`（OpenAI）全双工转译；流式 SSE（thinking 思维链块、tool_use / tool_result、ping 心跳保活）与非流式共享同一套 extractors，两条路径零分叉 |
| **请求侧净化** | 客户端指纹脱敏（规避腾讯 11128 拦截）、消息序列归一（修复 tool_calls 顺序，规避 11148）、推理强度解析（模型名后缀 `[high]` / Anthropic thinking / `reasoning_effort` / 通用 reasoning 四源统一） |
| **路由与容灾** | 模型名 → 有序候选列表路由表；候选级自动故障转移；多账号池轮换；**会话粘性**（同一会话固定账号，保住上游前缀缓存）；账号级指数退避冷却（1→2→4→8 分钟封顶，**SQLite 持久化，重启不丢**）；错误三分类（冷却 / 重试 / 致命）与风控挑战页识别 |
| **上游提供商** | WorkBuddy 腾讯云代码助手（国内站 + 国际站双 region）、OpenCode Zen（免费模型池 + 健康度追踪 + Responses 适配 + 工具提示词降级）、OpenAI 兼容（OpenRouter / DeepSeek / 硅基流动）、Anthropic 兼容、Qwen 网页版（反爬身份 mint + 单并发门）。**新增提供商 = 新目录 + 一行注册** |
| **鉴权体系** | 多把虚拟密钥（模型白名单 / 启停 / 角色）、管理主密钥、定时任务专用密钥（降权语义）、常量时间比较（抗时序攻击） |
| **运维自动化** | AccessToken 401 无感续签（写回 SQLite）、每日定时签到、余额并发聚合、上游前缀缓存命中统计 |
| **上下文控制** | 最大上下文轮数截断（可设 0 = 不限）+ RTK 工具输出净化（ANSI 清洗 / 测试折叠 / 渐进退火） |
| **流式零缓冲** | `x-accel-buffering: no` + `Cache-Control: no-cache no-transform` + 每块即时下发，首字延迟不退化 |
| **Web 控制台** | 登录 / 初始化引导 / 总览 / 账号管理（导入导出闭环）/ API 中转 / 虚拟密钥 / 模型路由（拖拽排序）/ 定时任务 / 运行日志 / 设置（代理 / 备份 / KV 迁移） |
| **全局代理** | http / https / socks5 / socks5h（远程 DNS）；代理池限流自动轮换；提供商级覆盖与绕过列表；热生效；出口 IP 实测 |

---

## 🚀 快速开始

### 环境要求

- **Node.js ≥ 22.5**（未使用任何需要本地编译的原生模块；`better-sqlite3` 之类被刻意回避——若你使用本文档之外的自定义安装流程且 npmrc 配置了 `ignore-scripts`，原生模块会静默安装失败，本项目的 Prisma + SQLite 方案不受影响）
- 包管理器：**pnpm**（本仓库提交 `pnpm-lock.yaml`；npm / yarn / bun 亦可，但请勿混用锁文件）

### 安装与启动

```bash
# 1. 安装依赖
pnpm install

# 2. 生成 Prisma Client 并初始化 SQLite（首次）
pnpm run db:generate && pnpm run db:push

# 3. 生产模式启动（默认端口 18787）
pnpm run build && pnpm start

# 或开发模式（热重载，默认同样监听 18787）
pnpm run dev
```

启动后访问 **http://127.0.0.1:18787**：

1. **首次启动**（数据库无管理员）→ 自动进入**初始化引导页**：设置管理员密码、（可选）配置首个上游提供商；完成后一次性展示生成的 `master_key` / `cron_secret` / 默认客户端密钥（强随机生成，请立即保存）。
2. 之后访问即为**登录页**。不存在「有登录页但无人可登录」的状态。

> **端口被占用时**：进程会启动失败并明确报错（`EADDRINUSE`）。可通过环境变量 `PORT` 改端口：`PORT=18788 pnpm start`。控制台前端与网关 API 始终**同端口同进程**（单端口架构，无前后端分离部署）。

### 启动自检

进程启动时（instrumentation 钩子）自动执行：

- ✅ SQLite 数据库可写（`SELECT 1` + 密钥初始化写入）
- ✅ 定时任务调度器启动（签到 + Token 保活）
- ✅ `master_key` / `cron_secret` 存在性检查（缺失则生成强随机值——**拒绝硬编码兜底**）

可通过 `curl http://127.0.0.1:18787/healthz` 验证（零 provider / 零路由时返回 `503 degraded`，而非永远 ok）。

---

## 🖥️ Web 控制台

单页应用（`/` 路径），包含 8 大模块：

| 模块 | 能力 |
| :--- | :--- |
| **账户总览** | 聚合余额与积分、账号总数与启用数、提供商数量、路由数量、上游前缀缓存命中率、最近签到 / 最近 Token 刷新时间、可用模型列表 |
| **账号管理** | 按提供商分组列表；增删改、启停；**批量导入**（粘贴文本 / 上传文件，JSON 为主 + CSV，逐行校验，返回成功 / 跳过 / 失败数量与逐行原因，冲突策略可选跳过 / 覆盖 / 生成新 ID）；**导出**（完整导出含凭据可再导入，需二次确认；脱敏导出隐藏凭据用于分享，且被系统识别并拒绝作为导入源） |
| **API 中转管理** | 已配置中转卡片网格；新增 / 编辑弹出**配置悬浮窗**，按提供商类型渲染不同字段（WorkBuddy 双 region 与账号池 / OpenAI 兼容含附加请求头 / Anthropic / OpenCode Zen / Qwen 网页版）；**保存前可测试连通性**，回显余额或可用模型 |
| **虚拟密钥** | 增删改查、启停、备注、按密钥配置模型白名单；密钥值仅创建时一次性展示，此后掩码显示 |
| **模型路由** | 模型名 → 有序候选列表的增删改；候选可增删、**拖拽排序**、启停 |
| **定时任务** | 签到与 Token 保活的开关、cron 执行时间、时区配置；上次执行结果与逐账号明细；手动立即执行 |
| **运行日志** | 时间、模型、命中的提供商与账号、耗时、状态码、Token 用量（in / out / cached）、失败与冷却记录；按模型筛选与分页 |
| **设置** | 全局代理（协议 / 池 / 绕过列表 / **出口 IP 实测按钮**）、管理员密码修改（改密后全部会话失效）、CORS 白名单、上下文轮数、密钥再生成、**数据备份一键导出**、**KV 迁移工具** |

**敏感字段契约**（代码与实现中显式体现）：界面只显示掩码（如 `sk-1••••abcd（已隐藏，共 32 位）`）；保存时若该字段未被改动，服务端必须用数据库中的原值回填——**绝不允许一次保存把凭据清空**。虚拟密钥的密钥名同样掩码显示并在保存时正确还原。该契约集中在 `src/lib/gateway/config/configService.ts`（`mergeSecrets` / `restoreVirtualKeys`）与 `src/lib/gateway/console/consoleHelpers.ts`（`mergeCredentialsOnSave`）。

---

## 🔌 客户端接入指南

### Claude Code

```bash
# 设置环境变量指向本机网关
export ANTHROPIC_BASE_URL=http://127.0.0.1:18787
export ANTHROPIC_API_KEY=sk-uag-xxxxxxxx        # 控制台「虚拟密钥」创建的密钥

claude
```

模型名走网关路由表（如 `claude-3-5-sonnet-20241022` 映射到 DeepSeek / 免费池候选链）；推理强度可用模型名后缀（`claude-3-7-sonnet-20250219[high]`）或原生 `thinking` 配置。

### CC-Switch

- **Base URL**：`http://127.0.0.1:18787`
- **API Key**：虚拟密钥
- **余额卡片**：CC-Switch 依赖 `/v1/usage` 的 `{code:0, data:{balance,total,unit}}` 响应结构（本网关原样保留）：

```bash
curl -H "Authorization: Bearer sk-uag-xxx" http://127.0.0.1:18787/v1/usage
# {"code":0,"data":{"balance":1234.5,"total":5000,"unit":"积分"}}
```

### Cursor / OpenAI 生态客户端（NextChat 等）

- **API Base**：`http://127.0.0.1:18787/v1`
- **API Key**：虚拟密钥
- 兼容 OpenAI Chat Completions 协议与 `/v1/models` 模型目录

> **非 HTTPS 地址被客户端拒绝时**：部分客户端（如某些网页版）拒绝 `http://` 端点。解决办法：
> 1. 本机回环地址多数客户端默认放行（`127.0.0.1` / `localhost`），优先使用；
> 2. 局域网访问时在前面加一层 Caddy / nginx 做 TLS 终结（`example.com { reverse_proxy 127.0.0.1:18787 }`）；
> 3. 网页客户端跨域：默认同源策略不回 CORS 头，需在「设置 → CORS 白名单」显式加入客户端 Origin（最小必要配置）。

### 自动化脚本 / AI 智能体（Agent-Native）

`/admin` 返回自解释 JSON 规范页，`/admin/api/*` 支持配置读写、状态查询、签到、刷新令牌——原 v2.4.0 的自动化调用方式**完全不变**：

```bash
# 读取配置（机密字段自动脱敏）
curl -H "Authorization: Bearer <MASTER_KEY>" http://127.0.0.1:18787/admin/api/config

# 写入配置（省略/掩码的机密字段自动用 DB 原值回填；config_version 乐观锁，冲突返回 409；校验失败返回 400）
curl -X POST -H "Authorization: Bearer <MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d @config.json http://127.0.0.1:18787/admin/api/config

# 手动签到 / 强制刷新 Token
curl -X POST -H "Authorization: Bearer <MASTER_KEY>" http://127.0.0.1:18787/admin/api/checkin
curl -X POST -H "Authorization: Bearer <MASTER_KEY>" http://127.0.0.1:18787/admin/api/refresh

# 定时任务触发器（专用密钥，无法调用 Admin API）
curl -X POST -H "Authorization: Bearer <CRON_SECRET>" http://127.0.0.1:18787/checkin
```

---

## 📡 端点总览（API Reference）

| 路径 | 方法 | 鉴权 | 说明 |
| :--- | :--- | :--- | :--- |
| `/` | GET | 公开 | 浏览器访问返回控制台；非 HTML Accept（curl 等）返回健康检查 JSON（与 `/healthz` 同构） |
| `/healthz` | GET | 公开 | 存活心跳；零 provider / 零路由时 `503 degraded` |
| `/status` | GET | 公开 | 无害存活信息（service / version / storage） |
| `/v1/messages` | POST | API Key | Anthropic Messages 协议（Claude Code 主路径） |
| `/v1/chat/completions` | POST | API Key | OpenAI Chat Completions 协议 |
| `/v1/models` `/models` | GET | API Key | OpenAI 兼容模型目录（当前路由配置） |
| `/v1/usage` `/usage` | GET | API Key | CC-Switch 兼容余额查询（响应结构不变） |
| `/checkin` | POST | Master Key 或 Cron Secret | 手动签到（Cron 密钥降权，仅能触发本接口） |
| `/admin` | GET | 公开 | Agent-Native 自解释 JSON 规范页 |
| `/admin/api/config` | GET/POST | Master Key 或会话 | 配置读写（脱敏 / 回填 / 校验 400 / 乐观锁 409） |
| `/admin/api/status` | GET | Master Key 或会话 | 聚合状态（余额 / 账号 / 最近签到与刷新 / 缓存统计） |
| `/admin/api/checkin` | POST | Master Key 或会话 | 手动签到 |
| `/admin/api/refresh` | POST | Master Key 或会话 | 强制刷新全部 Token |
| `/api/console/*` | — | 会话 Cookie | Web 控制台后端（20 个端点） |

响应结构与 v2.4.0 保持一致；对外路径不因端口 / 部署形态变化而改变。

---

## 🌐 全局代理

| 能力 | 说明 |
| :--- | :--- |
| **协议** | `http` / `https` / `socks5` / `socks5h`（socks5h = 远程 DNS 解析）；支持 `user:pass@host:port` 或分字段 |
| **代理池** | 多地址逗号 / 分号 / 换行分隔；**上游返回限流时自动轮换到下一个**（原 OpenCode 专属行为已全局化，全部提供商共享） |
| **作用域** | 全部出站请求：提供商调用、余额与积分查询、签到、令牌续签、免费模型拉取、连通性测试 |
| **两层覆盖** | 全局默认 + 提供商级覆盖（自有代理 / `direct` 直连）；绕过列表（指定域名直连） |
| **优先级** | 设置页配置 > 环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`）> 直连 |
| **热生效** | 保存后无需重启（运行时设置写穿缓存 + dispatcher 缓存失效） |
| **测试** | 设置页「测试代理」实测一次出站请求，回显**出口 IP 与耗时**；失败时区分 DNS 解析失败 / 代理认证失败 / 连接超时等具体原因 |

实现说明：Node 原生 `fetch` 不支持代理，HTTP/HTTPS 通过 **undici `ProxyAgent` 注入 dispatcher**，SOCKS 协议走 `socks-proxy-agent`（纯 JS 实现，其 Agent 实现 undici Dispatcher 接口）；全局 fetch **不被替换**，仅在统一出站出口 `fetchWithProxy()` 显式传 dispatcher。

---

## 🔐 安全模型

1. **管理员密码**：scrypt 强哈希（salt + 64 字节派生密钥）存储，禁止明文 / 普通哈希。
2. **会话机制**：双通道服务端会话（而非 JWT）。理由：需求明确要求「登出、会话有效期、滑动续期、修改密码后失效全部既有会话」——服务端会话天然支持撤销，JWT 无状态签名无法单点失效（引入黑名单等于变相会话）。**通道 1（主）**：Cookie `HttpOnly` + `SameSite=Lax` + 生产环境 `Secure`（本地 HTTP 部署可设 `ALLOW_INSECURE_COOKIE=1`）；**通道 2（兜底）**：登录响应同时返回会话令牌（前端 localStorage 存放、请求以 `Authorization: Bearer` 附带）——覆盖控制台被嵌入第三方 iframe（如预览面板）时浏览器静默丢弃 SameSite=Lax Cookie 的场景。两通道指向**同一条服务端 Session 记录**：登出 / 改密 / 过期删除记录即同时失效，撤销语义一致（令牌仅代表控制台会话，不是网关 Master Key）。有效期 12 小时 + 滑动续期（剩余 < 1h 时顺延）。
3. **登录防爆破**：同一 IP 连续 5 次失败锁定 15 分钟；全部登录尝试写入 `LoginAudit` 审计表。
4. **CORS 收紧**：原版 `Access-Control-Allow-Origin: *` 与 Cookie 会话组合会形成安全漏洞，已改为**默认同源**（不回 CORS 头）+ 显式白名单（`*` 需手动开启且界面有风险提示）。本机服务端客户端（Claude Code / CC-Switch）非浏览器调用，无需 CORS。
5. **默认仅监听 127.0.0.1**；控制台「设置」提供局域网访问开关，打开时展示风险提示。
6. **凭据脱敏**：所有日志、界面输出、API 响应中的 Token / 密钥均为掩码（前 4 + `••••` + 后 4 + 长度）；`SECRET_FIELDS` 清单统一管理。
7. **初始化防抢占**：初始化引导页仅在「无管理员存在**且**请求来自本机」时可用，远程访问无法抢先初始化。
8. **密钥管理**：`master_key` / `cron_secret` 缺失时生成强随机值（`uag-master_` + 24 字节随机），**拒绝硬编码兜底**；缺失关键密钥直接报错而非静默降级。

---

## 💾 数据存储

- **驱动**：Prisma ORM + SQLite。选择理由：零原生编译依赖（规避 `ignore-scripts` 环境下 `better-sqlite3` 类模块静默安装失败的问题），跨平台开箱即用，且 Prisma 提供类型安全的 schema 与迁移工具。
- **位置**：默认 `db/custom.db`（项目 `db/` 目录），环境变量 `DATABASE_URL` 可覆盖；**已加入 .gitignore**；文件权限建议设为 `0600`（`chmod 600 db/custom.db`）。
- **模式**：WAL 日志模式 + 合理 busy timeout（长连接流式请求、定时任务与后台令牌续签并发写入安全）。
- **Schema 版本**：`SchemaVersion` 表 + 顺序迁移机制；迁移脚本幂等可重复执行。
- **表结构按领域拆分**（不再把配置塞成单个 JSON blob）：`AdminUser` / `Session` / `LoginAudit` / `Provider` / `Account`（含冷却状态与余额快照）/ `ModelRoute` / `RouteCandidate` / `VirtualKey` / `SystemSetting` / `CheckinLog` / `RequestLog` / `JobRun`。
- **凭据存储方式**：**明文 + 文件权限保护**（`credentials` JSON 字段 + DB 文件 `0600`）。取舍说明：网关必须向上游还原明文凭据才能发请求，对称加密只是把「文件权限」换成「口令保管」——忘记口令即数据不可恢复，且进程内仍需持有解密密钥（防护面未实质扩大）。如需更强隔离，建议整盘加密 + 严格文件权限。
- **备份**：控制台「设置 → 数据备份」一键导出全库 JSON（含凭据，仅属主保存）；恢复可用 KV 迁移工具的导入模式或直接替换 DB 文件。
- **配置防御性行为**（等价保留原版）：写入前 schema 校验返回明确 `400`；`config_version` 乐观锁冲突返回 `409`；缺失关键密钥拒绝硬编码兜底；代码默认路由自动回填存量配置缺失条目（仅当引用的 provider 全部存在）。

---

## 🔄 从 Cloudflare KV 迁移

控制台「设置 → KV 迁移工具」提供一次性迁移：

1. 从原环境导出 `GATEWAY_CONFIG` 键的 JSON 全文：
   ```bash
   npx wrangler kv key get --binding GATEWAY_KV GATEWAY_CONFIG > gateway-config.json
   # 或从 Cloudflare 控制台 KV 界面直接复制
   ```
2. 粘贴到迁移工具（或用 API）：
   ```bash
   curl -X POST -H "Authorization: Bearer <MASTER_KEY>" \
     -H "Content-Type: application/json" \
     -d "{\"text\": $(cat gateway-config.json)}" \
     http://127.0.0.1:18787/api/console/migrate-kv
   ```
3. 查看迁移报告：新建的 providers / accounts / routes / virtual_keys 数量、跳过项（幂等语义，可重复执行）、警告（如路由候选引用不存在的 provider）。

原 KV 中的运行状态键（`WB_ACCESS_TOKEN_*` / `WB_COOLDOWN_*` / `LAST_CHECKIN` / `LEGACY_OPENCODE_FREE_MODELS` / `QWEN_FP_*`）无需迁移——新版对应数据（账号凭据最新值 / 冷却 / 签到日志 / 免费模型池 / Qwen 指纹）会在首次运行时自动重建或落位于对应表。

---

## 🏭 常驻部署

### Docker

```dockerfile
# Dockerfile
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run db:generate && pnpm run build
ENV PORT=18787
EXPOSE 18787
VOLUME ["/app/db"]
CMD ["pnpm", "start"]
```

```yaml
# docker-compose.yml
services:
  uag:
    build: .
    ports:
      - "127.0.0.1:18787:18787"   # 默认仅本机；对外暴露改为 "18787:18787"（风险自担）
    volumes:
      - ./data:/app/db             # SQLite 数据卷
    restart: unless-stopped
```

### systemd（Linux）

```ini
# /etc/systemd/system/uag.service
[Unit]
Description=Universal AI Gateway
After=network.target

[Service]
Type=simple
User=uag
WorkingDirectory=/opt/uag
ExecStart=/usr/bin/pnpm start
Environment=PORT=18787
Restart=on-failure
RestartSec=5
# 优雅关闭：SIGTERM 后等待流式请求收尾（默认 10s 超时）
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now uag
```

### launchd（macOS）

```xml
<!-- ~/Library/LaunchAgents/com.uag.gateway.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.uag.gateway</string>
  <key>WorkingDirectory</key><string>/Users/you/uag</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/pnpm</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>18787</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/uag.log</string>
  <key>StandardErrorPath</key><string>/tmp/uag.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.uag.gateway.plist
```

> 优雅关闭：进程收到 SIGTERM 后停止接受新请求，在途流式交换按上游停滞熔断（默认 180s）或自然完成后退出。

---

## 🏗️ 架构变更说明（原 v2.4.0 → v3.0）

### 已删除（云端产物与适配层）

以下内容被**有意删除**，逐条列出便于核对没有误删业务能力：

| 删除项 | 替代方案 |
| :--- | :--- |
| `wrangler.jsonc` / `wrangler.example.jsonc` | 无需替代（本地 Node 部署） |
| `vercel.json` | 无需替代 |
| `api/` 目录（Vercel Serverless 入口） | Next.js App Router 路由（`src/app/**/route.ts`） |
| `wrangler` 开发依赖 | 移除 |
| Cloudflare KV 绑定（`GATEWAY_KV` / `WORKBUDDY_KV`）与读写代码 | Prisma + SQLite（`src/lib/gateway/config/configService.ts`） |
| Cloudflare Cron Triggers（`scheduled` handler） | 进程内调度器（`src/lib/gateway/jobs/scheduler.ts`，自研 5 字段 cron + 时区） |
| 内存 KV 降级实现（无 KV 绑定时的 fallback） | SQLite 恒可用 |
| Upstash Redis 适配（如曾配置） | SQLite 恒可用 |
| 云平台环境变量白名单机制（secrets 面板） | dotenv 风格 `.env` + 启动自检 + DB 设置（控制台热改） |
| Cloudflare / Vercel 部署文档章节 | 本 README 的本地部署章节 |

### 保留（对外契约不变）

- 端点路径与响应结构：`/v1/messages`、`/v1/chat/completions`、`/v1/models`、`/v1/usage`、`/status`、`/healthz`、`/checkin`、`/admin`、`/admin/api/*`
- `GATEWAY_CONFIG` 的 JSON 形态作为引擎内存契约（`/admin/api/config` 的 GET/POST 原样可用）
- 全部提供商适配器语义、调度与容灾算法、鉴权语义（含常量时间比较）
- 默认路由表与 `backfillMissingRoutes` 回填行为

### 新增

- Web 管理控制台（`/`）+ 控制台后端（`/api/console/*`）
- 管理员密码 + Cookie 会话体系（scrypt / 登录锁定 / 审计）
- SQLite 按领域拆表 + 请求日志 / 签到日志 / 任务执行记录落库
- 全局代理层（原 OpenCode 专属代理池轮换全局化 + 协议扩展 + 两层覆盖 + 实测）
- 账号导入导出闭环、KV 迁移工具、数据备份

### 唯一的契约级差异（附兼容方案）

`/status` 响应中的 `kvEnabled: boolean` 字段改为 `storage: "sqlite"`——该字段语义为「持久层是否可用」，原自动化脚本若依赖 `kvEnabled` 请改为检查 `storage`（本机部署下 KV 概念不复存在，保留该键只会误导）。其余端点的路径、方法、状态码、响应结构均未改变。

---

## ❓ 常见问题（FAQ）

**Q: 日志落盘可选吗？**
结构化日志默认输出到 stdout（级别可在设置中调整：debug / info / warn / error）。systemd / launchd / Docker 的标准日志管道即可收集（`journalctl -u uag`、`docker logs uag`）。如需文件落盘，追加 `>> /var/log/uag.log 2>&1` 或配置 journald 持久化。

**Q: 凭据忘记备份、DB 文件损坏怎么办？**
凭据明文存储于 SQLite——**没有备份就无法恢复**（这是「明文 + 文件权限」方案的明确取舍）。请定期使用「设置 → 数据备份」导出 JSON 并妥善加密保存。

**Q: 多个 OpenCode 代理怎么配？**
设置页代理池每行一个地址（支持 `http://u:p@h:port,socks5://h2:port`）；或某提供商单独覆盖（「API 中转 → 编辑 → 代理覆盖」）。

**Q: 为什么 /v1/messages 返回 404 No route configured？**
路由查找是显式匹配（无模糊回退）。请在控制台「模型路由」为该模型名配置候选链，或直接使用路由表中已有的模型名。

**Q: 冷却状态重启后会保留吗？**
会。账号冷却（含指数退避 streak）持久化在 `Account` 表；重启后调度器自动水合。

---

## 📄 License

MIT（继承原项目）
