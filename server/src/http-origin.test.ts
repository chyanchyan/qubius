import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { createAppServer, originSourceAllowed } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store } from "./store.js";
import type { Effort } from "./types.js";

/*
 * validateApiRequest 的 Origin/Referer 回退：
 * - Sec-Fetch-Site 缺失时才检查 Origin（没有则 Referer）；
 * - 白名单主机放行；
 * - lan-proxy 改写 Host 后，回环请求可凭 x-forwarded-host 匹配原始 Host 放行；
 * - 已有 Sec-Fetch-Site 的请求不再看 Origin，避免误杀局域网入口。
 */

interface Harness {
  port: number;
  close: () => Promise<void>;
}

async function startHarness(options: { allowedHosts?: string[] } = {}): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-http-origin-"));
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [],
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
  };
  const settings = {
    current: {
      providers: [],
      effort: "high" as Effort,
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "", baseUrl: "" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function call(
  port: number,
  headers: Record<string, string> = {},
  pathname = "/api/settings",
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            data: text ? JSON.parse(text) as Record<string, unknown> : {},
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("缺少 Sec-Fetch-Site 时同源和白名单 Origin 放行", async () => {
  const harness = await startHarness({
    allowedHosts: ["127.0.0.1", "localhost", "[::1]", "code.example.com"],
  });
  try {
    const sameOrigin = await call(harness.port, {
      origin: `http://127.0.0.1:${harness.port}`,
    });
    assert.equal(sameOrigin.status, 200);

    const whitelisted = await call(harness.port, { origin: "https://code.example.com" });
    assert.equal(whitelisted.status, 200);
  } finally {
    await harness.close();
  }
});

test("缺少 Sec-Fetch-Site 时不允许的 Origin 返回 403", async () => {
  const harness = await startHarness();
  try {
    const evil = await call(harness.port, { origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.data.error, "来源不被允许");

    // Origin 优先于 Referer：即使 Referer 是同源，也按 Origin 判断。
    const mixed = await call(harness.port, {
      origin: "https://evil.example",
      referer: `http://127.0.0.1:${harness.port}/`,
    });
    assert.equal(mixed.status, 403);
  } finally {
    await harness.close();
  }
});

test("没有 Origin/Referer 时放行（curl/原生客户端）", async () => {
  const harness = await startHarness();
  try {
    const plain = await call(harness.port);
    assert.equal(plain.status, 200);
  } finally {
    await harness.close();
  }
});

test("缺少 Origin 时回退到 Referer", async () => {
  const harness = await startHarness();
  try {
    const sameOrigin = await call(harness.port, {
      referer: `http://127.0.0.1:${harness.port}/sessions`,
    });
    assert.equal(sameOrigin.status, 200);

    const evil = await call(harness.port, { referer: "https://evil.example/page" });
    assert.equal(evil.status, 403);
  } finally {
    await harness.close();
  }
});

test("经 lan-proxy 转发：x-forwarded-host 等于 Origin 主机时放行", async () => {
  const harness = await startHarness();
  try {
    const viaLan = await call(harness.port, {
      host: `127.0.0.1:${harness.port}`,
      origin: "http://192.168.1.5:8787",
      "x-forwarded-host": "192.168.1.5:8787",
    });
    assert.equal(viaLan.status, 200);
  } finally {
    await harness.close();
  }
});

test("x-forwarded-host 与 Origin 主机不一致时 403", async () => {
  const harness = await startHarness();
  try {
    const mismatch = await call(harness.port, {
      host: `127.0.0.1:${harness.port}`,
      origin: "http://192.168.1.6:8787",
      "x-forwarded-host": "192.168.1.5:8787",
    });
    assert.equal(mismatch.status, 403);
  } finally {
    await harness.close();
  }
});

test("已有 Sec-Fetch-Site 时不再按 Origin 校验，避免误杀局域网访问", async () => {
  const harness = await startHarness();
  try {
    // 浏览器经 lan-proxy 访问时 Sec-Fetch-Site=same-origin，而 Origin 是局域网地址，
    // 不在 allowedHosts 里也必须放行（Host 已被代理改写成回环）。
    const sameOrigin = await call(harness.port, {
      "sec-fetch-site": "same-origin",
      origin: "http://192.168.1.5:8787",
    });
    assert.equal(sameOrigin.status, 200);

    const crossSite = await call(harness.port, { "sec-fetch-site": "cross-site" });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.data.error, "跨站请求被拒绝");
  } finally {
    await harness.close();
  }
});

test("Origin 为 null 或无法解析时 403", async () => {
  const harness = await startHarness();
  try {
    const nullOrigin = await call(harness.port, { origin: "null" });
    assert.equal(nullOrigin.status, 403);

    const malformed = await call(harness.port, { origin: "not a url" });
    assert.equal(malformed.status, 403);

    const fileOrigin = await call(harness.port, { origin: "file:///tmp/page.html" });
    assert.equal(fileOrigin.status, 403);
  } finally {
    await harness.close();
  }
});

test("回退校验同样作用于 /api/health", async () => {
  const harness = await startHarness();
  try {
    const plain = await call(harness.port, {}, "/api/health");
    assert.equal(plain.status, 200);

    const evil = await call(harness.port, { origin: "https://evil.example" }, "/api/health");
    assert.equal(evil.status, 403);
    assert.equal(evil.data.error, "来源不被允许");
  } finally {
    await harness.close();
  }
});

test("缺少 Origin 时 Referer 也支持 x-forwarded-host 回退", async () => {
  const harness = await startHarness();
  try {
    const viaLan = await call(harness.port, {
      host: `127.0.0.1:${harness.port}`,
      referer: "http://192.168.1.5:8787/sessions",
      "x-forwarded-host": "192.168.1.5:8787",
    });
    assert.equal(viaLan.status, 200);

    const mismatch = await call(harness.port, {
      host: `127.0.0.1:${harness.port}`,
      referer: "http://192.168.1.6:8787/sessions",
      "x-forwarded-host": "192.168.1.5:8787",
    });
    assert.equal(mismatch.status, 403);
  } finally {
    await harness.close();
  }
});

test("allowedHosts 带端口时精确匹配，默认端口按 URL 规范化", async () => {
  const withPort = await startHarness({
    allowedHosts: ["127.0.0.1", "localhost", "[::1]", "code.example.com:8443"],
  });
  try {
    const samePort = await call(withPort.port, { origin: "https://code.example.com:8443" });
    assert.equal(samePort.status, 200);
    // 规则带端口时，不带端口的来源不匹配。
    const noPort = await call(withPort.port, { origin: "https://code.example.com" });
    assert.equal(noPort.status, 403);
  } finally {
    await withPort.close();
  }

  const defaultPort = await startHarness({
    allowedHosts: ["127.0.0.1", "localhost", "[::1]", "code.example.com"],
  });
  try {
    // https 默认端口 443 会被 URL 规范化掉，仍按主机名匹配。
    const https = await call(defaultPort.port, { origin: "https://code.example.com:443" });
    assert.equal(https.status, 200);
    // 规则不带端口时允许同主机名的任意端口。
    const otherPort = await call(defaultPort.port, { origin: "https://code.example.com:8443" });
    assert.equal(otherPort.status, 200);
  } finally {
    await defaultPort.close();
  }
});

test("非回环来源伪造 x-forwarded-host 不生效", () => {
  const allowedHosts = ["127.0.0.1"];
  // 回环（lan-proxy）来源 + 匹配的原始 Host 放行。
  assert.equal(originSourceAllowed({
    origin: "http://192.168.1.5:8787",
    remoteAddress: "127.0.0.1",
    forwardedHost: "192.168.1.5:8787",
    allowedHosts,
  }), true);
  assert.equal(originSourceAllowed({
    origin: "http://192.168.1.5:8787",
    remoteAddress: "::ffff:127.0.0.1",
    forwardedHost: "192.168.1.5:8787",
    allowedHosts,
  }), true);
  // 非回环来源即使伪造了匹配的 x-forwarded-host 也必须拒绝。
  assert.equal(originSourceAllowed({
    origin: "http://192.168.1.5:8787",
    remoteAddress: "192.168.1.50",
    forwardedHost: "192.168.1.5:8787",
    allowedHosts,
  }), false);
});
