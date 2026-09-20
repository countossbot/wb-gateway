// 控制台前端展示工具 —— 相对时间、余额、冷却倒计时、掩码识别等。
"use client";

import { formatDistanceToNowStrict, format, isFuture } from "date-fns";
import { zhCN } from "date-fns/locale";

/** 相对时间：如「3 小时前」「刚刚」 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return formatDistanceToNowStrict(d, { addSuffix: true, locale: zhCN });
  } catch {
    return "—";
  }
}

/** 绝对时间（精简）：2024-01-02 15:04 */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return format(d, "yyyy-MM-dd HH:mm:ss");
  } catch {
    return "—";
  }
}

/** 冷却倒计时：未来时间 → 「剩 3 分钟」；过去 → null */
export function cooldownRemaining(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (!isFuture(d)) return null;
    return `剩 ${formatDistanceToNowStrict(d, { locale: zhCN })}`;
  } catch {
    return null;
  }
}

/** 数字格式化：余额等（保留最多 2 位小数） */
export function fmtNum(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (Number.isNaN(v)) return String(n);
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/** v4.4.0：成本估算金额格式化（$ + 智能小数位）——
 * < $0.01 保留 4 位（微成本场景 0.0071）；< $1 保留 3 位；≥ $1 保留 2 位；
 * ≥ $1000 千分位。null/undefined → "—"（未计价口径由调用方渲染淡态说明）。 */
export function fmtUsd(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (Number.isNaN(v)) return String(n);
  const abs = Math.abs(v);
  if (abs === 0) return "$0";
  let decimals: number;
  if (abs < 0.01) decimals = 4;
  else if (abs < 1) decimals = 3;
  else if (abs < 1000) decimals = 2;
  else decimals = 0;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** v3.9.2：token 数紧凑格式化（单位自动转换 K/M/B）——防止大数字撑爆统计卡 / 排行行。
 * 规则：< 1 万全量千分位（9,876）；≥ 1 万按 3 位有效数字缩写（12.3K / 456K / 1.23M / 2.5B）。
 * 展示位建议搭配 title={fmtNum(原值)} 保留精确值（悬停可查全量）。 */
export function fmtCompact(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (Number.isNaN(v)) return String(n);
  const abs = Math.abs(v);
  if (abs < 10_000) return v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const tiers: Array<{ max: number; div: number; suffix: string }> = [
    { max: 1e6, div: 1e3, suffix: "K" },
    { max: 1e9, div: 1e6, suffix: "M" },
    { max: 1e12, div: 1e9, suffix: "B" },
    { max: Infinity, div: 1e12, suffix: "T" },
  ];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (abs < t.max) {
      const scaled = v / t.div;
      const decimals = Math.abs(scaled) < 10 ? 2 : Math.abs(scaled) < 100 ? 1 : 0;
      let text = scaled.toFixed(decimals);
      if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
      // 进位边界（999,999 → "1000K"）：跳到下一档重缩（→ "1M"）
      if (Math.abs(parseFloat(text)) >= 1000 && i + 1 < tiers.length) {
        const next = tiers[i + 1];
        const s2 = v / next.div;
        const d2 = Math.abs(s2) < 10 ? 2 : 1;
        text = s2.toFixed(d2);
        if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
        return `${text}${next.suffix}`;
      }
      return `${text}${t.suffix}`;
    }
  }
  return String(v);
}

/** 判断字段值是否为后端掩码/REDACTED（用于「未改动就原样传回」契约） */
export function isMaskedValue(v: unknown): boolean {
  return (
    v === "***REDACTED***" ||
    v === "" ||
    v === null ||
    v === undefined ||
    (typeof v === "string" && v.includes("••••"))
  );
}

/** 凭据字段回显：无值显示占位提示 */
export function credentialDisplay(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（未设置）";
  return String(v);
}

/** 密码强度评分（0-4）：长度 + 字符类别 */
export function passwordStrength(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  const labels = ["太弱", "弱", "一般", "良好", "强", "很强"];
  return { score: Math.min(score, 5), label: pw.length === 0 ? "" : labels[Math.min(score, 5)] };
}

/** 常用时区列表（下拉） */
export const COMMON_TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "UTC",
];

/** 常用 cron 预设 */
export const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "每天 9:00", value: "0 9 * * *" },
  { label: "每天 21:00", value: "0 21 * * *" },
  { label: "每 6 小时", value: "0 */6 * * *" },
  { label: "每 12 小时", value: "0 */12 * * *" },
  { label: "每小时", value: "0 * * * *" },
  { label: "每 30 分钟", value: "*/30 * * * *" },
];

/** 提供商类型的中文说明与建议默认 Base URL */
export const PROVIDER_TYPE_META: Record<
  string,
  { label: string; desc: string; defaultBaseUrl?: string; icon: string }
> = {
  workbuddy: {
    label: "WorkBuddy",
    desc: "阿里云百炼代充型中转，多账号池 + Token 自动刷新 + 每日签到领积分",
    icon: "building",
  },
  openai: {
    label: "OpenAI 兼容",
    desc: "OpenRouter / DeepSeek / 硅基流动等 OpenAI 协议端点",
    defaultBaseUrl: "https://api.openai.com/v1",
    icon: "zap",
  },
  anthropic: {
    label: "Anthropic 兼容",
    desc: "Anthropic 协议端点（官方或兼容中转）",
    defaultBaseUrl: "https://api.anthropic.com",
    icon: "sparkles",
  },
  opencode: {
    label: "OpenCode Zen",
    desc: "免费模型池（-free 后缀模型免凭据直连），自动同步模型列表",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    icon: "gift",
  },
  qwenweb: {
    label: "Qwen Web（逆向）",
    desc: "通义千问 Web 端逆向通道：Token/Cookie + 反爬指纹，单轮压缩",
    defaultBaseUrl: "https://chat.qwen.ai",
    icon: "globe",
  },
};

/** 状态码颜色分类 */
export function statusColor(status: number | null): string {
  if (status === null || status === undefined) return "text-muted-foreground";
  if (status >= 200 && status < 300) return "text-emerald-600";
  if (status >= 400 && status < 500) return "text-amber-600";
  return "text-red-600";
}

/** Token 用量展示：in/out/cached（v3.9.3：可选来源尾注；↑↓⚡ 符号格式保持不变）。
 * source：true=上游 usage 帧精确 / false=字符估算 / null|undefined=未记录（不显示尾注）。 */
export function tokenUsage(
  inTok: number | null,
  outTok: number | null,
  cached: number | null,
  source?: boolean | null
): string {
  const parts: string[] = [];
  if (inTok !== null && inTok !== undefined) parts.push(`↑${inTok}`);
  if (outTok !== null && outTok !== undefined) parts.push(`↓${outTok}`);
  if (cached !== null && cached !== undefined && cached > 0) parts.push(`⚡${cached}`);
  if (parts.length === 0) return "—";
  if (source === true) parts.push("·精确");
  else if (source === false) parts.push("·估算");
  return parts.join(" ");
}
