import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { writeFileAtomic } from "./atomic-file.js";
import type { AppConfig } from "./config.js";
import { isJobState, jobTimestamp, type JobState } from "./job-state.js";

export type SecondaryAction = "sync" | "rollback";
/** 共享契约状态 + `idle`（从未运行）。 */
export type SecondaryState = "idle" | JobState;

/** 副实例相对主实例某分支的位置。 */
export type PrimaryRelation = "up-to-date" | "behind" | "diverged" | "unknown";

/** 主实例分支与副实例当前提交的对比；只读，不触发 fetch。 */
export interface PrimaryComparison {
  /** 主实例上用于同步的分支。 */
  ref: string;
  /** 主实例该分支的最新提交（短 sha）。 */
  head?: string;
  relation: PrimaryRelation;
  /** 主实例领先的提交数。 */
  behind?: number;
  /** 分叉时副实例独有的提交数。 */
  ahead?: number;
  /** 主实例最新提交的标题。 */
  subject?: string;
  /** 主实例最新提交的时间（ISO 8601）。 */
  committedAt?: string;
  /** 需要同步的改动规模。 */
  files?: number;
  insertions?: number;
  deletions?: number;
  /** package-lock.json 有变化，同步时会重装依赖。 */
  depsChanged?: boolean;
  /** 主实例有已跟踪文件的未提交改动；这些内容不会被同步。 */
  dirty?: boolean;
  /** 待同步的提交，最新在前（最多 5 个）。 */
  commits?: { sha: string; subject: string }[];
  /** relation 为 unknown 时的原因。 */
  reason?: string;
}

export interface SecondaryStatus {
  state: SecondaryState;
  action?: SecondaryAction;
  jobId?: string;
  currentHead?: string;
  previousHead?: string | null;
  from?: string | null;
  to?: string | null;
  message?: string;
  pid?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  logTail?: string;
  /** 主实例当前版本与差距；拿不到时 relation 为 unknown。 */
  primary?: PrimaryComparison;
  /** 副实例当前分支；同步要求 main。 */
  branch?: string;
  /** 副实例工作区有未提交改动（含未跟踪文件），同步会失败。 */
  dirty?: boolean;
  /** 正在运行的服务所用构建的提交（短 sha）。 */
  runningHead?: string;
  /** 回滚目标的提交标题。 */
  previousSubject?: string;
}

/** secondary.json 的状态词汇：共享契约 + idle。 */
function isSecondaryState(value: unknown): value is SecondaryState {
  return value === "idle" || isJobState(value);
}

function statusFile(dataDir: string): string {
  return path.join(dataDir, "secondary.json");
}

function logFile(dataDir: string): string {
  return path.join(dataDir, "secondary.log");
}

function readStored(dataDir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusFile(dataDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
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

const HEAD_CACHE_MS = 2_000;
const TAIL_BYTES = 64 * 1024;
let headCache: { repoRoot: string; at: number; value: string } | null = null;

function currentHead(repoRoot: string): string {
  const now = Date.now();
  if (headCache && headCache.repoRoot === repoRoot && now - headCache.at < HEAD_CACHE_MS) {
    return headCache.value;
  }
  let value = "";
  try {
    value = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    value = "";
  }
  // 空结果也缓存，避免 git 不可用时每秒轮询都同步执行一次。
  headCache = { repoRoot, at: now, value };
  return value;
}

const COMPARE_CACHE_MS = 10_000;
let compareCache: { key: string; at: number; value: PrimaryComparison } | null = null;

const REPO_STATE_CACHE_MS = 5_000;
let repoStateCache: { repoRoot: string; at: number; value: { branch?: string; dirty?: boolean } } | null = null;

/** 副实例自己的分支和工作区状态，与 secondary.sh 开头的检查保持一致。 */
function repoState(repoRoot: string): { branch?: string; dirty?: boolean } {
  const now = Date.now();
  if (repoStateCache && repoStateCache.repoRoot === repoRoot && now - repoStateCache.at < REPO_STATE_CACHE_MS) {
    return repoStateCache.value;
  }
  const branch = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const status = runGit(repoRoot, ["status", "--porcelain"]);
  const value = {
    branch: branch || undefined,
    // 探测失败时不标记 dirty，避免把 git 异常误报成“有未提交改动”。
    dirty: status.ok ? status.stdout.trim().length > 0 : undefined,
  };
  repoStateCache = { repoRoot, at: now, value };
  return value;
}

/** 提交标题不会变，按 (仓库, sha) 记住即可。 */
const subjectCache = new Map<string, string>();

function commitSubject(repoRoot: string, sha: string): string | undefined {
  const key = `${repoRoot}\0${sha}`;
  const cached = subjectCache.get(key);
  if (cached !== undefined) return cached || undefined;
  const result = runGit(repoRoot, ["log", "-1", "--format=%s", sha]);
  const subject = result.ok ? result.stdout.trim() : "";
  if (subjectCache.size >= 8) {
    const oldest = subjectCache.keys().next().value;
    if (oldest !== undefined) subjectCache.delete(oldest);
  }
  subjectCache.set(key, subject);
  return subject || undefined;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

/** 只读 git 调用；失败不抛错，交给调用方按 unknown 处理。 */
function runGit(repo: string, args: string[], maxBuffer = 1024 * 1024): GitResult {
  try {
    const stdout = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer,
      // 探测性命令（cat-file -e、merge-base）失败是正常分支，不要把 git 的 stderr 写进服务日志。
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    return { ok: true, stdout };
  } catch (error) {
    const failed = error as { stdout?: unknown };
    return { ok: false, stdout: typeof failed.stdout === "string" ? failed.stdout : "" };
  }
}

function hasCommit(repo: string, sha: string): boolean {
  return runGit(repo, ["cat-file", "-e", `${sha}^{commit}`]).ok;
}

function latestCommit(repo: string, sha: string): Pick<PrimaryComparison, "subject" | "committedAt"> {
  const result = runGit(repo, ["log", "-1", "--format=%cI%x00%s", sha]);
  if (!result.ok) return {};
  const [committedAt, subject] = result.stdout.replace(/\n$/, "").split("\0");
  return {
    subject: subject || undefined,
    committedAt: committedAt || undefined,
  };
}

function diffStats(
  repo: string,
  from: string,
  to: string,
): Pick<PrimaryComparison, "files" | "insertions" | "deletions" | "depsChanged"> {
  const result = runGit(repo, ["diff", "--numstat", from, to], 8 * 1024 * 1024);
  if (!result.ok) return {};
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  let depsChanged = false;
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [added = "", removed = "", ...rest] = line.split("\t");
    if (rest.length === 0) continue;
    files += 1;
    if (/^\d+$/.test(added)) insertions += Number(added);
    if (/^\d+$/.test(removed)) deletions += Number(removed);
    if (rest.join("\t") === "package-lock.json") depsChanged = true;
  }
  return { files, insertions, deletions, depsChanged };
}

/** 待同步提交的标题，最新在前。 */
function recentCommits(repo: string, from: string, to: string): { sha: string; subject: string }[] {
  const result = runGit(repo, ["log", "--format=%h%x00%s", "--max-count=5", `${from}..${to}`]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\0");
      return { sha, subject };
    })
    .filter((commit) => commit.sha);
}

/**
 * 比较副实例 HEAD 与主实例同步分支。
 * 正常情况下副实例的提交一定是主实例分支的祖先，所以直接在主实例仓库里数
 * `HEAD..主实例分支` 即可，不需要 fetch，也不会改动任何 ref。
 */
export function computePrimaryComparison(
  primaryRepo: string,
  ref: string,
  repoRoot: string,
): PrimaryComparison {
  const result: PrimaryComparison = { ref, relation: "unknown" };
  if (!primaryRepo) {
    result.reason = "未配置主实例仓库";
    return result;
  }
  if (!fs.existsSync(primaryRepo)) {
    result.reason = "找不到主实例仓库";
    return result;
  }

  const resolved = runGit(primaryRepo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const primaryHead = resolved.ok ? resolved.stdout.trim().split("\n")[0] ?? "" : "";
  if (!primaryHead) {
    result.reason = `主实例没有分支 ${ref}`;
    return result;
  }
  result.head = primaryHead.slice(0, 8);
  Object.assign(result, latestCommit(primaryRepo, primaryHead));
  // 只看已跟踪文件：未跟踪的构建产物/临时文件不算“未提交改动”，避免长期误报。
  const primaryStatus = runGit(primaryRepo, ["status", "--porcelain", "--untracked-files=no"]);
  if (primaryStatus.ok) result.dirty = primaryStatus.stdout.trim().length > 0;

  const secondaryFull = runGit(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
  if (!secondaryFull) {
    result.reason = "读不到副实例当前提交";
    return result;
  }
  if (secondaryFull === primaryHead) {
    result.relation = "up-to-date";
    result.behind = 0;
    return result;
  }

  // 选一个同时拥有两个提交的仓库：优先主实例仓库，其次副实例仓库（fetch 过但没同步成功时）。
  let repo = "";
  if (hasCommit(primaryRepo, secondaryFull)) repo = primaryRepo;
  else if (hasCommit(repoRoot, primaryHead)) repo = repoRoot;
  if (!repo) {
    result.reason = "副实例本地缺少主实例的新提交，无法比较";
    return result;
  }

  const behindResult = runGit(repo, ["rev-list", "--count", `${secondaryFull}..${primaryHead}`]);
  const behind = behindResult.ok ? Number.parseInt(behindResult.stdout.trim(), 10) : Number.NaN;
  if (Number.isFinite(behind)) result.behind = behind;

  if (runGit(repo, ["merge-base", "--is-ancestor", secondaryFull, primaryHead]).ok) {
    result.relation = Number.isFinite(behind) && behind > 0 ? "behind" : "up-to-date";
    if (result.relation === "behind") {
      Object.assign(result, diffStats(repo, secondaryFull, primaryHead));
      result.commits = recentCommits(repo, secondaryFull, primaryHead);
    }
    return result;
  }

  result.relation = "diverged";
  const aheadResult = runGit(repo, ["rev-list", "--count", `${primaryHead}..${secondaryFull}`]);
  const ahead = aheadResult.ok ? Number.parseInt(aheadResult.stdout.trim(), 10) : Number.NaN;
  if (Number.isFinite(ahead)) result.ahead = ahead;
  return result;
}

function comparePrimary(config: AppConfig, repoRoot: string, secondaryHead: string): PrimaryComparison {
  const key = `${config.secondary?.primaryRepo ?? ""}\0${config.secondary?.primaryRef ?? ""}\0${secondaryHead}`;
  const now = Date.now();
  if (compareCache && compareCache.key === key && now - compareCache.at < COMPARE_CACHE_MS) {
    return compareCache.value;
  }
  let value: PrimaryComparison;
  try {
    const secondaryConfig = config.secondary;
    value = secondaryConfig
      ? computePrimaryComparison(secondaryConfig.primaryRepo, secondaryConfig.primaryRef, repoRoot)
      : { ref: config.secondary?.primaryRef ?? "main", relation: "unknown", reason: "未配置主实例仓库" };
  } catch {
    value = { ref: config.secondary?.primaryRef ?? "main", relation: "unknown", reason: "比较主实例版本失败" };
  }
  compareCache = { key, at: now, value };
  return value;
}

function tail(file: string, lines = 40): string | undefined {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return undefined;
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, buffer, 0, length, start);
    if (read <= 0) return undefined;
    const parts = buffer.subarray(0, read).toString("utf8").split(/\r?\n/);
    // 从文件中间开始读时，第一行可能被截断，丢掉它。
    if (start > 0) parts.shift();
    const text = parts.slice(-lines).join("\n").trim();
    return text || undefined;
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

export function readSecondaryStatus(
  config: AppConfig,
  repoRoot: string,
  runningHead?: string,
): SecondaryStatus | null {
  if (config.role !== "secondary") return null;
  const stored = readStored(config.dataDir) ?? {};
  const state: SecondaryState = isSecondaryState(stored.state) ? stored.state : "idle";
  const head = currentHead(repoRoot);
  const local = repoState(repoRoot);
  const previousHead = typeof stored.previousHead === "string" && stored.previousHead ? stored.previousHead : null;
  return {
    state,
    action: stored.action === "sync" || stored.action === "rollback" ? stored.action : undefined,
    jobId: typeof stored.jobId === "string" ? stored.jobId : undefined,
    currentHead: head,
    primary: comparePrimary(config, repoRoot, head),
    branch: local.branch,
    dirty: local.dirty,
    runningHead: runningHead ? runningHead.slice(0, 8) : undefined,
    previousHead,
    previousSubject: previousHead ? commitSubject(repoRoot, previousHead) : undefined,
    from: typeof stored.from === "string" ? stored.from : null,
    to: typeof stored.to === "string" ? stored.to : null,
    message: typeof stored.message === "string" ? stored.message : undefined,
    pid: typeof stored.pid === "number" ? stored.pid : null,
    startedAt: typeof stored.startedAt === "string" ? stored.startedAt : null,
    finishedAt: typeof stored.finishedAt === "string" ? stored.finishedAt : null,
    logTail: tail(logFile(config.dataDir)),
  };
}

export function startSecondaryAction(
  config: AppConfig,
  repoRoot: string,
  action: SecondaryAction,
): "started" | "busy" {
  if (config.role !== "secondary" || !config.secondary) throw new Error("当前实例不是副实例");
  // deploy/secondary.sh 依赖 bash、flock、ss 和 Linux 的重启命令；Windows 和 macOS 都无法执行。
  if (process.platform === "win32" || process.platform === "darwin") {
    const platformName = process.platform === "win32" ? "Windows" : "macOS";
    throw new Error(`${platformName} 上无法自动同步：deploy/secondary.sh 依赖 bash、flock、ss 和系统重启命令，请在终端手动执行`);
  }
  const script = config.secondary.script;
  if (!fs.existsSync(script)) throw new Error(`找不到维护脚本 ${script}`);

  const stored = readStored(config.dataDir);
  const pid = stored && typeof stored.pid === "number" ? stored.pid : null;
  if (stored?.state === "running" && isAlive(pid)) return "busy";

  let child: ChildProcess;
  try {
    child = spawn("bash", [script, action], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        // 旧部署脚本读取的 RC_*，保留兼容。
        RC_REPO: repoRoot,
        RC_DATA: config.dataDir,
        RC_PORT: String(config.port),
        RC_PRIMARY_REPO: config.secondary.primaryRepo,
        RC_PRIMARY_REF: config.secondary.primaryRef,
        RC_RESTART: config.secondary.restart,
        RC_STATUS: statusFile(config.dataDir),
        RC_LOG: logFile(config.dataDir),
        RC_SERVER_LOG: path.join(config.dataDir, "remote-coder.log"),
        // 新部署脚本读取的 QUBIUS_*。
        QUBIUS_REPO_DIR: repoRoot,
        QUBIUS_CONFIG_DIR: config.configDir,
        QUBIUS_DATA_DIR: config.dataDir,
        QUBIUS_SECONDARY: "1",
        QUBIUS_PORT: String(config.port),
        QUBIUS_PRIMARY_DIR: config.secondary.primaryRepo,
        QUBIUS_PRIMARY_REF: config.secondary.primaryRef,
        QUBIUS_RESTART: config.secondary.restart,
        QUBIUS_STATUS_FILE: statusFile(config.dataDir),
        QUBIUS_SECONDARY_LOG: logFile(config.dataDir),
        QUBIUS_SERVER_LOG: path.join(config.dataDir, "qubius.log"),
        // QUBIUS_DEPLOY_LOCK 不在这里猜主实例数据目录：已由外部设置时随
        // ...process.env 原样透传，否则交给 secondary.sh 用部署侧默认值。
      },
    });
  } catch (error) {
    recordSpawnFailure(config, action, error);
    throw new Error(`无法启动维护脚本：${error instanceof Error ? error.message : String(error)}`);
  }
  // 没有 error 监听器时，spawn 失败（如 bash 不存在、脚本不可执行）会触发未处理的 error 事件并拖垮服务。
  child.on("error", (error) => recordSpawnFailure(config, action, error));
  child.unref();
  return "started";
}

function recordSpawnFailure(config: AppConfig, action: SecondaryAction, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const finishedAt = jobTimestamp();
  const stored = readStored(config.dataDir) ?? {};
  try {
    writeFileAtomic(
      statusFile(config.dataDir),
      JSON.stringify({
        // 保留 previousHead 等已有字段，避免失败时丢掉回滚目标。
        ...stored,
        state: "failed",
        action,
        // 新 jobId 让页面轮询立刻看到终态，而不是等到 180 秒超时。
        jobId: String(Date.now()),
        message: `维护脚本启动失败：${message}`,
        finishedAt,
        pid: null,
      }, null, 2),
      { mode: 0o600, backup: true },
    );
  } catch {
    // 状态文件写不进去时至少还能写日志。
  }
  try {
    fs.appendFileSync(logFile(config.dataDir), `[${finishedAt}] 维护脚本启动失败：${message}\n`);
  } catch {
    // 日志也写不了就只能放弃记录，不能让错误处理本身再抛错。
  }
}
