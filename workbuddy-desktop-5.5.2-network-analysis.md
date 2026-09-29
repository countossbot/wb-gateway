# WorkBuddy AI Desktop 5.5.2 — 只读网络行为分析报告

- 分析对象：`/Applications/WorkBuddy AI.app`，`CFBundleShortVersionString = 5.5.2`（与任务描述一致）
- 分析方式：**只读**。未修改任何应用文件、配置、token 或系统设置；未安装任何证书；未启用 MITM 解密；未伪造任何"看起来像 Desktop"的请求。
- 证据文件：`$PI_SCRATCH_DIR/evidence-network.txt`（原始命令输出，未经编辑）

---

## 一、核心结论：任务前提里有一个致命的地址错误

任务原文要求"抓取 Desktop 发送 `hy3` 时真实的 outbound 请求"，但给出的手工对照地址是：

```
https://www.workbuddy.ai/v2/chat/completions     ← 这个 URL 是对的
```

真正的问题在**取证的落点**：任务里把本机那台 `43.156.86.196` 当成了 WorkBuddy 的服务端。**它根本不是。**

| 主机 | 证书校验身份（hostname verification ON） | 结论 |
|---|---|---|
| `43.156.86.196` 当作 `www.workbuddy.ai` | ❌ `REJECTED: Hostname mismatch, certificate is not valid for 'www.workbuddy.ai'` | 不是 workbuddy |
| `43.156.86.196` 当作 **`sg.tgalileo.com`** | ✅ **VALID ✔** `CN=sg.tgalileo.com`，GlobalSign 签发，`2026-05-15 → 2026-11-30` | **就是它** |
| `43.160.158.125` 当作 `www.workbuddy.ai` | ✅ **VALID ✔** SAN 含 `*.workbuddy.ai` / `workbuddy.ai` / `www.workbuddy.ai` | 真正的 workbuddy |

`43.156.86.196` = **`sg.tgalileo.com`**（腾讯的遥测/追踪域名）。它与 App 自己的日志完全对得上：

```
DaemonTraceService] DaemonTraceService ready, endpoint=https://sg.tgalileo.com/v1/traces
```

**所以：去抓 `43.156.86.196` 上的流量，抓到的是遥测数据上报，不是 `hy3` 的模型请求。** 这是整个任务最容易踩空的地方。

---

## 二、真实端点：`/v2/chat/completions` 是**真的存在**（且与手工 curl 一致）

这一点值得单独确认，因为它同时验证了"手工对照地址是否正确"：

```
POST https://www.workbuddy.ai/v2/chat/completions   -> 401  (存在，需鉴权)
POST https://www.workbuddy.ai/v2/chat/completionsXX -> 404  (不存在)
GET  https://www.workbuddy.ai/v2/bogus              -> 404  (不存在)
```

`401` + `WWW-Authenticate: Bearer realm="copilot"`，网关为 APISIX。**路径存在、鉴权在应用层** —— 说明任务里手工构造的对照地址本身是**正确**的。

静态代码同样印证（`codebuddy.js`）：

```js
// resolveModelBaseURL —— 约 10540720
return ...`${ed}/v2`          // ed = product.endpoint = https://www.workbuddy.ai
// OpenAI SDK 内部再追加
`/chat/completions`
```

即 baseURL 由 `${endpoint}/v2` + SDK 的 `/chat/completions` **两段拼接**而成。bundle 里**不存在** `/v2/chat/completions` 这个单一片段字面量，所以直接 grep 找不到——但拼接结果与手工地址完全一致。

---

## 三、hy3 的权威定义（来自产品配置，非猜测）

来源：`~/.workbuddy-ai/cache/acc-product-config-v3.json` → `models[]`

```json
{
  "id": "hy3",
  "name": "Hy3",
  "descriptionZh": "混元思考模型，具有增强的推理能力",
  "credits": "x0.00",
  "maxInputTokens": 192000,
  "maxOutputTokens": 64000,
  "maxAllowedSize": 192000,
  "temperature": 0.9,
  "top_p": 1,
  "onlyReasoning": true,
  "supportsReasoning": true,
  "supportsToolCall": true,
  "supportsImages": true,
  "reasoning": {
    "canDisableThinking": false,
    "defaultEffort": "high",
    "supportedEfforts": ["low", "high"],
    "summary": "auto"
  },
  "tags": ["craft"],
  "vendor": "j"
}
```

要点：
- 模型配置里**没有** `provider` / `api` / `baseUrl` / `url` —— hy3 是**产品内置模型**，走产品 `endpoint`（`https://www.workbuddy.ai`），而非第三方 provider。
- config 中与 hy3 相关的 id 只有 **`hy3`** 和 **`hy3-free-trial-202608`** 两个。
  ⚠️ 更正：本机 CLI bundle 里另有 `hy3-free` / `hy3-preview` / `hy3-preview-agent` 字面量，但它们**不在**产品 config 的 `models[]` 中；`hy3-free` 在 config 里仅作为 `hy3-free-trial-202608` 的子串出现。
- **只有 `hy3`** 走本机产品端点；`hy3-free` 在 CLI 里被定义为 `provider:"opencode"`、`api:"openai-completions"`，**不经过** `www.workbuddy.ai`。

---

## 四、请求形态

| 维度 | 事实 | 依据 |
|---|---|---|
| 方法 / 路径 | `POST {endpoint}/v2/chat/completions` | 静态拼接 + 线上 401/404 对照 |
| API 风格 | **OpenAI chat-completions**（非 `/responses`） | `new OpenAI({baseURL})` → SDK 拼 `/chat/completions` |
| 鉴权 | `Authorization: Bearer <redacted>` + `X-API-Key: <redacted>` | apiKey 来源：`CODEBUDDY_API_KEY` → 自定义模型 apiKey → auth session |
| 请求体顶层字段 | `model`、`messages`、`stream`、`stream_options.include_usage`、`tools`、`tool_choice`、`temperature`、`max_tokens`/`max_completion_tokens`、`reasoning_effort`、`reasoning` | SDK 类型 + 本地转换规则 |
| 关键自定义头 | `X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Request-ID`、`X-Agent-Intent`（默认 `craft`）、`X-Agent-Purpose`、`X-Private-Data` | `getCustomHeaders()` / 请求头组装处 |
| `X-Private-Data` | 值为**布尔字符串** `"false"`/`"true"`（**不是** base64/JSON） | `ed[PRIVATE_DATA_HEADER] = eg ? "false" : "true"` |
| `X-Client-Info` | **不存在**（全 bundle 0 次出现） | — |
| `X-User-Id` / `X-Department-Info` / `X-Enterprise-Id` | 仅在 **IOA 企业内网**环境注入；本机默认 SaaS 路径**不发送** | `IOAUtils.applyIOADefaultHeaders` |
| `User-Agent` | 该 HTTP 请求**无**产品级自定义 UA 表达式；`CodeBuddyCode/1.0` 仅用于 IDE WebSocket 握手 | — |

---

## 五、为什么本机抓包会抓到"错误的目标"

这是本报告最有价值的一节，解释了"看起来像 Desktop 的流量"为何会误导：

1. **App 声明自己走系统代理。** App 自带网络诊断报告写着：

   ```
   Proxy Mode: System Proxy
   Proxy URL: http://127.0.0.1:7890/
   Endpoint: https://www.workbuddy.ai
   Resolved: 43.160.158.125
   ```

2. **而 `www.workbuddy.ai` 在本机确实是 `43.160.158.125`**（`dig` 结果一致，`/etc/hosts` 没有任何 workbuddy 条目）。**`43.156.86.196` 不在解析结果里。**

3. **那 9 条到 `43.156.86.196` 的连接是谁的？** 是 WorkBuddy AI 自己的进程没错（`ps` 确认 pid `37963`/`38023`/`39810` 均为 `/Applications/WorkBuddy AI.app/Contents/MacOS/Electron`），但目标身份经证书校验为 **`sg.tgalileo.com`** —— 即 `DaemonTraceService` 的遥测上报，**与 hy3 模型请求无关**。

4. **结论：把 `43.156.86.196` 当作"Desktop 的真实流量"去抓，抓到的是遥测，会把结论引向完全错误的方向。**

补充：`43.156.86.196:443` 无论带**任何** SNI（含不带 SNI）都**不返回任何 X.509 证书**（`getpeercert() == {}`），只完成 TLS 握手；而 `43.160.158.125` 在 SNI=`www.workbuddy.ai` 下返回合法证书。这两台机器的 TLS 行为属于完全不同的类型。

---

## 六、要拿到"真实 wire request"的正确做法

任务目标（拿到可验证的真实 wire request）**当前尚未达成**，原因与可行路径如下：

**为何未达成：**
- 精确定位到"用户实际发送 `hy3` 的那一次请求"需要能看到 HTTP 明文。
- 当前 App **没有**开启代理拦截；任务明确禁止"用伪造 curl 冒充 Desktop"。
- 无密码的 `sudo tcpdump` 不可用（需要人工输入密码）；且即使有 pcap，TLS 也是密文，看不到 header/body。

**可行且合规的路径（按推荐度排序）：**

1. **用 App 自带的"系统代理"开关 + 本机 mitmproxy（推荐）**
   App 已经声明走 `127.0.0.1:7890`（ClashX Pro）。把 ClashX 的规则指向本机一个 mitmproxy 监听口，即可在 **App 自己发起的连接**上拿到完整 header/body。
   注意：本机 ClashX 对**不带 SNI 的直连 TLS**会拒绝（`SSLEOFError`），所以必须让 App 通过代理的 **HTTP CONNECT** 出站，而不是裸 TCP。
   ⚠️ 此路径需要（a）修改 ClashX/mitmproxy 配置，（b）安装 mitmproxy CA。**这两项都超出了"只读分析"的授权范围，必须由你明确同意后才能做。**

2. **让 App 走一个独立的核心代理配置**（不改 ClashX），同样需要 mitmproxy CA。

3. **若只为验证"端点/头部形态"是否正确**：本报告的静态证据（第四、二节）已经足够，因为路径、鉴权方式、请求体字段、自定义头都已从 App 自身产物中逐条取证。

---

## 七、证据清单与可复现命令

原始输出：`$PI_SCRATCH_DIR/evidence-network.txt`

```bash
# 1) 证书校验身份（证明 43.156.86.196 是 sg.tgalileo.com，不是 workbuddy）
python3 -c "import socket,ssl;c=ssl.create_default_context();
s=c.wrap_socket(socket.create_connection(('43.156.86.196',443),timeout=8),server_hostname='sg.tgalileo.com');
print(s.getpeercert()['subjectAltName'])"

# 2) DNS 真相
dig +short www.workbuddy.ai A          # -> 43.160.158.125
grep -i workbuddy /etc/hosts           # -> 无

# 3) App 的连接对象 + 进程归属
lsof -nP -iTCP -sTCP:ESTABLISHED | grep 43.156.86.196
ps -p 37963 -o comm=                   # -> .../WorkBuddy AI.app/Contents/MacOS/Electron

# 4) App 自己声明的端点/代理
grep -E 'Endpoint:|Proxy Mode:|Proxy URL:|Resolved:' ~/.workbuddy-ai/logs/network/*.txt

# 5) 端点存在性（401 vs 404）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://www.workbuddy.ai/v2/chat/completions
curl -s -o /dev/null -w '%{http_code}\n' https://www.workbuddy.ai/v2/bogus
```

---

## 八、仍未确认 / 遗留项

1. **"用户实际发送 hy3 那一次"的完整 wire request（含 header 与 body 明文）尚未取得** —— 需要你在第六节的授权选择中明确一项。
2. `hy3` 请求体里 `reasoning_effort` 的**运行时实际取值**（config 声明 `defaultEffort: "high"`，但实际发送值取决于运行时设置）未直接观测到。
3. `X-Agent-Intent` 在非 `craft` 模式下的取值分支未逐一展开。
4. `43.156.86.196` 上承载的遥测 payload 内容未分析（超出本次"hy3 模型请求"的范围）。
5. 用户账号相关的 `enterpriseId` / `X-User-Id` 等只在 IOA 环境注入，本机为 SaaS，无法从静态代码给出实际值。

---

## 九、本次分析的合规边界（如实声明）

- **未做**：修改 App 文件/配置、安装证书、启用 MITM、伪造请求、读取或输出任何 token / apiKey / 账号 ID / 机器码明文。
- **已做**：只读的证书握手探测（不发送任何业务数据）、`lsof` / `ps` / `dig` / `curl` 只读探测、App 自身日志与产品配置的静态取证。
- 所有敏感值在本报告与证据文件中一律以 `<redacted>` 呈现。
