import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { deployConfigDir } from "../deploy.js";
import { jobTimestamp } from "../job-state.js";
import { clear as clearOpsLock } from "./opslock.js";
import { readPlan, type StoredEdgePlan } from "./plan.js";
import { writeEdgeJob, type EdgeJobKind } from "./state.js";
import { EdgeError, type EdgeRole } from "./types.js";

/**
 * edge 作业的进程/文件原语。
 *
 * - `edge-request.json`：server 原子写入（0600），detached 的 edge-job 读取。
 *   内容只含 jobId/token/计划指纹/确认域名等，不含 secrets。
 * - `spawnJob`：以 detached 方式启动 `deploy/edge-job.sh`；脚本自己 hold
 *   flock 并接管作业，server 不长期持锁。
 * - `planRunner`：把同步 spawnSync 的 `buildPlan` 放到子进程执行，避免最长
 *   30s 的远端探测阻塞 HTTP 事件循环。子进程只回传 planHash，计划正文由
 *   `buildPlan` 原子写到 `<configDir>/edge-plan.json`，父进程再从磁盘读取。
 */

export const EDGE_REQUEST_FILE = "edge-request.json";

/** server → edge-job 的请求（不含 secrets）。 */
export interface EdgeJobRequest {
  version: 1;
  kind: "apply" | "restore" | "reclaim";
  jobId: string;
  /** apply/restore 使用；reclaim 不携带 ops 标记。 */
  token?: string;
  createdAt: string;
  confirmDomain?: string;
  /** apply。 */
  planHash?: string;
  confirmExisting?: boolean;
  /** restore。remoteSha 表示“当前远端 Caddyfile 的 sha”。 */
  backup?: string;
  remoteSha?: string;
  /** reclaim：只清理这个 job 的残留。 */
  reclaimJobId?: string;
}

const SAFE_JOB_ID_RE = /^[A-Za-z0-9._-]+$/;

export function edgeRequestFile(configDir: string): string {
  return path.join(configDir, EDGE_REQUEST_FILE);
}

function writeAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能没创建成功。
    }
    throw error;
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** 校验请求结构；损坏/非法返回 null。 */
export function validateEdgeRequest(raw: unknown): EdgeJobRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (record.kind !== "apply" && record.kind !== "restore" && record.kind !== "reclaim") {
    return null;
  }
  if (!isString(record.jobId) || !SAFE_JOB_ID_RE.test(record.jobId)) return null;
  if (!isString(record.createdAt)) return null;

  if (record.kind === "reclaim") {
    if (
      record.reclaimJobId !== undefined &&
      (!isString(record.reclaimJobId) || !SAFE_JOB_ID_RE.test(record.reclaimJobId))
    ) {
      return null;
    }
    return {
      version: 1,
      kind: "reclaim",
      jobId: record.jobId,
      createdAt: record.createdAt,
      ...(isString(record.reclaimJobId) ? { reclaimJobId: record.reclaimJobId } : {}),
    };
  }

  if (!isString(record.token) || record.token.length === 0) return null;
  if (!isString(record.confirmDomain)) return null;
  if (record.kind === "apply") {
    if (!isString(record.planHash) || record.planHash.length === 0) return null;
    if (
      record.confirmExisting !== undefined &&
      typeof record.confirmExisting !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      kind: "apply",
      jobId: record.jobId,
      token: record.token,
      createdAt: record.createdAt,
      confirmDomain: record.confirmDomain,
      planHash: record.planHash,
      ...(record.confirmExisting === true ? { confirmExisting: true } : {}),
    };
  }
  if (!isString(record.backup) || record.backup.length === 0) return null;
  if (!isString(record.remoteSha) || record.remoteSha.length === 0) return null;
  return {
    version: 1,
    kind: "restore",
    jobId: record.jobId,
    token: record.token,
    createdAt: record.createdAt,
    confirmDomain: record.confirmDomain,
    backup: record.backup,
    remoteSha: record.remoteSha,
  };
}

/** 原子写请求（0600）。 */
export function writeEdgeRequest(configDir: string, request: EdgeJobRequest): string {
  const file = edgeRequestFile(configDir);
  writeAtomic(file, `${JSON.stringify(request, null, 2)}\n`, 0o600);
  return file;
}

/** 读取请求；不存在/损坏/非法返回 null。 */
export function readEdgeRequest(configDir: string): EdgeJobRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(edgeRequestFile(configDir), "utf8"));
  } catch {
    return null;
  }
  return validateEdgeRequest(parsed);
}

/**
 * detached 作业启动时确认请求属于自己：edge-request.json 是共享文件，
 * reclaim 与 apply/restore 竞争时不能被别的作业“借用”。
 */
export function verifyRequestOwnership(
  request: EdgeJobRequest,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; message: string } {
  const expectedJob = (env.QUBIUS_EDGE_JOB_ID ?? env.QUBIUS_OPS_JOB ?? "").trim();
  const expectedKind = (env.QUBIUS_EDGE_KIND ?? "").trim();
  if (expectedJob && request.jobId !== expectedJob) {
    return {
      ok: false,
      message: `请求 jobId（${request.jobId}）与当前作业（${expectedJob}）不一致，拒绝执行。`,
    };
  }
  if (expectedKind && request.kind !== expectedKind) {
    return {
      ok: false,
      message: `请求类型（${request.kind}）与当前作业（${expectedKind}）不一致，拒绝执行。`,
    };
  }
  return { ok: true };
}

/** 删除请求；不存在不报错。 */
export function deleteEdgeRequest(configDir: string): void {
  try {
    fs.unlinkSync(edgeRequestFile(configDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface SpawnJobOptions {
  /** 默认 `bash <script>`。apply/restore 使用。 */
  script?: string;
  /** 覆盖命令与参数（reclaim 直接启动 node）。 */
  command?: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 子进程 stdout/stderr 追加到这里（通常是 edge.log）。 */
  logFile: string;
}

export interface SpawnedJob {
  pid: number | null;
}

export type SpawnJobFn = (options: SpawnJobOptions) => SpawnedJob;

/**
 * spawn 失败（异步 error 事件）时写 edge.json failed 并按 token 清 pending。
 * HTTP 此时已经返回 202，前端通过 status 轮询看到失败。
 */
function recordSpawnFailure(options: SpawnJobOptions, error: Error): void {
  try {
    fs.appendFileSync(options.logFile, `启动 edge 作业失败：${error.message}\n`);
  } catch {
    // 日志写不了就只能放弃日志。
  }
  const env = options.env;
  const configDir = (
    env.QUBIUS_EDGE_CONFIG_DIR ??
    env.QUBIUS_CONFIG_DIR ??
    env.QUBIUS_OPS_ROOT ??
    ""
  ).trim();
  const jobId = (env.QUBIUS_EDGE_JOB_ID ?? env.QUBIUS_OPS_JOB ?? "").trim();
  const kind = (env.QUBIUS_EDGE_KIND ?? "apply") as EdgeJobKind;
  if (configDir && jobId) {
    const now = jobTimestamp();
    try {
      writeEdgeJob(configDir, {
        jobId,
        state: "failed",
        kind,
        step: "spawn",
        message: `任务启动失败：${error.message}`,
        pid: null,
        startedAt: now,
        finishedAt: now,
      });
    } catch {
      // 状态写不了只能依赖脚本/后续清理。
    }
  }
  const root = env.QUBIUS_OPS_ROOT;
  const token = env.QUBIUS_OPS_TOKEN;
  if (root && token) {
    try {
      clearOpsLock(root, token);
    } catch {
      // pending 会按宽限期自然过期。
    }
  }
}

/**
 * 默认 spawn：detached + stdio 指向日志文件，server 退出后作业继续。
 * detached 让作业脱离 server 的进程组；脚本内部会自行 setsid 派生的
 * ssh/docker 不带 flock fd（Node 只传 stdio），因此不会误持锁。
 */
export const defaultSpawnJob: SpawnJobFn = (options) => {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(options.logFile, "a", 0o600);
  try {
    const command = options.command ?? "bash";
    const args = options.args ?? [options.script ?? ""];
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: options.env,
    });
    // 没有监听器时 spawn 失败会触发未处理的 error 事件。
    child.on("error", (error) => recordSpawnFailure(options, error));
    child.unref();
    return { pid: child.pid ?? null };
  } finally {
    fs.closeSync(fd);
  }
};

export interface PlanRunOptions {
  role: EdgeRole;
  env: NodeJS.ProcessEnv;
  /** 子进程 cwd；用于解析 tsx（开发/测试）和相对路径。 */
  cwd: string;
  /** 仓库根目录；经 QUBIUS_EDGE_REPO_ROOT 传给子进程，供 <repo>/deploy/env 解析。 */
  repoRoot?: string;
  timeoutMs?: number;
}

export type PlanRunner = (options: PlanRunOptions) => Promise<StoredEdgePlan>;

function planModuleUrl(): string {
  const base = new URL(import.meta.url);
  const spec = base.pathname.endsWith(".ts") ? "./plan.ts" : "./plan.js";
  return new URL(spec, base).href;
}

const PLAN_BOOTSTRAP = `
const moduleUrl = process.env.QUBIUS_EDGE_PLAN_MODULE;
const role = process.env.QUBIUS_EDGE_PLAN_ROLE || "primary";
const repoRoot = process.env.QUBIUS_EDGE_REPO_ROOT || undefined;
import(moduleUrl)
  .then((mod) => mod.buildPlan({ role }, { repoRoot }))
  .then((plan) => {
    process.stdout.write(JSON.stringify({ planHash: plan.planHash }));
  })
  .catch((error) => {
    process.stderr.write((error && error.message) || String(error));
    process.exit(1);
  });
`;

/**
 * 默认 plan runner：用子进程执行 buildPlan，父进程读取落盘计划。
 *
 * 子进程只输出 planHash；计划正文由 buildPlan 原子写到磁盘。父进程校验
 * planHash 一致后再返回，避免回读到旧计划。
 */
export const defaultPlanRunner: PlanRunner = (options) => {
  const configDir = deployConfigDir(options.env);
  const isTs = import.meta.url.endsWith(".ts");
  const args: string[] = [];
  if (isTs) args.push("--import", "tsx");
  args.push("--input-type=module", "--eval", PLAN_BOOTSTRAP);
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    QUBIUS_EDGE_PLAN_MODULE: planModuleUrl(),
    QUBIUS_EDGE_PLAN_ROLE: options.role,
    ...(options.repoRoot ? { QUBIUS_EDGE_REPO_ROOT: options.repoRoot } : {}),
  };
  const timeoutMs = options.timeoutMs ?? 90_000;

  return new Promise<StoredEdgePlan>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64 * 1024) child.kill("SIGKILL");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new EdgeError(`生成计划失败：${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || (timedOut ? "超时" : `exit ${code ?? "?"}`);
        reject(new EdgeError(`生成计划失败：${detail}`));
        return;
      }
      let planHash: unknown;
      try {
        planHash = (JSON.parse(stdout.trim()) as { planHash?: unknown }).planHash;
      } catch {
        planHash = undefined;
      }
      if (typeof planHash !== "string") {
        reject(new EdgeError("生成计划失败：子进程输出不是合法 JSON。"));
        return;
      }
      const plan = readPlan(configDir);
      if (!plan) {
        reject(new EdgeError("生成计划失败：找不到落盘的计划文件。"));
        return;
      }
      if (plan.planHash !== planHash) {
        reject(new EdgeError("生成计划失败：计划文件与子进程结果不一致（可能已过期）。"));
        return;
      }
      resolve(plan);
    });
  });
};
