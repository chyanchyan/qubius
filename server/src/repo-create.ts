import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 1_000_000;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// 仓库名称会拼进路径，不能带分隔符或控制字符。
const INVALID_NAME_RE = /[/\\\u0000-\u001f\u007f]/;

/** 新建仓库失败；status 直接映射成 HTTP 状态码。 */
export class RepoCreateError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "RepoCreateError";
  }
}

/**
 * 从仓库名称推导项目 id：小写，非字母数字压成连字符。
 * 推不出合法 id（例如纯中文名称）时返回 null，由调用方生成兜底 id。
 */
export function projectIdFromName(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return PROJECT_ID_RE.test(slug) ? slug : null;
}

/** 校验仓库名称并解析目标目录；目录必须不存在，母目录必须已存在。 */
export function resolveNewRepoPath(parent: string, name: string): string {
  const repoName = name.trim();
  if (!repoName) throw new RepoCreateError("仓库名称不能为空");
  if (repoName === "." || repoName === ".." || INVALID_NAME_RE.test(repoName)) {
    throw new RepoCreateError("仓库名称不能包含路径分隔符或控制字符");
  }
  const parentDir = path.resolve(parent);
  let parentIsDir = false;
  try {
    parentIsDir = fs.statSync(parentDir).isDirectory();
  } catch {
    parentIsDir = false;
  }
  if (!parentIsDir) throw new RepoCreateError(`母目录不存在：${parentDir}`);
  const target = path.join(parentDir, repoName);
  if (fs.existsSync(target)) throw new RepoCreateError(`目录已存在：${target}`, 409);
  return target;
}

/**
 * 在空目录里 `git init` 并提交一个空初始提交，让仓库立刻能建 worktree
 * （没有提交的仓库 `git worktree add ... HEAD` 会失败）。
 * 任一步失败都会删掉刚创建的目录，不在磁盘上留下半成品。
 */
export async function createGitRepo(target: string): Promise<void> {
  try {
    fs.mkdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RepoCreateError(`目录已存在：${target}`, 409);
    }
    throw new RepoCreateError(`无法创建目录 ${target}：${messageOf(error)}`);
  }
  try {
    await exec("git", ["init", "-q", "-b", "main"], {
      cwd: target,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    // 有些环境全局开启 commit.gpgsign，没有可用签名 key 时初始提交会失败。
    await exec(
      "git",
      ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "初始化仓库"],
      {
        cwd: target,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new RepoCreateError(`创建 git 仓库失败：${gitMessageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitMessageOf(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer } | undefined)?.stderr;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  if (text) return text;
  return messageOf(error);
}
