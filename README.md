# ⚡ Universal-AI-Gateway（Node.js 重构版 v4.9.0）

<div align="center">

**通用全功能 AI 统一网关 —— 纯 Node.js 常驻进程 + SQLite + Web 管理控制台**

[![Node](https://img.shields.io/badge/Node-%3E%3D22.5-339933?logo=node.js&logoColor=white)]()
[![Bun](https://img.shields.io/badge/Bun-1.3.4-000000?logo=bun&logoColor=white)]()
[![Storage](https://img.shields.io/badge/Storage-SQLite-003B57?logo=sqlite&logoColor=white)]()
[![Protocol](https://img.shields.io/badge/Protocol-Anthropic%20%7C%20OpenAI-059669.svg)]()
[![Port](https://img.shields.io/badge/Port-18787-D97706.svg)]()
[![Deploy](https://img.shields.io/badge/Deploy-Docker%20%7C%20systemd%20%7C%20launchd-2496ED.svg)]()

</div>

> 本仓库是 [Ericsunsk/Universal-AI-Gateway](https://github.com/Ericsunsk/Universal-AI-Gateway) v2.4.0 的彻底重构：
> 架构、目录、数据层、运行时全部重写为**纯 Node.js 常驻进程**（原 Cloudflare Workers + Vercel 双引擎），
> 配置与状态存储由云 KV 迁移为**本地 SQLite 单文件**，并新增自带 **Web 管理控制台**。
> 原项目的全部业务能力（协议转译、路由容灾、上游提供商、鉴权、运维自动化）等价保留，对外 API 契约不变。
>
> 当前版本 **4.9.0**（[版本号定义](src/lib/gateway/config/configService.ts)，`/status` 端点实时返回）。
> 📘 **从零搭建操作手册**：[`docs/搭建指南.md`](docs/搭建指南.md) —— 安装 → WorkBuddy 凭证导入 → 路由 → 客户端接入 → 验证 → 运维。

---

## 📖 目录

- [快速开始](#-快速开始)
- [部署方式](#-部署方式)
  - [方式一：裸机直接运行](#方式一裸机直接运行推荐本地开发)
  - [方式二：Docker Compose（推荐生产）](#方式二docker-compose推荐生产)
  - [方式三：从源码构建 Docker 镜像](#方式三从源码构建-docker-镜像)
  - [方式四：systemd（Linux 常驻）](#方式四systemdlinux-常驻)
  - [方式五：launchd（macOS 常驻）](#方式五launchdmacos-常驻)
  - [方式六：自定义 GHCR 镜像 + 反向代理](#方式六自定义-ghcr-镜像--反向代理)
- [核心能力](#-核心能力)
- [Web 控制台](#-web-控制台)
- [客户端接入](#-客户端接入指南)
- [端点总览](#-端点总览api-reference)
- [全局代理](#-全局代理)
- [安全模型](#-安全模型)
- [数据存储](#-数据存储)
- [从 Cloudflare KV 迁移](#-从-cloudflare-kv-迁移)
- [架构变更说明](#-架构变更说明原-v240---v490)
- [常见问题](#-常见问题faq)

---

## 🚀 快速开始

### 环境要求

| 组件 | 版本 | 说明 |
| :--- | :--- | :--- |
| **Node.js** | ≥ 22.5 | 运行时（standalone server）。未使用任何需本地编译的原生模块，刻意回避 `better-sqlite3`——若 `ignore-scripts` 生效，原生模块会静默安装失败，本项目 Prisma + SQLite 方案不受影响 |
| **Bun** | 1.3.4 | **包管理器与 `start` 脚本运行时**。仓库锁定 `bun.lock`，请勿混用 npm / pnpm / yarn 锁文件 |
| **磁盘** | ≥ 500 MB | 依赖约 400 MB + SQLite 单文件 |
| **内存** | ≥ 256 MB | 运行态常态 < 150 MB，容器编排建议限制 320 MB |

> **为什么同时需要 Node 和 Bun**：`bun install` 负责依赖安装与 `prisma generate`，`next build` 与生产启动走 Node——避免 Bun 运行 standalone server 的兼容不确定性。安装 Bun：`curl -fsSL https://bun.sh/install | bash`。

### 安装与启动

```bash
# 1. 安装依赖
bun install --frozen-lockfile

# 2. 生成 Prisma Client（首次，或 schema.prisma 变更后）
bun run db:generate

# 3. 配置数据库路径
cp .env.example .env
# 编辑 .env：本地部署建议改为相对路径
# DATABASE_URL=file:./db/custom.db

# 4. 初始化 SQLite 表结构（首次）
bun run db:push

# 5. 构建并启动（默认端口 18787）
bun run build && bun start

# 或开发模式（热重载，默认端口 3000）
bun run dev
```

启动后访问 **http://127.0.0.1:18787**：

1. **首次启动**（数据库无管理员）→ 自动进入**初始化引导页**：设置管理员密码、（可选）配置首个上游提供商；完成后一次性展示生成的 `master_key` / `cron_secret` / 默认客户端密钥（强随机生成，请立即保存）。
2. 之后访问即为**登录页**。不存在"有登录页但无人可登录"的状态。

> **端口被占用时**：进程启动失败并明确报错（`EADDRINUSE`）。可通过 `PORT` 环境变量改端口：`PORT=18788 bun start`。控制台前端与网关 API 始终**同端口同进程**（单端口架构，无前后端分离部署）。

### 启动自检

进程启动时（instrumentation 钩子）自动执行：

- ✅ SQLite 数据库可写（`SELECT 1` + 密钥初始化写入）
- ✅ 定时任务调度器启动（签到 + Token 保活）
- ✅ `master_key` / `cron_secret` 存在性检查（缺失则生成强随机值——**拒绝硬编码兜底**）

验证：`curl http://127.0.0.1:18787/healthz`（零 provider / 零路由时返回 `503 degraded`，而非永远 ok）。

---

## 🏭 部署方式

六种部署形态，按使用场景选用。**对外端点路径与响应结构不因部署方式变化而改变**。

### 方式一：裸机直接运行（推荐本地开发）

适用：本机使用、需要改代码、调试。

```bash
bun install --frozen-lockfile
bun run db:generate
bun run db:push
bun run build
PORT=18787 bun start
```

优点：零容器开销，改代码即时生效（`bun run dev`）。缺点：无进程守护，终端关闭即停。

### 方式二：Docker Compose（推荐生产）

**这是生产部署的推荐路径**：compose 文件只引用远端镜像，不在本机构建——镜像构建期峰值内存 1.5～2 GB，小内存 VPS 上会 OOM。

```bash
# 1. 确认 compose 文件中的镜像名与你的仓库一致
grep image docker-compose.yml

# 2. 启动
docker compose up -d

# 3. 跟踪首启日志，看到以下两行即就绪
docker compose logs -f
#   [SchemaInit] schema ready
#   [SchemaInit] default admin seeded
```

浏览器访问 `http://<主机>:18787`，用默认账号 `admin` / `gateway-admin-2026` 登录，**登录后立即修改密码**。

**已内置的生产级保障**（见 [docker-compose.yml](docker-compose.yml)）：

| 配置项 | 取值 | 作用 |
| :--- | :--- | :--- |
| `image` | `ghcr.io/<用户名>/<仓库名>:latest` | 只拉取不构建，小内存机器安全（镜像名以仓库内 `docker-compose.yml` 实际取值为准） |
| `init.sql` 自动建表 | 空卷首启自动执行 | 无需人工跑迁移；重复重启幂等 |
| 默认管理员播种 | 仅当库内无管理员时 | 重复重启不覆盖不报错 |
| `[::]:18787:18787` | 双栈监听 | IPv4 + IPv6 同时可达 |
| `uag-data` 具名卷 | 挂载 `/app/db` | 数据与容器生命周期解绑 |
| `mem_limit: 320m` | — | 小内存 VPS 保护 |
| `security_opt: no-new-privileges` | — | 禁止提权 |
| `healthcheck` | 接受 200 与 503 | 空库 degraded 状态不误判为不健康 |
| 日志轮转 | 10 MB × 3 | 防止日志撑爆磁盘 |

**切换到宿主目录绑定**（数据更易备份）时注意权限——容器以非 root 的 `node` 用户运行，宿主目录若为 root 属主会报 `readonly database`：

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
# 然后改 docker-compose.yml：- ./data:/app/db
```

**常用运维命令**：

```bash
docker compose logs -f          # 跟踪日志
docker compose restart          # 重启（数据保留）
docker compose pull && docker compose up -d   # 升级到最新镜像
docker compose down             # 停止（数据保留）
docker compose down -v          # 停止并删除数据卷（数据全丢）
```

### 方式三：从源码构建 Docker 镜像

适用：私有定制、需要修改镜像内容、自建 registry。**唯一要求：构建机可访问公网基础镜像源且内存充足（见下方警告）**，不需要预装 Node / Bun / Prisma——依赖安装、`prisma generate`、`next build` 全部在构建阶段内完成。

```bash
# 1. 克隆并进入仓库
git clone <你的仓库地址> uag && cd uag

# 2. 构建镜像（默认无构建参数，全流程在容器内完成）
docker build -t uag:local .

# 3. 运行（数据落具名卷，重启不丢）
docker run -d \
  --name uag \
  -p 127.0.0.1:18787:18787 \
  -v uag-data:/app/db \
  --restart unless-stopped \
  -e UAG_DEFAULT_ADMIN_PASSWORD='<强口令>' \
  uag:local
```

> 容器首启会自动执行 `prisma/init.sql` 建表并播种默认管理员（仅在库内无管理员时），无需手动跑迁移。库内已有管理员后，`UAG_DEFAULT_ADMIN_PASSWORD` 不再生效。

**自定义构建参数**（可选）：

```bash
docker build \
  --build-arg DATABASE_URL=file:/app/db/custom.db \   # 构建期 Prisma 生成所用路径
  -t uag:local .
```

**推送到自建 / 私有 registry**：

```bash
docker tag uag:local registry.example.com/uag:4.9.0
docker tag uag:local registry.example.com/uag:latest
docker push registry.example.com/uag:4.9.0
docker push registry.example.com/uag:latest
```

**多阶段构建说明**（见仓库内 `Dockerfile`）：builder 阶段装 Bun 与依赖、跑 `prisma generate`、执行 `next build`（走 Node 而非 Bun）并把 static / public / init.sql 复制进 standalone 产物；runner 阶段仅保留 `node:22-bookworm-slim` + `ca-certificates` + `openssl` + standalone 产物，以非 root 的 `node` 用户运行，镜像内**不含 Bun、TypeScript、Prisma CLI 与源码树**。

**改用宿主目录绑定数据**时须先处理属主（容器以 UID 1000 运行）：

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
docker run -d --name uag -p 127.0.0.1:18787:18787 \
  -v "$PWD/data:/app/db" --restart unless-stopped uag:local
```

> ⚠️ **必须知道**：构建期峰值内存约 1.5～2 GB。小内存 VPS（≤1 GB）请改用方式二拉取镜像，或在 CI 中构建（见方式六）。构建机若无法访问 Docker Hub，可在 `Dockerfile` 顶部换用可达的基础镜像源。

### 方式四：systemd（Linux 常驻）

适用：Linux 服务器直接跑进程（不用容器），需要开机自启与崩溃重启。

```ini
# /etc/systemd/system/uag.service
[Unit]
Description=Universal AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=uag
Group=uag
WorkingDirectory=/opt/uag
Environment=NODE_ENV=production
Environment=PORT=18787
Environment=DATABASE_URL=file:/opt/uag/db/custom.db
ExecStart=/usr/local/bin/bun start
Restart=on-failure
RestartSec=5
# 优雅关闭：SIGTERM 后等待流式请求收尾
KillSignal=SIGTERM
TimeoutStopSec=10
# 加固
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
# 前置：创建专用用户与目录
sudo useradd -r -s /usr/sbin/nologin uag
sudo mkdir -p /opt/uag && sudo chown -R uag:uag /opt/uag
# 将项目部署到 /opt/uag 并完成 build 后：
sudo chmod 600 /opt/uag/db/custom.db
sudo systemctl daemon-reload
sudo systemctl enable --now uag
sudo journalctl -u uag -f
```

### 方式五：launchd（macOS 常驻）

适用：macOS 本机长期后台运行。

```xml
<!-- ~/Library/LaunchAgents/com.uag.gateway.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.uag.gateway</string>
  <key>WorkingDirectory</key><string>/opt/uag</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/bun</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>18787</string>
    <key>NODE_ENV</key><string>production</string>
    <key>DATABASE_URL</key><string>file:/opt/uag/db/custom.db</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/uag.log</string>
  <key>StandardErrorPath</key><string>/tmp/uag.err</string>
</dict>
</plist>
```

> 上述路径为占位示例，请替换为你的实际部署目录与 `bun` 安装路径（`which bun` 查看）。`WorkingDirectory` 与 `ProgramArguments` 中的 `bun` 必须使用**绝对路径**，launchd 不加载登录 shell 的 `PATH`。

```bash
launchctl load -w ~/Library/LaunchAgents/com.uag.gateway.plist
launchctl list | grep uag           # 查看运行状态
launchctl unload ~/Library/LaunchAgents/com.uag.gateway.plist   # 停止
```

> macOS 上也可直接用 Docker Desktop 走方式二，省去 plist 维护。

### 方式六：自定义 GHCR 镜像 + 反向代理

适用：拥有 GitHub 仓库、希望 CI 自动出多架构镜像，并在公网通过 HTTPS 暴露。

**6.1 CI 自动构建多架构镜像**

仓库已内置 [`.github/workflows/docker.yml`](.github/workflows/docker.yml)：main 分支推送或打 `v*.*.*` tag 时，在 `ubuntu-24.04` 与 `ubuntu-24.04-arm` 上并行构建 `linux/amd64` + `linux/arm64`，推送后合并为多架构 manifest，标签为 `latest`（main 分支）与 `v*.*.*`（tag）。

Fork 后需修改镜像名（GitHub 容器镜像名必须全小写）：

```bash
# 同时改这三处
#   .github/workflows/docker.yml  → tags: ghcr.io/<你的用户名>/<仓库名>:...
#   Dockerfile                    → LABEL org.opencontainers.image.source="https://github.com/<你的用户名>/<仓库名>"
#   docker-compose.yml            → image: ghcr.io/<你的用户名>/<仓库名>:latest
```

> 上述三处是唯一的改名点。若直接使用本仓库已发布的镜像，则无需改动，但需确认该包为 Public（或在使用端先 `docker login ghcr.io`）。

首次推送后到 GitHub 仓库 `Packages` 设置该包为 Public（或在使用端 `docker login ghcr.io`）。

**6.2 反向代理 + TLS**

局域网或公网访问时，前置 Caddy / nginx 做 TLS 终结。Caddy 示例：

```
# Caddyfile
uag.example.com {
    reverse_proxy 127.0.0.1:18787
}
```

nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name uag.example.com;
    ssl_certificate     /etc/ssl/uag.crt;
    ssl_certificate_key /etc/ssl/uag.key;

    location / {
        proxy_pass http://127.0.0.1:18787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式 SSE 关键配置：关闭缓冲，否则首字延迟退化甚至整体卡住
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_set_header Connection "";
    }
}
```

> ⚠️ **流式代理必读**：网关自身已下发 `x-accel-buffering: no` 与 `Cache-Control: no-cache no-transform`，但反向代理仍可能自行缓冲。**务必显式关闭代理层缓冲**（`proxy_buffering off` / `encode zstd gzip` 之外不做压缩），否则 SSE 会被整段缓存后一次性下发。

---

## ✨ 核心能力

| 能力 | 说明 |
| :--- | :--- |
| **双向协议转译** | `/v1/messages`（Anthropic）⇄ `/v1/chat/completions`（OpenAI）全双工转译；另支持 `/v1/responses`（OpenAI Responses API，Codex CLI 入站）。流式 SSE（thinking 思维链块、tool_use / tool_result、ping 心跳保活）与非流式共享同一套 extractors，零分叉 |
| **请求侧净化** | 客户端指纹脱敏（规避腾讯 11128 拦截）、消息序列归一（修复 tool_calls 顺序，规避 11148）、推理强度解析（模型名后缀 `[high]` / Anthropic thinking / `reasoning_effort` / 通用 reasoning 四源统一） |
| **路由与容灾** | 模型名 → 有序候选列表路由表；候选级自动故障转移；多账号池轮换；**会话粘性**（同一会话固定账号，保住上游前缀缓存）；账号级指数退避冷却（1→2→4→8 分钟封顶，**SQLite 持久化，重启不丢**）；错误三分类（冷却 / 重试 / 致命）与风控挑战页识别 |
| **账号调度模式** | 负载均衡 / 顺序调度可配置 |
| **上游提供商** | WorkBuddy 腾讯云代码助手（国内站 + 国际站双 region，CN 30 模型 / INTL 18 模型）、OpenAI 兼容（OpenRouter / DeepSeek / 硅基流动）、Anthropic 兼容。**新增提供商 = 新目录 + 一行注册** |
| **用量与成本** | 请求日志六视图成本估算（`ModelPricing` 单价表）；虚拟密钥月度成本预算（超预算入口 429 + `X-Budget-*` 头组，下月 1 日重置）；总览月度账单卡（按密钥分组 + byModel 明细 + 环比 + CSV 导出） |
| **多用户与 RBAC** | 管理员 / 成员角色，成员管理与成员级密钥归属；日志与用量按 owner 维度过滤；路由候选模型目录支持真实上游拉取 |
| **鉴权体系** | 多把虚拟密钥（模型白名单 / 启停 / 角色）、管理主密钥、定时任务专用密钥（降权语义）、常量时间比较（抗时序攻击） |
| **运维自动化** | AccessToken 401 无感续签（写回 SQLite）、每日定时签到、余额并发聚合、上游前缀缓存命中统计 |
| **上下文控制** | 最大上下文轮数截断（可设 0 = 不限）+ RTK 工具输出净化（ANSI 清洗 / 测试折叠 / 渐进退火） |
| **流式零缓冲** | `x-accel-buffering: no` + `Cache-Control: no-cache no-transform` + 每块即时下发，首字延迟不退化 |
| **Web 控制台** | 登录 / 初始化引导 / 总览 / 账号管理（导入导出闭环）/ API 中转 / 虚拟密钥 / 模型路由（拖拽排序）/ 定时任务 / 运行日志 / 成员管理 / 设置（代理 / 备份 / KV 迁移） |
| **全局代理** | http / https / socks5 / socks5h（远程 DNS）；代理池限流自动轮换；提供商级覆盖与绕过列表；热生效；出口 IP 实测 |

---

## 🖥️ Web 控制台

单页应用（`/` 路径），包含 9 大模块：

| 模块 | 能力 |
| :--- | :--- |
| **账户总览** | 聚合余额与积分、账号总数与启用数、提供商数量、路由数量、上游前缀缓存命中率、最近签到 / 最近 Token 刷新时间、可用模型列表、月度账单卡 |
| **账号管理** | 按提供商分组列表；增删改、启停；**批量导入**（粘贴文本 / 上传文件，JSON 为主 + CSV，逐行校验，返回成功 / 跳过 / 失败数量与逐行原因，冲突策略可选跳过 / 覆盖 / 生成新 ID）；**导出**（完整导出含凭据可再导入，需二次确认；脱敏导出隐藏凭据用于分享，且被系统识别并拒绝作为导入源） |
| **API 中转管理** | 已配置中转卡片网格；新增 / 编辑弹出**配置悬浮窗**，按提供商类型渲染不同字段；**保存前可测试连通性**，回显余额或可用模型 |
| **虚拟密钥** | 增删改查、启停、备注、按密钥配置模型白名单、归属用户、月度成本预算；密钥值仅创建时一次性展示，此后掩码显示 |
| **模型路由** | 模型名 → 有序候选列表的增删改；候选可增删、**拖拽排序**、启停；候选模型目录支持上游实时拉取（倍率 / 免费徽章） |
| **定时任务** | 签到与 Token 保活的开关、cron 执行时间、时区配置；上次执行结果与逐账号明细；手动立即执行 |
| **运行日志** | 时间、模型、命中的提供商与账号、耗时、状态码、Token 用量（in / out / cached）、成本估算、失败与冷却记录；按模型 / 用户筛选与分页 |
| **成员管理** | 成员增删、角色分配、启停（停用级联其名下密钥） |
| **设置** | 全局代理（协议 / 池 / 绕过列表 / **出口 IP 实测按钮**）、管理员密码修改（改密后全部会话失效）、CORS 白名单、上下文轮数、密钥再生成、**数据备份一键导出**、**KV 迁移工具** |

**敏感字段契约**（代码与实现中显式体现）：界面只显示掩码（如 `sk-1••••abcd（已隐藏，共 32 位）`）；保存时若该字段未被改动，服务端必须用数据库中的原值回填——**绝不允许一次保存把凭据清空**。虚拟密钥的密钥名同样掩码显示并在保存时正确还原。该契约集中在 `src/lib/gateway/config/configService.ts`（`mergeSecrets` / `restoreVirtualKeys`）与 `src/lib/gateway/console/consoleHelpers.ts`（`mergeCredentialsOnSave`）。

---

## 🔌 客户端接入指南

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18787
export ANTHROPIC_API_KEY=sk-uag-xxxxxxxx        # 控制台「虚拟密钥」创建的密钥

claude
```

模型名走网关路由表（如 `claude-3-5-sonnet-20241022` 映射到 DeepSeek / 免费池候选链）；推理强度可用模型名后缀（`claude-3-7-sonnet-20250219[high]`）或原生 `thinking` 配置。

### Codex CLI / OpenAI Responses

指向 `/v1`，网关提供 `/v1/responses` 入站端点，含服务端工具剥离降级（`X-Gateway-Dropped-Tools` 头 + warn 日志）与 tool_call 序列统一修复。

### CC-Switch

- **Base URL**：`http://127.0.0.1:18787`
- **API Key**：虚拟密钥
- **余额卡片**：依赖 `/v1/usage` 的 `{code:0, data:{balance,total,unit}}` 响应结构（本网关原样保留）：

```bash
curl -H "Authorization: Bearer sk-uag-xxx" http://127.0.0.1:18787/v1/usage
# {"code":0,"data":{"balance":1234.5,"total":5000,"unit":"积分"}}
```

### Cursor / OpenAI 生态客户端（NextChat 等）

- **API Base**：`http://127.0.0.1:18787/v1`
- **API Key**：虚拟密钥
- 兼容 OpenAI Chat Completions 协议与 `/v1/models` 模型目录

> **非 HTTPS 地址被客户端拒绝时**：
> 1. 本机回环地址多数客户端默认放行（`127.0.0.1` / `localhost`），优先使用；
> 2. 局域网访问时前置 Caddy / nginx 做 TLS 终结（见[方式六](#方式六自定义-ghcr-镜像--反向代理)）；
> 3. 网页客户端跨域：默认同源策略不回 CORS 头，需在「设置 → CORS 白名单」显式加入客户端 Origin（最小必要配置）。

### 自动化脚本 / AI 智能体（Agent-Native）

`/admin` 返回自解释 JSON 规范页，`/admin/api/*` 支持配置读写、状态查询、签到、刷新令牌：

```bash
# 读取配置（机密字段自动脱敏）
curl -H "Authorization: Bearer <MASTER_KEY>" http://127.0.0.1:18787/admin/api/config

# 写入配置（省略/掩码的机密字段自动用 DB 原值回填；config_version 乐观锁，冲突 409；校验失败 400）
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
| `/v1/responses` | POST | API Key | OpenAI Responses API（Codex CLI 主路径） |
| `/v1/models` `/models` | GET | API Key | OpenAI 兼容模型目录（当前路由配置） |
| `/v1/usage` `/usage` | GET | API Key | CC-Switch 兼容余额查询（响应结构不变） |
| `/checkin` | POST | Master Key 或 Cron Secret | 手动签到（Cron 密钥降权，仅能触发本接口） |
| `/admin` | GET | 公开 | Agent-Native 自解释 JSON 规范页 |
| `/admin/api/config` | GET/POST | Master Key 或会话 | 配置读写（脱敏 / 回填 / 校验 400 / 乐观锁 409） |
| `/admin/api/status` | GET | Master Key 或会话 | 聚合状态（余额 / 账号 / 最近签到与刷新 / 缓存统计） |
| `/admin/api/checkin` | POST | Master Key 或会话 | 手动签到 |
| `/admin/api/refresh` | POST | Master Key 或会话 | 强制刷新全部 Token |
| `/api/console/*` | — | 会话 Cookie | Web 控制台后端 |

响应结构与 v2.4.0 保持一致；对外路径不因端口 / 部署形态变化而改变。

---

## 🌐 全局代理

| 能力 | 说明 |
| :--- | :--- |
| **协议** | `http` / `https` / `socks5` / `socks5h`（socks5h = 远程 DNS 解析）；支持 `user:pass@host:port` 或分字段 |
| **代理池** | 多地址逗号 / 分号 / 换行分隔；**上游返回限流时自动轮换到下一个**（全提供商共享） |
| **作用域** | 全部出站请求：提供商调用、余额与积分查询、签到、令牌续签、模型目录拉取、连通性测试 |
| **两层覆盖** | 全局默认 + 提供商级覆盖（自有代理 / `direct` 直连）；绕过列表（指定域名直连） |
| **优先级** | 设置页配置 > 环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`）> 直连 |
| **热生效** | 保存后无需重启（运行时设置写穿缓存 + dispatcher 缓存失效） |
| **测试** | 设置页「测试代理」实测一次出站请求，回显**出口 IP 与耗时**；失败时区分 DNS 解析失败 / 代理认证失败 / 连接超时等具体原因 |

实现说明：Node 原生 `fetch` 不支持代理，HTTP/HTTPS 通过 **undici `ProxyAgent` 注入 dispatcher**，SOCKS 协议走 `socks-proxy-agent`；全局 fetch **不被替换**，仅在统一出站出口 `fetchWithProxy()` 显式传 dispatcher。

---

## 🔐 安全模型

1. **管理员密码**：scrypt 强哈希（salt + 64 字节派生密钥）存储，禁止明文 / 普通哈希。
2. **会话机制**：双通道服务端会话（而非 JWT），因为需求要求「登出、会话有效期、滑动续期、修改密码后失效全部既有会话」——服务端会话天然支持撤销，JWT 无状态签名无法单点失效。**通道 1（主）**：Cookie `HttpOnly` + `SameSite=Lax` + 生产环境 `Secure`（本地 HTTP 部署可设 `ALLOW_INSECURE_COOKIE=1`）；**通道 2（兜底）**：登录响应同时返回会话令牌（前端 localStorage 存放、请求以 `Authorization: Bearer` 附带），覆盖控制台被嵌入第三方 iframe 时浏览器静默丢弃 `SameSite=Lax` Cookie 的场景。两通道指向**同一条服务端 Session 记录**。有效期 12 小时 + 滑动续期（剩余 < 1h 时顺延）。
3. **登录防爆破**：同一 IP 连续 5 次失败锁定 15 分钟；全部登录尝试写入 `LoginAudit` 审计表。
4. **CORS 收紧**：原版 `Access-Control-Allow-Origin: *` 与 Cookie 会话组合会形成安全漏洞，已改为**默认同源**（不回 CORS 头）+ 显式白名单（`*` 需手动开启且界面有风险提示）。
5. **监听地址**：默认仅监听 `127.0.0.1`；控制台「设置」提供局域网访问开关，打开时展示风险提示。容器编排中通过端口映射控制暴露面（见[方式二](#方式二docker-compose推荐生产)）。
6. **凭据脱敏**：所有日志、界面输出、API 响应中的 Token / 密钥均为掩码（前 4 + `••••` + 后 4 + 长度）；`SECRET_FIELDS` 清单统一管理。
7. **初始化防抢占**：初始化引导页仅在「无管理员存在**且**请求来自本机」时可用，远程访问无法抢先初始化。
8. **密钥管理**：`master_key` / `cron_secret` 缺失时生成强随机值（`uag-master_` + 24 字节随机），**拒绝硬编码兜底**；缺失关键密钥直接报错而非静默降级。
9. **容器加固**：`no-new-privileges`、非 root 运行、`pids_limit`、`mem_limit`。

---

## 💾 数据存储

- **驱动**：Prisma ORM + SQLite。选择理由：零原生编译依赖（规避 `ignore-scripts` 环境下 `better-sqlite3` 类模块静默安装失败），跨平台开箱即用，且 Prisma 提供类型安全的 schema 与迁移工具。
- **位置**：默认 `db/custom.db`，环境变量 `DATABASE_URL` 覆盖（**注意是 `file:` 前缀 + 绝对或相对路径**）；已加入 `.gitignore`；文件权限建议 `chmod 600 db/custom.db`。
  - 裸机 / systemd / launchd：`file:/opt/uag/db/custom.db` 或 `file:./db/custom.db`
  - Docker：`file:/app/db/custom.db`（落在具名卷内）
- **模式**：WAL 日志模式 + 合理 busy timeout（长连接流式请求、定时任务与后台令牌续签并发写入安全）。
- **表结构初始化**：两种幂等路径——裸机构建流程用 `bun run db:push`；容器首启用 `prisma/init.sql` 自动建表（`SchemaInit` 检测空库后执行）。
- **表结构按领域拆分**（不再把配置塞成单个 JSON blob）：`AdminUser` / `Session` / `LoginAudit` / `Provider` / `Account`（含冷却状态与余额快照）/ `ModelRoute` / `RouteCandidate` / `VirtualKey` / `SystemSetting` / `CheckinLog` / `RequestLog` / `UsageDaily` / `ModelPricing` / `JobRun` / `SchemaVersion`。
- **凭据存储方式**：**明文 + 文件权限保护**（`credentials` JSON 字段 + DB 文件 `0600`）。取舍说明：网关必须向上游还原明文凭据才能发请求，对称加密只是把「文件权限」换成「口令保管」——忘记口令即数据不可恢复，且进程内仍需持有解密密钥（防护面未实质扩大）。如需更强隔离，建议整盘加密 + 严格文件权限。
- **备份**：控制台「设置 → 数据备份」一键导出全库 JSON（含凭据，仅属主保存）；恢复可用 KV 迁移工具的导入模式，或直接替换 DB 文件（**替换前先停进程**，避免 WAL 不一致）。
- **配置防御性行为**：写入前 schema 校验返回明确 `400`；`config_version` 乐观锁冲突返回 `409`；缺失关键密钥拒绝硬编码兜底；代码默认路由自动回填存量配置缺失条目（仅当引用的 provider 全部存在）。

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

原 KV 中的运行状态键（`WB_ACCESS_TOKEN_*` / `WB_COOLDOWN_*` / `LAST_CHECKIN` 等）无需迁移——新版对应数据会在首次运行时自动重建或落位于对应表。

---

## 🏗️ 架构变更说明（原 v2.4.0 → v4.9.0）

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
| Cloudflare / Vercel 部署文档章节 | 本 README 的部署章节 |
| opencode / qwenweb 内置提供商预设与适配器（4.9.0 移除） | 历史 DB 数据继续可见但运行时不再支持 |

### 保留（对外契约不变）

- 端点路径与响应结构：`/v1/messages`、`/v1/chat/completions`、`/v1/models`、`/v1/usage`、`/status`、`/healthz`、`/checkin`、`/admin`、`/admin/api/*`
- `GATEWAY_CONFIG` 的 JSON 形态作为引擎内存契约（`/admin/api/config` 的 GET/POST 原样可用）
- 全部提供商适配器语义、调度与容灾算法、鉴权语义（含常量时间比较）
- 默认路由表与 `backfillMissingRoutes` 回填行为

### 新增

- Web 管理控制台（`/`）+ 控制台后端（`/api/console/*`）
- 管理员密码 + Cookie 会话体系（scrypt / 登录锁定 / 审计）
- SQLite 按领域拆表 + 请求日志 / 签到日志 / 任务执行记录落库
- 全局代理层（协议扩展 + 两层覆盖 + 实测）
- 账号导入导出闭环、KV 迁移工具、数据备份
- Docker 部署套件（standalone 多阶段构建 + GHCR 多架构 CI）+ 容器首启自动建表与默认管理员播种
- `/v1/responses` 入站端点（Codex CLI）+ 严格 SSE 生命周期
- 用量成本估算（`ModelPricing` + 六视图）与月度预算（密钥级预算 + 账单卡）
- 多用户 RBAC（管理员 / 成员、成员级密钥归属、日志 owner 过滤）
- 账号调度模式（负载均衡 / 顺序调度）可配置

### 唯一的契约级差异（附兼容方案）

`/status` 响应中的 `kvEnabled: boolean` 字段改为 `storage: "sqlite"`——该字段语义为「持久层是否可用」，原自动化脚本若依赖 `kvEnabled` 请改为检查 `storage`。其余端点的路径、方法、状态码、响应结构均未改变。

---

## ❓ 常见问题（FAQ）

**Q: 日志落盘可选吗？**
结构化日志默认输出到 stdout（级别可在设置中调整：debug / info / warn / error）。systemd / launchd / Docker 的标准日志管道即可收集（`journalctl -u uag`、`docker logs uag`），容器编排已配 10 MB × 3 轮转。如需文件落盘，追加 `>> /var/log/uag.log 2>&1` 或配置 journald 持久化。

**Q: 部署后访问 18787 无响应？**
按序排查：① `docker compose logs -f` 或 `journalctl -u uag` 看是否报 `EADDRINUSE`（端口占用）或 Prisma 报错；② `curl http://127.0.0.1:18787/healthz` 确认进程存活（`503 degraded` 属正常空跑态）；③ 容器部署时确认端口映射为 `"[::]:18787:18787"`（裸写 `::` 会被 YAML 解析成嵌套映射导致容器起不来）；④ 宿主目录绑定时检查属主 —— 容器以 `node` 用户（UID 1000）运行，root 属主目录会报 `readonly database`。

**Q: 从源码构建镜像时 OOM？**
构建期峰值 1.5～2 GB。小内存机器请改用 `docker compose` 拉取 CI 构建好的镜像（方式二），或临时加 swap / 在 CI 中构建（方式六）。

**Q: 反向代理后流式输出变慢或整体卡住？**
代理层缓冲所致。nginx 必须 `proxy_buffering off;` + `proxy_cache off;`，Caddy 默认不缓冲无需额外配置。

**Q: 凭据忘记备份、DB 文件损坏怎么办？**
凭据明文存储于 SQLite——**没有备份就无法恢复**（这是「明文 + 文件权限」方案的明确取舍）。请定期使用「设置 → 数据备份」导出 JSON 并妥善加密保存。

**Q: 多个代理怎么配？**
设置页代理池每行一个地址（支持 `http://u:p@h:port,socks5://h2:port`）；或某提供商单独覆盖（「API 中转 → 编辑 → 代理覆盖」）。

**Q: 为什么 /v1/messages 返回 404 No route configured？**
路由查找是显式匹配（无模糊回退）。请在控制台「模型路由」为该模型名配置候选链，或直接使用路由表中已有的模型名。

**Q: 冷却状态重启后会保留吗？**
会。账号冷却（含指数退避 streak）持久化在 `Account` 表；重启后调度器自动水合。

**Q: 容器里默认管理员密码在哪改？**
`docker-compose.yml` 中 `UAG_DEFAULT_ADMIN_USERNAME` / `UAG_DEFAULT_ADMIN_PASSWORD` **仅首次启动生效**（库内已有管理员后不再起作用）。更稳妥的做法是登录控制台后立即在「设置」中修改密码。

---

## 📄 License

MIT（继承原项目）
