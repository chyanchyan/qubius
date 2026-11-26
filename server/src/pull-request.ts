import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FeatureContext, FeatureHandler, FeatureResult } from "./feature-routes.js";
import { GitActionBusyError, withGitAction } from "./git-lock.js";
import { isSessionBusy } from "./session-lock.js";
import type { SessionCore } from "./types.js";
import { isSessionBranch, redactGitCredentials } from "./worktree.js";

const exec = promisify(execFile);

/**
 * 会话分支的 PR/MR 状态和创建。
 *
 * 路由契约（由 web 端一起使用）：
 * - GET  /api/sessions/<id>/pull-request
 * - POST /api/sessions/<id>/pull-request
 *
 * 通过本机已登录的 gh / glab CLI 操作，不在 qubius 里保存托管平台 token。
 * 托管平台命令走可注入的 CommandRunner，测试不需要真的装 gh/glab。
 */

const ROUTE_RE = /^\/api\/sessions\/([^/]+)\/pull-request$/;
const REMOTE_TIMEOUT_MS = 10_000;
const BRANCH_TIMEOUT_MS = 10_000;
const VIEW_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 120_000;
const CREATE_TIMEOUT_MS = 120_000;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_ERROR_TEXT = 600;

const GH_VIEW_ARGS = [
  "pr",
  "view",
  "--json",
  "number,url,state,title,mergeable,statusCheckRollup,headRefName,baseRefName",
];
const GLAB_VIEW_ARGS = ["mr", "view", "--output", "json"];

/** 一个检查项的归一化结果；status/conclusion 统一小写。 */
export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
}

/** GET/POST 共用的响应体。 */
export interface PullRequestStatus {
  supported: boolean;
  /** 支持的平台标识（github/gitlab）；不支持的远端放域名。 */
  host: string | null;
  exists: boolean;
  url?: string;
  number?: number;
  state?: string;
  title?: string;
  mergeable?: string;
  checks: PullRequestCheck[];
  error?: string;
  /** 只在 POST 成功创建后出现。 */
  created?: boolean;
}

export interface CommandRunnerOptions {
  cwd: string;
  timeoutMs?: number;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

/** 执行 git / gh / glab。测试注入假实现，避免依赖本机 CLI。 */
export interface CommandRunner {
  run(command: string, args: string[], options: CommandRunnerOptions): Promise<CommandOutput>;
}

export const defaultCommandRunner: CommandRunner = {
  async run(command, args, options) {
    const { stdout, stderr } = await exec(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? VIEW_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4_000_000,
      // 交互式凭据提示会让命令一直挂着；需要用户先在本机登录 CLI。
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  },
};

/**
 * 从 git remote URL 取出主机名（小写）。支持 https/ssh（带端口）和
 * scp 风格的 `git@host:owner/repo.git`；忽略 userinfo、端口和 `.git`。
 */
export function parseRemoteHost(remoteUrl: string): string | null {
  const text = (remoteUrl || "").trim();
  if (!text) return null;
  let authority: string | null = null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(text);
  if (scheme) {
    authority = scheme[1] ?? null;
  } else {
    // scp 风格：git@github.com:owner/repo.git；排除 https:// 这类带双斜杠的地址。
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(text);
    if (scp) authority = scp[1] ?? null;
  }
  if (!authority) return null;
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  const colon = authority.indexOf(":");
  if (colon >= 0) authority = authority.slice(0, colon);
  const host = authority.toLowerCase();
  return host || null;
}

/** github.* / gitlab（含自建域名）识别；其它托管平台不支持。 */
export function detectProvider(host: string | null): "github" | "gitlab" | null {
  if (!host) return null;
  const value = host.toLowerCase();
  if (value === "github.com" || value.startsWith("github.")) return "github";
  if (value === "gitlab.com" || value.includes("gitlab")) return "gitlab";
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * GitHub statusCheckRollup 的条目可能是 CheckRun（name/status/conclusion/
 * detailsUrl），也可能是旧的 StatusContext（context/state/targetUrl）。
 * 两者都归一化成同样的结构。
 */
export function normalizeGithubChecks(raw: unknown): PullRequestCheck[] {
  if (!Array.isArray(raw)) return [];
  const checks: PullRequestCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = asString(record.name) ?? asString(record.context);
    if (!name) continue;
    let status: string;
    let conclusion: string | null;
    const checkStatus = asString(record.status);
    if (checkStatus) {
      status = checkStatus.toLowerCase();
      const checkConclusion = asString(record.conclusion);
      conclusion = checkConclusion ? checkConclusion.toLowerCase() : null;
    } else {
      // StatusContext 只有 state（SUCCESS/FAILURE/ERROR/PENDING）。
      const state = asString(record.state)?.toLowerCase();
      if (state === "pending" || state === "expected") {
        status = "in_progress";
        conclusion = null;
      } else if (state) {
        status = "completed";
        conclusion = state;
      } else {
        status = "unknown";
        conclusion = null;
      }
    }
    // detailsUrl/targetUrl 由托管平台返回，理论上是公开链接，但仍可能带上
    // https://user:token@ 形式的凭证，统一和 git 输出一样脱敏。
    const rawUrl = asString(record.detailsUrl) ?? asString(record.targetUrl);
    const url = rawUrl ? redactGitCredentials(rawUrl) : undefined;
    checks.push({
      name,
      status,
      conclusion,
      ...(url ? { url } : {}),
    });
  }
  return checks;
}

/** GitLab pipeline 的终态映射；其余 completed 语义外的状态按原值小写保留。 */
const GITLAB_PIPELINE_CONCLUSIONS: Record<string, string> = {
  success: "success",
  failed: "failure",
  canceled: "cancelled",
  cancelled: "cancelled",
  skipped: "skipped",
  manual: "manual",
};

const GITLAB_PIPELINE_IN_PROGRESS = new Set([
  "running",
  "pending",
  "created",
  "preparing",
  "waiting_for_resource",
  "scheduled",
]);

/** glab mr view 的 head_pipeline / pipeline 可能是对象或数组（取第一个）。 */
function gitlabPipelineStatus(record: Record<string, unknown>): string | undefined {
  const direct = asString(record.status);
  if (direct) return direct;
  const detailed = record.detailed_status;
  if (typeof detailed === "string") return asString(detailed);
  if (detailed && typeof detailed === "object") {
    const nested = detailed as Record<string, unknown>;
    return asString(nested.group) ?? asString(nested.text);
  }
  return undefined;
}

/**
 * 把 GitLab pipeline 归一化成一条检查。glab 的 JSON 不提供逐 job 结果，
 * 这里只暴露 pipeline 整体状态，前端按同一套 PullRequestCheck 渲染。
 */
export function normalizeGitlabPipeline(raw: unknown): PullRequestCheck[] {
  const source = Array.isArray(raw) ? raw[0] : raw;
  if (!source || typeof source !== "object") return [];
  const record = source as Record<string, unknown>;
  const rawStatus = gitlabPipelineStatus(record);
  if (!rawStatus) return [];
  const value = rawStatus.toLowerCase();
  let status: string;
  let conclusion: string | null;
  if (Object.prototype.hasOwnProperty.call(GITLAB_PIPELINE_CONCLUSIONS, value)) {
    status = "completed";
    conclusion = GITLAB_PIPELINE_CONCLUSIONS[value] ?? null;
  } else if (GITLAB_PIPELINE_IN_PROGRESS.has(value)) {
    status = "in_progress";
    conclusion = null;
  } else {
    status = value;
    conclusion = null;
  }
  const rawUrl = asString(record.web_url);
  const url = rawUrl ? redactGitCredentials(rawUrl) : undefined;
  return [{ name: "pipeline", status, conclusion, ...(url ? { url } : {}) }];
}

function mapGitlabMergeable(record: Record<string, unknown>): string | undefined {
  if (record.has_conflicts === true) return "conflicting";
  const raw = asString(record.detailed_merge_status) ?? asString(record.merge_status);
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (["can_be_merged", "mergeable", "can_be_merged_recheck"].includes(value)) return "mergeable";
  if (["cannot_be_merged", "cannot_be_merged_recheck", "conflict", "conflicts"].includes(value)) {
    return "conflicting";
  }
  return value;
}

interface ParsedView {
  url?: string;
  number?: number;
  state?: string;
  title?: string;
  mergeable?: string;
  checks: PullRequestCheck[];
}

function parseGithubView(stdout: string): ParsedView | null {
  const text = stdout.trim();
  if (!text) return null;
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const parsed: ParsedView = { checks: normalizeGithubChecks(record.statusCheckRollup) };
  const url = asString(record.url);
  if (url) parsed.url = redactGitCredentials(url);
  if (typeof record.number === "number") parsed.number = record.number;
  const state = asString(record.state);
  if (state) parsed.state = state.toLowerCase();
  const title = asString(record.title);
  if (title) parsed.title = title;
  const mergeable = asString(record.mergeable);
  if (mergeable) parsed.mergeable = mergeable.toLowerCase();
  return parsed;
}

function parseGitlabView(stdout: string): ParsedView | null {
  const text = stdout.trim();
  if (!text) return null;
  const data = JSON.parse(text) as unknown;
  // 不同 glab 版本可能返回对象；数组时取第一个。
  const record = Array.isArray(data) ? data[0] : data;
  if (!record || typeof record !== "object") return null;
  const item = record as Record<string, unknown>;
  const parsed: ParsedView = {
    checks: normalizeGitlabPipeline(item.head_pipeline ?? item.pipeline),
  };
  const url = asString(item.web_url) ?? asString(item.url);
  if (url) parsed.url = redactGitCredentials(url);
  if (typeof item.iid === "number") parsed.number = item.iid;
  const state = asString(item.state);
  if (state) parsed.state = state.toLowerCase();
  const title = asString(item.title);
  if (title) parsed.title = title;
  const mergeable = mapGitlabMergeable(item);
  if (mergeable) parsed.mergeable = mergeable;
  return parsed;
}

interface RunnerFailure {
  code: string;
  text: string;
}

function readFailure(error: unknown): RunnerFailure {
  // git/gh/glab 的 stderr 可能带 https://user:token@host，先脱敏再交给上层。
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const stderr = typeof record.stderr === "string" ? record.stderr.trim() : "";
    const stdout = typeof record.stdout === "string" ? record.stdout.trim() : "";
    const message = typeof record.message === "string" ? record.message : "";
    return { code, text: redactGitCredentials(stderr || stdout || message) };
  }
  return {
    code: "",
    text: redactGitCredentials(error instanceof Error ? error.message : String(error)),
  };
}

function truncate(text: string): string {
  // readFailure 已脱敏；远端 URL 等直接传入的文本在这里再兜一次。
  const single = redactGitCredentials(text).replace(/\s+/g, " ").trim();
  return single.length > MAX_ERROR_TEXT ? `${single.slice(0, MAX_ERROR_TEXT)}…` : single;
}

const AUTH_RE = /not logged in|not logged into|not authenticated|authentication required|auth login|bad credentials|invalid token|http 401|401 unauthorized|login required|please authenticate|no oauth token|GH_TOKEN|GITLAB_TOKEN/i;
const NO_PR_RE = /no (?:open )?pull requests? found|no merge requests? found|no open merge requests?|could not find (?:a )?(?:pull request|merge request)|no (?:pull|merge) request for branch/i;
const ALREADY_EXISTS_RE = /already exists|already been created/i;

function isMissingCli(failure: RunnerFailure): boolean {
  return failure.code === "ENOENT" || /\bENOENT\b/.test(failure.text);
}

function cliName(provider: "github" | "gitlab"): string {
  return provider === "github" ? "gh" : "glab";
}

function providerLabel(provider: "github" | "gitlab"): string {
  return provider === "github" ? "PR" : "MR";
}

function missingCliMessage(provider: "github" | "gitlab"): string {
  return provider === "github"
    ? "未找到 gh CLI，请先安装并登录（gh auth login）"
    : "未找到 glab CLI，请先安装并登录（glab auth login）";
}

function authMessage(provider: "github" | "gitlab"): string {
  return provider === "github"
    ? "gh 未登录，请先在终端运行 gh auth login"
    : "glab 未登录，请先在终端运行 glab auth login";
}

interface Target {
  supported: boolean;
  host: string | null;
  provider: "github" | "gitlab" | null;
  error?: string;
}

function unsupportedStatus(target: Target): PullRequestStatus {
  const status: PullRequestStatus = {
    supported: false,
    host: target.host,
    exists: false,
    checks: [],
  };
  if (target.error) status.error = target.error;
  return status;
}

/** 从会话 cwd 的 origin 远端判断托管平台。 */
async function resolveTarget(run: CommandRunner, session: SessionCore): Promise<Target> {
  if (!session.git) {
    return { supported: false, host: null, provider: null, error: "这个对话不是 git 仓库" };
  }
  let remoteUrl: string;
  try {
    const { stdout } = await run.run("git", ["remote", "get-url", "origin"], {
      cwd: session.cwd,
      timeoutMs: REMOTE_TIMEOUT_MS,
    });
    remoteUrl = stdout.trim();
  } catch (error) {
    const failure = readFailure(error);
    return {
      supported: false,
      host: null,
      provider: null,
      error: failure.text ? `读取远端失败：${truncate(failure.text)}` : "这个仓库没有 origin 远端",
    };
  }
  if (!remoteUrl) {
    return { supported: false, host: null, provider: null, error: "这个仓库没有 origin 远端" };
  }
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return { supported: false, host: null, provider: null, error: `无法识别远端地址：${truncate(remoteUrl)}` };
  }
  const provider = detectProvider(host);
  if (!provider) {
    return { supported: false, host, provider: null, error: `不支持的托管平台：${host}` };
  }
  return { supported: true, host, provider };
}

async function readStatus(
  run: CommandRunner,
  provider: "github" | "gitlab",
  cwd: string,
): Promise<PullRequestStatus> {
  const command = cliName(provider);
  const args = provider === "github" ? GH_VIEW_ARGS : GLAB_VIEW_ARGS;
  try {
    const { stdout } = await run.run(command, args, { cwd, timeoutMs: VIEW_TIMEOUT_MS });
    let parsed: ParsedView | null;
    try {
      parsed = provider === "github" ? parseGithubView(stdout) : parseGitlabView(stdout);
    } catch {
      throw new Error("CLI 返回了无法解析的输出");
    }
    if (!parsed) {
      return { supported: true, host: provider, exists: false, checks: [] };
    }
    return { supported: true, host: provider, exists: true, ...parsed };
  } catch (error) {
    const failure = readFailure(error);
    const empty: PullRequestStatus = { supported: true, host: provider, exists: false, checks: [] };
    if (isMissingCli(failure)) return { ...empty, error: missingCliMessage(provider) };
    if (AUTH_RE.test(failure.text)) return { ...empty, error: authMessage(provider) };
    if (NO_PR_RE.test(failure.text)) return empty;
    const detail = truncate(failure.text) || "命令执行失败";
    return { ...empty, error: `读取 ${providerLabel(provider)} 状态失败：${detail}` };
  }
}

interface CreateInput {
  title: string;
  body: string;
  base?: string;
}

function parseCreateInput(value: unknown): { input?: CreateInput; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "请求体必须是 JSON 对象" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string") return { error: "请填写标题" };
  const title = record.title.trim();
  if (title.length === 0) return { error: "请填写标题" };
  if (title.length > MAX_TITLE) return { error: `标题不能超过 ${MAX_TITLE} 字` };
  if (record.body !== undefined && typeof record.body !== "string") {
    return { error: "正文必须是字符串" };
  }
  const body = typeof record.body === "string" ? record.body : "";
  if (body.length > MAX_BODY) return { error: `正文不能超过 ${MAX_BODY} 字` };
  if (record.base !== undefined && typeof record.base !== "string") {
    return { error: "base 必须是字符串" };
  }
  const base = typeof record.base === "string" ? record.base.trim() : "";
  return { input: { title, body, ...(base ? { base } : {}) } };
}

export function createCommandArgs(provider: "github" | "gitlab", input: CreateInput): string[] {
  // 值统一用 --flag=value：标题/正文以 “-” 开头时也不会被当成选项。
  if (provider === "github") {
    const args = ["pr", "create", `--title=${input.title}`, `--body=${input.body}`];
    if (input.base) args.push(`--base=${input.base}`);
    return args;
  }
  const args = ["mr", "create", `--title=${input.title}`, `--description=${input.body}`, "--yes"];
  if (input.base) args.push(`--target-branch=${input.base}`);
  return args;
}

function extractUrl(text: string): string | undefined {
  // 创建命令可能打印含凭证的 URL；先脱敏再作为响应字段返回。
  const match = /https?:\/\/[^\s"'<>)]+/.exec(redactGitCredentials(text));
  return match?.[0];
}

/** rev-parse 失败或空输出时返回 null。 */
async function readCurrentBranch(run: CommandRunner, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeoutMs: BRANCH_TIMEOUT_MS,
    });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

const SESSION_BRANCH_ERROR = "只允许为会话分支（qubius/、qoder/ 或 remote-coder/）创建 PR/MR";

type CreateOutcome =
  | { ok: true; status: PullRequestStatus }
  | { ok: false; status: number; error: string };

async function createPullRequest(
  run: CommandRunner,
  provider: "github" | "gitlab",
  session: SessionCore,
  input: CreateInput,
): Promise<PullRequestStatus> {
  const empty: PullRequestStatus = { supported: true, host: provider, exists: false, checks: [] };
  // 普通 push，不 force：远端拒绝时把原因交给用户。
  try {
    await run.run("git", ["push", "-u", "origin", "HEAD"], {
      cwd: session.cwd,
      timeoutMs: PUSH_TIMEOUT_MS,
    });
  } catch (error) {
    const failure = readFailure(error);
    return { ...empty, error: `推送分支失败：${truncate(failure.text) || "git push 执行失败"}` };
  }

  try {
    const result = await run.run(cliName(provider), createCommandArgs(provider, input), {
      cwd: session.cwd,
      timeoutMs: CREATE_TIMEOUT_MS,
    });
    const createdUrl = extractUrl(result.stdout) ?? extractUrl(result.stderr);
    const status = await readStatus(run, provider, session.cwd);
    const merged: PullRequestStatus = {
      ...status,
      supported: true,
      host: provider,
      created: true,
    };
    if (!merged.exists && createdUrl && !merged.url) merged.url = createdUrl;
    return merged;
  } catch (error) {
    const failure = readFailure(error);
    if (isMissingCli(failure)) return { ...empty, error: missingCliMessage(provider) };
    if (AUTH_RE.test(failure.text)) return { ...empty, error: authMessage(provider) };
    if (ALREADY_EXISTS_RE.test(failure.text)) {
      return { ...empty, error: `这个分支已经有 ${providerLabel(provider)}` };
    }
    const detail = truncate(failure.text) || "命令执行失败";
    return { ...empty, error: `创建 ${providerLabel(provider)} 失败：${detail}` };
  }
}

export interface PullRequestHandlerOptions {
  /** 测试注入的命令执行器；缺省走本机真实 CLI。 */
  run?: CommandRunner;
}

/**
 * 生成路由处理器。默认导出的 handlePullRequestRoutes 使用真实 CLI；
 * 测试用 createPullRequestHandler({ run }) 注入假 runner。
 */
export function createPullRequestHandler(options: PullRequestHandlerOptions = {}): FeatureHandler {
  const run = options.run ?? defaultCommandRunner;
  return async (ctx: FeatureContext): Promise<FeatureResult | null> => {
    const match = ROUTE_RE.exec(ctx.url.pathname);
    if (!match) return null;
    const sessionId = match[1] ?? "";
    if (!sessionId) return null;
    if (ctx.method !== "GET" && ctx.method !== "POST") {
      return { status: 405, body: { error: "不支持的请求方法" } };
    }
    const session = ctx.store.get(sessionId);
    if (!session) return { status: 404, body: { error: "找不到对话" } };

    if (ctx.method === "GET") {
      const target = await resolveTarget(run, session);
      if (!target.supported || !target.provider) {
        return { status: 200, body: unsupportedStatus(target) };
      }
      return { status: 200, body: await readStatus(run, target.provider, session.cwd) };
    }

    // POST：创建 PR/MR。运行/排队/等确认时先拒绝，避免推送和 agent 抢分支；
    // 归档/清理中的会话也不允许动 git。
    const busyPhase = session.phase === "queued"
      || session.phase === "running"
      || session.phase === "needs_input";
    if (session.turnActive || busyPhase) {
      return { status: 409, body: { error: "对话进行中，完成后再创建 PR/MR" } };
    }
    if (isSessionBusy(session.id)) {
      return { status: 409, body: { error: "对话正在归档或清理，请稍后再试" } };
    }
    let raw: unknown;
    try {
      raw = await ctx.readJson(ctx.req);
    } catch {
      return { status: 400, body: { error: "请求体不是合法的 JSON" } };
    }
    const parsed = parseCreateInput(raw);
    if (!parsed.input) {
      return { status: 400, body: { error: parsed.error ?? "参数不正确" } };
    }
    const target = await resolveTarget(run, session);
    if (!target.supported || !target.provider) {
      return { status: 200, body: unsupportedStatus(target) };
    }
    const provider = target.provider;
    const input = parsed.input;
    try {
      // 整个 push + create 流程和 GitPanel 共用同一把 git 锁。
      const outcome = await withGitAction(session.id, async (): Promise<CreateOutcome> => {
        // 先确认 HEAD 仍是要创建 PR 的会话分支：终端里切到 main 或历史数据
        // 的 cwd 就是项目目录时，不能把用户当前分支推走。
        const branch = await readCurrentBranch(run, session.cwd);
        if (!branch) {
          return { ok: false, status: 400, error: "无法读取当前分支，不能创建 PR/MR" };
        }
        if (!isSessionBranch(branch)) {
          return { ok: false, status: 400, error: SESSION_BRANCH_ERROR };
        }
        return { ok: true, status: await createPullRequest(run, provider, session, input) };
      });
      if (!outcome.ok) return { status: outcome.status, body: { error: outcome.error } };
      return { status: 200, body: outcome.status };
    } catch (error) {
      if (error instanceof GitActionBusyError) {
        return { status: 409, body: { error: "这个对话已有 git 操作在进行，请稍后再试" } };
      }
      // 预期错误都在 createPullRequest 内处理；这里兜底也不能把凭证带出去。
      const detail = truncate(error instanceof Error ? error.message : "");
      return {
        status: 500,
        body: { error: detail ? `创建 PR/MR 失败：${detail}` : "创建 PR/MR 失败" },
      };
    }
  };
}

export const handlePullRequestRoutes: FeatureHandler = createPullRequestHandler();
