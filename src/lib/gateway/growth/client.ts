// 成长中心 HTTP 客户端（仅国内站）。
//
// 重要约定：
// 1. 永远不要使用 workbuddy.ai（国际站），本模块只走 workbuddy.cn / codebuddy.cn。
// 2. 上游对 User-Agent 有硬校验：缺失或格式不对会直接拒绝，所以 UA 统一由版本常量拼装。
// 3. 所有方法必须防御式：网络异常只返回 false / null，绝不向调用方抛错，也不打印 token。

import { fetchWithProxy } from "@/lib/gateway/proxy/proxyAgent";
import { desktopFingerprint } from "./derive";

/** 桌面端客户端版本号（与上游校验的 UA 一致，升级只需改这一行） */
export const GROWTH_CLIENT_VERSION = "5.5.6";
/** CLI 版本号（UA 中第二段） */
export const GROWTH_CLI_VERSION = "2.137.1";

/** 国内主站域名（成长中心任务接口所在域） */
const CN_BASE = "https://www.workbuddy.cn";
/** 开学季 / 小程序活动域名 */
const SCHOOL_BASE = "https://www.codebuddy.cn";

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 20_000;

/** 统一的 User-Agent：WorkBuddy/<客户端版本> WorkBuddy/<客户端版本> CLI/<CLI 版本> */
function buildUserAgent(): string {
  return `WorkBuddy/${GROWTH_CLIENT_VERSION} WorkBuddy/${GROWTH_CLIENT_VERSION} CLI/${GROWTH_CLI_VERSION}`;
}

/** 请求选项 */
export interface GrowthRequestOpts {
  /** 小程序机制调用：额外带 X-Client-Platform: miniprogram，并走 codebuddy.cn 域 */
  miniprogram?: boolean;
  /** 活动 id：给了就走 codebuddy.cn 域并携带 activity_id */
  activityId?: string;
  /** 超时毫秒数，默认 20s */
  timeoutMs?: number;
  /** 是否使用 codebuddy.cn 域（由 miniprogram / activityId 自动推导，一般不用手填） */
  schoolDomain?: boolean;
}

/**
 * 成长中心 API 客户端。
 * 构造时传入 bearer token，后续所有请求自动附带鉴权与上游要求的固定请求头。
 */
export class GrowthClient {
  private readonly token: string;
  /** 账号 uid：用于派生稳定的桌面指纹（同账号跨次执行保持一致） */
  readonly uid: string;
  /** 账号昵称：参与指纹派生，仅用于上报体，不外发 */
  readonly nick: string;

  constructor(accessToken: string, uid = "", nick = "") {
    this.token = accessToken;
    this.uid = uid;
    this.nick = nick;
  }


  /** 组装请求头；不打印任何 token 内容 */
  private headers(opts: GrowthRequestOpts = {}): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "User-Agent": buildUserAgent(),
      "Content-Type": "application/json",
      accept: "application/json",
      Origin: CN_BASE,
      Referer: `${CN_BASE}/`,
    };
    // 小程序侧上游按平台做分流与埋点校验，缺这个头会被判为非法调用
    if (opts.miniprogram) h["X-Client-Platform"] = "miniprogram";
    return h;
  }

  /** 该请求应使用的域名：小程序/活动调用走 codebuddy.cn */
  private base(opts: GrowthRequestOpts = {}): string {
    return opts.miniprogram || opts.activityId || opts.schoolDomain ? SCHOOL_BASE : CN_BASE;
  }

  /** 发起请求并解析 JSON；任何异常都返回 null（不抛错、不泄漏 token） */
  private async requestJson(
    url: string,
    init: RequestInit,
    opts: GrowthRequestOpts = {},
  ): Promise<unknown | null> {
    try {
      const res = await fetchWithProxy(url, {
        ...init,
        headers: { ...this.headers(opts), ...((init.headers as Record<string, string>) ?? {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // 上游偶发返回非 JSON（网关页面 / HTML 错误页），视为失败
        return null;
      }
    } catch {
      // 网络/代理/超时错误：静默降级
      return null;
    }
  }

  /** 判断响应体中的 code 字段是否为 0（上游成功约定） */
  private isOk(json: unknown): boolean {
    if (typeof json !== "object" || json === null) return false;
    const code = (json as { code?: unknown }).code;
    return code === 0 || code === "0";
  }

  /**
   * 拉取任务列表。
   * activityId 存在时走 codebuddy.cn 并通过 ?activity_id= 指定活动。
   */
  async getTasks(opts: { miniprogram?: boolean; activityId?: string } = {}): Promise<unknown> {
    const query = opts.activityId ? `?activity_id=${encodeURIComponent(opts.activityId)}` : "";
    const url = `${this.base(opts)}/v2/activity/growth/tasks${query}`;
    return this.requestJson(url, { method: "GET" }, opts);
  }

  /** 领取（接受）任务；返回上游 code === 0 */
  async accept(code: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${this.base(opts)}/v2/activity/growth/tasks/${encodeURIComponent(code)}/accept`;
    const json = await this.requestJson(url, { method: "POST", body: "{}" }, opts);
    return this.isOk(json);
  }

  /** 领取任务奖励（claim）；返回上游 code === 0 */
  async claim(code: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${this.base(opts)}/v2/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
    const json = await this.requestJson(url, { method: "POST", body: "{}" }, opts);
    return this.isOk(json);
  }

  /** 批量上报埋点事件（web_event / desktop_event / miniprogram_event 都走这里） */
  async reportEvent(body: unknown, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${SCHOOL_BASE}/v2/report`;
    const json = await this.requestJson(url, { method: "POST", body: JSON.stringify(body ?? {}) }, opts);
    return this.isOk(json);
  }

  // ---------------- 互动玩法（playground）薄封装 ----------------

  /** 查询大转盘剩余抽奖次数 */
  async lotteryChances(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(`${this.base(opts)}/v2/activity/growth/lottery/chances`, { method: "GET" }, opts);
  }

  /** 执行一次大转盘抽奖 */
  async lotteryDraw(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(
      `${this.base(opts)}/v2/activity/growth/lottery/draw`,
      { method: "POST", body: "{}" },
      opts,
    );
  }

  /** 查询盲盒可开次数（能量够才可开，每次 10 能量） */
  async blindboxQuota(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(`${this.base(opts)}/v2/activity/growth/buddy/quota`, { method: "GET" }, opts);
  }

  /** 开启盲盒（count 为本次开启数量） */
  async blindboxOpen(count = 1, opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(
      `${this.base(opts)}/v2/activity/growth/buddy/open`,
      { method: "POST", body: JSON.stringify({ count }) },
      opts,
    );
  }

  /** 查询 Buddy 可见状态（是否已领取） */
  async buddyVisible(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(`${this.base(opts)}/v2/activity/growth/buddy/visible`, { method: "GET" }, opts);
  }

  /** 查询 Buddy 旅行状态（idle / traveling / arrived） */
  async buddyTravelStatus(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(
      `${this.base(opts)}/v2/activity/growth/buddy/travel/status`,
      { method: "GET" },
      opts,
    );
  }

  /** 查询旅行配置（可选目的地列表） */
  async buddyTravelConfig(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(
      `${this.base(opts)}/v2/activity/growth/buddy/travel/config`,
      { method: "GET" },
      opts,
    );
  }

  /** 领取旅行到达奖励 */
  async buddyTravelClaim(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(
      `${this.base(opts)}/v2/activity/growth/buddy/travel/claim`,
      { method: "POST", body: "{}" },
      opts,
    );
  }

  /** 派 Buddy 出发旅行 */
  async buddyTravelDepart(locationId: number, opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(
      `${this.base(opts)}/v2/activity/growth/buddy/travel/depart`,
      { method: "POST", body: JSON.stringify({ location_id: locationId }) },
      opts,
    );
  }

  /** 按档位兑换积分奖品（403=天数不足，409=已兑换过） */
  async redeem(level: number | string, opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(
      `${this.base(opts)}/v2/activity/growth/redeem`,
      { method: "POST", body: JSON.stringify({ level }) },
      opts,
    );
  }

  /** 查询已获得的徽章列表 */
  async badges(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(`${this.base(opts)}/v2/activity/growth/badges`, { method: "GET" }, opts);
  }

  /** 查询 Buddy 信息（挂件状态等） */
  async buddyInfo(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(`${this.base(opts)}/v2/activity/growth/buddy/info`, { method: "GET" }, opts);
  }

  /** 查询连签热度图（补签卡判据） */
  async heatmap(opts: GrowthRequestOpts = {}): Promise<unknown> {
    return this.requestJson(`${this.base(opts)}/v2/activity/growth/heatmap`, { method: "GET" }, opts);
  }

  /**
   * 发起一次真实模型对话（real_api 类任务的真实判据）。
   * 上游按会话计入 chat_5 / Model_chat_GLM5.2 等任务进度。
   */
  async chat(prompt: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const json = await this.requestJson(
      `${this.base(opts)}/console/chat/completions`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
      },
      { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
    );
    return this.isOk(json) || json !== null;
  }

  /**
   * 按机制上报任务事件（web_event / desktop_event / miniprogram_event）。
   * 桌面端事件注入 desktopFingerprint，小程序事件走 miniprogram 头。
   */
  async reportTaskEvent(
    code: string,
    mechanism: string,
    opts: GrowthRequestOpts = {},
  ): Promise<boolean> {
    const fn = desktopFingerprint(this.uid, this.nick);
    const event = {
      event: code,
      task_code: code,
      ts: Date.now(),
      ...(mechanism === "desktop_event" ? fn : {}),
    };
    return this.reportEvent([event], {
      ...opts,
      miniprogram: mechanism === "miniprogram_event",
      // 事件上报统一走 codebuddy.cn（与参考实现一致）
      schoolDomain: true,
    });
  }
}
