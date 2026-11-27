import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigYaml, sha256File, writeDeployStamp } from "./deploy-lib.mjs";

/*
 * deploy/deploy-job.mjs 的编排级回归测试（Windows / macOS 页面部署任务）。
 *
 * 全部在 mktemp 临时目录、19xxx 本地端口上运行，不触碰真实服务：
 *   - 一个假 checkout（git 仓库 + 看起来已构建的 server/dist、web/dist）；
 *   - 一个假 server：/api/health 返回 ok/head/pid/activeSessions/webDist，
 *     activeSessions 由 QUBIUS_FAKE_ACTIVE_SESSIONS 控制；
 *   - 以子进程运行真正的 deploy-job.mjs，检查退出码、状态文件和进程是否被停/重启。
 *
 * 覆盖的关键保护：
 *   A. 有进行中会话时，在停止任何进程之前以 exit 3 中止（状态 failed/busy）；
 *   B. 无变化时跳过构建和重启，进程 pid 不变；
 *   C. QUBIUS_DEPLOY_FORCE=1 时允许中断会话并重启，新进程健康。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const jobScript = path.join(here, "deploy-job.mjs");
const PUBLIC_HOST = "qubius.local";
const TEST_TIMEOUT = 90_000;

// 测试进程本身可能带着真实的 QUBIUS_* 环境变量；子进程必须从干净环境开始。
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("QUBIUS_")) continue;
    env[key] = value;
  }
  return env;
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** 在 19xxx 里挑一个空闲端口（避免碰到真实服务和其它测试）。 */
async function freePort19xxx() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 19000 + Math.floor(Math.random() * 1000);
    if (await canBind(port)) return port;
  }
  throw new Error("找不到可用的 19xxx 端口");
}

function isAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function fetchHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForHealth(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health) return health;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`假 server 没有在端口 ${port} 就绪`);
}

async function waitForDead(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

function git(repo, args) {
  const result = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败：${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

// 假 server：读取同目录 build.json 的 head，activeSessions 由环境变量控制。
// 部署任务只依赖 /api/health 的 ok/head/pid/activeSessions 字段。
const FAKE_SERVER_SOURCE = `import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
let head = "";
try {
  head = JSON.parse(fs.readFileSync(path.join(here, "build.json"), "utf8")).head || "";
} catch {}
const activeSessions = Number(process.env.QUBIUS_FAKE_ACTIVE_SESSIONS || 0);
const port = Number(process.env.QUBIUS_PRIMARY_PORT || 0);
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, head: head, pid: process.pid, activeSessions: activeSessions, webDist: true }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
server.listen(port, "127.0.0.1");
`;

/** 搭一个看起来“已经构建好、无改动”的 checkout。 */
function setupRepo(repo, port) {
  fs.mkdirSync(path.join(repo, "server", "dist"), { recursive: true });
  fs.mkdirSync(path.join(repo, "web", "dist"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  // dist / node_modules 不提交，避免被 buildDirtyStatus 当成源码改动。
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nserver/dist/\nweb/dist/\n");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "fake-qubius", version: "0.0.0", type: "module" }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  git(repo, ["init", "-q"]);
  git(repo, ["add", ".gitignore", "package.json", "package-lock.json"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  const lockHash = sha256File(path.join(repo, "package-lock.json"));
  fs.writeFileSync(path.join(repo, "node_modules", ".qubius-lock-hash"), `${lockHash}\n`);
  fs.writeFileSync(path.join(repo, "server", "dist", "index.js"), FAKE_SERVER_SOURCE);
  fs.writeFileSync(
    path.join(repo, "server", "dist", "build.json"),
    `${JSON.stringify({ head, version: "0.0.0", builtAt: "2026-01-01T00:00:00Z", dirty: false })}\n`,
  );
  fs.writeFileSync(path.join(repo, "web", "dist", "index.html"), "<!doctype html><title>fake</title>\n");
  return { head };
}

/** 与 deploy-job.mjs 的 writeConfig 完全一致的渲染结果，便于预写 config 和 stamp。 */
function expectedConfig({ dataDir, port }) {
  return renderConfigYaml({
    role: "primary",
    dataDir,
    port,
    publicHost: PUBLIC_HOST,
    maxConcurrent: 4,
    approvalTimeoutMinutes: 0,
    archiveDir: "",
    archiveRetentionDays: 30,
    archiveInstance: "main",
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "",
    projectsText: "",
    secondary: null,
  });
}

function jobEnv(fixture, extra = {}) {
  const env = cleanEnv();
  Object.assign(env, {
    QUBIUS_DEPLOY_STATUS: fixture.status,
    QUBIUS_DEPLOY_LOG: fixture.log,
    QUBIUS_DEPLOY_JOB_ID: "test-job",
    QUBIUS_DEPLOY_STARTED_AT: "2026-01-01T00:00:00Z",
    QUBIUS_DEPLOY_REPO_ROOT: fixture.repo,
    QUBIUS_DEPLOY_PARENT_PID: String(fixture.serverPid),
    QUBIUS_DEPLOY_PARENT_ROLE: "primary",
    QUBIUS_DEPLOY_PARENT_SCRIPT: path.join(fixture.repo, "server", "dist", "index.js"),
    QUBIUS_DEPLOY_PARENT_PORT: String(fixture.port),
    QUBIUS_DEPLOY_PARENT_DATA_DIR: fixture.dataDir,
    QUBIUS_CONFIG_DIR: fixture.configDir,
    QUBIUS_ENV: fixture.envFile,
    QUBIUS_START_PRIMARY: "1",
    QUBIUS_START_SECONDARY: "0",
    QUBIUS_START_LAN: "0",
    QUBIUS_PRIMARY_DIR: fixture.repo,
    QUBIUS_DATA_PRIMARY: fixture.dataDir,
    QUBIUS_PRIMARY_PORT: String(fixture.port),
    QUBIUS_PUBLIC_HOST: PUBLIC_HOST,
  });
  return { ...env, ...extra };
}

function runJob(env, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [jobScript], {
      cwd: env.QUBIUS_PRIMARY_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`deploy-job 超时（${timeoutMs}ms）\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function readStatus(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function makeFixture(activeSessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-deploy-job-"));
  const repo = path.join(root, "repo");
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const children = [];
  let serverChild = null;
  const cleanup = async () => {
    // 停掉假 server 和任何被部署任务启动的进程（pidfile 里的 pid）。
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
      }
    }
    try {
      const pidfile = path.join(dataDir, "qubius.pid");
      if (fs.existsSync(pidfile)) {
        const pid = Number(fs.readFileSync(pidfile, "utf8").trim());
        if (isAlive(pid)) {
          try { process.kill(pid, "SIGTERM"); } catch { /* 已退出 */ }
        }
      }
    } catch {
      // 清理失败不影响测试结论。
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  };

  try {
    const port = await freePort19xxx();
    const { head } = setupRepo(repo, port);
    const envFile = path.join(root, "empty.env");
    fs.writeFileSync(envFile, "");
    const status = path.join(configDir, "deploy.json");
    const log = path.join(configDir, "deploy.log");
    const configFile = path.join(configDir, "config.yaml");
    fs.writeFileSync(configFile, expectedConfig({ dataDir, port }));

    serverChild = spawn(process.execPath, [path.join(repo, "server", "dist", "index.js")], {
      cwd: repo,
      env: {
        ...cleanEnv(),
        QUBIUS_PRIMARY_PORT: String(port),
        QUBIUS_FAKE_ACTIVE_SESSIONS: String(activeSessions),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(serverChild);
    let stderr = "";
    serverChild.stderr.on("data", (chunk) => { stderr += chunk; });
    let health;
    try {
      health = await waitForHealth(port);
    } catch (error) {
      throw new Error(`${error.message}\n${stderr}`);
    }
    const serverPid = health.pid;
    fs.writeFileSync(path.join(dataDir, "qubius.pid"), `${serverPid}\n`);

    return {
      root,
      port,
      repo,
      configDir,
      dataDir,
      envFile,
      status,
      log,
      configFile,
      head,
      serverPid,
      serverChild,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function writeStamp(fixture, { port = fixture.port } = {}) {
  writeDeployStamp(path.join(fixture.dataDir, ".deploy-stamp"), {
    head: fixture.head,
    configHash: sha256File(fixture.configFile) ?? "none",
    envHash: sha256File(fixture.envFile) ?? "none",
    port,
  });
}

function readLog(fixture) {
  try {
    return fs.readFileSync(fixture.log, "utf8");
  } catch {
    return "";
  }
}

test("A：有进行中会话时，在停任何进程之前以 exit 3 中止", { timeout: TEST_TIMEOUT }, async () => {
  const fixture = await makeFixture(2);
  try {
    // 没有 .deploy-stamp → 判定需要重启，从而进入忙碌检查。
    const result = await runJob(jobEnv(fixture));
    assert.equal(result.code, 3, `应 exit 3，实际 ${result.code}\n${result.stderr}\n${readLog(fixture)}`);

    const status = readStatus(fixture.status);
    assert.equal(status.state, "failed");
    assert.equal(status.step, "busy");

    // 假 server 必须仍然活着，且还是同一个 pid（没有被停/替换）。
    assert.ok(isAlive(fixture.serverPid), "忙碌中止时旧进程不应被停止");
    const after = await fetchHealth(fixture.port);
    assert.equal(after?.pid, fixture.serverPid, "旧进程不应被替换");

    const log = readLog(fixture);
    assert.match(log, /非交互部署已中止/);
    assert.doesNotMatch(log, /停止\s+(当前服务进程|主实例|旧进程)/, "忙碌中止前不应停止任何进程");
    assert.doesNotMatch(log, /staging/, "忙碌中止前不应构建");
  } finally {
    await fixture.cleanup();
  }
});

test("B：无变化时跳过构建和重启，进程 pid 不变", { timeout: TEST_TIMEOUT }, async () => {
  const fixture = await makeFixture(0);
  try {
    writeStamp(fixture);
    const buildBefore = fs.readFileSync(path.join(fixture.repo, "server", "dist", "build.json"), "utf8");

    const result = await runJob(jobEnv(fixture));
    assert.equal(result.code, 0, `应 exit 0，实际 ${result.code}\n${result.stderr}\n${readLog(fixture)}`);

    const status = readStatus(fixture.status);
    assert.equal(status.state, "success");
    assert.equal(status.step, "done");

    // 同一个 pid，未重启。
    assert.ok(isAlive(fixture.serverPid), "无变化时旧进程应保持运行");
    const after = await fetchHealth(fixture.port);
    assert.equal(after?.pid, fixture.serverPid, "无变化时不应替换进程");

    const log = readLog(fixture);
    assert.match(log, /无变化，跳过构建和重启/);
    assert.doesNotMatch(log, /staging/, "无变化时不应构建");
    assert.doesNotMatch(log, /停止\s*主实例/, "无变化时不应停止实例");
    assert.equal(
      fs.readFileSync(path.join(fixture.repo, "server", "dist", "build.json"), "utf8"),
      buildBefore,
      "无变化时 build.json 不应被改写",
    );
    assert.ok(!fs.existsSync(path.join(fixture.repo, "server", "dist.next")), "不应产生 staging 产物");
  } finally {
    await fixture.cleanup();
  }
});

test("C：QUBIUS_DEPLOY_FORCE=1 时允许中断会话并重启", { timeout: TEST_TIMEOUT }, async () => {
  const fixture = await makeFixture(2);
  try {
    // 没有 stamp → 需要重启；FORCE 让忙碌检查放行。
    const result = await runJob({
      ...jobEnv(fixture),
      QUBIUS_DEPLOY_FORCE: "1",
    });
    assert.equal(result.code, 0, `应 exit 0，实际 ${result.code}\n${result.stderr}\n${readLog(fixture)}`);

    const status = readStatus(fixture.status);
    assert.equal(status.state, "success");
    assert.equal(status.step, "done");

    // 旧进程被停掉，新进程健康且 pid 不同。
    assert.ok(await waitForDead(fixture.serverPid), "FORCE 时旧进程应被停止");
    const after = await fetchHealth(fixture.port);
    assert.ok(after, "重启后新进程应健康");
    assert.notEqual(after.pid, fixture.serverPid, "应启动新进程");
    assert.ok(isAlive(after.pid), "新进程应存活");

    const log = readLog(fixture);
    assert.match(log, /QUBIUS_DEPLOY_FORCE 已强制继续/);
    assert.match(log, /停止\s+(当前服务进程|主实例)/);
    assert.match(log, /主实例已就绪/);
  } finally {
    await fixture.cleanup();
  }
});
