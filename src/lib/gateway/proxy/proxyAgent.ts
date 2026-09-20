// 全局代理层 —— 所有出站请求的统一入口（原项目仅 opencode 有代理池轮换，此处全局化）。
//
// 能力：
// 1. 协议：http、https、socks5、socks5h（远程 DNS 解析）；支持 user:pass@host:port 与分字段
// 2. 代理池：逗号 / 分号 / 换行分隔多地址；上游限流（429）时自动轮换到下一个（原 opencode 行为全局化）
// 3. 作用域：全部出站请求 —— 提供商调用、余额与积分查询、签到、令牌续签、免费模型拉取、连通性测试
// 4. 两层覆盖：全局默认代理 + 提供商级覆盖（自有代理 / "direct" 直连）；支持绕过列表（指定域名直连）
// 5. 优先级：设置页配置 > 环境变量（HTTP_PROXY/HTTPS_PROXY/NO_PROXY）> 直连
// 6. 热生效：配置保存在内存 runtimeSettings（saveConfig 时同步刷新），无需重启
//
// 实现要点：Node 原生 fetch 不支持代理，HTTP/HTTPS 通过 undici ProxyAgent 注入 dispatcher，
// SOCKS 协议走 fetch-socks 的 socksDispatcher（原生 undici Dispatcher 适配，v3.6.0 起）；
// 不替换全局 fetch，仅在 fetchWithProxy 出口显式传 dispatcher。

import { ProxyAgent, Agent, type Dispatcher } from "undici";
// v3.6.0 修复：socks-proxy-agent 实现的是 node:http Agent 而非 undici Dispatcher，
// 直接当 dispatcher 传给 undici fetch 会抛 "agent.dispatch is not a function"
// （所有 SOCKS 出站全断的潜伏 bug）。改用 fetch-socks 的 socksDispatcher（原生 undici Dispatcher 适配）。
import { socksDispatcher } from "fetch-socks";
import { BoundedMap } from "../core/boundedMap";

export interface ProxyConfig {
  enabled: boolean;
  // 多地址池：逗号/分号/换行分隔（保留原 opencode 代理池轮换语义）
  list: string;
  bypass: string[]; // 绕过列表：命中的主机名直连
  // 测试结果缓存（最近一次 /console/api/proxy/test 写入，供总览展示）
  lastTest?: {
    ok: boolean;
    exitIp?: string;
    elapsedMs?: number;
    error?: string;
    at: string;
  } | null;
}

// ---- 代理池轮换状态（进程级，与原 opencode 实例行为等价） ----
let poolRotateIndex = 0;

export function parseProxyList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return (raw as unknown[]).map((s) => String(s).trim()).filter(Boolean);
  return String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 解析单个代理地址 → { protocol, auth? }；socks5h 表示远程 DNS 解析
export function parseProxyUrl(
  url: string
): { protocol: string; host: string; port: string; username?: string; password?: string } | null {
  try {
    const u = new URL(url);
    const protocol = u.protocol.replace(":", "").toLowerCase();
    if (!["http", "https", "socks5", "socks5h"].includes(protocol)) return null;
    return {
      protocol,
      host: u.hostname,
      port: u.port || (protocol.startsWith("socks") ? "1080" : protocol === "https" ? "443" : "80"),
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return null;
  }
}

// ---- Dispatcher 缓存：同地址复用连接池 ----
// v3.9.3：BoundedMap 有界化（上限 1000；动态代理池可被外部输入枚举撑爆）。
// 驱逐时必须先 close() 再移除（参照 invalidateProxyDispatchers 的清理语义），
// 否则连接池泄漏；undici close 二次调用安全，驱逐进行中请求的地址概率极低
// （正常部署仅 1~3 个代理地址，驱逐仅在超 1000 条目时发生）。
const dispatcherCache = new BoundedMap<string, Dispatcher>({
  maxEntries: 1000,
  onEvict: (_url, d) => {
    try {
      (d as { close?: () => void }).close?.();
    } catch {
      /* close 失败不影响驱逐（GC 兑底） */
    }
  },
});

function getDispatcher(proxyUrl: string): Dispatcher | null {
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) return cached;

  const parsed = parseProxyUrl(proxyUrl);
  if (!parsed) return null;

  let dispatcher: Dispatcher | null = null;
  if (parsed.protocol === "socks5" || parsed.protocol === "socks5h") {
    // v3.6.0 修复：socksDispatcher 原生实现 undici Dispatcher（socks5h = 远程 DNS 解析）；
    // 此前的 SocksProxyAgent 是 node:http Agent，undici fetch 调用其 dispatch() 直接抛错
    dispatcher = socksDispatcher({
      type: 5,
      host: parsed.host,
      port: parseInt(parsed.port, 10) || 1080,
      userId: parsed.username,
      password: parsed.password,
    }) as unknown as Dispatcher;
  } else {
    dispatcher = new ProxyAgent({
      uri: proxyUrl.startsWith("https://") || proxyUrl.startsWith("http://") ? proxyUrl : `http://${proxyUrl}`,
      // Token/连接池保活：签到与长流式共用
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
  }
  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

// 测试/配置变更后清理旧 dispatcher（热生效：不重启进程换代理）
// v3.9.3：clear() 已通过 onEvict 逐个 close（BoundedMap 语义），不再手动遍历
export function invalidateProxyDispatchers(): void {
  dispatcherCache.clear();
  poolRotateIndex = 0;
}

// 限流时轮换到代理池下一个地址（原 opencode rotateProxy 全局化）
export function rotateProxyPool(): void {
  poolRotateIndex += 1;
}

// ---- 作用域解析 ----
export interface OutboundScope {
  // 提供商级覆盖：null=跟随全局；"direct"=直连；其他=专属代理池字符串
  providerOverride?: string | null;
  providerId?: string;
}

import { getRuntimeSettings, type RuntimeSettingsShape } from "../config/runtimeSettings";

// 解析某次出站请求应使用的代理地址（单个）；返回 null 表示直连。
// 优先级：提供商覆盖 > 全局设置 > 环境变量基线 > 直连。
// 绕过列表（bypass + NO_PROXY 语义）：目标主机命中则直连。
function resolveProxyFor(targetUrl: string, scope: OutboundScope | null): string | null {
  const settings = getRuntimeSettings();
  const proxyConf: ProxyConfig | null = (settings as RuntimeSettingsShape).proxy || null;

  let pool: string[] = [];
  if (scope?.providerOverride === "direct") {
    return null; // 提供商显式直连
  }
  if (scope?.providerOverride) {
    pool = parseProxyList(scope.providerOverride); // 提供商专属代理池
  } else if (proxyConf?.enabled && proxyConf.list) {
    pool = parseProxyList(proxyConf.list); // 全局代理池
  } else {
    // 环境变量基线（HTTP_PROXY / HTTPS_PROXY）
    const envProxy =
      targetUrl.startsWith("https:") ? process.env.HTTPS_PROXY || process.env.https_proxy : process.env.HTTP_PROXY || process.env.http_proxy;
    pool = envProxy ? [envProxy] : [];
  }
  if (pool.length === 0) return null;

  // 绕过列表（设置页 bypass + 环境 NO_PROXY），命中直连
  const bypass = [...(proxyConf?.bypass || [])];
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (noProxy) bypass.push(...noProxy.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    for (const pattern of bypass) {
      const p = pattern.toLowerCase();
      if (p === "*" || host === p || host.endsWith("." + p.replace(/^\./, ""))) return null;
    }
  } catch {
    /* noop */
  }

  // 池轮换落点：多地址时按当前轮换指针取模（限流触发 rotateProxyPool 推进）
  return pool[poolRotateIndex % pool.length];
}

/**
 * 统一出站 fetch：注入代理 dispatcher，其余语义与原生 fetch 一致。
 * 所有上游调用（callChat / 余额 / 签到 / 续签 / 模型拉取 / 连通性测试）必须走此出口。
 */
export async function fetchWithProxy(
  url: string,
  init: RequestInit = {},
  scope: OutboundScope | null = null
): Promise<Response> {
  const proxyUrl = resolveProxyFor(url, scope);
  if (!proxyUrl) {
    return fetch(url, init);
  }
  const dispatcher = getDispatcher(proxyUrl);
  if (!dispatcher) {
    return fetch(url, init);
  }
  // undici fetch：显式传 dispatcher，不污染全局
  const { fetch: undiciFetch } = await import("undici");
  const fetchInit = init as Record<string, unknown>;
  const initWithDispatcher: Record<string, unknown> = { ...fetchInit, dispatcher };
  return (await undiciFetch(url, initWithDispatcher as never)) as unknown as Response;
}

/**
 * 代理连通性测试：实测一次出站请求，回显出口 IP 与耗时；
 * 失败时区分 DNS 解析失败 / 代理认证失败 / 连接超时 / 其他。
 *
 * v3.6.0：新增 draft 草稿模式 —— 设置页「测试代理（按当前草稿）」在保存前即可实测：
 *   - draft.list 非空：逐个地址并行实测（cap 5，含掩码，不回显凭据），
 *     每地址 8s 超时；主结果 ok = 任一地址通过，exitIp 取首个通过地址的出口。
 *   - draft.list 为空：等同直连出口测试（与保存空列表语义一致）。
 *   - 无 draft：按当前生效配置实测（历史行为，提供商作用域测试等场景复用）。
 */
export interface ProxyDraftTest {
  list: string[];
  bypass: string[];
}

export interface ProxyAddressTestResult {
  /** 掩码后的地址（protocol://host:port，不回显凭据） */
  masked: string;
  ok: boolean;
  elapsedMs: number;
  exitIp?: string;
  error?: string;
}

export async function testProxy(
  targetUrl = "https://api.ipify.org/?format=json",
  scope: OutboundScope | null = null,
  draft?: ProxyDraftTest | null
): Promise<{
  ok: boolean;
  exitIp?: string;
  elapsedMs: number;
  error?: string;
  detail?: string;
  /** v3.6.0：draft 模式下的逐地址实测明细（按输入顺序；直连模式无此字段） */
  pool?: ProxyAddressTestResult[];
}> {
  // ---- v3.6.0：草稿模式 —— 逐地址并行实测（绕过全局配置，测的就是用户输入） ----
  if (draft && draft.list.length > 0) {
    const targets = draft.list.slice(0, 5); // 防御：超长池只测前 5 个
    const startedAt = Date.now();
    const results = await Promise.all(
      targets.map(async (addr): Promise<ProxyAddressTestResult> => {
        const t0 = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const res = await fetchViaExplicitProxy(addr, targetUrl, controller.signal);
          clearTimeout(timer);
          const elapsed = Date.now() - t0;
          if (!res.ok) {
            return { masked: maskProxyAddr(addr), ok: false, elapsedMs: elapsed, error: `HTTP ${res.status}` };
          }
          const text = await res.text();
          let exitIp: string | undefined;
          try {
            exitIp = JSON.parse(text)?.ip || text.trim().slice(0, 64);
          } catch {
            exitIp = text.trim().slice(0, 64);
          }
          return { masked: maskProxyAddr(addr), ok: true, elapsedMs: elapsed, exitIp };
        } catch (err) {
          return {
            masked: maskProxyAddr(addr),
            ok: false,
            elapsedMs: Date.now() - t0,
            error: summarizeProxyError(err),
          };
        }
      })
    );
    const passed = results.filter((r) => r.ok);
    return {
      ok: passed.length > 0,
      exitIp: passed[0]?.exitIp,
      elapsedMs: Date.now() - startedAt,
      error: passed.length === 0 ? results[0]?.error || "全部地址实测失败" : undefined,
      pool: results,
    };
  }

  // ---- 直连模式（草稿为空 = 测直连出口；或无 draft 且命中 bypass） ----
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetchWithProxy(targetUrl, { signal: controller.signal }, scope);
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, elapsedMs: elapsed, error: `HTTP ${res.status}`, detail: await res.text().catch(() => "") };
    }
    const text = await res.text();
    let exitIp: string | undefined;
    try {
      exitIp = JSON.parse(text)?.ip || text.trim().slice(0, 64);
    } catch {
      exitIp = text.trim().slice(0, 64);
    }
    return { ok: true, exitIp, elapsedMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    return { ok: false, elapsedMs: elapsed, error: summarizeProxyError(err) };
  }
}

/** v3.6.0：错误归类摘要（DNS/拒绝连接/超时/认证失败），testProxy 两处复用 */
function summarizeProxyError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const code = e.cause?.code || e.name || "";
  const msg = e.cause?.message || e.message || String(err);
  let reason = "连接失败";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /dns|ENOTFOUND/i.test(msg)) {
    reason = "DNS 解析失败（代理服务器域名无法解析）";
  } else if (code === "ECONNREFUSED") {
    reason = "代理拒绝连接（ECONNREFUSED，检查端口与白名单）";
  } else if (code === "ETIMEDOUT" || code === "AbortError" || /timeout/i.test(msg)) {
    reason = "连接超时（代理不可达或目标被墙）";
  } else if (res_auth_fail(msg)) {
    reason = "代理认证失败（检查用户名密码，HTTP 407）";
  }
  return `${reason}：${msg}`.slice(0, 300);
}

/** v3.6.0：掩码代理地址（剥掉 user:pass 凭据，仅回显 protocol://host:port） */
export function maskProxyAddr(addr: string): string {
  const parsed = parseProxyUrl(addr);
  return parsed ? `${parsed.protocol}://${parsed.host}:${parsed.port}` : addr.slice(0, 64);
}

/**
 * v3.6.0：经「显式指定」的代理地址出站 fetch（不走 runtime settings 解析，
 * 专供设置页草稿实测 —— 测的就是用户输入，而非当前生效配置）。
 */
async function fetchViaExplicitProxy(addr: string, url: string, signal: AbortSignal): Promise<Response> {
  const dispatcher = getDispatcher(addr);
  if (!dispatcher) throw new Error(`代理地址不合法（无法解析协议/主机/端口）`);
  const { fetch: undiciFetch } = await import("undici");
  return (await undiciFetch(url, { dispatcher, signal } as never)) as unknown as Response;
}

function res_auth_fail(msg: string): boolean {
  return /407|authentication|unauthorized|auth/i.test(msg) && !/bearer/i.test(msg);
}

/** 代理诊断信息（设置页展示） */
export function proxyDiagnostics(): { poolSize: number; currentIndex: number; cachedDispatchers: string[] } {
  const settings = getRuntimeSettings();
  const proxyConf: ProxyConfig | null = (settings as RuntimeSettingsShape).proxy || null;
  const pool = proxyConf?.enabled ? parseProxyList(proxyConf.list) : [];
  return {
    poolSize: pool.length,
    currentIndex: poolRotateIndex,
    cachedDispatchers: [...dispatcherCache.keys()].map((k) => {
      const parsed = parseProxyUrl(k);
      if (!parsed) return k;
      // 脱敏：不带凭据展示
      return `${parsed.protocol}://${parsed.host}:${parsed.port}`;
    }),
  };
}
