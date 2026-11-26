import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * lan-proxy 的认证/限速端到端回归：
 * - 无 Authorization 的浏览器首屏请求不能累计失败，否则正常用户刷新几次就被锁；
 * - 带错误 Authorization 的请求才计数；
 * - 跨站请求 403 且不计数；
 * - 正确凭据清零。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyScript = path.join(here, "lan-proxy.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function request(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  for (;;) {
    try {
      if (await predicate()) return;
    } catch {
      // 代理还没监听时连接会被拒绝，继续重试。
    }
    if (Date.now() - started > timeoutMs) throw new Error("超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const basic = (value) => `Basic ${Buffer.from(value).toString("base64")}`;

async function withProxy(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-lan-proxy-http-"));
  const credentials = path.join(dir, "credentials");
  fs.writeFileSync(credentials, "user:pass\n", { mode: 0o600 });
  const upstreamPort = await freePort();
  const proxyPort = await freePort();
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream");
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));

  const child = spawn(process.execPath, [proxyScript], {
    env: {
      ...process.env,
      LAN_PROXY_HOST: "127.0.0.1",
      LAN_PROXY_PORT: String(proxyPort),
      LAN_PROXY_UPSTREAM_PORT: String(upstreamPort),
      LAN_PROXY_CREDENTIALS: credentials,
      LAN_PROXY_MAX_FAILURES: "3",
      LAN_PROXY_LOCK_MS: "60000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    try {
      await waitFor(async () => (await request(proxyPort)).status === 401);
    } catch (error) {
      throw new Error(`lan-proxy 没有启动：${error.message}\n${stderr}`);
    }
    return await fn({ port: proxyPort, upstreamPort, seen });
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("无 Authorization 的 401 不累计失败，不会锁住正常浏览器", async () => {
  await withProxy(async ({ port }) => {
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await request(port)).status, 401);
    }
    const ok = await request(port, { authorization: basic("user:pass") });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "upstream");
  });
});

test("带错误 Authorization 的请求累计失败并最终锁定", async () => {
  await withProxy(async ({ port }) => {
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await request(port, { authorization: basic("user:wrong") })).status, 401);
    }
    const locked = await request(port, { authorization: basic("user:pass") });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers["retry-after"]) >= 1);
  });
});

test("跨站请求 403 且不累计失败", async () => {
  await withProxy(async ({ port }) => {
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await request(port, { "sec-fetch-site": "cross-site" })).status, 403);
    }
    assert.equal((await request(port, { authorization: basic("user:pass") })).status, 200);
    for (let index = 0; index < 2; index += 1) {
      assert.equal((await request(port, { authorization: basic("user:wrong") })).status, 401);
    }
    assert.equal((await request(port, { authorization: basic("user:pass") })).status, 200);
  });
});

test("转发时把原始 Host 写入 x-forwarded-host，并把 Host 改写为上游地址", async () => {
  await withProxy(async ({ port, upstreamPort, seen }) => {
    const res = await request(port, {
      authorization: basic("user:pass"),
      host: "192.168.1.5:8787",
      // 客户端自带的 x-forwarded-host 必须被代理覆盖，不能伪造原始 Host。
      "x-forwarded-host": "evil.example",
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, `127.0.0.1:${upstreamPort}`);
    assert.equal(seen[0]["x-forwarded-host"], "192.168.1.5:8787");
  });
});

test("正确凭据会清零之前的失败计数", async () => {
  await withProxy(async ({ port }) => {
    assert.equal((await request(port, { authorization: basic("user:wrong") })).status, 401);
    assert.equal((await request(port, { authorization: basic("user:wrong") })).status, 401);
    assert.equal((await request(port, { authorization: basic("user:pass") })).status, 200);
    assert.equal((await request(port, { authorization: basic("user:wrong") })).status, 401);
    assert.equal((await request(port, { authorization: basic("user:wrong") })).status, 401);
    assert.equal((await request(port, { authorization: basic("user:pass") })).status, 200);
  });
});
