import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { sha256Hex } from "./canonical.js";
import { redact, secretValues } from "./render.js";
import { EdgeError, type EdgePaths, type EdgeSecrets } from "./types.js";

/**
 * edgectl CLI 调用层。
 *
 * 设计约束：
 *   - 纯 argv 调用，不经过 shell：参数不会被再次解释，避免注入；
 *   - 只根据退出码判断成功，不解析 edgectl 的中文/英文文案；
 *   - 所有 stdout/stderr 在返回或写日志前统一脱敏（密钥 + URL user:pass）；
 *   - config 路径始终显式、绝对；bin 只来自 `EdgePaths.binPath`（服务端解析）；
 *   - plan 阶段的候选注册表写到注册表同目录（确保命中同一份 .env），文件名
 *     固定前缀 `.qubius-edge-candidate-<jobId>`，0600，finally 删除。
 *
 * runner 可注入，测试用 fake edgectl 记录 argv / stdin / 退出码。
 */

export interface CommandSpec {
  command: string;
  args: string[];
  /** 作为 stdin 传入的内容（可选）。 */
  input?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export type CommandRunner = (spec: CommandSpec) => CommandResult;

/**
 * 默认 runner：spawnSync，编码 utf8，超时即终止。
 *
 * 注意：spawnSync 会阻塞 Node 事件循环（最长到 timeoutMs，plan/apply 可达
 * 数十秒）。D2b 若在 HTTP 进程里同步生成计划，应把 plan 放进子进程/worker
 * 执行，避免拖住其它请求；本单元只提供原语，不做调度。
 */
export const defaultCommandRunner: CommandRunner = (spec) => {
  const proc = spawnSync(spec.command, spec.args, {
    encoding: "utf8",
    input: spec.input,
    timeout: spec.timeoutMs,
    env: spec.env ?? process.env,
    cwd: spec.cwd,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: proc.status ?? null,
    stdout: typeof proc.stdout === "string" ? proc.stdout : "",
    stderr: typeof proc.stderr === "string" ? proc.stderr : "",
    signal: proc.signal ?? null,
    error: proc.error ?? undefined,
  };
};

/** 脱敏 URL 里的 user:pass（例如 git remote / proxy URL）。 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1***@");
}

/** 统一脱敏：密钥值 + URL user:pass。数组可传敏感字符串列表。 */
export function redactText(
  text: string,
  secrets?: EdgeSecrets | string[] | null,
): string {
  const values = Array.isArray(secrets) ? secrets : secretValues(secrets ?? undefined);
  return redactCredentials(redact(text, values));
}

export const CANDIDATE_PREFIX = ".qubius-edge-candidate-";
const SAFE_JOB_ID_RE = /^[A-Za-z0-9._-]+$/;

/** 校验 jobId 只含安全字符，避免路径穿越/空白进入远程命令。 */
export function assertSafeJobId(jobId: string): string {
  if (!jobId || !SAFE_JOB_ID_RE.test(jobId)) {
    throw new EdgeError(`非法 jobId：${JSON.stringify(jobId)}`);
  }
  return jobId;
}

/** 候选注册表路径：与真实注册表同目录，保证读到同一份 .env。 */
export function candidateRegistryPath(registryPath: string, jobId: string): string {
  const safe = assertSafeJobId(jobId);
  return path.join(path.dirname(path.resolve(registryPath)), `${CANDIDATE_PREFIX}${safe}`);
}

/**
 * 在注册表同目录写候选文件并执行 fn；无论成功、失败还是抛异常都删除。
 * 文件以 0600 创建（先 chmod 再 chmod，避免 umask 放宽）。
 */
export function withCandidateRegistry<T>(
  registryPath: string,
  jobId: string,
  content: string,
  fn: (candidatePath: string) => T,
): T {
  const candidate = candidateRegistryPath(registryPath, jobId);
  let primaryError: unknown;
  try {
    fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
    fs.writeFileSync(candidate, content, { mode: 0o600 });
    fs.chmodSync(candidate, 0o600);
    return fn(candidate);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // 无条件清理：即使 writeFileSync/chmod 中途失败（文件可能已创建）或 fn
    // 抛异常，也不留下候选文件。ENOENT 视为已清理；其它 unlink 失败只在
    // 没有更重要的原始错误时才抛出，避免掩盖真正原因。
    // 注意：正常返回后若 unlink 因权限等原因失败（非 ENOENT），异常会从
    // finally 抛出并覆盖原本成功的返回值——这是有意的（清理失败必须上报）。
    try {
      fs.unlinkSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && primaryError === undefined) {
        throw error;
      }
    }
  }
}

export interface CliResult {
  ok: boolean;
  code: number | null;
  /** 已脱敏。 */
  stdout: string;
  /** 已脱敏。 */
  stderr: string;
  timedOut: boolean;
  /** 实际 argv（不含命令名之外的 shell 包装）。 */
  argv: string[];
}

export interface CliOptions {
  paths: EdgePaths;
  secrets?: EdgeSecrets;
  runner?: CommandRunner;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

interface RawCliRun {
  result: CliResult;
  rawStdout: string;
  rawStderr: string;
}

function requireBin(paths: EdgePaths): string {
  if (!paths.binPath) {
    throw new EdgeError(
      "找不到可用的 edgectl CLI（QUBIUS_EDGECTL_BIN）；不会静默回退 native。",
    );
  }
  return paths.binPath;
}

function isTimedOut(result: CommandResult): boolean {
  if (result.status !== null) return false;
  if (result.signal !== null) return true;
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ETIMEDOUT";
}

function runCli(options: CliOptions, args: string[]): RawCliRun {
  const bin = requireBin(options.paths);
  const runner = options.runner ?? defaultCommandRunner;
  const spec: CommandSpec = {
    command: bin,
    args,
    timeoutMs: options.timeoutMs ?? 30_000,
    env: options.env,
  };
  const proc = runner(spec);
  const rawStdout = proc.stdout ?? "";
  const rawStderr = [proc.stderr ?? "", proc.error ? proc.error.message : ""]
    .filter((value) => value.length > 0)
    .join("\n");
  const timedOut = isTimedOut(proc);
  const result: CliResult = {
    ok: proc.status === 0 && !proc.error,
    code: proc.status,
    stdout: redactText(rawStdout, options.secrets),
    stderr: redactText(rawStderr, options.secrets),
    timedOut,
    argv: [bin, ...args],
  };
  if (options.log) {
    const suffix = timedOut ? "（超时）" : `（exit ${proc.status ?? "?"}）`;
    options.log(`edgectl ${args.join(" ")}${suffix}`);
    if (result.stderr) options.log(result.stderr);
  }
  return { result, rawStdout, rawStderr };
}

export interface CliVersionResult {
  /** 解析出的语义版本号；无法解析时为 null。 */
  version: string | null;
  /** 已脱敏的 `--version` 输出。 */
  raw: string;
  result: CliResult;
}

/**
 * `--version` 握手。失败（非 0 退出 / spawn 失败 / 超时）直接抛 EdgeError，
 * 调用方不得回退 native。
 */
export function cliVersion(options: CliOptions): CliVersionResult {
  const { result, rawStdout } = runCli(options, ["--version"]);
  if (!result.ok) {
    const detail = result.stderr || result.stdout || "无输出";
    throw new EdgeError(
      `edgectl --version 握手失败（exit ${result.code ?? "?"}）：${detail}`,
    );
  }
  const raw = result.stdout.trim();
  const match = raw.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return { version: match ? match[1]! : null, raw, result };
}

function assertAbsoluteConfig(configPath: string): string {
  if (!path.isAbsolute(configPath)) {
    throw new EdgeError(`edgectl --config 必须是绝对路径：${configPath}`);
  }
  return path.resolve(configPath);
}

/** `edgectl validate --strict --config <abs>`。 */
export function validateConfig(configPath: string, options: CliOptions): CliResult {
  const config = assertAbsoluteConfig(configPath);
  return runCli(options, ["validate", "--strict", "--config", config]).result;
}

/** `edgectl apply-vps --yes --config <abs>`。 */
export function applyVps(configPath: string, options: CliOptions): CliResult {
  const config = assertAbsoluteConfig(configPath);
  return runCli(options, ["apply-vps", "--yes", "--config", config]).result;
}

export interface CandidateRunResult {
  validate: CliResult;
  /** validate 通过时才真正执行；跳过时为占位结果（ok=false）。 */
  dryRun: CliResult;
  /** true 表示 validate 失败或抛出，dry-run 未执行。 */
  dryRunSkipped: boolean;
  /** dry-run 原始 stdout 的 sha256（未执行时为 null）。 */
  dryRunStdoutSha: string | null;
  /** 已脱敏的 dry-run stdout，用于展示。 */
  dryRunStdout: string;
}

function skippedCli(argv: string[]): CliResult {
  return { ok: false, code: null, stdout: "", stderr: "", timedOut: false, argv };
}

/**
 * 在注册表同目录写候选文件，依次执行 `validate --strict` 和
 * `apply-vps --dry-run`。validate 失败时直接跳过 dry-run（不浪费一次 CLI/ssh），
 * 候选文件在返回前删除（finally），异常路径同样清理。
 */
export function runDryRunCandidate(
  options: CliOptions & {
    registryPath: string;
    jobId: string;
    candidateText: string;
  },
): CandidateRunResult {
  return withCandidateRegistry(
    options.registryPath,
    options.jobId,
    options.candidateText,
    (candidate) => {
      const validate = validateConfig(candidate, options);
      if (!validate.ok) {
        return {
          validate,
          dryRun: skippedCli(["--skipped", "apply-vps", "--dry-run", "--config", candidate]),
          dryRunSkipped: true,
          dryRunStdoutSha: null,
          dryRunStdout: "",
        };
      }
      const { result: dryRun, rawStdout } = runCli(options, [
        "apply-vps",
        "--dry-run",
        "--config",
        candidate,
      ]);
      return {
        validate,
        dryRun,
        dryRunSkipped: false,
        dryRunStdoutSha: sha256Hex(rawStdout),
        dryRunStdout: redactText(rawStdout, options.secrets),
      };
    },
  );
}
