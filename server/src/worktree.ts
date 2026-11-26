import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { envCompat } from "./env.js";

const exec = promisify(execFile);

function timeoutFromEnv(name: string, fallback: number): number {
  // QUBIUS_* 优先，旧的 REMOTE_CODER_* 继续兼容。
  const value = Number(envCompat(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const PROBE_TIMEOUT_MS = 10_000;
// 大仓库首次 checkout / 删除大量文件可能超过一分钟，允许用环境变量调整。
const WORKTREE_TIMEOUT_MS = timeoutFromEnv("QUBIUS_WORKTREE_TIMEOUT_MS", 120_000);
const DIFF_TIMEOUT_MS = timeoutFromEnv("QUBIUS_DIFF_TIMEOUT_MS", 60_000);
const PROBE_MAX_BUFFER = 1_000_000;
const MAX_UNTRACKED_SHOWN = 200;
const WORKTREE_MAX_BUFFER = 2_000_000;
const DIFF_MAX_BUFFER = 10_000_000;

const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const ACCESS_TOKEN_RE = /(x-access-token:)[^\s@]+/gi;

/** 新会话的分支前缀，用产品名区分 qubius 建的分支。 */
export const SESSION_BRANCH_PREFIX = "qubius/";
/**
 * 旧版本一直用的前缀。已有会话的 worktree、分支和 git 操作还在用
 * `remote-coder/<id>`，读、写、删都要继续接受，不能只认新前缀。
 */
export const LEGACY_SESSION_BRANCH_PREFIX = "remote-coder/";
/** 产品从 Qoder 改名 Qubius 之前创建的会话分支前缀，同样要继续兼容。 */
export const RENAMED_SESSION_BRANCH_PREFIX = "qoder/";

/** 当前前缀和所有历史前缀。 */
export const SESSION_BRANCH_PREFIXES = [
  SESSION_BRANCH_PREFIX,
  RENAMED_SESSION_BRANCH_PREFIX,
  LEGACY_SESSION_BRANCH_PREFIX,
] as const;

/** 分支名是否属于 qubius 自己创建或历史遗留的会话分支。 */
export function hasSessionBranchPrefix(name: string): boolean {
  return SESSION_BRANCH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 这个会话自己的分支名。 */
export function sessionBranch(sessionId: string): string {
  return `${SESSION_BRANCH_PREFIX}${sessionId}`;
}

/**
 * 去掉 git 输出里的远端凭证：`https://user:pass@host` 和
 * `x-access-token:...` 都可能出现在 push 失败的 stderr 里。
 */
export function redactGitCredentials(text: string): string {
  return text
    .replace(URL_USERINFO_RE, "$1***@")
    .replace(ACCESS_TOKEN_RE, "$1***");
}

function gitError(error: unknown, fallback: string): Error {
  const err = error as
    | (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: string | Buffer })
    | undefined;
  if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new Error(`${fallback}：输出超过上限`);
  }
  if (err?.signal) {
    return new Error(`${fallback}：进程被终止（${err.signal}）`);
  }
  if (err?.killed) {
    return new Error(`${fallback}：进程被终止`);
  }
  const stderr = typeof err?.stderr === "string" ? redactGitCredentials(err.stderr.trim()) : "";
  if (stderr) return new Error(`${fallback}：${stderr}`);
  const message = error instanceof Error ? redactGitCredentials(error.message) : fallback;
  return new Error(`${fallback}：${message}`);
}

interface GitRepoProbeOptions {
  /** 测试可注入的探测函数；默认真正 spawn git。 */
  probe?: (dir: string) => Promise<boolean>;
  /** 测试可注入的时钟（毫秒）。 */
  now?: () => number;
  /** 结果缓存时长；默认 30 秒。 */
  ttlMs?: number;
}

const GIT_REPO_CACHE_TTL_MS = 30_000;

// /api/projects 每次请求都会对每个项目探测 git；缓存结果避免反复 spawn。
const gitRepoCache = new Map<string, { value: boolean; at: number }>();

async function probeGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** .git 在 worktree 里是文件而不是目录，用 lstat 判断存在即可。 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断目录是否在 git worktree 里。结果按绝对路径缓存一个短 TTL，
 * 避免项目列表这种高频调用反复 spawn git。
 *
 * 目录在 TTL 内消失时立即失效，确保项目被删后马上反映为不可用。
 * 可选参数仅用于测试注入，正常调用 `isGitRepo(dir)` 即可。
 */
export async function isGitRepo(dir: string, options: GitRepoProbeOptions = {}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? GIT_REPO_CACHE_TTL_MS;
  const cached = gitRepoCache.get(dir);
  if (cached && now() - cached.at < ttlMs) {
    if (cached.value && !(await isDirectory(dir))) {
      // 之前是真仓库，但目录被删了：缓存作废，不要再报 git。
      gitRepoCache.delete(dir);
      return false;
    }
    return cached.value;
  }
  if (!(await isDirectory(dir))) {
    gitRepoCache.delete(dir);
    return false;
  }
  const value = await (options.probe ?? probeGitRepo)(dir);
  gitRepoCache.set(dir, { value, at: now() });
  return value;
}

export async function createWorktree(options: {
  projectPath: string;
  projectId: string;
  sessionId: string;
  dataDir: string;
  /**
   * 起始提交（分叉用）：只接受 qubius 自己建的会话分支，且必须能解析成
   * commit；否则回退 HEAD，避免把任意分支/引用 checkout 出来。
   */
  startPoint?: string;
}): Promise<{ cwd: string; branch: string }> {
  const branch = sessionBranch(options.sessionId);
  const cwd = path.join(options.dataDir, "worktrees", options.projectId, options.sessionId);
  fs.mkdirSync(path.dirname(cwd), { recursive: true });
  if (fs.existsSync(cwd)) {
    throw new Error(`worktree 目录已存在：${cwd}`);
  }
  let base = "HEAD";
  if (options.startPoint) {
    if (await isSessionCommit(options.projectPath, options.startPoint)) {
      base = options.startPoint;
    } else {
      console.warn(
        `[worktree] 起始点不可用，回退 HEAD：${options.startPoint}（${options.projectPath}）`,
      );
    }
  }
  try {
    await exec(
      "git",
      ["-C", options.projectPath, "worktree", "add", "-b", branch, cwd, base],
      {
        windowsHide: true,
        timeout: WORKTREE_TIMEOUT_MS,
        maxBuffer: WORKTREE_MAX_BUFFER,
      },
    );
  } catch (error) {
    await removeWorktree(options.projectPath, cwd, branch, { sessionId: options.sessionId })
      .catch(() => undefined);
    throw gitError(error, "git worktree add 失败");
  }
  return { cwd, branch };
}

/**
 * 起始点是否是可用的会话分支提交。只认 qubius 自己的分支前缀，且必须能
 * 解析成 commit；任何一步失败都当作不可用（回退 HEAD）。
 */
async function isSessionCommit(projectPath: string, ref: string): Promise<boolean> {
  if (!hasSessionBranchPrefix(ref)) return false;
  try {
    await exec(
      "git",
      ["-C", projectPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER },
    );
    return true;
  } catch {
    return false;
  }
}

/* 恢复归档时只接受 qubius/、旧 qoder/ 或 remote-coder/ 下的会话分支，避免把别人的分支 checkout 出来。 */
const BRANCH_RE = /^(?:qubius|qoder|remote-coder)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 恢复归档会话的工作目录。到期清理会删除 worktree 和分支；恢复时：
 * - 分支还在就从它建 worktree，否则从 HEAD 新建同名分支；
 * - 之前的未提交改动不会回来，只恢复对话上下文。
 * 返回是否新建了目录（失败清理时用）。
 */
export async function restoreWorktree(options: {
  projectPath: string;
  cwd: string;
  branch?: string;
  sessionId: string;
}): Promise<boolean> {
  const cwd = path.resolve(options.cwd);
  const root = path.resolve(options.projectPath);
  if (cwd === root) return false;
  if (await pathExists(path.join(cwd, ".git"))) return false;
  if (await pathExists(cwd)) {
    // 上次恢复失败可能留下半个目录；清掉后重建。异步删除避免卡住事件循环。
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
  const branch = options.branch && BRANCH_RE.test(options.branch)
    ? options.branch
    : sessionBranch(options.sessionId);
  await fs.promises.mkdir(path.dirname(cwd), { recursive: true });
  let exists = false;
  try {
    await exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
    });
    exists = true;
  } catch {
    exists = false;
  }
  try {
    if (exists) {
      await exec("git", ["-C", root, "worktree", "add", cwd, branch], {
        windowsHide: true,
        timeout: WORKTREE_TIMEOUT_MS,
        maxBuffer: WORKTREE_MAX_BUFFER,
      });
    } else {
      await exec("git", ["-C", root, "worktree", "add", "-b", branch, cwd, "HEAD"], {
        windowsHide: true,
        timeout: WORKTREE_TIMEOUT_MS,
        maxBuffer: WORKTREE_MAX_BUFFER,
      });
    }
  } catch (error) {
    throw gitError(error, "恢复 worktree 失败");
  }
  return true;
}

/** 会话 id 是 UUID；删除目录前用它确认 cwd 确实是 qubius 自己建的 worktree。 */
const SESSION_ID_LAYOUT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * 目录删除遇到占用时的退避间隔。Windows 上 `git worktree remove` 会先删注册项、
 * 再递归删目录；目录里的文件还被进程占着时第二步失败，目录会留在原地。
 * 给占用进程一点退出时间，必要时再让调用方看到可重试的错误。
 */
const REMOVE_DIR_RETRY_DELAYS_MS = [100, 300, 800, 1_500];
const RETRYABLE_REMOVE_CODES = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 递归删除目录。Node 的 fs.rm 只对部分错误自动重试；Windows 上常见的
 * EACCES / EBUSY / EPERM 需要自己退避，否则一次占用就会让会话永久删不掉。
 */
export async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = REMOVE_DIR_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !code || !RETRYABLE_REMOVE_CODES.has(code)) throw error;
      console.warn(`删除目录失败（${code}），${delay}ms 后重试：${dir}`);
      await sleepMs(delay);
    }
  }
}

/**
 * 只对 qubius 的会话 worktree 布局做“直接删目录”的降级：目录名必须等于
 * 会话 id（旧数据没有 sessionId 时至少必须是 UUID）。cwd 数据损坏时不会
 * 因为这条兜底误删别的目录。
 */
function isSessionWorktreeDir(cwd: string, sessionId?: string): boolean {
  const base = path.basename(cwd);
  return sessionId ? base === sessionId : SESSION_ID_LAYOUT_RE.test(base);
}

/**
 * 删除会话的 worktree 和分支。
 *
 * `git worktree remove` 在 Windows 上不是原子操作：它先删 `.git/worktrees/<id>`
 * 注册项，再递归删工作目录。目录被 CWD/打开的文件/子进程占用时第一步已经
 * 完成、第二步失败，重试只会得到 `fatal: '…' is not a working tree`（exit 128），
 * 会话就永远卡在“删不掉”状态。所以 git 删除失败时，只要路径确认是会话
 * worktree，就降级为直接递归删目录；下一次重试可以继续收尾。
 *
 * 删除失败会抛错，调用方应保留会话以便重试。
 */
export async function removeWorktree(
  projectPath: string,
  cwd: string,
  branch?: string,
  options: { sessionId?: string } = {},
): Promise<void> {
  const target = path.resolve(cwd);
  // 防御：配置或数据损坏时 cwd 可能指向项目根，绝不能递归删除。
  if (target === path.resolve(projectPath)) {
    throw new Error(`拒绝删除项目目录本身：${target}`);
  }

  if (fs.existsSync(target)) {
    try {
      await exec("git", ["-C", projectPath, "worktree", "remove", "--force", cwd], {
        windowsHide: true,
        timeout: WORKTREE_TIMEOUT_MS,
        maxBuffer: WORKTREE_MAX_BUFFER,
      });
    } catch (error) {
      const failure = gitError(error, "git worktree remove 失败");
      if (!isSessionWorktreeDir(target, options.sessionId)) throw failure;
      // 注册项可能已经被 git 删掉（见函数注释）。直接删目录，删掉了就算成功；
      // 删不掉时把两边的原因都带给用户，保留会话以便下次重试。
      try {
        await removeDirWithRetry(target);
        console.warn(`git worktree remove 失败，已直接删除目录 ${target}：${failure.message}`);
      } catch (removeError) {
        const reason = removeError instanceof Error ? removeError.message : String(removeError);
        throw new Error(`无法删除 worktree 目录 ${target}：${reason}（git: ${failure.message}）`);
      }
    }
  }
  // 目录已经不在时顺手清掉可能残留的注册项（旧版本删一半留下的 prunable 条目）。
  // 尽力而为：仓库本身被移走/改名时这里失败不应阻塞会话删除。
  await exec("git", ["-C", projectPath, "worktree", "prune"], {
    windowsHide: true,
    timeout: WORKTREE_TIMEOUT_MS,
    maxBuffer: WORKTREE_MAX_BUFFER,
  }).catch(() => undefined);
  // 即使目录/分支清理有异常，也尝试清理分支；失败时由调用方保留可重试状态。
  if (branch) {
    await exec("git", ["-C", projectPath, "branch", "-D", branch], {
      windowsHide: true,
      timeout: WORKTREE_TIMEOUT_MS,
      maxBuffer: WORKTREE_MAX_BUFFER,
    }).catch((error) => {
      console.warn(`无法删除分支 ${branch}：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

export async function diffSummary(cwd: string, git: boolean): Promise<{ stat: string; patch: string }> {
  if (!git) return { stat: "这个目录不是 git 仓库，没有 diff。", patch: "" };
  const [unstagedStat, stagedStat, unstaged, staged, status] = await Promise.all([
    gitText(cwd, ["diff", "--stat"]),
    gitText(cwd, ["diff", "--cached", "--stat"]),
    gitText(cwd, ["diff"]),
    gitText(cwd, ["diff", "--cached"]),
    // 只读查询，不会改动 index；-z 避免文件名里的空格/引号被转义。
    // normal 会把未跟踪目录折叠成一项，避免 node_modules 之类撑爆输出。
    gitText(cwd, ["status", "--porcelain", "-z", "--untracked-files=normal"]),
  ]);
  const untracked = untrackedFiles(status);
  const shown = untracked.slice(0, MAX_UNTRACKED_SHOWN);
  const untrackedStat = shown.length > 0
    ? `未跟踪\n${shown.map((file) => ` ${file}`).join("\n")}`
      + (untracked.length > shown.length ? `\n … 还有 ${untracked.length - shown.length} 项` : "")
    : "";
  const stat = [
    stagedStat.trim() ? `已暂存\n${stagedStat.trim()}` : "",
    unstagedStat.trim() ? `未暂存\n${unstagedStat.trim()}` : "",
    untrackedStat,
  ].filter(Boolean).join("\n\n");
  const patch = [staged.trim() ? `已暂存\n${staged.trim()}` : "", unstaged.trim() ? `未暂存\n${unstaged.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");
  if (!stat && !patch) return { stat: "没有改动", patch: "" };
  return { stat: stat || "有改动", patch: clipPatch(patch) };
}

function untrackedFiles(status: string): string[] {
  return status
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter((file) => file.length > 0);
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: DIFF_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BUFFER,
      // 只读查询不要顺手刷新 index，避免和 agent 的 git 操作抢锁。
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (error) {
    return gitError(error, "git diff 失败").message;
  }
}

function clipPatch(patch: string): string {
  const max = 60_000;
  if (patch.length <= max) return patch;
  return `${patch.slice(0, max)}\n… diff 已截断`;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  dirty: string[];
}

export interface MergeStatus {
  /** 比较用的基准分支短名；仓库里找不到 main/master 时为 null。 */
  base: string | null;
  /** 已经合入基准分支的会话分支（qubius/、旧 qoder/ 与 remote-coder/）。 */
  merged: string[];
  /** 创建后从未提交过代码的会话分支：tip 仍是创建时的提交。 */
  untouched: string[];
}

/* 优先本地 main，其次 master，最后远端同名分支；按顺序取第一个存在的。 */
const MERGE_BASE_CANDIDATES = [
  { ref: "refs/heads/main", name: "main" },
  { ref: "refs/heads/master", name: "master" },
  { ref: "refs/remotes/origin/main", name: "origin/main" },
  { ref: "refs/remotes/origin/master", name: "origin/master" },
] as const;

async function readRefs(projectPath: string, refs: readonly string[]): Promise<Set<string>> {
  try {
    const { stdout } = await exec("git", ["-C", projectPath, "for-each-ref", "--format=%(refname)", ...refs], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
      // 只读查询不要刷新 index / 和 agent 的 git 操作抢锁。
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** 会话分支当前的 tip。 */
async function sessionBranchTips(projectPath: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", projectPath, "for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads/"],
      {
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const tips = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const [branch, sha] = line.split("\0");
      if (branch && sha && hasSessionBranchPrefix(branch)) tips.set(branch, sha);
    }
    return tips;
  } catch {
    return new Map();
  }
}

/**
 * 每个会话分支创建时的提交。`git worktree add -b`（以及 checkout -b）会在
 * 分支 reflog 里留下一条「branch: Created from …」；它的新提交就是创建时的
 * tip。分支后来提交过代码，tip 就和这条记录不同。
 *
 * reflog 过期（默认 90 天）或仓库关闭了 core.logAllRefUpdates 时查不到，
 * 对应的分支按「未知」处理，不会误判成从未改动。
 */
async function sessionBranchCreations(projectPath: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C",
        projectPath,
        "reflog",
        "show",
        "--all",
        "--grep-reflog=branch: Created from",
        "--format=%H%x00%gD",
      ],
      {
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const created = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const [sha, selector] = line.split("\0");
      if (!sha || !selector) continue;
      const at = selector.lastIndexOf("@{");
      if (at <= 0) continue;
      const ref = selector.slice(0, at);
      if (!ref.startsWith("refs/heads/")) continue;
      const branch = ref.slice("refs/heads/".length);
      if (hasSessionBranchPrefix(branch)) created.set(branch, sha);
    }
    return created;
  } catch {
    return new Map();
  }
}

/**
 * 项目里已经合入 main（没有 main 时退回 master / 远端同名分支）的会话分支。
 *
 * 只看分支 tip 是否已包含在基准分支里：「分支的改动是否已经在 main 上体现」
 * 等价于分支没有领先基准的提交。ttb 把 main rebase 到开发分支之后、ttbm 把
 * 开发分支 merge 进 main 之后，会话分支都会成为 main 的祖先，因此这里能覆盖
 * 两种收尾流程。未提交的工作区改动不属于分支提交，不参与判断。
 *
 * 另外报告从未提交过代码的分支（untouched）：它们同样以「已合入」出现，
 * 但没有可归档的代码改动，界面用灰灯区分，全部归档也会跳过。
 */
export async function mergedSessionBranches(projectPath: string): Promise<MergeStatus> {
  const [refs, tips, creations] = await Promise.all([
    readRefs(projectPath, MERGE_BASE_CANDIDATES.map((candidate) => candidate.ref)),
    sessionBranchTips(projectPath),
    sessionBranchCreations(projectPath),
  ]);
  const untouched = [...creations]
    .filter(([branch, createdSha]) => tips.get(branch) === createdSha)
    .map(([branch]) => branch)
    .sort();
  const base = MERGE_BASE_CANDIDATES.find((candidate) => refs.has(candidate.ref));
  if (!base) return { base: null, merged: [], untouched };
  try {
    const { stdout } = await exec(
      "git",
      ["-C", projectPath, "branch", "--merged", base.ref, "--format=%(refname:short)"],
      {
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const merged = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(hasSessionBranchPrefix)
      .sort();
    return { base: base.name, merged, untouched };
  } catch {
    // 仓库还没有提交或基准分支损坏：保守返回空列表，界面按未合入显示。
    return { base: base.name, merged: [], untouched };
  }
}

export interface GitPushResult {
  branch: string;
  committed: boolean;
  pushed: boolean;
  output: string;
}

// commit/push 是写操作，超时和输出上限都比只读查询宽松。
const GIT_ACTION_TIMEOUT_MS = 120_000;
const GIT_ACTION_MAX_BUFFER = 2_000_000;
const STATUS_MAX_BUFFER = 10_000_000;
const MAX_COMMIT_MESSAGE = 500;
const MAX_GIT_OUTPUT = 4_000;

/**
 * 只允许 commit/push 会话自己的分支；旧 qoder/ 与 remote-coder/ 会话继续可用。
 * 创建 PR/MR 前的 push 也会复用这个判断，避免把用户当前分支（如 main）推走。
 */
export function isSessionBranch(branch: string): boolean {
  return hasSessionBranchPrefix(branch);
}

async function runGit(
  cwd: string,
  args: string[],
  fallback: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: GIT_ACTION_TIMEOUT_MS,
      maxBuffer: GIT_ACTION_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    throw gitError(error, fallback);
  }
}

async function currentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], "读取当前分支失败");
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    // 还没有提交的 unborn branch 上 rev-parse 会失败，退回 branch --show-current。
  }
  const { stdout } = await runGit(cwd, ["branch", "--show-current"], "读取当前分支失败");
  const branch = stdout.trim();
  if (!branch) throw new Error("当前不在分支上");
  return branch;
}

/**
 * 解析 `git status --porcelain=v1 -z`。条目以 NUL 分隔；改名/复制条目在
 * -z 下把新路径放在条目里，旧路径作为下一个 NUL 字段跟在后面，需要跳过。
 */
function parseStatusEntries(output: string): string[] {
  const entries = output.split("\0");
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    // -z 下改名/复制的新路径就在条目里，旧路径是紧随其后的一个 NUL 字段。
    if (status.includes("R") || status.includes("C")) index += 1;
    if (file) files.push(file);
  }
  return files;
}

async function readStatusEntries(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "status", "--porcelain=v1", "-z"], {
      windowsHide: true,
      timeout: DIFF_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER,
      // 只读查询不抢 index 锁。
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return parseStatusEntries(stdout);
  } catch (error) {
    throw gitError(error, "读取 git 状态失败");
  }
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const [branch, dirty] = await Promise.all([
    currentBranch(cwd),
    readStatusEntries(cwd),
  ]);
  return { branch, clean: dirty.length === 0, dirty };
}

/**
 * 提交并可选推送。分支、提交信息和远端都在执行前校验，避免留下半完成的操作。
 * message 为空且 push 为真时表示只推送，不创建提交。
 */
export async function commitAndPush(
  cwd: string,
  options: { message: string; push: boolean },
): Promise<GitPushResult> {
  const branch = await currentBranch(cwd);
  if (!isSessionBranch(branch)) {
    throw new Error("只允许操作会话分支（qubius/、qoder/ 或 remote-coder/）");
  }

  const message = options.message.trim();
  if (message.length > MAX_COMMIT_MESSAGE) {
    throw new Error(`提交信息不能超过 ${MAX_COMMIT_MESSAGE} 字`);
  }
  const shouldCommit = message.length > 0;
  if (!shouldCommit && !options.push) {
    throw new Error("提交信息不能为空");
  }

  if (options.push) {
    try {
      await exec("git", ["-C", cwd, "remote", "get-url", "origin"], {
        windowsHide: true,
        timeout: GIT_ACTION_TIMEOUT_MS,
        maxBuffer: GIT_ACTION_MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      throw new Error("这个仓库没有 origin 远端");
    }
  }

  const chunks: string[] = [];
  let committed = false;
  let pushed = false;

  if (shouldCommit) {
    const dirty = await readStatusEntries(cwd);
    if (dirty.length === 0) throw new Error("没有可提交的改动");
    chunks.push(...outputParts(await runGit(cwd, ["add", "-A"], "git add 失败")));
    chunks.push(...outputParts(await runGit(cwd, ["commit", "-m", message], "git commit 失败")));
    committed = true;
  }

  if (options.push) {
    try {
      chunks.push(...outputParts(await runGit(cwd, ["push", "-u", "origin", "HEAD"], "git push 失败")));
    } catch (error) {
      if (committed) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`已提交但推送失败：${detail}`);
      }
      throw error;
    }
    pushed = true;
  }

  return {
    branch,
    committed,
    pushed,
    output: redactGitCredentials(chunks.join("\n").trim()).slice(0, MAX_GIT_OUTPUT),
  };
}

function outputParts(result: { stdout: string; stderr: string }): string[] {
  return [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0);
}
