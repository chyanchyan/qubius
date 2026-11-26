import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveAuthToken } from "./auth.js";
import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_LIMITS,
  type AppConfig,
  type LimitsConfig,
  type Role,
} from "./config.js";
import { resolveDeployEnvFile, type DeployEnvSource } from "./deploy-env.js";
import { jobTimestamp } from "./job-state.js";
import { tryLanAddress } from "./lan-address.js";
import {
  claim as claimOpsLock,
  clear as clearOpsLock,
  opsJobEnv,
  status as opsLockStatus,
} from "./edge/opslock.js";
import { PERMISSIONS, isPermission } from "./permissions.js";

export type DeployPermission = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export interface DeployProject {
  id: string;
  name: string;
  path: string;
  permission: DeployPermission;
  /** 非 git 项目每个对话使用独立目录；默认 false。 */
  isolated: boolean;
  /**
   * 回写时保留的未建模字段（例如用户自定义的标量）。
   * 嵌套对象/数组会被序列化成单行字符串，再读取时不可逆；
   * 最多 32 个键、序列化后不超过 8KB。
   */
  extras?: Record<string, unknown>;
  /** 内部标记：请求里是否显式给了 isolated；用于合并已有配置。 */
  isolatedProvided?: boolean;
}

export interface DeployForm {
  startPrimary: boolean;
  startSecondary: boolean;
  clonePeer: boolean;
  /** 构建前从各 checkout 的 origin 快进拉取当前分支；默认 false。 */
  pullLatest: boolean;
  primaryPort: number;
  secondaryPort: number;
  publicHost: string;
  publicHostSecondary: string;
  /** 额外允许的 Host（逗号或空白分隔）；写入 env 的 QUBIUS_ALLOWED_HOSTS，启动时追加到 allowedHosts。 */
  allowedHostsExtra: string;
  lanHost: string;
  configDir: string;
  primaryDir: string;
  secondaryDir: string;
  dataPrimary: string;
  dataSecondary: string;
  primaryRepoUrl: string;
  secondaryRepoUrl: string;
  primaryRef: string;
  /** 访问令牌：off 关闭、auto 自动生成、custom 使用下面的令牌。 */
  authMode: "off" | "auto" | "custom";
  /** custom 模式的令牌。GET 不返回已保存的值（只用 authTokenSet 表示已设置）。 */
  authToken: string;
  /** 服务端是否已保存令牌；GET 用，提交时忽略。 */
  authTokenSet?: boolean;
  /** 浏览器命令行页开关。 */
  terminal: boolean;
  /** 同时进行的对话上限（初始默认值，页面设置优先）。 */
  maxConcurrent: number;
  /** 等待确认超时（分钟，0 表示不自动拒绝）。 */
  approvalTimeoutMinutes: number;
  /** 会话/请求上限；默认值见 DEFAULT_LIMITS。 */
  limits: LimitsConfig;
  /** 是否启用局域网 Basic 认证入口（write QUBIUS_START_LAN）。 */
  lanEnabled: boolean;
  /** 局域网 Basic 用户名；默认 qubius。 */
  lanAuthUser: string;
  /** 新密码；留空表示沿用已保存的密码，首次启用时自动生成。GET 不返回已保存的值。 */
  lanAuthPassword: string;
  /** 服务端是否已有局域网密码（GET 用，提交时忽略）。 */
  lanAuthPasswordSet?: boolean;
  archiveDir: string;
  archiveRetentionDays: number;
  nodeBin: string;
  projects: DeployProject[];
  /** 数据目录与当前配置文件不同且旧目录有会话时的二次确认。 */
  confirmDataDirChange?: boolean;
}

export interface DeployInstanceInfo {
  role: "primary" | "secondary";
  repoDir: string;
  dataDir: string;
  port: number;
  running: boolean;
  head?: string;
  /** 实例报告的构建版本号；旧版服务端没有这个字段。 */
  version?: string;
}

export interface DeployJobStatus {
  jobId: string;
  state: "running" | "success" | "failed";
  step: string;
  message: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  logTail?: string;
}

/**
 * 应用部署被 ops lock 阻塞时的类型化结果。
 * busy：锁被活跃任务（edge/deploy）持有；residual：锁空闲但有残留进程。
 */
export interface DeployBusy {
  code: "busy" | "residual";
  kind?: string;
  remainingPids?: number[];
}

/** 局域网入口一次性信息：只在本次部署响应里返回，后续 GET 不再包含密码。 */
export interface DeployLanInfo {
  user: string;
  password: string;
  /** 形如 http://192.168.1.10:8787，按启用的实例生成。 */
  urls: string[];
}

export interface DeployOneTimeInfo {
  lan?: DeployLanInfo;
  /** 本次部署后生效的 API 访问令牌；未启用 auth 时省略。 */
  authToken?: string;
}

export type ApplyDeployResult = { jobId: string; oneTime?: DeployOneTimeInfo } | DeployBusy;

/** 当前进程实际生效的配置摘要；部署页只读展示，避免再去翻文件和日志。 */
export interface DeployCurrentConfig {
  dataDir: string;
  allowedHosts: string[];
  authEnabled: boolean;
  authTokenSource?: "config" | "env" | "file";
  authTokenFile?: string;
  terminal: boolean;
  /** 局域网入口当前状态；不含密码。 */
  lan?: { enabled: boolean; user: string; passwordSet: boolean; file: string };
  archive?: { dir: string; retentionDays: number; instance: string };
  role: Role;
}

export interface DeployState {
  setupRequired: boolean;
  repoDir: string;
  /** 首次部署时当前 checkout 的 origin（仅 http(s)），供部署向导预填仓库地址。 */
  detectedRepoUrl?: string;
  configDir: string;
  configFile: string;
  envFile: string;
  /** envFile 的解析来源，与 deploy/lib.sh 的优先级一致。 */
  envSource: DeployEnvSource;
  role: "primary" | "secondary";
  /** 当前进程的配置摘要；测试或不传 config 时省略。 */
  current?: DeployCurrentConfig;
  /** 当前 server 进程监听端口；前端据此判断部署后本页面实例是否还在。 */
  port: number;
  /** 运行服务的平台；前端据此提示 Windows 与 Linux 的部署差异。 */
  platform: NodeJS.Platform;
  nodeVersion: string;
  form: DeployForm;
  instances: DeployInstanceInfo[];
  job: DeployJobStatus | null;
  /** QUBIUS_PROJECTS_FILE 存在但读取/解析失败时提示；前端只读展示即可。 */
  projectsError?: string;
}

export const DEFAULT_PRIMARY_REPO_URL = "http://gitea.example.com/example/qubius.git";
/** 两个实例共用同一个仓库；副实例只是另一份 checkout。 */
export const DEFAULT_SECONDARY_REPO_URL = DEFAULT_PRIMARY_REPO_URL;

/** 本页管理的 QUBIUS_* 键；合并 env 时只替换这些键，其余内容原样保留。 */
const MANAGED_KEYS = [
  "QUBIUS_START_PRIMARY",
  "QUBIUS_START_SECONDARY",
  "QUBIUS_CLONE_PEER",
  "QUBIUS_PULL_LATEST",
  "QUBIUS_PRIMARY_PORT",
  "QUBIUS_SECONDARY_PORT",
  "QUBIUS_PUBLIC_HOST",
  "QUBIUS_PUBLIC_HOST_SECONDARY",
  "QUBIUS_ALLOWED_HOSTS",
  "QUBIUS_AUTH",
  "QUBIUS_AUTH_TOKEN",
  "QUBIUS_TERMINAL",
  "QUBIUS_MAX_CONCURRENT",
  "QUBIUS_APPROVAL_TIMEOUT_MINUTES",
  "QUBIUS_LIMIT_TRANSCRIPT_BYTES",
  "QUBIUS_LIMIT_TRANSCRIPT_MESSAGES",
  "QUBIUS_LIMIT_MESSAGE_TEXT",
  "QUBIUS_LIMIT_REQUEST_BODY",
  "QUBIUS_HISTORY_PAGE",
  "QUBIUS_START_LAN",
  "QUBIUS_LAN_HOST",
  "QUBIUS_LAN_USER",
  "QUBIUS_CONFIG_DIR",
  "QUBIUS_PRIMARY_DIR",
  "QUBIUS_SECONDARY_DIR",
  "QUBIUS_DATA_PRIMARY",
  "QUBIUS_DATA_SECONDARY",
  "QUBIUS_PRIMARY_REPO_URL",
  "QUBIUS_SECONDARY_REPO_URL",
  "QUBIUS_PRIMARY_REF",
  "QUBIUS_ARCHIVE_DIR",
  "QUBIUS_ARCHIVE_RETENTION_DAYS",
  "QUBIUS_NODE_BIN",
  "QUBIUS_PROJECTS_FILE",
] as const;

const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** 与 deploy/lib.sh 的 QUBIUS_PUBLIC_HOST 默认值一致。留空时用这个。 */
export const DEFAULT_PUBLIC_HOST = "code.example.com";
/** 与 deploy/lib.sh 的 QUBIUS_PUBLIC_HOST_SECONDARY 默认值一致。 */
export const DEFAULT_PUBLIC_HOST_SECONDARY = "code-bak.example.com";
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const URL_RE = /^https?:\/\//;
/** 换行和控制字符会破坏 env/projects 文件结构，一律拒绝。 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 部署表单语义校验失败；HTTP 层映射为 400。 */
export class DeployValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployValidationError";
  }
}

/**
 * 目标数据目录与当前 config.yaml 不同，且旧目录里还有会话。
 * 这是「重新部署后会话全没了」的根因，必须让用户在页面上显式确认。
 */
export class DeployDataDirChangeError extends DeployValidationError {
  readonly currentDataDir: string;
  readonly targetDataDir: string;
  readonly sessions: number;

  constructor(currentDataDir: string, targetDataDir: string, sessions: number) {
    super(
      `数据目录将从 ${currentDataDir} 切换到 ${targetDataDir}，旧目录里还有 ${sessions} 个会话。`
        + "直接部署会让这些会话在新实例里看不到；确认要切换请再次提交。",
    );
    this.name = "DeployDataDirChangeError";
    this.currentDataDir = currentDataDir;
    this.targetDataDir = targetDataDir;
    this.sessions = sessions;
  }
}

function fail(message: string): never {
  throw new DeployValidationError(message);
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/**
 * 是否走 Node 版部署任务 `deploy/deploy-job.mjs`：
 * Windows 和 macOS 没有 systemd，macOS 还没有 flock/ss/setsid/sha256sum，
 * 用纯 Node 任务完成配置渲染、构建和进程重启；Linux 继续用 deploy-job.sh。
 */
function usesNodeDeployJob(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * 默认配置、env、数据、日志都收敛到 checkout 内的 .qubius/（已 gitignore）。
 * 与 deploy/lib.sh 的 qubius_default_config_dir 保持一致：不再使用
 * ~/.config、~/.local/share 或 %APPDATA%，避免 quickstart、部署页和服务端
 * 各自算出不同的目录。
 *
 * repoRoot 优先从参数取；其次是部署脚本导出的 QUBIUS_REPO_DIR；最后用
 * 进程工作目录（run.sh / deploy-job 都会在 checkout 根启动服务）。
 */
export function defaultRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.QUBIUS_REPO_DIR) ?? process.cwd();
}

export function defaultConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  _platform: NodeJS.Platform = process.platform,
  repoRoot?: string,
): string {
  return path.join(path.resolve(repoRoot ?? defaultRepoRoot(env)), ".qubius");
}

/** 部署配置目录：QUBIUS_CONFIG_DIR，或 <checkout>/.qubius。 */
export function deployConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  repoRoot?: string,
): string {
  const configured = (env.QUBIUS_CONFIG_DIR ?? "").trim();
  return path.resolve(configured || defaultConfigDir(env, platform, repoRoot));
}

/**
 * 读取 checkout 的 origin，供首次部署向导预填仓库地址。
 * 只接受 http(s)（部署表单和克隆脚本都要求这个形式）；没有 git、没有 origin
 * 或是 SSH 地址时返回 undefined，让页面保留原来的默认值。
 */
export function detectRepoUrl(repoDir: string): string | undefined {
  try {
    const remote = execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!URL_RE.test(remote)) return undefined;
    // origin 里可能带 user:token；这个值会显示在浏览器里，不能原样透出。
    const parsed = new URL(remote);
    if (parsed.username || parsed.password) return undefined;
    return remote;
  } catch {
    return undefined;
  }
}

export interface DerivedDeploy {
  configDir: string;
  envFile: string;
  /** envFile 的解析来源，与 deploy/lib.sh 的优先级一致。 */
  envSource: DeployEnvSource;
  /** env 文件里解析出来的值（不含进程环境）。 */
  stored: Record<string, string>;
  form: DeployForm;
  /** 配置了 QUBIUS_PROJECTS_FILE 但读取/解析失败时的中文错误。 */
  projectsError?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  const home = homeOf(env);
  let text = value;
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(home, text.slice(2));
  return text
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
    // Windows 风格的 %USERPROFILE% / %APPDATA% 等。
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => env[name] ?? match);
}

/**
 * 解析 shell 风格的 env 文件。只用于读取部署配置，不执行任何内容：
 * 忽略注释/空行，支持 `export KEY=...`、单双引号、$HOME 展开和简单行尾注释。
 */
export function parseEnvFile(text: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    // 引号值允许后面跟行尾注释（shell 里合法且常见）。
    const unwrap = (quote: string): boolean => {
      if (!value.startsWith(quote)) return false;
      const close = value.lastIndexOf(quote);
      if (close <= 0) return false;
      const rest = value.slice(close + 1).trim();
      if (rest && !rest.startsWith("#")) return false;
      value = value.slice(1, close);
      return true;
    };
    if (unwrap("'")) {
      // shell 单引号里唯一需要还原的是 '\'' 拼接写法。
      value = value.replace(/'\\''/g, "'");
    } else if (unwrap('"')) {
      value = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    values[key] = expandHome(value, env);
  }
  return values;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  switch (value.trim().toLowerCase()) {
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

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : fallback;
}

function resolveDir(configDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(configDir, value);
}

interface ProjectsFileResult {
  projects: DeployProject[];
  error?: string;
}

const PROJECT_MODELED_KEYS = new Set(["id", "name", "path", "permission", "isolated"]);
const EXTRAS_MAX_KEYS = 32;
const EXTRAS_MAX_BYTES = 8 * 1024;

/** 收集同一条目里未建模的字段，部署写回时原样保留。 */
function readExtras(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (PROJECT_MODELED_KEYS.has(key)) continue;
    extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function extrasExceed(extras: Record<string, unknown>): boolean {
  if (Object.keys(extras).length > EXTRAS_MAX_KEYS) return true;
  try {
    return Buffer.byteLength(JSON.stringify(extras)) > EXTRAS_MAX_BYTES;
  } catch {
    return true;
  }
}

function readProjectsFile(file: string, configDir: string): ProjectsFileResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { projects: [], error: `无法读取 ${file}：${message}` };
  }
  // 空文件/纯注释/纯空白都视为没有额外项目（旧版会写出 0 字节文件）。
  if (!text.trim() || text.split(/\r?\n/).every((line) => !line.trim() || line.trimStart().startsWith("#"))) {
    return { projects: [] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { projects: [], error: `projects 文件不是合法 YAML：${message}` };
  }
  // 只有注释时 yaml.parse 也返回 null。
  if (parsed === null || parsed === undefined) return { projects: [] };
  if (!Array.isArray(parsed)) {
    return { projects: [], error: "projects 文件必须是 YAML 列表" };
  }
  const projects: DeployProject[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { projects: [], error: `projects 文件第 ${index + 1} 项必须是对象` };
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const projectPath = typeof record.path === "string" ? record.path.trim() : "";
    if (!id || !name || !projectPath) {
      return { projects: [], error: `projects 文件第 ${index + 1} 项缺少 id、name 或 path` };
    }
    const permission = record.permission === undefined ? "acceptEdits" : record.permission;
    if (!isPermission(permission)) {
      return { projects: [], error: `projects 文件第 ${index + 1} 项 permission 非法` };
    }
    const isolated = record.isolated === undefined ? false : record.isolated;
    if (typeof isolated !== "boolean") {
      return { projects: [], error: `projects 文件第 ${index + 1} 项 isolated 必须是布尔值` };
    }
    const extras = readExtras(record);
    const project: DeployProject = {
      id,
      name,
      path: resolveDir(configDir, projectPath),
      permission,
      isolated,
    };
    if (extras && !extrasExceed(extras)) {
      // 未建模字段只在服务端内部保留，不随 GET 的 JSON 外泄；写回时再合并。
      Object.defineProperty(project, "extras", {
        value: extras,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    projects.push(project);
  }
  return { projects };
}

/**
 * 从部署 env 推导页面表单。env 文件里的值优先，其次进程环境，最后用默认值。
 * 推导过程不做校验，保证配置损坏时页面仍能打开并显示可编辑内容。
 */
export function deriveDeployForm(
  env: NodeJS.ProcessEnv = process.env,
  role: Role = "primary",
  repoRoot?: string,
  platform: NodeJS.Platform = process.platform,
): DerivedDeploy {
  const home = homeOf(env);
  const configDir = deployConfigDir(env, platform, repoRoot);
  // 与 shell 侧 deploy/lib.sh 单一来源：QUBIUS_ENV > configDir/env > repo/deploy/env。
  const { file: envFile, source: envSource } = resolveDeployEnvFile(env, configDir, repoRoot);
  let stored: Record<string, string> = {};
  try {
    stored = parseEnvFile(fs.readFileSync(envFile, "utf8"), env);
  } catch {
    stored = {};
  }
  const pick = (name: string, fallback: string): string =>
    nonEmpty(stored[name]) ?? nonEmpty(env[name]) ?? fallback;

  const archiveDirRaw = pick("QUBIUS_ARCHIVE_DIR", "");
  const projectsFileRaw = nonEmpty(stored.QUBIUS_PROJECTS_FILE) ?? nonEmpty(env.QUBIUS_PROJECTS_FILE);
  // 冷启动默认值跟随当前实例角色：副实例默认只启动自己。
  const startPrimaryDefault = role === "secondary" ? "0" : "1";
  const startSecondaryDefault = role === "secondary" ? "1" : "0";
  // 两个实例共用一个仓库：副仓库地址未显式设置时跟随主仓库（包括 env 里的自定义地址）。
  const primaryRepoUrl = pick("QUBIUS_PRIMARY_REPO_URL", DEFAULT_PRIMARY_REPO_URL);
  // 主实例默认就是当前 checkout；数据目录放在它自己的 .qubius/data。
  const repoBase = path.resolve(repoRoot ?? defaultRepoRoot(env));
  const primaryDirDefault = repoBase;
  const secondaryDirDefault = path.join(home, "co-qubius");
  const primaryDir = resolveDir(configDir, pick("QUBIUS_PRIMARY_DIR", primaryDirDefault));
  const secondaryDir = resolveDir(configDir, pick("QUBIUS_SECONDARY_DIR", secondaryDirDefault));
  // 真实 Windows 环境里默认 localhost，本机使用不用再想一个域名；
  // 用隔离 HOME 的测试不设置 APPDATA/USERPROFILE，仍然得到空串。
  const windowsLocalHost = platform === "win32" && (nonEmpty(env.APPDATA) || nonEmpty(env.USERPROFILE))
    ? "localhost"
    : "";
  // 令牌只回传「是否已设置」，不回传明文。QUBIUS_AUTH=0 表示显式关闭；
  // 已有令牌且没有显式关闭时按自定义模式展示。
  const authTokenStored = nonEmpty(stored.QUBIUS_AUTH_TOKEN) ?? "";
  const authFlag = pick("QUBIUS_AUTH", "").trim().toLowerCase();
  const authExplicitOff = ["0", "false", "no", "off"].includes(authFlag);
  const authExplicitOn = ["1", "true", "yes", "on"].includes(authFlag);
  const authMode: DeployForm["authMode"] = authExplicitOff
    ? "off"
    : authTokenStored
      ? "custom"
      : authExplicitOn
        ? "auto"
        : "off";
  // 局域网入口：有凭据文件或 env 显式打开时默认启用；密码只回传“已设置”。
  const lanFile = lanCredentialsFile(configDir, env);
  const lanStored = readLanCredentials(lanFile);
  // 只看 env 文件，不看进程环境：deploy/lib.sh 会把 QUBIUS_START_LAN 默认成 1，
  // 如果混进来，部署页会把“默认值”误当成用户主动启用。
  const lanFlag = nonEmpty(stored.QUBIUS_START_LAN);
  const lanEnabled = lanFlag === undefined ? fs.existsSync(lanFile) : parseBool(lanFlag, false);
  const form: DeployForm = {
    startPrimary: parseBool(pick("QUBIUS_START_PRIMARY", startPrimaryDefault), role !== "secondary"),
    startSecondary: parseBool(pick("QUBIUS_START_SECONDARY", startSecondaryDefault), role === "secondary"),
    clonePeer: parseBool(pick("QUBIUS_CLONE_PEER", "0"), false),
    pullLatest: parseBool(pick("QUBIUS_PULL_LATEST", "0"), false),
    primaryPort: parseIntOr(pick("QUBIUS_PRIMARY_PORT", "8787"), 8787),
    secondaryPort: parseIntOr(pick("QUBIUS_SECONDARY_PORT", "8788"), 8788),
    publicHost: pick("QUBIUS_PUBLIC_HOST", windowsLocalHost),
    publicHostSecondary: pick("QUBIUS_PUBLIC_HOST_SECONDARY", ""),
    allowedHostsExtra: pick("QUBIUS_ALLOWED_HOSTS", ""),
    lanHost: pick("QUBIUS_LAN_HOST", ""),
    configDir,
    primaryDir,
    secondaryDir,
    dataPrimary: resolveDir(configDir, pick("QUBIUS_DATA_PRIMARY", path.join(primaryDir, ".qubius", "data"))),
    dataSecondary: resolveDir(configDir, pick("QUBIUS_DATA_SECONDARY", path.join(secondaryDir, ".qubius", "data"))),
    primaryRepoUrl,
    secondaryRepoUrl: pick("QUBIUS_SECONDARY_REPO_URL", primaryRepoUrl),
    primaryRef: pick("QUBIUS_PRIMARY_REF", "main"),
    authMode,
    authToken: "",
    authTokenSet: Boolean(authTokenStored),
    terminal: parseBool(pick("QUBIUS_TERMINAL", "1"), true),
    maxConcurrent: parseIntOr(pick("QUBIUS_MAX_CONCURRENT", "4"), 4),
    approvalTimeoutMinutes: parseIntOr(pick("QUBIUS_APPROVAL_TIMEOUT_MINUTES", "10"), 10),
    limits: {
      transcriptBytes: parseIntOr(
        pick("QUBIUS_LIMIT_TRANSCRIPT_BYTES", String(DEFAULT_LIMITS.transcriptBytes)),
        DEFAULT_LIMITS.transcriptBytes,
      ),
      transcriptMessages: parseIntOr(
        pick("QUBIUS_LIMIT_TRANSCRIPT_MESSAGES", String(DEFAULT_LIMITS.transcriptMessages)),
        DEFAULT_LIMITS.transcriptMessages,
      ),
      messageText: parseIntOr(
        pick("QUBIUS_LIMIT_MESSAGE_TEXT", String(DEFAULT_LIMITS.messageText)),
        DEFAULT_LIMITS.messageText,
      ),
      requestBodyBytes: parseIntOr(
        pick("QUBIUS_LIMIT_REQUEST_BODY", String(DEFAULT_LIMITS.requestBodyBytes)),
        DEFAULT_LIMITS.requestBodyBytes,
      ),
      historyPage: parseIntOr(
        pick("QUBIUS_HISTORY_PAGE", String(DEFAULT_LIMITS.historyPage)),
        DEFAULT_LIMITS.historyPage,
      ),
    },
    lanEnabled,
    lanAuthUser: lanStored?.user ?? (nonEmpty(env.QUBIUS_LAN_USER) ?? "qubius"),
    lanAuthPassword: "",
    lanAuthPasswordSet: Boolean(lanStored?.password),
    archiveDir: archiveDirRaw ? resolveDir(configDir, archiveDirRaw) : "",
    archiveRetentionDays: parseIntOr(pick("QUBIUS_ARCHIVE_RETENTION_DAYS", "30"), 30),
    nodeBin: pick("QUBIUS_NODE_BIN", ""),
    projects: [],
  };
  let projectsError: string | undefined;
  if (projectsFileRaw) {
    const result = readProjectsFile(resolveDir(configDir, projectsFileRaw), configDir);
    form.projects = result.projects;
    projectsError = result.error;
  }
  return { configDir, envFile, envSource, stored, form, ...(projectsError ? { projectsError } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("请求不是部署配置对象");
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") fail(`${label} 必须是字符串`);
  if (CONTROL_RE.test(value)) fail(`${label} 不能包含换行或控制字符`);
  return value.trim();
}

function requireBool(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail(`${label} 必须是布尔值`);
  return value;
}

function requireInt(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) fail(`${label} 必须是整数`);
  return value;
}

function validateProjects(value: unknown): DeployProject[] {
  if (!Array.isArray(value)) fail("projects 必须是数组");
  const seen = new Set<string>();
  const projects: DeployProject[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`projects[${index}] 必须是对象`);
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!PROJECT_ID_RE.test(id)) {
      fail(`projects[${index}].id 只能用小写字母、数字和连字符`);
    }
    if (id === "qubius" || id === "co-qubius") {
      fail(`项目 id 不能是 ${id}：会和自动加入的对端项目冲突`);
    }
    if (seen.has(id)) fail(`项目 id 重复：${id}`);
    seen.add(id);
    const rawName = typeof record.name === "string" ? record.name : "";
    const rawPath = typeof record.path === "string" ? record.path : "";
    if (CONTROL_RE.test(rawName)) fail(`projects[${index}].name 不能包含换行或控制字符`);
    if (CONTROL_RE.test(rawPath)) fail(`projects[${index}].path 不能包含换行或控制字符`);
    const name = rawName.trim();
    if (!name) fail(`projects[${index}].name 不能为空`);
    const projectPath = rawPath.trim();
    if (!projectPath) fail(`projects[${index}].path 不能为空`);
    if (!path.isAbsolute(projectPath)) fail(`projects[${index}].path 必须是绝对路径`);
    const permission = record.permission;
    if (!isPermission(permission)) {
      fail(`projects[${index}].permission 必须是 ${PERMISSIONS.join("、")}`);
    }
    const isolatedProvided = record.isolated !== undefined;
    const isolated = isolatedProvided ? record.isolated : false;
    if (typeof isolated !== "boolean") fail(`projects[${index}].isolated 必须是布尔值`);
    const extras = readExtras(record);
    if (extras && extrasExceed(extras)) {
      fail(`projects[${index}] 的未建模字段过多或过大（最多 ${EXTRAS_MAX_KEYS} 个键、${EXTRAS_MAX_BYTES} 字节）`);
    }
    projects.push({
      id,
      name,
      path: path.resolve(projectPath),
      permission,
      isolated,
      isolatedProvided,
      ...(extras ? { extras } : {}),
    });
  }
  return projects;
}

/** 会话/请求上限；缺省字段沿用 DEFAULT_LIMITS，范围与 server/src/config.ts 的 LIMIT_RULES 一致。 */
function validateLimits(value: unknown): LimitsConfig {
  if (value === undefined) return { ...DEFAULT_LIMITS };
  const record = asRecord(value);
  const read = (key: keyof LimitsConfig, label: string, min: number, max: number): number => {
    const raw = record[key];
    if (raw === undefined) return DEFAULT_LIMITS[key];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
      fail(`${label}必须是 ${min} 到 ${max} 的整数`);
    }
    return raw;
  };
  return {
    transcriptBytes: read("transcriptBytes", "单会话总字节上限", 64 * 1024, 64 * 1024 * 1024),
    transcriptMessages: read("transcriptMessages", "单会话消息条数上限", 50, 20_000),
    messageText: read("messageText", "单条消息正文字符上限", 1_024, 1_024 * 1_024),
    requestBodyBytes: read("requestBodyBytes", "请求体字节上限", 1_024 * 1_024, 64 * 1_024 * 1_024),
    historyPage: read("historyPage", "历史分页条数", 50, 2_000),
  };
}

function requireAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value)) fail(`${label} 必须是绝对路径`);
}

/**
 * 解析并校验 POST /api/deploy/apply 的表单。所有错误都是中文，供前端直接展示。
 * 只在服务端做判断；目录存在性检查用 fs，不触碰任何进程。
 */
export function validateDeployForm(
  input: unknown,
  platform: NodeJS.Platform = process.platform,
): DeployForm {
  const record = asRecord(input);
  const authMode = record.authMode === undefined ? "off" : record.authMode;
  if (authMode !== "off" && authMode !== "auto" && authMode !== "custom") {
    fail("访问令牌模式必须是 off、auto 或 custom");
  }
  const authToken = record.authToken === undefined ? "" : requireString(record, "authToken", "访问令牌");
  if (authToken && (authToken.length < 16 || authToken.length > 512)) {
    fail("访问令牌必须是 16 到 512 个字符");
  }
  const allowedHostsExtra = record.allowedHostsExtra === undefined
    ? ""
    : requireString(record, "allowedHostsExtra", "额外允许的域名");
  for (const raw of allowedHostsExtra.split(/[,\s]+/)) {
    const host = raw.trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) continue;
    if (!HOST_RE.test(host) && isIP(host) === 0) {
      fail(`额外允许的域名里 ${raw} 不是合法域名或 IP`);
    }
  }
  const lanEnabled = record.lanEnabled === undefined
    ? false
    : requireBool(record, "lanEnabled", "局域网入口开关");
  const lanAuthUser = record.lanAuthUser === undefined
    ? "qubius"
    : requireString(record, "lanAuthUser", "局域网用户名");
  if (!/^[^\s:]{1,64}$/.test(lanAuthUser)) {
    fail("局域网用户名必须是 1 到 64 个字符，且不能包含冒号或空白");
  }
  const lanAuthPassword = record.lanAuthPassword === undefined
    ? ""
    : requireString(record, "lanAuthPassword", "局域网密码");
  if (lanAuthPassword && (lanAuthPassword.length < 8 || lanAuthPassword.length > 128)) {
    fail("局域网密码必须是 8 到 128 个字符");
  }
  const form: DeployForm = {
    startPrimary: requireBool(record, "startPrimary", "startPrimary"),
    startSecondary: requireBool(record, "startSecondary", "startSecondary"),
    clonePeer: requireBool(record, "clonePeer", "clonePeer"),
    // 旧版页面不会提交这个字段：缺省按 false 处理，保持兼容。
    pullLatest: record.pullLatest === undefined ? false : requireBool(record, "pullLatest", "pullLatest"),
    primaryPort: requireInt(record, "primaryPort", "主实例端口"),
    secondaryPort: requireInt(record, "secondaryPort", "副实例端口"),
    publicHost: requireString(record, "publicHost", "主实例公网域名"),
    publicHostSecondary: requireString(record, "publicHostSecondary", "副实例公网域名"),
    allowedHostsExtra,
    lanHost: requireString(record, "lanHost", "内网入口地址"),
    configDir: requireString(record, "configDir", "配置目录"),
    primaryDir: requireString(record, "primaryDir", "主实例目录"),
    secondaryDir: requireString(record, "secondaryDir", "副实例目录"),
    dataPrimary: requireString(record, "dataPrimary", "主实例数据目录"),
    dataSecondary: requireString(record, "dataSecondary", "副实例数据目录"),
    primaryRepoUrl: requireString(record, "primaryRepoUrl", "主实例仓库地址"),
    secondaryRepoUrl: requireString(record, "secondaryRepoUrl", "副实例仓库地址"),
    primaryRef: requireString(record, "primaryRef", "主实例分支"),
    // 新字段都有默认值，旧版页面/测试不提交也能继续工作。
    authMode,
    authToken,
    authTokenSet: record.authTokenSet === true,
    terminal: record.terminal === undefined ? true : requireBool(record, "terminal", "命令行页开关"),
    maxConcurrent: record.maxConcurrent === undefined ? 4 : requireInt(record, "maxConcurrent", "并发上限"),
    approvalTimeoutMinutes: record.approvalTimeoutMinutes === undefined
      ? 10
      : requireInt(record, "approvalTimeoutMinutes", "确认超时"),
    limits: validateLimits(record.limits),
    lanEnabled,
    lanAuthUser,
    lanAuthPassword,
    lanAuthPasswordSet: record.lanAuthPasswordSet === true,
    archiveDir: requireString(record, "archiveDir", "归档目录"),
    archiveRetentionDays: requireInt(record, "archiveRetentionDays", "列表保留天数"),
    nodeBin: requireString(record, "nodeBin", "Node 路径"),
    projects: validateProjects(record.projects),
    confirmDataDirChange: record.confirmDataDirChange === true,
  };
  // clonePeer 只对副实例有意义；没启用副实例时归一化为 false，避免 env 里残留 1。
  form.clonePeer = form.startSecondary && form.clonePeer;

  for (const [label, port] of [["主实例端口", form.primaryPort], ["副实例端口", form.secondaryPort]] as const) {
    if (port < 1 || port > 65535) fail(`${label}必须在 1 到 65535 之间`);
  }
  if (form.startPrimary && form.startSecondary && form.primaryPort === form.secondaryPort) {
    fail("主实例和副实例不能使用同一个端口");
  }
  if (!form.startPrimary && !form.startSecondary) fail("至少需要启用一个实例");

  if (form.startPrimary) {
    form.publicHost = form.publicHost || DEFAULT_PUBLIC_HOST;
    if (!HOST_RE.test(form.publicHost)) fail("主实例公网域名只能包含小写字母、数字、点和连字符");
  }
  if (form.startSecondary) {
    form.publicHostSecondary = form.publicHostSecondary || DEFAULT_PUBLIC_HOST_SECONDARY;
    if (!HOST_RE.test(form.publicHostSecondary)) {
      fail("副实例公网域名只能包含小写字母、数字、点和连字符");
    }
  }
  if (form.startPrimary && form.startSecondary && form.publicHost === form.publicHostSecondary) {
    fail("主实例和副实例不能使用同一个公网域名");
  }
  if (form.lanHost) {
    // 纯数字点串（如 999.999.999.999）必须按 IPv4 校验，不能当主机名放行。
    const numericDotted = form.lanHost.includes(".") && /^[0-9.]+$/.test(form.lanHost);
    const valid = numericDotted
      ? isIP(form.lanHost) === 4
      : isIP(form.lanHost) !== 0 || HOST_RE.test(form.lanHost);
    if (!valid) fail("内网入口地址必须是合法的 IPv4、IPv6 或主机名");
  }

  requireAbsolute(form.configDir, "配置目录");
  requireAbsolute(form.primaryDir, "主实例目录");
  requireAbsolute(form.secondaryDir, "副实例目录");
  requireAbsolute(form.dataPrimary, "主实例数据目录");
  requireAbsolute(form.dataSecondary, "副实例数据目录");
  if (form.archiveDir) requireAbsolute(form.archiveDir, "归档目录");
  if (form.startPrimary && form.startSecondary) {
    if (path.resolve(form.primaryDir) === path.resolve(form.secondaryDir)) {
      fail("主实例和副实例不能使用同一个目录");
    }
    if (path.resolve(form.dataPrimary) === path.resolve(form.dataSecondary)) {
      fail("主实例和副实例不能使用同一个数据目录");
    }
  }

  const isExecutable = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true);
    } catch {
      return false;
    }
  };
  const existsFile = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const checkInstall = (dir: string, label: string): void => {
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) fail(`${label}不存在：${dir}`);
    if (usesNodeDeployJob(platform)) {
      // Windows / macOS 走 Node 部署任务，不依赖 bash 脚本的可执行位。
      const platformName = platform === "win32" ? "Windows" : "macOS";
      for (const file of ["deploy/deploy-job.mjs", "deploy/deploy-lib.mjs", "package.json"]) {
        if (!existsFile(path.join(dir, file))) {
          fail(`${label}缺少 ${file}，无法在 ${platformName} 上部署：${dir}`);
        }
      }
      return;
    }
    for (const script of ["deploy/install.sh", "deploy/start-all.sh", "deploy/build.sh"]) {
      if (!isExecutable(path.join(dir, script))) {
        fail(`${label}缺少可执行的 ${script}：${dir}`);
      }
    }
  };
  /** clonePeer 时允许目标不存在，但父目录必须可写（或能由已有祖先创建）。 */
  const checkCreatable = (dir: string, label: string): void => {
    let dirStat: fs.Stats | undefined;
    try {
      dirStat = fs.statSync(dir);
    } catch {
      dirStat = undefined;
    }
    if (dirStat && !dirStat.isDirectory()) fail(`${label}是文件而不是目录：${dir}`);
    let existing = path.dirname(dir);
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    let writable = false;
    try {
      writable = fs.statSync(existing).isDirectory()
        && (fs.accessSync(existing, fs.constants.W_OK), true);
    } catch {
      writable = false;
    }
    if (!writable) fail(`${label}的父目录不可写或无法创建：${path.dirname(dir)}`);
  };
  if (form.startPrimary) checkInstall(form.primaryDir, "主实例目录");
  if (form.startSecondary) {
    if (form.clonePeer) checkCreatable(form.secondaryDir, "副实例目录");
    else checkInstall(form.secondaryDir, "副实例目录");
  }

  if (form.nodeBin) {
    let ok = false;
    try {
      ok = fs.statSync(form.nodeBin).isFile();
      if (ok) fs.accessSync(form.nodeBin, fs.constants.X_OK);
    } catch {
      ok = false;
    }
    if (!ok) fail(`Node 路径不存在或不可执行：${form.nodeBin}`);
  }

  if (form.startPrimary && !URL_RE.test(form.primaryRepoUrl)) {
    fail("主实例仓库地址必须是 http(s):// 开头");
  }
  if (form.startSecondary && !URL_RE.test(form.secondaryRepoUrl)) {
    fail("副实例仓库地址必须是 http(s):// 开头");
  }
  if (!form.primaryRef) fail("主实例分支不能为空");
  if (!REF_RE.test(form.primaryRef)) {
    fail("主实例分支只能包含字母、数字、点、下划线、斜杠和连字符");
  }
  // secondary.sh 会把 ref 直接传给 git fetch；前导 - 会被当成选项，.. 可穿越层级。
  if (form.primaryRef.startsWith("-") || form.primaryRef.includes("..")) {
    fail("主实例分支不能以 - 开头或包含 ..");
  }

  if (form.archiveRetentionDays < 1 || form.archiveRetentionDays > 3650) {
    fail("列表保留天数必须在 1 到 3650 之间");
  }
  if (form.maxConcurrent < 1 || form.maxConcurrent > 256) {
    fail("并发上限必须在 1 到 256 之间");
  }
  if (form.approvalTimeoutMinutes < 0 || form.approvalTimeoutMinutes > 1440) {
    fail("确认超时必须在 0 到 1440 分钟之间（0 表示不自动拒绝）");
  }

  return form;
}

/** 表单对应的 env 键值；所有值都是字符串，写入 env 文件并由部署脚本读取。 */
export function deployEnvValues(form: DeployForm, projectsFile: string): Record<string, string> {
  return {
    QUBIUS_START_PRIMARY: form.startPrimary ? "1" : "0",
    QUBIUS_START_SECONDARY: form.startSecondary ? "1" : "0",
    QUBIUS_CLONE_PEER: form.clonePeer ? "1" : "0",
    QUBIUS_PULL_LATEST: form.pullLatest ? "1" : "0",
    QUBIUS_PRIMARY_PORT: String(form.primaryPort),
    QUBIUS_SECONDARY_PORT: String(form.secondaryPort),
    QUBIUS_PUBLIC_HOST: form.publicHost,
    QUBIUS_PUBLIC_HOST_SECONDARY: form.publicHostSecondary,
    QUBIUS_ALLOWED_HOSTS: form.allowedHostsExtra ?? "",
    QUBIUS_AUTH: form.authMode === "off" ? "0" : "1",
    QUBIUS_AUTH_TOKEN: form.authMode === "custom" ? form.authToken : "",
    QUBIUS_TERMINAL: form.terminal === false ? "0" : "1",
    QUBIUS_MAX_CONCURRENT: String(form.maxConcurrent ?? 4),
    QUBIUS_APPROVAL_TIMEOUT_MINUTES: String(form.approvalTimeoutMinutes ?? 10),
    QUBIUS_LIMIT_TRANSCRIPT_BYTES: String(form.limits?.transcriptBytes ?? DEFAULT_LIMITS.transcriptBytes),
    QUBIUS_LIMIT_TRANSCRIPT_MESSAGES: String(form.limits?.transcriptMessages ?? DEFAULT_LIMITS.transcriptMessages),
    QUBIUS_LIMIT_MESSAGE_TEXT: String(form.limits?.messageText ?? DEFAULT_LIMITS.messageText),
    QUBIUS_LIMIT_REQUEST_BODY: String(form.limits?.requestBodyBytes ?? DEFAULT_LIMITS.requestBodyBytes),
    QUBIUS_HISTORY_PAGE: String(form.limits?.historyPage ?? DEFAULT_LIMITS.historyPage),
    QUBIUS_START_LAN: form.lanEnabled ? "1" : "0",
    QUBIUS_LAN_USER: form.lanAuthUser,
    QUBIUS_LAN_HOST: form.lanHost,
    QUBIUS_CONFIG_DIR: form.configDir,
    QUBIUS_PRIMARY_DIR: form.primaryDir,
    QUBIUS_SECONDARY_DIR: form.secondaryDir,
    QUBIUS_DATA_PRIMARY: form.dataPrimary,
    QUBIUS_DATA_SECONDARY: form.dataSecondary,
    QUBIUS_PRIMARY_REPO_URL: form.primaryRepoUrl,
    QUBIUS_SECONDARY_REPO_URL: form.secondaryRepoUrl,
    QUBIUS_PRIMARY_REF: form.primaryRef,
    QUBIUS_ARCHIVE_DIR: form.archiveDir,
    QUBIUS_ARCHIVE_RETENTION_DAYS: String(form.archiveRetentionDays),
    QUBIUS_NODE_BIN: form.nodeBin,
    QUBIUS_PROJECTS_FILE: form.projects.length > 0 ? projectsFile : "",
  };
}

function shellValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 合并 env 文本：保留注释和本页不管理的行（例如 QUBIUS_GITEA_TOKEN），
 * 只替换 MANAGED_KEYS 里的键；缺失的键追加在末尾。
 */
export function mergeEnvText(existing: string, values: Record<string, string>): string {
  const managed = new Set<string>(MANAGED_KEYS);
  const emitted = new Set<string>();
  const lines: string[] = [];
  for (const line of existing.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && managed.has(match[1]!)) {
      const key = match[1]!;
      if (emitted.has(key)) continue;
      emitted.add(key);
      lines.push(`${key}=${shellValue(values[key] ?? "")}`);
      continue;
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const key of MANAGED_KEYS) {
    if (emitted.has(key)) continue;
    lines.push(`${key}=${shellValue(values[key] ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** YAML 单引号字符串；含控制字符时退回 JSON 双引号（YAML 兼容的转义形式）。 */
function yamlString(value: string): string {
  if (CONTROL_RE.test(value)) return JSON.stringify(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  // 嵌套结构无法满足 install.sh 只允许四空格续行的限制，序列化成单行字符串保留。
  return yamlString(JSON.stringify(value));
}

/** 旧版本把 worktree 写成了 JSON 字符串；读回时尽量还原成映射。 */
function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function renderProjectsYaml(projects: DeployProject[]): string {
  if (projects.length === 0) return "";
  const lines: string[] = [];
  for (const project of projects) {
    lines.push(`  - id: ${yamlString(project.id)}`);
    lines.push(`    name: ${yamlString(project.name)}`);
    lines.push(`    path: ${yamlString(project.path)}`);
    lines.push(`    permission: ${project.permission}`);
    if (project.isolated) lines.push("    isolated: true");
    for (const [key, value] of Object.entries(project.extras ?? {})) {
      if (PROJECT_MODELED_KEYS.has(key)) continue;
      const safeKey = /^[A-Za-z0-9_.-]+$/.test(key) ? key : yamlString(key);
      // worktree 是服务端认识的嵌套配置，必须写成未加引号的单行 YAML 映射
      //（JSON 是 YAML 子集），否则会变成字符串、让服务端整份项目文件解析失败。
      // 单行形式同时满足 install.sh 只允许四空格续行的限制；空对象也按映射输出。
      if (key === "worktree") {
        const nested = typeof value === "string" ? parseJsonObject(value) : value;
        if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
          lines.push(`    ${safeKey}: ${JSON.stringify(nested)}`);
          continue;
        }
      }
      lines.push(`    ${safeKey}: ${yamlScalar(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * 备份文件。env 可能含 QUBIUS_GITEA_TOKEN 等密钥，备份必须和主文件一样
 * 以 0600 落盘；copyFileSync 会按 umask 生成 0644，不能用。
 */
function backupFile(file: string, mode: number): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const base = `${file}.bak.${timestamp()}`;
  let target = base;
  let counter = 1;
  while (fs.existsSync(target)) {
    target = `${base}-${counter}`;
    counter += 1;
  }
  const content = fs.readFileSync(file);
  writeAtomic(target, content, mode);
  return target;
}

function writeAtomic(file: string, content: string | Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** 写部署 env 文件：先备份旧文件，保留其它行，权限 0600。 */
export function writeDeployEnv(envFile: string, form: DeployForm, projectsFile: string): { backup?: string } {
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch {
    existing = "";
  }
  const merged = mergeEnvText(existing, deployEnvValues(form, projectsFile));
  const backup = backupFile(envFile, 0o600);
  writeAtomic(envFile, merged, 0o600);
  return backup ? { backup } : {};
}

/** 写 projects 文件；旧文件备份为 *.bak.<时间戳>。 */
export function writeProjectsFile(file: string, projects: DeployProject[]): { backup?: string } {
  const backup = backupFile(file, 0o644);
  writeAtomic(file, renderProjectsYaml(projects), 0o644);
  return backup ? { backup } : {};
}

/** 用户清空项目列表：备份旧文件后删除，避免留下 0 字节或畸形文件。 */
function removeProjectsFile(file: string): { backup?: string } {
  const backup = backupFile(file, 0o644);
  try {
    fs.unlinkSync(file);
  } catch {
    // 文件已被删除或无法删除；env 里的引用会同时清空，不影响后续部署。
  }
  return backup ? { backup } : {};
}

export function deployStatusFile(configDir: string): string {
  return path.join(configDir, "deploy.json");
}

export function deployLogFile(configDir: string): string {
  return path.join(configDir, "deploy.log");
}

/** 日志可能带仓库 URL，统一以 0600 创建/修正并做 user:pass 脱敏。 */
function redactUrl(value: string): string {
  return value.replace(/(:\/\/)[^/@\s]+@/g, "$1***@");
}

function appendDeployLog(file: string, text: string): void {
  fs.appendFileSync(file, redactUrl(text), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 不能 chmod 时至少保留了创建时的 0600。
  }
}

const TAIL_BYTES = 64 * 1024;

interface DeployTailCacheEntry {
  size: number;
  mtimeMs: number;
  lines: number;
  value: string | undefined;
}

/**
 * 状态接口每 2s 轮询一次；deploy.log 只在追加时变化。按 (size, mtimeMs, lines)
 * 缓存尾部结果，避免重复读 64KB。
 */
const deployTailCache = new Map<string, DeployTailCacheEntry>();

function tail(file: string, lines = 60): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    deployTailCache.delete(file);
    return undefined;
  }
  const cached = deployTailCache.get(file);
  if (
    cached !== undefined &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.lines === lines
  ) {
    return cached.value;
  }
  const size = stat.size;
  let fd: number | undefined;
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) {
      deployTailCache.set(file, { size, mtimeMs: stat.mtimeMs, lines, value: undefined });
      return undefined;
    }
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, buffer, 0, length, start);
    if (read <= 0) return undefined;
    const parts = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
    if (start > 0) parts.shift();
    // 文件末尾的换行会多出一个空元素，先去掉再按行截取，避免少算一行。
    while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    const text = parts.slice(-lines).join("\n").trim();
    const value = text || undefined;
    deployTailCache.set(file, { size, mtimeMs: stat.mtimeMs, lines, value });
    return value;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响读取结果。
      }
    }
  }
}

function isAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface DeployJobParseCacheEntry {
  text: string;
  job: DeployJobStatus | null;
}

/**
 * deploy.json 内容不变时复用解析结果。只缓存「磁盘上原样记录的字段」，
 * 不做 running→failed 的存活归一化，避免 pid 存活状态变化后拿到过期结论。
 */
const deployJobParseCache = new Map<string, DeployJobParseCacheEntry>();

function parseDeployJobText(text: string): DeployJobStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const state = record.state;
  if (state !== "running" && state !== "success" && state !== "failed") return null;
  return {
    jobId: typeof record.jobId === "string" ? record.jobId : "",
    state,
    step: typeof record.step === "string" ? record.step : "",
    message: typeof record.message === "string" ? record.message : "",
    pid: typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
  };
}

/** 读取部署任务状态；文件不存在或内容损坏时返回 null，并附上日志尾部。 */
export function readDeployJob(configDir: string): DeployJobStatus | null {
  const file = deployStatusFile(configDir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    deployJobParseCache.delete(file);
    return null;
  }
  const cached = deployJobParseCache.get(file);
  let parsed: DeployJobStatus | null;
  if (cached !== undefined && cached.text === text) {
    parsed = cached.job;
  } else {
    parsed = parseDeployJobText(text);
    deployJobParseCache.set(file, { text, job: parsed });
  }
  if (!parsed) return null;
  const job: DeployJobStatus = { ...parsed };
  // 进程已死但状态还停在 running（server 被杀/崩溃）：归一化为失败，
  // 避免页面永久转圈，也避免 pid 复用导致 busy 误判。
  if (job.state === "running" && !isAlive(job.pid)) {
    job.state = "failed";
    if (!job.message || job.message === "部署任务已启动") job.message = "部署任务已中断";
    if (!job.finishedAt) job.finishedAt = jobTimestamp();
  }
  const logTail = tail(deployLogFile(configDir));
  if (logTail) job.logTail = logTail;
  return job;
}

export function writeDeployJob(configDir: string, job: DeployJobStatus): void {
  writeAtomic(deployStatusFile(configDir), `${JSON.stringify(job, null, 2)}\n`, 0o644);
}

export function deployBusy(configDir: string): boolean {
  const job = readDeployJob(configDir);
  return job?.state === "running" && isAlive(job.pid);
}

function deployLockFile(configDir: string): string {
  return path.join(configDir, "deploy.job.lock");
}

/**
 * 用 O_EXCL 创建锁文件，把「busy 检查 → 写 running 状态」变成原子操作；
 * 主/副实例共享同一个 configDir 时也安全。返回 null 表示已有任务在跑。
 * 锁只覆盖 apply 的启动阶段，任务运行期间由状态文件里的 pid 判断 busy。
 */
export function acquireDeployLock(configDir: string): (() => void) | null {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const lock = deployLockFile(configDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lock);
        } catch {
          // 锁已不存在。
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const job = readDeployJob(configDir);
      if (job?.state === "running" && isAlive(job.pid)) return null;
      // 没有存活任务却留着锁：上次 apply 中途崩溃，清掉后重试一次。
      try {
        fs.unlinkSync(lock);
      } catch {
        // 别的进程刚清掉，重试即可。
      }
    }
  }
  return null;
}

export interface DeployJobSpec {
  /** 部署任务脚本的绝对路径。 */
  script: string;
  /** 启动脚本所用的可执行文件。 */
  command: string;
  args: string[];
  windowsHide: boolean;
}

/**
 * 选择部署任务：Windows / macOS 用 Node 脚本（不依赖 bash/systemd/flock），
 * Linux 保持原来的 deploy-job.sh。
 */
export function deployJobSpec(options: {
  repoRoot: string;
  platform?: NodeJS.Platform;
  nodeBin?: string;
  execPath?: string;
}): DeployJobSpec {
  const platform = options.platform ?? process.platform;
  if (usesNodeDeployJob(platform)) {
    const script = path.join(options.repoRoot, "deploy", "deploy-job.mjs");
    return {
      script,
      command: options.nodeBin || options.execPath || process.execPath,
      args: [script],
      windowsHide: true,
    };
  }
  const script = path.join(options.repoRoot, "deploy", "deploy-job.sh");
  return { script, command: "bash", args: [script], windowsHide: false };
}

export interface StartDeployOptions {
  configDir: string;
  repoRoot: string;
  /** 传递给部署脚本的 QUBIUS_* 表单值（含 QUBIUS_PROJECTS_FILE）。 */
  values: Record<string, string>;
  /** 本次部署实际读写的 env 文件；默认 `<configDir>/env`。 */
  envFile?: string;
  /** applyDeploy 已 claim 的 ops lock；脚本会接管 flock。 */
  jobId?: string;
  /** Linux 上必填：deploy-job.sh 强制要求持有 ops lock；Windows/macOS 忽略。 */
  token: string;
  /** 目标平台；默认 process.platform，测试可显式指定。 */
  platform?: NodeJS.Platform;
  /** 当前服务实例的角色；部署任务据此决定是否停掉父进程。 */
  parentRole?: Role;
  /** 当前服务的数据目录；部署任务用它找到 shutdown-token 做优雅退出。 */
  parentDataDir?: string;
  /** 当前服务监听的端口；部署任务用它向旧进程发送优雅退出请求。 */
  parentPort?: number;
}

/**
 * 启动 detached 部署任务。任务不依赖当前 server 进程存活：start-all 会杀掉
 * 这个 server，所以脚本必须独立运行。返回 "busy" 表示已有任务在跑。
 */
export function startDeployJob(options: StartDeployOptions): { jobId: string } | "busy" {
  const { configDir, repoRoot, values } = options;
  const platform = options.platform ?? process.platform;
  if (deployBusy(configDir)) return "busy";
  const spec = deployJobSpec({
    repoRoot,
    platform,
    nodeBin: values.QUBIUS_NODE_BIN,
  });
  if (!fs.existsSync(spec.script)) throw new Error(`找不到部署脚本 ${spec.script}`);

  const jobId = options.jobId ?? randomUUID();
  const startedAt = jobTimestamp();
  const statusFile = deployStatusFile(configDir);
  const logFile = deployLogFile(configDir);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  appendDeployLog(logFile, `===== ${startedAt} deploy ${jobId} =====\n`);

  // 脚本自己会立刻写 running/prepare；这里只在它还没来得及写时补一条。
  const initial: DeployJobStatus = {
    jobId,
    state: "running",
    step: "prepare",
    message: "部署任务已启动",
    pid: null,
    startedAt,
    finishedAt: null,
  };

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...values,
    // 指向 applyDeploy 实际写入的那份 env，避免 shell 回落到另一份配置。
    QUBIUS_ENV: options.envFile ?? path.join(configDir, "env"),
    QUBIUS_CONFIG_DIR: values.QUBIUS_CONFIG_DIR ?? configDir,
    QUBIUS_PRIMARY_DIR: values.QUBIUS_PRIMARY_DIR ?? "",
    QUBIUS_SECONDARY_DIR: values.QUBIUS_SECONDARY_DIR ?? "",
    QUBIUS_START_PRIMARY: values.QUBIUS_START_PRIMARY ?? "0",
    QUBIUS_START_SECONDARY: values.QUBIUS_START_SECONDARY ?? "0",
    QUBIUS_CLONE_PEER: values.QUBIUS_CLONE_PEER ?? "0",
    QUBIUS_SECONDARY_REPO_URL: values.QUBIUS_SECONDARY_REPO_URL ?? "",
    QUBIUS_DEPLOY_STATUS: statusFile,
    QUBIUS_DEPLOY_LOG: logFile,
    QUBIUS_DEPLOY_JOB_ID: jobId,
    QUBIUS_DEPLOY_STARTED_AT: startedAt,
    QUBIUS_DEPLOY_PARENT_PID: String(process.pid),
    QUBIUS_DEPLOY_PARENT_ROLE: options.parentRole ?? "primary",
    QUBIUS_DEPLOY_PARENT_SCRIPT: process.argv[1] ?? "",
    QUBIUS_DEPLOY_PARENT_DATA_DIR: options.parentDataDir ?? "",
    QUBIUS_DEPLOY_PARENT_PORT: options.parentPort ? String(options.parentPort) : "",
    QUBIUS_DEPLOY_REPO_ROOT: repoRoot,
  };
  // Windows / macOS 的 Node 部署任务自己串行化（deploy.job.lock + deploy.json），
  // 不使用依赖 flock 的 shell ops lock。
  const childEnv = usesNodeDeployJob(platform)
    ? baseEnv
    : opsJobEnv(configDir, options.token, jobId, baseEnv);

  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: childEnv,
      windowsHide: spec.windowsHide,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeDeployJob(configDir, {
      jobId,
      state: "failed",
      step: "spawn",
      message: `部署任务启动失败：${message}`,
      pid: null,
      startedAt,
      finishedAt: jobTimestamp(),
    });
    throw new Error(`无法启动部署任务：${message}`);
  }
  // 没有 error 监听器时 spawn 失败会变成未处理的 error 事件，拖垮服务。
  child.on("error", (error) => {
    try {
      appendDeployLog(logFile, `部署任务启动失败：${error.message}\n`);
    } catch {
      // 日志写不了就只更新状态文件。
    }
    try {
      writeDeployJob(configDir, {
        jobId,
        state: "failed",
        step: "spawn",
        message: "部署任务启动失败",
        pid: null,
        startedAt,
        finishedAt: jobTimestamp(),
      });
    } catch {
      // 状态也无法写入时只能放弃记录。
    }
    // spawn 异步失败时清掉 pending ops claim，避免锁被占 120s。
    if (!usesNodeDeployJob(platform)) {
      try {
        clearOpsLock(configDir, options.token);
      } catch {
        // 清理失败只能等 pending 宽限期过期。
      }
    }
  });
  child.unref();

  // 补上 running 状态和 pid 供 busy 判断使用；如果脚本已经写了同 jobId 的
  // 进度（甚至已经成功），不要覆盖它。
  try {
    const current = readDeployJob(configDir);
    if (!current || current.jobId !== jobId) {
      writeDeployJob(configDir, { ...initial, pid: child.pid ?? null });
    }
  } catch {
    // 状态文件只是展示用途，更新失败不影响任务本身。
  }
  return { jobId };
}

async function probe(port: number): Promise<{ running: boolean; head?: string; version?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(700),
    });
    if (!response.ok) return { running: false };
    let head: string | undefined;
    let version: string | undefined;
    try {
      const data = (await response.json()) as { head?: unknown; version?: unknown };
      if (typeof data.head === "string" && data.head.trim()) head = data.head.trim();
      if (typeof data.version === "string" && data.version.trim()) version = data.version.trim();
    } catch {
      // 健康检查不是 JSON 时只记录 running。
    }
    return {
      running: true,
      ...(head ? { head } : {}),
      ...(version ? { version } : {}),
    };
  } catch {
    return { running: false };
  }
}

/** 按端口探测两个实例；探测失败视为未运行。 */
export async function probeInstances(form: DeployForm): Promise<DeployInstanceInfo[]> {
  const targets: Array<{ role: "primary" | "secondary"; repoDir: string; dataDir: string; port: number }> = [
    { role: "primary", repoDir: form.primaryDir, dataDir: form.dataPrimary, port: form.primaryPort },
    { role: "secondary", repoDir: form.secondaryDir, dataDir: form.dataSecondary, port: form.secondaryPort },
  ];
  return Promise.all(targets.map(async (target) => {
    const result = await probe(target.port);
    return {
      role: target.role,
      repoDir: target.repoDir,
      dataDir: target.dataDir,
      port: target.port,
      running: result.running,
      ...(result.head ? { head: result.head } : {}),
      ...(result.version ? { version: result.version } : {}),
    };
  }));
}

function resolveProjectsFile(value: string | undefined, configDir: string): string {
  const configured = (value ?? "").trim();
  return configured ? resolveDir(configDir, configured) : path.join(configDir, "projects.yaml");
}

/** 局域网 Basic 凭据文件：LAN_PROXY_CREDENTIALS 优先，否则 <configDir>/lan-proxy.credentials。 */
export function lanCredentialsFile(configDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = nonEmpty(env.LAN_PROXY_CREDENTIALS);
  return configured ? resolveDir(configDir, configured) : path.join(configDir, "lan-proxy.credentials");
}

/** 读取 user:password；文件缺失或格式不对时返回 undefined。 */
export function readLanCredentials(file: string): { user: string; password: string } | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const index = raw.indexOf(":");
    if (index <= 0) return undefined;
    const user = raw.slice(0, index).trim();
    const password = raw.slice(index + 1);
    if (!user || !password) return undefined;
    return { user, password };
  } catch {
    return undefined;
  }
}

export function writeLanCredentials(file: string, user: string, password: string): void {
  writeAtomic(file, `${user}:${password}\n`, 0o600);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 等不支持 chmod；文件仍在配置目录里。
  }
}

function generateLanPassword(): string {
  // 16 个 base64url 字符，方便复制，不含冒号/空白。
  return randomBytes(12).toString("base64url");
}

/**
 * 合并进程 env 与部署 env 文件里的局域网地址变量：
 * 进程 env 优先，其次 env 文件（QUBIUS_ENV > configDir/env > repo/deploy/env）。
 * 这样服务端能读到 start-all 没有导出的 LAN_PROXY_HOST。
 */
export function deployLanEnv(
  env: NodeJS.ProcessEnv = process.env,
  configDir?: string,
  repoRoot?: string,
): NodeJS.ProcessEnv {
  if (!configDir) return { ...env };
  const resolved = resolveDeployEnvFile(env, configDir, repoRoot);
  if (!resolved.exists) return { ...env };
  let stored: Record<string, string>;
  try {
    stored = parseEnvFile(fs.readFileSync(resolved.file, "utf8"), env);
  } catch {
    return { ...env };
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const key of ["LAN_PROXY_HOST", "QUBIUS_LAN_HOST"]) {
    if (!nonEmpty(merged[key]) && nonEmpty(stored[key])) merged[key] = stored[key];
  }
  return merged;
}

/**
 * 自动选择局域网 IPv4（忽略显式配置），保留给旧调用方。
 * 新代码请用 lan-address.ts 的 lanAddress()/tryLanAddress()，它们会优先采用
 * LAN_PROXY_HOST/QUBIUS_LAN_HOST。
 */
export function detectLanHost(): string | undefined {
  return tryLanAddress({ env: {} });
}

function lanUrls(form: DeployForm, env: NodeJS.ProcessEnv): string[] {
  // LAN_PROXY_HOST 优先；表单值（QUBIUS_LAN_HOST）覆盖 env 文件里的同名值。
  const qHost = form.lanHost.trim() || nonEmpty(env.QUBIUS_LAN_HOST) || "";
  let host: string | undefined;
  try {
    host = tryLanAddress({ env: { ...env, QUBIUS_LAN_HOST: qHost } });
  } catch (error) {
    // 显式值非法时给出可读的 400，而不是静默退回自动地址。
    throw new DeployValidationError(
      error instanceof Error ? error.message : "内网入口地址无效",
    );
  }
  if (!host) return [];
  const urls: string[] = [];
  if (form.startPrimary) urls.push(`http://${host}:${form.primaryPort}`);
  if (form.startSecondary) urls.push(`http://${host}:${form.secondaryPort}`);
  return urls;
}

/** 当前 config.yaml 里的 dataDir；没有配置文件或字段时返回 undefined。 */
function readConfiguredDataDir(configFile: string, configDir: string): string | undefined {
  try {
    const parsed = parseYaml(fs.readFileSync(configFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>).dataDir;
    if (typeof value !== "string" || !value.trim()) return undefined;
    return resolveDir(configDir, value.trim());
  } catch {
    return undefined;
  }
}

/** 数据目录里的会话数；目录存在但读不到 sessions 时按 1 处理，宁可多确认一次。 */
function countSessions(dataDir: string): number {
  const sessionsDir = path.join(dataDir, "sessions");
  try {
    return fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".json")).length;
  } catch {
    try {
      return fs.statSync(dataDir).isDirectory() ? 1 : 0;
    } catch {
      return 0;
    }
  }
}

/** 写入（或沿用）局域网凭据，返回本次要一次性展示的信息。 */
function prepareLanInfo(
  form: DeployForm,
  configDir: string,
  env: NodeJS.ProcessEnv,
): DeployLanInfo | undefined {
  if (!form.lanEnabled) return undefined;
  const file = lanCredentialsFile(configDir, env);
  const existing = readLanCredentials(file);
  const user = form.lanAuthUser.trim() || existing?.user || "qubius";
  const password = form.lanAuthPassword || existing?.password || generateLanPassword();
  writeLanCredentials(file, user, password);
  return { user, password, urls: lanUrls(form, env) };
}

/** 部署后生效的 API 令牌：custom 用表单值，auto 读/生成目标数据目录的 auth-token。 */
function deployedAuthToken(form: DeployForm, role: Role): string | undefined {
  if (form.authMode === "off") return undefined;
  if (form.authMode === "custom") return form.authToken || undefined;
  const dataDir = role === "secondary" ? form.dataSecondary : form.dataPrimary;
  try {
    return resolveAuthToken({ auth: true, dataDir }, {});
  } catch {
    return undefined;
  }
}

export interface ApplyDeployOptions {
  body: unknown;
  repoRoot: string;
  /** 服务实际加载的配置文件；用于数据目录变化检查。 */
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  /** 当前服务实例的角色；交给部署任务决定是否停掉父进程。 */
  role?: Role;
  /** 当前服务的数据目录和端口；部署任务据此向旧进程请求优雅退出。 */
  dataDir?: string;
  port?: number;
  /** 目标平台；默认 process.platform，测试可显式指定。 */
  platform?: NodeJS.Platform;
}

/**
 * 校验表单 → 写 projects → 合并写 env → detached 启动部署任务。
 * 先做 busy 检查再落盘，避免任务在跑时覆盖用户配置。
 */
/** 合并同 id 的既有项目：保留 isolated 和未建模字段，表单值优先。 */
function mergeProjects(existing: DeployProject[], incoming: DeployProject[]): DeployProject[] {
  const byId = new Map(existing.map((project) => [project.id, project]));
  return incoming.map((project) => {
    const prev = byId.get(project.id);
    const { isolatedProvided, ...rest } = project;
    if (!prev) return rest;
    // 请求没有显式给 isolated（旧前端）时沿用磁盘上的值，避免静默改成 false。
    const isolated = isolatedProvided === false ? prev.isolated : project.isolated;
    const extras = { ...prev.extras, ...project.extras };
    return {
      ...rest,
      isolated,
      ...(Object.keys(extras).length > 0 ? { extras } : {}),
    };
  });
}

function opsBusyResult(
  result: ReturnType<typeof claimOpsLock>,
  fallbackKind?: string,
): DeployBusy {
  if (result.code === "residual") {
    return { code: "residual", remainingPids: result.remainingPids ?? [] };
  }
  const kind =
    result.kind && result.kind !== "unknown"
      ? result.kind
      : fallbackKind || undefined;
  return { code: "busy", ...(kind ? { kind } : {}) };
}

function busyKindFromStatus(configDir: string): string | undefined {
  try {
    const current = opsLockStatus(configDir, { cacheMs: 1000 });
    const kind = current.metaKind;
    return kind && kind !== "unknown" ? kind : undefined;
  } catch {
    return undefined;
  }
}

export function applyDeploy(options: ApplyDeployOptions): ApplyDeployResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // macOS 没有 flock，和 Windows 一样靠 deploy.job.lock + deploy.json 串行化。
  const useOpsLock = !usesNodeDeployJob(platform);
  const form = validateDeployForm(options.body, platform);
  // configDir 由服务端部署环境决定；不接受页面修改，否则 GET/POST/status 会读写不同目录。
  const configDir = deployConfigDir(env, platform, options.repoRoot);
  if (path.resolve(form.configDir) !== configDir) {
    throw new DeployValidationError("配置目录由服务端 QUBIUS_CONFIG_DIR 决定，不能在此修改");
  }
  form.configDir = configDir;
  // 与 GET/deriveDeployForm 用同一个解析结果，读写同一份文件。
  const resolution = resolveDeployEnvFile(env, configDir, options.repoRoot);
  if (resolution.source === "QUBIUS_ENV" && !resolution.exists) {
    throw new DeployValidationError(
      `QUBIUS_ENV 指向的 env 文件不存在：${resolution.file}。` +
        "shell 侧 deploy/lib.sh 会因此拒绝启动；请修正 QUBIUS_ENV 或创建该文件。",
    );
  }
  const envFile = resolution.file;

  // 重新部署最容易丢数据的场景：新配置把 dataDir 指到另一个空目录，页面看起来
  // 就是“会话全没了”。旧目录还有会话时要求显式确认，不静默切换。
  const existingConfigFile = options.configFile
    ? path.resolve(options.configFile)
    : path.join(configDir, (options.role ?? "primary") === "secondary" ? "config-secondary.yaml" : "config.yaml");
  const currentDataDir = readConfiguredDataDir(existingConfigFile, configDir);
  const targetDataDir = (options.role ?? "primary") === "secondary" ? form.dataSecondary : form.dataPrimary;
  if (
    currentDataDir
    && path.resolve(currentDataDir) !== path.resolve(targetDataDir)
    && !form.confirmDataDirChange
  ) {
    const sessions = countSessions(currentDataDir);
    if (sessions > 0) throw new DeployDataDirChangeError(currentDataDir, targetDataDir, sessions);
  }

  // O_EXCL 锁覆盖「busy 检查 → 写 running 状态」，跨进程也只允许一个 apply。
  // 先拿锁再读/写任何文件：busy 时直接 409，不留下半套配置。
  const release = acquireDeployLock(configDir);
  if (!release) return { code: "busy", kind: "deploy" };

  // ops.lock 是跨 job 的权威锁：写 env/Projects 与 spawn 前占位。
  // claim 只写 pending；detached 的 deploy-job.sh 会 flock 并接管。
  // Windows / macOS 没有 flock，deploy.job.lock + deploy.json 已经足够串行化；
  // 这两个平台的部署任务也不参与 edge 的 shell ops lock。
  const jobId = randomUUID();
  const token = randomUUID();
  if (useOpsLock) {
    let claimed: ReturnType<typeof claimOpsLock>;
    try {
      claimed = claimOpsLock({ root: configDir, kind: "deploy", jobId, token });
    } catch (error) {
      release();
      throw error;
    }
    if (!claimed.ok) {
      release();
      const fallback =
        claimed.code === "busy" && (!claimed.kind || claimed.kind === "unknown")
          ? busyKindFromStatus(configDir)
          : undefined;
      return opsBusyResult(claimed, fallback);
    }
  }

  let spawned = false;
  try {
    if (deployBusy(configDir)) return { code: "busy", kind: "deploy" };
    const spec = deployJobSpec({
      repoRoot: options.repoRoot,
      platform,
      nodeBin: form.nodeBin,
    });
    if (!fs.existsSync(spec.script)) throw new Error(`找不到部署脚本 ${spec.script}`);

    const stored = fs.existsSync(envFile)
      ? parseEnvFile(fs.readFileSync(envFile, "utf8"), env)
      : {};
    // 自定义令牌允许页面留空表示“沿用已保存的值”；不存在时才要求输入。
    if (form.authMode === "custom" && !form.authToken) {
      const existingToken = nonEmpty(stored.QUBIUS_AUTH_TOKEN) ?? nonEmpty(env.QUBIUS_AUTH_TOKEN);
      if (!existingToken || existingToken.length < 16 || existingToken.length > 512) {
        throw new DeployValidationError("自定义访问令牌必须是 16 到 512 个字符");
      }
      form.authToken = existingToken;
    }
    // 局域网凭据和部署后生效的令牌只在本次响应里返回一次；GET /api/deploy 不含密码。
    // env 文件里的 LAN_PROXY_HOST 可能没有导出到进程 env，这里显式合并后再算访问地址。
    const lanInfo = prepareLanInfo(form, configDir, deployLanEnv(env, configDir, options.repoRoot));
    const authToken = deployedAuthToken(form, options.role ?? "primary");
    const oneTime: DeployOneTimeInfo | undefined = lanInfo || authToken
      ? {
        ...(lanInfo ? { lan: lanInfo } : {}),
        ...(authToken ? { authToken } : {}),
      }
      : undefined;
    // 与 GET 一致：只有 env 显式配置了 QUBIUS_PROJECTS_FILE 才读该文件；
    // 未配置时不碰默认路径下的手工文件。
    const configuredProjects = nonEmpty(stored.QUBIUS_PROJECTS_FILE);
    const projectsFile = resolveProjectsFile(stored.QUBIUS_PROJECTS_FILE, configDir);
    if (form.projects.length > 0) {
      let existingProjects: DeployProject[] = [];
      if (configuredProjects) {
        // 已配置的 projects 文件损坏时拒绝覆盖，避免悄悄丢掉用户项目。
        const result = readProjectsFile(projectsFile, configDir);
        if (result.error) throw new DeployValidationError(`现有 projects 文件无法读取：${result.error}`);
        existingProjects = result.projects;
      }
      writeProjectsFile(projectsFile, mergeProjects(existingProjects, form.projects));
    } else if (configuredProjects) {
      // 没有额外项目：清空引用，备份并删除旧文件，下一次部署不会读到空文件。
      removeProjectsFile(projectsFile);
    }
    writeDeployEnv(envFile, form, projectsFile);
    const result = startDeployJob({
      configDir,
      repoRoot: options.repoRoot,
      values: deployEnvValues(form, projectsFile),
      envFile,
      jobId,
      token,
      platform,
      parentRole: options.role,
      parentDataDir: options.dataDir,
      parentPort: options.port,
    });
    if (result === "busy") return { code: "busy", kind: "deploy" };
    spawned = true;
    // 密码/令牌只在这次响应里返回，GET /api/deploy 只保留“已设置”状态。
    return oneTime ? { ...result, oneTime } : result;
  } finally {
    // 没有成功交给 detached 脚本时，按 token 清掉 pending，避免锁被占 120s。
    if (useOpsLock && !spawned) {
      try {
        clearOpsLock(configDir, token);
      } catch {
        // 清理失败只能让 pending 宽限期自然过期。
      }
    }
    release();
  }
}

export interface ReadDeployStateOptions {
  role: Role;
  repoRoot: string;
  port: number;
  setupRequired?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 当前进程的配置；传入后在 /api/deploy 里附带 current 摘要。 */
  config?: AppConfig;
  /** 服务实际加载的配置文件；--config 指定时用它而不是按 configDir 推导。 */
  configFile?: string;
  authEnabled?: boolean;
  authTokenSource?: "config" | "env" | "file";
  authTokenFile?: string;
}

export async function readDeployState(options: ReadDeployStateOptions): Promise<DeployState> {
  const { configDir, envFile, envSource, form, projectsError } = deriveDeployForm(
    options.env,
    options.role,
    options.repoRoot,
  );
  const configFile = options.configFile
    ? path.resolve(options.configFile)
    : path.join(configDir, options.role === "secondary" ? "config-secondary.yaml" : "config.yaml");
  // 只有首次部署（没有配置文件）才需要这个提示，正常页面不必每次都查 git。
  const detectedRepoUrl = options.setupRequired === true
    ? detectRepoUrl(path.resolve(options.repoRoot))
    : undefined;
  const current: DeployCurrentConfig | undefined = options.config
    ? {
      dataDir: options.config.dataDir,
      allowedHosts: options.config.allowedHosts?.length
        ? [...options.config.allowedHosts]
        : [...DEFAULT_ALLOWED_HOSTS],
      authEnabled: options.authEnabled === true,
      ...(options.authTokenSource ? { authTokenSource: options.authTokenSource } : {}),
      ...(options.authTokenFile ? { authTokenFile: options.authTokenFile } : {}),
      terminal: options.config.terminal !== false,
      lan: {
        enabled: form.lanEnabled,
        user: form.lanAuthUser,
        passwordSet: form.lanAuthPasswordSet === true,
        file: lanCredentialsFile(configDir, options.env ?? process.env),
      },
      ...(options.config.archive
        ? {
          archive: {
            dir: options.config.archive.dir,
            retentionDays: options.config.archive.retentionDays,
            instance: options.config.archive.instance,
          },
        }
        : {}),
      role: options.config.role,
    }
    : undefined;
  return {
    setupRequired: options.setupRequired === true,
    repoDir: path.resolve(options.repoRoot),
    ...(detectedRepoUrl ? { detectedRepoUrl } : {}),
    configDir,
    configFile,
    envFile,
    envSource,
    role: options.role,
    ...(current ? { current } : {}),
    port: options.port,
    platform: process.platform,
    nodeVersion: process.version,
    form,
    instances: await probeInstances(form),
    job: readDeployJob(configDir),
    ...(projectsError ? { projectsError } : {}),
  };
}
