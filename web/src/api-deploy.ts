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
  /** 构建前从各 checkout 的 origin 快进拉取当前分支。 */
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
  role: "primary" | "secondary";
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

/** 提交部署表单；成功时服务端返回 202 和一个后台任务 id。 */
export function applyDeploy(
  form: DeployForm,
  signal?: AbortSignal,
): Promise<{ ok: true; jobId: string }> {
  return request("/api/deploy/apply", { method: "POST", body: JSON.stringify(form) }, signal);
}

export function getDeployStatus(signal?: AbortSignal): Promise<{ job: DeployJob | null }> {
  return request("/api/deploy/status", undefined, signal);
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
