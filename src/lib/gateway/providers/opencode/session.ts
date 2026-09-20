// 会话亲和与 CLI 指纹 —— callChat 与 callResponsesApi 共用的身份伪装。
import { webcrypto } from "node:crypto";

export const PLATFORMS = ["darwin; arm64", "darwin; x64", "linux; x64", "windows; x64"];

export interface SessionFingerprint {
  sessionId: string;
  requestId: string;
  platform: string;
  userAgent: string;
  version: string;
}

interface FingerprintOptions {
  sessionId?: string | null;
  request?: Request | null;
  messages?: Array<{ role?: string; content?: unknown }>;
}

/**
 * 计算会话亲和性标识与真实的 OpenCode CLI 指纹
 * 在连续对话或多轮调用中复用同一个 Session ID，极大提升防风控能力
 */
export async function deriveSessionAndFingerprint(
  payload: FingerprintOptions,
  options: { sessionId?: string | null; request?: Request | null } = {}
): Promise<SessionFingerprint> {
  let sessionId = options.sessionId ?? null;
  if (!sessionId && options.request?.headers) {
    const getH = (k: string) => options.request!.headers.get(k);
    sessionId = getH("x-session-id") || getH("x-conversation-id") || getH("session-id");
  }
  if (!sessionId && payload?.request?.headers) {
    const getH = (k: string) => (payload.request as Request).headers.get(k);
    sessionId = getH("x-session-id") || getH("x-conversation-id") || getH("session-id");
  }

  if (!sessionId) {
    const firstUserMsg = payload?.messages?.find((m) => m.role === "user");
    const seed = firstUserMsg
      ? typeof firstUserMsg.content === "string"
        ? firstUserMsg.content
        : JSON.stringify(firstUserMsg.content)
      : "";

    if (seed && seed.length > 3) {
      try {
        const data = new TextEncoder().encode(seed);
        const hashBuffer = await webcrypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
        sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      } catch {
        sessionId = webcrypto.randomUUID();
      }
    } else {
      sessionId = webcrypto.randomUUID();
    }
  }

  let charSum = 0;
  for (let i = 0; i < sessionId.length; i++) {
    charSum += sessionId.charCodeAt(i);
  }
  const platform = PLATFORMS[charSum % PLATFORMS.length];

  return {
    sessionId,
    requestId: webcrypto.randomUUID(),
    platform,
    userAgent: `opencode/1.18.30 (${platform})`,
    version: "1.18.30",
  };
}
