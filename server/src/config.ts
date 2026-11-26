import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { isPermission, type PermissionLevel } from "./permissions.js";
import { mergeProjectLists, readProjectsFile, resolveProjectsFile } from "./project-source.js";
import { normalizeWorktreeConfig } from "./worktree-prep.js";

/** 新 worktree 的准备工作：复制 gitignored 文件、链接共享目录、执行 setup。 */
export interface WorktreeConfig {
  /** 在 worktree 目录里执行的 shell 命令；不配置则不执行。 */
  setup?: string;
  /** setup 超时秒数，默认 300，范围 1..3600。 */
  setupTimeoutSeconds: number;
  /** 与主检出共享的 gitignored 目录，在 worktree 里建立链接。 */
  sharedDirectories: string[];
  /** 从主检出复制到 worktree 的 gitignored 文件/目录。 */
  include: string[];
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  permission: PermissionLevel;
  /** 非 git 目录下每个对话使用独立子目录，可并行；git 项目仍走 worktree。 */
  isolated: boolean;
  /** git 项目的 worktree 准备配置。 */
  worktree?: WorktreeConfig;
  /** 服务端内置项目（普通对话），不从配置文件读取。 */
  builtin?: boolean;
}

/** 内置「普通对话」项目的 id；页面顶部入口直接跳到这个项目。 */
export const CHAT_PROJECT_ID = "chat";
const CHAT_PROJECT_NAME = "普通对话";

export type Role = "primary" | "secondary";

/** 会话归档到机械盘；不配置时不会归档，也不会自动过期删除。 */
export interface ArchiveConfig {
  /** 归档根目录；实例内容放在 <dir>/<instance>/ 下。 */
  dir: string;
  /** 会话在 SSD 上保留的天数，超过后先归档再删除。 */
  retentionDays: number;
  /** 同一台机器上区分主/副实例的子目录名。 */
  instance: string;
}

export interface SecondaryConfig {
  primaryRepo: string;
  primaryRef: string;
  script: string;
  restart: string;
}

/** 会话/请求的内存与历史分页上限。 */
export interface LimitsConfig {
  /** 单个会话消息序列化后的总字节数（UTF-8）。 */
  transcriptBytes: number;
  /** 单个会话保留的消息条数。 */
  transcriptMessages: number;
  /** 单条消息正文的字符数。 */
  messageText: number;
  /** 单次 JSON 请求体的字节数。 */
  requestBodyBytes: number;
  /** 首帧/翻页时一次返回的历史消息条数。 */
  historyPage: number;
}

/**
 * 未配置 allowedHosts 时的默认白名单：只允许回环主机。
 * 这样即使忘了配置，DNS rebinding 也不能用外部域名接管本机服务；
 * 需要公网/局域网访问时必须显式配置 allowedHosts。
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

export const DEFAULT_LIMITS: LimitsConfig = {
  transcriptBytes: 8 * 1024 * 1024,
  transcriptMessages: 5_000,
  messageText: 200_000,
  requestBodyBytes: 28_000_000,
  historyPage: 200,
};

interface LimitRule {
  env: string;
  key: keyof LimitsConfig;
  min: number;
  max: number;
  unit: string;
}

/** 每项上限的合法区间与对应的环境变量。 */
const LIMIT_RULES: LimitRule[] = [
  { env: "QUBIUS_LIMIT_TRANSCRIPT_BYTES", key: "transcriptBytes", min: 64 * 1024, max: 64 * 1024 * 1024, unit: "字节" },
  { env: "QUBIUS_LIMIT_TRANSCRIPT_MESSAGES", key: "transcriptMessages", min: 50, max: 20_000, unit: "条" },
  { env: "QUBIUS_LIMIT_MESSAGE_TEXT", key: "messageText", min: 1024, max: 1024 * 1024, unit: "字符" },
  { env: "QUBIUS_LIMIT_REQUEST_BODY", key: "requestBodyBytes", min: 1024 * 1024, max: 64 * 1024 * 1024, unit: "字节" },
  { env: "QUBIUS_HISTORY_PAGE", key: "historyPage", min: 50, max: 2_000, unit: "条" },
];

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  maxConcurrent: number;
  /** 等待确认多久没人回应就自动拒绝，默认 10 分钟；0 表示不自动拒绝。测试夹具可以省略。 */
  approvalTimeoutMinutes?: number;
  projects: ProjectConfig[];
  /** config.yaml 自带的项目（含内置普通对话），不含额外项目文件；热加载时作为底稿。 */
  projectsBase?: ProjectConfig[];
  /** 额外项目文件；运行期新增的项目写在这里，文件变化会热加载。 */
  projectsFile?: string;
  configDir: string;
  role: Role;
  secondary?: SecondaryConfig;
  archive?: ArchiveConfig;
  /** 校验请求的 Host 头；未配置时使用 DEFAULT_ALLOWED_HOSTS（只允许回环主机）。 */
  allowedHosts?: string[];
  /** 启用 API 访问令牌；未配置时行为不变。 */
  auth?: boolean;
  /** 显式 API 访问令牌（至少 16 个字符）；不写且 auth=true 时自动生成到 dataDir/auth-token。 */
  authToken?: string;
  /** 浏览器命令行页；只有显式 false 才关闭（未写时开启）。 */
  terminal?: boolean;
  /** 会话/请求上限；未配置时使用 DEFAULT_LIMITS（旧测试夹具可以省略）。 */
  limits?: LimitsConfig;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`找不到配置文件 ${abs}`);
  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(abs, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "解析失败";
    throw new Error(`配置文件不是合法 YAML：${message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("配置文件必须是映射");
  const record = parsed as Record<string, unknown>;
  const listen = typeof record.listen === "string" ? record.listen : "127.0.0.1:8787";
  const { host, port } = parseListen(listen);
  const configDir = path.dirname(abs);
  const dataDir = path.resolve(
    configDir,
    typeof record.dataDir === "string" && record.dataDir.trim() ? record.dataDir : "./data",
  );
  const maxConcurrent = normalizeMax(record.maxConcurrent);
  const approvalTimeoutMinutes = normalizeApprovalTimeout(record.approvalTimeoutMinutes, env);
  const projects = normalizeProjects(record.projects, configDir);
  // 页面始终有一个「普通对话」入口；用户可以自己在 projects 里定义同 id 项目来覆盖。
  // 目录放在 dataDir 下，随 dataDir 一起创建和备份，不依赖额外配置。
  if (!projects.some((project) => project.id === CHAT_PROJECT_ID)) {
    projects.push({
      id: CHAT_PROJECT_ID,
      name: CHAT_PROJECT_NAME,
      path: path.join(dataDir, "chat"),
      permission: "acceptEdits",
      isolated: true,
      builtin: true,
    });
  }
  // 额外项目文件是运行期新增项目的落盘位置；config.yaml 里已写过的同 id 项目
  // 以文件为准，这样重启后不需要重新部署也能看到新项目。
  const projectsFile = resolveProjectsFile(configDir, bootstrapEnv(env, "QUBIUS_PROJECTS_FILE"));
  const extra = readProjectsFile(projectsFile, configDir);
  if (extra.error) {
    console.warn(`[projects] ${projectsFile}：${extra.error}；忽略额外项目，保留 config.yaml 里的项目`);
  }
  const role = normalizeRole(record.role);
  const secondary = normalizeSecondary(record.secondary, role, configDir);
  const archive = normalizeArchive(record.archive, configDir, role);
  const allowedHosts = normalizeAllowedHosts(record.allowedHosts, env);
  const auth = normalizeAuth(record.auth, env);
  const authToken = normalizeAuthToken(record.authToken, env);
  const terminal = normalizeTerminal(record.terminal, env);
  const limits = normalizeLimits(record.limits, env);
  return {
    host,
    port,
    dataDir,
    maxConcurrent,
    approvalTimeoutMinutes,
    projects: mergeProjectLists(projects, extra.projects),
    projectsBase: projects,
    projectsFile,
    configDir,
    role,
    secondary,
    archive,
    allowedHosts,
    auth,
    authToken,
    terminal,
    limits,
  };
}

/** 配置文件优先；没写时看 QUBIUS_TERMINAL（0 关闭、1 开启），都没有则开启。 */
function normalizeTerminal(value: unknown, env: NodeJS.ProcessEnv): boolean {
  if (value !== undefined) {
    if (typeof value !== "boolean") throw new Error("terminal 必须是 true 或 false");
    return value;
  }
  const fromEnv = bootstrapEnv(env, "QUBIUS_TERMINAL");
  if (fromEnv === undefined) return true;
  if (fromEnv === "0") return false;
  if (fromEnv === "1") return true;
  throw new Error("QUBIUS_TERMINAL 只能是 0 或 1");
}

function normalizeAuth(value: unknown, env: NodeJS.ProcessEnv): boolean | undefined {
  if (value !== undefined) {
    if (typeof value !== "boolean") throw new Error("auth 必须是 true 或 false");
    return value;
  }
  // 与 envFlag 等价：QUBIUS_AUTH=1（或旧变量 REMOTE_CODER_AUTH=1）时启用；
  // 显式 QUBIUS_AUTH=0 表示关闭（部署向导「关闭访问令牌」会写这个值）。
  const fromEnv = bootstrapEnv(env, "QUBIUS_AUTH");
  if (fromEnv === "1") return true;
  if (fromEnv === "0") return false;
  return undefined;
}

function normalizeAuthToken(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (value !== undefined) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("authToken 必须是非空字符串");
    }
    return value.trim();
  }
  const fromEnv = bootstrapEnv(env, "QUBIUS_AUTH_TOKEN");
  return fromEnv?.trim() || undefined;
}

function normalizeLimits(value: unknown, env: NodeJS.ProcessEnv): LimitsConfig {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error("limits 必须是映射");
  }
  const record = (value ?? {}) as Record<string, unknown>;
  const result = { ...DEFAULT_LIMITS };
  for (const rule of LIMIT_RULES) {
    const fromEnv = bootstrapEnv(env, rule.env);
    if (fromEnv !== undefined) {
      const parsed = Number(fromEnv);
      if (!Number.isInteger(parsed) || parsed < rule.min || parsed > rule.max) {
        throw new Error(
          `${rule.env}（limits.${rule.key}）必须是 ${rule.min} 到 ${rule.max} 的整数${rule.unit ? `（${rule.unit}）` : ""}`,
        );
      }
      result[rule.key] = parsed;
      continue;
    }
    const raw = record[rule.key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < rule.min || raw > rule.max) {
      throw new Error(
        `limits.${rule.key} 必须是 ${rule.min} 到 ${rule.max} 的整数${rule.unit ? `（${rule.unit}）` : ""}`,
      );
    }
    result[rule.key] = raw;
  }
  return result;
}

/**
 * 部署 env 里的额外主机：QUBIUS_ALLOWED_HOSTS（逗号或空白分隔）。
 * 公网域名由部署模板直接写进 config.yaml 的 allowedHosts，不在这里重复追加，
 * 免得 manual start 时把部署脚本的占位默认值（code.example.com）也放进来。
 * 额外域名不走 config.yaml，是因为部署页每次会重新渲染它，手工加的会被覆盖。
 */
function extraHostsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = bootstrapEnv(env, "QUBIUS_ALLOWED_HOSTS");
  if (!raw) return [];
  const hosts: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const host = part.trim();
    if (host) hosts.push(host);
  }
  return hosts;
}

function normalizeHosts(items: unknown[], label: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${label}[${index}] 必须是非空字符串`);
    }
    let host = item.trim().toLowerCase();
    // 统一的 IPv6 写法：不带方括号的裸地址包上 []，便于和 Host 头匹配。
    if (host.includes(":") && !host.startsWith("[") && !/^[^:]+:\d+$/.test(host)) {
      host = `[${host}]`;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

function normalizeAllowedHosts(value: unknown, env: NodeJS.ProcessEnv): string[] {
  const fromEnv = extraHostsFromEnv(env);
  // 未配置时默认只允许回环主机；env 里的额外域名（部署页的访问域名）追加在后面。
  if (value === undefined) {
    return normalizeHosts([...DEFAULT_ALLOWED_HOSTS, ...fromEnv], "QUBIUS_ALLOWED_HOSTS");
  }
  if (!Array.isArray(value)) throw new Error("allowedHosts 必须是字符串数组");
  if (value.length === 0) throw new Error("allowedHosts 不能为空数组；删除该字段则默认只允许回环主机");
  // 显式数组仍作为基础列表；env 追加的域名同样生效，避免部署后丢失。
  return normalizeHosts([...value, ...fromEnv], "allowedHosts");
}

function normalizeArchive(
  value: unknown,
  configDir: string,
  role: Role,
): ArchiveConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("archive 必须是映射");
  }
  const record = value as Record<string, unknown>;
  const rawDir = typeof record.dir === "string" ? record.dir.trim() : "";
  if (!rawDir) throw new Error("archive.dir 不能为空");
  const dir = path.resolve(configDir, rawDir);
  const rawDays = record.retentionDays === undefined ? 30 : record.retentionDays;
  if (typeof rawDays !== "number" || !Number.isInteger(rawDays) || rawDays < 1 || rawDays > 3650) {
    throw new Error("archive.retentionDays 必须是 1 到 3650 的整数");
  }
  const defaultInstance = role === "secondary" ? "bak" : "main";
  const rawInstance = record.instance === undefined ? defaultInstance : record.instance;
  if (typeof rawInstance !== "string") {
    throw new Error("archive.instance 必须是字符串");
  }
  const instance = rawInstance.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(instance) || instance === "." || instance === "..") {
    throw new Error("archive.instance 只能使用 1 到 64 个字母、数字、点、下划线或连字符");
  }
  return { dir, retentionDays: rawDays, instance };
}

function normalizeRole(value: unknown): Role {
  if (value === undefined) return "primary";
  if (value === "primary" || value === "secondary") return value;
  throw new Error("role 必须是 primary 或 secondary");
}

function normalizeSecondary(value: unknown, role: Role, configDir: string): SecondaryConfig | undefined {
  if (role !== "secondary") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("role 为 secondary 时必须配置 secondary.primaryRepo");
  }
  const record = value as Record<string, unknown>;
  const primaryRepo = typeof record.primaryRepo === "string" ? record.primaryRepo.trim() : "";
  if (!primaryRepo) throw new Error("secondary.primaryRepo 不能为空");
  const primaryRef = typeof record.primaryRef === "string" && record.primaryRef.trim()
    ? record.primaryRef.trim()
    : "main";
  const script = typeof record.script === "string" && record.script.trim()
    ? path.resolve(configDir, record.script.trim())
    : path.join(configDir, "secondary.sh");
  const restart = typeof record.restart === "string" && record.restart.trim()
    ? path.resolve(configDir, record.restart.trim())
    : path.join(configDir, "run.sh");
  return { primaryRepo: path.resolve(configDir, primaryRepo), primaryRef, script, restart };
}

export function parseListen(listen: string): { host: string; port: number } {
  const match = listen.trim().match(/^(.*):(\d+)$/);
  if (!match) throw new Error(`listen 必须是 host:port，收到 ${listen}`);
  const host = match[1] ?? "";
  const port = Number(match[2]);
  if (!LOOPBACK.has(host)) {
    throw new Error(`listen 只能绑定 127.0.0.1 或 localhost，收到 ${host}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口无效：${match[2]}`);
  }
  return { host: "127.0.0.1", port };
}

function normalizeMax(value: unknown): number {
  if (value === undefined) return 4;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 256) {
    throw new Error("maxConcurrent 必须是 1 到 256 的整数");
  }
  return value;
}

function normalizeApprovalTimeout(value: unknown, env: NodeJS.ProcessEnv = process.env): number {
  if (value === undefined) {
    // 部署向导把值写进 env，config.yaml 里没写时也生效。
    const fromEnv = bootstrapEnv(env, "QUBIUS_APPROVAL_TIMEOUT_MINUTES");
    if (fromEnv === undefined) return 10;
    const parsed = Number(fromEnv);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1440) {
      throw new Error("QUBIUS_APPROVAL_TIMEOUT_MINUTES 必须是 0 到 1440 的整数（0 表示不自动拒绝）");
    }
    return parsed;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1440) {
    throw new Error("approvalTimeoutMinutes 必须是 0 到 1440 的整数（0 表示不自动拒绝）");
  }
  return value;
}

/** 读取 bootstrap 变量：QUBIUS_* 优先，旧名 REMOTE_CODER_* 兼容；空串视为未设置。 */
function bootstrapEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value !== undefined && value !== "") return value;
  if (name.startsWith("QUBIUS_")) {
    const legacy = env[`REMOTE_CODER_${name.slice("QUBIUS_".length)}`];
    if (legacy !== undefined && legacy !== "") return legacy;
  }
  return undefined;
}

function bootstrapPort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = bootstrapEnv(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function bootstrapMaxConcurrent(env: NodeJS.ProcessEnv): number {
  const raw = bootstrapEnv(env, "QUBIUS_MAX_CONCURRENT");
  if (raw === undefined) return 4;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 256 ? parsed : 4;
}

/**
 * 冷启动配置：config.yaml 还不存在时仍能启动服务（内置普通对话可用），
 * 并让部署页可以写配置后重启。不修改 loadConfig 的行为。
 */
export function bootstrapConfig(
  file: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const abs = path.resolve(file);
  const configDir = path.dirname(abs);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const role: Role = bootstrapEnv(env, "QUBIUS_SECONDARY") === "1" ? "secondary" : "primary";
  const port = role === "secondary"
    ? bootstrapPort(env, "QUBIUS_SECONDARY_PORT", 8788)
    : bootstrapPort(env, "QUBIUS_PRIMARY_PORT", 8787);
  // 冷启动默认数据目录与配置目录一致：<checkout>/.qubius/data。
  // 这样 quickstart、部署页和服务端不会各自算出不同的目录，会话也不会“重新部署后消失”。
  const defaultDataDir = path.join(repoRoot, ".qubius", "data");
  const dataDir = path.resolve(
    role === "secondary"
      ? bootstrapEnv(env, "QUBIUS_DATA_SECONDARY") ?? defaultDataDir
      : bootstrapEnv(env, "QUBIUS_DATA_PRIMARY") ?? defaultDataDir,
  );
  const maxConcurrent = bootstrapMaxConcurrent(env);
  // 与 loadConfig 保持一致：页面始终有「普通对话」入口。
  const projects: ProjectConfig[] = [{
    id: CHAT_PROJECT_ID,
    name: CHAT_PROJECT_NAME,
    path: path.join(dataDir, "chat"),
    permission: "acceptEdits",
    isolated: true,
    builtin: true,
  }];
  const projectsFile = resolveProjectsFile(configDir, bootstrapEnv(env, "QUBIUS_PROJECTS_FILE"));
  const extra = readProjectsFile(projectsFile, configDir);
  if (extra.error) {
    console.warn(`[projects] ${projectsFile}：${extra.error}；忽略额外项目`);
  }
  const secondary = role === "secondary"
    ? {
      primaryRepo: path.resolve(bootstrapEnv(env, "QUBIUS_PRIMARY_DIR") ?? path.join(home, "qubius")),
      primaryRef: bootstrapEnv(env, "QUBIUS_PRIMARY_REF") ?? "main",
      script: path.join(repoRoot, "deploy", "secondary.sh"),
      restart: path.join(repoRoot, "deploy", "run.sh"),
    }
    : undefined;
  return {
    host: "127.0.0.1",
    port,
    dataDir,
    maxConcurrent,
    approvalTimeoutMinutes: 10,
    projects: mergeProjectLists(projects, extra.projects),
    projectsBase: projects,
    projectsFile,
    configDir,
    role,
    secondary,
    archive: undefined,
    allowedHosts: normalizeAllowedHosts(undefined, env),
    auth: bootstrapEnv(env, "QUBIUS_AUTH") === "1" ? true : undefined,
    authToken: bootstrapEnv(env, "QUBIUS_AUTH_TOKEN")?.trim() || undefined,
    terminal: normalizeTerminal(undefined, env),
    limits: normalizeLimits(undefined, env),
  };
}

function normalizeProjects(value: unknown, configDir: string): ProjectConfig[] {
  // 可以不配置项目：页面仍有内置的「普通对话」。
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("projects 必须是数组");
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`projects[${index}] 必须是映射`);
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const projectPath = typeof record.path === "string" ? record.path.trim() : "";
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
      throw new Error(`projects[${index}].id 只能用小写字母、数字和连字符`);
    }
    if (seen.has(id)) throw new Error(`项目 id 重复：${id}`);
    seen.add(id);
    if (!name) throw new Error(`projects[${index}].name 不能为空`);
    if (!projectPath) throw new Error(`projects[${index}].path 不能为空`);
    const permission = record.permission === undefined ? "acceptEdits" : record.permission;
    if (!isPermission(permission)) {
      throw new Error(`projects[${index}].permission 必须是 default、acceptEdits、plan、auto 或 bypassPermissions`);
    }
    const isolated = record.isolated === undefined ? false : record.isolated;
    if (typeof isolated !== "boolean") {
      throw new Error(`projects[${index}].isolated 必须是 true 或 false`);
    }
    const worktree = normalizeWorktreeConfig(record.worktree, `projects[${index}].worktree`);
    return {
      id,
      name,
      path: path.resolve(configDir, projectPath),
      permission,
      isolated,
      ...(worktree ? { worktree } : {}),
    };
  });
}
