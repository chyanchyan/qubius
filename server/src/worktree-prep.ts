import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig, WorktreeConfig } from "./config.js";

/**
 * 新 worktree 创建后的准备步骤：
 * - 复制 `.worktreeinclude` / 项目配置里的 gitignored 文件（例如 .env）；
 * - 为 node_modules、.cache 之类的 gitignored 目录建立共享链接；
 * - 执行项目配置的 setup 命令（例如 npm ci）。
 *
 * 由 http.ts 的 createSession 在 `git worktree add` 成功后调用；失败时
 * 会话创建失败并清理 worktree。配置和实现见 config.ts / worktree-prep.ts。
 */
export interface WorktreePrepOptions {
  project: ProjectConfig;
  worktreePath: string;
}

export interface WorktreePrepResult {
  warnings: string[];
}

export const DEFAULT_WORKTREE_SETUP_TIMEOUT_SECONDS = 300;
export const MIN_WORKTREE_SETUP_TIMEOUT_SECONDS = 1;
export const MAX_WORKTREE_SETUP_TIMEOUT_SECONDS = 3600;

/** setup 失败时错误信息里保留的输出上限（字节）。 */
const SETUP_OUTPUT_TAIL_BYTES = 8 * 1024;
const INCLUDE_FILE = ".worktreeinclude";

/**
 * 校验并规范化 worktree 相关的相对路径：只接受仓库内的相对路径，
 * 拒绝绝对路径、盘符路径和 `..` 逃逸。返回用 `/` 分隔的规范形式。
 */
export function normalizeRelativeWorktreePath(value: string, label: string): string {
  const raw = value.trim();
  if (!raw) throw new Error(`${label} 不能为空`);
  if (raw.includes("\u0000")) throw new Error(`${label} 不能包含空字符`);
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\\\")) {
    throw new Error(`${label} 必须是仓库内的相对路径`);
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.includes("..")) throw new Error(`${label} 不能包含 ..`);
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  if (!normalized) throw new Error(`${label} 不能指向仓库根目录`);
  return normalized;
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是字符串数组`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${label}[${index}] 必须是非空字符串`);
    }
    const normalized = normalizeRelativeWorktreePath(item, `${label}[${index}]`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeSetupTimeout(value: unknown, label: string): number {
  if (value === undefined || value === null) return DEFAULT_WORKTREE_SETUP_TIMEOUT_SECONDS;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MIN_WORKTREE_SETUP_TIMEOUT_SECONDS
    || value > MAX_WORKTREE_SETUP_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `${label} 必须是 ${MIN_WORKTREE_SETUP_TIMEOUT_SECONDS} 到 ${MAX_WORKTREE_SETUP_TIMEOUT_SECONDS} 的整数`,
    );
  }
  return value;
}

function normalizeSetup(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  const command = value.trim();
  if (!command) throw new Error(`${label} 不能为空字符串`);
  return command;
}

/** 解析 config / projects.yaml 里的 `worktree:` 配置；未配置时返回 undefined。 */
export function normalizeWorktreeConfig(value: unknown, label = "worktree"): WorktreeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是映射`);
  }
  const record = value as Record<string, unknown>;
  return {
    setup: normalizeSetup(record.setup, `${label}.setup`),
    setupTimeoutSeconds: normalizeSetupTimeout(record.setupTimeoutSeconds, `${label}.setupTimeoutSeconds`),
    sharedDirectories: normalizeStringList(record.sharedDirectories, `${label}.sharedDirectories`),
    include: normalizeStringList(record.include, `${label}.include`),
  };
}

/** 读取仓库根的 `.worktreeinclude`；空行和 # 注释忽略，非法行只产生 warning。 */
export function readWorktreeInclude(
  projectPath: string,
): { paths: string[]; warnings: string[] } {
  const file = path.join(projectPath, INCLUDE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { paths: [], warnings: [] };
    if (code === "EISDIR") {
      return { paths: [], warnings: [`跳过 ${INCLUDE_FILE}：同名路径是目录，不是文件`] };
    }
    throw new Error(`无法读取 ${INCLUDE_FILE}：${messageOf(error)}`);
  }
  const paths: string[] = [];
  const warnings: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      paths.push(normalizeRelativeWorktreePath(line, `${INCLUDE_FILE} 第 ${index + 1} 行`));
    } catch (error) {
      warnings.push(`跳过 ${INCLUDE_FILE} 第 ${index + 1} 行（${line}）：${messageOf(error)}`);
    }
  }
  return { paths, warnings };
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

interface GitResult {
  code: number;
  stderr: string;
}

/** 在项目主检出里跑一个只读 git 查询；git 自身无法启动时抛错。 */
function runGit(projectPath: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", projectPath, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(new Error(`无法执行 git：${messageOf(error)}`));
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stderr });
    });
  });
}

async function isTracked(projectPath: string, relativePath: string): Promise<boolean> {
  // --literal-pathspecs：include 路径按字面处理，避免 * ? 等字符被当成 glob。
  // check-ignore 只接受字面路径，不支持这个选项。
  const result = await runGit(projectPath, [
    "--literal-pathspecs",
    "ls-files",
    "--error-unmatch",
    "--",
    relativePath,
  ]);
  return result.code === 0;
}

async function isIgnored(projectPath: string, relativePath: string): Promise<boolean> {
  const result = await runGit(projectPath, ["check-ignore", "-q", "--", relativePath]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(
    `git check-ignore 检查 ${relativePath} 失败（退出码 ${result.code}）：${result.stderr.trim()}`,
  );
}

async function copyIncludes(
  project: ProjectConfig,
  worktreePath: string,
  warnings: string[],
): Promise<void> {
  const config = project.worktree;
  const includeFile = readWorktreeInclude(project.path);
  warnings.push(...includeFile.warnings);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const [source, items] of [
    ["worktree.include", config?.include ?? []],
    [INCLUDE_FILE, includeFile.paths],
  ] as const) {
    for (const raw of items) {
      // 配置里的路径已在解析时校验；这里再规范化一次，避免调用方直接构造配置绕过校验。
      const relativePath = normalizeRelativeWorktreePath(raw, source);
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      paths.push(relativePath);
    }
  }
  for (const relativePath of paths) {
    const source = path.join(project.path, relativePath);
    if (!exists(source)) {
      warnings.push(`跳过 include ${relativePath}：源路径不存在`);
      continue;
    }
    if (await isTracked(project.path, relativePath)) {
      warnings.push(`跳过 include ${relativePath}：路径已被 git 跟踪`);
      continue;
    }
    if (!(await isIgnored(project.path, relativePath))) {
      warnings.push(`跳过 include ${relativePath}：没有被 .gitignore 忽略`);
      continue;
    }
    const target = path.join(worktreePath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
  }
}

async function linkSharedDirectories(
  project: ProjectConfig,
  worktreePath: string,
  warnings: string[],
): Promise<void> {
  for (const raw of project.worktree?.sharedDirectories ?? []) {
    const relativePath = normalizeRelativeWorktreePath(raw, "worktree.sharedDirectories");
    const source = path.join(project.path, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(source);
    } catch {
      warnings.push(`跳过共享目录 ${relativePath}：源目录不存在`);
      continue;
    }
    if (!stat.isDirectory()) {
      warnings.push(`跳过共享目录 ${relativePath}：源路径不是目录`);
      continue;
    }
    if (!(await isIgnored(project.path, relativePath))) {
      warnings.push(`跳过共享目录 ${relativePath}：没有被 .gitignore 忽略`);
      continue;
    }
    const target = path.join(worktreePath, relativePath);
    if (exists(target)) {
      warnings.push(`跳过共享目录 ${relativePath}：worktree 目标已存在`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  }
}

function setupFailure(command: string, reason: string, output: Buffer): Error {
  const tail = output.toString("utf8").trim();
  return new Error(
    `worktree setup 命令失败：${command}（${reason}）${tail ? `\n${tail}` : ""}`,
  );
}

/**
 * 结束 setup 的整棵进程树。POSIX 上 setup 以 detached 方式启动（shell 是新进程组组长），
 * 对负 pid 发信号能连同 `npm ci` 这类子进程一起杀掉；Windows 用 taskkill /T。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已经退出。
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          child.kill();
        } catch {
          // 进程可能已经退出。
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        // 进程可能已经退出。
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // 进程可能已经退出。
    }
  }
}

/**
 * 在 worktree 里执行 setup；超时或非 0 退出时报错，输出只保留尾部 8 KiB。
 * 超时先杀掉整棵进程树，等子进程真正退出（close）后再 reject，避免清理 worktree
 * 时还有 setup 子进程在写文件。
 */
function runSetup(command: string, cwd: string, timeoutSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // POSIX 上 detached 让 shell 成为新进程组组长，便于按进程树清理；
    // Windows 不设 detached，避免额外开控制台窗口。
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      shell: true,
      cwd,
      env: process.env,
      detached,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    };
    const append = (chunk: Buffer) => {
      output = output.length === 0 ? chunk : Buffer.concat([output, chunk]);
      if (output.length > SETUP_OUTPUT_TAIL_BYTES) {
        output = output.subarray(output.length - SETUP_OUTPUT_TAIL_BYTES);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      finish(new Error(`worktree setup 命令无法启动：${command}：${messageOf(error)}`));
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        // 进程树已结束，现在可以安全地让调用方清理 worktree。
        finish(setupFailure(command, `超时（${timeoutSeconds} 秒）`, output));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const reason = code !== null ? `退出码 ${code}` : `信号 ${signal ?? "未知"}`;
      finish(setupFailure(command, reason, output));
    });
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // 兜底：正常 SIGKILL 后 close 会很快触发；这里只防止极端情况下会话一直挂着。
      forceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(setupFailure(command, `超时（${timeoutSeconds} 秒）`, output));
      }, 5_000);
    }, timeoutSeconds * 1_000);
  });
}

export async function prepareWorktree(options: WorktreePrepOptions): Promise<WorktreePrepResult> {
  const { project, worktreePath } = options;
  if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
    throw new Error(`worktree 目录不存在：${worktreePath}`);
  }
  const warnings: string[] = [];
  await copyIncludes(project, worktreePath, warnings);
  await linkSharedDirectories(project, worktreePath, warnings);
  const config = project.worktree;
  if (config?.setup) {
    await runSetup(config.setup, worktreePath, config.setupTimeoutSeconds);
  }
  return { warnings };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
