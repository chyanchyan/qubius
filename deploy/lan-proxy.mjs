#!/usr/bin/env node
// 局域网入口：Basic 认证 + 反向代理到只监听回环的 qubius / co-qubius。
// 只转发请求，不读写 dataDir，因此与生产进程共用同一份配置和记录。
//
// 端口和凭据都由 deploy/lan-proxy.sh 通过环境变量传入，通常不需要直接运行本文件：
//   LAN_PROXY_PORT=<角色端口> LAN_PROXY_UPSTREAM_PORT=<角色端口>  # 主实例 qubius / 副实例 co-qubius
//   LAN_PROXY_CREDENTIALS=<配置目录>/lan-proxy.credentials
// 两个实例分别以 QUBIUS_SECONDARY=0/1 启动，默认值 8787 只作为直接运行时的兜底。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFailureLimiter } from "./lan-proxy-limit.mjs";

// Windows 上 new URL(...).pathname 是 /D:/... 形式，必须用 fileURLToPath。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const credentialsFile =
  process.env.LAN_PROXY_CREDENTIALS || path.join(scriptDir, "lan-proxy.credentials");
const upstreamHost = process.env.LAN_PROXY_UPSTREAM_HOST || "127.0.0.1";
const upstreamPort = Number(process.env.LAN_PROXY_UPSTREAM_PORT || 8787);

function lanAddress() {
  if (process.env.LAN_PROXY_HOST) return process.env.LAN_PROXY_HOST;
  const skip = /^(lo|docker|br-|veth|virbr|tun|tap|cni)/;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name) || !addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  throw new Error("找不到局域网 IPv4 地址，请用 LAN_PROXY_HOST 指定");
}

function loadCredential() {
  const raw = fs.readFileSync(credentialsFile, "utf8").trim();
  if (!/^[^:]+:.+$/.test(raw)) {
    throw new Error(`${credentialsFile} 应为 user:password`);
  }
  return raw;
}

const expected = Buffer.from(loadCredential());
const host = lanAddress();
const port = Number(process.env.LAN_PROXY_PORT || 8787);
const allowedOrigins = new Set([
  `http://${host}:${port}`,
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);

// 环境变量解析失败时回退默认值，避免一个手误把限速关掉或设成不可用。
function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const limiter = createFailureLimiter({
  maxFailures: envPositiveInt("LAN_PROXY_MAX_FAILURES", 5),
  lockMs: envPositiveInt("LAN_PROXY_LOCK_MS", 5 * 60_000),
});

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6).trim(), "base64");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Basic 凭据会被浏览器自动带到跨站请求上，所以额外挡掉跨站来源。
function sameSite(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin && !allowedOrigins.has(origin)) return false;
  return true;
}

function forwardHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "authorization" || HOP_BY_HOP.has(lower)) continue;
    if (value !== undefined) headers[name] = value;
  }
  headers.host = `${upstreamHost}:${upstreamPort}`;
  return headers;
}

function deny(res, status, body, extra = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || "unknown";
  const gate = limiter.check(ip);
  if (!gate.allowed) {
    deny(res, 429, "尝试次数过多，请稍后再试\n", {
      "retry-after": String(gate.retryAfter ?? 1),
    });
    return;
  }
  // 先挡跨站请求再验凭据：否则恶意页面可借受害者浏览器发无凭据请求，把受害者 IP 锁住。
  if (!sameSite(req)) {
    deny(res, 403, "拒绝跨站请求\n");
    return;
  }
  if (!authorized(req)) {
    // 只有带了 Authorization 却验证失败的请求才算暴力破解尝试。浏览器首屏
    // 和无凭据的 manifest/图标请求会先拿到 401 再弹登录框，不能让它们累计
    // 失败次数，否则正常用户刷新几次就会被锁住。
    if (req.headers.authorization) limiter.fail(ip);
    deny(res, 401, "需要登录\n", {
      "www-authenticate": 'Basic realm="qubius", charset="UTF-8"',
    });
    return;
  }
  limiter.succeed(ip);

  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req),
    },
    (up) => {
      const headers = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        if (value !== undefined) headers[name] = value;
      }
      res.writeHead(up.statusCode || 502, headers);
      // SSE 需要立刻把响应头交给浏览器，不能被缓冲。
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      up.pipe(res);
      up.on("error", () => res.destroy());
    },
  );

  upstream.on("error", (error) => {
    if (res.headersSent) res.destroy();
    else deny(res, 502, `上游服务不可用：${error.message}\n`);
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.timeout = 0;
server.keepAliveTimeout = 65_000;

server.listen(port, host, () => {
  const now = new Date().toISOString();
  console.log(`${now} lan-proxy listening on http://${host}:${port} -> http://${upstreamHost}:${upstreamPort}`);
});

function shutdown(signal) {
  console.log(`${new Date().toISOString()} ${signal}, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
