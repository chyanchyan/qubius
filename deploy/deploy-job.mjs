#!/usr/bin/env node
// qubius 部署任务（Windows / macOS 原生版本，由 server 以 detached 方式启动）。
//
// Linux 使用 deploy/deploy-job.sh；Windows 和 macOS 没有 systemd（macOS 还没有
// flock/ss/setsid/sha256sum），因此这里用纯 Node 完成同样的工作：
//   1. 读取 server 写好的 env / projects，渲染 config.yaml；
//   2. 必要时克隆副实例 checkout；
//   3. 依赖变化时停实例、备份 node_modules 后 npm ci，再把产物 staging 到 dist.next；
//   4. 停掉旧的服务进程，原子切换 dist.next -> live，按新配置启动，校验 /api/health，
//      失败时回滚 .prev 并恢复 node_modules.prev；
//   5. 写 deploy.json / deploy.log（字段与 shell 版本一致）。
//
// 只读取环境变量，不把用户输入拼进命令行；状态/日志路径由 server 指定。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listenerPids, processInfo, stopProcess } from "./quickstart-lib.mjs";
import {
  activeSessionsFromHealth,
  backupNodeModules,
  busyDecision,
  cleanupNodeModulesPrev,
  deployDecision,
  deployPorts,
  discardStaging,
  expandHome,
  gitDirty,
  gitHead,
  jobTimestamp,
  lanAddress,
  needsBuild,
  needsInstall,
  parseEnvFile,
  proxyChildEnv,
  proxyPlan,
  readDeployStamp,
  redactUrl,
  renderConfigYaml,
  repoRootFromServerScript,
  restoreNodeModulesWhenBackedUp,
  rollbackDist,
  samePath,
  sha256File,
  stripAnsi,
  swapDist,
  validateProjectsIndent,
  writeDeployStamp,
} from "./deploy-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 页面触发的部署会在新终端窗口里跑（QUBIUS_DEPLOY_CONSOLE=1）：日志要同时
   打到控制台，端口冲突时要在窗口里询问，服务也在这个窗口前台运行。
   say() 在读取 env 文件时就会用到，所以先用 let 占位，读完 env 再赋值。 */
let deployConsole = false;

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
  const line = redactUrl(stripAnsi(text));
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    // 日志写不了不影响部署本身。
  }
  /* 终端模式下同时打到窗口；日志文件仍然保留一份，页面和设备排查都能看。 */
  if (deployConsole) console.log(line);
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

function fail(step, message, code = 1) {
  say(`失败：${message}`);
  if (!finished) {
    finished = true;
    try {
      writeStatus("failed", step, message);
    } catch {
      // 状态目录不可写时只能放弃。
    }
  }
  process.exitCode = code;
  process.exit(code);
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
  // 由调用方恢复已停角色后再失败，这里不能直接退出进程。
  throw new Error(`${label}端口 ${port} 停止后仍被占用，拒绝启动新版本`);
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
// runTry 只执行并记录，不中断进程；调用方可以据此恢复旧版本。run 是“失败即中止”的包装。
function runTry(label, command, args, options = {}) {
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
    /* 终端模式：npm ci / 构建的输出也打给用户看，否则窗口里只有任务自己的进度。 */
    if (deployConsole) console.log(output);
  }
  return { ok: !result.error && result.status === 0, result };
}

function run(label, command, args, options = {}) {
  const { ok, result } = runTry(label, command, args, options);
  if (result.error) {
    fail(options.step ?? "run", `${label}失败：${result.error.message}`);
  }
  if (!ok) {
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
const nodeBin = envValue("QUBIUS_NODE_BIN") ? abs(envValue("QUBIUS_NODE_BIN")) : process.execPath;
// 部署行为开关：忙碌保护（FORCE/WAIT）与“无变化也强制重启”（RESTART）。
const deployForce = envBool("QUBIUS_DEPLOY_FORCE", false);
const deployWaitRaw = envValue("QUBIUS_DEPLOY_WAIT");
const deployWait = deployWaitRaw === undefined
  ? undefined
  : (/^\d+$/.test(deployWaitRaw.trim()) ? Number(deployWaitRaw.trim()) : Number.NaN);
const deployRestart = envBool("QUBIUS_DEPLOY_RESTART", false);
deployConsole = envBool("QUBIUS_DEPLOY_CONSOLE", false);

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
async function stopRole(entry, options = {}) {
  if (entry.stopped && !options.force) return;
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

function stampPath(entry) {
  return path.join(entry.dataDir, ".deploy-stamp");
}

function configHashOf(entry) {
  return sha256File(entry.configFile) ?? "none";
}

function envHashOf() {
  return ENV_FILE ? (sha256File(ENV_FILE) ?? "none") : "none";
}

function writeRoleStamp(entry) {
  writeDeployStamp(stampPath(entry), {
    head: gitHead(entry.repo),
    configHash: configHashOf(entry),
    envHash: envHashOf(),
    port: entry.port,
  });
}

/**
 * 该角色重启前要检查的端口：新端口、stamp 里上次实际使用的端口（改端口时
 * 旧会话仍挂在旧端口上），以及父进程已知的旧端口。
 */
function portsForEntry(entry) {
  const stamp = readDeployStamp(stampPath(entry));
  return deployPorts({
    port: entry.port,
    stampPort: stamp?.port,
    parentPort: PARENT_PORT,
    isParent: entry.role === PARENT_ROLE,
  });
}

/** 汇总该角色所有可能端口上的进行中会话数（取最大值，同一服务不重复计数）。 */
async function activeSessionsForEntry(entry) {
  let active = 0;
  for (const port of portsForEntry(entry)) {
    active = Math.max(active, activeSessionsFromHealth(await fetchHealth(port)));
  }
  return active;
}

class BusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BusyError";
  }
}

/**
 * 停止/重启一个健康实例前检查进行中的会话（每次调用都重新读 /api/health，
 * 构建后要再查一次，避免构建期间新出现的会话被静默打断）。
 * QUBIUS_DEPLOY_FORCE=1 强制继续；QUBIUS_DEPLOY_WAIT=<秒> 等待空闲；
 * 都没有时（页面部署是非交互的）抛 BusyError，由调用方决定中止/先恢复已停角色。
 */
async function guardBusy(entry) {
  let active = await activeSessionsForEntry(entry);
  const decision = busyDecision({
    activeSessions: active,
    force: deployForce,
    waitSeconds: deployWait,
  });
  if (decision.action === "proceed") {
    if (decision.reason) say(`${entry.label}：${decision.reason}`);
    return;
  }
  if (decision.action === "fail") {
    throw new BusyError(`${entry.label}：${decision.reason}`);
  }

  const limit = decision.waitSeconds;
  say(`${entry.label}：${decision.reason}`);
  const deadline = Date.now() + limit * 1000;
  while (active > 0 && Date.now() < deadline) {
    await sleep(2000);
    active = await activeSessionsForEntry(entry);
  }
  if (active <= 0) {
    say(`${entry.label}已空闲，继续`);
    return;
  }
  throw new BusyError(
    `${entry.label}等待 ${limit} 秒后仍有 ${active} 个会话进行中，已中止部署（可设 QUBIUS_DEPLOY_FORCE=1 强制重启，或先停止这些会话再重试）`,
  );
}

/** 中止前把本次为 npm ci 停掉的实例按旧版本重新拉起（health-only）。 */
async function restoreStoppedPlans(plans) {
  let restored = 0;
  for (const { entry } of plans) {
    if (!entry.stopped || entry.restored) continue;
    restoreNodeModulesWhenBackedUp(entry.repo, entry.nodeModulesBackedUp);
    entry.nodeModulesBackedUp = false;
    discardStaging(entry.repo);
    say(`${entry.label}已停止，恢复 node_modules 后按旧版本重新拉起`);
    try {
      await startRole(entry, { skipHead: true });
      writeRoleStamp(entry);
      restored += 1;
    } catch (error) {
      say(`${entry.label}旧版本重新拉起失败：${error instanceof Error ? error.message : error}`);
    }
  }
  return restored;
}

/**
 * 只把产物构建到 server/dist.next、web/dist.next，并写入 staging 的 build.json；
 * live 完全不动。失败时清理 .next 并返回 false。
 */
function stageBuildRole(entry) {
  const repo = entry.repo;
  const serverDir = path.join(repo, "server");
  const webDir = path.join(repo, "web");
  const tsc = path.join(repo, "node_modules", "typescript", "bin", "tsc");
  const vite = path.join(repo, "node_modules", "vite", "bin", "vite.js");
  const env = { ...process.env, PATH: childPath };
  discardStaging(repo);
  say(`构建 ${entry.label}（staging，live 不动）：${repo}`);

  const steps = [
    ["构建 server", [tsc, "--outDir", "dist.next"], serverDir],
    ["类型检查 web", [tsc, "--noEmit"], webDir],
    ["构建 web", [vite, "build", "--outDir", "dist.next"], webDir],
  ];
  for (const [label, args, cwd] of steps) {
    const { ok } = runTry(label, nodeBin, args, {
      cwd,
      step: `build-${entry.role}`,
      env,
    });
    if (!ok) {
      discardStaging(repo);
      return false;
    }
  }

  const head = gitHead(repo);
  const body = {
    head,
    version: packageVersion(repo),
    builtAt: new Date().toISOString(),
    dirty: gitDirty(repo),
  };
  const serverNext = path.join(repo, "server", "dist.next");
  fs.mkdirSync(serverNext, { recursive: true });
  const tmp = path.join(serverNext, `.build.json.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  fs.renameSync(tmp, path.join(serverNext, "build.json"));
  say(`已暂存 server/dist.next/build.json：head=${head}`);
  return true;
}

function buildFailure(step, message) {
  const error = new Error(message);
  error.step = step;
  return error;
}

/** 构建失败时把自己的角色恢复到旧版本（恢复依赖、丢弃 staging、必要时拉起）。 */
async function restorePreparedEntry(entry) {
  restoreNodeModulesWhenBackedUp(entry.repo, entry.nodeModulesBackedUp);
  entry.nodeModulesBackedUp = false;
  discardStaging(entry.repo);
  if (entry.stopped) {
    try {
      await startRole(entry, { skipHead: true });
      writeRoleStamp(entry);
      say(`${entry.label}已恢复旧版本`);
    } catch (error) {
      say(`${entry.label}旧版本未能拉起：${error.message}`);
    }
    entry.restored = true;
  }
}

/**
 * 安装依赖（先停旧进程并备份 node_modules）并把产物 stage 到 .next。
 * 失败时恢复本角色的 node_modules/旧版本后抛错，由主流程恢复其它已停角色。
 * 返回 { install, stopped } 供后续 swap/回滚使用。
 */
async function prepareBuild(entry) {
  const repo = entry.repo;
  const install = needsInstall(repo);
  let stopped = false;

  if (install) {
    say(`${entry.label}需要重新安装依赖，先停止旧进程并备份 node_modules`);
    await stopRole(entry);
    stopped = true;
    try {
      entry.nodeModulesBackedUp = backupNodeModules(repo);
    } catch (error) {
      entry.nodeModulesBackedUp = false;
      await restorePreparedEntry(entry);
      throw buildFailure(`install-${entry.role}`, `${entry.label}备份 node_modules 失败：${error.message}`);
    }
    const { ok } = runTry("安装依赖", "npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: repo,
      step: `install-${entry.role}`,
      shell: isWindows,
      env: { ...process.env, PATH: childPath },
    });
    if (!ok) {
      await restorePreparedEntry(entry);
      throw buildFailure(`install-${entry.role}`, `${entry.label}安装依赖失败`);
    }
    const hash = sha256File(path.join(repo, "package-lock.json"));
    if (hash) {
      try {
        fs.writeFileSync(path.join(repo, "node_modules", ".qubius-lock-hash"), `${hash}\n`);
      } catch {
        // 写不了标记只会导致下次重复安装。
      }
    }
  }

  if (!stageBuildRole(entry)) {
    await restorePreparedEntry(entry);
    throw buildFailure(`build-${entry.role}`, `${entry.label}构建失败`);
  }
  return { install, stopped };
}

/** 部署中止时把其它已停角色回滚并拉起旧版本；已经成功启动的角色不动。 */
async function recoverOtherPlans(plans, swapped, { exclude = null, started = null } = {}) {
  for (const { entry } of plans) {
    if (exclude && entry === exclude) continue;
    if (started && started.has(entry)) continue;
    if (swapped.has(entry)) {
      try {
        rollbackDist(entry.repo);
      } catch (error) {
        say(`${entry.label}回滚失败：${error.message}`);
      }
      swapped.delete(entry);
    }
    restoreNodeModulesWhenBackedUp(entry.repo, entry.nodeModulesBackedUp);
    entry.nodeModulesBackedUp = false;
    discardStaging(entry.repo);
    if (!entry.stopped) continue;
    try {
      await startRole(entry, { skipHead: true });
      writeRoleStamp(entry);
      say(`${entry.label}已恢复旧版本`);
    } catch (error) {
      say(`${entry.label}恢复旧版本失败：${error.message}`);
    }
  }
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

async function startRole(entry, options = {}) {
  const index = path.join(entry.repo, "server", "dist", "index.js");
  if (!fs.existsSync(index)) throw new Error(`缺少构建产物：${index}`);
  fs.mkdirSync(entry.dataDir, { recursive: true });
  const logFile = path.join(entry.dataDir, "qubius.log");
  const pidfile = path.join(entry.dataDir, "qubius.pid");
  say(`启动 ${entry.label}：${index}`);
  let child;
  let logStream;
  if (deployConsole) {
    /* 终端模式：服务跟部署任务一起待在这个窗口里，stdout/stderr 同时透传到
       控制台和 qubius.log；关闭窗口或 Ctrl+C 会连同服务一起停止。 */
    child = spawn(nodeBin, [index], {
      cwd: entry.repo,
      env: serverEnv(entry),
      detached: false,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    logStream = fs.createWriteStream(logFile, { flags: "a" });
    child.stdout?.pipe(logStream, { end: false });
    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
  } else {
    const fd = fs.openSync(logFile, "a");
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
  }
  let exited = false;
  child.on("exit", () => {
    exited = true;
    if (logStream) logStream.end();
  });
  child.on("error", (error) => {
    exited = true;
    say(`${entry.label}启动失败：${error.message}`);
    if (logStream) logStream.end();
  });
  if (deployConsole) consoleServers.push(child);
  else child.unref();
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
    throw new Error(`${entry.label}启动后 /api/health 未就绪，查看 ${logFile}`);
  }
  if (health.pid && child.pid && health.pid !== child.pid) {
    throw new Error(`${entry.label}端口 ${entry.port} 被其他进程占用（pid=${health.pid}）`);
  }
  // 回滚后启动的是旧产物，health 的 head 是旧 HEAD，不能再和当前 git HEAD 比较。
  if (!options.skipHead) {
    const head = gitHead(entry.repo);
    if (typeof health.head === "string" && health.head && head && health.head !== head) {
      throw new Error(
        `${entry.label} health 的 head=${health.head} 与当前 git HEAD=${head} 不一致（构建后未重启？）`,
      );
    }
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

/** 无变化部署时只确保局域网入口存活，不主动重启它。 */
async function ensureProxyAlive(entry) {
  const credentials = envValue("LAN_PROXY_CREDENTIALS") || path.join(configDir, "lan-proxy.credentials");
  if (!fs.existsSync(credentials)) {
    // 没有凭据时 startProxy 会直接跳过；不要因为“找不到局域网地址”让部署失败。
    await startProxy(entry);
    return;
  }
  const pidfile = path.join(entry.dataDir, "lan-proxy.pid");
  const pid = readPid(pidfile);
  const pidAlive = Boolean(pid && isAlive(pid) && isNodeProcess(pid));
  const host = proxyLanAddress(entry);
  const listening = Boolean(host && (await isPortListening(host, entry.port)));
  const plan = proxyPlan({ restart: false, pidAlive, listening });
  if (plan === "keep") {
    say(`${entry.label} LAN 入口已在运行，跳过重启`);
    return;
  }
  await startProxy(entry);
}

/**
 * 局域网地址与 lan-proxy.mjs 共用 deploy-lib 的实现，用来校验它真的监听上了。
 * env 文件里的 QUBIUS_LAN_HOST/LAN_PROXY_HOST 也要参与，显式指定优先。
 */
function proxyLanAddress(entry) {
  try {
    return lanAddress({ env: baseChildEnv() });
  } catch (error) {
    fail(`proxy-${entry.role}`, error instanceof Error ? error.message : String(error));
  }
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
  const host = proxyLanAddress(entry);
  const logFile = path.join(entry.dataDir, "lan-proxy.log");
  const pidfile = path.join(entry.dataDir, "lan-proxy.pid");
  // 探活和子进程用同一个 host：显式 LAN_PROXY_HOST 优先，避免两个变量并存时
  // 子进程监听一个地址、部署任务却在另一个地址探活而误判失败。
  const env = proxyChildEnv({
    ...serverEnv(entry),
    LAN_PROXY_PORT: String(entry.port),
    LAN_PROXY_UPSTREAM_PORT: String(entry.port),
    LAN_PROXY_CREDENTIALS: credentials,
  }, host);
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

// ── 终端模式：端口确认与前台服务 ────────────────────────────────────────────

/** 在控制台里问一个 y/N 问题；非交互终端直接返回默认值，避免部署挂死。 */
async function askYesNo(question, defaultYes) {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return /^(y|yes)$/.test(answer);
  } finally {
    rl.close();
  }
}

function describeListener(pid) {
  const info = processInfo(pid);
  const name = info?.name || "未知进程";
  const command = info?.command ? `  ${info.command}` : "";
  return `PID ${pid} ${name}${command}`;
}

/**
 * 部署前检查每个实例的端口。当前 qubius 实例占着端口是正常的（部署会先优雅
 * 停止它），只需要确认；别的进程占用则列出并询问是否强制停止。页面触发部署
 * 时会先打开这个终端窗口，用户能在部署真正开始前决定要不要继续。
 */
async function confirmPorts() {
  if (!deployConsole) return;
  for (const entry of entries) {
    const { pids } = listenerPids(entry.port);
    if (pids.length === 0) continue;
    const health = await fetchHealth(entry.port);
    const healthPid = Number(health?.pid) || 0;
    /* 局域网入口和当前实例都是部署流程自己会重启的进程，不算“外部占用”。 */
    const proxyPid = readPid(path.join(entry.dataDir, "lan-proxy.pid"));
    const ours = new Set([healthPid, PARENT_PID, proxyPid ?? 0].filter((pid) => pid > 0));
    const known = pids.filter((pid) => ours.has(pid));
    const unknown = pids.filter((pid) => !ours.has(pid));

    if (unknown.length > 0) {
      say(`端口 ${entry.port} 被其他进程占用：`);
      for (const pid of unknown) say(`  ${describeListener(pid)}`);
      const stop = await askYesNo("停止占用进程并继续部署？[y/N] ", false);
      if (!stop) fail("port", `已取消部署：端口 ${entry.port} 被其他进程占用`);
      for (const pid of unknown) {
        try {
          stopProcess(pid);
          say(`已停止占用进程 PID ${pid}`);
        } catch (error) {
          say(`无法停止 PID ${pid}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        await waitPortFree(entry.port, `端口 ${entry.port}`);
      } catch (error) {
        fail("port", error instanceof Error ? error.message : String(error));
      }
    }

    if (known.length > 0) {
      say(`端口 ${entry.port} 由运行中的${entry.label}占用：`);
      for (const pid of known) say(`  ${describeListener(pid)}`);
      const proceed = await askYesNo("部署会先停止当前实例，继续？[Y/n] ", true);
      if (!proceed) fail("port", "已取消部署：保留当前运行实例");
    }
  }
}

/** 终端模式下启动的服务进程：等服务退出后部署任务再结束，窗口保持在前台。 */
const consoleServers = [];

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 1);
      return;
    }
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  writeStatus("running", "prepare", "准备部署");
  say(`===== ${STARTED_AT} deploy ${JOB_ID}（${isWindows ? "Windows" : "macOS"} 部署任务）=====`);
  say(`部署仓库：${DEPLOY_REPO_ROOT}`);
  say(`部署配置：env=${ENV_FILE || "未指定"}`);

  await confirmPorts();

  for (const entry of entries) ensureRepo(entry);

  if (pullLatest) {
    for (const entry of entries) pullLatestCode(entry);
  }

  say("生成实例配置");
  for (const entry of entries) writeConfig(entry);

  // 先逐角色判断是否真的需要重启。构建产物、HEAD、config/env 指纹都没变化、
  // 且服务健康时跳过构建和重启，避免无谓打断正在工作的会话。
  const plans = [];
  for (const entry of entries) {
    const healthy = (await fetchHealth(entry.port)) !== null;
    const buildNeeded = needsBuild(entry.repo);
    const decision = deployDecision({
      buildNeeded,
      configHash: configHashOf(entry),
      envHash: envHashOf(),
      stamp: readDeployStamp(stampPath(entry)),
      head: gitHead(entry.repo),
      healthy,
      forceRestart: deployRestart,
    });
    plans.push({ entry, decision });
  }

  const restartPlans = plans.filter((plan) => plan.decision.restart);

  // 构建/停止之前先统一检查一遍：任一角色忙时，在改动任何进程之前退出。
  // 检查范围同时包含新端口、stamp 里上次的端口和父进程实际在用的旧端口。
  for (const { entry } of restartPlans) {
    try {
      await guardBusy(entry);
    } catch (error) {
      if (error instanceof BusyError) fail("busy", error.message, 3);
      throw error;
    }
  }

  const prep = new Map();
  try {
    for (const { entry, decision } of plans) {
      if (!decision.restart) {
        say(`${entry.label}：无变化，跳过构建和重启（${decision.reason}）`);
        continue;
      }
      say(`${entry.label}：需要重启（${decision.reason}）`);
      if (decision.build) {
        writeStatus("running", `install-${entry.role}`, `正在安装/构建${entry.label}`);
        prep.set(entry, await prepareBuild(entry));
      } else {
        say(`${entry.label}无需重新构建，直接重启`);
        prep.set(entry, { install: false, stopped: false });
      }
    }
  } catch (error) {
    // 构建失败时先把之前为 npm ci 停掉的角色恢复，再报告失败。
    await restoreStoppedPlans(restartPlans);
    fail(error.step ?? "build", error instanceof Error ? error.message : String(error));
  }

  // 构建可能耗时，停止前再读一次 activeSessions；FORCE 已显式要求跳过。
  // 若构建期间为 npm ci 停过实例，中止前恢复依赖并按旧版本重新拉起。
  if (!deployForce) {
    try {
      for (const { entry } of restartPlans) await guardBusy(entry);
    } catch (error) {
      if (error instanceof BusyError) {
        await restoreStoppedPlans(restartPlans);
        fail("busy", error.message, 3);
      }
      throw error;
    }
  }

  if (restartPlans.length > 0) {
    writeStatus("running", "stop", "正在停止当前服务");
    try {
      for (const { entry } of restartPlans) await stopRole(entry);
      for (const { entry } of restartPlans) await waitPortFree(entry.port, entry.label);
    } catch (error) {
      // 还没 swap，恢复所有已停角色（含依赖备份）后再失败。
      await recoverOtherPlans(restartPlans, new Set());
      fail("stop", error instanceof Error ? error.message : String(error));
    }

    // 停稳后再原子切换 staging -> live；失败则恢复依赖并拉起旧版本。
    const swapped = new Set();
    for (const { entry, decision } of plans) {
      if (!decision.restart || !decision.build) continue;
      try {
        swapDist(entry.repo);
        swapped.add(entry);
        say(`${entry.label}已切换 server/dist、web/dist（旧产物在 *.prev）`);
      } catch (error) {
        say(`${entry.label}切换新产物失败：${error.message}`);
        restoreNodeModulesWhenBackedUp(entry.repo, entry.nodeModulesBackedUp);
        entry.nodeModulesBackedUp = false;
        discardStaging(entry.repo);
        try {
          await startRole(entry, { skipHead: true });
          writeRoleStamp(entry);
          say(`${entry.label}已按旧版本重新拉起`);
        } catch (restoreError) {
          say(`${entry.label}旧版本未能拉起：${restoreError.message}`);
        }
        // 其它已停角色还没启动，恢复旧版本后再报告失败。
        await recoverOtherPlans(restartPlans, swapped, { exclude: entry });
        fail(`swap-${entry.role}`, `${entry.label}切换新产物失败：${error.message}`);
      }
    }

    const started = new Set();
    for (const { entry } of restartPlans) {
      writeStatus("running", `start-${entry.role}`, `正在启动${entry.label}`);
      try {
        await startRole(entry);
      } catch (error) {
        say(`${entry.label}新版本启动失败：${error.message}`);
        await stopRole(entry, { force: true });
        let rollbackOk = true;
        if (swapped.has(entry)) {
          try {
            rollbackDist(entry.repo);
            swapped.delete(entry);
            say(`${entry.label}已回滚 server/dist、web/dist`);
          } catch (rollbackError) {
            rollbackOk = false;
            say(`${entry.label}回滚失败（首次部署没有 .prev？）：${rollbackError.message}`);
          }
        }
        restoreNodeModulesWhenBackedUp(entry.repo, entry.nodeModulesBackedUp);
        entry.nodeModulesBackedUp = false;
        if (!rollbackOk) {
          // 首次部署没有旧产物：live 仍是启动失败的新版本，不能再拉起它冒充“已回滚”。
          await recoverOtherPlans(restartPlans, swapped, { exclude: entry, started });
          fail(`start-${entry.role}`, `${entry.label}新版本启动失败，且无旧版本可回滚`);
        }
        try {
          await startRole(entry, { skipHead: true });
          say(`${entry.label}已回滚到旧版本`);
        } catch (oldError) {
          say(`${entry.label}旧版本也未能启动：${oldError.message}`);
          await recoverOtherPlans(restartPlans, swapped, { exclude: entry, started });
          fail(
            `start-${entry.role}`,
            `${entry.label}新版本启动失败，回滚后旧版本也未能启动`,
          );
        }
        // 后面还没启动的角色也要恢复旧版本，避免一直被停着。
        await recoverOtherPlans(restartPlans, swapped, { exclude: entry, started });
        fail(`start-${entry.role}`, `${entry.label}新版本启动失败，已回滚到旧版本：${error.message}`);
      }
      started.add(entry);
      // 成功重启后记录当前状态，供下次判断是否可以跳过。
      writeRoleStamp(entry);
      // 本次没有安装依赖时，旧的 node_modules.prev 已过期，成功部署后清掉。
      if (!prep.get(entry)?.install) cleanupNodeModulesPrev(entry.repo);
    }
  } else {
    say("没有需要重启的实例，跳过停止和启动");
  }

  if (startLan) {
    const restarted = new Set(restartPlans.map((plan) => plan.entry));
    for (const entry of entries) {
      if (restarted.has(entry)) {
        // 实例已重启，代理跟着重启以指向新进程。
        await stopProxy(entry);
        await startProxy(entry);
      } else {
        // 无变化时只确保代理存活，不主动中断正在服务的局域网入口。
        await ensureProxyAlive(entry);
      }
    }
  } else {
    say("跳过局域网入口（QUBIUS_START_LAN=0）");
  }

  finish("success", "done", "部署完成");
  say("部署完成");

  /* 终端模式下 make deploy 的进程要等任务退出才能继续，令牌在这里直接打到
     窗口；不能用 say()，否则会一并写进 deploy.log。 */
  if (deployConsole && envBool("QUBIUS_DEPLOY_PRINT_TOKEN", false)) {
    for (const entry of entries) {
      try {
        const file = path.join(entry.dataDir, "auth-token");
        if (!fs.existsSync(file)) continue;
        const token = fs.readFileSync(file, "utf8").trim();
        if (token) console.log(`${entry.label} API 访问令牌（只显示这一次）：${token}`);
      } catch {
        // 读不到就跳过；令牌仍可在设置页重置。
      }
    }
  }

  if (deployConsole && consoleServers.length > 0) {
    say("服务已在前台运行；按 Ctrl+C 或关闭此窗口即停止。");
    /* Ctrl+C 会同时送达前台服务，它会自己优雅退出；这里补一刀停掉局域网
       入口，避免留下后台 node 进程。 */
    process.once("SIGINT", () => {
      if (startLan) {
        for (const entry of entries) {
          const pid = readPid(path.join(entry.dataDir, "lan-proxy.pid"));
          if (pid && isAlive(pid)) {
            try {
              process.kill(pid);
            } catch {
              // 已经退出。
            }
          }
        }
      }
      process.exit(130);
    });
    const codes = await Promise.all(consoleServers.map((child) => waitForExit(child)));
    /* 主服务退出后 LAN 入口没有上游，一并停掉，避免留下后台 node 进程。 */
    if (startLan) {
      for (const entry of entries) {
        try {
          await stopProxy(entry);
        } catch {
          // 停不掉就留给 make stop / 下次部署处理。
        }
      }
    }
    const failed = codes.find((code) => code !== 0);
    if (failed !== undefined) {
      say(`服务进程已退出（退出码 ${failed}）`);
      process.exitCode = failed || 1;
    }
  }
}

main().catch((error) => {
  fail("unexpected", `部署任务异常：${error instanceof Error ? error.message : String(error)}`);
});
