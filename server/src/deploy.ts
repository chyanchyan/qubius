import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Role } from "./config.js";
import { resolveDeployEnvFile, type DeployEnvSource } from "./deploy-env.js";
import { jobTimestamp } from "./job-state.js";
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
  lanHost: string;
  configDir: string;
  primaryDir: string;
  secondaryDir: string;
  dataPrimary: string;
  dataSecondary: string;
  primaryRepoUrl: string;
  secondaryRepoUrl: string;
  primaryRef: string;
  archiveDir: string;
  archiveRetentionDays: number;
  nodeBin: string;
  projects: DeployProject[];
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

export type ApplyDeployResult = { jobId: string } | DeployBusy;

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
  "QUBIUS_LAN_HOST",
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

function fail(message: string): never {
  throw new DeployValidationError(message);
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/**
 * Windows 的机器级配置目录：%APPDATA%\qubius。
 * 只有在真实 Windows 环境（env 里带 APPDATA/USERPROFILE）时才启用，
 * 这样用独立 HOME 的测试在 Linux/Windows 上都能得到 POSIX 语义。
 */
function windowsConfigDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return undefined;
  const appData = nonEmpty(env.APPDATA);
  if (appData) return path.join(appData, "qubius");
  const profile = nonEmpty(env.USERPROFILE);
  return profile ? path.join(profile, "AppData", "Roaming", "qubius") : undefined;
}

/** Windows 的数据目录：%LOCALAPPDATA%\qubius（与 roaming 配置分开）。 */
function windowsDataHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return undefined;
  const localAppData = nonEmpty(env.LOCALAPPDATA);
  if (localAppData) return localAppData;
  const profile = nonEmpty(env.USERPROFILE);
  return profile ? path.join(profile, "AppData", "Local") : undefined;
}

/**
 * 是否走 Node 版部署任务 `deploy/deploy-job.mjs`：
 * Windows 和 macOS 没有 systemd，macOS 还没有 flock/ss/setsid/sha256sum，
 * 用纯 Node 任务完成配置渲染、构建和进程重启；Linux 继续用 deploy-job.sh。
 */
function usesNodeDeployJob(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** 与 deploy/lib.sh 一致：${XDG_CONFIG_HOME:-$HOME/.config}/qubius；Windows 用 %APPDATA%。 */
export function defaultConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const windows = windowsConfigDir(env, platform);
  if (windows) return windows;
  const home = homeOf(env);
  return path.join(nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config"), "qubius");
}

/** 与 deploy/lib.sh 一致：${XDG_DATA_HOME:-$HOME/.local/share}；Windows 用 %LOCALAPPDATA%。 */
function defaultDataHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return windowsDataHome(env, platform)
    ?? nonEmpty(env.XDG_DATA_HOME)
    ?? path.join(homeOf(env), ".local", "share");
}

/** 部署配置目录：QUBIUS_CONFIG_DIR，或 Windows 的 %APPDATA%\qubius / 其它平台的 ~/.config/qubius。 */
export function deployConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = (env.QUBIUS_CONFIG_DIR ?? "").trim();
  return path.resolve(configured || defaultConfigDir(env, platform));
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
  const configDir = deployConfigDir(env, platform);
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
  // Windows / macOS 的主实例没有显式配置时默认部署当前 checkout（本机首次部署
  // 通常就在这个仓库里）。Linux 保持原来的 $HOME/qubius 默认，避免改变既有行为。
  const primaryDirDefault = usesNodeDeployJob(platform) && role === "primary" && repoRoot
    ? repoRoot
    : path.join(home, "qubius");
  // 真实 Windows 环境里默认 localhost，本机使用不用再想一个域名；
  // 用隔离 HOME 的测试不设置 APPDATA/USERPROFILE，仍然得到空串。
  const windowsLocalHost = platform === "win32" && (nonEmpty(env.APPDATA) || nonEmpty(env.USERPROFILE))
    ? "localhost"
    : "";
  const form: DeployForm = {
    startPrimary: parseBool(pick("QUBIUS_START_PRIMARY", startPrimaryDefault), role !== "secondary"),
    startSecondary: parseBool(pick("QUBIUS_START_SECONDARY", startSecondaryDefault), role === "secondary"),
    clonePeer: parseBool(pick("QUBIUS_CLONE_PEER", "0"), false),
    pullLatest: parseBool(pick("QUBIUS_PULL_LATEST", "0"), false),
    primaryPort: parseIntOr(pick("QUBIUS_PRIMARY_PORT", "8787"), 8787),
    secondaryPort: parseIntOr(pick("QUBIUS_SECONDARY_PORT", "8788"), 8788),
    publicHost: pick("QUBIUS_PUBLIC_HOST", windowsLocalHost),
    publicHostSecondary: pick("QUBIUS_PUBLIC_HOST_SECONDARY", ""),
    lanHost: pick("QUBIUS_LAN_HOST", ""),
    configDir,
    primaryDir: resolveDir(configDir, pick("QUBIUS_PRIMARY_DIR", primaryDirDefault)),
    secondaryDir: resolveDir(configDir, pick("QUBIUS_SECONDARY_DIR", path.join(home, "co-qubius"))),
    dataPrimary: resolveDir(
      configDir,
      pick("QUBIUS_DATA_PRIMARY", path.join(defaultDataHome(env, platform), "qubius")),
    ),
    dataSecondary: resolveDir(
      configDir,
      pick("QUBIUS_DATA_SECONDARY", path.join(defaultDataHome(env, platform), "co-qubius")),
    ),
    primaryRepoUrl,
    secondaryRepoUrl: pick("QUBIUS_SECONDARY_REPO_URL", primaryRepoUrl),
    primaryRef: pick("QUBIUS_PRIMARY_REF", "main"),
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
    lanHost: requireString(record, "lanHost", "内网入口地址"),
    configDir: requireString(record, "configDir", "配置目录"),
    primaryDir: requireString(record, "primaryDir", "主实例目录"),
    secondaryDir: requireString(record, "secondaryDir", "副实例目录"),
    dataPrimary: requireString(record, "dataPrimary", "主实例数据目录"),
    dataSecondary: requireString(record, "dataSecondary", "副实例数据目录"),
    primaryRepoUrl: requireString(record, "primaryRepoUrl", "主实例仓库地址"),
    secondaryRepoUrl: requireString(record, "secondaryRepoUrl", "副实例仓库地址"),
    primaryRef: requireString(record, "primaryRef", "主实例分支"),
    archiveDir: requireString(record, "archiveDir", "归档目录"),
    archiveRetentionDays: requireInt(record, "archiveRetentionDays", "列表保留天数"),
    nodeBin: requireString(record, "nodeBin", "Node 路径"),
    projects: validateProjects(record.projects),
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

export interface ApplyDeployOptions {
  body: unknown;
  repoRoot: string;
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
  const configDir = deployConfigDir(env);
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
    return result;
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
}

export async function readDeployState(options: ReadDeployStateOptions): Promise<DeployState> {
  const { configDir, envFile, envSource, form, projectsError } = deriveDeployForm(
    options.env,
    options.role,
    options.repoRoot,
  );
  const configFile = path.join(
    configDir,
    options.role === "secondary" ? "config-secondary.yaml" : "config.yaml",
  );
  // 只有首次部署（没有配置文件）才需要这个提示，正常页面不必每次都查 git。
  const detectedRepoUrl = options.setupRequired === true
    ? detectRepoUrl(path.resolve(options.repoRoot))
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
    port: options.port,
    platform: process.platform,
    nodeVersion: process.version,
    form,
    instances: await probeInstances(form),
    job: readDeployJob(configDir),
    ...(projectsError ? { projectsError } : {}),
  };
}
