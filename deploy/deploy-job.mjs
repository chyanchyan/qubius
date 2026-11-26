#!/usr/bin/env node
// qubius 部署任务（Windows / macOS 原生版本，由 server 以 detached 方式启动）。
//
// Linux 使用 deploy/deploy-job.sh；Windows 和 macOS 没有 systemd（macOS 还没有
// flock/ss/setsid/sha256sum），因此这里用纯 Node 完成同样的工作：
//   1. 读取 server 写好的 env / projects，渲染 config.yaml；
//   2. 必要时克隆副实例 checkout；
//   3. 依赖变化或源码变化时 npm ci / npm run build；
//   4. 停掉旧的服务进程，按新配置启动，校验 /api/health；
//   5. 写 deploy.json / deploy.log（字段与 shell 版本一致）。
//
// 只读取环境变量，不把用户输入拼进命令行；状态/日志路径由 server 指定。
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  expandHome,
  gitDirty,
  gitHead,
  jobTimestamp,
  needsBuild,
  needsInstall,
  parseEnvFile,
  redactUrl,
  renderConfigYaml,
  repoRootFromServerScript,
  samePath,
  sha256File,
  stripAnsi,
  validateProjectsIndent,
} from "./deploy-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATUS = process.env.QUBIUS_DEPLOY_STATUS;
const LOG = process.env.QUBIUS_DEPLOY_LOG;
if (!STATUS || !LOG) {
  console.error("缺少 QUBIUS_DEPLOY_STATUS / QUBIUS_DEPLOY_LOG");
  process.exit(2);
}

const JOB_ID = process.env.QUBIUS_DEPLOY_JOB_ID || "";
const STARTED_AT = process.env.QUBIUS_DEPLOY_STARTED_AT || jobTimestamp();
const PARENT_PID = Number(process.env.QUBIUS_DEPLOY_PARENT_PID || 0) || null;
const PARENT_ROLE = process.env.QUBIUS_DEPLOY_PARENT_ROLE === "secondary" ? "secondary" : "primary";
const PARENT_SCRIPT = process.env.QUBIUS_DEPLOY_PARENT_SCRIPT || "";
const PARENT_DATA_DIR = process.env.QUBIUS_DEPLOY_PARENT_DATA_DIR || "";
const PARENT_PORT = Number(process.env.QUBIUS_DEPLOY_PARENT_PORT || 0) || 0;
const DEPLOY_REPO_ROOT = process.env.QUBIUS_DEPLOY_REPO_ROOT
  ? path.resolve(process.env.QUBIUS_DEPLOY_REPO_ROOT)
  : path.resolve(here, "..");
const ENV_FILE = process.env.QUBIUS_ENV || "";

fs.mkdirSync(path.dirname(STATUS), { recursive: true });
fs.mkdirSync(path.dirname(LOG), { recursive: true });

let finished = false;

// ── 日志与状态（与 server/src/job-state.ts、deploy-job.sh 的格式一致）──────
function say(text) {
  try {
    fs.appendFileSync(LOG, `${redactUrl(stripAnsi(text))}\n`);
  } catch {
    // 日志写不了不影响部署本身。
  }
}

function writeStatus(state, step, message) {
  const body = {
    jobId: JOB_ID,
    state,
    step,
    message,
    pid: process.pid,
    startedAt: STARTED_AT,
    finishedAt: state === "running" ? null : jobTimestamp(),
  };
  const tmp = `${STATUS}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  fs.renameSync(tmp, STATUS);
}

function finish(state, step, message) {
  finished = true;
  try {
    writeStatus(state, step, message);
  } catch {
    // 状态目录不可写时至少保留日志。
  }
}

function fail(step, message) {
  say(`失败：${message}`);
  if (!finished) {
    finished = true;
    try {
      writeStatus("failed", step, message);
    } catch {
      // 状态目录不可写时只能放弃。
    }
  }
  process.exitCode = 1;
  process.exit(1);
}

process.on("uncaughtException", (error) => {
  fail("unexpected", `部署任务异常：${error instanceof Error ? error.message : String(error)}`);
});
process.on("unhandledRejection", (error) => {
  fail("unexpected", `部署任务异常：${error instanceof Error ? error.message : String(error)}`);
});
process.on("exit", () => {
  if (finished) return;
  try {
    writeStatus("failed", "unknown", "部署任务已中断");
  } catch {
    // 状态目录不可写时只能放弃。
  }
});

// ── env 文件与变量 ──────────────────────────────────────────────────────────
function readEnvFile() {
  if (!ENV_FILE) return {};
  try {
    return parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"), process.env);
  } catch (error) {
    say(`无法读取 env 文件 ${ENV_FILE}：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

const fileVars = readEnvFile();

/** 与 shell 的 qubius_load_env 一致：调用者导出的变量优先于 env 文件。 */
function envValue(name) {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  const fromFile = fileVars[name];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return undefined;
}

function envBool(name, fallback) {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function envInt(name, fallback) {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) ? value : fallback;
}

/** 与 deriveDeployForm 一致：相对路径按配置目录解析。调用发生在 configDir 初始化之后。 */
function abs(value) {
  return path.resolve(configDir, expandHome(value, process.env));
}

/** 子进程环境：env 文件的键 + 当前进程环境；去掉部署/运维任务的标记。 */
function baseChildEnv() {
  const env = { ...fileVars, ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("QUBIUS_OPS_") || key.startsWith("QUBIUS_DEPLOY_")) delete env[key];
  }
  return env;
}

// ── 进程与端口工具 ──────────────────────────────────────────────────────────
function isAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Windows 上确认 PID 确实是 node.exe，避免 pid 复用时误杀其他进程。 */
function isNodeProcess(pid) {
  if (!isWindows) return true;
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) return true;
  return /node\.exe/i.test(result.stdout);
}

/**
 * 请 server 自己收尾退出。Windows 的 process.kill 是 TerminateProcess，不会
 * 触发 SIGTERM 处理器，直接硬杀会跳过 store.flush()；所以优先请求内部接口。
 * 令牌文件不存在（旧版本）或校验失败时返回 false，由调用方退回硬杀。
 */
async function requestGracefulShutdown(pid, port, dataDir) {
  if (!pid || !port || !dataDir) return false;
  let token = "";
  try {
    token = fs.readFileSync(path.join(dataDir, "shutdown-token"), "utf8").trim();
  } catch {
    return false;
  }
  if (!token) return false;
  // 能读到 health 时确认端口上就是目标 PID；读不到仍尝试一次，令牌本身
  // 只会被目标 server 接受，别的进程会返回 403。
  const health = await fetchHealth(port);
  if (health?.pid !== undefined && health.pid !== pid) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/internal/shutdown`, {
      method: "POST",
      headers: { "x-qubius-shutdown-token": token },
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function stopPid(pid, label, options = {}) {
  if (!isAlive(pid)) return false;
  say(`停止 ${label}（pid=${pid}）`);
  const graceful = options.port && options.dataDir
    ? await requestGracefulShutdown(pid, options.port, options.dataDir)
    : false;
  if (graceful) {
    say(`${label} 已请求优雅退出，等待收尾`);
  } else {
    try {
      process.kill(pid);
    } catch (error) {
      say(`无法停止 ${label}：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  // 优雅退出要等 server 的 shutdown() 完成（最多 10 秒后强制 exit）。
  const waitMs = graceful ? 15_000 : 10_000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  say(`${label} 未在 ${waitMs / 1000} 秒内退出，强制结束 pid=${pid}`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经退出或没有权限。
  }
  return true;
}

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPortListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(700, () => done(false));
  });
}

async function waitPortFree(port, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await isPortListening("127.0.0.1", port))) return;
    await sleep(200);
  }
  fail("stop", `${label}端口 ${port} 停止后仍被占用，拒绝启动新版本`);
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

// ── 运行命令 ────────────────────────────────────────────────────────────────
function run(label, command, args, options = {}) {
  say(`$ ${command} ${args.join(" ")}`.trim());
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: options.shell === true,
    timeout: options.timeout ?? 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim();
  if (output) {
    try {
      fs.appendFileSync(LOG, `${redactUrl(output)}\n`);
    } catch {
      // 日志写不了不影响命令结果。
    }
  }
  if (result.error) {
    fail(options.step ?? "run", `${label}失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(options.step ?? "run", `${label}失败（退出码 ${result.status ?? "未知"}）`);
  }
  return result;
}

// ── 部署配置 ────────────────────────────────────────────────────────────────
const configDir = path.resolve(envValue("QUBIUS_CONFIG_DIR") || path.dirname(STATUS));
const startPrimary = envBool("QUBIUS_START_PRIMARY", false);
const startSecondary = envBool("QUBIUS_START_SECONDARY", false);
const startLan = envBool("QUBIUS_START_LAN", true);
const clonePeer = envBool("QUBIUS_CLONE_PEER", false);
const pullLatest = envBool("QUBIUS_PULL_LATEST", false);
const primaryRepo = envValue("QUBIUS_PRIMARY_DIR") ? abs(envValue("QUBIUS_PRIMARY_DIR")) : "";
const secondaryRepo = envValue("QUBIUS_SECONDARY_DIR") ? abs(envValue("QUBIUS_SECONDARY_DIR")) : "";
const secondaryRepoUrl = envValue("QUBIUS_SECONDARY_REPO_URL") || envValue("QUBIUS_PRIMARY_REPO_URL") || "";
const primaryRef = envValue("QUBIUS_PRIMARY_REF") || "main";
const maxConcurrent = envInt("QUBIUS_MAX_CONCURRENT", 4);
const approvalTimeoutMinutes = envInt("QUBIUS_APPROVAL_TIMEOUT_MINUTES", 10);
const archiveDir = envValue("QUBIUS_ARCHIVE_DIR") ? abs(envValue("QUBIUS_ARCHIVE_DIR")) : "";
const archiveRetentionDays = envInt("QUBIUS_ARCHIVE_RETENTION_DAYS", 30);
const projectsFileRaw = envValue("QUBIUS_PROJECTS_FILE");
const projectsFile = projectsFileRaw ? abs(projectsFileRaw) : "";
const lanHost = envValue("QUBIUS_LAN_HOST") || "";
const nodeBin = envValue("QUBIUS_NODE_BIN") ? abs(envValue("QUBIUS_NODE_BIN")) : process.execPath;

if (maxConcurrent < 1 || maxConcurrent > 256) {
  fail("prepare", `QUBIUS_MAX_CONCURRENT 必须在 1 到 256 之间：${maxConcurrent}`);
}
if (archiveRetentionDays < 1 || archiveRetentionDays > 3650) {
  fail("prepare", `QUBIUS_ARCHIVE_RETENTION_DAYS 必须在 1 到 3650 之间：${archiveRetentionDays}`);
}
if (!startPrimary && !startSecondary) {
  fail("prepare", "至少需要启用一个实例");
}

function makeEntry(role) {
  const secondary = role === "secondary";
  const repo = secondary ? secondaryRepo : primaryRepo;
  const label = secondary ? "副实例" : "主实例";
  const port = envInt(secondary ? "QUBIUS_SECONDARY_PORT" : "QUBIUS_PRIMARY_PORT", secondary ? 8788 : 8787);
  const dataDir = envValue(secondary ? "QUBIUS_DATA_SECONDARY" : "QUBIUS_DATA_PRIMARY");
  const publicHost = envValue(secondary ? "QUBIUS_PUBLIC_HOST_SECONDARY" : "QUBIUS_PUBLIC_HOST") || "";
  if (!repo) fail("prepare", `缺少${label}目录（QUBIUS_${secondary ? "SECONDARY" : "PRIMARY"}_DIR）`);
  if (!dataDir) fail("prepare", `缺少${label}数据目录（QUBIUS_DATA_${secondary ? "SECONDARY" : "PRIMARY"}）`);
  if (port < 1 || port > 65535) fail("prepare", `${label}端口必须在 1 到 65535 之间：${port}`);
  if (!publicHost) fail("prepare", `启用${label}时公网域名不能为空`);
  // 对端实例未启用时不把它写进项目列表：否则会显示一个根本不会运行的实例。
  const peerEnabled = secondary ? startPrimary : startSecondary;
  const peerPath = peerEnabled ? (secondary ? primaryRepo : secondaryRepo) : "";
  if (!peerEnabled) say("对端实例未启用，配置里不会包含对端项目");
  else if (!peerPath) say(`${label}未配置对端 checkout，配置里不会包含对端项目`);
  return {
    role,
    label,
    repo,
    dataDir: abs(dataDir),
    port,
    publicHost,
    configFile: path.join(configDir, secondary ? "config-secondary.yaml" : "config.yaml"),
    peerId: secondary ? "qubius" : "co-qubius",
    peerName: secondary ? "qubius" : "co-qubius",
    peerPath,
    flag: secondary ? "1" : "0",
    stopped: false,
  };
}

const entries = [];
if (startPrimary) entries.push(makeEntry("primary"));
if (startSecondary) entries.push(makeEntry("secondary"));
if (startPrimary && startSecondary && entries[0].port === entries[1].port) {
  fail("prepare", "主实例和副实例不能使用同一个端口");
}

// 节点版本：与 build.sh 一样要求 >= 22。
const versionResult = spawnSync(nodeBin, ["-p", "process.versions.node"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 10_000,
});
if (versionResult.error || versionResult.status !== 0) {
  fail("prepare", `无法运行 Node：${nodeBin}`);
}
const nodeMajor = Number((versionResult.stdout || "").trim().split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  fail("prepare", `需要 Node.js >= 22，当前 ${nodeBin} 是 ${(versionResult.stdout || "").trim() || "未知版本"}`);
}
// npm 通常和 node 同目录；显式加进 PATH，兼容 QUBIUS_NODE_BIN 指向 nvm 的情况。
const childPath = `${path.dirname(nodeBin)}${path.delimiter}${process.env.PATH ?? ""}`;

// ── projects 文件 ───────────────────────────────────────────────────────────
let projectsText = "";
if (projectsFile) {
  if (!fs.existsSync(projectsFile)) {
    fail("prepare", `QUBIUS_PROJECTS_FILE 不存在：${projectsFile}`);
  }
  projectsText = fs.readFileSync(projectsFile, "utf8");
  const checked = validateProjectsIndent(projectsText);
  if (!checked.ok) {
    fail("prepare", `QUBIUS_PROJECTS_FILE 第 ${checked.line} 行${checked.reason}：${projectsFile}`);
  }
}

// ── 仓库准备（副实例可克隆）─────────────────────────────────────────────────
function ensureRepo(entry) {
  if (spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status !== 0) {
    fail("clone", "找不到 git；Windows 部署需要安装 git 并在 PATH 中");
  }
  const packageFile = path.join(entry.repo, "package.json");
  if (!fs.existsSync(packageFile)) {
    if (entry.role !== "secondary" || !clonePeer) {
      fail("clone", `${entry.label}目录不存在或不是 qubius checkout：${entry.repo}`);
    }
    if (!secondaryRepoUrl) fail("clone", "副实例仓库 URL 为空，无法克隆");
    say(`克隆副实例仓库：${secondaryRepoUrl} -> ${entry.repo}`);
    fs.mkdirSync(path.dirname(entry.repo), { recursive: true });
    run("克隆副实例仓库", "git", ["clone", "--", secondaryRepoUrl, entry.repo], {
      step: "clone",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (!fs.existsSync(packageFile)) {
      fail("clone", `克隆完成但缺少 package.json：${entry.repo}`);
    }
  }
  if (!gitHead(entry.repo)) {
    fail("clone", `${entry.label}不是 git 仓库：${entry.repo}`);
  }
}

// ── 拉取最新代码（可选，构建前）─────────────────────────────────────────────
function gitResult(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
}

/**
 * 从 origin 快进拉取当前分支；与 deploy/pull-latest.sh 语义一致：
 * 工作区有改动或已分叉时失败，绝不 reset --hard。
 */
function pullLatestCode(entry) {
  const step = `pull-${entry.role}`;
  if (!gitHead(entry.repo)) {
    fail(step, `${entry.label}不是 git 仓库：${entry.repo}`);
  }
  const remote = "origin";
  if (gitResult(entry.repo, ["remote", "get-url", remote]).status !== 0) {
    fail(step, `${entry.label}没有 ${remote} 远端，无法拉取最新代码`);
  }
  const status = gitResult(entry.repo, ["status", "--porcelain"]);
  if (status.status !== 0) {
    fail(step, `无法读取${entry.label}工作区状态`);
  }
  if ((status.stdout ?? "").trim()) {
    fail(step, `${entry.label}工作区有未提交改动，已取消拉取；请先提交或清理后重试`);
  }
  const branchResult = gitResult(entry.repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = (branchResult.stdout ?? "").trim();
  if (branchResult.status !== 0 || !branch) {
    fail(step, `${entry.label}处于 detached HEAD，无法确定要拉取的分支`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    fail(step, `${entry.label}当前分支名非法：${branch}`);
  }
  const from = gitHead(entry.repo);
  writeStatus("running", step, `正在拉取${entry.label}最新代码`);
  say(`拉取${entry.label}最新代码：${remote}/${branch}`);
  run(`拉取${entry.label}最新代码`, "git", ["-C", entry.repo, "fetch", "--prune", remote, branch], {
    step,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const toResult = gitResult(entry.repo, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  const to = (toResult.stdout ?? "").trim();
  if (toResult.status !== 0 || !to) {
    fail(step, `读不到 ${remote}/${branch} 的最新提交`);
  }
  if (to === from) {
    say(`${entry.label}代码已经是最新：${from.slice(0, 8)}`);
    return;
  }
  const ancestor = gitResult(entry.repo, ["merge-base", "--is-ancestor", from, to]);
  if (ancestor.status === 1) {
    fail(
      step,
      `${entry.label}本地 ${branch}（${from.slice(0, 8)}）与 ${remote}/${branch}（${to.slice(0, 8)}）已分叉，请先在终端手动合并`,
    );
  }
  if (ancestor.status !== 0) {
    fail(step, `无法比较${entry.label}本地与远端提交`);
  }
  run(`快进${entry.label}代码`, "git", ["-C", entry.repo, "merge", "--ff-only", to], { step });
  say(`${entry.label}已更新：${from.slice(0, 8)} -> ${to.slice(0, 8)}`);
}

// ── 配置渲染 ────────────────────────────────────────────────────────────────
function backupName(file) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let target = `${file}.bak.${stamp}`;
  let counter = 1;
  while (fs.existsSync(target)) {
    target = `${file}.bak.${stamp}-${counter}`;
    counter += 1;
  }
  return target;
}

function writeConfig(entry) {
  const text = renderConfigYaml({
    role: entry.role,
    dataDir: entry.dataDir,
    port: entry.port,
    publicHost: entry.publicHost,
    maxConcurrent,
    approvalTimeoutMinutes,
    archiveDir,
    archiveRetentionDays,
    archiveInstance: entry.role === "secondary" ? "bak" : "main",
    peerId: entry.peerId,
    peerName: entry.peerName,
    peerPath: entry.peerPath,
    projectsText,
    secondary: entry.role === "secondary"
      ? {
        primaryRepo,
        primaryRef,
        script: path.join(entry.repo, "deploy", "secondary.sh"),
        restart: path.join(entry.repo, "deploy", "run.sh"),
      }
      : null,
  });
  if (fs.existsSync(entry.configFile)) {
    const current = fs.readFileSync(entry.configFile, "utf8");
    if (current === text) {
      say(`保留现有配置 ${entry.configFile}（与本次渲染一致）`);
      return;
    }
    const backup = backupName(entry.configFile);
    fs.copyFileSync(entry.configFile, backup);
    say(`已备份旧配置到 ${backup}`);
  }
  fs.mkdirSync(path.dirname(entry.configFile), { recursive: true });
  const tmp = `${entry.configFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, entry.configFile);
  say(`写入配置 ${entry.configFile}`);
}

// ── 构建 ────────────────────────────────────────────────────────────────────
async function stopRole(entry) {
  if (entry.stopped) return;
  entry.stopped = true;
  if (PARENT_PID && PARENT_ROLE === entry.role) {
    // 与 shell 版本一致：只停属于本次部署目录（或当前 checkout）的 server，
    // 避免误杀另一个 checkout 上同角色的服务。
    const parentRepo = repoRootFromServerScript(PARENT_SCRIPT);
    const owned = samePath(parentRepo, entry.repo) || samePath(parentRepo, DEPLOY_REPO_ROOT);
    if (owned) {
      await stopPid(PARENT_PID, "当前服务进程", {
        port: PARENT_PORT,
        dataDir: PARENT_DATA_DIR || entry.dataDir,
      });
    } else {
      say(`父进程不是本次部署的 server（${PARENT_SCRIPT || "未知"}），不停止`);
    }
  }
  const pidfile = path.join(entry.dataDir, "qubius.pid");
  const pid = readPid(pidfile);
  if (pid && pid !== PARENT_PID) {
    if (isAlive(pid) && isNodeProcess(pid)) {
      await stopPid(pid, `${entry.label}旧进程`, { port: entry.port, dataDir: entry.dataDir });
    } else if (isAlive(pid)) {
      say(`${entry.label} pidfile 指向的不是 node 进程（pid=${pid}），按陈旧 pidfile 处理`);
    }
  }
  try {
    fs.unlinkSync(pidfile);
  } catch {
    // 文件本来就不存在。
  }
}

/** 版本号取自仓库根 package.json；读不到或格式异常时省略，由服务端回退。 */
function packageVersion(repo) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    return /^[0-9A-Za-z.+-]+$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

async function buildRole(entry) {
  if (!needsBuild(entry.repo)) {
    say(`${entry.label}构建产物已是最新，跳过构建`);
    return;
  }
  const install = needsInstall(entry.repo);
  if (install) {
    // npm ci 会删除 node_modules：Windows 上运行中的进程可能锁住原生模块，必须先停止；
    // macOS 允许删除/替换正在使用的文件，构建期间继续运行旧服务，避免页面长时间断线。
    if (isWindows) {
      say(`${entry.label}需要重新安装依赖，先停止旧进程`);
      await stopRole(entry);
    }
    run("安装依赖", "npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: entry.repo,
      step: `install-${entry.role}`,
      shell: isWindows,
      env: { ...process.env, PATH: childPath },
    });
    const hash = sha256File(path.join(entry.repo, "package-lock.json"));
    if (hash) {
      try {
        fs.writeFileSync(path.join(entry.repo, "node_modules", ".qubius-lock-hash"), `${hash}\n`);
      } catch {
        // 写不了标记只会导致下次重复安装。
      }
    }
  }
  say(`构建 ${entry.label}：${entry.repo}`);
  run("构建", "npm", ["run", "build"], {
    cwd: entry.repo,
    step: `build-${entry.role}`,
    shell: isWindows,
    env: { ...process.env, PATH: childPath },
  });
  const head = gitHead(entry.repo);
  const body = {
    head,
    version: packageVersion(entry.repo),
    builtAt: new Date().toISOString(),
    dirty: gitDirty(entry.repo),
  };
  fs.mkdirSync(path.join(entry.repo, "server", "dist"), { recursive: true });
  const tmp = path.join(entry.repo, "server", "dist", `.build.json.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  fs.renameSync(tmp, path.join(entry.repo, "server", "dist", "build.json"));
  say(`已写入 server/dist/build.json：head=${head}`);
}

// ── 启动与校验 ──────────────────────────────────────────────────────────────
function serverEnv(entry) {
  const env = baseChildEnv();
  env.PATH = childPath;
  env.QUBIUS_CONFIG = entry.configFile;
  env.QUBIUS_CONFIG_DIR = configDir;
  env.QUBIUS_REPO_DIR = entry.repo;
  env.QUBIUS_SECONDARY = entry.flag;
  if (ENV_FILE) env.QUBIUS_ENV = ENV_FILE;
  return env;
}

async function startRole(entry) {
  const index = path.join(entry.repo, "server", "dist", "index.js");
  if (!fs.existsSync(index)) fail(`start-${entry.role}`, `缺少构建产物：${index}`);
  fs.mkdirSync(entry.dataDir, { recursive: true });
  const logFile = path.join(entry.dataDir, "qubius.log");
  const pidfile = path.join(entry.dataDir, "qubius.pid");
  say(`启动 ${entry.label}：${index}`);
  const fd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(nodeBin, [index], {
      cwd: entry.repo,
      env: serverEnv(entry),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (error) => {
    exited = true;
    say(`${entry.label}启动失败：${error.message}`);
  });
  child.unref();
  fs.writeFileSync(pidfile, `${child.pid ?? ""}\n`);

  const deadline = Date.now() + 60_000;
  let health = null;
  while (Date.now() < deadline) {
    health = await fetchHealth(entry.port);
    if (health) break;
    if (exited || child.exitCode !== null || child.signalCode !== null) break;
    await sleep(500);
  }
  if (!health) {
    fail(`start-${entry.role}`, `${entry.label}启动后 /api/health 未就绪，查看 ${logFile}`);
  }
  if (health.pid && child.pid && health.pid !== child.pid) {
    fail(`start-${entry.role}`, `${entry.label}端口 ${entry.port} 被其他进程占用（pid=${health.pid}）`);
  }
  const head = gitHead(entry.repo);
  if (typeof health.head === "string" && health.head && head && health.head !== head) {
    fail(
      `start-${entry.role}`,
      `${entry.label} health 的 head=${health.head} 与当前 git HEAD=${head} 不一致（构建后未重启？）`,
    );
  }
  say(`${entry.label}已就绪：http://127.0.0.1:${entry.port}（pid=${child.pid}）`);
}

async function stopProxy(entry) {
  const pidfile = path.join(entry.dataDir, "lan-proxy.pid");
  const pid = readPid(pidfile);
  if (pid && isAlive(pid) && isNodeProcess(pid)) await stopPid(pid, `${entry.label} LAN 入口`);
  try {
    fs.unlinkSync(pidfile);
  } catch {
    // 文件本来就不存在。
  }
}

/** 与 deploy/lan-proxy.mjs 的 lanAddress() 保持一致，用来校验它真的监听上了。 */
function lanAddress() {
  if (lanHost) return lanHost;
  const skip = /^(lo|docker|br-|veth|virbr|tun|tap|cni)/;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name) || !addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "";
}

async function startProxy(entry) {
  const credentials = envValue("LAN_PROXY_CREDENTIALS") || path.join(configDir, "lan-proxy.credentials");
  if (!fs.existsSync(credentials)) {
    say(`未找到 LAN 凭据 ${credentials}，跳过 ${entry.label} LAN 入口`);
    return;
  }
  const script = path.join(entry.repo, "deploy", "lan-proxy.mjs");
  if (!fs.existsSync(script)) {
    say(`缺少 ${script}，跳过 ${entry.label} LAN 入口`);
    return;
  }
  const host = lanAddress();
  if (!host) {
    fail(`proxy-${entry.role}`, `找不到局域网 IPv4 地址，请设置 QUBIUS_LAN_HOST`);
  }
  const logFile = path.join(entry.dataDir, "lan-proxy.log");
  const pidfile = path.join(entry.dataDir, "lan-proxy.pid");
  const env = {
    ...serverEnv(entry),
    LAN_PROXY_PORT: String(entry.port),
    LAN_PROXY_UPSTREAM_PORT: String(entry.port),
    LAN_PROXY_CREDENTIALS: credentials,
  };
  if (lanHost) env.LAN_PROXY_HOST = lanHost;
  say(`启动 ${entry.label} LAN 入口（${host}:${entry.port}）`);
  const fd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(nodeBin, [script], {
      cwd: entry.repo,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    fs.closeSync(fd);
    fail(`proxy-${entry.role}`, `${entry.label} LAN 入口启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
  fs.closeSync(fd);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (error) => {
    exited = true;
    say(`${entry.label} LAN 入口启动失败：${error.message}`);
  });
  child.unref();
  fs.writeFileSync(pidfile, `${child.pid ?? ""}\n`);

  // 通配/回环地址无法区分代理和 127.0.0.1 上的 server，跳过探活。
  const verifyHost = /^(0\.0\.0\.0|::|localhost|127\.0\.0\.1|\[::1\])$/i.test(host) ? "" : host;
  if (!verifyHost) {
    say(`${entry.label} LAN 入口绑定 ${host}，跳过端口探活`);
    return;
  }
  const deadline = Date.now() + 5000;
  let listening = false;
  while (Date.now() < deadline) {
    if (exited) break;
    if (await isPortListening(verifyHost, entry.port)) {
      listening = true;
      break;
    }
    await sleep(200);
  }
  if (!listening) {
    if (child.pid && isAlive(child.pid)) {
      try {
        process.kill(child.pid);
      } catch {
        // 已经退出。
      }
    }
    fail(
      `proxy-${entry.role}`,
      `${entry.label} LAN 入口未在 ${verifyHost}:${entry.port} 监听，查看 ${logFile}`,
    );
  }
  say(`${entry.label} LAN 入口已就绪：http://${host}:${entry.port}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  writeStatus("running", "prepare", "准备部署");
  say(`===== ${STARTED_AT} deploy ${JOB_ID}（${isWindows ? "Windows" : "macOS"} 部署任务）=====`);
  say(`部署仓库：${DEPLOY_REPO_ROOT}`);
  say(`部署配置：env=${ENV_FILE || "未指定"}`);

  for (const entry of entries) ensureRepo(entry);

  if (pullLatest) {
    for (const entry of entries) pullLatestCode(entry);
  }

  say("生成实例配置");
  for (const entry of entries) writeConfig(entry);

  for (const entry of entries) {
    if (needsBuild(entry.repo)) {
      writeStatus("running", `install-${entry.role}`, `正在安装/构建${entry.label}`);
    }
    await buildRole(entry);
  }

  writeStatus("running", "stop", "正在停止当前服务");
  for (const entry of entries) await stopRole(entry);
  for (const entry of entries) await waitPortFree(entry.port, entry.label);

  for (const entry of entries) {
    writeStatus("running", `start-${entry.role}`, `正在启动${entry.label}`);
    await startRole(entry);
  }

  if (startLan) {
    for (const entry of entries) {
      await stopProxy(entry);
      await startProxy(entry);
    }
  } else {
    say("跳过局域网入口（QUBIUS_START_LAN=0）");
  }

  finish("success", "done", "部署完成");
  say("部署完成");
}

main().catch((error) => {
  fail("unexpected", `部署任务异常：${error instanceof Error ? error.message : String(error)}`);
});
