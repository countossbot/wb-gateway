// 成长中心 HTTP 客户端（仅国内站）。
//
// 重要约定：
// 1. 永远不要使用 workbuddy.ai（国际站），本模块只走 workbuddy.cn / codebuddy.cn。
// 2. 上游对 User-Agent 有硬校验：缺失或格式不对会直接拒绝，所以 UA 统一由版本常量拼装。
// 3. 所有方法必须防御式：网络异常只返回 false / null，绝不向调用方抛错，也不打印 token。

import { createHash, randomUUID } from "node:crypto";
import { fetchWithProxy } from "@/lib/gateway/proxy/proxyAgent";
import { deriveId } from "./derive";

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

  /**
   * 通道 1：CLOUD 桌面通道上报（对齐脚本 report()，workbuddy_daily.py L566-591）。
   *
   * 端点：`CN_BASE + /v2/report`（POST）。
   * 载荷：**每个事件一个完整信封**组成的数组；信封字段先按 L570-579 铺满，
   * 再用事件字段覆盖同名字段（脚本 L580 的 `dict(env, **e)` 等价语义）。
   * 必填字段缺失上游会返回 10001，所以这里绝不允许裁剪信封。
   */
  async reportCloud(events: Array<Record<string, unknown>>): Promise<boolean> {
    const arr = events.map((e) => ({ ...desktopCloudEnvelope(this.uid, this.nick), ...e }));
    return this.postReport(CN_BASE, arr);
  }

  /**
   * 通道 2：web 域单事件上报（对齐脚本 report_web_event()，L2207-2219）。
   *
   * 端点：`CN_BASE + /v2/report`（POST）。
   * 载荷：`{"common": {...}, "events": [ev]}` —— **不是裸数组**，这是 web 域与桌面域最大的结构差异。
   * common 字段照 L2215-2219；事件 ev 照 L2210-2214（自带 eventCode / 页面元素信息）。
   * 注意：web 域 machineId 用 derive_id(uid, "webmachine")，与桌面域的 "machine" 不同。
   */
  async reportWeb(events: Array<Record<string, unknown>>): Promise<boolean> {
    const machineId = deriveId(this.uid, "webmachine");
    const common = {
      userId: this.uid,
      userNickname: this.nick,
      ideName: "web",
      ideType: "web",
      machineId,
      mode: "CLOUD",
      userAgent: "Mozilla/5.0",
      os: "Win32",
      timezone: "Asia/Shanghai",
    };
    // 脚本每次只上报一个事件，这里按同一信封形状批量补齐，保持语义一致
    const now = Date.now();
    const evs = events.map((e) => ({
      timestamp: now,
      reportDelay: 0,
      pageURL: "",
      elementId: "",
      elementName: "",
      os: "Win32",
      arch: "",
      osVersion: "10.0",
      userAgent: SHORT_UA_WEB,
      machineId,
      userId: this.uid,
      userNickname: this.nick,
      ...e,
    }));
    return this.postReport(CN_BASE, { common, events: evs });
  }

  /**
   * 通道 3：小程序埋点上报（对齐 mp_base() L1585-1593 + mp_report() L1649-1665）。
   *
   * 端点：`https://www.codebuddy.cn/v2/report`（脚本 L1663 写死，非 workbuddy.cn）。
   * 请求头：MP_REPORT_HEADERS（L1572-1576）四项 + 既有 Authorization / X-User-Id。
   * 载荷：mp 信封数组（**不是** {"common","events"} 结构，与 web 域不同）。
   * 注意 machineId 用 **md5** 派生（L1581），不能用 deriveId 的 sha256 变体。
   */
  async reportMp(events: Array<Record<string, unknown>>): Promise<boolean> {
    const base = mpBase(this.uid, this.nick);
    const arr = events.map((e) => ({ ...base, ...e }));
    return this.postReport(SCHOOL_BASE, arr, {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Client-Product": "workbuddy-mp",
      "X-Client-Version": "2.4.0",
      "X-Client-Platform": "mp-weixin",
      "X-Platform": "wechatmp",
      ...(this.uid ? { "X-User-Id": this.uid } : {}),
    });
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
   * 通道 4：发起一次**真实对话**（对齐脚本 webchat()，L591-619）。
   *
   * 脚本语义：先建会话，再向 /console/chat/completions 发流式请求，返回会话 id 与拼接后的回复文本。
   * meta 走请求体 `_meta` 字段（脚本 L597-598），T3 的 Expert_team_use_3 依赖其中
   * `codebuddy.ai.growthEvent` + `promptRequestId` 携带 ExpertActualUse JSON。
   *
   * @returns `{ conversationId, responseId, requestId, content }`；任一步失败返回 null（防御式，不抛错）。
   */
  async webchat(
    convName: string,
    prompt: string,
    meta?: Record<string, unknown>,
    model: string = GROWTH_CHAT_MODEL,
  ): Promise<WebchatResult | null> {
    // 1) 先建会话（脚本 L592-594）：名称后缀 8 位随机串保证唯一
    const convUrl = `${CN_BASE}/console/webchat/conversations`;
    const convJson = await this.requestJson(
      convUrl,
      {
        method: "POST",
        body: JSON.stringify({ name: `${convName}-${randomSuffix(8)}` }),
      },
      {},
    );
    const conversationId =
      (convJson as { data?: { conversationId?: string } } | null)?.data?.conversationId ?? "";
    // requestId 由客户端生成并随 meta 上报，后续事件用它关联这次对话
    const requestId = randomUuid();

    // 2) 发流式对话请求（脚本 L595-602）
    const payload: Record<string, unknown> = {
      messages: [{ role: "user", content: prompt }],
      model,
      stream: true,
      conversationId,
      requestId,
    };
    if (meta) payload._meta = meta;

    let content = "";
    try {
      const resp = await fetchWithProxy(
        `${CN_BASE}/console/chat/completions`,
        {
          method: "POST",
          headers: { ...this.headers({}), Accept: "text/event-stream" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS_FOR_CHAT),
        },
      );
      if (!resp.ok || !resp.body) return null;
      // 复用 chat() 同款 SSE 读取逻辑：必须把流读完，[DONE] 即收尾
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          content += extractSseText(buf);
          if (buf.includes("[DONE]")) break;
        }
      } finally {
        // 异常安全：无论正常结束还是提前 break 都释放连接
        await reader.cancel().catch(() => {});
      }
    } catch {
      return null;
    }
    return { conversationId, responseId: requestId, requestId, content };
  }

  /**
   * 统一 POST /v2/report；网络异常 / 非 2xx / 解析失败一律返回 false，绝不抛错。
   * extraHeaders 用于小程序通道覆盖/追加协议头。
   */
  private async postReport(
    baseUrl: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<boolean> {
    try {
      const json = await this.requestJson(
        `${baseUrl}/v2/report`,
        {
          method: "POST",
          headers: { ...this.headers({}), ...extraHeaders },
          body: JSON.stringify(body),
        },
        {},
      );
      if (json === null) return false;
      return this.isOk(json);
    } catch {
      return false;
    }
  }

  /**
   * @deprecated T2 已将上报拆为 reportCloud / reportWeb / reportMp 三条通道，
   * 本方法仅为兼容 runner.ts 现有调用点而保留（薄包装，转发到桌面 CLOUD 通道）。
   * T3 会改写 runner.ts 的调用点，届时可删除本方法。
   */
  async reportTaskEvent(
    code: string,
    mechanism: string,
    _opts: GrowthRequestOpts = {},
  ): Promise<boolean> {
    // 旧实现按机制分域名，现统一走桌面上报通道，事件字段保持 task_code 语义
    return this.reportCloud([{ eventCode: code, task_code: code, mechanism }]);
  }
}

/** webchat() 返回值：会话 id + 关联 id + 拼接后的回复文本 */
export interface WebchatResult {
  conversationId: string;
  /** 响应 id（与 requestId 同源，供后续事件构造使用） */
  responseId: string;
  /** 客户端生成的请求 id，脚本用 meta.promptRequestId 关联 */
  requestId: string;
  /** SSE 拼接后的完整回复文本 */
  content: string;
}

/** 脚本 report()/report_web_event() 使用的短 UA 字面量（L568 / L2213） */
const SHORT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WorkBuddy/5.5.4";

/** 对话请求超时（脚本 timeout=90） */
const DEFAULT_TIMEOUT_MS_FOR_CHAT = 90_000;

/**
 * CLOUD 桌面通道信封（脚本 report() L570-579），字段逐项对齐：
 * 写死的 os/arch/releaseDate/commit 等是上游指纹校验的一部分，勿改。
 */
function desktopCloudEnvelope(uid: string, nick: string): Record<string, unknown> {
  return {
    timestamp: Date.now(),
    reportDelay: 0,
    userId: uid,
    userNickname: nick,
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    ideVersion: GROWTH_CLIENT_VERSION,
    machineId: deriveId(uid, "machine"),
    sessionId: deriveId(uid, "session"),
    mode: "CLOUD",
    userAgent: SHORT_UA,
    os: "Win32",
    arch: "x64",
    osVersion: "10.0.26220",
    timezone: "Asia/Shanghai",
    product: "SaaS",
    releaseDate: 1789036585355,
    commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
    extName: "workbuddy-desktop",
    extVersion: GROWTH_CLIENT_VERSION,
    cpuCores: 20,
    memorySize: 24,
  };
}

/**
 * 小程序通道信封基础字段（脚本 mp_base() L1585-1593）。
 * machineId 用 md5("mp:<uid>") 切成 UUID 形态（L1579-1581），与 deriveId 的 sha256 不同。
 */
function mpBase(uid: string, nick: string): Record<string, unknown> {
  return {
    timestamp: Date.now(),
    ideType: "WorkBuddy_MP",
    ideVersion: "2.4.0",
    extName: "workbuddy-mp",
    extVersion: "2.4.0",
    product: "SaaS",
    ideName: "wx_app_cloud",
    platform: "mini_program",
    os: "windows",
    osVersion: "11",
    arch: "x64",
    machineId: mpMachineId(uid),
    timezone: "Asia/Shanghai",
    userId: uid,
    userNickname: nick,
  };
}

/**
 * 脚本 mp_machine_id()（L1579-1581）：md5("mp:<uid>") 的 hex 按 8-4-4-4-12 切分成 UUID 形态。
 * 必须用 md5（不能用 deriveId 的 sha256），否则上游指纹不匹配。
 */
function mpMachineId(uid: string): string {
  const hex = createHash("md5").update(`mp:${uid}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** 脚本 report_web_event() 使用的 web UA 字面量（L2213，无 WorkBuddy 后缀） */
const SHORT_UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/** 生成 n 位随机小写字母数字串（替代脚本的 uuid4()[:8] 会话名后缀） */
function randomSuffix(n: number): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

/** 生成 UUID v4（替代脚本 uuid.uuid4()，用于请求 id） */
function randomUuid(): string {
  return randomUUID();
}

/**
 * 从 SSE 增量缓冲中抽取文本片段（复用 chat() 的流式解析语义）。
 * 只处理形如 `data: {...}` 的行，解析失败/非 JSON 一律跳过，绝不抛错。
 */
function extractSseText(buf: string): string {
  const out: string[] = [];
  for (const line of buf.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const raw = t.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const j = JSON.parse(raw) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      const c = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
      if (typeof c === "string") out.push(c);
    } catch {
      // 半行/坏行：跳过即可，下一轮补齐
    }
  }
  return out.join("");
}
