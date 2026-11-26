import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUTH_TOKEN_FILE } from "./auth.js";
import type { AppConfig } from "./config.js";
import {
  detectLanHost,
  lanCredentialsFile,
  mergeEnvText,
  readLanCredentials,
  writeLanCredentials,
} from "./deploy.js";
import { resolveDeployEnvFile } from "./deploy-env.js";

/** 运行中的服务端令牌状态；重置后立即切换，旧令牌保留 60 秒宽限。 */
export interface AuthTokenState {
  current?: string;
  previous?: string;
  previousUntil?: number;
  source?: "config" | "env" | "file";
  file?: string;
}

export type LanRestartMethod = "systemd" | "process" | "none";

export interface ResetLanResult {
  user: string;
  password: string;
  urls: string[];
  /** none 表示当前没有运行中的局域网入口；scheduled 表示响应后会自动重启。 */
  restart: "scheduled" | "none";
  restartMethod: LanRestartMethod;
  restartNote: string;
}

export interface ResetAuthTokenResult {
  token: string;
  source: "config" | "env" | "file";
  file?: string;
  restartNeeded: false;
  note: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

function writeSecretAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    // Windows 等不支持 chmod。
  }
  fs.renameSync(tmp, file);
}

function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function run(command: string, args: string[], timeout = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true }, (error) => resolve(!error));
  });
}

function lanProxyUnit(config: AppConfig): string {
  return config.role === "secondary" ? "co-qubius-proxy.service" : "qubius-proxy.service";
}

/**
 * 只把 WorkingDirectory 和当前 checkout 一致的 unit 当作本实例的入口。
 * 同一台机器可能同时跑着别的 qubius 实例（或测试），不能误重启它们。
 */
function systemdUnitForRepo(unit: string, repoRoot: string): boolean {
  try {
    const cwd = execFileSync(
      "systemctl",
      ["--user", "show", unit, "--property=WorkingDirectory", "--value"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return Boolean(cwd) && path.resolve(cwd) === path.resolve(repoRoot);
  } catch {
    return false;
  }
}

function systemdUnitActiveForRepo(unit: string, repoRoot: string): boolean {
  if (!systemdUnitForRepo(unit, repoRoot)) return false;
  try {
    execFileSync("systemctl", ["--user", "is-active", "--quiet", unit], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 局域网入口是否在运行：本 checkout 的 systemd unit 或 pidfile。 */
export function lanProxyRunning(
  config: AppConfig,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { running: boolean; method: LanRestartMethod } {
  if (process.platform === "linux" && systemdUnitActiveForRepo(lanProxyUnit(config), repoRoot)) {
    return { running: true, method: "systemd" };
  }
  const pidfile = path.join(config.dataDir, "lan-proxy.pid");
  return { running: isAlive(readPid(pidfile)), method: "process" };
}

/** 等进程退出；异步等待，避免阻塞 HTTP 事件循环。 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

async function restartProcess(
  config: AppConfig,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  credentialsFile: string,
): Promise<boolean> {
  const pidfile = path.join(config.dataDir, "lan-proxy.pid");
  const pid = readPid(pidfile);
  if (isAlive(pid)) {
    try {
      process.kill(pid!, "SIGTERM");
    } catch {
      // 已退出。
    }
    if (!(await waitForExit(pid!, 3000))) {
      try {
        process.kill(pid!, "SIGKILL");
      } catch {
        // 已退出。
      }
      await waitForExit(pid!, 1000);
    }
  }
  const script = path.join(repoRoot, "deploy", "lan-proxy.mjs");
  if (!fs.existsSync(script)) return false;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(config.dataDir, "lan-proxy.log");
  const fd = fs.openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [script], {
      cwd: repoRoot,
      env: {
        ...env,
        QUBIUS_CONFIG_DIR: config.configDir,
        QUBIUS_REPO_DIR: repoRoot,
        QUBIUS_SECONDARY: config.role === "secondary" ? "1" : "0",
        LAN_PROXY_PORT: String(config.port),
        LAN_PROXY_UPSTREAM_PORT: String(config.port),
        LAN_PROXY_CREDENTIALS: credentialsFile,
        ...(nonEmpty(env.QUBIUS_LAN_HOST) ? { LAN_PROXY_HOST: nonEmpty(env.QUBIUS_LAN_HOST)! } : {}),
      },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    fs.writeFileSync(pidfile, `${child.pid ?? ""}\n`);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** 重启局域网入口；调用方应在响应发出后再调用，避免把响应连接一起重启掉。 */
export async function restartLanProxy(
  config: AppConfig,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  credentialsFile: string,
): Promise<LanRestartMethod> {
  if (process.platform === "linux" && systemdUnitActiveForRepo(lanProxyUnit(config), repoRoot)) {
    if (await run("systemctl", ["--user", "restart", lanProxyUnit(config)])) {
      return "systemd";
    }
  }
  return (await restartProcess(config, repoRoot, env, credentialsFile)) ? "process" : "none";
}

/** 生成新密码并写盘；返回的结果告诉前端是否需要在响应后重启、重启方式是什么。 */
export function resetLanPassword(options: {
  config: AppConfig;
  configDir: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  user?: string;
}): { result: ResetLanResult; credentialsFile: string; needsRestart: boolean } {
  const env = options.env ?? process.env;
  const credentialsFile = lanCredentialsFile(options.configDir, env);
  const current = readLanCredentials(credentialsFile);
  const requested = nonEmpty(options.user);
  const user = requested && /^[^\s:]{1,64}$/.test(requested)
    ? requested
    : current?.user ?? nonEmpty(env.QUBIUS_LAN_USER) ?? "qubius";
  const password = randomBytes(12).toString("base64url");
  writeLanCredentials(credentialsFile, user, password);

  const status = lanProxyRunning(options.config, options.repoRoot, env);
  const host = nonEmpty(env.QUBIUS_LAN_HOST) ?? detectLanHost();
  const urls = host ? [`http://${host}:${options.config.port}`] : [];
  const restart: ResetLanResult["restart"] = status.running ? "scheduled" : "none";
  return {
    credentialsFile,
    needsRestart: status.running,
    result: {
      user,
      password,
      urls,
      restart,
      restartMethod: status.running ? status.method : "none",
      restartNote: status.running
        ? "新密码已保存；局域网入口正在重启，约几秒后生效。通过局域网访问时当前页面可能短暂断开，需要重新输入登录凭据。"
        : "凭据已保存；局域网入口当前未运行，启动或部署后生效。",
    },
  };
}

/** 把新令牌写进 config.yaml；仅当前令牌来自配置文件时需要。 */
function patchConfigAuth(file: string, token: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const quoted = JSON.stringify(token);
  if (/^authToken\s*:/m.test(text)) {
    text = text.replace(/^authToken\s*:.*$/m, `authToken: ${quoted}`);
  } else {
    text = `${text.replace(/\s*$/, "")}\nauthToken: ${quoted}\n`;
  }
  if (/^auth\s*:\s*false\s*$/m.test(text)) {
    text = text.replace(/^auth\s*:\s*false\s*$/m, "auth: true");
  } else if (!/^auth\s*:/m.test(text)) {
    text = `${text.replace(/\s*$/, "")}\nauth: true\n`;
  }
  writeSecretAtomic(file, text, 0o600);
}

/**
 * 生成新令牌并立即写入运行状态：
 * - 运行中的服务端立刻切换到新令牌（旧令牌 60 秒内仍可用，避免在途请求 401）；
 * - 持久化到 env 文件，重启后继续生效；
 * - 当前来源是 auth-token 文件/config.yaml 时同步更新对应文件。
 */
export function resetAuthToken(options: {
  config: AppConfig;
  configDir: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  state: AuthTokenState;
}): ResetAuthTokenResult {
  const env = options.env ?? process.env;
  const token = randomBytes(32).toString("hex");
  const resolution = resolveDeployEnvFile(env, options.configDir, options.repoRoot);
  if (resolution.source === "QUBIUS_ENV" && !resolution.exists) {
    throw new Error(
      `QUBIUS_ENV 指向的 env 文件不存在：${resolution.file}；请先修正配置再重置令牌`,
    );
  }
  let existing = "";
  try {
    existing = fs.readFileSync(resolution.file, "utf8");
  } catch {
    existing = "";
  }
  // env 是部署后唯一可靠的持久化位置；deploy/lib.sh 会 source 它。
  writeSecretAtomic(
    resolution.file,
    mergeEnvText(existing, { QUBIUS_AUTH: "1", QUBIUS_AUTH_TOKEN: token }),
    0o600,
  );

  const source = options.state.source;
  let file: string | undefined;
  if (source === "file") {
    file = options.state.file ?? path.join(options.config.dataDir, AUTH_TOKEN_FILE);
    writeSecretAtomic(file, token, 0o600);
  } else if (source === "config") {
    // config.yaml 里的 authToken 优先级高于 env；必须同步改掉，否则重启后回退。
    patchConfigAuth(
      path.join(
        options.configDir,
        options.config.role === "secondary" ? "config-secondary.yaml" : "config.yaml",
      ),
      token,
    );
  }

  options.state.previous = options.state.current;
  options.state.previousUntil = Date.now() + 60_000;
  options.state.current = token;
  options.state.source = "env";
  if (file) options.state.file = file;

  return {
    token,
    source: "env",
    ...(file ? { file } : {}),
    restartNeeded: false,
    note: "服务端已立即启用新令牌，无需重启；当前浏览器已自动更新。旧令牌 60 秒后失效，其它设备需要用新令牌重新登录。",
  };
}
