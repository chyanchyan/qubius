// deploy/edge-deploy.mjs 的命令行流程测试：用本地假服务端模拟 /api/edge。
// 不读写真实 edgectl 配置，也不启动 qubius。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "edge-deploy.mjs");

const DESIRED = [
  {
    name: "qubius",
    domains: ["code.test"],
    env: "dev",
    upstream: "http://127.0.0.1:8787",
    auth: "dev",
    sse: true,
  },
];

function makeState(overrides = {}) {
  return {
    view: {
      enabled: true,
      appBusy: null,
      provider: { resolved: "native", source: "test", available: true },
      registry: { name: "edgectl.yaml", drift: false },
      desired: DESIRED,
      canPlan: true,
      ...(overrides.view ?? {}),
    },
    plan: {
      planHash: "hash-1",
      provider: "native",
      desired: DESIRED,
      registryDiff: "",
      remoteDiff: "",
      warnings: [],
      requiresConfirmExisting: false,
      requiresForceReclaim: false,
      appliable: true,
      ...(overrides.plan ?? {}),
    },
    jobId: overrides.jobId ?? "job-1",
    job: {
      jobId: overrides.jobId ?? "job-1",
      state: "success",
      kind: "apply",
      step: "reload",
      message: "已应用",
      pid: 123,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      ...(overrides.job ?? {}),
    },
    calls: [],
    applyBody: null,
    token: "",
    viewStatus: overrides.viewStatus,
  };
}

function handlerFor(state) {
  return (req, res, body) => {
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/api/edge" && req.method === "GET") {
      state.calls.push("view");
      state.token = req.headers["x-qubius-token"] ?? "";
      if (state.viewStatus) return send(state.viewStatus.status, state.viewStatus.body);
      return send(200, state.view);
    }
    if (req.url === "/api/edge/plan" && req.method === "POST") {
      state.calls.push("plan");
      return send(200, state.plan);
    }
    if (req.url === "/api/edge/apply" && req.method === "POST") {
      state.calls.push("apply");
      state.applyBody = JSON.parse(body || "{}");
      return send(202, { ok: true, jobId: state.jobId });
    }
    if (req.url === "/api/edge/status" && req.method === "GET") {
      state.calls.push("status");
      return send(200, { job: state.job });
    }
    send(404, { error: "not found" });
  };
}

async function withServer(state, fn) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handlerFor(state)(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function run(args, env = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("--help 和缺少参数返回用法", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /用法：/);

  const missing = await run([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /缺少 --port/);
});

test("启用时生成计划、确认域名并应用成功，带访问令牌", async () => {
  const state = makeState();
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port), "--yes", "--token", "secret-token"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /目标站点：qubius code\.test/);
    assert.match(result.stdout, /公网入口已应用/);
    assert.equal(state.token, "secret-token");
    assert.deepEqual(state.calls, ["view", "plan", "apply", "status"]);
    assert.deepEqual(state.applyBody, { planHash: "hash-1", confirmDomain: "code.test" });
  });
});

test("需要额外确认时带 confirmExisting", async () => {
  const state = makeState({
    plan: { requiresConfirmExisting: true, warnings: ["会改动已有站点"] },
  });
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port), "--yes"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /会改动已有站点/);
    assert.deepEqual(state.applyBody, {
      planHash: "hash-1",
      confirmDomain: "code.test",
      confirmExisting: true,
    });
  });
});

test("非交互环境没有 --yes 时拒绝应用", async () => {
  const state = makeState();
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port)]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--yes/);
    assert.ok(!state.calls.includes("apply"));
  });
});

test("公网入口未启用时直接失败", async () => {
  const state = makeState({ view: { enabled: false, hint: "未配置 QUBIUS_EDGECTL_CONFIG" } });
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port), "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /公网入口未启用/);
    assert.deepEqual(state.calls, ["view"]);
  });
});

test("401 时提示访问令牌", async () => {
  const state = makeState({
    viewStatus: { status: 401, body: { error: "需要访问令牌" } },
  });
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port), "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /需要访问令牌/);
  });
});

test("计划不可应用时不调用 apply", async () => {
  const state = makeState({
    plan: { appliable: false, remoteUnavailable: "远端不可达" },
  });
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port), "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /计划不可应用：远端不可达/);
    assert.ok(!state.calls.includes("apply"));
  });
});

test("作业失败时返回非零并打印日志尾", async () => {
  const state = makeState({
    job: {
      state: "failed",
      step: "reload",
      message: "reload 失败",
      logTail: "caddy validate failed",
    },
  });
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port), "--yes"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /reload 失败/);
    assert.match(result.stderr, /caddy validate failed/);
  });
});

test("显式 --domain 会用于确认", async () => {
  const state = makeState();
  await withServer(state, async (port) => {
    const result = await run(["--port", String(port), "--yes", "--domain", "code.test"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state.applyBody.confirmDomain, "code.test");
  });
});
