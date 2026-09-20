// SSE 长流探针 —— 验证 Bun 运行时下 node:http createServer 的长响应流是否被
// idleTimeout / requestTimeout 类机制切断（模拟生产 `bun .next/standalone/server.js` 行为）。
// 行为：每 4s 发一个 SSE ping（与网关 streamOpenAIToAnthropic 的保活节奏一致），持续 320s。
// 客户端：curl -N 计时统计。320s 超过 requestTimeout=300s（Node 默认），可同时验证该值是否影响响应流。
import http from "node:http";

const PORT = 3060;
const TOTAL_MS = 320_000;
const PING_MS = 4_000;

const server = http.createServer((req, res) => {
  console.log(`[probe] ${new Date().toISOString()} request from ${req.socket.remoteAddress}`);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache no-transform",
    "x-accel-buffering": "no",
    Connection: "keep-alive",
  });
  const started = Date.now();
  let n = 0;
  const timer = setInterval(() => {
    const elapsed = Date.now() - started;
    if (elapsed >= TOTAL_MS) {
      clearInterval(timer);
      res.write(`event: done\ndata: {"elapsed":${elapsed},"pings":${n}}\n\n`);
      res.end();
      console.log(`[probe] ${new Date().toISOString()} stream completed: ${n} pings over ${elapsed}ms`);
      return;
    }
    n++;
    res.write(`event: ping\ndata: {"t":${elapsed}}\n\n`);
  }, PING_MS);
  req.on("close", () => {
    clearInterval(timer);
    console.log(`[probe] ${new Date().toISOString()} client closed early at ${Date.now() - started}ms after ${n} pings`);
  });
});

// @ts-expect-error node types under bun
if (server.requestTimeout !== undefined) console.log(`[probe] requestTimeout=${server.requestTimeout}`);
// @ts-expect-error node types under bun
if (server.headersTimeout !== undefined) console.log(`[probe] headersTimeout=${server.headersTimeout}`);
// @ts-expect-error node types under bun
if (server.keepAliveTimeout !== undefined) console.log(`[probe] keepAliveTimeout=${server.keepAliveTimeout}`);
// @ts-expect-error node types under bun
console.log(`[probe] server.timeout=${server.timeout}`);

server.listen(PORT, () => console.log(`[probe] listening on ${PORT}, will stream for ${TOTAL_MS / 1000}s`));
