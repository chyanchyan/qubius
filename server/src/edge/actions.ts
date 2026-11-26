import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { deployConfigDir, deriveDeployForm, readDeployJob } from "../deploy.js";
import { jobTimestamp } from "../job-state.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  applyVps,
  cliVersion,
  redactText,
  validateConfig,
  type CommandRunner,
} from "./cli.js";
import { desiredSites } from "./desired.js";
import { resolveEdgeEnv } from "./envfile.js";
import {
  applyNative,
  reloadOnly,
  type NativeApplyResult,
} from "./native-apply.js";
import {
  defaultPlanRunner,
  defaultSpawnJob,
  deleteEdgeRequest,
  writeEdgeRequest,
  type EdgeJobRequest,
  type PlanRunner,
  type SpawnJobFn,
} from "./job-runner.js";
import {
  claim,
  cleanup,
  forceReclaim,
  opsDaemonEnv,
  opsJobEnv,
  status as opsStatus,
  clear as opsClear,
  writeOpsMeta,
  type OpsCallOptions,
  type OpsClaimOptions,
  type OpsCleanupOptions,
  type OpsForceReclaimOptions,
} from "./opslock.js";
import {
  computePlanHash,
  deletePlan,
  edgeEnvSnapshot,
  readPlan,
  verifyPlan,
  type StoredEdgePlan,
} from "./plan.js";
import { NATIVE_RENDER_VERSION, type ProviderKind } from "./provider.js";
import { parseRegistryText, readRegistry } from "./registry.js";
import {
  caddyReload,
  caddyValidateCandidate,
  caddyValidateLive,
  caddyVersion,
  readRemoteFile,
  writeRemoteFileInPlace,
} from "./remote.js";
import { renderVpsBlock, spliceManaged } from "./render.js";
import { loadEdgeSecrets } from "./secrets.js";
import {
  appendEdgeLog,
  isoNow,
  readEdgeJobWithLog,
  readEdgeState,
  updateEdgeState,
  writeEdgeJob,
  type EdgeJob,
} from "./state.js";
import {
  EdgeError,
  type EdgePaths,
  type EdgeRole,
  type EdgeRegistry,
  type EdgeSecrets,
  type EdgeSite,
  type OpsLockResult,
} from "./types.js";

/**
 * edge 的 HTTP 动作层：GET 视图、plan、apply、restore、reclaim，以及 detached
 * edge 作业的执行逻辑（edge-job.ts 只做入口/异常兜底）。
 *
 * 所有依赖（opslock、ssh/docker、edgectl runner、spawn、plan 子进程）都可注入，
 * 测试用假实现；生产走默认导出。
 */

export type EdgeErrorCode = "busy" | "stale" | "residual" | "conflict";

/** HTTP 层可直接映射的失败：status + 机器可读 code/kind/remainingPids/jobId。 */
export class EdgeActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extras: {
      code?: EdgeErrorCode;
      kind?: string;
      remainingPids?: number[];
      jobId?: string;
    } = {},
  ) {
    super(message);
    this.name = "EdgeActionError";
  }
}

export interface EdgeOpsFns {
  claim: (options: OpsClaimOptions) => OpsLockResult;
  status: (root: string, options?: OpsCallOptions) => OpsLockResult;
  clear: (root: string, token?: string, options?: OpsCallOptions) => OpsLockResult;
  cleanup: (root: string, options?: OpsCleanupOptions) => OpsLockResult;
  forceReclaim: (
    root: string,
    phrase: string,
    options?: OpsForceReclaimOptions,
  ) => OpsLockResult;
}

export interface EdgeRemoteFns {
  readRemoteFile: typeof readRemoteFile;
  caddyVersion: typeof caddyVersion;
  caddyValidateCandidate: typeof caddyValidateCandidate;
  caddyValidateLive: typeof caddyValidateLive;
  caddyReload: typeof caddyReload;
  writeRemoteFileInPlace: typeof writeRemoteFileInPlace;
}

export interface EdgeActionDeps {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  role?: EdgeRole;
  /** 覆盖 deployConfigDir（测试用）。 */
  configDir?: string;
  /** 覆盖 resolveEdgeEnv（测试用）。 */
  paths?: EdgePaths;
  now?: () => Date;
  randomId?: () => string;
  ops?: Partial<EdgeOpsFns>;
  remote?: Partial<EdgeRemoteFns>;
  spawnJob?: SpawnJobFn;
  planRunner?: PlanRunner;
  /** plan 子进程预算（毫秒）；默认 QUBIUS_EDGE_PLAN_TIMEOUT_MS 或 90s。 */
  planTimeoutMs?: number;
  /** 注入 D4 native apply / reload（测试用）。 */
  nativeApplyFn?: typeof applyNative;
  reloadOnlyFn?: typeof reloadOnly;
  runner?: CommandRunner;
  readRegistryFn?: (configPath: string) => EdgeRegistry;
  loadSecretsFn?: typeof loadEdgeSecrets;
  isAlive?: (pid: number | null) => boolean;
}

export interface EdgeProviderView {
  /** disabled 时为 null（不伪装成 native）。 */
  resolved: "cli" | "native" | null;
  source: string;
  available: boolean;
  reason?: string;
}

/** edge.json 记录的上一次失败，供页面预填 restore 表单。 */
export interface EdgeLastFailure {
  jobId: string;
  /** 当前远端 Caddyfile 的 sha（restore 的 remoteSha）。 */
  remoteSha?: string;
  /** 本工具生成的本地备份文件名（basename）。 */
  backup?: string;
  /** 失败时保存的 unknown 快照文件名（basename）。 */
  unknown?: string;
  /** 服务器计算的备份内容 sha。 */
  backupSha?: string;
  at?: string;
}

export interface EdgeRegistryView {
  name: string;
  sha?: string;
  drift: boolean;
  error?: string;
}

export interface EdgeView {
  enabled: boolean;
  hint?: string;
  provider: EdgeProviderView;
  registry: EdgeRegistryView;
  desired: EdgeSite[];
  appBusy?: "deploy" | "edge" | null;
  lastJob?: EdgeJob | null;
  lastFailure?: EdgeLastFailure | null;
  canPlan: boolean;
  planHint?: string;
}

export interface EdgePlanView {
  planHash: string;
  provider: ProviderKind;
  desired: EdgeSite[];
  registryDiff: string;
  remoteDiff: string;
  warnings: string[];
  requiresConfirmExisting: boolean;
  requiresForceReclaim: boolean;
  /** false 表示存在硬阻断/远端不可用，前端应禁用「应用入口」。 */
  appliable: boolean;
  remoteUnavailable?: string;
}

interface RouteContext {
  env: NodeJS.ProcessEnv;
  role: EdgeRole;
  configDir: string;
  paths: EdgePaths;
  /** 已知的仓库根目录；用于解析 <repo>/deploy/env。 */
  repoRoot: string;
}

const SAFE_BASENAME_RE = /^(?!\.{1,2}$)(?!.*[/\\\x00-\x1f\x7f])[^\s/\\]+$/;

/** 与 web/src/api-edge.ts 的 isSafeBasename 对齐的本地白名单。 */
export function isSafeBasename(name: string): boolean {
  if (!name || name !== name.trim()) return false;
  if (name === "." || name === "..") return false;
  return SAFE_BASENAME_RE.test(name) && path.basename(name) === name;
}

const EDGE_BACKUP_NAME_RE = /^edge-(?:backup|unknown)-[A-Za-z0-9._-]+\.Caddyfile$/;

/** restore 只接受本工具生成的备份/快照文件名（basename 白名单）。 */
export function isAllowedEdgeBackupName(name: string): boolean {
  return isSafeBasename(name) && EDGE_BACKUP_NAME_RE.test(name);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ctxOf(deps: EdgeActionDeps): RouteContext {
  const env = deps.env ?? process.env;
  const role = deps.role ?? "primary";
  const configDir = deps.configDir ? path.resolve(deps.configDir) : deployConfigDir(env);
  const paths = deps.paths ?? resolveEdgeEnv(env);
  return { env, role, configDir, paths, repoRoot: deps.repoRoot };
}

function opsOf(deps: EdgeActionDeps): EdgeOpsFns {
  return {
    claim: deps.ops?.claim ?? claim,
    status: deps.ops?.status ?? opsStatus,
    clear: deps.ops?.clear ?? opsClear,
    cleanup: deps.ops?.cleanup ?? cleanup,
    forceReclaim: deps.ops?.forceReclaim ?? forceReclaim,
  };
}

function remoteOf(deps: EdgeActionDeps): EdgeRemoteFns {
  return {
    readRemoteFile: deps.remote?.readRemoteFile ?? readRemoteFile,
    caddyVersion: deps.remote?.caddyVersion ?? caddyVersion,
    caddyValidateCandidate: deps.remote?.caddyValidateCandidate ?? caddyValidateCandidate,
    caddyValidateLive: deps.remote?.caddyValidateLive ?? caddyValidateLive,
    caddyReload: deps.remote?.caddyReload ?? caddyReload,
    writeRemoteFileInPlace: deps.remote?.writeRemoteFileInPlace ?? writeRemoteFileInPlace,
  };
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

/**
 * claim 失败映射。优先识别 pending claim（宽限期内）：此时 ops-lock 可能先
 * 扫到正在启动的 job 而返回 residual，不能把它误报为残留；统一映射 busy。
 */
function claimFailure(
  ops: EdgeOpsFns,
  configDir: string,
  result: OpsLockResult,
  action: string,
): EdgeActionError {
  if (result.code !== "busy" && result.code !== "residual") {
    return claimError(result, action);
  }
  let current: OpsLockResult | undefined;
  try {
    current = ops.status(configDir, { cacheMs: 1000 });
  } catch {
    current = undefined;
  }
  const pendingClaim =
    current !== undefined &&
    current.metaStatus === "complete" &&
    current.metaState === "pending" &&
    (current.metaAgeSeconds ?? 0) < 120;
  if (pendingClaim) {
    const kind =
      current!.metaKind && current!.metaKind !== "unknown"
        ? current!.metaKind
        : result.kind && result.kind !== "unknown"
          ? result.kind
          : undefined;
    return new EdgeActionError(409, `有${kind ? ` ${kind} ` : ""}任务正在启动，请稍后再试。`, {
      code: "busy",
      ...(kind ? { kind } : {}),
    });
  }
  const fallbackKind =
    current?.metaKind && current.metaKind !== "unknown" ? current.metaKind : undefined;
  return claimError(result, action, fallbackKind);
}

function disabledError(paths: EdgePaths): EdgeActionError {
  return new EdgeActionError(
    400,
    `公网入口未启用：${paths.errors.join("；") || "未配置 edgectl 配置路径"}`,
  );
}

function expectedConfirmDomains(ctx: RouteContext, plan?: StoredEdgePlan): string[] {
  const domains = new Set<string>();
  try {
    const form = deriveDeployForm(ctx.env, ctx.role, ctx.repoRoot).form;
    // primary 与 secondary 的公网域名都允许确认（只启动 co-qubius 时也能操作）。
    for (const host of [form.publicHost, form.publicHostSecondary]) {
      const value = host.trim();
      if (value) domains.add(normalizeDomainSafe(value));
    }
  } catch {
    // 表单不可用时只用计划里的 desired。
  }
  if (plan) {
    for (const site of plan.desired) {
      for (const domain of site.domains) domains.add(domain);
    }
  }
  domains.delete("");
  return [...domains];
}

function normalizeDomainSafe(value: string): string {
  try {
    // 与 registry.normalizeDomain 保持一致的最小处理：去 scheme/端口/末尾点。
    return value
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "")
      .replace(/\.+$/, "");
  } catch {
    return "";
  }
}

function recordValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** 在 edge.json 顶层记录 provider / planHash（保留其它键，例如 forceReclaims）。 */
function recordPlanFingerprint(configDir: string, plan: StoredEdgePlan): void {
  try {
    updateEdgeState(configDir, (state) => {
      state.provider = plan.provider;
      state.planHash = plan.planHash;
      return state;
    });
  } catch {
    // 指纹只是审计信息，写入失败不影响 apply。
  }
}

function requireString(body: unknown, key: string): string {
  const value = recordValue(body, key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new EdgeActionError(400, `缺少 ${key}`);
  }
  return value.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 返回前端前的路径脱敏：configDir → <configDir>，注册表 → basename，
 * HOME 下的绝对路径 → basename。
 */
function redactPaths(
  value: string,
  ctx: RouteContext,
  registryPath?: string | null,
): string {
  let text = value;
  if (ctx.configDir) text = text.split(ctx.configDir).join("<configDir>");
  if (registryPath) {
    text = text.split(registryPath).join(path.basename(registryPath));
  }
  const home = (ctx.env.HOME ?? "").trim();
  if (home && home !== "/") {
    const re = new RegExp(`${escapeRegExp(home)}[^\\s"';|&<>()\\[\\]{}]*`, "g");
    text = text.replace(re, (match) =>
      match === home ? "<home>" : path.basename(match),
    );
  }
  // 兜底：configPath 未配置或路径不在 HOME/configDir 下时，仍把绝对路径降为 basename。
  text = text.replace(
    /(^|[\s"'(=,;:：])((?:\/[A-Za-z0-9._~%+-]+)+)(?=$|[\s"'),;:：])/g,
    (match, prefix: string, absolute: string) =>
      prefix + path.basename(absolute),
  );
  return text;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

function fileStamp(file: string): FileStamp | null {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * GET /api/edge 与 /api/edge/status 会高频轮询。注册表 YAML 与 .env 的解析
 * 结果按文件 (mtimeMs, size) 缓存；文件不变时不再重复 parse YAML / 读 .env。
 * 注入的 readRegistryFn/loadSecretsFn 走原路径，不参与缓存。
 */
const viewRegistryCache = new Map<string, { stamp: FileStamp; registry: EdgeRegistry }>();
const viewSecretsCache = new Map<string, { key: string; secrets: EdgeSecrets }>();

function readViewRegistry(deps: EdgeActionDeps, configPath: string): EdgeRegistry {
  if (deps.readRegistryFn) return deps.readRegistryFn(configPath);
  const stamp = fileStamp(configPath);
  const cached = viewRegistryCache.get(configPath);
  if (stamp && cached && sameStamp(cached.stamp, stamp)) return cached.registry;
  const registry = readRegistry(configPath);
  if (stamp) viewRegistryCache.set(configPath, { stamp, registry });
  return registry;
}

function loadViewSecrets(deps: EdgeActionDeps, ctx: RouteContext): EdgeSecrets | undefined {
  if (!ctx.paths.configPath) return undefined;
  try {
    const registry = readViewRegistry(deps, ctx.paths.configPath);
    if (deps.loadSecretsFn) return deps.loadSecretsFn({ registry, env: ctx.env });
    const env = ctx.env ?? process.env;
    const envFile = path.join(path.dirname(registry.source), ".env");
    // 密钥只取决于 registry 的变量名、相关进程环境值，以及两个文件的内容。
    const key = JSON.stringify([
      registry.authDev.passwordHashEnv,
      registry.authDev.cookieSecretEnv,
      env[registry.authDev.passwordHashEnv] ?? null,
      env[registry.authDev.cookieSecretEnv] ?? null,
      fileStamp(ctx.paths.configPath),
      fileStamp(envFile),
    ]);
    const cached = viewSecretsCache.get(ctx.paths.configPath);
    if (cached && cached.key === key) return cached.secrets;
    const secrets = loadEdgeSecrets({ registry, env: ctx.env });
    viewSecretsCache.set(ctx.paths.configPath, { key, secrets });
    return secrets;
  } catch {
    return undefined;
  }
}

function recordLastFailure(configDir: string, failure: EdgeLastFailure): void {
  try {
    updateEdgeState(configDir, (state) => {
      state.lastFailure = { ...failure, at: failure.at ?? isoNow() };
      return state;
    });
  } catch {
    // 预填信息写不了不影响作业结果。
  }
}

function clearLastFailure(configDir: string): void {
  try {
    updateEdgeState(configDir, (state) => {
      delete state.lastFailure;
      return state;
    });
  } catch {
    // ignore
  }
}

function readLastFailure(configDir: string): EdgeLastFailure | null {
  const state = readEdgeState(configDir);
  const raw = state?.lastFailure;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.jobId !== "string") return null;
  const pick = (key: string): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  // 引用的文件已被清理时不再返回失效字段，避免前端预填不存在的文件。
  const backup = pick("backup") ? path.basename(pick("backup")!) : undefined;
  const backupExists = backup ? fs.existsSync(path.join(configDir, backup)) : false;
  const unknown = pick("unknown") ? path.basename(pick("unknown")!) : undefined;
  const unknownExists = unknown ? fs.existsSync(path.join(configDir, unknown)) : false;
  return {
    jobId: record.jobId,
    ...(pick("remoteSha") ? { remoteSha: pick("remoteSha") } : {}),
    ...(backup && backupExists ? { backup } : {}),
    ...(unknown && unknownExists ? { unknown } : {}),
    ...(backupExists && pick("backupSha") ? { backupSha: pick("backupSha") } : {}),
    ...(pick("at") ? { at: pick("at") } : {}),
  };
}

function sanitizeJob(
  job: EdgeJob,
  ctx: RouteContext,
  registryPath: string | null | undefined,
): EdgeJob {
  return {
    ...job,
    step: redactPaths(job.step, ctx, registryPath),
    message: redactPaths(job.message, ctx, registryPath),
    ...(job.logTail === undefined
      ? {}
      : { logTail: redactPaths(job.logTail, ctx, registryPath) }),
  };
}

function markJobInterrupted(
  ctx: RouteContext,
  job: EdgeJob,
  secrets: EdgeSecrets | undefined,
  message: string,
  now?: Date,
): EdgeJob {
  const next: EdgeJob = {
    ...job,
    state: "failed",
    step: job.step || "prepare",
    message,
    pid: null,
    finishedAt: jobTimestamp(now ?? new Date()),
  };
  try {
    writeEdgeJob(ctx.configDir, next, secrets ?? null);
  } catch {
    // 状态写不了仍返回归一化后的视图。
  }
  return next;
}

/** HTTP 错误信息返回前统一做路径脱敏（避免探测 configDir/注册表绝对路径）。 */
export function redactApiText(deps: EdgeActionDeps, text: string): string {
  try {
    const ctx = ctxOf(deps);
    let out = text;
    // 先替换已知根路径，避免被兜底 basename 规则拆散。
    if (deps.repoRoot) out = out.split(deps.repoRoot).join("<repoRoot>");
    const lockScript = (ctx.env.QUBIUS_OPS_LOCK_SCRIPT ?? "").trim();
    if (lockScript) out = out.split(lockScript).join(path.basename(lockScript));
    return redactPaths(out, ctx, ctx.paths.configPath);
  } catch {
    return text;
  }
}

/**
 * 供 GET /api/edge 与 /status 使用：读取作业 + 日志尾，归一化异常退出，
 * 并做路径脱敏。running 但没有存活的 pid/锁时视为失败，避免永久转圈。
 */
export function readEdgeJobForApi(deps: EdgeActionDeps): EdgeJob | null {
  const ctx = ctxOf(deps);
  const secrets = loadViewSecrets(deps, ctx);
  let job = readEdgeJobWithLog(ctx.configDir, { secrets });
  if (!job) return null;

  if (job.state === "running") {
    const alive = deps.isAlive ?? isAlive;
    if (job.pid !== null && !alive(job.pid)) {
      job = markJobInterrupted(ctx, job, secrets, "任务已中断（进程已退出）", deps.now?.());
    } else if (job.pid === null) {
      let current: OpsLockResult | undefined;
      try {
        current = opsOf(deps).status(ctx.configDir, { cacheMs: 1000 });
      } catch {
        current = undefined;
      }
      if (
        current &&
        current.ok === true &&
        current.lockFree === true &&
        (current.remainingPids?.length ?? 0) === 0
      ) {
        const starting =
          current.metaStatus === "complete" &&
          current.metaState === "pending" &&
          (current.metaAgeSeconds ?? 0) < 120;
        if (!starting) {
          job = markJobInterrupted(ctx, job, secrets, "任务未启动或已中断", deps.now?.());
        }
      }
    }
  }
  return sanitizeJob(job, ctx, ctx.paths.configPath);
}

export function getEdgeView(deps: EdgeActionDeps): EdgeView {
  const ctx = ctxOf(deps);
  const role = ctx.role;
  const form = deriveDeployForm(ctx.env, role, ctx.repoRoot).form;
  const desired = desiredSites(form, role).sites;

  const registry: EdgeRegistryView = { name: "<未配置>", drift: false };
  if (ctx.paths.configPath) {
    registry.name = path.basename(ctx.paths.configPath);
    try {
      const text = fs.readFileSync(ctx.paths.configPath, "utf8");
      registry.sha = sha256Hex(text);
      const plan = readPlan(ctx.configDir);
      if (plan) registry.drift = plan.registrySha !== registry.sha;
    } catch (error) {
      registry.error = redactPaths(messageOf(error), ctx, ctx.paths.configPath);
    }
  } else {
    registry.error = redactPaths(
      ctx.paths.errors.join("；") || "未配置 edgectl 配置路径",
      ctx,
    );
  }

  const provider: EdgeProviderView = {
    resolved: ctx.paths.resolvedProvider,
    source: ctx.paths.configSource ?? ctx.paths.binSource ?? "none",
    available: !ctx.paths.disabled,
    ...(ctx.paths.disabled
      ? {
          reason: redactPaths(
            ctx.paths.errors.join("；") || "公网入口未配置",
            ctx,
          ),
        }
      : {}),
  };

  const alive = deps.isAlive ?? isAlive;
  const lastJob = readEdgeJobForApi(deps);
  let appBusy: "deploy" | "edge" | null = null;
  const deployJob = readDeployJob(ctx.configDir);
  if (deployJob?.state === "running" && alive(deployJob.pid)) appBusy = "deploy";
  if (!appBusy && lastJob?.state === "running") appBusy = "edge";

  const canPlan = !ctx.paths.disabled;
  const hint = redactPaths(ctx.paths.errors.join("；"), ctx);
  return {
    enabled: !ctx.paths.disabled,
    ...(ctx.paths.errors.length > 0 && ctx.paths.disabled ? { hint } : {}),
    provider,
    registry,
    desired,
    appBusy,
    lastJob,
    lastFailure: readLastFailure(ctx.configDir),
    canPlan,
    ...(canPlan
      ? {}
      : {
          planHint:
            hint || "公网入口未启用，无法生成计划。",
        }),
  };
}

export interface PlanEdgeOptions {
  role?: EdgeRole;
}

export async function planEdge(
  deps: EdgeActionDeps,
  options: PlanEdgeOptions = {},
): Promise<EdgePlanView> {
  const ctx = ctxOf(deps);
  if (ctx.paths.disabled) throw disabledError(ctx.paths);
  const runner = deps.planRunner ?? defaultPlanRunner;
  const role = options.role ?? ctx.role;
  const configured = Number.parseInt(
    (ctx.env.QUBIUS_EDGE_PLAN_TIMEOUT_MS ?? "").trim(),
    10,
  );
  const timeoutMs =
    deps.planTimeoutMs ??
    (Number.isFinite(configured) && configured > 0 ? configured : 90_000);
  let plan: StoredEdgePlan;
  try {
    plan = await runner({
      role,
      env: ctx.env,
      cwd: deps.repoRoot,
      repoRoot: deps.repoRoot,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof EdgeActionError) throw error;
    const message = redactPaths(messageOf(error), ctx, ctx.paths.configPath);
    // 超时与子进程失败分开映射，避免前端把 500 当成未知故障。
    if (/超时|timed?\s*out|ETIMEDOUT/i.test(message) || /超时/.test(messageOf(error))) {
      throw new EdgeActionError(504, `生成计划超时：${message}`);
    }
    throw new EdgeActionError(503, `生成计划失败：${message}`);
  }

  let requiresForceReclaim = false;
  try {
    const current = opsOf(deps).status(ctx.configDir, { cacheMs: 1000 });
    requiresForceReclaim =
      current.ok === true &&
      current.lockFree === true &&
      (current.remainingPids?.length ?? 0) > 0;
  } catch {
    requiresForceReclaim = false;
  }

  return {
    planHash: plan.planHash,
    provider: plan.provider,
    desired: plan.desired,
    registryDiff: plan.registryDiff,
    remoteDiff: plan.remoteDiff,
    warnings: plan.warnings.map((value) =>
      redactPaths(value, ctx, ctx.paths.configPath),
    ),
    requiresConfirmExisting: plan.requiresConfirmExisting,
    requiresForceReclaim,
    appliable: plan.appliable,
    ...(plan.remoteUnavailable === undefined
      ? {}
      : {
          remoteUnavailable: redactPaths(
            plan.remoteUnavailable,
            ctx,
            ctx.paths.configPath,
          ),
        }),
  };
}

interface VerifiedApply {
  registry: EdgeRegistry;
  secrets: EdgeSecrets;
}

function claimError(
  result: OpsLockResult,
  action: string,
  fallbackKind?: string,
): EdgeActionError {
  if (result.code === "busy") {
    const kind =
      result.kind && result.kind !== "unknown"
        ? result.kind
        : fallbackKind || undefined;
    return new EdgeActionError(
      409,
      `有${kind ? ` ${kind} ` : ""}任务正在运行，请稍后再试。`,
      { code: "busy", ...(kind ? { kind } : {}), ...(result.jobId ? { jobId: result.jobId } : {}) },
    );
  }
  if (result.code === "residual") {
    return new EdgeActionError(409, "锁空闲但仍有残留进程，请先回收。", {
      code: "residual",
      remainingPids: result.remainingPids ?? [],
    });
  }
  return new EdgeActionError(409, `${action}失败：${result.message ?? result.code}`, {
    code: "conflict",
  });
}

/**
 * apply 的本地闸门（HTTP 进程内，不做任何远端 I/O）：
 * planHash / provider / appliable / remoteUnavailable / registrySha /
 * candidateSha / envSnapshot / secretsSha / native 版本 / edgectl bin。
 *
 * 远端 recheck（remoteRawSha、Caddy 版本、edgectl --version）在 detached
 * edge job 里完成，失败写 stale 终态，不影响这里的快速 202。
 */
function verifyApplyLocal(
  deps: EdgeActionDeps,
  ctx: RouteContext,
  plan: StoredEdgePlan,
  planHash: string,
): VerifiedApply {
  if (ctx.paths.disabled) throw disabledError(ctx.paths);
  if (plan.provider !== "cli" && plan.provider !== "native") {
    throw new EdgeActionError(409, `未知 provider：${plan.provider}`, { code: "conflict" });
  }
  if (plan.remoteUnavailable !== undefined) {
    throw new EdgeActionError(
      409,
      `计划生成时远端不可用：${plan.remoteUnavailable}，请重新生成计划。`,
      { code: "stale" },
    );
  }
  if (!plan.appliable) {
    const reasons = [...plan.errors, ...plan.blocking]
      .filter((value) => value.length > 0)
      .join("；");
    throw new EdgeActionError(
      409,
      `计划不可应用${reasons ? `：${reasons}` : "。"}`,
      { code: "conflict" },
    );
  }

  const stale: string[] = [];
  if (computePlanHash(plan) !== plan.planHash) {
    stale.push("计划文件内容与 planHash 不一致（可能被修改）");
  }
  if (plan.planHash !== planHash) stale.push("planHash 与当前计划不一致");
  if (plan.nativeRenderVersion !== NATIVE_RENDER_VERSION) {
    stale.push("native 渲染版本已变化");
  }
  if (sha256Hex(plan.candidateBytes) !== plan.candidateSha) {
    stale.push("候选注册表内容与 candidateSha 不一致");
  }

  let registryText: string | undefined;
  try {
    registryText = fs.readFileSync(plan.registryPath, "utf8");
  } catch {
    stale.push("无法读取注册表");
  }
  if (registryText !== undefined && sha256Hex(registryText) !== plan.registrySha) {
    stale.push("注册表在计划生成后发生变化");
  }

  const snapshot = edgeEnvSnapshot(ctx.env, plan.role, ctx.repoRoot);
  if (canonicalJson(snapshot) !== canonicalJson(plan.envSnapshot)) {
    stale.push("edge 相关环境变量在计划生成后发生变化");
  }

  if (plan.edgectl.bin !== null && ctx.paths.binPath !== plan.edgectl.bin) {
    stale.push("edgectl 路径已变化");
  }

  let registry: EdgeRegistry | undefined;
  if (registryText !== undefined) {
    try {
      registry = parseRegistryText(registryText, plan.registryPath);
    } catch {
      stale.push("注册表无法解析");
    }
  }
  let secrets: EdgeSecrets | undefined;
  if (registry) {
    try {
      secrets = (deps.loadSecretsFn ?? loadEdgeSecrets)({ registry, env: ctx.env });
      if (secrets.secretsSha !== plan.secretsSha) {
        stale.push("dev 认证密钥在计划生成后发生变化");
      }
    } catch {
      stale.push("无法读取 dev 认证密钥");
    }
  }

  if (stale.length > 0) {
    throw new EdgeActionError(409, `计划已过期：${stale.join("；")}。`, { code: "stale" });
  }
  return { registry: registry!, secrets: secrets! };
}

export async function applyEdge(
  deps: EdgeActionDeps,
  body: unknown,
): Promise<{ ok: true; jobId: string }> {
  const ctx = ctxOf(deps);
  const planHash = requireString(body, "planHash");
  const confirmDomain = normalizeDomainSafe(requireString(body, "confirmDomain"));
  const confirmExisting = recordValue(body, "confirmExisting") === true;

  if (ctx.paths.disabled) throw disabledError(ctx.paths);
  const plan = readPlan(ctx.configDir);
  if (!plan) {
    throw new EdgeActionError(409, "没有可应用的 edge 计划，请先重新生成计划。", {
      code: "stale",
    });
  }
  if (plan.planHash !== planHash) {
    throw new EdgeActionError(409, "planHash 与当前计划不一致，请重新生成计划。", {
      code: "stale",
    });
  }
  const allowedDomains = expectedConfirmDomains(ctx, plan);
  if (allowedDomains.length === 0) {
    throw new EdgeActionError(409, "当前没有可确认的公网域名，请先配置主/副实例公网域名。", {
      code: "conflict",
    });
  }
  if (!allowedDomains.includes(confirmDomain)) {
    throw new EdgeActionError(
      409,
      `确认的公网域名 ${confirmDomain || "（空）"} 与目标站点不一致。`,
      { code: "conflict" },
    );
  }
  if (plan.requiresConfirmExisting && !confirmExisting) {
    throw new EdgeActionError(
      409,
      "计划会改动已有站点或非 qubius 管理的站点，需要额外确认（confirmExisting）。",
      { code: "conflict" },
    );
  }

  const verified = verifyApplyLocal(deps, ctx, plan, planHash);
  recordPlanFingerprint(ctx.configDir, plan);

  const jobId = (deps.randomId ?? randomUUID)();
  const token = randomUUID();
  const ops = opsOf(deps);
  let claimed: OpsLockResult;
  try {
    claimed = ops.claim({
      root: ctx.configDir,
      kind: "apply",
      jobId,
      token,
    });
  } catch (error) {
    throw new EdgeActionError(500, `占用 ops lock 失败：${messageOf(error)}`);
  }
  if (!claimed.ok) {
    throw claimFailure(ops, ctx.configDir, claimed, "占用 ops lock");
  }

  const nowDate = (deps.now ?? (() => new Date()))();
  // edge-request.json 的 createdAt 保持既有毫秒 ISO；作业状态用秒精度契约。
  const now = nowDate.toISOString();
  const jobStartedAt = jobTimestamp(nowDate);
  const request: EdgeJobRequest = {
    version: 1,
    kind: "apply",
    jobId,
    token,
    createdAt: now,
    confirmDomain,
    planHash,
    ...(confirmExisting ? { confirmExisting: true } : {}),
  };

  try {
    writeEdgeRequest(ctx.configDir, request);
    writeEdgeJob(
      ctx.configDir,
      {
        jobId,
        state: "running",
        kind: "apply",
        step: "prepare",
        message: "edge 应用任务已启动",
        pid: null,
        startedAt: jobStartedAt,
        finishedAt: null,
      },
      verified.secrets,
    );
    const spawn = deps.spawnJob ?? defaultSpawnJob;
    spawn({
      script: path.join(deps.repoRoot, "deploy", "edge-job.sh"),
      cwd: deps.repoRoot,
      logFile: path.join(ctx.configDir, "edge.log"),
      env: opsJobEnv(ctx.configDir, token, jobId, {
        ...ctx.env,
        QUBIUS_CONFIG_DIR: ctx.configDir,
        QUBIUS_EDGE_CONFIG_DIR: ctx.configDir,
        QUBIUS_EDGE_REPO_ROOT: deps.repoRoot,
        QUBIUS_EDGE_JOB_ID: jobId,
        QUBIUS_EDGE_KIND: "apply",
      }),
    });
  } catch (error) {
    // spawn/写请求失败：按 token 清掉 pending，避免锁被占 120s。
    try {
      ops.clear(ctx.configDir, token);
    } catch {
      // 清理失败只能让 pending 宽限期自然过期。
    }
    writeEdgeJob(ctx.configDir, {
      jobId,
      state: "failed",
      kind: "apply",
      step: "spawn",
      message: `edge 任务启动失败：${messageOf(error)}`,
      pid: null,
      startedAt: jobStartedAt,
      finishedAt: jobTimestamp(deps.now?.() ?? new Date()),
    }, verified.secrets);
    throw new EdgeActionError(500, `无法启动 edge 任务：${messageOf(error)}`);
  }

  return { ok: true, jobId };
}

export async function restoreEdge(
  deps: EdgeActionDeps,
  body: unknown,
): Promise<{ ok: true; jobId: string }> {
  const ctx = ctxOf(deps);
  const backup = requireString(body, "backup");
  const remoteSha = requireString(body, "remoteSha");
  const confirmDomain = normalizeDomainSafe(requireString(body, "confirmDomain"));
  if (!/^[0-9a-f]{64}$/.test(remoteSha)) {
    throw new EdgeActionError(
      400,
      "remoteSha 必须是当前远端 Caddyfile 的 64 位十六进制 sha256。",
    );
  }
  if (!isAllowedEdgeBackupName(backup)) {
    throw new EdgeActionError(
      400,
      "backup 必须是本工具生成的备份/快照文件名（edge-backup-*.Caddyfile 或 edge-unknown-*.Caddyfile）。",
    );
  }
  const backupFile = path.join(ctx.configDir, backup);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(backupFile);
  } catch {
    throw new EdgeActionError(404, "找不到指定的备份文件。");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new EdgeActionError(404, "备份文件不是普通文件。");
  }

  if (ctx.paths.disabled) throw disabledError(ctx.paths);
  const allowedDomains = expectedConfirmDomains(ctx);
  if (allowedDomains.length === 0) {
    throw new EdgeActionError(409, "当前没有可确认的公网域名，请先配置主/副实例公网域名。", {
      code: "conflict",
    });
  }
  if (!allowedDomains.includes(confirmDomain)) {
    throw new EdgeActionError(409, "确认的公网域名与当前实例不一致。", { code: "conflict" });
  }

  // 远端 sha 与 Caddy 校验都在 detached job 里做；这里只做本地快速校验。
  const jobId = (deps.randomId ?? randomUUID)();
  const token = randomUUID();
  const ops = opsOf(deps);
  let claimed: OpsLockResult;
  try {
    claimed = ops.claim({ root: ctx.configDir, kind: "restore", jobId, token });
  } catch (error) {
    throw new EdgeActionError(500, `占用 ops lock 失败：${messageOf(error)}`);
  }
  if (!claimed.ok) {
    throw claimFailure(ops, ctx.configDir, claimed, "占用 ops lock");
  }

  const nowDate = (deps.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  const jobStartedAt = jobTimestamp(nowDate);
  const request: EdgeJobRequest = {
    version: 1,
    kind: "restore",
    jobId,
    token,
    createdAt: now,
    confirmDomain,
    backup,
    remoteSha,
  };
  try {
    writeEdgeRequest(ctx.configDir, request);
    writeEdgeJob(ctx.configDir, {
      jobId,
      state: "running",
      kind: "restore",
      step: "prepare",
      message: "edge 恢复任务已启动",
      pid: null,
      startedAt: jobStartedAt,
      finishedAt: null,
    });
    const spawn = deps.spawnJob ?? defaultSpawnJob;
    spawn({
      script: path.join(deps.repoRoot, "deploy", "edge-job.sh"),
      cwd: deps.repoRoot,
      logFile: path.join(ctx.configDir, "edge.log"),
      env: opsJobEnv(ctx.configDir, token, jobId, {
        ...ctx.env,
        QUBIUS_CONFIG_DIR: ctx.configDir,
        QUBIUS_EDGE_CONFIG_DIR: ctx.configDir,
        QUBIUS_EDGE_REPO_ROOT: deps.repoRoot,
        QUBIUS_EDGE_JOB_ID: jobId,
        QUBIUS_EDGE_KIND: "restore",
      }),
    });
  } catch (error) {
    try {
      ops.clear(ctx.configDir, token);
    } catch {
      // 清理失败只能等 pending 过期。
    }
    writeEdgeJob(ctx.configDir, {
      jobId,
      state: "failed",
      kind: "restore",
      step: "spawn",
      message: `edge 恢复任务启动失败：${messageOf(error)}`,
      pid: null,
      startedAt: jobStartedAt,
      finishedAt: jobTimestamp(deps.now?.() ?? new Date()),
    });
    throw new EdgeActionError(500, `无法启动 edge 恢复任务：${messageOf(error)}`);
  }
  return { ok: true, jobId };
}

/**
 * reclaim 也放到 detached job 里执行（cleanup/forceReclaim 可能耗时数十秒）。
 * HTTP 只做固定短语校验和一次廉价的 status 预检（活跃持锁 → 409 busy），
 * 真正的清理/回收结果通过 /api/edge/status 轮询查看。
 */
export function reclaimEdge(deps: EdgeActionDeps, body: unknown): { ok: true } {
  const ctx = ctxOf(deps);
  const confirm = recordValue(body, "confirm");
  if (confirm !== "RECLAIM") {
    throw new EdgeActionError(400, "确认短语必须是 RECLAIM。");
  }
  const jobIdRaw = recordValue(body, "jobId");
  let reclaimJobId: string | undefined;
  if (typeof jobIdRaw === "string" && jobIdRaw.trim()) {
    reclaimJobId = jobIdRaw.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(reclaimJobId)) {
      throw new EdgeActionError(400, "jobId 含有非法字符。");
    }
  }

  const ops = opsOf(deps);
  // 廉价预检：活跃持锁或宽限期内的 pending claim 都算 busy（与 claim 语义一致），
  // 避免 reclaim 覆盖 pending apply/restore 的 edge-request.json。
  try {
    const current = ops.status(ctx.configDir, { cacheMs: 1000 });
    const pendingClaim =
      current.metaStatus === "complete" &&
      current.metaState === "pending" &&
      (current.metaAgeSeconds ?? 0) < 120;
    if (current.ok === true && (current.lockFree === false || pendingClaim)) {
      const kind =
        current.metaKind && current.metaKind !== "unknown" ? current.metaKind : undefined;
      throw new EdgeActionError(
        409,
        `有${kind ? ` ${kind} ` : ""}任务正在运行，无法回收。`,
        { code: "busy", ...(kind ? { kind } : {}) },
      );
    }
  } catch (error) {
    if (error instanceof EdgeActionError) throw error;
    // status 失败不让回收失败；job 内会再次尝试。
  }

  const jobId = (deps.randomId ?? randomUUID)();
  const nowDate = (deps.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  const jobStartedAt = jobTimestamp(nowDate);
  const request: EdgeJobRequest = {
    version: 1,
    kind: "reclaim",
    jobId,
    createdAt: now,
    ...(reclaimJobId ? { reclaimJobId } : {}),
  };
  const failSpawn = (error: unknown): never => {
    writeEdgeJob(ctx.configDir, {
      jobId,
      state: "failed",
      kind: "reclaim",
      step: "spawn",
      message: `回收任务启动失败：${messageOf(error)}`,
      pid: null,
      startedAt: jobStartedAt,
      finishedAt: jobTimestamp(deps.now?.() ?? new Date()),
    });
    throw new EdgeActionError(500, `无法启动回收任务：${messageOf(error)}`);
  };

  try {
    writeEdgeRequest(ctx.configDir, request);
    // spawn 前先写 running(pid=null)，避免任务启动窗口内状态缺失。
    writeEdgeJob(ctx.configDir, {
      jobId,
      state: "running",
      kind: "reclaim",
      step: "prepare",
      message: "回收任务已启动",
      pid: null,
      startedAt: jobStartedAt,
      finishedAt: null,
    });
  } catch (error) {
    failSpawn(error);
  }

  let spawned: { pid: number | null } | null = null;
  try {
    const spawn = deps.spawnJob ?? defaultSpawnJob;
    spawned = spawn({
      command: process.execPath,
      args: [path.join(deps.repoRoot, "server", "dist", "edge-job.js")],
      cwd: deps.repoRoot,
      logFile: path.join(ctx.configDir, "edge.log"),
      // 不携带 ops 标记：回收进程本身不能被当成残留杀掉。
      env: opsDaemonEnv({
        ...ctx.env,
        QUBIUS_CONFIG_DIR: ctx.configDir,
        QUBIUS_EDGE_CONFIG_DIR: ctx.configDir,
        QUBIUS_EDGE_REPO_ROOT: deps.repoRoot,
        QUBIUS_EDGE_JOB_ID: jobId,
        QUBIUS_EDGE_KIND: "reclaim",
      }),
    });
  } catch (error) {
    failSpawn(error);
  }

  if (spawned && spawned.pid !== null) {
    // 补写 pid；失败只记日志，作业本身已启动，不能误报失败。
    try {
      writeEdgeJob(ctx.configDir, {
        jobId,
        state: "running",
        kind: "reclaim",
        step: "prepare",
        message: "回收任务已启动",
        pid: spawned.pid,
        startedAt: jobStartedAt,
        finishedAt: null,
      });
    } catch (error) {
      try {
        appendEdgeLog(
          ctx.configDir,
          `回收任务 pid 写入失败：${messageOf(error)}\n`,
        );
      } catch {
        // 日志也写不了只能放弃。
      }
    }
  }
  return { ok: true };
}

/* ────────────────────────── edge job 执行 ────────────────────────── */

interface JobTracker {
  ctx: RouteContext;
  deps: EdgeActionDeps;
  request: EdgeJobRequest;
  secrets?: EdgeSecrets;
  startedAt: string;
  step: string;
  remainingPids?: number[];
  /** 失败时记录到 edge.json，供 GET 预填 restore 表单。 */
  lastFailure?: EdgeLastFailure;
  remote: EdgeRemoteFns;
  ops: EdgeOpsFns;
}

interface RemoteSnapshot {
  content: string;
  sha: string;
}

function trackerOf(
  configDir: string,
  request: EdgeJobRequest,
  deps: EdgeActionDeps,
): JobTracker {
  const env = deps.env ?? process.env;
  const role = deps.role ?? "primary";
  return {
    ctx: {
      env,
      role,
      configDir,
      paths: deps.paths ?? resolveEdgeEnv(env),
      repoRoot: deps.repoRoot,
    },
    deps,
    request,
    startedAt: jobTimestamp(deps.now?.() ?? new Date()),
    step: "prepare",
    remote: remoteOf(deps),
    ops: opsOf(deps),
  };
}

function writeRunning(tracker: JobTracker, step: string, message: string): void {
  tracker.step = step;
  writeEdgeJob(
    tracker.ctx.configDir,
    {
      jobId: tracker.request.jobId,
      state: "running",
      kind: tracker.request.kind,
      step,
      message,
      pid: process.pid,
      startedAt: tracker.startedAt,
      finishedAt: null,
    },
    tracker.secrets ?? null,
  );
  appendEdgeLog(
    tracker.ctx.configDir,
    `[${isoNow()}] ${tracker.request.kind} ${tracker.request.jobId} ${step}: ${message}\n`,
    tracker.secrets ?? null,
  );
}

function finishJob(
  tracker: JobTracker,
  state: "success" | "failed",
  step: string,
  message: string,
): EdgeJob {
  const now = isoNow();
  const job: EdgeJob = {
    jobId: tracker.request.jobId,
    state,
    kind: tracker.request.kind,
    step,
    message,
    pid: process.pid,
    startedAt: tracker.startedAt,
    finishedAt: jobTimestamp(tracker.deps.now?.() ?? new Date()),
    ...(tracker.remainingPids ? { remainingPids: tracker.remainingPids } : {}),
  };
  writeEdgeJob(tracker.ctx.configDir, job, tracker.secrets ?? null);
  appendEdgeLog(
    tracker.ctx.configDir,
    `[${now}] ${tracker.request.kind} ${tracker.request.jobId} ${state}: ${message}\n`,
    tracker.secrets ?? null,
  );
  markTerminal(tracker, state);
  return job;
}

function markTerminal(tracker: JobTracker, state: "success" | "failed"): void {
  const env = tracker.ctx.env;
  const root = env.QUBIUS_OPS_ROOT;
  const token = env.QUBIUS_OPS_TOKEN;
  const job = env.QUBIUS_OPS_JOB ?? tracker.request.jobId;
  if (!root || !token) return;
  try {
    writeOpsMeta(root, {
      state,
      kind: tracker.request.kind,
      jobId: job,
      token,
      pid: process.pid,
    }, { env });
  } catch {
    // 脚本退出时还会再 mark 一次；这里失败不影响作业结果。
  }
}

function remoteOptions(tracker: JobTracker) {
  return {
    runner: tracker.deps.runner,
    env: tracker.ctx.env,
    secrets: tracker.secrets,
  };
}

function writeRegistryAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.qubius-edge.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
}

function backupFileName(jobId: string): string {
  return `edge-backup-${jobId}.Caddyfile`;
}

function unknownFileName(jobId: string): string {
  return `edge-unknown-${jobId}.Caddyfile`;
}

function writeSensitiveFile(configDir: string, name: string, content: string): string {
  const file = path.join(configDir, name);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
  return file;
}

/** 启动时清理自有备份/快照：最多保留 5 份且不超过 7 天；删除失败不阻塞。 */
export function cleanupEdgeBackups(
  configDir: string,
  options: {
    max?: number;
    maxAgeMs?: number;
    now?: Date;
    /** 本次请求正在使用的备份，永不清理。 */
    exclude?: string[];
  } = {},
): string[] {
  const max = options.max ?? 5;
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = (options.now ?? new Date()).getTime();
  const excluded = new Set(options.exclude ?? []);
  let names: string[];
  try {
    names = fs.readdirSync(configDir);
  } catch {
    return [];
  }
  const rows: Array<{ name: string; file: string; mtime: number }> = [];
  for (const name of names) {
    // 本次请求正在使用的备份完全不参与数量/年龄排序。
    if (excluded.has(name)) continue;
    if (!/^edge-(?:backup|unknown)-[A-Za-z0-9._-]+\.Caddyfile$/.test(name)) continue;
    const file = path.join(configDir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) rows.push({ name, file, mtime: stat.mtimeMs });
    } catch {
      // 读取失败跳过。
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  rows.forEach((row, index) => {
    if (index < max && now - row.mtime <= maxAgeMs) return;
    try {
      fs.unlinkSync(row.file);
      removed.push(row.name);
    } catch {
      // 删除失败不阻塞作业。
    }
  });
  return removed;
}

function removeIfExists(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

/** 读取远端；失败抛中文错误。 */
function readRemote(tracker: JobTracker, registry: EdgeRegistry): RemoteSnapshot {
  try {
    return tracker.remote.readRemoteFile(registry, remoteOptions(tracker));
  } catch (error) {
    throw new EdgeError(`读取远端 Caddyfile 失败：${messageOf(error)}`);
  }
}

/**
 * live validate + reload；reload 失败时按文档再执行一次 validate+reload。
 * 返回 null 表示成功，否则返回错误详情。
 */
function activateWithRetry(tracker: JobTracker, registry: EdgeRegistry): string | null {
  let detail = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const live = tracker.remote.caddyValidateLive(registry, remoteOptions(tracker));
    if (!live.ok) {
      detail =
        `live 校验失败：${live.stderr || live.stdout || "无输出"}` +
        (attempt === 0 ? "" : "（重试后仍失败）");
      // live 校验失败时不会 reload，直接重试下一轮。
      continue;
    }
    const reload = tracker.remote.caddyReload(registry, remoteOptions(tracker));
    if (reload.ok) return null;
    detail =
      `caddy reload 失败：${reload.stderr || reload.stdout || "无输出"}` +
      (attempt === 0 ? "" : "（重试后仍失败）");
  }
  return detail || "reload 失败";
}

function saveUnknown(tracker: JobTracker, content: string): string {
  return writeSensitiveFile(
    tracker.ctx.configDir,
    unknownFileName(tracker.request.jobId),
    content,
  );
}

/** native provider：调用 D4 的 applyNative / reloadOnly，并映射 outcome。 */
async function runNativeApplyJob(
  tracker: JobTracker,
  plan: StoredEdgePlan,
): Promise<string> {
  recordPlanFingerprint(tracker.ctx.configDir, plan);
  if (plan.remoteRawSha === null) {
    throw new EdgeError("计划生成时远端不可用，不能应用。");
  }

  const registryText = fs.readFileSync(plan.registryPath, "utf8");
  let candidateRegistry: EdgeRegistry;
  try {
    candidateRegistry = parseRegistryText(plan.candidateBytes, plan.registryPath);
  } catch (error) {
    throw new EdgeError(`解析候选注册表失败：${messageOf(error)}`);
  }
  let secrets: EdgeSecrets;
  try {
    secrets = (tracker.deps.loadSecretsFn ?? loadEdgeSecrets)({
      registry: candidateRegistry,
      env: tracker.ctx.env,
    });
  } catch (error) {
    throw new EdgeError(`读取 dev 认证密钥失败：${messageOf(error)}`);
  }
  tracker.secrets = secrets;

  writeRunning(tracker, "verify-plan", "正在复核计划与本地配置");
  // caddyVersion 真正探测一次（不要用 plan 自己的值自比）。
  let currentCaddy: string | null | undefined;
  if (plan.caddyVersion !== null) {
    try {
      currentCaddy = tracker.remote.caddyVersion(
        candidateRegistry,
        remoteOptions(tracker),
      ).version;
    } catch (error) {
      throw new EdgeError(`无法探测远端 Caddy 版本：${messageOf(error)}`);
    }
  }
  const verdict = verifyPlan(plan, {
    planHash: tracker.request.planHash,
    recheck: true,
    // native 的远端 sha/候选校验由 applyNative 自己完成。
    remoteRawSha: plan.remoteRawSha,
    secrets,
    env: tracker.ctx.env,
    repoRoot: tracker.ctx.repoRoot,
    provider: "native",
    ...(currentCaddy === undefined ? {} : { caddyVersion: currentCaddy }),
  });
  if (!verdict.ok) {
    throw new EdgeError(
      `计划已过期：${verdict.stale.map((reason) => reason.message).join("；")}`,
    );
  }

  const log = (text: string): void => {
    appendEdgeLog(tracker.ctx.configDir, `${text}\n`, secrets);
  };
  const applyFn = tracker.deps.nativeApplyFn ?? applyNative;
  const reloadFn = tracker.deps.reloadOnlyFn ?? reloadOnly;

  /** 写回真实注册表（候选即期望配置）；写前再确认 registrySha。 */
  const writeLocalRegistry = (): { text: string; mode: number } => {
    writeRunning(tracker, "write-registry", "正在写入注册表");
    let originalText = registryText;
    let originalMode = 0o600;
    try {
      originalText = fs.readFileSync(plan.registryPath, "utf8");
      if (sha256Hex(originalText) !== plan.registrySha) {
        throw new EdgeError("注册表在复核后再次发生变化，请重新生成计划。");
      }
      originalMode = fs.statSync(plan.registryPath).mode & 0o777;
      writeRegistryAtomic(plan.registryPath, plan.candidateBytes, originalMode);
    } catch (error) {
      if (error instanceof EdgeError) throw error;
      throw new EdgeError(`写入注册表失败：${messageOf(error)}`);
    }
    return { text: originalText, mode: originalMode };
  };

  const snapshotUnknown = (): void => {
    try {
      const snapshot = readRemote(tracker, candidateRegistry);
      const unknown = saveUnknown(tracker, snapshot.content);
      tracker.lastFailure = {
        ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
        remoteSha: snapshot.sha,
        unknown: path.basename(unknown),
      };
    } catch {
      // 读不到远端时只保留消息。
    }
  };

  // 先读远端再决定是否改本地注册表，避免“未写远端却改了唯一事实来源”。
  writeRunning(tracker, "verify-remote", "正在复核远端状态");
  let current: RemoteSnapshot;
  try {
    current = readRemote(tracker, candidateRegistry);
  } catch (error) {
    throw new EdgeError(`读取远端 Caddyfile 失败：${messageOf(error)}`);
  }

  if (current.sha === plan.expectedRemoteSha) {
    // 变更计划但远端已是目标内容：写注册表 + validate live/reload，不重写远端。
    writeLocalRegistry();
    writeRunning(tracker, "activate", "远端已是目标内容，正在 reload");
    const retry = await reloadFn({
      registry: candidateRegistry,
      secrets,
      expectedSha: plan.expectedRemoteSha,
      jobId: tracker.request.jobId,
      runner: tracker.deps.runner,
      env: tracker.ctx.env,
      log,
    });
    if (retry.outcome === "success") return retry.message;
    tracker.lastFailure = {
      ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
      remoteSha: retry.remoteSha ?? current.sha,
    };
    throw new EdgeError(`远端已是目标内容，但 reload 重试失败：${retry.message}`);
  }

  if (current.sha !== plan.remoteRawSha) {
    // 未写本地注册表；保存现场并失败。
    tracker.lastFailure = {
      ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
      remoteSha: current.sha,
    };
    snapshotUnknown();
    throw new EdgeError(
      `远端 Caddyfile 在应用前发生变化（sha ${current.sha}）；未写入，请重新生成计划。`,
    );
  }

  // 远端仍是计划基线：写注册表后交给 applyNative（它自带写前复核）。
  const original = writeLocalRegistry();
  const rollbackRegistry = (): void => {
    try {
      writeRegistryAtomic(plan.registryPath, original.text, original.mode);
    } catch (error) {
      appendEdgeLog(
        tracker.ctx.configDir,
        `回滚注册表失败：${messageOf(error)}\n`,
        secrets,
      );
    }
  };
  const failNoSnapshot = (message: string): never => {
    // 远端分毫未动：回滚本地注册表，保持唯一事实来源。
    rollbackRegistry();
    throw new EdgeError(message);
  };
  const failKeepCandidate = (message: string, snapshot: boolean): never => {
    if (snapshot) snapshotUnknown();
    // 远端已是目标内容（未激活）或未知：本地注册表保留候选配置。
    throw new EdgeError(message);
  };

  writeRunning(tracker, "apply", "正在应用 native 远端配置");
  const result: NativeApplyResult = await applyFn({
    registryPath: plan.registryPath,
    registry: candidateRegistry,
    candidateBytes: plan.candidateBytes,
    secrets,
    remoteRawSha: plan.remoteRawSha,
    expectedRemoteSha: plan.expectedRemoteSha,
    jobId: tracker.request.jobId,
    log,
    runner: tracker.deps.runner,
    env: tracker.ctx.env,
    timeoutMs: 60_000,
  });
  if (result.remoteSha) {
    tracker.lastFailure = {
      ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
      remoteSha: result.remoteSha,
    };
  }
  // 说明：D4 的 backupPath 是远端 `.bak` 绝对路径，不是本端点 restore 可用的
  // 本地备份，因此不写入 lastFailure.backup（避免前端误用）。

  switch (result.outcome) {
    case "success":
      return result.message;
    case "writtenNotActive": {
      writeRunning(tracker, "activate", "内容已写入，正在重试 reload");
      const retry = await reloadFn({
        registry: candidateRegistry,
        secrets,
        expectedSha: plan.expectedRemoteSha,
        jobId: tracker.request.jobId,
        runner: tracker.deps.runner,
        env: tracker.ctx.env,
        log,
      });
      if (retry.outcome === "success") return retry.message;
      if (retry.remoteSha) {
        tracker.lastFailure = {
          ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
          remoteSha: retry.remoteSha,
        };
      }
      // 远端仍是 expected（live-invalid/reload-failed）时不需要 unknown 快照；
      // 但若远端已漂移或读取失败，需要刷新现场并保存快照。
      const drifted =
        retry.code === "remote-changed" ||
        retry.code === "remote-read-failed" ||
        (retry.remoteSha !== null && retry.remoteSha !== plan.expectedRemoteSha);
      return failKeepCandidate(
        `native apply 已写入但未生效，reload 重试仍失败：${retry.message}`,
        drifted,
      );
    }
    case "restored":
      // 已恢复原内容，不需要再保存“恢复它等于什么都不做”的快照。
      return failNoSnapshot(`native apply 未生效，已恢复原内容：${result.message}`);
    case "unknown":
      return failKeepCandidate(
        `native apply 结果未知（需人工确认）：${result.message}`,
        true,
      );
    default:
      // failed（remote-changed/candidate-invalid/stale-plan/读远端失败等）：
      // 远端未写入，回滚本地注册表。
      return failNoSnapshot(`native apply 失败：${result.message}`);
  }
}

async function runApplyJob(tracker: JobTracker): Promise<string> {
  const plan = readPlan(tracker.ctx.configDir);
  if (!plan) throw new EdgeError("找不到 edge 计划文件，请重新生成计划。");
  if (tracker.request.planHash && tracker.request.planHash !== plan.planHash) {
    throw new EdgeError("计划已变化（planHash 不一致），请重新生成计划。");
  }
  if (!plan.appliable) {
    const reasons = [...plan.errors, ...plan.blocking].filter(Boolean).join("；");
    throw new EdgeError(`计划不可应用${reasons ? `：${reasons}` : "。"}`);
  }
  if (plan.remoteUnavailable !== undefined) {
    throw new EdgeError(`计划生成时远端不可用：${plan.remoteUnavailable}`);
  }
  if (tracker.ctx.paths.disabled) {
    throw new EdgeError(`公网入口未启用：${tracker.ctx.paths.errors.join("；")}`);
  }
  if (plan.provider === "native") {
    return runNativeApplyJob(tracker, plan);
  }
  if (plan.provider !== "cli") {
    throw new EdgeError(`未知 provider：${plan.provider}`);
  }
  recordPlanFingerprint(tracker.ctx.configDir, plan);

  let registryText: string;
  try {
    registryText = fs.readFileSync(plan.registryPath, "utf8");
  } catch (error) {
    throw new EdgeError(`读取注册表失败：${messageOf(error)}`);
  }
  let registry: EdgeRegistry;
  try {
    registry = parseRegistryText(registryText, plan.registryPath);
  } catch (error) {
    throw new EdgeError(`解析注册表失败：${messageOf(error)}`);
  }
  let secrets: EdgeSecrets;
  try {
    secrets = (tracker.deps.loadSecretsFn ?? loadEdgeSecrets)({
      registry,
      env: tracker.ctx.env,
    });
  } catch (error) {
    throw new EdgeError(`读取 dev 认证密钥失败：${messageOf(error)}`);
  }
  tracker.secrets = secrets;

  writeRunning(tracker, "verify-remote", "正在复核远端与配置指纹");
  if (plan.remoteRawSha === null) {
    throw new EdgeError("计划生成时远端不可用，不能应用。");
  }
  const current = readRemote(tracker, registry);
  tracker.lastFailure = { jobId: tracker.request.jobId, remoteSha: current.sha };

  // 远端预检三态：old 可写；expected 只需 reload；其它保存快照并停止。
  let mode: "write" | "already";
  if (current.sha === plan.remoteRawSha) {
    mode = "write";
  } else if (current.sha === plan.expectedRemoteSha) {
    mode = "already";
  } else {
    const unknown = saveUnknown(tracker, current.content);
    tracker.lastFailure = {
      ...tracker.lastFailure,
      remoteSha: current.sha,
      unknown: path.basename(unknown),
    };
    throw new EdgeError(
      `远端 Caddyfile 在计划生成后发生变化（sha ${current.sha}）；` +
        `未覆盖，已保存到 ${path.basename(unknown)}。请人工核对后重新生成计划。`,
    );
  }

  // edgectl --version / Caddy 版本 / registry/env/secrets 全部在 job 内复核。
  let edgectl: StoredEdgePlan["edgectl"];
  try {
    const version = cliVersion({
      paths: tracker.ctx.paths,
      runner: tracker.deps.runner,
      env: tracker.ctx.env,
      secrets,
    });
    edgectl = {
      bin: tracker.ctx.paths.binPath,
      version: version.version,
      source: tracker.ctx.paths.binSource,
    };
  } catch (error) {
    throw new EdgeError(`edgectl 握手失败：${messageOf(error)}`);
  }
  let currentCaddy: string | null | undefined;
  if (plan.caddyVersion !== null) {
    try {
      currentCaddy = tracker.remote.caddyVersion(
        registry,
        remoteOptions(tracker),
      ).version;
    } catch (error) {
      throw new EdgeError(`无法探测远端 Caddy 版本：${messageOf(error)}`);
    }
  }
  const verdict = verifyPlan(plan, {
    planHash: tracker.request.planHash,
    recheck: true,
    // already 模式下远端已是目标内容；用计划记录的 old sha 让 verifyPlan 的
    // 远端漂移检查通过（目标内容已在上面单独确认）。
    remoteRawSha: plan.remoteRawSha,
    secrets,
    env: tracker.ctx.env,
    repoRoot: tracker.ctx.repoRoot,
    provider: "cli",
    edgectl,
    ...(currentCaddy === undefined ? {} : { caddyVersion: currentCaddy }),
  });
  if (!verdict.ok) {
    throw new EdgeError(
      `计划已过期：${verdict.stale.map((reason) => reason.message).join("；")}`,
    );
  }

  writeRunning(tracker, "render", "正在计算期望的 Caddyfile");
  let expected: string;
  try {
    const candidateRegistry = parseRegistryText(plan.candidateBytes, plan.registryPath);
    expected = spliceManaged(current.content, renderVpsBlock(candidateRegistry, secrets));
  } catch (error) {
    throw new EdgeError(`渲染候选 Caddyfile 失败：${messageOf(error)}`);
  }
  let expectedSha = sha256Hex(expected);
  if (expectedSha !== plan.expectedRemoteSha) {
    throw new EdgeError("候选内容与计划指纹不一致，请重新生成计划。");
  }

  // 非阻断自检：native 渲染的 expected 与候选内容比对，只记录日志。
  writeRunning(tracker, "self-check", "正在做远端语法自检");
  try {
    const check = tracker.remote.caddyValidateCandidate(
      registry,
      expected,
      tracker.request.jobId,
      remoteOptions(tracker),
    );
    if (!check.result.ok) {
      appendEdgeLog(
        tracker.ctx.configDir,
        `自检未通过（非阻断）：${check.result.stderr || check.result.stdout || "无输出"}\n`,
        secrets,
      );
    } else {
      appendEdgeLog(tracker.ctx.configDir, "自检通过。\n", secrets);
    }
  } catch (error) {
    appendEdgeLog(tracker.ctx.configDir, `自检异常（非阻断）：${messageOf(error)}\n`, secrets);
  }

  writeRunning(tracker, "backup", "正在保存远端备份");
  const backup = writeSensitiveFile(
    tracker.ctx.configDir,
    backupFileName(tracker.request.jobId),
    current.content,
  );
  let backupSha = sha256Hex(current.content);
  tracker.lastFailure = {
    ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
    backup: path.basename(backup),
    backupSha,
  };

  // 把候选注册表写入真实注册表；写前再确认 registrySha，失败时恢复原文。
  writeRunning(tracker, "write-registry", "正在写入注册表");
  let originalText = registryText;
  let originalMode = 0o600;
  try {
    originalText = fs.readFileSync(plan.registryPath, "utf8");
    if (sha256Hex(originalText) !== plan.registrySha) {
      throw new EdgeError("注册表在复核后再次发生变化，请重新生成计划。");
    }
    const stat = fs.statSync(plan.registryPath);
    originalMode = stat.mode & 0o777;
    writeRegistryAtomic(plan.registryPath, plan.candidateBytes, originalMode);
  } catch (error) {
    if (error instanceof EdgeError) throw error;
    throw new EdgeError(`写入注册表失败：${messageOf(error)}`);
  }

  const cliOptions = {
    paths: tracker.ctx.paths,
    secrets,
    runner: tracker.deps.runner,
    env: tracker.ctx.env,
    timeoutMs: 60_000,
  };

  writeRunning(tracker, "validate", "正在校验注册表");
  const validate = validateConfig(plan.registryPath, cliOptions);
  if (!validate.ok) {
    try {
      writeRegistryAtomic(plan.registryPath, originalText, originalMode);
    } catch (restoreError) {
      appendEdgeLog(
        tracker.ctx.configDir,
        `校验失败后恢复注册表也失败：${messageOf(restoreError)}\n`,
        secrets,
      );
    }
    throw new EdgeError(
      `edgectl validate --strict 校验失败（exit ${validate.code ?? "?"}）：` +
        (validate.stderr || validate.stdout || "无输出"),
    );
  }

  // validate/自检可能耗时数十秒；apply 前紧邻再读远端，避免覆盖外部改动。
  writeRunning(tracker, "recheck", "正在写入前再次确认远端");
  let preApply: RemoteSnapshot;
  try {
    preApply = readRemote(tracker, registry);
  } catch (error) {
    try {
      writeRegistryAtomic(plan.registryPath, originalText, originalMode);
    } catch {
      // 回滚失败时保留候选注册表；远端未写入。
    }
    throw error;
  }
  const rollbackRegistry = (): void => {
    try {
      writeRegistryAtomic(plan.registryPath, originalText, originalMode);
    } catch (error) {
      appendEdgeLog(
        tracker.ctx.configDir,
        `回滚注册表失败：${messageOf(error)}\n`,
        secrets,
      );
    }
  };

  // 按 apply 前的真实远端重新决定：expected→already；old→write；
  // 其它→失败。初始已是 expected、期间又回退为 old 时必须改回 write。
  if (preApply.sha === plan.expectedRemoteSha) {
    mode = "already";
  } else if (preApply.sha === plan.remoteRawSha) {
    mode = "write";
    try {
      const candidateRegistry = parseRegistryText(plan.candidateBytes, plan.registryPath);
      expected = spliceManaged(preApply.content, renderVpsBlock(candidateRegistry, secrets));
      expectedSha = sha256Hex(expected);
    } catch (error) {
      rollbackRegistry();
      const unknown = saveUnknown(tracker, preApply.content);
      tracker.lastFailure = {
        ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
        remoteSha: preApply.sha,
        unknown: path.basename(unknown),
      };
      throw new EdgeError(
        `应用前重新渲染候选 Caddyfile 失败：${messageOf(error)}；` +
          `未写入，已保存远端快照到 ${path.basename(unknown)}。`,
      );
    }
    if (expectedSha !== plan.expectedRemoteSha) {
      rollbackRegistry();
      const unknown = saveUnknown(tracker, preApply.content);
      tracker.lastFailure = {
        ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
        remoteSha: preApply.sha,
        unknown: path.basename(unknown),
      };
      throw new EdgeError(
        "应用前重新计算的期望内容与计划指纹不一致，请重新生成计划；" +
          `已保存远端快照到 ${path.basename(unknown)}。`,
      );
    }
    // 刷新备份，确保回滚基线是写入前最新的远端内容。
    writeSensitiveFile(
      tracker.ctx.configDir,
      backupFileName(tracker.request.jobId),
      preApply.content,
    );
    backupSha = sha256Hex(preApply.content);
    tracker.lastFailure = {
      ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
      remoteSha: preApply.sha,
      backup: path.basename(backupFileName(tracker.request.jobId)),
      backupSha,
    };
  } else {
    // 远端已漂移：回滚本地注册表（远端分毫未动），保存现场并失败。
    rollbackRegistry();
    const unknown = saveUnknown(tracker, preApply.content);
    tracker.lastFailure = {
      ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
      remoteSha: preApply.sha,
      unknown: path.basename(unknown),
    };
    throw new EdgeError(
      `远端 Caddyfile 在应用前发生变化（sha ${preApply.sha}）；` +
        `未覆盖，已保存到 ${path.basename(unknown)}。请人工核对后重新生成计划。`,
    );
  }

  if (mode === "already") {
    // CLI 在“远端已一致”时会 no-op 且不 reload，所以这里显式 validate+reload。
    writeRunning(tracker, "activate", "远端已是目标内容，正在 reload");
    const detail = activateWithRetry(tracker, registry);
    if (detail) {
      throw new EdgeError(`远端已是目标内容，但 ${detail}。`);
    }
    return "远端已是目标内容，已 validate 并 reload。";
  }

  writeRunning(tracker, "apply", "正在应用远端配置");
  const applied = applyVps(plan.registryPath, cliOptions);

  writeRunning(tracker, "verify-result", "正在确认远端结果");
  let after: RemoteSnapshot | undefined;
  let readError: unknown;
  try {
    after = readRemote(tracker, registry);
  } catch (error) {
    readError = error;
  }

  if (!applied.ok) {
    if (!after) {
      throw new EdgeError(
        `edgectl apply-vps 失败（exit ${applied.code ?? "?"}），且无法读取远端确认状态：` +
          `${messageOf(readError)}。本地备份：${path.basename(backup)}。`,
      );
    }
    if (after.sha === plan.remoteRawSha) {
      if (tracker.lastFailure) tracker.lastFailure.remoteSha = after.sha;
      throw new EdgeError(
        `edgectl apply-vps 失败（exit ${applied.code ?? "?"}）；远端未发生变化，保持原状。` +
          (applied.stderr || applied.stdout ? `（${applied.stderr || applied.stdout}）` : ""),
      );
    }
    if (after.sha === expectedSha) {
      writeRunning(tracker, "activate", "内容已写入，正在激活");
      const detail = activateWithRetry(tracker, registry);
      if (detail) {
        throw new EdgeError(
          `远端已写入目标内容，但 ${detail}。本地备份：${path.basename(backup)}。`,
        );
      }
      return "apply-vps 失败，但目标内容已写入并通过 validate/reload 激活。";
    }
    const unknown = saveUnknown(tracker, after.content);
    tracker.lastFailure = {
      ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
      remoteSha: after.sha,
      unknown: path.basename(unknown),
    };
    throw new EdgeError(
      `edgectl apply-vps 失败且远端内容未知（sha ${after.sha}）；` +
        `未覆盖，已保存到 ${path.basename(unknown)}。`,
    );
  }

  // apply-vps 成功：必须确认远端确实等于 expected，否则不记成功。
  if (!after) {
    throw new EdgeError(
      `apply-vps 成功但无法读取远端确认结果：${messageOf(readError)}。需人工核对。`,
    );
  }
  if (after.sha === expectedSha) {
    return "边缘配置已应用。";
  }
  const unknown = saveUnknown(tracker, after.content);
  tracker.lastFailure = {
    ...(tracker.lastFailure ?? { jobId: tracker.request.jobId }),
    remoteSha: after.sha,
    unknown: path.basename(unknown),
  };
  throw new EdgeError(
    `apply-vps 返回成功，但远端内容与期望不一致（sha ${after.sha}）；` +
      `已保存快照到 ${path.basename(unknown)}，需人工确认。`,
  );
}

async function runRestoreJob(tracker: JobTracker): Promise<string> {
  const configPath = tracker.ctx.paths.configPath;
  if (!configPath) throw new EdgeError("未配置 edgectl 配置路径，无法恢复。");
  let registry: EdgeRegistry;
  try {
    registry = (tracker.deps.readRegistryFn ?? readRegistry)(configPath);
  } catch (error) {
    throw new EdgeError(`读取注册表失败：${messageOf(error)}`);
  }
  let secrets: EdgeSecrets;
  try {
    secrets = (tracker.deps.loadSecretsFn ?? loadEdgeSecrets)({
      registry,
      env: tracker.ctx.env,
    });
  } catch (error) {
    throw new EdgeError(`读取 dev 认证密钥失败：${messageOf(error)}`);
  }
  tracker.secrets = secrets;

  const backupName = tracker.request.backup ?? "";
  if (!isAllowedEdgeBackupName(backupName)) {
    throw new EdgeError(
      "备份文件名不合法（只接受 edge-backup-*.Caddyfile 或 edge-unknown-*.Caddyfile）。",
    );
  }
  const backupFile = path.join(tracker.ctx.configDir, backupName);
  let backupStat: fs.Stats;
  try {
    backupStat = fs.lstatSync(backupFile);
  } catch {
    throw new EdgeError("找不到指定的备份文件。");
  }
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new EdgeError("备份文件不是普通文件。");
  }
  let backupContent: string;
  try {
    backupContent = fs.readFileSync(backupFile, "utf8");
  } catch (error) {
    throw new EdgeError(`读取备份失败：${messageOf(error)}`);
  }
  // 备份内容 sha 由服务器计算并记录，用户只需提供当前远端 sha。
  const backupSha = sha256Hex(backupContent);
  const lastFailure: EdgeLastFailure = {
    jobId: tracker.request.jobId,
    backup: backupName,
    backupSha,
    ...(tracker.request.remoteSha ? { remoteSha: tracker.request.remoteSha } : {}),
  };
  tracker.lastFailure = lastFailure;

  writeRunning(tracker, "verify-remote", "正在复核远端状态");
  const current = readRemote(tracker, registry);
  if (tracker.request.remoteSha && current.sha !== tracker.request.remoteSha) {
    lastFailure.remoteSha = current.sha;
    throw new EdgeError(
      "远端 Caddyfile 与 remoteSha 不一致（可能已被修改），未写入；请刷新后重试。",
    );
  }

  writeRunning(tracker, "validate-backup", "正在校验备份内容");
  const check = tracker.remote.caddyValidateCandidate(
    registry,
    backupContent,
    tracker.request.jobId,
    remoteOptions(tracker),
  );
  if (!check.result.ok) {
    throw new EdgeError(
      `备份内容未通过 Caddy 校验，未写入远端：${check.result.stderr || check.result.stdout || "无输出"}`,
    );
  }

  // 写入前紧邻再读一次 sha，避免 validate 期间的漂移。
  writeRunning(tracker, "recheck", "正在写入前再次确认远端");
  const before = readRemote(tracker, registry);
  if (tracker.request.remoteSha && before.sha !== tracker.request.remoteSha) {
    lastFailure.remoteSha = before.sha;
    throw new EdgeError(
      "远端 Caddyfile 在恢复前与 remoteSha 不一致，未写入；请刷新后重试。",
    );
  }

  // 保存最新远端内容，reload 失败时用来自动回滚。
  const checkpoint = saveUnknown(tracker, before.content);
  lastFailure.unknown = path.basename(checkpoint);

  writeRunning(tracker, "write", "正在写入备份内容");
  const written = tracker.remote.writeRemoteFileInPlace(
    registry,
    backupContent,
    remoteOptions(tracker),
  );
  if (!written.ok) {
    throw new EdgeError(
      `写入远端失败：${written.stderr || written.stdout || "无输出"}`,
    );
  }

  writeRunning(tracker, "reload", "正在重新加载 Caddy");
  const reload = tracker.remote.caddyReload(registry, remoteOptions(tracker));
  if (reload.ok) {
    removeIfExists(checkpoint);
    return "已恢复备份并重新加载。";
  }

  // 第一次 reload 失败：回写当前内容并再次 validate/reload。
  writeRunning(tracker, "rollback", "reload 失败，正在回写原内容");
  const rollback = tracker.remote.writeRemoteFileInPlace(
    registry,
    before.content,
    remoteOptions(tracker),
  );
  if (!rollback.ok) {
    throw new EdgeError(
      `reload 失败，且回写原内容失败：${rollback.stderr || rollback.stdout || "无输出"}；` +
        `现场已保存到 ${path.basename(checkpoint)}。`,
    );
  }
  const live = tracker.remote.caddyValidateLive(registry, remoteOptions(tracker));
  const reload2 = live.ok
    ? tracker.remote.caddyReload(registry, remoteOptions(tracker))
    : live;
  if (!reload2.ok) {
    throw new EdgeError(
      `恢复失败：reload 失败，回写后再次 validate/reload 仍失败；` +
        `原始内容已写入但可能未生效，现场保存到 ${path.basename(checkpoint)}。`,
    );
  }
  removeIfExists(checkpoint);
  delete lastFailure.unknown;
  throw new EdgeError("恢复失败（reload 报错），已回写原始内容并重新加载。");
}

/**
 * 执行一个 edge 作业（由 detached edge-job 调用；测试也可直接调用）。
 * 永远返回 EdgeJob，不抛异常。
 */
async function runReclaimJob(tracker: JobTracker): Promise<string> {
  const jobIds = tracker.request.reclaimJobId ? [tracker.request.reclaimJobId] : [];
  writeRunning(tracker, "cleanup", "正在清理残留进程");
  let cleaned: OpsLockResult;
  try {
    cleaned = tracker.ops.cleanup(tracker.ctx.configDir, {
      jobIds,
      timeoutSeconds: 20,
    });
  } catch (error) {
    throw new EdgeError(`清理残留失败：${messageOf(error)}`);
  }
  if (!cleaned.ok && cleaned.code === "busy") {
    throw new EdgeError("有活跃任务持有 ops lock，无法回收。");
  }

  writeRunning(tracker, "force-reclaim", "正在强制回收");
  let reclaimed: OpsLockResult;
  try {
    reclaimed = tracker.ops.forceReclaim(tracker.ctx.configDir, "RECLAIM", {
      timeoutSeconds: 20,
    });
  } catch (error) {
    throw new EdgeError(`强制回收失败：${messageOf(error)}`);
  }
  if (!reclaimed.ok) {
    if (reclaimed.code === "residual") {
      tracker.remainingPids = reclaimed.remainingPids ?? [];
      throw new EdgeError(
        `仍有残留进程（${tracker.remainingPids.join("、") || "未知"}），暂时无法回收。`,
      );
    }
    if (reclaimed.code === "phrase-mismatch") {
      throw new EdgeError("确认短语不匹配。");
    }
    throw new EdgeError(`强制回收失败：${reclaimed.message ?? reclaimed.code}`);
  }
  const count = reclaimed.cleanedPids?.length ?? 0;
  // 日志不写绝对 root。
  appendEdgeLog(tracker.ctx.configDir, `reclaim ok root=<configDir> cleaned=${count}\n`);
  return `已回收 ops lock（清理 ${count} 个残留进程）。`;
}

export async function runEdgeJob(
  configDir: string,
  request: EdgeJobRequest,
  deps: EdgeActionDeps,
): Promise<EdgeJob> {
  const tracker = trackerOf(configDir, request, deps);
  try {
    cleanupEdgeBackups(configDir, {
      now: deps.now?.(),
      ...(request.kind === "restore" && request.backup
        ? { exclude: [request.backup] }
        : {}),
    });
  } catch {
    // 清理失败不阻塞。
  }
  writeRunning(tracker, "prepare", "edge 作业已启动");

  try {
    let message: string;
    if (request.kind === "apply") {
      message = await runApplyJob(tracker);
    } else if (request.kind === "restore") {
      message = await runRestoreJob(tracker);
    } else {
      message = await runReclaimJob(tracker);
    }

    removeIfExists(path.join(configDir, backupFileName(request.jobId)));
    // 成功：清理请求；apply/restore 同时删除计划，reclaim 保留计划。
    try {
      deleteEdgeRequest(configDir);
    } catch {
      // ignore
    }
    if (request.kind !== "reclaim") {
      try {
        deletePlan(configDir);
      } catch {
        // ignore
      }
      clearLastFailure(configDir);
    }
    return finishJob(tracker, "success", "done", message);
  } catch (error) {
    if (tracker.lastFailure) recordLastFailure(configDir, tracker.lastFailure);
    const message = redactText(messageOf(error), tracker.secrets ?? null);
    return finishJob(tracker, "failed", tracker.step, message);
  }
}
