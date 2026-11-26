// deploy/quickstart.mjs 的纯逻辑：npm 源选择、参数解析和配置目录推导。
// 不依赖第三方模块，克隆后未安装依赖也能运行。
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const REGISTRIES = [
  { id: "official", label: "npm 官方源", url: "https://registry.npmjs.org/" },
  { id: "npmmirror", label: "npmmirror（淘宝）", url: "https://registry.npmmirror.com/" },
  { id: "tencent", label: "腾讯云", url: "https://mirrors.cloud.tencent.com/npm/" },
  { id: "huawei", label: "华为云", url: "https://repo.huaweicloud.com/repository/npm/" },
];

export const DEFAULT_REGISTRY = REGISTRIES[0].url;

/**
 * 把用户输入解析成 registry URL。
 * 空输入用官方源；数字按列表选择；也接受直接粘贴的 http(s) 地址。
 * 其它输入返回 undefined，由调用方重新询问。
 */
export function registryFromInput(input) {
  const text = String(input ?? "").trim();
  if (!text) return DEFAULT_REGISTRY;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    return REGISTRIES[index]?.url;
  }
  return undefined;
}

export function parseArgs(argv) {
  const options = {};
  const unknown = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--registry") options.registry = argv[++index];
    else if (arg.startsWith("--registry=")) options.registry = arg.slice("--registry=".length);
    else if (arg === "--config-dir") options.configDir = argv[++index];
    else if (arg.startsWith("--config-dir=")) options.configDir = arg.slice("--config-dir=".length);
    else if (arg === "--port") options.port = argv[++index];
    else if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else unknown.push(arg);
  }
  if (unknown.length > 0) options.unknown = unknown;
  return options;
}

/** 1–65535 的整数端口；非法输入返回 undefined。 */
export function parsePort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** 检测 127.0.0.1 上的端口是否已有进程监听；超时按占用处理，避免误启动。 */
export function portInUse(port, host = "127.0.0.1", timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
  });
}

/** 从 start+1 开始找第一个空闲端口，作为冲突时的默认建议。 */
export async function nextFreePort(start, host = "127.0.0.1") {
  const first = Math.min(Math.max(start + 1, 1), 65535);
  for (let port = first; port <= 65535; port += 1) {
    if (!(await portInUse(port, host))) return port;
  }
  for (let port = first - 1; port >= 1; port -= 1) {
    if (!(await portInUse(port, host))) return port;
  }
  return undefined;
}

function uniquePids(values) {
  return [...new Set(values.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

/** 解析 `lsof -t` 的输出（每行一个 PID）。 */
export function parseLsofPids(output) {
  return uniquePids(
    output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isInteger(value)),
  );
}

/** 解析 `ss -ltnp` 输出里监听指定端口的 PID。 */
export function parseSsPids(output, port) {
  const pids = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[3] ?? "";
    if (!local.endsWith(`:${port}`)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      pids.push(Number(match[1]));
    }
  }
  return uniquePids(pids);
}

/** 解析 Windows `netstat -ano -p tcp` 输出里监听指定端口的 PID。 */
export function parseNetstatPids(output, port) {
  const pids = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[0]?.toUpperCase() !== "TCP") continue;
    if (parts[3]?.toUpperCase() !== "LISTENING") continue;
    const local = parts[1] ?? "";
    const separator = local.lastIndexOf(":");
    if (separator < 0 || Number(local.slice(separator + 1)) !== port) continue;
    pids.push(Number(parts[4]));
  }
  return uniquePids(pids);
}

/** 解析 `ps -p <pid> -o pid=,comm=,args=` 的一行输出。 */
export function parsePsInfo(output, pid) {
  const line = output.trim();
  if (!line) return undefined;
  const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
  if (!match) return { pid, name: "", command: "" };
  return { pid: Number(match[1]), name: match[2] ?? "", command: match[3] ?? "" };
}

/** 解析 Windows `tasklist /FO CSV /NH` 的一行（没有命令行信息）。 */
export function parseTasklistInfo(output, pid) {
  const fields = [...output.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  return { pid, name: fields[0] ?? "", command: "" };
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    // 保留 stderr，命令失败时可以把系统错误一并展示给用户。
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
    windowsHide: true,
  });
}

function errorDetail(error) {
  if (error && typeof error === "object" && "stderr" in error && error.stderr) {
    const text = String(error.stderr).trim();
    if (text) return text;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 找出监听指定端口的进程；找不到时返回空列表。 */
export function listenerPids(port, platform = process.platform) {
  if (platform === "win32") {
    try {
      return { pids: parseNetstatPids(runCommand("netstat", ["-ano", "-p", "tcp"]), port), source: "netstat" };
    } catch {
      return { pids: [], source: "netstat" };
    }
  }
  try {
    const pids = parseLsofPids(runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]));
    if (pids.length > 0) return { pids, source: "lsof" };
  } catch {
    // 没装 lsof 或没有权限；继续尝试 ss。
  }
  try {
    return { pids: parseSsPids(runCommand("ss", ["-ltnp"]), port), source: "ss" };
  } catch {
    return { pids: [], source: "ss" };
  }
}

/** PID 的名称和命令行，用于停止前确认。 */
export function processInfo(pid, platform = process.platform) {
  if (platform === "win32") {
    try {
      return parseTasklistInfo(runCommand("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]), pid);
    } catch {
      return undefined;
    }
  }
  try {
    return parsePsInfo(runCommand("ps", ["-p", String(pid), "-o", "pid=,comm=,args="]), pid);
  } catch {
    return undefined;
  }
}

/**
 * 停止进程。POSIX 发送 SIGTERM 让 qubius 收尾；Windows 的 taskkill 对
 * Node 控制台进程只有 /F 可靠，因此直接强制结束，失败由调用方提示手动处理。
 */
export function stopProcess(pid, platform = process.platform) {
  if (platform === "win32") {
    try {
      runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch (error) {
      throw new Error(`taskkill 失败：${errorDetail(error)}`);
    }
    return;
  }
  process.kill(pid, "SIGTERM");
}

/** 等端口释放，用于停止进程后确认可以继续启动。 */
export async function waitPortFree(port, timeoutMs = 5000, host = "127.0.0.1") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port, host))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !(await portInUse(port, host));
}

function homeOf(env) {
  return (env.HOME ?? "").trim() || (env.USERPROFILE ?? "").trim() || os.homedir();
}

export function expandHome(value, env = process.env, platform = process.platform) {
  const text = String(value ?? "").trim();
  const home = homeOf(env);
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return (platform === "win32" ? path.win32 : path.posix).join(home, text.slice(2));
  }
  return text
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => env[name] ?? match);
}

export function isAbsolutePath(value, platform = process.platform) {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

/** 与 server/src/deploy.ts 的语义一致：POSIX 用 XDG_CONFIG_HOME，Windows 用 %APPDATA%。 */
export function defaultConfigDir(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const appData = (env.APPDATA ?? "").trim();
    if (appData) return path.win32.join(appData, "qubius");
    return path.win32.join(homeOf(env), "AppData", "Roaming", "qubius");
  }
  const base = (env.XDG_CONFIG_HOME ?? "").trim() || path.posix.join(homeOf(env), ".config");
  return path.posix.join(base, "qubius");
}

/** 配置目录必须是绝对路径；返回规范化后的路径或抛错。 */
export function normalizeConfigDir(value, env = process.env, platform = process.platform) {
  const expanded = expandHome(value, env, platform);
  if (!expanded) return "";
  if (!isAbsolutePath(expanded, platform)) {
    throw new Error(`配置目录必须是绝对路径：${expanded}`);
  }
  return expanded;
}
