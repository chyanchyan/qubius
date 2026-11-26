#!/usr/bin/env node
// 跨平台启动/部署入口：make start/stop/restart/install/pull/deploy* 都调用这里。
//
// Linux 上把动作转给成熟的 deploy/*.sh（systemd、flock、两个实例、局域网入口）；
// Windows/macOS 上用 Node 完成同样的启动/停止，部署则交给 deploy-job.mjs。
// 只使用 Node 内置模块，不依赖 bash。
//
// 用法：node deploy/cli.mjs <start|stop|restart|status|install|pull|deploy|deploy-lan|deploy-wan>
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./deploy-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";
const ACTION = process.argv[2] || "";

function fail(message, code = 1) {
  console.error(`qubius: ${message}`);
  process.exit(code);
}

function say(message) {
  console.log(message);
}

function expandHome(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(home, text.slice(2));
  return text
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => process.env[name] ?? match);
}

const defaultConfigDir = path.join(repoRoot, ".qubius");
const configDir = path.resolve(
  (process.env.QUBIUS_CONFIG_DIR ?? "").trim() || defaultConfigDir,
);

function resolveEnvFile() {
  const configured = (process.env.QUBIUS_ENV ?? "").trim();
  if (configured) return path.resolve(repoRoot, configured);
  const candidates = [path.join(configDir, "env"), path.join(repoRoot, "deploy", "env")];
  return candidates.find((file) => fs.existsSync(file)) ?? path.join(configDir, "env");
}

const envFile = resolveEnvFile();
let fileVars = {};
try {
  fileVars = parseEnvFile(fs.readFileSync(envFile, "utf8"), process.env);
} catch {
  fileVars = {};
}

/** 与 shell 一致：调用者导出的环境变量优先于 env 文件。 */
function envValue(name, fallback) {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  const fromFile = fileVars[name];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return fallback;
}

function envBool(name, fallback) {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  switch (String(raw).trim().toLowerCase()) {
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
  const value = Number(String(raw).trim());
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}

function resolveDir(value) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(configDir, expanded);
}

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 不存在。
  }
}

function killPid(pid, label) {
  if (!alive(pid)) return false;
  say(`停止${label}（pid=${pid}）`);
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // 继续等待进程退出。
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    // 用 Atomics.wait 做同步小睡，避免把生命周期的其余逻辑写成异步。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // 已经退出。
  }
  return true;
}

function roleEntries() {
  const entries = [];
  const primaryRepo = resolveDir(envValue("QUBIUS_PRIMARY_DIR", repoRoot));
  const secondaryRepo = resolveDir(envValue("QUBIUS_SECONDARY_DIR", path.join(os.homedir(), "co-qubius")));
  if (envBool("QUBIUS_START_PRIMARY", true)) {
    entries.push({
      role: "primary",
      label: "主实例 qubius",
      flag: "0",
      repo: primaryRepo,
      dataDir: resolveDir(envValue("QUBIUS_DATA_PRIMARY", path.join(primaryRepo, ".qubius", "data"))),
      port: envInt("QUBIUS_PRIMARY_PORT", 8787),
      configName: "config.yaml",
    });
  }
  if (envBool("QUBIUS_START_SECONDARY", false)) {
    entries.push({
      role: "secondary",
      label: "副实例 co-qubius",
      flag: "1",
      repo: secondaryRepo,
      dataDir: resolveDir(envValue("QUBIUS_DATA_SECONDARY", path.join(secondaryRepo, ".qubius", "data"))),
      port: envInt("QUBIUS_SECONDARY_PORT", 8788),
      configName: "config-secondary.yaml",
    });
  }
  return entries;
}

function health(port) {
  return new Promise((resolve) => {
    const request = fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    request
      .then(async (response) => {
        if (!response.ok) return resolve(null);
        try {
          return resolve(await response.json());
        } catch {
          return resolve({ ok: true });
        }
      })
      .catch(() => resolve(null));
  });
}

async function waitHealthy(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function entryConfigFile(entry) {
  const deployed = path.join(configDir, entry.configName);
  if (fs.existsSync(deployed)) return deployed;
  const legacy = path.join(entry.repo, entry.configName);
  return fs.existsSync(legacy) ? legacy : deployed;
}

/** 以 config.yaml 的 dataDir/listen 为准；没有配置时用 env/默认值。 */
function effectiveSettings(entry) {
  let dataDir = entry.dataDir;
  let port = entry.port;
  try {
    const configFile = entryConfigFile(entry);
    const text = fs.readFileSync(configFile, "utf8");
    const data = text.match(/^\s*dataDir:\s*(.+?)(?:\s+#.*)?\s*$/m);
    if (data) {
      const value = expandHome(data[1].replace(/^['"]|['"]$/g, ""));
      dataDir = path.isAbsolute(value) ? path.resolve(value) : path.resolve(path.dirname(configFile), value);
    }
    const listen = text.match(/^\s*listen:\s*[^\s#]+:(\d+)(?:\s+#.*)?\s*$/m);
    if (listen) port = Number(listen[1]) || port;
  } catch {
    // 没有配置文件时用 env/默认值。
  }
  return { ...entry, dataDir, port };
}

function childEnv(entry) {
  return {
    ...fileVars,
    ...process.env,
    QUBIUS_CONFIG_DIR: configDir,
    QUBIUS_REPO_DIR: entry.repo,
    QUBIUS_SECONDARY: entry.flag,
    QUBIUS_CONFIG: entryConfigFile(entry),
    // QUBIUS_ENV 只在文件真实存在时设置：否则部署页会拒绝写配置。
    ...(fs.existsSync(envFile) ? { QUBIUS_ENV: envFile } : {}),
  };
}

function ensureBuilt(entry) {
  const index = path.join(entry.repo, "server", "dist", "index.js");
  const web = path.join(entry.repo, "web", "dist", "index.html");
  if (fs.existsSync(index) && fs.existsSync(web)) return;
  say(`${entry.label}缺少构建产物，先执行 npm run build`);
  const result = spawnSync("npm", ["run", "build"], {
    cwd: entry.repo,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.status !== 0) fail(`${entry.label}构建失败`);
}

async function startEntry(entry) {
  entry = effectiveSettings(entry);
  const current = await health(entry.port);
  if (current) {
    say(`${entry.label}已在运行：http://127.0.0.1:${entry.port}`);
    return;
  }
  if (!fs.existsSync(entry.repo)) {
    fail(`${entry.label}的 checkout 不存在：${entry.repo}`);
  }
  const pidfile = path.join(entry.dataDir, "qubius.pid");
  const pid = readPid(pidfile);
  if (alive(pid)) {
    fail(`${entry.label}的 pidfile 指向仍在运行的进程（pid=${pid}），但健康检查失败；先 make stop 或检查端口`);
  }
  ensureBuilt(entry);
  fs.mkdirSync(entry.dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(entry.dataDir, "qubius.log");
  const fd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(entry.repo, "server", "dist", "index.js")], {
      cwd: entry.repo,
      env: childEnv(entry),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  fs.writeFileSync(pidfile, `${child.pid ?? ""}\n`);
  say(`启动${entry.label}：http://127.0.0.1:${entry.port}（pid=${child.pid}）`);
  if (!(await waitHealthy(entry.port))) {
    fail(`${entry.label}启动后 /api/health 未就绪，查看 ${logFile}`);
  }
  await startLan(entry);
}

function lanCredentialsFile() {
  const configured = (envValue("LAN_PROXY_CREDENTIALS", "") ?? "").trim();
  return configured
    ? resolveDir(configured)
    : path.join(configDir, "lan-proxy.credentials");
}

async function startLan(entry) {
  if (!envBool("QUBIUS_START_LAN", true)) return;
  const credentials = lanCredentialsFile();
  if (!fs.existsSync(credentials)) {
    say(`跳过${entry.label}局域网入口（缺少 ${credentials}；到部署页启用或运行 make deploy-lan）`);
    return;
  }
  const script = path.join(entry.repo, "deploy", "lan-proxy.mjs");
  if (!fs.existsSync(script)) {
    say(`跳过${entry.label}局域网入口（缺少 ${script}）`);
    return;
  }
  const pidfile = path.join(entry.dataDir, "lan-proxy.pid");
  const pid = readPid(pidfile);
  if (alive(pid)) {
    say(`${entry.label}局域网入口已在运行（pid=${pid}）`);
    return;
  }
  const env = {
    ...childEnv(entry),
    LAN_PROXY_PORT: String(entry.port),
    LAN_PROXY_UPSTREAM_PORT: String(entry.port),
    LAN_PROXY_CREDENTIALS: credentials,
  };
  const lanHost = (envValue("QUBIUS_LAN_HOST", "") ?? "").trim();
  if (lanHost) env.LAN_PROXY_HOST = lanHost;
  const logFile = path.join(entry.dataDir, "lan-proxy.log");
  const fd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [script], {
      cwd: entry.repo,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();
  fs.writeFileSync(pidfile, `${child.pid ?? ""}\n`);
  say(`启动${entry.label}局域网入口（端口 ${entry.port}）`);
}

function stopEntry(entry) {
  entry = effectiveSettings(entry);
  killPid(readPid(path.join(entry.dataDir, "lan-proxy.pid")), `${entry.label}局域网入口`);
  removeFile(path.join(entry.dataDir, "lan-proxy.pid"));
  killPid(readPid(path.join(entry.dataDir, "qubius.pid")), entry.label);
  removeFile(path.join(entry.dataDir, "qubius.pid"));
}

async function startAll() {
  const entries = roleEntries();
  if (entries.length === 0) fail("没有启用的实例（检查 QUBIUS_START_PRIMARY / QUBIUS_START_SECONDARY）");
  for (const entry of entries) await startEntry(entry);
}

function stopAll() {
  const entries = roleEntries();
  if (entries.length === 0) {
    say("没有启用的实例（检查 QUBIUS_START_PRIMARY / QUBIUS_START_SECONDARY）");
    return;
  }
  for (const entry of entries) stopEntry(entry);
}

async function status() {
  const entries = roleEntries();
  say(`配置目录：${configDir}`);
  say(`env 文件：${envFile}${fs.existsSync(envFile) ? "" : "（不存在）"}`);
  const credentials = lanCredentialsFile();
  say(`局域网凭据：${credentials}${fs.existsSync(credentials) ? "" : "（未配置）"}`);
  for (const entry of entries) {
    const target = effectiveSettings(entry);
    const info = await health(target.port);
    say(
      `${target.label}：${info ? "运行中" : "未运行"} http://127.0.0.1:${target.port}`
        + `，数据目录 ${target.dataDir}`,
    );
  }
}

function ensureLanCredentials(print = true) {
  const file = lanCredentialsFile();
  if (fs.existsSync(file)) return;
  const user = (envValue("QUBIUS_LAN_USER", "qubius") ?? "qubius").trim() || "qubius";
  if (!/^[^\s:]{1,64}$/.test(user)) fail("QUBIUS_LAN_USER 只能包含非空白、非冒号字符（1-64）");
  const password = crypto.randomBytes(12).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${user}:${password}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 不支持 chmod。
  }
  if (print) {
    say("已生成局域网登录凭据（只显示这一次）：");
    say(`  用户名：${user}`);
    say(`  密码：${password}`);
    say(`  文件：${file}`);
  }
}

function shellQuote(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 把受管键写回 env 文件，保留其它行和注释；部署后的启动/重启能继续沿用。 */
function upsertEnv(values) {
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch {
    existing = "";
  }
  const managed = new Set(Object.keys(values));
  const emitted = new Set();
  const lines = [];
  for (const line of existing.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && managed.has(match[1])) {
      const key = match[1];
      if (emitted.has(key)) continue;
      emitted.add(key);
      lines.push(`${key}=${shellQuote(values[key])}`);
      continue;
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const key of managed) {
    if (!emitted.has(key)) lines.push(`${key}=${shellQuote(values[key])}`);
  }
  fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    // Windows 不支持 chmod。
  }
}

function printAuthTokens(entries) {
  for (const entry of entries) {
    const file = path.join(entry.dataDir, "auth-token");
    if (!fs.existsSync(file)) continue;
    say(`${entry.label} API 访问令牌（只显示这一次）：${fs.readFileSync(file, "utf8").trim()}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        const error = new Error(`被信号 ${signal} 终止`);
        error.exitCode = 1;
        reject(error);
      } else if (code === 0) {
        resolve();
      } else {
        const error = new Error(`退出码 ${code ?? "未知"}`);
        // 保留子进程退出码（尤其是忙碌保护的 3），让 make 入口也能透传。
        error.exitCode = typeof code === "number" ? code : 1;
        reject(error);
      }
    });
  });
}

async function deployWithNode(mode) {
  if (!fs.existsSync(envFile)) {
    fail(`找不到 ${envFile}；先运行 make quickstart 或在 /deploy 完成首次配置`);
  }
  const startLan = mode !== "local";
  if (startLan) ensureLanCredentials();
  const primaryRepo = resolveDir(envValue("QUBIUS_PRIMARY_DIR", repoRoot));
  const secondaryRepo = resolveDir(envValue("QUBIUS_SECONDARY_DIR", path.join(os.homedir(), "co-qubius")));
  const jobEnv = {
    ...fileVars,
    ...process.env,
    QUBIUS_ENV: envFile,
    QUBIUS_CONFIG_DIR: configDir,
    QUBIUS_REPO_DIR: repoRoot,
    QUBIUS_PRIMARY_DIR: primaryRepo,
    QUBIUS_SECONDARY_DIR: secondaryRepo,
    QUBIUS_DATA_PRIMARY: resolveDir(envValue("QUBIUS_DATA_PRIMARY", path.join(primaryRepo, ".qubius", "data"))),
    QUBIUS_DATA_SECONDARY: resolveDir(envValue("QUBIUS_DATA_SECONDARY", path.join(secondaryRepo, ".qubius", "data"))),
    QUBIUS_PRIMARY_PORT: String(envInt("QUBIUS_PRIMARY_PORT", 8787)),
    QUBIUS_SECONDARY_PORT: String(envInt("QUBIUS_SECONDARY_PORT", 8788)),
    QUBIUS_START_PRIMARY: envBool("QUBIUS_START_PRIMARY", true) ? "1" : "0",
    QUBIUS_START_SECONDARY: envBool("QUBIUS_START_SECONDARY", false) ? "1" : "0",
    QUBIUS_START_LAN: startLan ? "1" : "0",
    QUBIUS_DEPLOY_STATUS: path.join(configDir, "deploy.json"),
    QUBIUS_DEPLOY_LOG: path.join(configDir, "deploy.log"),
    QUBIUS_DEPLOY_JOB_ID: crypto.randomUUID(),
    QUBIUS_DEPLOY_STARTED_AT: new Date().toISOString(),
    QUBIUS_DEPLOY_REPO_ROOT: repoRoot,
  };
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // 把这次部署的入口选择写回 env，之后的 make start/restart 沿用同一套目录和 LAN 开关。
  upsertEnv({
    QUBIUS_CONFIG_DIR: configDir,
    QUBIUS_PRIMARY_DIR: jobEnv.QUBIUS_PRIMARY_DIR,
    QUBIUS_SECONDARY_DIR: jobEnv.QUBIUS_SECONDARY_DIR,
    QUBIUS_DATA_PRIMARY: jobEnv.QUBIUS_DATA_PRIMARY,
    QUBIUS_DATA_SECONDARY: jobEnv.QUBIUS_DATA_SECONDARY,
    QUBIUS_PRIMARY_PORT: jobEnv.QUBIUS_PRIMARY_PORT,
    QUBIUS_SECONDARY_PORT: jobEnv.QUBIUS_SECONDARY_PORT,
    QUBIUS_START_PRIMARY: jobEnv.QUBIUS_START_PRIMARY,
    QUBIUS_START_SECONDARY: jobEnv.QUBIUS_START_SECONDARY,
    QUBIUS_START_LAN: jobEnv.QUBIUS_START_LAN,
    ...(envValue("QUBIUS_LAN_USER") ? { QUBIUS_LAN_USER: envValue("QUBIUS_LAN_USER") } : {}),
  });
  try {
    await run(process.execPath, [path.join(scriptDir, "deploy-job.mjs")], { cwd: repoRoot, env: jobEnv });
  } catch (error) {
    fail(
      `部署任务失败：${error.message}；查看 ${jobEnv.QUBIUS_DEPLOY_LOG}`,
      typeof error.exitCode === "number" ? error.exitCode : 1,
    );
  }
  const entries = [];
  if (jobEnv.QUBIUS_START_PRIMARY === "1") {
    entries.push({ role: "primary", label: "主实例 qubius", dataDir: jobEnv.QUBIUS_DATA_PRIMARY });
  }
  if (jobEnv.QUBIUS_START_SECONDARY === "1") {
    entries.push({ role: "secondary", label: "副实例 co-qubius", dataDir: jobEnv.QUBIUS_DATA_SECONDARY });
  }
  if (startLan) printAuthTokens(entries);
  if (mode === "wan") {
    await applyEdge(jobEnv, entries);
  }
  say(`部署完成：${mode}`);
}

async function applyEdge(jobEnv, entries) {
  const primary = jobEnv.QUBIUS_START_PRIMARY === "1";
  const entry = entries.find((item) => item.role === (primary ? "primary" : "secondary"))
    ?? entries[0];
  if (!entry) fail("没有可用的实例，无法应用公网入口");
  const port = primary ? jobEnv.QUBIUS_PRIMARY_PORT : jobEnv.QUBIUS_SECONDARY_PORT;
  const args = ["--port", String(port)];
  const tokenFile = path.join(entry.dataDir, "auth-token");
  if (jobEnv.QUBIUS_AUTH_TOKEN) args.push("--token", jobEnv.QUBIUS_AUTH_TOKEN);
  else if (fs.existsSync(tokenFile)) args.push("--token-file", tokenFile);
  if (jobEnv.QUBIUS_EDGE_DOMAIN) args.push("--domain", jobEnv.QUBIUS_EDGE_DOMAIN);
  if (jobEnv.QUBIUS_EDGE_WAIT) args.push("--wait", jobEnv.QUBIUS_EDGE_WAIT);
  if (envBool("QUBIUS_EDGE_YES", false)) args.push("--yes");
  say(`应用公网入口（127.0.0.1:${port}）`);
  await run(process.execPath, [path.join(scriptDir, "edge-deploy.mjs"), ...args], { cwd: repoRoot });
}

async function main() {
  switch (ACTION) {
    case "start":
      if (isLinux) return run("bash", [path.join(scriptDir, "start-all.sh")]);
      await startAll();
      return;
    case "stop":
      if (isLinux) return run("bash", [path.join(scriptDir, "start-all.sh"), "--stop"]);
      stopAll();
      return;
    case "restart":
      // 显式 restart 必须真正停/起，即使构建产物、HEAD、config/env 都没变化；
      // 否则无法用它恢复卡住进程或仅 shell env 变化后的状态。
      if (isLinux) {
        return run("bash", [path.join(scriptDir, "start-all.sh"), "--restart"], {
          env: { ...process.env, QUBIUS_DEPLOY_RESTART: "1" },
        });
      }
      stopAll();
      await startAll();
      return;
    case "status":
      await status();
      return;
    case "install":
      if (isLinux) return run("bash", [path.join(scriptDir, "install.sh")]);
      say("macOS/Windows 不需要 install：用 make quickstart 启动后在 /deploy 完成配置和部署。");
      return;
    case "pull": {
      const result = spawnSync("git", ["-C", repoRoot, "pull", "--ff-only"], { stdio: "inherit" });
      if (result.status !== 0) fail("git pull --ff-only 失败");
      return;
    }
    case "deploy":
    case "deploy-lan":
    case "deploy-wan": {
      const mode = ACTION === "deploy" ? "local" : ACTION === "deploy-lan" ? "lan" : "wan";
      if (isLinux) return run("bash", [path.join(scriptDir, "deploy.sh"), mode]);
      await deployWithNode(mode);
      return;
    }
    default:
      fail(
        "用法：node deploy/cli.mjs <start|stop|restart|status|install|pull|deploy|deploy-lan|deploy-wan>",
      );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // 透传子进程退出码：忙碌保护返回 3 时，make deploy* 也应以 3 结束。
  const code = error && typeof error.exitCode === "number" ? error.exitCode : 1;
  fail(message, code);
});
