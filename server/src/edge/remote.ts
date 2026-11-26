import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256Hex } from "./canonical.js";
import {
  assertSafeJobId,
  defaultCommandRunner,
  redactText,
  type CommandRunner,
  type CommandResult,
} from "./cli.js";
import { EdgeError, type EdgeRegistry, type EdgeSecrets } from "./types.js";

/**
 * VPS 远端操作（ssh / docker exec）。
 *
 * 全部通过 argv 直传，不经过 shell 二次解释；远程命令用一个 shell 片段字符串
 * 传入 ssh，片段里的每个变量都经过 POSIX 单引号转义。与 edgectl 的差异只在
 * 于我们把命令拼成可测试的 argv。
 *
 * 安全约定：
 *   - ssh 固定 BatchMode=yes ConnectTimeout=10，避免交互提示卡住；
 *   - 默认开启 ControlMaster 连接复用（一次 apply 里十几次 ssh 共享一条连接），
 *     QUBIUS_SSH_CONTROL=0 可关闭；
 *   - 远端文件只使用 `cat >` 原地写（单文件 bind mount 不能换 inode）；
 *   - 所有返回的 stdout/stderr 都经过 redactText 脱敏；
 *   - 远端 Caddyfile 内容本身不脱敏（需要 splice / sha 比较），调用方不得直接
 *     展示或落盘明文；展示路径由 plan 脱敏后再写。
 */

export interface RemoteOptions {
  runner?: CommandRunner;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  secrets?: EdgeSecrets | string[];
}

export interface RemoteResult {
  ok: boolean;
  code: number | null;
  /** 已脱敏。 */
  stdout: string;
  /** 已脱敏。 */
  stderr: string;
  timedOut: boolean;
  argv: string[];
}

interface RawRemoteRun {
  result: RemoteResult;
  rawStdout: string;
  rawStderr: string;
}

/** `~` / `~/x` 展开为当前用户 HOME；其它路径原样返回。 */
export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return (env.HOME ?? "").trim() || os.homedir();
}

/**
 * 校验 resolve 之后的 ControlPath 模板。
 *
 * - token 只能出现在 basename：出现在目录部分（例如 `/custom/qubius-%C/sock`）
 *   会让本地准备字面量 `%C` 目录、ssh 运行时又展开成哈希目录，复用静默失效。
 * - 需要 `%C`（ssh 的 host+port+user+local 哈希），或同时具备
 *   `%r`（远端用户）+ `%h`/`%n`（主机）+ `%p`（端口）。只有 host+port 时
 *   `ubuntu@host` 与 `root@host` 会错误复用同一连接。
 */
function validateSshControlPath(resolved: string, original: string): void {
  const dir = path.dirname(resolved);
  if (dir.includes("%")) {
    throw new EdgeError(
      `QUBIUS_SSH_CONTROL_PATH 的 token 只能出现在文件名（basename）中：${original}`,
    );
  }
  const base = path.basename(resolved);
  if (base.includes("%C")) return;
  const hasUser = base.includes("%r");
  const hasHost = /%[hn]/.test(base);
  const hasPort = base.includes("%p");
  if (!(hasUser && hasHost && hasPort)) {
    throw new EdgeError(
      `QUBIUS_SSH_CONTROL_PATH 必须包含 %C，或同时包含 %r + (%h/%n) + %p：${original}`,
    );
  }
}

/**
 * ControlMaster 复用套接字模板。`%C` 由 ssh 按 (host, port, user) 生成哈希，
 * 不同目标不会互相复用；路径保持很短，避免超过 Unix socket 的 108 字节上限。
 *
 * 放在用户私有目录的专属子目录里，避免共享 /tmp 下被其他用户预创建占位（DoS）：
 *   1. QUBIUS_SSH_CONTROL_PATH 显式覆盖（绝对路径，token 只在 basename）；
 *   2. $XDG_RUNTIME_DIR/qubius-ssh/qubius-%C（XDG 必须是绝对路径）；
 *   3. ~/.ssh/qubius-control/qubius-%C。
 *
 * 本函数是纯函数，不创建目录；目录准备见 prepareSshControlDir（真正 spawn 前）。
 */
export function sshControlPath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = (env.QUBIUS_SSH_CONTROL_PATH ?? "").trim();
  if (custom) {
    const expanded = expandHome(custom, homeOf(env));
    if (!path.isAbsolute(expanded)) {
      throw new EdgeError(
        `QUBIUS_SSH_CONTROL_PATH 必须是绝对路径：${custom}（相对路径会因 server/job cwd 不同而分裂 socket）`,
      );
    }
    // resolve 后校验：`/x/qubius-%C/../sock` 这类写法必须被挡住。
    const resolved = path.resolve(expanded);
    validateSshControlPath(resolved, custom);
    return resolved;
  }
  const runtime = (env.XDG_RUNTIME_DIR ?? "").trim();
  if (runtime && path.isAbsolute(runtime)) {
    return path.join(runtime, "qubius-ssh", "qubius-%C");
  }
  return path.join(homeOf(env), ".ssh", "qubius-control", "qubius-%C");
}

function controlPathFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith("ControlPath=")) return arg.slice("ControlPath=".length);
  }
  return null;
}

/** 已告警过的目录；避免每次 spawn 刷日志。 */
const warnedControlDirs = new Set<string>();

function warnControlDir(dir: string, reason: string): void {
  if (warnedControlDirs.has(dir)) return;
  warnedControlDirs.add(dir);
  console.warn(`[edge] ControlPath 目录 ${dir} ${reason}；连接复用可能不可用。`);
}

/** 默认放置 ControlPath 的专属子目录名（只有这类目录会被收紧到 0700）。 */
function isDedicatedControlDir(dir: string): boolean {
  const base = path.basename(dir);
  return base === "qubius-ssh" || base === "qubius-control";
}

/**
 * 真正 spawn ssh 前准备 ControlPath 的专属目录。
 *
 * - 目录不存在时以 0700 创建；父目录只作为 mkdir -p 的路径，不会被 chmod；
 * - 已存在时用 lstat 检查：必须是真实目录、属当前用户；symlink/他人目录直接
 *   跳过并告警（ssh 会跟随 symlink，不能默默使用）；
 * - 只有默认专属子目录会被收紧到 0700，避免误 chmod 自定义的共享父目录；
 * - 每次 spawn 都检查一次（一次 lstat，很便宜），目录被删除后能重新创建；
 * - 注入 mock runner 时调用方不得调用本函数（测试不产生 FS 副作用）。
 */
export function prepareSshControlDir(argv: string[]): void {
  const controlPath = controlPathFromArgv(argv);
  if (!controlPath) return;
  const dir = path.dirname(controlPath);
  try {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!stat) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      warnControlDir(dir, "不是真实目录（可能是 symlink）");
      return;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      warnControlDir(dir, "不属于当前用户");
      return;
    }
    if ((stat.mode & 0o077) !== 0 && isDedicatedControlDir(dir)) {
      fs.chmodSync(dir, 0o700);
    }
  } catch {
    // 创建/检查失败不阻断 ssh；ssh 自己会给出明确错误。
  }
}

/**
 * 与 edgectl 一致的 ssh argv（外加连接复用）：
 *   ssh -o BatchMode=yes -o ConnectTimeout=10
 *       [-o ControlMaster=auto -o ControlPath=<私有子目录>/qubius-%C -o ControlPersist=60s]
 *       [-i <key>] [-p <port>] <target>
 * sshKey 为空时省略 -i；端口 22 时省略 -p。
 * 环境变量 QUBIUS_SSH_CONTROL=0 时关闭连接复用（测试/排障用）。
 * 环境变量 QUBIUS_SSH_CONTROL_PATH 可覆盖复用套接字模板。
 */
export function sshCommand(
  registry: EdgeRegistry,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const vps = registry.vps;
  // 纵深防御：目标以 `-` 开头会被 ssh 当成选项（例如 -oProxyCommand=...）。
  if (!vps.ssh || vps.ssh.startsWith("-")) {
    throw new EdgeError(`edge.vps.ssh 不能为空或以 - 开头：${vps.ssh}`);
  }
  const argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if ((env.QUBIUS_SSH_CONTROL ?? "").trim() !== "0") {
    const controlPath = sshControlPath(env);
    argv.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      "ControlPersist=60s",
    );
  }
  const key = (vps.sshKey ?? "").trim();
  if (key) argv.push("-i", expandHome(key));
  if (vps.sshPort !== 22) argv.push("-p", String(vps.sshPort));
  argv.push(vps.ssh);
  return argv;
}

/** POSIX 单引号转义；用于拼进远程 sh 片段。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isTimedOut(proc: CommandResult): boolean {
  if (proc.status !== null) return false;
  if (proc.signal !== null) return true;
  return (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function runRemoteWith(
  options: RemoteOptions,
  ssh: string[],
  remoteScript: string,
  input?: string,
): RawRemoteRun {
  const runner = options.runner ?? defaultCommandRunner;
  // 只有真正 spawn 时才准备目录；注入 runner（测试/mock）不做任何 FS 操作。
  if (!options.runner) prepareSshControlDir(ssh);
  const proc = runner({
    command: ssh[0]!,
    args: [...ssh.slice(1), remoteScript],
    input,
    timeoutMs: options.timeoutMs ?? 30_000,
    env: options.env,
  });
  const rawStdout = proc.stdout ?? "";
  const rawStderr = [proc.stderr ?? "", proc.error ? proc.error.message : ""]
    .filter((value) => value.length > 0)
    .join("\n");
  const result: RemoteResult = {
    ok: proc.status === 0 && !proc.error,
    code: proc.status,
    stdout: redactText(rawStdout, options.secrets),
    stderr: redactText(rawStderr, options.secrets),
    timedOut: isTimedOut(proc),
    argv: [...ssh, remoteScript],
  };
  return { result, rawStdout, rawStderr };
}

function failureMessage(action: string, result: RemoteResult): string {
  const detail = result.stderr || result.stdout || (result.timedOut ? "超时" : "无输出");
  return `${action}失败（exit ${result.code ?? "?"}）：${detail}`;
}

/** 执行一段远程命令（通过单个 ssh 调用）。 */
export function runRemote(
  registry: EdgeRegistry,
  remoteScript: string,
  options: RemoteOptions = {},
): RemoteResult {
  return runRemoteWith(options, sshCommand(registry, options.env), remoteScript).result;
}

export interface RemoteFileRead {
  /** 原始内容（未脱敏；用于 sha/splice，不得直接展示或落盘）。 */
  content: string;
  sha: string;
  result: RemoteResult;
}

/** 读取远端 Caddyfile（`cat -- <path>`）。失败抛 EdgeError。 */
export function readRemoteFile(
  registry: EdgeRegistry,
  options: RemoteOptions = {},
): RemoteFileRead {
  const target = registry.vps.caddyfile;
  const script = `cat -- ${shellQuote(target)}`;
  const { result, rawStdout } = runRemoteWith(options, sshCommand(registry, options.env), script);
  if (!result.ok) throw new EdgeError(failureMessage("读取远端 Caddyfile", result));
  return { content: rawStdout, sha: sha256Hex(rawStdout), result };
}

/** 远端当前 Caddyfile 的 sha256。 */
export function remoteSha(
  registry: EdgeRegistry,
  options: RemoteOptions = {},
): string {
  return readRemoteFile(registry, options).sha;
}

/**
 * 原地写远端 Caddyfile：`umask 077; cat > <path>`，内容走 stdin。
 * 必须原地截断写入，不能 rename 替换（bind mount 单文件无法换 inode）。
 */
export function writeRemoteFileInPlace(
  registry: EdgeRegistry,
  content: string,
  options: RemoteOptions = {},
): RemoteResult {
  const target = registry.vps.caddyfile;
  const script = `umask 077; cat > ${shellQuote(target)}`;
  return runRemoteWith(options, sshCommand(registry, options.env), script, content).result;
}

export interface CaddyValidateCandidateOptions extends RemoteOptions {
  /**
   * 是否先探测 `dirname(caddyfile_container)` 可写；默认 true。
   * false 时直接用该目录（测试/已知可写）。
   */
  checkWritable?: boolean;
}

export interface CaddyValidateCandidateResult {
  result: RemoteResult;
  /** 实际使用的候选文件绝对路径（容器内）。 */
  candidate: string;
  /** 候选目录（容器内）。 */
  candidateDir: string;
  /** true 表示容器内注册表目录不可写，已回退 /tmp。 */
  fallback: boolean;
}

const CANDIDATE_FILE_PREFIX = ".qubius-candidate-";
/** 容器内候选目录回退位置。 */
export const CADDY_CANDIDATE_FALLBACK_DIR = "/tmp";

function dockerExecScript(container: string, inner: string, interactive = false): string {
  return `docker exec${interactive ? " -i" : ""} ${shellQuote(container)} sh -c ${shellQuote(inner)}`;
}

function candidateLive(registry: EdgeRegistry): { container: string; dir: string } {
  const container = registry.vps.caddyContainer;
  const dir = path.posix.dirname(registry.vps.caddyfileContainer);
  if (!dir.startsWith("/")) {
    throw new EdgeError(
      `edge.vps.caddyfile_container 必须是绝对路径：${registry.vps.caddyfileContainer}`,
    );
  }
  return { container, dir };
}

/**
 * 用候选内容在容器内做一次 Caddy 语法校验：
 *   docker exec -i <caddy> sh -c 'umask 077; cat > <dir>/.qubius-candidate-<jobId>
 *     && caddy validate --config <candidate> --adapter caddyfile;
 *     rc=$?; rm -f <candidate>; exit $rc'
 *
 * 候选目录默认取 `dirname(caddyfile_container)`；先探测目录可写，不可写则
 * 回退 /tmp 并在返回值里标明。内容走 stdin，不会出现在 argv 或远程命令行里。
 */
export function caddyValidateCandidate(
  registry: EdgeRegistry,
  content: string,
  jobId: string,
  options: CaddyValidateCandidateOptions = {},
): CaddyValidateCandidateResult {
  const safeJobId = assertSafeJobId(jobId);
  const { container, dir } = candidateLive(registry);

  let candidateDir = dir;
  let fallback = false;
  if (options.checkWritable !== false) {
    const probe = `test -d ${shellQuote(dir)} && test -w ${shellQuote(dir)}`;
    const check = runRemoteWith(
      { ...options, timeoutMs: options.timeoutMs ?? 15_000 },
      sshCommand(registry, options.env),
      dockerExecScript(container, probe),
    ).result;
    if (!check.ok) {
      candidateDir = CADDY_CANDIDATE_FALLBACK_DIR;
      fallback = true;
    }
  }

  const candidate = path.posix.join(candidateDir, `${CANDIDATE_FILE_PREFIX}${safeJobId}`);
  const inner =
    `umask 077; cat > ${shellQuote(candidate)} && ` +
    `caddy validate --config ${shellQuote(candidate)} --adapter caddyfile; ` +
    `rc=$?; rm -f ${shellQuote(candidate)}; exit $rc`;
  const { result } = runRemoteWith(
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
    sshCommand(registry, options.env),
    dockerExecScript(container, inner, true),
    content,
  );
  return { result, candidate, candidateDir, fallback };
}

/** 校验容器内正在使用（或即将使用）的 Caddyfile。 */
export function caddyValidateLive(
  registry: EdgeRegistry,
  options: RemoteOptions = {},
): RemoteResult {
  const container = registry.vps.caddyContainer;
  const config = registry.vps.caddyfileContainer;
  const inner = `caddy validate --config ${shellQuote(config)} --adapter caddyfile`;
  return runRemoteWith(
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
    sshCommand(registry, options.env),
    dockerExecScript(container, inner),
  ).result;
}

/** reload 容器内 Caddy。调用方负责最多重试一次。 */
export function caddyReload(
  registry: EdgeRegistry,
  options: RemoteOptions = {},
): RemoteResult {
  const container = registry.vps.caddyContainer;
  const config = registry.vps.caddyfileContainer;
  const inner = `caddy reload --config ${shellQuote(config)} --adapter caddyfile`;
  return runRemoteWith(
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
    sshCommand(registry, options.env),
    dockerExecScript(container, inner),
  ).result;
}

/** 从 `caddy version` 输出里解析语义版本（允许 v 前缀、可缺 patch）。 */
export function parseCaddyVersion(text: string): string | null {
  const match = text.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
  return match ? match[1]! : null;
}

export interface CaddyVersionResult {
  /** 无法探测/解析时为 null。 */
  version: string | null;
  result: RemoteResult;
}

/**
 * `docker exec <caddy_container> caddy version`。
 * 失败不抛错（返回 version=null），由调用方决定是否阻断。
 */
export function caddyVersion(
  registry: EdgeRegistry,
  options: RemoteOptions = {},
): CaddyVersionResult {
  const container = registry.vps.caddyContainer;
  const script = `docker exec ${shellQuote(container)} caddy version`;
  const { result, rawStdout, rawStderr } = runRemoteWith(
    { ...options, timeoutMs: options.timeoutMs ?? 15_000 },
    sshCommand(registry, options.env),
    script,
  );
  return {
    version: result.ok ? parseCaddyVersion(rawStdout || rawStderr) : null,
    result,
  };
}

const SAFE_SUFFIX_RE = /^[A-Za-z0-9._-]+$/;

export interface RemoteBackupOptions extends RemoteOptions {
  /** 备份文件名后缀；默认 UTC 时间戳。 */
  suffix?: string;
}

export interface RemoteBackupResult {
  /** 备份文件绝对路径；失败为 null。 */
  backup: string | null;
  result: RemoteResult;
}

/**
 * `cp -a -- <caddyfile> <caddyfile>.bak.<suffix>`。
 * 与 edgectl 的备份命名保持一致的可读性；suffix 只允许安全字符。
 */
export function backupRemoteFile(
  registry: EdgeRegistry,
  options: RemoteBackupOptions = {},
): RemoteBackupResult {
  const source = registry.vps.caddyfile;
  const suffix = options.suffix ?? new Date().toISOString().replace(/[:.]/g, "-");
  if (!SAFE_SUFFIX_RE.test(suffix)) {
    throw new EdgeError(`非法备份后缀：${JSON.stringify(suffix)}`);
  }
  const backup = `${source}.bak.${suffix}`;
  const script = `cp -a -- ${shellQuote(source)} ${shellQuote(backup)}`;
  const result = runRemoteWith(
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
    sshCommand(registry, options.env),
    script,
  ).result;
  return { backup: result.ok ? backup : null, result };
}

/** 只允许恢复本工具生成的 `<caddyfile>.bak.<安全后缀>` 绝对路径。 */
export function assertRemoteBackupPath(registry: EdgeRegistry, backup: string): string {
  if (!path.posix.isAbsolute(backup)) {
    throw new EdgeError(`备份路径必须是绝对路径：${backup}`);
  }
  const prefix = `${registry.vps.caddyfile}.bak.`;
  if (!backup.startsWith(prefix)) {
    throw new EdgeError(`备份路径不属于当前 Caddyfile：${backup}`);
  }
  // 后缀必须是单个安全文件名片段：拒绝 `/`、`..` 等路径穿越。
  const suffix = backup.slice(prefix.length);
  if (!SAFE_SUFFIX_RE.test(suffix)) {
    throw new EdgeError(`备份文件名不合法：${suffix}`);
  }
  return backup;
}

/**
 * 把备份内容写回 Caddyfile：`umask 077; cat -- <backup> > <caddyfile>`。
 * 仍是原地截断写入（bind mount 不能换 inode），内容不经过本地。
 */
export function restoreRemoteFile(
  registry: EdgeRegistry,
  backup: string,
  options: RemoteOptions = {},
): RemoteResult {
  const safeBackup = assertRemoteBackupPath(registry, backup);
  const script = `umask 077; cat -- ${shellQuote(safeBackup)} > ${shellQuote(registry.vps.caddyfile)}`;
  return runRemoteWith(
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
    sshCommand(registry, options.env),
    script,
  ).result;
}
