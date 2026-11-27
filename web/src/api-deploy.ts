/* 部署页用到的接口契约。服务端在 /api/deploy 下提供状态、提交和任务轮询。 */
import { request, type PermissionLevel } from "./api";

export type DeployPermission = PermissionLevel;

export interface DeployProject {
  id: string;
  name: string;
  path: string;
  permission: DeployPermission;
  /** 非 git 目录：每个对话使用独立子目录。 */
  isolated: boolean;
}

export interface DeployForm {
  startPrimary: boolean;
  startSecondary: boolean;
  clonePeer: boolean;
  /** 构建前从各 checkout 的远端（默认 origin）快进拉取当前分支。 */
  pullLatest: boolean;
  primaryPort: number;
  secondaryPort: number;
  publicHost: string;
  publicHostSecondary: string;
  /** 额外允许的 Host（逗号分隔）。 */
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
  /** off 关闭、auto 自动生成、custom 自定义。 */
  authMode: "off" | "auto" | "custom";
  /** custom 模式的新令牌；已保存时 GET 返回空串，authTokenSet 为 true。 */
  authToken: string;
  authTokenSet?: boolean;
  terminal: boolean;
  maxConcurrent: number;
  approvalTimeoutMinutes: number;
  /** 会话/请求上限；范围见 docs/reference.md。 */
  limits: {
    transcriptBytes: number;
    transcriptMessages: number;
    messageText: number;
    requestBodyBytes: number;
    historyPage: number;
  };
  /** 局域网 Basic 认证入口。 */
  lanEnabled: boolean;
  lanAuthUser: string;
  /** 留空表示沿用已保存的密码；首次启用时自动生成。 */
  lanAuthPassword: string;
  /** 服务端是否已有密码（GET 用）。 */
  lanAuthPasswordSet?: boolean;
  archiveDir: string;
  archiveRetentionDays: number;
  nodeBin: string;
  projects: DeployProject[];
  /** 数据目录变化且旧目录有会话时的二次确认。 */
  confirmDataDirChange?: boolean;
  /** 页面已确认部署可以先停止当前实例（Windows 部署任务据此跳过控制台提问）。 */
  confirmStopInstance?: boolean;
}

export interface DeployInstanceInfo {
  role: "primary" | "secondary";
  repoDir: string;
  dataDir: string;
  port: number;
  running: boolean;
  head?: string;
  /** 实例报告的版本号；旧版服务端没有。 */
  version?: string;
}

export interface DeployJob {
  jobId: string;
  state: "running" | "success" | "failed";
  step: string;
  message: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  logTail?: string;
}

/** 当前进程实际生效的配置摘要（部署页只读展示）。 */
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
  role: "primary" | "secondary";
}

export interface DeployState {
  setupRequired: boolean;
  repoDir: string;
  /** 首次部署时从当前 checkout 检测到的 origin（仅 http(s)），用于预填仓库地址。 */
  detectedRepoUrl?: string;
  configDir: string;
  configFile: string;
  envFile: string;
  /** envFile 的解析来源，与 deploy/lib.sh 的优先级一致。 */
  envSource: "QUBIUS_ENV" | "config-dir" | "repo" | "default";
  /** 显式配置的 GitHub 镜像（owner/repo，空串表示自动识别）；旧服务端没有这个字段。 */
  githubRepo?: string;
  role: "primary" | "secondary";
  /** 当前进程的配置摘要；旧服务端没有。 */
  current?: DeployCurrentConfig;
  /** 当前服务进程实际监听的端口，用来判断部署后本页面是否还能连上。 */
  port: number;
  /** 服务端运行的平台（如 win32、linux）；据此展示部署差异提示。 */
  platform: string;
  nodeVersion: string;
  form: DeployForm;
  instances: DeployInstanceInfo[];
  job: DeployJob | null;
  /** QUBIUS_PROJECTS_FILE 读取/解析失败时的说明；此时 form.projects 不可信。 */
  projectsError?: string;
}

export function getDeployState(signal?: AbortSignal): Promise<DeployState> {
  return request("/api/deploy", undefined, signal);
}

/** GitHub 公开镜像 main 分支的版本与当前运行版本的对照。 */
export interface GithubVersionState {
  repo?: string;
  version?: string;
  current?: string;
  status: "same" | "behind" | "ahead" | "unknown";
  checkedAt: string;
  error?: string;
}

export function getGithubVersion(signal?: AbortSignal): Promise<GithubVersionState> {
  return request("/api/deploy/github-version", undefined, signal);
}

/**
 * 保存 GitHub 镜像地址（owner/repo 或 GitHub URL；空串表示自动识别）。
 * 只改 env 里的这一个键，立即生效，不触发重新部署。
 */
export function saveGithubRepo(
  repo: string,
  signal?: AbortSignal,
): Promise<{ ok: true; repo: string }> {
  return request(
    "/api/deploy/github-repo",
    { method: "POST", body: JSON.stringify({ repo }) },
    signal,
  );
}

/** 局域网入口一次性信息：只在部署响应里出现，后续 GET 不含密码。 */
export interface DeployLanInfo {
  user: string;
  password: string;
  urls: string[];
}

export interface DeployOneTimeInfo {
  lan?: DeployLanInfo;
  /** 部署后生效的 API 访问令牌；未启用 auth 时省略。 */
  authToken?: string;
}

/** 提交部署表单；成功时服务端返回 202、后台任务 id，以及一次性凭据。 */
export function applyDeploy(
  form: DeployForm,
  signal?: AbortSignal,
): Promise<{ ok: true; jobId: string; oneTime?: DeployOneTimeInfo }> {
  return request("/api/deploy/apply", { method: "POST", body: JSON.stringify(form) }, signal);
}

export function getDeployStatus(signal?: AbortSignal): Promise<{ job: DeployJob | null }> {
  return request("/api/deploy/status", undefined, signal);
}

/**
 * 一键更新部署：服务端按当前已保存的配置重新部署，并在构建前从 GitHub
 * 远端快进拉取（没有 GitHub 远端时回落到 origin）。不需要提交表单。
 */
export function updateDeploy(
  signal?: AbortSignal,
  options: { confirmStopInstance?: boolean } = {},
): Promise<{ ok: true; jobId: string; oneTime?: DeployOneTimeInfo }> {
  return request(
    "/api/deploy/update",
    {
      method: "POST",
      body: JSON.stringify({ confirmStopInstance: options.confirmStopInstance === true }),
    },
    signal,
  );
}

/** 读取当前启用的 API 访问令牌；未启用时 404。 */
export function getConfigToken(signal?: AbortSignal): Promise<{
  token: string;
  source: "config" | "env" | "file";
  file?: string;
}> {
  return request("/api/config/token", undefined, signal);
}

export interface ResetLanResult {
  user: string;
  password: string;
  urls: string[];
  /** scheduled：响应发出后会自动重启局域网入口；none：当前未运行。 */
  restart: "scheduled" | "none";
  restartMethod: "systemd" | "process" | "none";
  restartNote: string;
}

/** 立即生成新局域网密码并写盘；返回一次性密码和重启状态。 */
export function resetLanPassword(
  user?: string,
  signal?: AbortSignal,
): Promise<{ ok: true; lan: ResetLanResult }> {
  return request(
    "/api/deploy/lan-credentials/reset",
    { method: "POST", body: JSON.stringify(user ? { user } : {}) },
    signal,
  );
}

export interface ResetAuthTokenResult {
  token: string;
  source: "config" | "env" | "file";
  file?: string;
  restartNeeded: false;
  note: string;
}

/** 立即生成新 API 令牌并切换到运行中的服务端；旧令牌短暂宽限。 */
export function resetAuthToken(signal?: AbortSignal): Promise<{ ok: true } & ResetAuthTokenResult> {
  return request("/api/deploy/auth-token/reset", { method: "POST", body: "{}" }, signal);
}

/** 409「数据目录变化且旧目录有会话」：前端弹二次确认后带 confirm 重试。 */
export function isDataDirChangeError(reason: unknown): reason is Error & {
  currentDataDir: string;
  targetDataDir: string;
  sessions: number;
} {
  return reason instanceof Error && (reason as { code?: unknown }).code === "data-dir-change";
}

/** 409「已有部署任务在运行」：前端应改为轮询现有任务，而不是留在 idle。 */
export function isDeployBusyError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  // 新服务端在错误体里带 code；优先按结构判断，兼容更精确。
  if ((reason as { code?: unknown }).code === "busy") return true;
  // 旧服务端只有中文文案，保留 fallback。
  return reason.message.includes("已有部署任务");
}

/**
 * 409 busy 的 kind：deploy（或缺失）表示部署任务，其它值（apply/restore/reclaim 等）
 * 说明占用锁的是公网入口任务，不能误去轮询部署状态。
 */
export function deployBusyKind(reason: unknown): string | undefined {
  if (!isDeployBusyError(reason)) return undefined;
  const kind = (reason as { kind?: unknown }).kind;
  return typeof kind === "string" && kind ? kind : undefined;
}

/** 409 residual：部署锁空闲，但仍有残留进程占用入口，需要先去公网入口面板回收。 */
export function isDeployResidualError(reason: unknown): boolean {
  return reason instanceof Error && (reason as { code?: unknown }).code === "residual";
}

/** residual 错误里服务端给出的残留进程列表。 */
export function deployResidualPids(reason: unknown): number[] {
  if (!isDeployResidualError(reason)) return [];
  const pids = (reason as { remainingPids?: unknown }).remainingPids;
  if (!Array.isArray(pids)) return [];
  return pids.filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid));
}
