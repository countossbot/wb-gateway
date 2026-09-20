// 配置服务 —— SQLite 持久层 ↔ 引擎内存契约（GatewayConfig 原形态）的双向转换器。
//
// 等价保留原 config.js 的全部行为：
//   1. 60s 内存热缓存 + singleflight 在途去重
//   2. 默认路由回填 backfillMissingRoutes（读路径只增不改）
//   3. 脱敏 redactConfig（SECRET_FIELDS + maskKeyName 虚拟键名掩码）
//   4. 保存回填契约 mergeSecrets / restoreVirtualKeys（界面只显示掩码；
//      保存时未改动的凭据字段必须用 DB 原值回填，绝不允许一次保存清空凭据）
//   5. 写前 schema 校验 validateConfig（返回 400）
//   6. config_version 乐观锁（冲突 409）与版本自增
//   7. 缺失关键密钥拒绝硬编码兜底（DB 中无 master_key 时管理接口报错，不静默降级）
//
// 表结构拆分（不再单个 JSON blob）：
//   Provider / Account / ModelRoute / RouteCandidate / VirtualKey / SystemSetting

import { db } from "@/lib/db";
import type { GatewayConfig, ProviderConfig, AccountConfig, RouteCandidateConfig, VirtualKeyEntry } from "../core/types";
import { refreshRuntimeSettings } from "./runtimeSettings";

export const VERSION = "4.4.0"; // 重构版版本号（原 2.4.0 → Node.js 重构；4.4.0：用量成本估算 —— ModelPricing 模型单价表 + 设置页定价管理（表格编辑/批量粘贴导入/未计价模型一键补录）+ 总览成本卡（今日/近7天成本 + 逐日趋势 + Top 成本模型 + 计价覆盖率）+ 用量透视成本模式与按模型视图 + Top 提供商成本列 + 密钥页 7 天成本 + 日志行级成本徽标）；4.3.2：运维监控体验升级；4.3.1：路由试跑控制台调试工具

// ---- 默认路由表（等价保留原 getDefaultConfig 的 routes；用于读路径回填） ----
export const DEFAULT_ROUTES: Record<string, RouteCandidateConfig[]> = {
  "deepseek-v4.1-flash": [
    { provider: "workbuddy", model: "deepseek-v4.1-flash" },
    { provider: "workbuddy", model: "deepseek-v4-pro" },
    { provider: "workbuddy", model: "deepseek-v4-flash" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
    { provider: "openrouter", model: "deepseek/deepseek-chat" },
  ],
  "deepseek-v4-flash": [
    { provider: "workbuddy", model: "deepseek-v4-flash" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
    { provider: "opencode", model: "mimo-v2.5-free" },
  ],
  "deepseek-v4-pro": [
    { provider: "workbuddy", model: "deepseek-v4-pro" },
    { provider: "workbuddy", model: "deepseek-v4.1-flash" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
    { provider: "openrouter", model: "deepseek/deepseek-r1" },
  ],
  "claude-3-7-sonnet-20250219": [
    { provider: "workbuddy", model: "deepseek-v4.1-flash" },
    { provider: "workbuddy", model: "deepseek-v4-pro" },
    { provider: "workbuddy", model: "deepseek-v4-flash" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
    { provider: "openrouter", model: "anthropic/claude-3.7-sonnet" },
  ],
  "claude-3-5-sonnet-20241022": [
    { provider: "workbuddy", model: "deepseek-v4.1-flash" },
    { provider: "workbuddy", model: "deepseek-v4-pro" },
    { provider: "workbuddy", model: "deepseek-v4-flash" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
    { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
  ],
  "claude-3-5-haiku-20241022": [
    { provider: "workbuddy", model: "deepseek-v4-flash" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
    { provider: "opencode", model: "mimo-v2.5-free" },
  ],
  "claude-3-haiku-20240307": [
    { provider: "workbuddy", model: "deepseek-v4-flash" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
  ],
  "claude-3-opus-20240229": [
    { provider: "workbuddy", model: "deepseek-v4-pro" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "openrouter", model: "anthropic/claude-3-opus" },
  ],
  "glm-5.2": [
    { provider: "workbuddy", model: "glm-5.2" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
  ],
  "kimi-k3-1": [
    { provider: "workbuddy", model: "kimi-k3-1" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
  ],
  "mimo-v2.5-free": [
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
  ],
  "glm-5.2-intl": [
    { provider: "workbuddy-intl", model: "glm-5.2" },
    { provider: "opencode", model: "mimo-v2.5-free" },
  ],
  "qwen3.7-plus-test": [
    { provider: "qwenweb", model: "qwen3.7-plus" },
    { provider: "opencode", model: "mimo-v2.5-free" },
  ],
  "ling-3.0-flash-fin-free": [
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "big-pickle" },
    { provider: "opencode", model: "mimo-v2.5-free" },
  ],
  "big-pickle": [
    { provider: "opencode", model: "big-pickle" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "mimo-v2.5-free" },
  ],
  "nemotron-3-ultra-free": [
    { provider: "opencode", model: "nemotron-3-ultra-free" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
  ],
  "nemotron-3.5-lightning-free": [
    { provider: "opencode", model: "nemotron-3.5-lightning-free" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
  ],
  "muse-spark-1.3": [
    { provider: "opencode", model: "muse-spark-1.3-contributor-free" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
  ],
  "muse-spark-1.3-contributor-free": [
    { provider: "opencode", model: "muse-spark-1.3-contributor-free" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
  ],
  "muse-spark-1.2-contributor-free": [
    { provider: "opencode", model: "muse-spark-1.2-contributor-free" },
    { provider: "opencode", model: "mimo-v2.5-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
  ],
  "deepseek-v4-flash-free": [
    { provider: "opencode", model: "deepseek-v4-flash-free" },
    { provider: "opencode", model: "ling-3.0-flash-fin-free" },
    { provider: "opencode", model: "mimo-v2.5-free" },
  ],
};

// ---- 原生项目预设提供商清单（「新增中转」提供商 ID 下拉框数据源） ----
// 取自原生项目 DEFAULT_ROUTES 引用的全部提供商 ID；排序与展示与原生项目保持一致。
// 选择预设时前端据此自动填充类型 / 区域 / Base URL（均为原生默认值，零映射转换）。
export const NATIVE_PROVIDER_PRESETS: Array<{
  id: string;
  type: string; // 适配器类型（与注册表一致）
  label: string;
  region?: "cn" | "intl"; // workbuddy 专用
  baseUrl?: string; // openai 兼容示例（OpenRouter）专用
}> = [
  { id: "workbuddy", type: "workbuddy", label: "WorkBuddy（国内站）", region: "cn" },
  { id: "workbuddy-intl", type: "workbuddy", label: "WorkBuddy（国际站）", region: "intl" },
  { id: "opencode", type: "opencode", label: "OpenCode Zen 免费池" },
  { id: "openrouter", type: "openai", label: "OpenRouter（OpenAI 兼容）", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "qwenweb", type: "qwenweb", label: "Qwen Web（通义千问网页版）" },
];

// 原生预设 ID → 适配器类型（预设清单的类型分类，用于按类型归组模型目录）
const NATIVE_PRESET_TYPE: Record<string, string> = {
  workbuddy: "workbuddy",
  "workbuddy-intl": "workbuddy",
  opencode: "opencode",
  openrouter: "openai",
  qwenweb: "qwenweb",
};

// ---- 原生模型目录（路由候选「模型」下拉框数据源） ----
// 把 DEFAULT_ROUTES 折叠为 { [适配器类型]: 模型 ID[] }。模型 ID 原样透传
// （沿用原始标识符，不做任何改写 / 转换 / 重新映射），顺序保持原生出现顺序。
export function nativeProviderModels(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const cands of Object.values(DEFAULT_ROUTES)) {
    for (const c of cands) {
      const t = NATIVE_PRESET_TYPE[c.provider];
      if (!t) continue;
      const list = out[t] || (out[t] = []);
      if (!list.includes(c.model)) list.push(c.model);
    }
  }
  return out;
}

// ---- 脱敏契约 ----
// 敏感字段清单：这些值永不通过 API 返回给客户端
const SECRET_FIELDS = ["accessToken", "refreshToken", "apiKey", "cookie", "token", "jwtToken"];
const REDACTED = "***REDACTED***";

function isRedacted(value: unknown): boolean {
  return value === REDACTED || value === "" || value === null || value === undefined;
}

// 遍历 providers 集合，兼容数组与对象两种形态
function eachProvider(providers: unknown, fn: (p: ProviderConfig) => void): void {
  if (!providers) return;
  if (Array.isArray(providers)) (providers as ProviderConfig[]).forEach(fn);
  else if (typeof providers === "object") Object.values(providers as Record<string, ProviderConfig>).forEach(fn);
}

// 递归脱敏任意对象树上的机密字段
function redactNode(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach(redactNode);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const field of SECRET_FIELDS) {
    if (obj[field] !== undefined && obj[field] !== "") obj[field] = REDACTED;
  }
  // provider.config 与多账号 accounts 均可能内嵌机密，递归处理
  for (const key of ["config", "accounts", "account"]) {
    if (obj[key]) redactNode(obj[key]);
  }
}

// virtual_keys 的真实密钥是「对象键名」而非值，直接返回会泄露。
// 读取时只回显键名指纹（前 6 位 + 长度），不回显完整密钥。
export function maskKeyName(key: string): string {
  if (typeof key !== "string" || key.length <= 6) return REDACTED;
  return `${key.slice(0, 6)}…（已隐藏，共 ${key.length} 位）`;
}

function redactVirtualKeys(virtualKeys: Record<string, VirtualKeyEntry>): void {
  if (!virtualKeys || typeof virtualKeys !== "object") return;
  const entries = Object.entries(virtualKeys);
  for (const [key, value] of entries) {
    virtualKeys[maskKeyName(key)] = value;
    delete virtualKeys[key];
  }
}

// 掩码键判定 —— 与 maskKeyName 配对，restoreVirtualKeys 共用。
// 短密钥掩码后就是 REDACTED 本身，长密钥含 "…" 指纹，两者都算掩码。
function isMaskedKeyName(key: string): boolean {
  return key === REDACTED || (typeof key === "string" && key.includes("…"));
}

// virtual_keys 回填：客户端回传的是掩码占位名，若原样落库会把密钥「改名」成掩码，
// 导致鉴权全部失效。此处按位序恢复原名 —— 与 redactVirtualKeys 构成 round-trip，
// 两半的顺序/掩码约定只活在这里，调用方不再各自手写 includes("…") 探测。
function restoreVirtualKeys(
  mergedKeys: Record<string, VirtualKeyEntry>,
  existingKeys: Record<string, VirtualKeyEntry>
): Record<string, VirtualKeyEntry> {
  if (!mergedKeys || typeof mergedKeys !== "object" || !existingKeys) return mergedKeys;
  const oldKeys = Object.keys(existingKeys);
  const newKeys = Object.keys(mergedKeys);
  const allMasked = newKeys.length === oldKeys.length && newKeys.every(isMaskedKeyName);
  if (!allMasked) return mergedKeys;
  const restored: Record<string, VirtualKeyEntry> = {};
  newKeys.forEach((maskedKey, i) => {
    restored[oldKeys[i]] = mergedKeys[maskedKey];
  });
  return restored;
}

// 递归遍历 providers 树，对机密字段做脱敏，返回可安全序列化给客户端的副本
export function redactConfig(config: GatewayConfig): GatewayConfig {
  if (!config || typeof config !== "object") return config;
  const clone = JSON.parse(JSON.stringify(config)) as GatewayConfig;

  eachProvider(clone.providers, redactNode);
  redactVirtualKeys(clone.virtual_keys);
  // 顶层机密一并清除
  for (const field of SECRET_FIELDS) delete (clone as Record<string, unknown>)[field];
  delete clone.cron_secret;
  delete clone.master_key;
  return clone;
}

// 递归回填机密：目标中脱敏/缺失的机密字段沿用来源值
// 注意：调用方只传对象（provider / config / account），数组由下面的 accounts id 匹配专管，
// 这里不处理数组形态——不要加通用下标回填，那会把轮换后的账号凭据错位。
function mergeNode(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return;
  if (Array.isArray(target) || Array.isArray(source)) return;
  for (const field of SECRET_FIELDS) {
    if (isRedacted(target[field]) && !isRedacted(source[field])) {
      target[field] = source[field];
    }
  }
  // provider.config / accounts 均需递归回填
  for (const key of ["config", "account"]) {
    if (target[key]) mergeNode(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
  }
  // accounts 按 account.id 语义匹配回填，而不是数组下标
  if (Array.isArray(target.accounts) && Array.isArray(source.accounts)) {
    const sourceById = new Map<string, Record<string, unknown>>();
    for (const acc of source.accounts as Record<string, unknown>[]) {
      if (acc?.id) sourceById.set(acc.id as string, acc);
    }
    for (const targetAcc of target.accounts as Record<string, unknown>[]) {
      if (targetAcc?.id && sourceById.has(targetAcc.id as string)) {
        mergeNode(targetAcc, sourceById.get(targetAcc.id as string)!);
      }
    }
  }
}

// 合并式写入的机密回填：新配置中脱敏/缺失的机密字段沿用旧值
function mergeSecrets(existing: GatewayConfig | null, incoming: GatewayConfig): GatewayConfig {
  if (!incoming || typeof incoming !== "object") return incoming;
  const merged = JSON.parse(JSON.stringify(incoming)) as GatewayConfig;
  const oldProviders = existing?.providers;

  // 按 provider.id 建立旧值索引，兼容数组与对象两种形态
  const oldById: Record<string, ProviderConfig> = {};
  eachProvider(oldProviders, (p) => {
    if (p?.id) oldById[p.id] = p;
  });

  eachProvider(merged.providers, (provider) => {
    const source = provider?.id ? oldById[provider.id] : undefined;
    if (source) mergeNode(provider as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>);
  });

  // 顶层机密（cron_secret / master_key / 任何 SECRET_FIELDS）同样回填
  for (const field of [...SECRET_FIELDS, "cron_secret", "master_key"]) {
    const mergedObj = merged as Record<string, unknown>;
    if (isRedacted(mergedObj[field]) && (existing as Record<string, unknown>)?.[field] !== undefined) {
      mergedObj[field] = (existing as Record<string, unknown>)[field];
    }
  }

  // virtual_keys 的真实密钥是键名：客户端回传的是掩码占位名，用 restoreVirtualKeys
  // 按位序恢复原名（与 redactVirtualKeys 配对，约定只活在那一对函数里）。
  if (merged.virtual_keys && typeof merged.virtual_keys === "object" && existing?.virtual_keys) {
    merged.virtual_keys = restoreVirtualKeys(merged.virtual_keys, existing.virtual_keys);
  }

  return merged;
}

// ---- 校验 ----
// 配置 schema 校验：在写入边界拦截畸形配置，避免请求期才报 502。
// 返回错误消息数组；空数组表示通过。
export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") {
    return ["config must be an object"];
  }
  const cfg = config as GatewayConfig;
  // provider id 集合只构建一次，供「重复 id 检测」与「routes 引用校验」复用
  const providerIds = new Set<string>();
  if (!Array.isArray(cfg.providers) && !(cfg.providers && typeof cfg.providers === "object")) {
    errors.push("providers must be an array or object");
  } else {
    const seenAccountIds = new Set<string>();
    eachProvider(cfg.providers, (provider) => {
      if (!provider || typeof provider !== "object") {
        errors.push("providers must contain provider objects");
        return;
      }
      const pid = provider.id || "<unknown>";
      if (!provider.id || typeof provider.id !== "string") {
        errors.push("provider.id is required");
      } else {
        if (providerIds.has(provider.id)) {
          errors.push(`duplicate provider id "${provider.id}"`);
        }
        providerIds.add(provider.id);
      }
      // Note: provider.type validation is done at createProvider time, not validate time
      // to maintain backward compatibility with tests that omit type in initial saves
      if (provider.enabled !== false) {
        const accounts = (provider.config as Record<string, unknown>)?.accounts as AccountConfig[] | undefined;
        if (Array.isArray(accounts) && accounts.length === 0) {
          errors.push(`provider "${pid}" has zero accounts`);
        }
        if (Array.isArray(accounts)) {
          accounts.forEach((account, i) => {
            if (!account || typeof account !== "object") {
              errors.push(`provider "${pid}" account[${i}] must be an object`);
              return;
            }
            if (!account.id || typeof account.id !== "string") {
              errors.push(`provider "${pid}" account[${i}] is missing id`);
              return;
            }
            const accountKey = `${pid}:${account.id}`;
            if (seenAccountIds.has(accountKey)) {
              errors.push(`provider "${pid}" has duplicate account id "${account.id}"`);
            }
            seenAccountIds.add(accountKey);
          });
        }
      }
    });
  }
  if (!cfg.routes || typeof cfg.routes !== "object" || Array.isArray(cfg.routes)) {
    errors.push("routes must be an object mapping model name -> route array");
  } else {
    for (const [model, routeList] of Object.entries(cfg.routes)) {
      if (!Array.isArray(routeList) || routeList.length === 0) {
        errors.push(`routes["${model}"] must be a non-empty array`);
        continue;
      }
      routeList.forEach((r, i) => {
        if (!r || typeof r !== "object") {
          errors.push(`routes["${model}"][${i}] must be an object`);
        } else if (!r.provider || typeof r.provider !== "string") {
          errors.push(`routes["${model}"][${i}] missing string "provider"`);
        } else if (!providerIds.has(r.provider)) {
          errors.push(`routes["${model}"][${i}] references unknown provider "${r.provider}"`);
        }
      });
    }
  }
  return errors;
}

// 纯函数：用代码默认路由回填存量配置里缺失的路由（只增不改）。
// 背景：配置一旦写入 DB 就盖住代码默认，后续发版新增路由对存量环境不可见。
// 本函数让读路径自动补齐缺失项，各环境无需动线上密钥。
// 约束：只补「引用 provider 在存量配置里全部存在」的路由；空 provider 配置保持原样。
export function backfillMissingRoutes(stored: GatewayConfig): GatewayConfig {
  if (!stored || typeof stored !== "object") return stored;
  const storedRoutes = stored.routes;
  if (!storedRoutes || typeof storedRoutes !== "object" || Array.isArray(storedRoutes)) return stored;
  const providerIds = new Set<string>();
  eachProvider(stored.providers, (p) => {
    if (p?.id) providerIds.add(p.id);
  });
  let added = 0;
  for (const [model, routeList] of Object.entries(DEFAULT_ROUTES)) {
    if (storedRoutes[model] !== undefined) continue;
    if (!Array.isArray(routeList) || routeList.length === 0) continue;
    if (!routeList.every((r) => r && typeof r.provider === "string" && providerIds.has(r.provider))) continue;
    storedRoutes[model] = JSON.parse(JSON.stringify(routeList));
    added++;
  }
  if (added > 0) console.log(`[Config] Backfilled ${added} missing route(s) from code defaults`);
  return stored;
}

// ---- DB → 引擎内存契约 ----
async function dbToConfigRaw(): Promise<GatewayConfig> {
  const [providers, accounts, routes, candidates, virtualKeys, settings] = await Promise.all([
    db.provider.findMany({ orderBy: { sortOrder: "asc" } }),
    db.account.findMany(),
    db.modelRoute.findMany({ orderBy: { id: "asc" } }),
    db.routeCandidate.findMany({ orderBy: { sortOrder: "asc" } }),
    db.virtualKey.findMany(),
    db.systemSetting.findMany(),
  ]);

  const settingsMap: Record<string, unknown> = {};
  for (const s of settings) settingsMap[s.key] = s.value;

  // accounts 按 providerId 分组，凭据展开进 provider.config.accounts
  const accountsByProvider = new Map<string, AccountConfig[]>();
  for (const acc of accounts) {
    const creds = (acc.credentials as Record<string, unknown>) || {};
    const entry: AccountConfig = {
      id: acc.id,
      name: acc.name || acc.id,
      enabled: acc.enabled,
      ...creds,
    };
    const list = accountsByProvider.get(acc.providerId) || [];
    list.push(entry);
    accountsByProvider.set(acc.providerId, list);
  }

  const providerConfigs: ProviderConfig[] = providers.map((p) => {
    const cfg = (p.config as Record<string, unknown>) || {};
    const accountsList = accountsByProvider.get(p.id);
    const mergedConfig: Record<string, unknown> = { ...cfg };
    if (accountsList) {
      mergedConfig.accounts = accountsList;
    }
    // 提供商级代理覆盖（provider.proxyOverride → 引擎 config 透传，fetchWithProxy 作用域消费）
    if (p.proxyOverride !== null && p.proxyOverride !== undefined) {
      mergedConfig.proxyOverride = p.proxyOverride;
    }
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      enabled: p.enabled,
      config: mergedConfig,
    };
  });

  // routes: { model: [{provider, model}] }
  const routesMap: Record<string, RouteCandidateConfig[]> = {};
  const candidatesByRoute = new Map<number, RouteCandidateConfig[]>();
  for (const c of candidates) {
    if (!c.enabled) continue;
    const list = candidatesByRoute.get(c.routeId) || [];
    list.push({ provider: c.providerId, model: c.model });
    candidatesByRoute.set(c.routeId, list);
  }
  for (const r of routes) {
    if (!r.enabled) continue;
    const list = candidatesByRoute.get(r.id);
    if (list && list.length > 0) routesMap[r.model] = list;
  }

  // virtual_keys: { key: {name, enabled, models, role, remark, dailyRequestLimit, dailyTokenLimit} }
  const virtualKeysMap: Record<string, VirtualKeyEntry> = {};
  for (const vk of virtualKeys) {
    virtualKeysMap[vk.keyValue] = {
      name: vk.name,
      enabled: vk.enabled,
      models: (vk.models as string[]) || ["*"],
      role: vk.role,
      ...(vk.remark ? { remark: vk.remark } : {}),
      // v4.3.0：日配额随配置下发（0 = 不限额；变更经 invalidateConfigChanged 传播）
      ...(vk.dailyRequestLimit > 0 ? { dailyRequestLimit: vk.dailyRequestLimit } : {}),
      ...(vk.dailyTokenLimit > 0 ? { dailyTokenLimit: vk.dailyTokenLimit } : {}),
    };
  }

  const config: GatewayConfig = {
    config_version: Number(settingsMap.config_version) || 1,
    master_key: (settingsMap.master_key as string) || "",
    cron_secret: (settingsMap.cron_secret as string) || "",
    max_context_turns: settingsMap.max_context_turns !== undefined ? Number(settingsMap.max_context_turns) : 0,
    usage_provider_id: (settingsMap.usage_provider_id as string) || "workbuddy",
    providers: providerConfigs,
    routes: routesMap,
    virtual_keys: virtualKeysMap,
  };
  return config;
}

// ---- 缓存 + singleflight（在途刷新去重） ----
let cachedConfig: GatewayConfig | null = null;
let cachedConfigTimestamp = 0;
let cachedConfigVersion: number | null = null; // v3.1.0：跨模块失效校验锚点
const CONFIG_CACHE_TTL_MS = 60 * 1000; // 60 秒内存热缓存
let inflightConfigRefresh: Promise<GatewayConfig> | null = null;

// v3.1.0（修复）：控制台写路径 invalidateConfigChanged 只能清「自己模块图」里的 cachedConfig ——
// Next dev（Turbopack）按路由拆分模块图，网关路由可能仍持有另一实例的旧配置，
// 导致控制台改完路由/提供商后网关最长 60s 不生效（实测复现：新增 mock-chat 路由后 chat 404）。
// 修复：TTL 内命中时用 DB config_version（主键点查，SQLite 本地极廉价）交叉校验，
// 版本不一致（被其它模块图实例失效过）立即穿透刷新。生产单实例模式下该校验零成本兼容。
async function cachedVersionMatchesDb(): Promise<boolean> {
  if (cachedConfigVersion === null) return true; // 无锚点（老缓存）→ 维持原语义
  try {
    const row = await db.systemSetting.findUnique({
      where: { key: "config_version" },
      select: { value: true },
    });
    return Number(row?.value ?? 1) === cachedConfigVersion;
  } catch {
    return true; // 查询异常时不放大故障，维持缓存
  }
}

export async function getConfig(forceRefresh = false): Promise<GatewayConfig> {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && now - cachedConfigTimestamp < CONFIG_CACHE_TTL_MS) {
    if (await cachedVersionMatchesDb()) {
      return cachedConfig;
    }
    // 版本不一致 → 落入下方刷新逻辑
  }
  if (!inflightConfigRefresh) {
    inflightConfigRefresh = refreshConfig().finally(() => {
      inflightConfigRefresh = null;
    });
  }
  return inflightConfigRefresh;
}

async function refreshConfig(): Promise<GatewayConfig> {
  const now = Date.now();
  const config = await dbToConfigRaw();
  // 存量 DB 可能落后于代码默认路由：内存中回填缺失项（不写库，无版本冲突）。
  try {
    backfillMissingRoutes(config);
  } catch {
    /* noop */
  }
  cachedConfig = config;
  cachedConfigTimestamp = now;
  cachedConfigVersion = config.config_version; // v3.1.0：记录锚点供跨模块失效校验
  return config;
}

// ---- 保存（引擎形态 → 各表差量写） ----
export class ConfigError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function saveConfig(newConfig: GatewayConfig): Promise<boolean> {
  const existing = await dbToConfigRaw();

  // 版本冲突检测：如果新配置提供了 config_version 且不匹配当前版本，返回 409
  if (newConfig.config_version !== undefined && existing.config_version !== undefined) {
    if (newConfig.config_version !== existing.config_version) {
      throw new ConfigError("Config version conflict: another client modified the config", 409);
    }
  }

  // 合并式写入：客户端省略或传回脱敏占位符的机密字段，保留 DB 中的原值，
  // 避免一次配置 POST 静默抹掉所有凭据（验收要求三.6 的核心契约）。
  const merged = mergeSecrets(existing, newConfig);

  // 写入前校验，拦截畸形配置。唯一的校验入口：错误带 400 状态，
  // 由调用方（admin catch）映射为 HTTP 状态，避免「校验了两遍、状态码两处定」的分裂。
  const validationErrors = validateConfig(merged);
  if (validationErrors.length > 0) {
    throw new ConfigError("Invalid config: " + validationErrors.join("; "), 400);
  }

  // ---- 差量写回各表 ----
  await persistConfigToDb(merged);

  // 递增版本号（写库后新读到的 config_version 即为新值）
  const newVersion = (existing.config_version || 0) + 1;
  await db.systemSetting.upsert({
    where: { key: "config_version" },
    create: { key: "config_version", value: newVersion as never },
    update: { value: newVersion as never },
  });

  // 立即热同步当前进程内存缓存与运行时设置
  cachedConfig = null; // 失效，下次读取穿透
  await refreshConfig();
  await refreshRuntimeSettings();
  return true;
}

// 引擎形态 → 各表（providers / accounts / routes / candidates / virtual_keys / settings）
async function persistConfigToDb(config: GatewayConfig): Promise<void> {
  const providers: ProviderConfig[] = Array.isArray(config.providers)
    ? config.providers
    : Object.values(config.providers || {});
  const existingProviders = await db.provider.findMany({ select: { id: true } });
  const existingIds = new Set(existingProviders.map((p) => p.id));

  // 1. providers + accounts
  let sortOrder = 0;
  const keepProviderIds = new Set<string>();
  for (const p of providers) {
    if (!p?.id) continue;
    keepProviderIds.add(p.id);
    const { accounts, proxyOverride, ...restConfig } = ((p.config as Record<string, unknown>) || {}) as {
      accounts?: AccountConfig[];
      proxyOverride?: string | null;
      [key: string]: unknown;
    };
    // 账号凭据：单账号形态（config.userId 三件套）折叠为一个 "primary" 账号
    let accountList: AccountConfig[] = Array.isArray(accounts) ? accounts : [];
    if (!Array.isArray(accounts)) {
      const hasSingle = restConfig.userId || restConfig.accessToken || restConfig.refreshToken;
      if (hasSingle) {
        accountList = [
          {
            id: "primary",
            name: "主账号",
            enabled: true,
            userId: restConfig.userId as string,
            accessToken: restConfig.accessToken as string,
            refreshToken: restConfig.refreshToken as string,
          },
        ];
      }
    }

    await db.provider.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        name: p.name || p.id,
        type: p.type || "openai",
        enabled: p.enabled !== false,
        sortOrder: sortOrder++,
        config: restConfig as never,
        proxyOverride: (proxyOverride as string | null) ?? null,
      },
      update: {
        name: p.name || p.id,
        type: p.type || "openai",
        enabled: p.enabled !== false,
        sortOrder: sortOrder - 1,
        config: restConfig as never,
        proxyOverride: (proxyOverride as string | null) ?? null,
      },
    });

    // 账号差量：upsert 提供的，删除缺失的
    const existingAccounts = await db.account.findMany({ where: { providerId: p.id }, select: { id: true } });
    const existingAccountIds = new Set(existingAccounts.map((a) => a.id));
    const keepAccountIds = new Set<string>();
    for (const acc of accountList) {
      if (!acc?.id) continue;
      keepAccountIds.add(acc.id);
      const { id, name, enabled, ...credentials } = acc as AccountConfig & Record<string, unknown>;
      await db.account.upsert({
        where: { providerId_id: { providerId: p.id, id: acc.id } },
        create: {
          id: acc.id,
          providerId: p.id,
          name: (name as string) || acc.id,
          enabled: enabled !== false,
          credentials: credentials as never,
        },
        update: {
          name: (name as string) || acc.id,
          enabled: enabled !== false,
          credentials: credentials as never,
        },
      });
    }
    for (const aid of existingAccountIds) {
      if (!keepAccountIds.has(aid)) {
        await db.account.delete({ where: { providerId_id: { providerId: p.id, id: aid } } });
      }
    }
  }
  // 删除被移除的 providers（级联删除账号）
  for (const pid of existingIds) {
    if (!keepProviderIds.has(pid)) {
      await db.provider.delete({ where: { id: pid } });
    }
  }

  // 2. routes + candidates（全量重建：路由列表无差量语义，直接重写）
  await db.modelRoute.deleteMany({});
  for (const [model, routeList] of Object.entries(config.routes || {})) {
    if (!Array.isArray(routeList) || routeList.length === 0) continue;
    const route = await db.modelRoute.create({
      data: { model, enabled: true },
    });
    let candOrder = 0;
    for (const rc of routeList) {
      if (!rc?.provider) continue;
      await db.routeCandidate.create({
        data: {
          routeId: route.id,
          providerId: rc.provider,
          model: rc.model,
          enabled: true,
          sortOrder: candOrder++,
        },
      });
    }
  }

  // 3. virtual_keys
  const existingKeys = await db.virtualKey.findMany({ select: { keyValue: true } });
  const existingKeyValues = new Set(existingKeys.map((k) => k.keyValue));
  const keepKeyValues = new Set<string>();
  for (const [key, entry] of Object.entries(config.virtual_keys || {})) {
    keepKeyValues.add(key);
    await db.virtualKey.upsert({
      where: { keyValue: key },
      create: {
        name: entry?.name || "Client Key",
        keyValue: key,
        keyPrefix: key.slice(0, 6),
        enabled: entry?.enabled !== false,
        models: (entry?.models || ["*"]) as never,
        role: entry?.role || "client",
        remark: entry?.remark || null,
        // v4.3.0：配额随 entry 全量覆盖（GET 返回含配额 → 回环 POST 自然保留；显式 0 清除限额）
        dailyRequestLimit: Math.max(0, Math.floor(Number(entry?.dailyRequestLimit) || 0)),
        dailyTokenLimit: Math.max(0, Math.floor(Number(entry?.dailyTokenLimit) || 0)),
      },
      update: {
        name: entry?.name || "Client Key",
        enabled: entry?.enabled !== false,
        models: (entry?.models || ["*"]) as never,
        role: entry?.role || "client",
        remark: entry?.remark || null,
        dailyRequestLimit: Math.max(0, Math.floor(Number(entry?.dailyRequestLimit) || 0)),
        dailyTokenLimit: Math.max(0, Math.floor(Number(entry?.dailyTokenLimit) || 0)),
      },
    });
  }
  for (const kv of existingKeyValues) {
    if (!keepKeyValues.has(kv)) {
      await db.virtualKey.delete({ where: { keyValue: kv } });
    }
  }

  // 4. 顶层设置键
  const topKeys: Array<[string, unknown]> = [
    ["master_key", config.master_key || ""],
    ["cron_secret", config.cron_secret || ""],
    ["max_context_turns", config.max_context_turns ?? 0],
    ["usage_provider_id", config.usage_provider_id || "workbuddy"],
  ];
  for (const [key, value] of topKeys) {
    if (value === undefined || value === null || value === "") continue; // 空 = 未提供，保留原值
    await db.systemSetting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
  }
}

// ---- 初始化种子（首次启动引导用） ----
export async function isDatabaseSeeded(): Promise<boolean> {
  const providers = await db.provider.count();
  const keys = await db.virtualKey.count();
  return providers > 0 || keys > 0;
}

// 确保系统密钥存在（master_key / cron_secret 初始化时若缺失则生成强随机值）
export async function ensureSystemSecrets(): Promise<{ master_key: string; cron_secret: string }> {
  const getOrCreate = async (key: string, generate: () => string): Promise<string> => {
    const row = await db.systemSetting.findUnique({ where: { key } });
    if (row && typeof row.value === "string" && (row.value as string).length >= 16) {
      return row.value as string;
    }
    const value = generate();
    await db.systemSetting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
    return value;
  };
  const randomSecret = (prefix: string) =>
    prefix + "_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const masterKey = await getOrCreate("master_key", () => randomSecret("uag-master"));
  const cronSecret = await getOrCreate("cron_secret", () => randomSecret("uag-cron"));
  return { master_key: masterKey, cron_secret: cronSecret };
}

// ---- 配置失效通知（控制台 CRUD 写路径调用）----
// 语义与 saveConfig 等价：bump config_version（fleet 按 version 判等 → 下次重建 provider 实例）
// + 失效内存缓存 + 主动重置 fleet 单例。
// 不做这一步的话，控制台新增的提供商不会进入调度引擎（providers_count 停留在旧值）。
export async function invalidateConfigChanged(): Promise<void> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: "config_version" } });
    const newVersion = Number(row?.value ?? 1) + 1;
    await db.systemSetting.upsert({
      where: { key: "config_version" },
      create: { key: "config_version", value: newVersion as never },
      update: { value: newVersion as never },
    });
    cachedConfig = null;
    cachedConfigVersion = null; // v3.1.0：本实例锚点一并失效
    const { resetFleetForTest } = await import("../core/fleet");
    resetFleetForTest();
  } catch (e) {
    console.error("[Config] invalidateConfigChanged failed:", e);
  }
}

// 测试隔离
export function resetConfigCacheForTest(): void {
  cachedConfig = null;
  cachedConfigTimestamp = 0;
}
