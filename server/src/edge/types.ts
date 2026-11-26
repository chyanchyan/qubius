import type { Role } from "../config.js";
import type { DeployForm } from "../deploy.js";

/**
 * edge 模块的公共类型。
 *
 * 这里只放纯数据结构和错误类型；读写文件/调用进程分别在 envfile、registry、
 * secrets、render、desired、opslock 里实现。上层 HTTP/API（D2）按这些类型
 * 组装请求和响应。
 */

/** edge 相关的可预期失败；HTTP 层可映射为 400/409。 */
export class EdgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeError";
  }
}

/** 带机器可读 code 的失败，例如 token 不匹配、残留进程阻塞。 */
export class EdgeCodeError extends EdgeError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EdgeCodeError";
    this.code = code;
  }
}

export type EdgeRole = Role;

/**
 * 部署页希望写进注册表的站点。
 *
 * edge 目前只管理 qubius / co-qubius 两个 dev 站点：dev 认证、开启 SSE。
 * 其它站点（prod、auth: none）只从注册表读取并渲染，不会被本类型表达。
 */
export interface EdgeSite {
  /** 与 web/src/api-edge.ts 的 EdgeSite 对齐。 */
  name: "qubius" | "co-qubius";
  domains: string[];
  env: "dev";
  upstream: string;
  auth: "dev";
  sse: true;
}

export type RegistrySiteEnv = "dev" | "prod";
export type RegistrySiteAuth = "none" | "dev";

/** 注册表里的 deploy 段（仅解析/保留，不在本单元执行部署）。 */
export interface RegistryDeploy {
  repo: string;
  composeFile: string;
  project: string;
  branch: string;
  healthUrl: string | null;
  healthTimeout: number;
  preBuild: string[][];
  postUp: string[][];
  extras?: Record<string, unknown>;
}

/** 注册表站点；未知键保存在 extras 里，写回时原样保留。 */
export interface RegistrySite {
  name: string;
  domains: string[];
  env: RegistrySiteEnv;
  upstream: string;
  auth: RegistrySiteAuth;
  sse: boolean;
  deploy?: RegistryDeploy;
  extras?: Record<string, unknown>;
}

export interface EdgeVpsConfig {
  ssh: string;
  sshKey: string;
  sshPort: number;
  tunnelBind: string;
  gatewayPort: number;
  caddyContainer: string;
  caddyfile: string;
  caddyfileContainer: string;
}

export interface EdgeLocalConfig {
  root: string;
  gatewayImage: string;
  gatewayContainer: string;
  tunnelService: string;
  tunnelUser: string;
  sshBin: string;
  stateFile: string;
}

export interface EdgeAuthDevConfig {
  username: string;
  cookieName: string;
  passwordHashEnv: string;
  cookieSecretEnv: string;
}

/** 完成校验后的 edgectl 注册表。 */
export interface EdgeRegistry {
  /** 注册表文件的绝对路径。 */
  source: string;
  version: 1;
  vps: EdgeVpsConfig;
  local: EdgeLocalConfig;
  authDev: EdgeAuthDevConfig;
  gitlabUrl: string | null;
  /** gitlab 段的原始键（未知键写回时保留）。 */
  gitlabRaw: Record<string, unknown>;
  sites: RegistrySite[];
  /** 顶层未建模键（写回时保留）。 */
  extras: Record<string, unknown>;
}

/** 从进程 env / .env 读到的 dev 认证密钥（不落盘明文）。 */
export interface EdgeSecrets {
  passwordHash: string;
  cookieSecret: string;
  /** sha256(canonicalJson([passwordHash, cookieSecret]))；用于状态比较。 */
  secretsSha: string;
  passwordHashSource: "process" | "envfile";
  cookieSecretSource: "process" | "envfile";
}

export type EdgeConfigSource =
  | "envfile-qubius"
  | "envfile-edgectl"
  | "process-qubius"
  | "process-edgectl"
  | null;

export type EdgeBinSource = "env" | "path" | "home" | null;

/** envfile.resolveEdgeEnv 的结果。 */
export interface EdgePaths {
  /** 规范化后的配置值；非法值时为 null（同时 errors 非空并 disabled）。 */
  provider: "auto" | "cli" | "native" | null;
  /**
   * 实际应使用的执行方式；disabled 时为 null。
   * cli 表示 binPath 存在且可执行，但版本握手由 D2 负责：真正渲染前应跑
   * `--version`，失败按错误上报，不能静默回退 native。
   */
  resolvedProvider: "cli" | "native" | null;
  /** 注册表绝对路径；未配置时为 null。 */
  configPath: string | null;
  configSource: EdgeConfigSource;
  /** edgectl CLI 绝对路径；找不到时为 null。 */
  binPath: string | null;
  binSource: EdgeBinSource;
  /** true 表示未配置或配置不可用，edge 功能关闭。 */
  disabled: boolean;
  /** 中文错误；disabled 时可能为空（未配置）或非空（配置损坏）。 */
  errors: string[];
}

/** desiredSites 的输出。 */
export interface EdgeDesired {
  sites: EdgeSite[];
  warnings: string[];
  /** 因 start=false 而没有生成 desired 的角色。注册表条目由上层保留。 */
  disabledRoles: EdgeRole[];
}

/** 后续 API 契约：/api/edge/plan 的输入。 */
export interface EdgePlanInput {
  role: EdgeRole;
  /** 缺省时由 deriveDeployForm 推导。 */
  form?: DeployForm;
  /** 是否把 desired 写回注册表；默认为 false（只预览）。 */
  apply?: boolean;
}

/** 后续 API 契约：警告集合。 */
export interface EdgeWarnings {
  warnings: string[];
  disabledRoles: EdgeRole[];
}

/** 后续 API 契约：edge 部署任务状态（对齐 web EdgeJob）。 */
export interface EdgeJobStatus {
  jobId: string;
  state: "running" | "success" | "failed";
  /** plan / apply / restore / reclaim（D2 写入 meta/状态时填）。 */
  kind?: string;
  step: string;
  message: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  logTail?: string;
  /** busy/residual 时附带的残留 pid。 */
  remainingPids?: number[];
}

/** upsertManagedSites 的返回值。 */
export interface EdgeUpsertResult {
  changed: boolean;
  /** 写回后的完整文本。 */
  text: string;
  /** 备份文件绝对路径（只有真正写入且原文件存在时才有）。 */
  backup?: string;
  /** 结构化、已脱敏的差异描述。 */
  diff: string;
}

/** ops-lock.sh / opslock.ts 的统一 JSON 结果。 */
export interface OpsLockResult {
  ok: boolean;
  /** busy / residual / token-mismatch / phrase-mismatch / corrupt 等。 */
  code: string;
  /** 仅 claim 成功时："pending"。 */
  state?: string;
  kind?: string;
  root?: string;
  jobId?: string;
  token?: string;
  remainingPids?: number[];
  /** claim busy 的原因：lock / pending。 */
  reason?: string;
  /** pending 宽限信息。 */
  ageSeconds?: number;
  graceSeconds?: number;
  /** status：missing / corrupt / complete。 */
  metaStatus?: string;
  /** mark 返回的 epoch 秒时间戳。 */
  startedAt?: number | null;
  finishedAt?: number | null;
  /** clear / force-reclaim 的结果标记。 */
  cleared?: boolean;
  forceReclaimed?: boolean;
  audit?: string;
  /** 可执行的后继操作提示。 */
  hint?: string;
  message?: string;
  /** 退出码；spawnSync 透传。 */
  exitCode?: number;
  /** status 的附加信息。 */
  lockFree?: boolean;
  metaState?: string;
  metaKind?: string;
  metaJobId?: string;
  metaToken?: string;
  metaPid?: number;
  metaAgeSeconds?: number;
  cleanedPids?: number[];
}

/** Node 侧 force reclaim 的审计记录（写进 <root>/edge.json）。 */
export interface OpsAuditEntry {
  root: string;
  token: string | null;
  jobId: string | null;
  /** 回收前观察到的残留 pid（initial）——成功时均已清理。 */
  remainingPids: number[];
  phrase: string;
  at: string;
}
