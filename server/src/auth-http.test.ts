import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store } from "./store.js";
import type { Effort } from "./types.js";

interface Harness {
  port: number;
  close: () => Promise<void>;
}

async function startHarness(
  options: {
    authToken?: string;
    allowedHosts?: string[];
    config?: Partial<AppConfig>;
    shutdownToken?: string;
    shutdown?: (reason: string) => void;
  } = {},
): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-auth-http-"));
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
    // 默认不写 allowedHosts：验证直接构造的测试夹具也走默认回环白名单。
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    ...options.config,
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
    authToken: options.authToken,
    ...(options.shutdownToken ? { shutdownToken: options.shutdownToken } : {}),
    ...(options.shutdown ? { shutdown: options.shutdown } : {}),
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
  pathname: string,
  headers: Record<string, string> = {},
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

test("未配置 allowedHosts 时默认拒绝外部 Host，允许回环 Host", async () => {
  const harness = await startHarness();
  try {
    const evil = await call(harness.port, "/api/settings", { host: "evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.data.error, "Host 不被允许");

    const loopback = await call(harness.port, "/api/settings");
    assert.equal(loopback.status, 200);

    const localhost = await call(harness.port, "/api/settings", { host: `localhost:${harness.port}` });
    assert.equal(localhost.status, 200);

    const ipv6 = await call(harness.port, "/api/settings", { host: `[::1]:${harness.port}` });
    assert.equal(ipv6.status, 200);

    // 健康检查同样先过 Host 校验。
    const healthEvil = await call(harness.port, "/api/health", { host: "evil.example" });
    assert.equal(healthEvil.status, 403);
  } finally {
    await harness.close();
  }
});

test("allowedHosts 显式空数组回退默认白名单，不会绕过 Host 校验", async () => {
  const harness = await startHarness({ allowedHosts: [] });
  try {
    const evil = await call(harness.port, "/api/settings", { host: "evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.data.error, "Host 不被允许");

    // 空数组按“未配置”处理，回环主机仍然可用。
    const loopback = await call(harness.port, "/api/settings");
    assert.equal(loopback.status, 200);
  } finally {
    await harness.close();
  }
});

test("直接构造 AppConfig 的 authToken 也生效，auth: false 可显式关闭", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const enabled = await startHarness({ config: { authToken: token } });
  try {
    const missing = await call(enabled.port, "/api/settings");
    assert.equal(missing.status, 401);
    const withToken = await call(enabled.port, "/api/settings", { "x-qubius-token": token });
    assert.equal(withToken.status, 200);
  } finally {
    await enabled.close();
  }

  const disabled = await startHarness({ config: { authToken: token, auth: false } });
  try {
    const settings = await call(disabled.port, "/api/settings");
    assert.equal(settings.status, 200);
  } finally {
    await disabled.close();
  }
});

test("启用令牌后 API 需要令牌，健康检查豁免", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const harness = await startHarness({ authToken: token });
  try {
    const missing = await call(harness.port, "/api/settings");
    assert.equal(missing.status, 401);
    assert.equal(missing.data.error, "需要访问令牌");
    // 401 响应不能回显令牌。
    assert.equal(JSON.stringify(missing.data).includes(token), false);

    const wrong = await call(harness.port, "/api/settings", { "x-qubius-token": "wrong-token" });
    assert.equal(wrong.status, 401);

    const viaHeader = await call(harness.port, "/api/settings", { "x-qubius-token": token });
    assert.equal(viaHeader.status, 200);

    const viaBearer = await call(harness.port, "/api/settings", {
      authorization: `Bearer ${token}`,
    });
    assert.equal(viaBearer.status, 200);

    const viaCookie = await call(harness.port, "/api/settings", {
      cookie: `theme=dark; qubius_token=${token}`,
    });
    assert.equal(viaCookie.status, 200);

    // 部署脚本探活不要求令牌。
    const health = await call(harness.port, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
  } finally {
    await harness.close();
  }
});

test("内部停机接口只在本机用正确令牌触发，且不要求访问令牌", async () => {
  const shutdownToken = "shutdown-token-0123456789abcdef";
  const reasons: string[] = [];
  const harness = await startHarness({
    // 即使启用了访问令牌，部署任务也只需要 shutdown 令牌。
    authToken: "0123456789abcdef0123456789abcdef",
    shutdownToken,
    shutdown: (reason) => reasons.push(reason),
  });
  try {
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${harness.port}/api/internal/shutdown`, { method: "POST", headers });

    const wrong = await post({ "x-qubius-shutdown-token": "wrong" });
    assert.equal(wrong.status, 403);
    assert.deepEqual(reasons, []);

    const missing = await post({});
    assert.equal(missing.status, 403);

    const ok = await post({ "x-qubius-shutdown-token": shutdownToken });
    assert.equal(ok.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(reasons, ["deploy-shutdown"]);

    // 没有配置 shutdownToken（普通嵌入/测试）时接口不存在。
    const disabled = await startHarness({});
    try {
      const response = await fetch(`http://127.0.0.1:${disabled.port}/api/internal/shutdown`, {
        method: "POST",
        headers: { "x-qubius-shutdown-token": "x" },
      });
      assert.equal(response.status, 404);
    } finally {
      await disabled.close();
    }
  } finally {
    await harness.close();
  }
});
