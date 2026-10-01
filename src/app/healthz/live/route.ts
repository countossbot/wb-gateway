// GET /healthz/live —— 纯存活探针（liveness）。
//
// 与 /healthz 的区别：
//   /healthz       语义健康检查：零 provider / 零路由时返回 503（degraded），供运维看真实状态，
//                  也被 docker-compose 的健康检查使用（它显式接受 200 与 503）。
//   /healthz/live  只回答「进程是否活着并能处理 HTTP」——永远 200，不查数据库、不看配置。
//
// 为什么需要它：Render 的健康检查只认 2xx，把 503 一律判为不健康。新部署若尚未配置任何
// provider，/healthz 会持续返回 503，导致 Render 一直卡在 deploying（健康检查永不通过）。
// 用本路径做 Render 的 healthCheckPath 即可正常上线；真正的业务就绪状态看 /healthz。

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(JSON.stringify({ status: "alive", time: new Date().toISOString() }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function HEAD() {
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
