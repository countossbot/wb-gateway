// 成长中心 HTTP 客户端（仅国内站）。
//
// 重要约定：
// 1. 永远不要使用 workbuddy.ai（国际站），本模块只走 workbuddy.cn / codebuddy.cn。
// 2. 上游对 User-Agent 有硬校验：缺失或格式不对会直接拒绝，所以 UA 统一由版本常量拼装。
// 3. 所有方法必须防御式：网络异常只返回 false / null，绝不向调用方抛错，也不打印 token。

import { fetchWithProxy } from "@/lib/gateway/proxy/proxyAgent";
import { desktopFingerprint, deriveId } from "./derive";

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

/** 默认对话模型：上游 /console/chat/completions 必须显式带 model，否则 11102 */
export const GROWTH_CHAT_MODEL = "glm-5.2";

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

  /**
   * 读取**开学季活动**任务（与成长中心是两套接口，不可混用）。
   *
   * 实测：开学季走 `https://www.codebuddy.cn/portal/activity/school/tasks`，
   * 响应形状为 `{code:0,data:{tasks:[{task_code,title,status,progress,target_count}],in_period}}`，
   * 与成长中心的 `accept_status/progress.{current,target}` 不同，故单独取。
   */
  async getSchoolTasks(opts: GrowthRequestOpts = {}): Promise<unknown> {
    const url = `${SCHOOL_BASE}/portal/activity/school/tasks`;
    return this.requestJson(url, { method: "GET" }, opts);
  }

  /** 开学季：标记任务已查看（前置动作，部分任务需先 viewed 才可完成） */
  async schoolViewed(code: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${SCHOOL_BASE}/portal/activity/school/tasks/${encodeURIComponent(code)}/viewed`;
    return this.isOk(await this.requestJson(url, { method: "POST", body: "{}" }, opts));
  }

  /** 开学季：分享完成（share_invite 的判据） */
  async schoolShareComplete(opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${SCHOOL_BASE}/portal/activity/school/tasks/share-complete`;
    return this.isOk(
      await this.requestJson(url, { method: "POST", body: JSON.stringify({ channel: "wechat" }) }, opts),
    );
  }

  /** 开学季：领取任务奖励 */
  async schoolClaim(code: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${SCHOOL_BASE}/portal/activity/school/tasks/${encodeURIComponent(code)}/claim`;
    return this.isOk(await this.requestJson(url, { method: "POST", body: "{}" }, opts));
  }

  /**
   * 接受任务（上游为**批量**端点：POST /tasks/accept + {"task_codes":[...]}）。
   * 逐任务调用亦可（单元素数组），返回值表示本次调用是否成功（已接受也返回 code:0）。
   */
  async accept(code: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${this.base(opts)}/v2/activity/growth/tasks/accept`;
    const json = await this.requestJson(
      url,
      { method: "POST", body: JSON.stringify({ task_codes: [code] }) },
      opts,
    );
    return this.isOk(json);
  }

  /** 领取任务奖励（claim）；返回上游 code === 0 */
  async claim(code: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${this.base(opts)}/v2/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
    const json = await this.requestJson(url, { method: "POST", body: "{}" }, opts);
    return this.isOk(json);
  }

  /** 批量上报埋点事件（web_event / desktop_event / miniprogram_event 都走这里） */
  /**
   * 事件上报（POST /v2/report，载荷为**事件信封数组**）。
   * 上游要求每个元素自带完整信封（eventCode 等必填），否则返回 10001。
   */
  async reportEvent(events: Array<Record<string, unknown>>, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${SCHOOL_BASE}/v2/report`;
    const json = await this.requestJson(url, { method: "POST", body: JSON.stringify(events) }, opts);
    return this.isOk(json);
  }

  /** 构造一个完整上报信封（字段对齐桌面端埋点） */
  private reportEnvelope(eventCode: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const fp = desktopFingerprint(this.uid, this.nick);
    return {
      timestamp: Date.now(),
      reportDelay: 0,
      userId: this.uid,
      userNickname: this.nick,
      eventCode,
      ...fp,
      ...extra,
    };
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
   *
   * 上游约束（实测）：
   *   - stream 必须为 true（false 直接返回 11101 "Non-stream chat request is currently not supported"）
   *   - 必须带 model，否则 11102 "model [] service info not found"
   *   - 响应为 SSE，需读到 data: [DONE] 才算完成
   */
  async chat(prompt: string, opts: GrowthRequestOpts = {}): Promise<boolean> {
    const url = `${this.base(opts)}/console/chat/completions`;
    const body = JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      model: GROWTH_CHAT_MODEL,
      stream: true,
      conversationId: `conv-${deriveId(this.uid || "anon", "conv")}`,
    });
    try {
      const resp = await fetchWithProxy(
        url,
        {
          method: "POST",
          headers: { ...this.headers(opts), Accept: "text/event-stream" },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
        },
        null,
      );
      if (!resp.ok || !resp.body) return false;
      // 必须把流读完（上游按会话完整性计入任务进度）
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (buf.includes("[DONE]")) break;
        }
      } finally {
        // 异常安全：无论正常结束还是提前 break 都释放连接
        await reader.cancel().catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按机制上报任务事件（web_event / desktop_event / miniprogram_event）。
   * 事件信封由 reportEnvelope() 构造（含桌面指纹）；小程序事件额外带 miniprogram 头。
   */
  async reportTaskEvent(
    code: string,
    mechanism: string,
    opts: GrowthRequestOpts = {},
  ): Promise<boolean> {
    const env = this.reportEnvelope(code, { task_code: code });
    return this.reportEvent([env], {
      ...opts,
      miniprogram: mechanism === "miniprogram_event",
    });
  }
}
