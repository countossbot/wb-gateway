// 确定性指纹派生 —— 移植自参考脚本。
// 关键约束：deriveId 必须是 uid+kind 的纯函数（不使用 Math.random / Date.now），
// 这样同一个账号在多次运行中上报的 machineId / sessionId 保持一致，避免被上游判为异常设备。

import { createHash } from "crypto";
import { GROWTH_CLIENT_VERSION } from "./client";

/**
 * 由 uid 与 kind 确定性地派生一个 uuid 形态的 id（sha256 前 32 位十六进制按 8-4-4-4-12 切分）。
 * 同一个 (uid, kind) 永远得到同一个值；不同 kind 之间互相独立。
 */
export function deriveId(uid: string, kind: string): string {
  const hex = createHash("sha256").update(`${kind}:${uid}`).digest("hex").slice(0, 32);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** 由 uid 派生一个稳定的 unix 毫秒时间戳（落在 2024-01-01 ~ 2024-01-31 之间，纯函数） */
function deriveTimestamp(uid: string, kind: string): number {
  const hex = createHash("sha256").update(`${kind}:ts:${uid}`).digest("hex").slice(0, 8);
  // 2_678_400_000 = 31 天的毫秒数，保证结果落在固定区间内
  return 1_704_067_200_000 + (Number.parseInt(hex, 16) % 2_678_400_000);
}

/**
 * 构造桌面端设备指纹（桌面端埋点上报时携带）。
 * os 固定 win32，ideVersion 取自客户端版本常量；machineId / sessionId 由 deriveId 确定性生成。
 */
export function desktopFingerprint(uid: string, nick: string): Record<string, unknown> {
  const machineId = deriveId(uid, "machine");
  const sessionId = deriveId(uid, "session");
  const bootTime = deriveTimestamp(uid, "boot");
  return {
    // 参考脚本固定使用上海时区；时区不一致上游会判定为异常环境
    timezone: "Asia/Shanghai",
    os: "win32",
    platform: "win32",
    arch: "x64",
    clientVersion: GROWTH_CLIENT_VERSION,
    ideVersion: GROWTH_CLIENT_VERSION,
    releaseDate: "2025-01-15",
    commit: deriveId(uid, "commit").replace(/-/g, "").slice(0, 40),
    machineId,
    deviceId: machineId,
    sessionId,
    uid,
    nick,
    // 会话启动时间：同一 uid 恒定，便于上游做设备一致性校验
    sessionStart: bootTime,
    language: "zh-cn",
    locale: "zh-CN",
  };
}
