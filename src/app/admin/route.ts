// GET /admin —— Agent-Native 自解释规范与索引（供 AI 智能体直接读取与调用）。
// 等价保留原版 JSON 规范页；鉴权提示为 Master Key 或控制台会话。
import { NextRequest } from "next/server";
import { VERSION } from "@/lib/gateway/config/configService";
import { resolveSession } from "@/lib/gateway/session/session";
import { extractToken } from "@/lib/gateway/auth/auth";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sessionPrincipal = await resolveSession(request);
  const hasBearer = !!extractToken(request);
  const config = await import("@/lib/gateway/config/configService").then((m) => m.getConfig());
  let authenticated = !!sessionPrincipal;
  if (!authenticated && hasBearer && config.master_key) {
    const { timingSafeEqual } = await import("@/lib/gateway/auth/timing");
    const token = extractToken(request);
    authenticated = timingSafeEqual(token, config.master_key);
  }

  return new Response(
    JSON.stringify(
      {
        service: "universal-ai-gateway",
        version: VERSION,
        mode: "agent-native",
        description:
          "Universal AI Gateway Management API (Node.js + SQLite) for Autonomous Agents",
        auth: {
          type: "Bearer Token, x-api-key, or Console Session Cookie",
          required_key: "MASTER_KEY",
          header: "Authorization: Bearer <MASTER_KEY>",
          note: "Web console sessions (uag_session cookie) are also accepted on /admin/api/*",
        },
        endpoints: [
          {
            path: "/admin/api/config",
            methods: ["GET", "POST"],
            description: "Read or update gateway routing, providers, and virtual keys (persisted to SQLite)",
            requires_auth: true,
          },
          {
            path: "/admin/api/status",
            methods: ["GET"],
            description: "Check real-time aggregated balance, accounts status, and last checkin logs",
            response_includes: {
              usage_daily: "last 7 days per-day usage rollup (requests / ok / input / output / cached tokens, from UsageDaily aggregate table — immune to rolling-log truncation)",
            },
            requires_auth: true,
          },
          {
            path: "/admin/api/checkin",
            methods: ["POST"],
            description: "Trigger manual daily checkin across all active multi-account pools",
            requires_auth: true,
          },
          {
            path: "/admin/api/refresh",
            methods: ["POST"],
            description: "Force refresh all cached and stored access tokens",
            requires_auth: true,
          },
          {
            path: "/admin/api/usage-backfill",
            methods: ["POST"],
            description: "Manually re-run the UsageDaily historical backfill (idempotent: days that already have rows are skipped to avoid double counting; runs automatically once at startup)",
            requires_auth: true,
          },
          {
            path: "/api/console/usage/daily",
            methods: ["GET"],
            description: "UsageDaily dimension query / pivot table (console session or Master Key). Query params: days=N (1-90, default 7) or day=YYYY-MM-DD. Returns rows (day x provider x key) plus pivot rollups byProvider / byKey / byDay / totals with successRate. Immune to rolling-log truncation.",
            requires_auth: true,
          },
          {
            path: "/api/console/audit",
            methods: ["GET"],
            description: "Console operation audit log (v3.2.0). Query params: limit=N (1-500, default 100), entity=provider|account|route|key|setting|system, action=delete|create|update|toggle|regenerate|restore, days=N. Returns entries (delete entries embed pre-delete snapshot with redacted credentials) plus stats {total24h, deletes24h, total7d}. Write-side: all console write APIs auto-record.",
            requires_auth: true,
          },
          {
            path: "/api/console/audit/restore",
            methods: ["POST"],
            description: "One-click rebuild of a deleted model route from its audit delete-snapshot (v3.2.3). Body: {auditId}. Only accepts entity=route + action=delete entries; refuses (409) if a route with the same model already exists — never overwrites; fails with explicit error if snapshot candidates reference missing providers. Creates the route + ordered candidates and records an action=restore audit entry.",
            requires_auth: true,
          },
          {
            path: "/api/console/balances/history",
            methods: ["GET"],
            description: "Per-account daily balance snapshot time series (v3.6.0). Query params: days=N (1-90, default 14). Returns full day axis plus per-account balance points (null = no snapshot that day), first/last/delta per account. Snapshots are captured as a side effect of fleet.getBalance real probes — zero extra upstream calls. Consumers: overview aggregate-balance trend, accounts page per-account sparkline.",
            requires_auth: true,
          },
          {
            path: "/api/console/proxy/test",
            methods: ["GET", "POST", "DELETE"],
            description: "Proxy connectivity probe (v3.6.0 — endpoint previously missing, settings-page test button returned 404). POST body {proxyList, bypass} tests the UNSAVED draft: non-empty list probes each address in parallel (cap 5, masked response, 8s timeout each, per-address results in pool[]), empty list probes the direct egress; empty body tests the active config. Persists proxy.lastTest (runtime settings) and appends proxyTestHistory (SystemSetting key, cap 20) returned as history[]. GET returns {lastTest, history, diagnostics}; DELETE clears test history only (non-business data).",
            requires_auth: true,
          },
        ],
        public_endpoints: [
          { path: "/healthz", method: "GET", description: "Worker liveness heartbeat" },
          { path: "/status", method: "GET", description: "Public health summary (no sensitive data)" },
          { path: "/v1/usage", method: "GET", description: "CC-Switch compatible credit inquiry (requires API Key)" },
          { path: "/v1/models", method: "GET", description: "OpenAI-compatible models catalog (requires API Key)" },
          { path: "/v1/messages", method: "POST", description: "Anthropic Messages protocol exchange (Claude Code)" },
          { path: "/v1/chat/completions", method: "POST", description: "OpenAI Chat Completions protocol exchange" },
        ],
        authenticated,
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeadersFor(request) },
    }
  );
}
