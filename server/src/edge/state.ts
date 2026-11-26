import fs from "node:fs";
import path from "node:path";

import { isJobState, jobTimestamp, type JobState } from "../job-state.js";
import { redactText } from "./cli.js";
import type { EdgeSecrets, OpsLockResult } from "./types.js";

/**
 * edge 作业状态与日志。
 *
 * - `<deployConfigDir>/edge.json`：0600，temp+rename 原子写。读改写保留其它
 *   顶层键（例如 forceReclaims 审计），损坏时返回 null 而不是抛异常。
 * - `<deployConfigDir>/edge.log`：0600，append；读取时只取末尾（默认 64KB/60 行）
 *   并再次脱敏。
 * - 时间统一 ISO 字符串；D1 的 `writeOpsMeta` 返回 epoch 秒，用
 *   `epochSecondsToIso` / `opsMetaTimes` 转换。
 */

export type EdgeJobKind = "plan" | "apply" | "restore" | "reclaim";
/** 与 job-state.ts 的共享状态契约一致。 */
export type EdgeJobState = JobState;

/** 与 web/src/api-edge.ts 的 EdgeJob 对齐。 */
export interface EdgeJob {
  jobId: string;
  state: EdgeJobState;
  kind: EdgeJobKind;
  step: string;
  message: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  logTail?: string;
  remainingPids?: number[];
}

/** edge.json 的顶层结构；保留未知键，避免覆盖 forceReclaims 等。 */
export type EdgeStateRecord = Record<string, unknown> & {
  job?: EdgeJob;
};

const JOB_KINDS = new Set<EdgeJobKind>(["plan", "apply", "restore", "reclaim"]);

export const EDGE_STATE_FILE = "edge.json";
export const EDGE_LOG_FILE = "edge.log";
export const EDGE_LOG_TAIL_BYTES = 64 * 1024;
export const EDGE_LOG_TAIL_LINES = 60;

export function edgeStateFile(configDir: string): string {
  return path.join(configDir, EDGE_STATE_FILE);
}

export function edgeLogFile(configDir: string): string {
  return path.join(configDir, EDGE_LOG_FILE);
}

/** 当前时间；委托共享契约的 jobTimestamp（秒精度，与 shell 侧一致）。 */
export function isoNow(): string {
  return jobTimestamp();
}

/** epoch 秒（可含小数）→ ISO 字符串；null/非法返回 null。 */
export function epochSecondsToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  try {
    return new Date(value * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * D1 `writeOpsMeta` 返回的 startedAt/finishedAt 是 epoch 秒；转换成 ISO。
 * 缺失的 startedAt 保持 null，由调用方决定 fallback。
 */
export function opsMetaTimes(
  meta: Pick<OpsLockResult, "startedAt" | "finishedAt">,
): { startedAt: string | null; finishedAt: string | null } {
  return {
    startedAt: epochSecondsToIso(meta.startedAt),
    finishedAt: epochSecondsToIso(meta.finishedAt),
  };
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

/** 读取 edge.json；不存在或损坏返回 null。 */
export function readEdgeState(configDir: string): EdgeStateRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(edgeStateFile(configDir), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as EdgeStateRecord;
}

/** 覆盖写 edge.json（0600 原子写）。 */
export function writeEdgeState(configDir: string, state: EdgeStateRecord): void {
  writeAtomic(edgeStateFile(configDir), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

/**
 * 读改写 edge.json：保留其它顶层键，mutator 可原地修改或返回新对象。
 * 文件损坏视为空对象，避免一次坏文件永久阻塞。
 */
export function updateEdgeState(
  configDir: string,
  mutator: (state: EdgeStateRecord) => EdgeStateRecord | void,
): EdgeStateRecord {
  const state = readEdgeState(configDir) ?? {};
  const next = mutator(state) ?? state;
  writeEdgeState(configDir, next);
  return next;
}

/**
 * 写入/更新当前 edge 作业，保留其它键。
 * 传入 secrets 时对 step/message/logTail 脱敏，避免日志/错误里带出密钥或
 * URL user:pass 后落盘。
 */
export function writeEdgeJob(
  configDir: string,
  job: EdgeJob,
  secrets?: EdgeSecrets | string[] | null,
): EdgeStateRecord {
  const safe: EdgeJob = {
    ...job,
    step: redactText(job.step, secrets),
    message: redactText(job.message, secrets),
    ...(job.logTail === undefined
      ? {}
      : { logTail: redactText(job.logTail, secrets) }),
  };
  return updateEdgeState(configDir, (state) => {
    state.job = safe;
    return state;
  });
}

function asJob(value: unknown): EdgeJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.jobId !== "string") return null;
  const state = record.state;
  if (!isJobState(state)) return null;
  const kind = record.kind;
  if (typeof kind !== "string" || !JOB_KINDS.has(kind as EdgeJobKind)) return null;
  const pid =
    typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null;
  const remainingPids = Array.isArray(record.remainingPids)
    ? record.remainingPids.filter(
        (pid): pid is number => typeof pid === "number" && Number.isInteger(pid),
      )
    : undefined;
  const job: EdgeJob = {
    jobId: record.jobId,
    state,
    kind: kind as EdgeJobKind,
    step: typeof record.step === "string" ? record.step : "",
    message: typeof record.message === "string" ? record.message : "",
    pid,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null,
  };
  if (typeof record.logTail === "string") job.logTail = record.logTail;
  if (remainingPids !== undefined) job.remainingPids = remainingPids;
  return job;
}

/**
 * 读取当前 edge 作业；不存在/损坏/字段非法返回 null。
 * 兼容两种结构：`{ job: {...} }` 或直接是作业对象（旧/手工文件）。
 */
export function readEdgeJob(configDir: string): EdgeJob | null {
  const state = readEdgeState(configDir);
  if (!state) return null;
  const nested = asJob(state.job);
  if (nested) return nested;
  return asJob(state);
}

/** append 到 edge.log（0600，自动创建）；写入前脱敏。 */
export function appendEdgeLog(
  configDir: string,
  text: string,
  secrets?: EdgeSecrets | string[] | null,
): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = edgeLogFile(configDir);
  const redacted = redactText(text, secrets);
  fs.appendFileSync(file, redacted, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 不能 chmod 时至少保留了创建时的 0600。
  }
}

export interface ReadEdgeLogOptions {
  secrets?: EdgeSecrets | string[] | null;
  lines?: number;
  bytes?: number;
}

interface EdgeTailCacheEntry {
  size: number;
  mtimeMs: number;
  maxBytes: number;
  maxLines: number;
  secretsKey: string;
  value: string | undefined;
}

/**
 * 状态接口每 2s 轮询一次。按 (size, mtimeMs, lines/bytes, secrets) 缓存脱敏后的
 * 日志尾；追加/轮转（size/mtime 变化）或密钥变化后自动失效。
 */
const edgeTailCache = new Map<string, EdgeTailCacheEntry>();

/** 参与脱敏的密钥版本；密钥变化时必须重算脱敏结果。 */
function secretsVersion(secrets: ReadEdgeLogOptions["secrets"]): string {
  if (!secrets) return "";
  if (Array.isArray(secrets)) return JSON.stringify(["list", secrets]);
  return JSON.stringify(["obj", secrets.passwordHash, secrets.cookieSecret]);
}

/** 读取 edge.log 末尾（默认 64KB/60 行），并再次脱敏。 */
export function readEdgeLogTail(
  configDir: string,
  options: ReadEdgeLogOptions = {},
): string | undefined {
  const file = edgeLogFile(configDir);
  const maxBytes = options.bytes ?? EDGE_LOG_TAIL_BYTES;
  const maxLines = options.lines ?? EDGE_LOG_TAIL_LINES;
  const secretsKey = secretsVersion(options.secrets);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    edgeTailCache.delete(file);
    return undefined;
  }
  const cached = edgeTailCache.get(file);
  if (
    cached !== undefined &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.maxBytes === maxBytes &&
    cached.maxLines === maxLines &&
    cached.secretsKey === secretsKey
  ) {
    return cached.value;
  }
  const size = stat.size;
  let fd: number | undefined;
  try {
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) {
      edgeTailCache.set(file, {
        size,
        mtimeMs: stat.mtimeMs,
        maxBytes,
        maxLines,
        secretsKey,
        value: undefined,
      });
      return undefined;
    }
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, buffer, 0, length, start);
    if (read <= 0) {
      edgeTailCache.delete(file);
      return undefined;
    }
    const parts = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
    if (start > 0) parts.shift();
    while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    const text = redactText(parts.slice(-maxLines).join("\n").trim(), options.secrets);
    const value = text || undefined;
    edgeTailCache.set(file, {
      size,
      mtimeMs: stat.mtimeMs,
      maxBytes,
      maxLines,
      secretsKey,
      value,
    });
    return value;
  } catch {
    edgeTailCache.delete(file);
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

/** 当前作业 + 日志尾部；供 D2b 组装 API 响应。 */
export function readEdgeJobWithLog(
  configDir: string,
  options: ReadEdgeLogOptions = {},
): EdgeJob | null {
  const job = readEdgeJob(configDir);
  if (!job) return null;
  const logTail = readEdgeLogTail(configDir, options);
  if (logTail) job.logTail = logTail;
  return job;
}
