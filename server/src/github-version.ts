import { execFileSync } from "node:child_process";

/** GitHub 公开镜像 main 分支的 package.json 版本，与当前运行版本做对照。 */
export interface GithubVersionState {
  /** 解析出的 owner/repo；没有 GitHub remote 或显式配置时缺省。 */
  repo?: string;
  /** 镜像里的版本号。 */
  version?: string;
  /** 当前运行构建的版本号。 */
  current?: string;
  /** GitHub 版本相对当前版本：same 一致，behind 镜像落后，ahead 镜像更新。 */
  status: "same" | "behind" | "ahead" | "unknown";
  /** 本次检查时间（ISO 8601）。 */
  checkedAt: string;
  /** 获取失败时的简短说明。 */
  error?: string;
}

const VERSION_RE = /^[0-9A-Za-z.+-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const REMOTE_PATTERNS = [
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
];

/** 从 github remote 地址解析 owner/repo；不认识的地址返回 undefined。 */
export function githubRepoFromRemote(remote: string): string | undefined {
  const value = remote.trim();
  for (const pattern of REMOTE_PATTERNS) {
    const match = value.match(pattern);
    if (match?.[1] && match[2]) return `${match[1]}/${match[2]}`;
  }
  return undefined;
}

function versionString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VERSION_RE.test(trimmed) ? trimmed : undefined;
}

function parseVersion(value: string): { core: [number, number, number]; pre?: string } | undefined {
  const match = value
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { pre: match[4] } : {}),
  };
}

/** 比较两个版本：负数表示 a 更旧，0 相同，正数表示 a 更新；无法解析返回 undefined。 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! - right.core[index]!;
  }
  if (left.pre === right.pre) return 0;
  // 同版本号下预发布低于正式版；两边都是预发布时按字符串比较，展示够用。
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function statusFor(current: string, github: string): GithubVersionState["status"] {
  const compared = compareVersions(github, current);
  if (compared === undefined) return "unknown";
  if (compared === 0) return "same";
  return compared < 0 ? "behind" : "ahead";
}

function readGithubRemote(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repoRoot, "remote", "get-url", "github"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 显式配置优先；没有 github remote 的项目也能用 QUBIUS_GITHUB_REPO=owner/repo 指定镜像。 */
function resolveRepo(repoRoot: string): string | undefined {
  const configured = process.env.QUBIUS_GITHUB_REPO?.trim();
  if (configured && REPO_RE.test(configured)) return configured;
  const remote = readGithubRemote(repoRoot);
  return remote ? githubRepoFromRemote(remote) : undefined;
}

/**
 * 读取 GitHub 镜像 main 分支上的版本号并与当前构建对照。网络失败不抛错，
 * 返回 error 交给页面显示，避免部署页因为外网不可用整页失败。
 */
export async function fetchGithubVersion(options: {
  repoRoot: string;
  current?: string;
  /** 测试注入；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入；默认当前时间。 */
  now?: () => Date;
}): Promise<GithubVersionState> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const repo = resolveRepo(options.repoRoot);
  const base: GithubVersionState = {
    status: "unknown",
    checkedAt,
    ...(repo ? { repo } : {}),
    ...(options.current ? { current: options.current } : {}),
  };
  if (!repo) return { ...base, error: "没有找到 GitHub 镜像" };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `https://raw.githubusercontent.com/${repo}/main/package.json`,
      {
        signal: AbortSignal.timeout(5000),
        headers: { accept: "application/json" },
      },
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ...base, error: name === "TimeoutError" ? "连接 GitHub 超时" : "无法连接 GitHub" };
  }
  if (!response.ok) return { ...base, error: `GitHub 返回 HTTP ${response.status}` };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ...base, error: "GitHub 返回的内容无法解析" };
  }
  const version = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? versionString((parsed as Record<string, unknown>).version)
    : undefined;
  if (!version) return { ...base, error: "GitHub 镜像里没有版本号" };

  return {
    ...base,
    version,
    status: options.current ? statusFor(options.current, version) : "unknown",
  };
}
