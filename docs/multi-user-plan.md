# 轻量多用户功能实施计划

> 目标场景：中小企业 / 小团体（约 5–50 人）。  
> 设计原则：只做轻量 RBAC 与成员归属，不引入 Org、Project、SSO、SCIM、细粒度权限编辑器。  
> 状态：仅任务拆分，未开始实施。

## 总体方案

- 控制台：`AdminUser` 从单管理员升级为多成员，使用固定三角色。
- 网关：继续沿用 `VirtualKey`，为密钥增加成员归属。
- 日志/用量：按成员与密钥维度过滤。
- 不做多租户、项目空间、外部身份源。
- 现有唯一管理员自动升级为 `ADMIN`。

## 角色定义

| 角色 | 说明 | 主要能力 |
|---|---|---|
| `ADMIN` | 管理员 | 全部管理能力，含成员管理与全局设置 |
| `OPERATOR` | 操作员 | 管理路由/密钥，读取日志/用量，不能管理成员或全局设置 |
| `VIEWER` | 观察者 | 只读控制台，不能修改配置 |

## 权限点

```text
provider.read / provider.write
route.read / route.write
key.read / key.write
member.read / member.write
log.read
usage.read
settings.read / settings.write
backup.read / backup.write
```

权限矩阵：

| 权限 | ADMIN | OPERATOR | VIEWER |
|---|---:|---:|---:|
| provider.read | Y | Y | Y |
| provider.write | Y | N | N |
| route.read | Y | Y | Y |
| route.write | Y | Y | N |
| key.read | Y | Y | Y |
| key.write | Y | Y | N |
| member.read | Y | Y | N |
| member.write | Y | N | N |
| log.read | Y | Y | Y |
| usage.read | Y | Y | Y |
| settings.read | Y | Y | Y |
| settings.write | Y | N | N |
| backup.read | Y | Y | N |
| backup.write | Y | N | N |

---

# Phase 1：多成员控制台 RBAC

## Task 1：数据模型与迁移准备

### 状态
- [ ] 未开始

### 目标
升级 `AdminUser`，支持多成员与角色字段。

### 修改范围
1. `prisma/schema.prisma`

将现有模型：

```prisma
model AdminUser {
  id           String   @id @default(cuid())
  username     String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

调整为：

```prisma
model AdminUser {
  id           String    @id @default(cuid())
  username     String    @unique
  passwordHash String
  displayName  String?
  role         String    @default("VIEWER") // ADMIN | OPERATOR | VIEWER
  enabled      Boolean   @default(true)
  lastLoginAt  DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}
```

### 迁移要求
- 不删除现有管理员数据。
- 已有 `AdminUser` 默认升级为 `ADMIN`。
- 生产/已有库使用 `prisma db push` 或受控 SQL 增列。
- 新库初始化脚本 `prisma/init.sql` 同步更新。

### 验证
```bash
bun x prisma generate
bun x prisma validate
```

### 回退点
```bash
rollback-multiuser-task1-schema
```

---

## Task 2：会话主体与权限中间件

### 状态
- [ ] 未开始

### 目标
会话主体返回真实角色，并提供统一权限检查函数。

### 修改范围
1. `src/lib/gateway/session/session.ts`
2. `src/lib/gateway/console/consoleHelpers.ts`

### 具体要求

#### SessionPrincipal

```ts
export type AdminRole = "ADMIN" | "OPERATOR" | "VIEWER";

export interface SessionPrincipal {
  isMaster: boolean;
  role: AdminRole;
  name: string;
  sessionId: string;
  userId: string;
}
```

- `isMaster` 仅 `ADMIN` 为 `true`。
- `name` 优先 `displayName`，缺省取 `username`。
- `resolveSessionFromToken()` 需要联表或二次查询 `AdminUser`。
- `enabled = false` 的用户会话立即失效。

#### 权限映射

```ts
export const ROLE_PERMISSIONS: Record<AdminRole, string[]> = {
  ADMIN: ["*"],
  OPERATOR: [
    "provider.read",
    "route.read", "route.write",
    "key.read", "key.write",
    "log.read",
    "usage.read",
    "settings.read",
  ],
  VIEWER: [
    "provider.read",
    "route.read",
    "key.read",
    "log.read",
    "usage.read",
    "settings.read",
  ],
};
```

#### 统一检查函数

在 `consoleHelpers.ts` 新增：

```ts
export async function requirePermission(
  request: Request,
  permission: string
): Promise<SessionPrincipal | Response>
```

语义：

- 未登录：`401`
- 登录但权限不足：`403`
- 权限通过：返回 `SessionPrincipal`

### 验证
```bash
bun x tsc --noEmit
```

### 回退点
```bash
rollback-multiuser-task2-permissions
```

---

## Task 3：登录 / 会话状态适配多角色

### 状态
- [ ] 未开始

### 目标
登录、会话、修改密码等接口适配多成员模型。

### 修改范围
1. `src/app/api/console/auth/login/route.ts`
2. `src/app/api/console/auth/session/route.ts`
3. `src/app/api/console/auth/password/route.ts`

### 具体要求

#### 登录
- 禁用用户不允许登录。
- 登录成功更新 `lastLoginAt`。
- 登录响应返回：

```json
{
  "username": "alice",
  "displayName": "Alice",
  "role": "OPERATOR"
}
```

#### 会话状态
`GET /api/console/auth/session` 返回：

```json
{
  "initialized": true,
  "authenticated": true,
  "username": "alice",
  "displayName": "Alice",
  "role": "OPERATOR",
  "authVia": "cookie"
}
```

#### 修改密码
- 任何人只能修改自己的密码。
- `ADMIN` 不能在这里改他人密码；改他人密码走成员管理接口。

### 验证
```bash
bun x tsc --noEmit
```

### 回退点
```bash
rollback-multiuser-task3-auth
```

---

## Task 4：成员管理 API

### 状态
- [ ] 未开始

### 目标
提供轻量成员管理能力，仅 `ADMIN` 可写。

### 建议路由
```text
GET    /api/console/members
POST   /api/console/members
PUT    /api/console/members/:id
POST   /api/console/members/:id/reset-password
POST   /api/console/members/:id/enable
POST   /api/console/members/:id/disable
```

也可以合并为：

```text
GET    /api/console/members
POST   /api/console/members
PUT    /api/console/members
POST   /api/console/members/action
```

优先采用合并式路由，减少动态路由复杂度。

### 返回字段
成员列表不返回密码哈希，仅返回：

```json
{
  "id": "...",
  "username": "alice",
  "displayName": "Alice",
  "role": "OPERATOR",
  "enabled": true,
  "lastLoginAt": "...",
  "createdAt": "...",
  "sessionCount": 2
}
```

### 新增成员
请求：

```json
{
  "username": "alice",
  "displayName": "Alice",
  "role": "OPERATOR",
  "password": "initial-password"
}
```

规则：

- 用户名唯一。
- 密码至少 8 位。
- 角色只允许 `ADMIN | OPERATOR | VIEWER`。
- 操作者必须具备 `member.write`，即 `ADMIN`。

### 编辑成员
允许修改：

```json
{
  "displayName": "Alice",
  "role": "VIEWER",
  "enabled": false
}
```

规则：

- 不能禁用自己。
- 不能降级最后一个启用的 `ADMIN`。
- 不能删除最后一个启用的 `ADMIN`。
- `enabled` 从 `true` 改为 `false` 时，必须删除该成员全部 Session。

### 重置密码
- 仅 `ADMIN`。
- 生成新随机密码或接收显式新密码。
- 成功后删除该成员全部 Session。
- 写审计。

### 审计
所有成员操作写入 `AuditLog`，`operator` 记录当前 `SessionPrincipal.userId` 与用户名。

### 权限检查
```text
GET    members -> member.read
POST   members -> member.write
PUT    members -> member.write
reset-password -> member.write
enable/disable -> member.write
```

### 验证
```bash
bun x tsc --noEmit
```

### 回退点
```bash
rollback-multiuser-task4-member-api
```

---

## Task 5：控制台 UI 与现有 API 权限接入

### 状态
- [ ] 未开始

### 目标
前端支持多成员管理，并对管理操作按角色隐藏/禁用。

### 修改范围
1. `src/components/console/settings.tsx` 或新增 `members-section.tsx`
2. `src/components/console/providers.tsx`
3. `src/components/console/routes.tsx`
4. `src/components/console/keys.tsx`
5. `src/components/console/logs.tsx`
6. `src/components/console/ui.tsx`
7. 控制台页面导航与当前用户信息

### UI 要求

#### 当前用户信息
顶栏显示：

```text
Alice · OPERATOR
```

#### 成员管理
- 仅 `ADMIN` 可见。
- 表格字段：
  - 用户名
  - 显示名
  - 角色
  - 启用状态
  - 最近登录
  - 会话数
- 操作：
  - 新增成员
  - 编辑角色 / 显示名
  - 启用 / 禁用
  - 重置密码
- 禁止对最后一个启用 ADMIN 执行禁用 / 降级。

#### 权限行为
- `VIEWER`：
  - 所有编辑按钮隐藏或禁用。
  - 只保留列表、详情、刷新。
- `OPERATOR`：
  - 可编辑路由和密钥。
  - 不能看到成员管理。
  - 不能修改全局设置。
- `ADMIN`：
  - 全部可见。

#### API 权限接入
以下 API 需要把 `requireSessionOr401()` 替换为 `requirePermission()`：

| API | 权限 |
|---|---|
| `GET /api/console/providers` | `provider.read` |
| `POST /api/console/providers` | `provider.write` |
| `PUT /api/console/providers` | `provider.write` |
| `DELETE /api/console/providers` | `provider.write` |
| `GET /api/console/routes` | `route.read` |
| `POST /api/console/routes` | `route.write` |
| `PUT /api/console/routes` | `route.write` |
| `DELETE /api/console/routes` | `route.write` |
| `GET /api/console/keys` | `key.read` |
| `POST /api/console/keys` | `key.write` |
| `PUT /api/console/keys` | `key.write` |
| `DELETE /api/console/keys` | `key.write` |
| `GET /api/console/logs` | `log.read` |
| `GET /api/console/overview` | `usage.read` |
| `GET /api/console/usage/*` | `usage.read` |
| `GET /api/console/settings` | `settings.read` |
| `PUT /api/console/settings` | `settings.write` |
| backup 相关读写 | `backup.read` / `backup.write` |

### 数据迁移
应用启动或 Task 5 部署时执行一次性迁移：

```ts
// 伪代码
if (adminCount > 0 && adminWithRoleCount === 0) {
  await db.adminUser.updateMany({
    data: { role: "ADMIN" }
  });
}
```

更精确方案：

1. 查询所有 `role is null or role not in (...)` 的用户。
2. 全部设为 `ADMIN`。
3. 保证至少一个启用 `ADMIN`。

### 验证
```bash
bun x eslint src
bun x tsc --noEmit
npm run build
```

### 回退点
```bash
rollback-multiuser-rbac
```

---

# Phase 2：VirtualKey 与日志归属成员

## Task 6：VirtualKey 增加成员归属

### 状态
- [ ] 未开始

### 目标
每把虚拟密钥可归属到成员，便于责任追踪与成员级统计。

### 修改范围
1. `prisma/schema.prisma`
2. `src/app/api/console/keys/route.ts`
3. `src/components/console/keys.tsx`
4. `prisma/init.sql`

### 字段

```prisma
model VirtualKey {
  // 现有字段...
  ownerUserId String?
}
```

### API 要求
- `GET /api/console/keys` 返回：

```json
{
  "id": "...",
  "name": "team-alice",
  "ownerUserId": "...",
  "owner": {
    "id": "...",
    "username": "alice",
    "displayName": "Alice"
  }
}
```

- `POST /api/console/keys` 支持可选 `ownerUserId`。
- `PUT /api/console/keys` 支持修改 `ownerUserId`。
- `ownerUserId` 允许为空。
- `ownerUserId` 必须存在且 `enabled = true`。

### UI 要求
- 创建 / 编辑密钥时增加“负责人”下拉。
- 下拉来源为启用的成员。
- 列表显示负责人。
- 支持按负责人筛选。

### 验证
```bash
bun x prisma generate
bun x tsc --noEmit
```

### 回退点
```bash
rollback-multiuser-task6-key-owner
```

---

## Task 7：RequestLog / UsageDaily 增加成员维度

### 状态
- [ ] 未开始

### 目标
网关调用日志能归到密钥负责人。

### 修改范围
1. `prisma/schema.prisma`
2. `src/lib/gateway/config/requestLog.ts`
3. `src/lib/gateway/exchange/dispatch.ts`
4. 相关日志 API / 用量 API

### 字段

```prisma
model RequestLog {
  // 现有字段...
  ownerUserId String?
}

model UsageDaily {
  // 现有字段...
  ownerUserId String @default("")
}
```

注意：

- `RequestLog.ownerUserId` 可空，旧数据为 `null`。
- `UsageDaily.ownerUserId` 建议默认 `""`，避免破坏现有复合唯一键。
- 若现有 `UsageDaily` 唯一键包含 `day/providerId/apiKeyName/model`，不要贸然把 `ownerUserId` 放进唯一键，否则旧数据会出现重复维度。
- 推荐先作为展示维度，不参与唯一键；`ownerUserId` 由 `apiKeyName → VirtualKey.ownerUserId` 解析。

### 写入链路
`dispatch.ts` 已有 `apiKeyName`。

在写入日志时根据 `apiKeyName` 查一次 `VirtualKey`，解析出 `ownerUserId`。

可做轻量缓存：

```ts
apiKeyName -> { ownerUserId, cachedAt }
```

TTL 建议 30–60 秒，避免每请求查库。

### 验证
```bash
bun x prisma generate
bun x tsc --noEmit
```

### 回退点
```bash
rollback-multiuser-task7-log-owner
```

---

## Task 8：成员筛选与成员禁用联动

### 状态
- [ ] 未开始

### 目标
控制台可按成员查看用量/日志；禁用成员时同步处理其密钥。

### 修改范围
1. `src/app/api/console/logs/route.ts`
2. `src/app/api/console/logs/export/route.ts`
3. `src/app/api/console/usage/daily/route.ts`
4. `src/app/api/console/usage/billing/route.ts`
5. `src/app/api/console/members/*`
6. 日志 / 用量 / 密钥 UI

### 筛选参数
```text
?ownerUserId=xxx
```

### 行为
- 日志列表支持按成员筛选。
- 用量透视支持按成员筛选。
- 月度账单支持按成员筛选。
- 成员禁用时：
  1. 删除该成员全部 Session。
  2. 禁用 `VirtualKey.ownerUserId = member.id` 且 `enabled = true` 的密钥。
  3. 写审计。
- 成员重新启用时不自动恢复其 Key，避免误启用；由管理员手动处理。

### 验证
```bash
bun x tsc --noEmit
```

### 回退点
```bash
rollback-multiuser-key-owner
```

---

# Phase 3：可选增强，不作为本期目标

## Task 9：TOTP 两步验证

### 状态
- [ ] 未开始，暂缓

### 目标
为控制台本地账号增加 TOTP。

### 范围
- `AdminUser.totpSecretEnc`
- `AdminUser.totpEnabled`
- 登录流程增加验证码校验
- 管理员可为自己启用/关闭 TOTP

### 说明
- 不做短信验证。
- 不做强制全员 TOTP 配置，允许全局设置强制开启。

---

## Task 10：邀请链接 / 一次性初始密码

### 状态
- [ ] 未开始，暂缓

### 目标
避免管理员手动传递初始密码。

### 范围
- 生成一次性邀请 token
- 有效期默认 24 小时
- 首次设置密码后失效

---

## Task 11：成员自助用量视图

### 状态
- [ ] 未开始，暂缓

### 目标
普通成员登录后只能查看自己的 Key 与用量。

### 范围
- 新角色 `USER`
- 或给 `VIEWER` 增加“仅看自己资源”模式
- 日志/用量强制追加 `ownerUserId = session.userId`

---

# 实施顺序与提交规范

## 顺序
1. Task 1：schema
2. Task 2：权限核心
3. Task 3：登录/会话
4. Task 4：成员 API
5. Task 5：UI + API 权限接入 + Phase 1 总验收
6. Task 6：Key 归属
7. Task 7：日志归属
8. Task 8：筛选与禁用联动 + Phase 2 总验收

## 每个任务完成标准

每个任务结束前必须执行：

```bash
git diff --check
bun x eslint src
bun x tsc --noEmit
```

涉及构建层的任务额外执行：

```bash
npm run build
```

## Git 回退点

按顺序创建：

```text
rollback-multiuser-plan
rollback-multiuser-task1-schema
rollback-multiuser-task2-permissions
rollback-multiuser-task3-auth
rollback-multiuser-task4-member-api
rollback-multiuser-rbac
rollback-multiuser-task6-key-owner
rollback-multiuser-task7-log-owner
rollback-multiuser-key-owner
```

每个 tag 使用中文说明，例如：

```bash
git tag -a rollback-multiuser-task1-schema -m "回退点：多用户数据模型升级完成"
```

## 推送策略

- 所有任务完成后再一起推送。
- 推送到 `main` 前确认远端没有新的非快进更新。
- 推送命令优先使用 fast-forward：

```bash
git fetch origin
git push origin HEAD:main
```

如远端已变化：

```bash
git fetch origin
git rebase origin/main
# 处理冲突并重新验证后
git push origin HEAD:main
```

---

# 风险与注意事项

## 权限兼容
现有接口大多是 `requireSessionOr401()`，默认所有登录用户等价于管理员。  
接入 RBAC 后必须逐一检查写接口，不能只靠前端隐藏按钮。

## 最后一个管理员保护
必须禁止：

- 禁用最后一个启用 `ADMIN`
- 降级最后一个启用 `ADMIN`
- 删除最后一个启用 `ADMIN`

否则系统失去可管理入口。

## 会话失效
成员禁用、密码重置、角色变更后：

- 禁用：删除全部 Session。
- 重置密码：删除全部 Session。
- 降级角色：不必须删除 Session，但下一次请求会按新角色鉴权。

## 配额兼容
现有配额基于 `apiKeyName`。  
增加 `ownerUserId` 不应改变原配额逻辑，否则可能出现历史数据统计错位。

## 数据库迁移
已有 SQLite 库必须保持数据不丢失。  
增列操作前建议备份数据库文件。

```bash
cp db/custom.db db/custom.db.backup-$(date +%Y%m%d%H%M%S)
```

路径以实际 `.env` 中 `DATABASE_URL` 为准。

---

# 不做的事情

明确不做：

- Organization
- Project
- 多租户
- SSO
- SCIM
- 用户自助注册
- 自定义权限编辑器
- 行级 Provider 授权
- 复杂审批流
