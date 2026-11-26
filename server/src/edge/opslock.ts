import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EdgeError, type OpsLockResult } from "./types.js";

/**
 * ops lock 的 Node 封装：spawnSync 调用 deploy/ops-lock.sh，解析 JSON。
 *
 * 协议要点（详见 deploy/ops-lock.sh 顶部注释）：
 *   - <root>/ops.lock 只作 flock 载体：O_CREAT 0600，永不写入 / unlink；
 *   - 元数据在 <root>/ops.meta，temp+rename 原子写；
 *   - job 自己 `exec 7<>ops.lock; flock -n 7`，运行期间持锁；子进程全部 `7>&-`；
 *   - job 在持锁期间用 mark / writeOpsMeta 写 running/终态 meta（不自取锁）；
 *   - daemon 由 start-all 的 env -u 去掉 ROOT/TOKEN/JOB/SERVER 标记。
 *
 * ROOT 一律用 realpath 规范化后再注入/比较。同一物理 configDir 的 symlink
 * 或不同写法必须得到同一个 ROOT，否则残留扫描会漏。运行中改 configDir
 * 会让旧残留的 ROOT 与新配置不一致，需要 force-reclaim。
 */

/** realpath（存在时）或绝对路径。 */
export function normalizeOpsRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** ops-lock.sh 路径；可用 QUBIUS_OPS_LOCK_SCRIPT 覆盖（测试/打包）。 */
export function opsLockScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.QUBIUS_OPS_LOCK_SCRIPT ?? "").trim();
  if (configured) return path.resolve(configured);
  return fileURLToPath(new URL("../../../deploy/ops-lock.sh", import.meta.url));
}

/**
 * 构造子进程 env：去掉从父进程继承来的 ops 标记，避免新 job 误继承过期
 * ROOT，也避免 QUBIUS_OPS_SERVER=1 让 job/子进程被残留扫描排除。
 */
function cleanOpsEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.QUBIUS_OPS_ROOT;
  delete env.QUBIUS_OPS_TOKEN;
  delete env.QUBIUS_OPS_JOB;
  delete env.QUBIUS_OPS_SERVER;
  return env;
}

/**
 * 启动 job 时使用的 env：显式覆盖 ROOT 为当前 deployConfigDir，绝不依赖
 * 继承值；同时删除继承的 QUBIUS_OPS_SERVER，保证 job 及其子进程会被当成
 * 可清理的残留而不是被排除。D2 应在 spawn 部署子进程时使用。
 */
export function opsJobEnv(
  root: string,
  token: string,
  jobId: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = cleanOpsEnv(base);
  env.QUBIUS_OPS_ROOT = normalizeOpsRoot(root);
  env.QUBIUS_OPS_TOKEN = token;
  env.QUBIUS_OPS_JOB = jobId;
  return env;
}

export interface OpsDaemonEnvOptions {
  /** true 时显式设置 QUBIUS_OPS_SERVER=1（默认不保留继承值）。 */
  server?: boolean;
}

/**
 * daemon（server 等长期进程）用的 env：删除所有继承的 ops 标记，包括
 * QUBIUS_OPS_SERVER。需要显式标记 server 时传 { server: true }。
 */
export function opsDaemonEnv(
  base: NodeJS.ProcessEnv = process.env,
  options: OpsDaemonEnvOptions = {},
): NodeJS.ProcessEnv {
  const env = cleanOpsEnv(base);
  if (options.server === true) env.QUBIUS_OPS_SERVER = "1";
  return env;
}

function parseResult(proc: SpawnSyncReturns<string>): OpsLockResult {
  const stdout = (proc.stdout ?? "").trim();
  const stderr = (proc.stderr ?? "").trim();
  if (proc.error) {
    if ((proc.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EdgeError(`找不到 bash 或 ops-lock.sh：${proc.error.message}`);
    }
    throw new EdgeError(`执行 ops-lock.sh 失败：${proc.error.message}`);
  }
  let parsed: unknown;
  try {
    parsed = stdout ? JSON.parse(stdout) : undefined;
  } catch {
    throw new EdgeError(
      `ops-lock.sh 输出不是 JSON（exit ${proc.status ?? "?"}）：${stdout || stderr || "无输出"}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EdgeError(
      `ops-lock.sh 输出缺少 JSON 对象（exit ${proc.status ?? "?"}）：${stdout || stderr || "无输出"}`,
    );
  }
  const result = parsed as OpsLockResult;
  result.exitCode = proc.status ?? undefined;
  return result;
}

export interface OpsCallOptions {
  /** 覆盖 ops-lock.sh 路径。 */
  script?: string;
  /** 覆盖脚本环境（不会继承 ops 标记）。 */
  env?: NodeJS.ProcessEnv;
  /** spawnSync 超时（毫秒），默认 60s。cleanup 可传更大。 */
  timeoutMs?: number;
  /**
   * status 专用：可解析结果的短时缓存（毫秒），默认 0（不缓存）。
   * 供同步的轮询路径降低 spawn 频率；本进程的写操作会让对应 root 的缓存失效。
   */
  cacheMs?: number;
}

/**
 * status 结果短时缓存。ops-lock.sh 调用是同步 spawnSync，而调用方
 * （readEdgeJobForApi、plan/reclaim 预检等）都是同步函数，没法改成异步
 * execFile；因此这里按短 TTL 缓存所有能解析出的 status 结果，降低重复 spawn。
 *
 * 失效边界：本进程内的写操作（claim/mark/clear/cleanup/force-reclaim）会删除
 * 对应 root 的缓存；其它进程对锁/meta 的写入不会立刻反映，最多滞后 1s。
 * 真正拿锁的 claim/job 始终实时执行，锁语义不变。
 */
const statusCache = new Map<string, { at: number; result: OpsLockResult }>();

function cloneOpsResult(result: OpsLockResult): OpsLockResult {
  return {
    ...result,
    ...(result.remainingPids ? { remainingPids: [...result.remainingPids] } : {}),
    ...(result.cleanedPids ? { cleanedPids: [...result.cleanedPids] } : {}),
  };
}

function argsRoot(args: string[]): string | null {
  const index = args.indexOf("--root");
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

/** 直接调用脚本，参数原样传入；测试/调试用。 */
export function runOpsLock(args: string[], options: OpsCallOptions = {}): OpsLockResult {
  const script = options.script ?? opsLockScriptPath(options.env ?? process.env);
  if (!fs.existsSync(script)) throw new EdgeError(`找不到 ops-lock.sh：${script}`);
  const env = cleanOpsEnv({ ...process.env, ...(options.env ?? {}) });
  const proc = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env,
    timeout: options.timeoutMs ?? 60_000,
  });
  const result = parseResult(proc);
  if (args[0] !== "status") {
    const root = argsRoot(args);
    if (root) statusCache.delete(root);
  }
  return result;
}

export interface OpsClaimOptions extends OpsCallOptions {
  root: string;
  kind: string;
  jobId: string;
  token: string;
  /** pending 宽限秒数；默认由脚本决定（120）。 */
  graceSeconds?: number;
}

/** claim：返回 ok/pending，或 ok:false + code=busy/residual。 */
export function claim(options: OpsClaimOptions): OpsLockResult {
  const args = [
    "claim",
    "--root",
    normalizeOpsRoot(options.root),
    "--kind",
    options.kind,
    "--job-id",
    options.jobId,
    "--token",
    options.token,
  ];
  if (options.graceSeconds !== undefined) args.push("--grace", String(options.graceSeconds));
  return runOpsLock(args, options);
}

export interface OpsMetaInput {
  state: "running" | "success" | "failed";
  kind: string;
  jobId: string;
  token: string;
  pid?: number;
  pgid?: number;
}

/**
 * 写 running / success / failed meta（对应 `ops-lock.sh mark`）。
 *
 * 重要：调用方必须已经持有 `<root>/ops.lock` 的 flock；本 helper/脚本
 * **不自取锁**。典型顺序（D2 的 edge-job）：
 *   exec 7<>ops.lock; flock -n 7
 *   writeOpsMeta(root, {state:"running", ...})
 *   ... 执行工作；所有 child 关闭 fd 7 ...
 *   writeOpsMeta(root, {state:"success"|"failed", ...})
 *   exit（fd 关闭即释放锁）
 * 脚本会保留 meta 里未建模字段，并原子写 0600。
 */
export function writeOpsMeta(
  root: string,
  meta: OpsMetaInput,
  options: OpsCallOptions = {},
): OpsLockResult {
  const args = [
    "mark",
    "--root",
    normalizeOpsRoot(root),
    "--state",
    meta.state,
    "--kind",
    meta.kind,
    "--job-id",
    meta.jobId,
    "--token",
    meta.token,
  ];
  if (meta.pid !== undefined) args.push("--pid", String(meta.pid));
  if (meta.pgid !== undefined) args.push("--pgid", String(meta.pgid));
  return runOpsLock(args, options);
}

export function status(root: string, options: OpsCallOptions = {}): OpsLockResult {
  const normalized = normalizeOpsRoot(root);
  const cacheMs = options.cacheMs ?? 0;
  if (cacheMs > 0) {
    const cached = statusCache.get(normalized);
    if (cached && Date.now() - cached.at < cacheMs) return cloneOpsResult(cached.result);
  }
  const result = runOpsLock(["status", "--root", normalized], options);
  if (cacheMs > 0) statusCache.set(normalized, { at: Date.now(), result: cloneOpsResult(result) });
  return result;
}

export function clear(root: string, token?: string, options: OpsCallOptions = {}): OpsLockResult {
  const args = ["clear", "--root", normalizeOpsRoot(root)];
  if (token) args.push("--token", token);
  return runOpsLock(args, options);
}

export interface OpsCleanupOptions extends OpsCallOptions {
  token?: string;
  jobIds?: string[];
  /** 已废弃的别名，等价于 timeoutSeconds（两者不要同时传）。 */
  untilSeconds?: number;
  /** TERM→KILL 的总超时秒数。 */
  timeoutSeconds?: number;
}

function cleanupTimeout(options: OpsCleanupOptions): number | undefined {
  if (options.timeoutSeconds !== undefined && options.untilSeconds !== undefined) {
    // 语义统一：以 timeoutSeconds 为准，避免两个参数互相覆盖。
    return options.timeoutSeconds;
  }
  return options.timeoutSeconds ?? options.untilSeconds;
}

export function cleanup(root: string, options: OpsCleanupOptions = {}): OpsLockResult {
  const args = ["cleanup", "--root", normalizeOpsRoot(root)];
  if (options.token) args.push("--token", options.token);
  for (const jobId of options.jobIds ?? []) args.push("--job-id", jobId);
  const timeout = cleanupTimeout(options);
  if (timeout !== undefined) args.push("--timeout", String(timeout));
  return runOpsLock(args, {
    ...options,
    timeoutMs: options.timeoutMs ?? (timeout ?? 20) * 1000 + 10_000,
  });
}

export interface OpsForceReclaimOptions extends OpsCallOptions {
  /** 清理残留的总超时秒数（默认 20）。 */
  timeoutSeconds?: number;
}

/**
 * force-reclaim 的确认短语固定为 RECLAIM（可用 OPS_FORCE_PHRASE 覆盖脚本端）。
 * 脚本会先清理 root 下的残留，确认无残留后才清 meta 并写审计；仍有残留时
 * 返回 exit 4 + remainingPids，不会宣称回收成功。
 */
export function forceReclaim(
  root: string,
  phrase: string,
  options: OpsForceReclaimOptions = {},
): OpsLockResult {
  const args = ["force-reclaim", "--root", normalizeOpsRoot(root), "--phrase", phrase];
  if (options.timeoutSeconds !== undefined) args.push("--timeout", String(options.timeoutSeconds));
  return runOpsLock(args, {
    ...options,
    timeoutMs: options.timeoutMs ?? (options.timeoutSeconds ?? 20) * 1000 + 10_000,
  });
}
