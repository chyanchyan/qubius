import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import type { DeployForm, DeployState } from "./deploy.js";
import type { GithubVersionState } from "./github-version.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store } from "./store.js";
import type { Effort } from "./types.js";

interface Harness {
  url: string;
  port: number;
  base: string;
  dataDir: string;
  configDir: string;
  store: Store;
  runtime: Runtime;
  close: () => Promise<void>;
}

async function startHarness(options: { setupRequired?: boolean } = {}): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-deploy-http-"));
  const dataDir = path.join(base, "data");
  const configDir = path.join(base, "config");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // 用不常用的端口，避免探测到本机真实服务。
  fs.writeFileSync(path.join(configDir, "env"), [
    "QUBIUS_PRIMARY_PORT=19181",
    "QUBIUS_SECONDARY_PORT=19182",
    "",
  ].join("\n"));

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [],
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  /* 测试必须与宿主环境隔离：开发机进程里通常带着部署用的 QUBIUS_* 变量
     （真实 configDir、projects 文件、启动开关），不清掉会让断言读到线上配置。
     快照后在 close 时原样恢复。 */
  const savedEnv = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("QUBIUS_")) savedEnv.set(key, process.env[key]);
  }
  for (const key of savedEnv.keys()) delete process.env[key];
  process.env.QUBIUS_CONFIG_DIR = configDir;
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
    setupRequired: options.setupRequired,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  // server 监听 0 时真实端口在 listen 之后才确定；部署页读取 config.port。
  config.port = address.port;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    base,
    dataDir,
    configDir,
    store,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("QUBIUS_") && !savedEnv.has(key)) delete process.env[key];
      }
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Windows 上 detached 的假部署任务可能还在退出，cwd 会短暂锁住目录。
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
    },
  };
}

async function call<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${harness.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : {} as T;
  return { status: response.status, data };
}

function makeRepo(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, "deploy"), { recursive: true });
  for (const script of ["install.sh", "start-all.sh", "build.sh"]) {
    const file = path.join(dir, "deploy", script);
    fs.writeFileSync(file, "#!/bin/bash\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  // Windows 部署走 Node 入口；两种平台都写一份，测试在哪个平台都能跑。
  fs.writeFileSync(path.join(dir, "deploy", "deploy-job.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(dir, "deploy", "deploy-lib.mjs"), "export {};\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  return dir;
}

const OPS_LOCK_SCRIPT = path.join(import.meta.dirname, "../../deploy/ops-lock.sh");

/**
 * 假的部署任务：持有 ops flock、写 running/成功状态，验证 POST → spawn 的完整链路。
 * 真实 deploy-job.sh 会自己 flock 并 mark，这里模拟同样的收尾，避免 pending 残留。
 */
function makeFakeJob(base: string): void {
  fs.mkdirSync(path.join(base, "deploy"), { recursive: true });
  const file = path.join(base, "deploy", "deploy-job.sh");
  const ops = JSON.stringify(OPS_LOCK_SCRIPT);
  // Windows 没有 flock/ops lock：直接把成功状态写出去。
  fs.writeFileSync(path.join(base, "deploy", "deploy-job.mjs"), [
    'import fs from "node:fs";',
    'import os from "node:os";',
    "const now = new Date().toISOString().replace(/\\.\\d{3}Z$/, \"Z\");",
    "const body = {",
    '  jobId: process.env.QUBIUS_DEPLOY_JOB_ID ?? "",',
    '  state: "success", step: "done", message: "部署完成", pid: null,',
    "  startedAt: process.env.QUBIUS_DEPLOY_STARTED_AT ?? now,",
    "  finishedAt: now,",
    "};",
    "fs.writeFileSync(process.env.QUBIUS_DEPLOY_STATUS, JSON.stringify(body) + \"\\n\");",
    "// 先离开仓库目录，避免测试清理临时目录时被 cwd 锁住。",
    "process.chdir(os.tmpdir());",
    "",
  ].join("\n"));
  fs.writeFileSync(file, [
    "#!/bin/bash",
    "set -u",
    'ROOT=${QUBIUS_OPS_ROOT:-}',
    `OPS=${ops}`,
    'if [ -n "$ROOT" ]; then',
    '  mkdir -p "$ROOT"',
    '  exec 7<>"$ROOT/ops.lock"',
    '  flock -n 7 || exit 3',
    '  bash "$OPS" mark --root "$ROOT" --state running --kind deploy --job-id "$QUBIUS_DEPLOY_JOB_ID" --token "$QUBIUS_OPS_TOKEN" --pid $$ 7>&- >/dev/null 2>&1 || true',
    "fi",
    'if [ -n "$ROOT" ]; then',
    '  bash "$OPS" mark --root "$ROOT" --state success --kind deploy --job-id "$QUBIUS_DEPLOY_JOB_ID" --token "$QUBIUS_OPS_TOKEN" 7>&- >/dev/null 2>&1 || true',
    "  exec 7>&-",
    "fi",
    `printf '{"jobId":"%s","state":"success","step":"done","message":"部署完成","pid":null,"startedAt":"%s","finishedAt":"%s"}\\n' \\`,
    '  "$QUBIUS_DEPLOY_JOB_ID" "$QUBIUS_DEPLOY_STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$QUBIUS_DEPLOY_STATUS"',
    "exit 0",
    "",
  ].join("\n"));
  fs.chmodSync(file, 0o755);
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - start > timeout) throw new Error("等待部署状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("冷启动时 GET /api/deploy 返回 setupRequired 和从 env 推导的表单", async () => {
  const harness = await startHarness({ setupRequired: true });
  try {
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    assert.equal(state.status, 200);
    assert.equal(state.data.setupRequired, true);
    assert.equal(state.data.role, "primary");
    assert.equal(state.data.port, harness.port);
    assert.equal(state.data.configDir, harness.configDir);
    assert.equal(state.data.envFile, path.join(harness.configDir, "env"));
    assert.equal(state.data.configFile, path.join(harness.configDir, "config.yaml"));
    assert.equal(state.data.form.primaryPort, 19181);
    assert.equal(state.data.form.secondaryPort, 19182);
    assert.equal(state.data.form.startPrimary, true);
    assert.equal(state.data.form.startSecondary, false);
    assert.ok(state.data.instances.some((instance) => instance.role === "primary"));
    assert.equal(state.data.job, null);
  } finally {
    await harness.close();
  }
});

test("GET /api/deploy/github-version 没有镜像时返回可展示的状态", async () => {
  const harness = await startHarness();
  try {
    const result = await call<GithubVersionState>(harness, "GET", "/api/deploy/github-version");
    assert.equal(result.status, 200);
    assert.equal(result.data.error, "没有找到 GitHub 镜像");
    assert.equal(result.data.status, "unknown");
    assert.equal(typeof result.data.current, "string");
    assert.ok(!Number.isNaN(Date.parse(result.data.checkedAt)));
  } finally {
    await harness.close();
  }
});

test("POST /api/deploy/apply 非法 body 返回 400", async () => {
  const harness = await startHarness();
  try {
    const result = await call<{ error: string }>(harness, "POST", "/api/deploy/apply", {});
    assert.equal(result.status, 400);
    assert.ok(result.data.error.length > 0);
    assert.equal(fs.existsSync(path.join(harness.configDir, "projects.yaml")), false);
  } finally {
    await harness.close();
  }
});

test("启用的实例缺少 deploy/install.sh 时返回 400 且不启动任务", async () => {
  const harness = await startHarness();
  try {
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    const empty = path.join(harness.base, "empty");
    fs.mkdirSync(empty, { recursive: true });
    const form: DeployForm = {
      ...state.data.form,
      primaryDir: empty,
      publicHost: "code.example.com",
      startPrimary: true,
    };
    const result = await call<{ error: string }>(harness, "POST", "/api/deploy/apply", form);
    assert.equal(result.status, 400);
    assert.match(
      result.data.error,
      process.platform === "win32" ? /deploy-job\.mjs/ : /install\.sh/,
    );
    assert.equal(fs.existsSync(path.join(harness.configDir, "projects.yaml")), false);
    assert.equal(fs.existsSync(path.join(harness.configDir, "deploy.json")), false);
  } finally {
    await harness.close();
  }
});

test("已有部署任务在跑时 POST 返回 409，且不写配置", async () => {
  const harness = await startHarness();
  try {
    const repo = makeRepo(harness.base, "primary");
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    fs.writeFileSync(path.join(harness.configDir, "deploy.json"), JSON.stringify({
      jobId: "existing",
      state: "running",
      step: "prepare",
      message: "正在部署",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }));
    const form: DeployForm = {
      ...state.data.form,
      primaryDir: repo,
      dataPrimary: path.join(harness.base, "data-primary"),
      publicHost: "code.example.com",
      startPrimary: true,
    };
    const result = await call<{ error: string }>(harness, "POST", "/api/deploy/apply", form);
    assert.equal(result.status, 409);
    assert.match(result.data.error, /已有部署任务/);
    assert.equal(fs.existsSync(path.join(harness.configDir, "projects.yaml")), false);
  } finally {
    await harness.close();
  }
});

test("edge 占用 ops lock 时 POST /api/deploy/apply 返回 409 busy/edge", {
  skip: process.platform === "win32" ? "Windows 不使用 shell ops lock" : false,
}, async () => {
  const harness = await startHarness();
  try {
    makeFakeJob(harness.base);
    const repo = makeRepo(harness.base, "primary");
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(path.join(harness.configDir, "ops.meta"), JSON.stringify({
      version: 1,
      state: "pending",
      kind: "edge",
      jobId: "edge-job",
      token: "edge-token",
      root: harness.configDir,
      claimedAt: now,
      updatedAt: now,
    }));
    const form: DeployForm = {
      ...state.data.form,
      primaryDir: repo,
      dataPrimary: path.join(harness.base, "data-primary"),
      publicHost: "code.example.com",
      startPrimary: true,
    };
    const result = await call<{ error: string; code: string; kind?: string }>(
      harness,
      "POST",
      "/api/deploy/apply",
      form,
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "busy");
    assert.equal(result.data.kind, "edge");
    assert.equal(fs.existsSync(path.join(harness.configDir, "projects.yaml")), false);
  } finally {
    await harness.close();
  }
});

test("GET /api/deploy/status 返回任务状态和日志尾部", async () => {
  const harness = await startHarness();
  try {
    fs.writeFileSync(path.join(harness.configDir, "deploy.json"), JSON.stringify({
      jobId: "job-9",
      state: "failed",
      step: "install-primary",
      message: "主实例安装失败",
      pid: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    }));
    fs.writeFileSync(path.join(harness.configDir, "deploy.log"), "step one\nstep two\n");
    const result = await call<{ job: { jobId: string; state: string; logTail?: string } | null }>(
      harness,
      "GET",
      "/api/deploy/status",
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.job?.jobId, "job-9");
    assert.equal(result.data.job?.state, "failed");
    assert.match(result.data.job?.logTail ?? "", /step two/);
  } finally {
    await harness.close();
  }
});

test("配置目录由服务端决定：POST 修改 configDir 返回 400", async () => {
  const harness = await startHarness();
  try {
    // 把主实例目录指到临时仓库，避免测试依赖开发机 $HOME 下是否恰好有默认 checkout。
    process.env.QUBIUS_PRIMARY_DIR = makeRepo(harness.base, "primary");
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    const result = await call<{ error: string }>(harness, "POST", "/api/deploy/apply", {
      ...state.data.form,
      configDir: path.join(harness.base, "other-config"),
      publicHost: "code.example.com",
    });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /QUBIUS_CONFIG_DIR/);
    assert.equal(fs.existsSync(path.join(harness.configDir, "projects.yaml")), false);
  } finally {
    await harness.close();
  }
});

test("合法表单返回 202、真正 spawn 部署任务并保留 isolated 与未知字段", async () => {
  const harness = await startHarness();
  try {
    makeFakeJob(harness.base);
    const repo = makeRepo(harness.base, "primary");
    const projectsPath = path.join(harness.configDir, "projects.yaml");
    fs.writeFileSync(projectsPath, [
      "  - id: 'demo'",
      "    name: '旧名字'",
      `    path: '${path.join(harness.base, "demo")}'`,
      "    permission: acceptEdits",
      "    isolated: true",
      "    owner: 'alice'",
      "",
    ].join("\n"));
    // 只有 env 引用时才读取/合并既有 projects 文件。
    fs.writeFileSync(path.join(harness.configDir, "env"), [
      "QUBIUS_PRIMARY_PORT=19181",
      "QUBIUS_SECONDARY_PORT=19182",
      `QUBIUS_PROJECTS_FILE=${projectsPath}`,
      "",
    ].join("\n"));
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    const form: DeployForm = {
      ...state.data.form,
      primaryDir: repo,
      dataPrimary: path.join(harness.base, "data-primary"),
      publicHost: "code.example.com",
      startPrimary: true,
      startSecondary: false,
      clonePeer: false,
      projects: [],
    };
    // 模拟旧前端：不传 isolated，期望沿用磁盘上的 true 和未知字段 owner。
    const body = {
      ...form,
      projects: [{
        id: "demo",
        name: "示例",
        path: path.join(harness.base, "demo"),
        permission: "acceptEdits",
      }],
    };
    const applied = await call<{ ok: boolean; jobId: string }>(harness, "POST", "/api/deploy/apply", body);
    assert.equal(applied.status, 202);
    assert.equal(applied.data.ok, true);
    assert.ok(applied.data.jobId.length > 0);

    const done = await waitFor(
      () => call<{ job: { state: string; step: string } | null }>(harness, "GET", "/api/deploy/status"),
      (value) => value.data.job?.state === "success",
    );
    assert.equal(done.data.job?.step, "done");

    const envFile = path.join(harness.configDir, "env");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    }
    assert.match(fs.readFileSync(envFile, "utf8"), /^QUBIUS_PRIMARY_PORT=19181$/m);
    // Windows 路径含反斜杠，shellValue 会用单引号包起来。
    assert.match(fs.readFileSync(envFile, "utf8"), /^QUBIUS_PROJECTS_FILE='?.*projects\.yaml'?$/m);
    const projects = fs.readFileSync(path.join(harness.configDir, "projects.yaml"), "utf8");
    assert.match(projects, /^  - id: 'demo'$/m);
    assert.match(projects, /^    name: '示例'$/m);
    assert.match(projects, /^    isolated: true$/m);
    assert.match(projects, /^    owner: 'alice'$/m);
    if (process.platform !== "win32") {
      // 部署日志以 0600 创建。
      assert.equal(fs.statSync(path.join(harness.configDir, "deploy.log")).mode & 0o777, 0o600);
    }
  } finally {
    await harness.close();
  }
});

test("没有额外项目时连续两次 apply 都成功，且不写非法 projects 文件", async () => {
  const harness = await startHarness();
  try {
    makeFakeJob(harness.base);
    const repo = makeRepo(harness.base, "primary");
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    const body = {
      ...state.data.form,
      primaryDir: repo,
      dataPrimary: path.join(harness.base, "data-primary"),
      publicHost: "code.example.com",
      startPrimary: true,
      startSecondary: false,
      clonePeer: false,
      projects: [],
    };
    const first = await call<{ jobId: string }>(harness, "POST", "/api/deploy/apply", body);
    assert.equal(first.status, 202);
    await waitFor(
      () => call<{ job: { state: string } | null }>(harness, "GET", "/api/deploy/status"),
      (value) => value.data.job?.state === "success",
    );
    assert.equal(fs.existsSync(path.join(harness.configDir, "projects.yaml")), false);
    assert.match(fs.readFileSync(path.join(harness.configDir, "env"), "utf8"), /^QUBIUS_PROJECTS_FILE=''$/m);

    // 第二次 apply 不能因为 env 指向空/不存在的 projects 文件而 400。
    const second = await call<{ jobId: string }>(harness, "POST", "/api/deploy/apply", body);
    assert.equal(second.status, 202);
    await waitFor(
      () => call<{ job: { state: string; jobId: string } | null }>(harness, "GET", "/api/deploy/status"),
      (value) => value.data.job?.state === "success" && value.data.job.jobId === second.data.jobId,
    );
  } finally {
    await harness.close();
  }
});

test("env 未引用默认 projects.yaml 时 GET 不读、apply 不覆盖手工文件", async () => {
  const harness = await startHarness();
  try {
    makeFakeJob(harness.base);
    const repo = makeRepo(harness.base, "primary");
    const manual = path.join(harness.configDir, "projects.yaml");
    const original = "  - id: 'manual'\n    name: '手工'\n    path: '/srv/manual'\n";
    fs.writeFileSync(manual, original);
    const state = await call<DeployState>(harness, "GET", "/api/deploy");
    assert.deepEqual(state.data.form.projects, []);

    const applied = await call<{ jobId: string }>(harness, "POST", "/api/deploy/apply", {
      ...state.data.form,
      primaryDir: repo,
      dataPrimary: path.join(harness.base, "data-primary"),
      publicHost: "code.example.com",
      startPrimary: true,
      startSecondary: false,
      clonePeer: false,
      projects: [],
    });
    assert.equal(applied.status, 202);
    // 等 detached 假任务收尾（写状态 + 释放 ops lock）后再清理临时目录。
    await waitFor(
      () => call<{ job: { state: string; jobId: string } | null }>(harness, "GET", "/api/deploy/status"),
      (value) => value.data.job?.state === "success" && value.data.job.jobId === applied.data.jobId,
    );
    assert.equal(fs.readFileSync(manual, "utf8"), original);
  } finally {
    await harness.close();
  }
});
