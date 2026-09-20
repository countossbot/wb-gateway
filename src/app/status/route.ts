// GET /status —— 公开状态检查（仅无害存活信息）。
// 余额 / 签到日志 / Token 刷新时间属敏感运营数据，
// 已收敛到需鉴权的 /admin/api/status 与 /v1/usage，避免公开泄露上游账号状态。
// （原版返回 kvEnabled；Node 重构后返回 storage 引擎标识，保持「无害存活信息」语义。）
import { NextRequest } from "next/server";
import { VERSION } from "@/lib/gateway/config/configService";
import { corsHeadersFor } from "@/lib/gateway/http/headers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return new Response(
    JSON.stringify(
      {
        service: "universal-ai-gateway",
        version: VERSION,
        storage: "sqlite",
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeadersFor(request) },
    }
  );
}
