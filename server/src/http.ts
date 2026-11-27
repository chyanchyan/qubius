import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAccessEntries } from "./access-entries.js";
import { ArchiveError, type ArchiveStore } from "./archive.js";
import { tokenFromRequest, tokenMatches } from "./auth.js";
import { resolveBuildInfo } from "./build-info.js";
import {
  CHAT_PROJECT_ID,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_LIMITS,
  type AppConfig,
  type ProjectConfig,
} from "./config.js";
import {
  DeployDataDirChangeError,
  DeployValidationError,
  applyDeploy,
  deployBusy,
  deployConfigDir,
  readDeployEnvValue,
  readDeployJob,
  readDeployState,
  redeployWithPull,
  saveGithubRepo,
  type ApplyDeployResult,
} from "./deploy.js";
import {
  resetAuthToken,
  resetLanPassword,
  restartLanProxy,
  type AuthTokenState,
} from "./credential-reset.js";
import type { EdgeActionDeps } from "./edge/actions.js";
import { handleEdgeRequest } from "./edge/http.js";
import { envFlag } from "./env.js";
import { handleFeatureRoutes } from "./feature-routes.js";
import { GitActionBusyError, withGitAction } from "./git-lock.js";
import { fetchGithubVersion } from "./github-version.js";
import {
  copyImageRefs,
  findImage,
  imageFilePath,
  ImageInputError,
  isImageMediaType,
  MAX_IMAGES,
  parseIncomingImages,
  readSavedImages,
  removeSessionImages,
  saveImages,
  type IncomingImage,
} from "./images.js";
import { isPermission, type PermissionLevel } from "./permissions.js";
import { resolvePermission, saveProjectPermissions } from "./project-permissions.js";
import { appendProjectToFile, readProjectsFile, removeProjectFromFile } from "./project-source.js";
import { describeProject } from "./projects.js";
import {
  createGitRepo,
  projectIdFromName,
  RepoCreateError,
  resolveNewRepoPath,
} from "./repo-create.js";
import { testProvider } from "./provider-test.js";
import { PushError, type PushSendResult, type PushService } from "./push.js";
import { redact, type Approval, type Runtime, type RuntimePrompt } from "./runtime.js";
import { clip, configureLimits, detectWorkflowSkill } from "./status.js";
import { MAX_DISCUSSION_PARTICIPANTS } from "./discussion.js";
import type { ScheduleRunner, ScheduleStore } from "./schedules.js";
import type { ArchiveSweeper } from "./retention.js";
import { readSecondaryStatus, startSecondaryAction } from "./secondary.js";
import { readSubagentTranscript } from "./subagent-detail.js";
import {
  entriesFromSdkMessages,
  findUserMessageIndex,
  remapForks,
  ROOT_FORK_POINT,
  sliceBefore,
  sliceThrough,
} from "./session-rewind.js";
import { titleFromPrompt } from "./session-title.js";
import {
  relocateSdkSession,
  removeSdkSessionFilesForIds,
  sdkProjectSlug,
  sessionSdkIds,
  SUBAGENT_TASK_ID_RE,
} from "./sdk-files.js";
import { removeDiffComments } from "./diff-comments.js";
import { removeSessionWorkspace } from "./session-cleanup.js";
import {
  createSkill,
  findSkillDomain,
  listSkills,
  readSkill,
  SkillError,
  SkillSettings,
  skillKey,
  writeSkill,
} from "./skills.js";
import { isSessionBusy, tryLockSession, unlockSession } from "./session-lock.js";
import {
  applySettingsPatch,
  findProvider,
  providerKind,
  publicSettings,
  resolveSettings,
  saveSettings,
  type StoredSettings,
} from "./settings.js";
import { SseQueue } from "./sse.js";
import type { SessionEvent, Store } from "./store.js";
import { TerminalLimitError } from "./terminal.js";
import type { TerminalController } from "./terminal-http.js";
import {
  isEffort,
  type DiscussionParticipant,
  type ImageMediaType,
  type ImageRef,
  type ProjectInfo,
  type SessionCore,
  type SessionSummary,
  type TranscriptItem,
  type WorkflowSkill,
} from "./types.js";
import {
  commitAndPush,
  createWorktree,
  diffSummary,
  gitStatus,
  isGitRepo,
  mergedSessionBranches,
  removeWorktree,
  sessionBranch,
} from "./worktree.js";
import { prepareWorktree } from "./worktree-prep.js";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

// 保守的 CSP：生产构建只加载同源的 /assets/*.js，没有内联脚本。
// style 放开内联，img 允许 data:/blob:（附件预览），避免误伤前端。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Markdown 允许渲染 http(s) 图片，这里保持同样的来源范围。
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  // 命令行用同源 SSE/POST（普通 HTTP），'self' 已经覆盖。
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

// 编译后的 http.js 与 build.json 同在 server/dist 下；开发时读 server/src，通常不存在。
const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD_INFO_FILE = path.join(here, "build.json");
// src 和 dist 往上两级都是 checkout 根，开发环境据此回退到 package.json 的版本号。
const PACKAGE_FILE = path.join(here, "..", "..", "package.json");

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CSP,
  };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 部署提交的统一响应：202 表示任务已启动，409 区分 busy 与残留进程。 */
function sendDeployResult(res: ServerResponse, result: ApplyDeployResult): void {
  if ("jobId" in result) {
    sendJson(res, 202, {
      ok: true,
      jobId: result.jobId,
      // 局域网密码和 API 令牌只在这次响应里出现一次。
      ...(result.oneTime ? { oneTime: result.oneTime } : {}),
    });
    return;
  }
  // busy 保持旧文案兼容；residual 用独立文案，避免前端按 busy 误判。
  sendJson(res, 409, {
    error:
      result.code === "residual"
        ? "部署锁空闲但存在残留进程，请先回收"
        : "已有部署任务在运行",
    code: result.code,
    ...(result.kind ? { kind: result.kind } : {}),
    ...(result.remainingPids ? { remainingPids: result.remainingPids } : {}),
  });
}

/** 数据目录变化且旧目录有会话：结构化 409，前端据此弹二次确认。 */
function sendDataDirConflict(res: ServerResponse, error: DeployDataDirChangeError): void {
  sendJson(res, 409, {
    error: error.message,
    code: "data-dir-change",
    currentDataDir: error.currentDataDir,
    targetDataDir: error.targetDataDir,
    sessions: error.sessions,
  });
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireString(value: unknown, field: string, label: string): string {
  const item = bodyRecord(value)[field];
  if (typeof item !== "string") throw new HttpError(400, `缺少${label}`);
  return item;
}

function requireBoolean(value: unknown, field: string, label: string): boolean {
  const item = bodyRecord(value)[field];
  if (typeof item !== "boolean") throw new HttpError(400, `${label} 必须是布尔值`);
  return item;
}

function throwSkillError(error: unknown): never {
  if (error instanceof SkillError) throw new HttpError(error.status, error.message);
  throw error;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** 内部运维接口只接受本机连接（IPv4、IPv6 以及 IPv4-mapped 写法）。 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function splitHost(value: string): { host: string; hostname: string; hasPort: boolean } {
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end >= 0) {
      return { host, hostname: host.slice(0, end + 1), hasPort: host.length > end + 1 };
    }
  }
  const colon = host.lastIndexOf(":");
  // 只有一个冒号才当作端口；裸 IPv6（如 `::1`）整体作为主机名。
  if (colon > 0 && host.indexOf(":") === colon && /^\d+$/.test(host.slice(colon + 1))) {
    return { host, hostname: host.slice(0, colon), hasPort: true };
  }
  return { host, hostname: host, hasPort: false };
}

function hostAllowed(allowed: readonly string[] | undefined, hostHeader: string): boolean {
  // 空数组等同于“没有允许的主机”，必须 fail-closed，不能当成关闭校验。
  if (!allowed || allowed.length === 0) return false;
  const request = splitHost(hostHeader);
  if (!request.host) return false;
  return allowed.some((entry) => {
    const rule = splitHost(entry);
    // 配置项带端口时精确比较；不带端口时允许同主机名的任意端口。
    return rule.hasPort ? rule.host === request.host : rule.hostname === request.hostname;
  });
}

/** Origin/Referer 的主机是否等于 lan-proxy 改写前的原始 Host。 */
function forwardedHostMatches(forwardedHost: string, origin: URL): boolean {
  const forwarded = splitHost(forwardedHost);
  if (!forwarded.host) return false;
  // 与 hostAllowed 的规则一致：原始 Host 带端口时精确比较，不带端口时只比主机名。
  return forwarded.hasPort
    ? forwarded.host === origin.host
    : forwarded.hostname === origin.hostname;
}

export interface OriginSource {
  origin?: string;
  referer?: string;
  remoteAddress?: string;
  forwardedHost?: string;
  allowedHosts?: readonly string[];
}

/**
 * 缺少 Sec-Fetch-Site 时的 Origin/Referer 回退校验：
 * - Origin（没有则 Referer）都没有时放行，兼容 curl/原生客户端；
 * - 主机在 allowedHosts 里直接放行；
 * - 经 lan-proxy 转发（来源是回环）且 Origin 主机等于改写前原 Host
 *   （x-forwarded-host）时也放行，局域网入口改 Host 后不会误杀；
 * - 解析失败或 Origin 为 "null" 时报 403。
 *
 * 独立成纯函数便于测试非回环来源伪造 x-forwarded-host 的代码路径。
 */
export function originSourceAllowed({
  origin = "",
  referer = "",
  remoteAddress,
  forwardedHost = "",
  allowedHosts,
}: OriginSource): boolean {
  const source = origin.trim() || referer.trim();
  if (!source) return true;
  if (source.toLowerCase() === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!parsed.host) return false;
  if (hostAllowed(allowedHosts, parsed.host)) return true;
  if (!isLoopbackAddress(remoteAddress)) return false;
  const forwarded = forwardedHost.trim();
  return Boolean(forwarded) && forwardedHostMatches(forwarded, parsed);
}

function originAllowed(req: IncomingMessage, allowedHosts: readonly string[] | undefined): boolean {
  return originSourceAllowed({
    origin: headerValue(req.headers.origin),
    referer: headerValue(req.headers.referer),
    remoteAddress: req.socket.remoteAddress,
    forwardedHost: headerValue(req.headers["x-forwarded-host"]),
    allowedHosts,
  });
}

function validateApiRequest(
  req: IncomingMessage,
  method: string,
  allowedHosts: readonly string[] | undefined,
  tokenState: AuthTokenState,
  pathname: string,
): void {
  const fetchSite = headerValue(req.headers["sec-fetch-site"]).trim().toLowerCase();
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "跨站请求被拒绝");
  }
  // 浏览器带了 Sec-Fetch-Site 时已经声明了来源关系（lan-proxy 会把 Host 改写成回环，
  // 再按 Origin 比较会误杀局域网访问），只在缺失/为空时回退到 Origin/Referer。
  if (!fetchSite && !originAllowed(req, allowedHosts)) {
    throw new HttpError(403, "来源不被允许");
  }
  if (!hostAllowed(allowedHosts, headerValue(req.headers.host))) {
    throw new HttpError(403, "Host 不被允许");
  }
  // /api/health 供部署脚本探活，不要求令牌；其余 API 在启用令牌后必须匹配。
  // 刚重置令牌时旧令牌有 60 秒宽限，避免在途请求/页面自动刷新立刻 401。
  const provided = tokenFromRequest(req);
  const current = tokenState.current;
  const previous = tokenState.previousUntil && Date.now() < tokenState.previousUntil
    ? tokenState.previous
    : undefined;
  if (
    current
    && pathname !== "/api/health"
    && !tokenMatches(current, provided)
    && !(previous && tokenMatches(previous, provided))
  ) {
    throw new HttpError(401, "需要访问令牌");
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const contentType = headerValue(req.headers["content-type"]).trim().toLowerCase();
    if (!contentType.startsWith("application/json")) {
      throw new HttpError(415, "请求必须使用 application/json");
    }
  }
}

// 启动时读一次，health 描述的是正在运行的那份代码。每次请求都重新读文件
// 会让“重新构建但没重启”的旧进程也报告新 build，从而骗过部署校验。
const BUILD_INFO = resolveBuildInfo(BUILD_INFO_FILE, PACKAGE_FILE);
const BUILD_HEAD = BUILD_INFO.head;

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 进程内存用量（MB，四舍五入）；健康检查用来观察长会话/慢连接是否撑大堆。 */
function memoryMb(): {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
} {
  const usage = process.memoryUsage();
  const mb = (value: number): number => Math.round(value / (1024 * 1024));
  return {
    rss: mb(usage.rss),
    heapUsed: mb(usage.heapUsed),
    heapTotal: mb(usage.heapTotal),
    external: mb(usage.external),
    arrayBuffers: mb(usage.arrayBuffers),
  };
}

export function createAppServer(options: {
  config: AppConfig;
  store: Store;
  runtime: Runtime;
  webDist: string;
  settings: { current: StoredSettings };
  permissions: { current: Record<string, PermissionLevel> };
  repoRoot: string;
  archive?: ArchiveStore;
  sweeper?: ArchiveSweeper;
  push?: PushService;
  schedules?: ScheduleStore;
  scheduleRunner?: ScheduleRunner;
  /** 配置文件不存在（冷启动）时为 true，部署页据此引导填写。 */
  setupRequired?: boolean;
  /** 公网入口依赖注入（测试）；生产使用默认实现。 */
  edge?: Partial<EdgeActionDeps>;
  /** 技能管理；configDir 用于测试时指向临时 Claude 配置目录。 */
  skills?: { store: SkillSettings; configDir?: string };
  /** 读取子任务 transcript 的 Claude 配置目录；测试时指向临时目录。 */
  sdkConfigDir?: string;
  /** 启用 API 访问令牌后，除 /api/health 外的 API 请求必须携带。 */
  authToken?: string;
  /** 可变的令牌状态；重置令牌后立即切换，旧值保留 60 秒宽限。 */
  authTokenState?: AuthTokenState;
  /** 当前配置文件的绝对路径；/api/deploy 用它展示「配置在哪」（支持 --config 自定义路径）。 */
  configFile?: string;
  /** 令牌来源；file 时附带 tokenFile，供登录框和部署页提示去哪里找。 */
  authTokenSource?: "config" | "env" | "file";
  authTokenFile?: string;
  /** 开发机命令行；未注入时 /api/terminal 返回 503。 */
  terminal?: TerminalController;
  /**
   * 部署任务请求优雅退出用的令牌；只有配置了它才暴露
   * POST /api/internal/shutdown。只接受本机回环连接。
   */
  shutdownToken?: string;
  /** 校验通过后触发收尾退出；由 index.ts 接到 runShutdown。 */
  shutdown?: (reason: string) => void;
}) {
  const { config, store, runtime, webDist, repoRoot } = options;
  /**
   * 令牌来源：index.ts 解析出的（含自动生成）优先；直接构造 AppConfig 的入口
   * 回退到 config.authToken。auth: false 显式关闭时不再使用配置里的令牌。
   * 重置接口会原地修改 tokenState，所以这里用可变对象而不是字符串。
   */
  const tokenState: AuthTokenState = options.authTokenState ?? {
    current: options.authToken ?? (config.auth === false ? undefined : config.authToken),
    ...(options.authTokenSource ? { source: options.authTokenSource } : {}),
    ...(options.authTokenFile ? { file: options.authTokenFile } : {}),
  };
  /** 技能开关落在 dataDir；测试也可以注入独立的 store/configDir。 */
  const skillStore = options.skills?.store ?? new SkillSettings(config.dataDir);
  const skillConfigDir = options.skills?.configDir;
  const skillsOptions = () => ({
    config,
    ...(skillConfigDir ? { configDir: skillConfigDir } : {}),
    disabled: skillStore.snapshot(),
  });
  /**
   * 运行期上限以设置文件为准（首次启动时继承 config.yaml）；测试夹具没有这些字段时
   * 退回配置或默认值。每次请求现读，设置页保存后立即生效。
   */
  const currentLimits = () => ({
    ...DEFAULT_LIMITS,
    ...(config.limits ?? {}),
    ...(options.settings.current.limits ?? {}),
  });
  const readJson = (req: IncomingMessage): Promise<unknown> => readJsonBody(req, currentLimits().requestBodyBytes);
  /**
   * web/dist 构建产物就绪后不再回退，所以只缓存 true；false 继续重探，
   * 避免服务先启动、之后再构建前端时 /api/health 一直报 false。
   * dataDirWritable 是探活信号，必须每次检查，不能缓存。
   */
  let webDistReady = false;
  const hasWebDist = (): boolean => {
    if (!webDistReady) webDistReady = fs.existsSync(path.join(webDist, "index.html"));
    return webDistReady;
  };

  /** 列表/详情事件都补上运行时队列和文件检查点状态；测试 stub 可能没有这些方法。 */
  function withQueue(summary: SessionEvent): SessionEvent {
    if (summary.removed) return summary;
    const snapshot = typeof runtime.queueSnapshot === "function" ? runtime.queueSnapshot(summary.id) : [];
    return {
      ...summary,
      queue: snapshot,
      canRewindFiles: typeof runtime.canRewindFiles === "function"
        ? Boolean(runtime.canRewindFiles(summary.id))
        : false,
    };
  }
  return createServer(async (req, res) => {
    try {
      await route(req, res, options);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "服务器错误";
      sendJson(res, status, { error: redact(message, options.settings.current.providers.map((provider) => provider.apiKey)) });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse, ctx: typeof options): Promise<void> {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = req.method || "GET";
    // 部署任务在 Windows 上需要让旧进程优雅收尾（Windows 的 SIGTERM 是硬杀）。
    // 这条路由先于通用的 Host/访问令牌校验：令牌来自 dataDir 里的随机文件，
    // 且只接受本机回环连接。
    if (url.pathname === "/api/internal/shutdown" && method === "POST") {
      const expected = options.shutdownToken;
      const provided = headerValue(req.headers["x-qubius-shutdown-token"]);
      if (!expected || !options.shutdown) throw new HttpError(404, "未启用");
      if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, "只允许本机连接");
      if (!tokenMatches(expected, provided)) throw new HttpError(403, "令牌不正确");
      sendJson(res, 202, { ok: true });
      // 先让响应发出去，再开始收尾；收尾会关掉监听套接字并最终退出进程。
      setImmediate(() => options.shutdown?.("deploy-shutdown"));
      return;
    }
    if (isApiPath(url.pathname)) {
      // 直接构造 AppConfig 的测试夹具没写 allowedHosts 时也使用默认回环白名单；
      // 显式空数组同样回退到默认白名单（而不是关闭校验）。
      const allowedHosts = config.allowedHosts?.length ? config.allowedHosts : DEFAULT_ALLOWED_HOSTS;
      // 显式配置的 authToken 也直接生效；自动生成令牌仍由 index.ts 完成。
      validateApiRequest(
        req,
        method,
        allowedHosts,
        tokenState,
        url.pathname,
      );
    }
    if (url.pathname === "/api/health" && method === "GET") {
      sendJson(res, 200, {
        ok: true,
        role: config.role,
        ...(BUILD_HEAD ? { head: BUILD_HEAD } : {}),
        ...(BUILD_INFO.version ? { version: BUILD_INFO.version } : {}),
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        dataDirWritable: isWritable(config.dataDir),
        webDist: hasWebDist(),
        memory: memoryMb(),
        // 排队/运行/等待确认的会话数；部署脚本据此避免静默打断正在工作的 agent。
        activeSessions: store.activeCount(),
        // 登录框还没拿到令牌时用它提示「令牌文件在哪」；只暴露路径，不暴露令牌。
        authRequired: Boolean(tokenState.current),
        ...(tokenState.file ? { authTokenFile: tokenState.file } : {}),
      });
      return;
    }
    if (url.pathname === "/api/instance" && method === "GET") {
      // 重启副实例会中断进行中的会话，页面用它提示同步的影响。
      const activeSessions = store.activeCount();
      sendJson(res, 200, {
        role: config.role,
        secondary: readSecondaryStatus(config, repoRoot, BUILD_HEAD),
        terminal: Boolean(ctx.terminal),
        activeSessions,
        // 顶栏据此在「当前入口」图标旁标出实例还开放了哪些入口。
        access: readAccessEntries({
          config,
          repoRoot,
          env: process.env,
          ...(ctx.edge ? { edge: ctx.edge } : {}),
        }),
        ...(BUILD_INFO.version ? { version: BUILD_INFO.version } : {}),
      });
      return;
    }
    if (url.pathname === "/api/deploy/github-version" && method === "GET") {
      // env 文件里的 QUBIUS_GITHUB_REPO 是部署页直接可改的设置；以文件为准，
      // 这样保存后无需重启就能反映到版本对照（进程环境只作回落）。
      const githubEnv = { ...process.env };
      const configured = readDeployEnvValue(process.env, process.platform, repoRoot, "QUBIUS_GITHUB_REPO");
      if (configured !== undefined) {
        if (configured.trim()) githubEnv.QUBIUS_GITHUB_REPO = configured;
        else delete githubEnv.QUBIUS_GITHUB_REPO;
      }
      // 外网不可用时不报 5xx，页面显示为“无法获取”即可。
      sendJson(res, 200, await fetchGithubVersion({
        repoRoot,
        current: BUILD_INFO.version,
        env: githubEnv,
      }));
      return;
    }
    if (url.pathname === "/api/deploy" && method === "GET") {
      sendJson(res, 200, await readDeployState({
        role: config.role,
        repoRoot,
        port: config.port,
        setupRequired: options.setupRequired,
        config,
        ...(options.configFile ? { configFile: options.configFile } : {}),
        authEnabled: Boolean(tokenState.current),
        ...(tokenState.source ? { authTokenSource: tokenState.source } : {}),
        ...(tokenState.file ? { authTokenFile: tokenState.file } : {}),
      }));
      return;
    }
    if (url.pathname === "/api/deploy/status" && method === "GET") {
      sendJson(res, 200, { job: readDeployJob(deployConfigDir(process.env, process.platform, repoRoot)) });
      return;
    }
    if (url.pathname === "/api/config/token" && method === "GET") {
      // 只有启用令牌时才有值；启用后本路由已经通过令牌校验，调用方本来就知道它。
      // 用途：Windows/首次登录时在部署页直接复制，不用去数据目录翻 auth-token 文件。
      if (!tokenState.current) throw new HttpError(404, "未启用访问令牌");
      sendJson(res, 200, {
        token: tokenState.current,
        source: tokenState.source ?? (config.authToken ? "config" : "file"),
        ...(tokenState.file ? { file: tokenState.file } : {}),
      });
      return;
    }
    if (url.pathname === "/api/deploy/lan-credentials/reset" && method === "POST") {
      const configDir = deployConfigDir(process.env, process.platform, repoRoot);
      if (deployBusy(configDir)) throw new HttpError(409, "已有部署任务在运行");
      const body = await readJson(req);
      const requested = body && typeof body === "object" && !Array.isArray(body)
        ? (body as { user?: unknown }).user
        : undefined;
      const user = typeof requested === "string" ? requested : undefined;
      const { result, credentialsFile, needsRestart } = resetLanPassword({
        config,
        configDir,
        repoRoot,
        env: process.env,
        user,
      });
      // 先响应再重启：如果页面是通过局域网入口访问的，重启会断开当前连接。
      sendJson(res, 200, { ok: true, lan: result });
      if (needsRestart) {
        setTimeout(() => {
          void restartLanProxy(config, repoRoot, process.env, credentialsFile).catch((error) => {
            console.warn("[lan] 重启局域网入口失败", error);
          });
        }, 500);
      }
      return;
    }
    if (url.pathname === "/api/deploy/auth-token/reset" && method === "POST") {
      const configDir = deployConfigDir(process.env, process.platform, repoRoot);
      if (deployBusy(configDir)) throw new HttpError(409, "已有部署任务在运行");
      try {
        const result = resetAuthToken({
          config,
          configDir,
          repoRoot,
          env: process.env,
          state: tokenState,
        });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "重置令牌失败");
      }
      return;
    }
    if (url.pathname === "/api/deploy/apply" && method === "POST") {
      const body = await readJson(req);
      let result;
      try {
        result = applyDeploy({
          body,
          repoRoot,
          ...(options.configFile ? { configFile: options.configFile } : {}),
          role: config.role,
          dataDir: config.dataDir,
          port: config.port,
        });
      } catch (error) {
        if (error instanceof DeployDataDirChangeError) {
          sendDataDirConflict(res, error);
          return;
        }
        if (error instanceof DeployValidationError) throw new HttpError(400, error.message);
        throw error;
      }
      sendDeployResult(res, result);
      return;
    }
    if (url.pathname === "/api/deploy/update" && method === "POST") {
      // 「从 GitHub 更新并部署」：按服务端当前保存的配置重新部署，构建前拉取。
      // 不接受页面表单，避免把未保存的改动或客户端伪造的配置写进 env。
      if (options.setupRequired) throw new HttpError(400, "还没有部署配置，请先完成首次部署");
      // 动作本身不需要配置参数；只接受“已确认停止当前实例”这个布尔值。
      const body = await readJson(req);
      const confirmStopInstance = Boolean(
        body && typeof body === "object" && !Array.isArray(body)
        && (body as { confirmStopInstance?: unknown }).confirmStopInstance === true,
      );
      let result;
      try {
        result = redeployWithPull({
          repoRoot,
          ...(options.configFile ? { configFile: options.configFile } : {}),
          role: config.role,
          dataDir: config.dataDir,
          port: config.port,
          confirmStopInstance,
        });
      } catch (error) {
        if (error instanceof DeployDataDirChangeError) {
          sendDataDirConflict(res, error);
          return;
        }
        if (error instanceof DeployValidationError) throw new HttpError(400, error.message);
        throw error;
      }
      sendDeployResult(res, result);
      return;
    }
    if (url.pathname === "/api/deploy/github-repo" && method === "POST") {
      // 部署页「GitHub 仓库」快捷设置：只改 env 里的一个键，不触发重新部署。
      if (options.setupRequired) throw new HttpError(400, "还没有部署配置，请先完成首次部署");
      const body = await readJson(req);
      const configDir = deployConfigDir(process.env, process.platform, repoRoot);
      if (deployBusy(configDir)) throw new HttpError(409, "已有部署任务在运行");
      try {
        sendJson(res, 200, {
          ok: true,
          ...saveGithubRepo({ repoRoot, repo: bodyRecord(body).repo }),
        });
      } catch (error) {
        if (error instanceof DeployValidationError) throw new HttpError(400, error.message);
        throw error;
      }
      return;
    }
    if (url.pathname === "/api/edge" || url.pathname.startsWith("/api/edge/")) {
      const handled = await handleEdgeRequest(req, res, url, method, {
        repoRoot,
        role: config.role,
        ...ctx.edge,
      });
      if (handled) return;
    }
    if (url.pathname === "/api/secondary/sync" && method === "POST") {
      requireSecondary(config);
      if (startSecondaryAction(config, repoRoot, "sync") === "busy") {
        throw new HttpError(409, "已有维护任务在运行");
      }
      sendJson(res, 202, { ok: true });
      return;
    }
    if (url.pathname === "/api/secondary/rollback" && method === "POST") {
      requireSecondary(config);
      if (startSecondaryAction(config, repoRoot, "rollback") === "busy") {
        throw new HttpError(409, "已有维护任务在运行");
      }
      sendJson(res, 202, { ok: true });
      return;
    }
    if (url.pathname === "/api/terminal" && method === "POST") {
      const terminal = ctx.terminal;
      if (!terminal) throw new HttpError(404, "命令行已关闭");
      const body = asRecord(await readJson(req));
      /* 从项目页点「命令行」时带上 project，PTY 直接在该项目仓库路径下打开。
         只接受配置里的项目 id，避免把任意路径暴露给终端。 */
      const projectId = typeof body.project === "string" ? body.project.trim() : "";
      let cwd: string | undefined;
      if (projectId) {
        const project = config.projects.find((item) => item.id === projectId);
        if (!project) throw new HttpError(404, "项目不存在");
        let available = false;
        try {
          available = fs.statSync(project.path).isDirectory();
        } catch {
          available = false;
        }
        if (!available) throw new HttpError(400, `项目目录不可用：${project.path}`);
        cwd = project.path;
      }
      try {
        sendJson(res, 201, terminal.create({
          cols: body.cols,
          rows: body.rows,
          ...(cwd ? { cwd } : {}),
        }));
      } catch (error) {
        if (error instanceof TerminalLimitError) throw new HttpError(503, error.message);
        throw error;
      }
      return;
    }
    const terminalRoute = url.pathname.match(
      /^\/api\/terminal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/stream|\/input|\/resize)?$/i,
    );
    if (terminalRoute) {
      const terminal = ctx.terminal;
      if (!terminal) throw new HttpError(404, "命令行已关闭");
      const id = terminalRoute[1] as string;
      const action = terminalRoute[2] ?? "";
      if (action === "/stream") {
        if (method !== "GET") throw new HttpError(405, "方法不被允许");
        if (!terminal.stream(id, req, res)) throw new HttpError(404, "命令行不存在");
        return;
      }
      if (action === "/input" || action === "/resize") {
        if (method !== "POST") throw new HttpError(405, "方法不被允许");
        const body = asRecord(await readJson(req));
        const ok = action === "/input"
          ? typeof body.data === "string" && body.data.length > 0 && terminal.input(id, body.data)
          : terminal.resize(id, body.cols, body.rows);
        if (!ok) throw new HttpError(400, "输入无效或命令行已结束");
        res.writeHead(204);
        res.end();
        return;
      }
      if (method !== "DELETE") throw new HttpError(405, "方法不被允许");
      if (!terminal.close(id)) throw new HttpError(404, "命令行不存在");
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/api/settings" && method === "GET") {
      sendJson(res, 200, publicSettings(ctx.settings.current));
      return;
    }
    if (url.pathname === "/api/settings" && method === "PUT") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") throw new HttpError(400, "请求不是 JSON 对象");
      try {
        ctx.settings.current = applySettingsPatch(ctx.settings.current, body as Record<string, unknown>);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "设置无效");
      }
      saveSettings(config.dataDir, ctx.settings.current);
      // 运行参数即时生效：并发上限调高后立即启动排队中的对话；确认超时、
      // 会话/请求上限和归档保留天数同样不需要重启。
      const next = resolveSettings(ctx.settings.current);
      ctx.runtime.setMaxConcurrent(next.maxConcurrent);
      ctx.runtime.setApprovalTimeoutMinutes(next.approvalTimeoutMinutes);
      configureLimits(next.limits);
      ctx.sweeper?.setRetentionDays(next.archiveRetentionDays);
      sendJson(res, 200, publicSettings(ctx.settings.current));
      return;
    }
    if (url.pathname === "/api/settings/test" && method === "POST") {
      const body = asRecord(await readJson(req));
      const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
      const provider = findProvider(ctx.settings.current, providerId);
      if (!provider) throw new HttpError(404, "接口配置不存在");
      const model = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : provider.models[0] || "";
      if (!model) throw new HttpError(400, "这套配置还没有模型");
      if (!provider.models.includes(model)) throw new HttpError(400, "模型不在这套配置里");
      if (!provider.apiKey.trim()) {
        sendJson(res, 200, { ok: false, detail: "这套配置还没有 API key" });
        return;
      }
      // 测试结果即使用户的 key/地址有问题也按 200 返回，前端直接展示分类文案。
      sendJson(res, 200, await testProvider({
        kind: providerKind(provider),
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
      }));
      return;
    }
    if (url.pathname === "/api/usage" && method === "GET") {
      // 由 Store 在内部遍历（可缓存），避免这里再做一次全表 listAll + get 的扫描。
      const providers = ctx.settings.current.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        pricing: provider.pricing,
      }));
      sendJson(res, 200, store.usageReport(providers));
      return;
    }
    if (url.pathname === "/api/skills" && method === "GET") {
      sendJson(res, 200, listSkills(skillsOptions()));
      return;
    }
    if (url.pathname === "/api/skills" && method === "POST") {
      const body = await readJson(req);
      const domain = requireString(body, "domain", "来源域");
      const name = requireString(body, "name", "技能名");
      const content = requireString(body, "content", "内容");
      try {
        const skill = createSkill(skillsOptions(), domain, name, content);
        skillStore.touch();
        sendJson(res, 201, { skill });
      } catch (error) {
        throwSkillError(error);
      }
      return;
    }
    const skillPath = url.pathname.match(/^\/api\/skills\/([^/]+)\/([^/]+)$/);
    if (skillPath) {
      let domainId: string;
      let dir: string;
      try {
        domainId = decodeURIComponent(skillPath[1] ?? "");
        dir = decodeURIComponent(skillPath[2] ?? "");
      } catch {
        throw new HttpError(400, "技能路径不合法");
      }
      if (method === "GET") {
        try {
          sendJson(res, 200, readSkill(skillsOptions(), domainId, dir));
        } catch (error) {
          throwSkillError(error);
        }
        return;
      }
      if (method === "PUT") {
        const body = await readJson(req);
        const content = requireString(body, "content", "内容");
        try {
          const skill = writeSkill(skillsOptions(), domainId, dir, content);
          skillStore.touch();
          sendJson(res, 200, { skill });
        } catch (error) {
          throwSkillError(error);
        }
        return;
      }
      if (method === "PATCH") {
        const body = await readJson(req);
        const enabled = requireBoolean(body, "enabled", "enabled");
        // 只允许切换真实存在的技能，避免把拼错的 key 写进 skills.json。
        const current = listSkills(skillsOptions());
        if (!findSkillDomain(current.domains, domainId)) {
          throw new HttpError(404, "没有这个技能来源域");
        }
        if (!current.skills.some((skill) => skill.id === skillKey(domainId, dir))) {
          throw new HttpError(404, "没有这个技能");
        }
        skillStore.setEnabled(domainId, dir, enabled);
        const refreshed = listSkills(skillsOptions());
        const skill = refreshed.skills.find((item) => item.id === skillKey(domainId, dir));
        if (!skill) throw new HttpError(404, "没有这个技能");
        sendJson(res, 200, { skill });
        return;
      }
      throw new HttpError(405, "不支持的方法");
    }
    if (url.pathname.startsWith("/api/skills/")) {
      throw new HttpError(404, "没有这个接口");
    }
    if (url.pathname === "/api/push") {
      const push = requirePush(ctx);
      if (method !== "GET") throw new HttpError(405, "不支持的方法");
      sendJson(res, 200, push.status());
      return;
    }
    if (url.pathname === "/api/push/subscriptions") {
      const push = requirePush(ctx);
      if (method === "POST") {
        const body = await readJson(req);
        let count: number;
        try {
          ({ count } = push.subscribe(body));
        } catch (error) {
          if (error instanceof PushError) throw new HttpError(400, error.message);
          throw error;
        }
        sendJson(res, 201, { ok: true, count });
        return;
      }
      if (method === "DELETE") {
        const body = await readJson(req);
        let count: number;
        try {
          ({ count } = push.unsubscribe(body));
        } catch (error) {
          if (error instanceof PushError) throw new HttpError(400, error.message);
          throw error;
        }
        sendJson(res, 200, { ok: true, count });
        return;
      }
      throw new HttpError(405, "不支持的方法");
    }
    if (url.pathname === "/api/push/test") {
      const push = requirePush(ctx);
      if (method !== "POST") throw new HttpError(405, "不支持的方法");
      let result: PushSendResult;
      try {
        result = await push.sendTest();
      } catch (error) {
        if (error instanceof PushError) throw new HttpError(400, error.message);
        throw error;
      }
      sendJson(res, 200, { ok: true, sent: result.sent, failed: result.failed });
      return;
    }
    if (url.pathname === "/api/projects" && method === "GET") {
      const removable = removableProjectIds(config);
      const projects = await Promise.all(config.projects.map((project) => (
        projectView(project, ctx.permissions.current, removable.has(project.id))
      )));
      sendJson(res, 200, { projects });
      return;
    }
    if (url.pathname === "/api/projects" && method === "POST") {
      // 运行期新增项目：只接受本机已有的 git 仓库，写入额外项目文件后立即生效。
      const body = asRecord(await readJson(req));
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const rawPath = typeof body.path === "string" ? body.path.trim() : "";
      const permission = body.permission === undefined ? "acceptEdits" : body.permission;
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
        throw new HttpError(400, "项目 id 只能用小写字母、数字和连字符");
      }
      if (id === CHAT_PROJECT_ID) throw new HttpError(400, "「普通对话」是内置项目，不能重复添加");
      if (!name) throw new HttpError(400, "名称不能为空");
      if (!rawPath) throw new HttpError(400, "路径不能为空");
      if (!isPermission(permission)) {
        throw new HttpError(400, "permission 必须是 default、acceptEdits、plan、auto 或 bypassPermissions");
      }
      if (config.projects.some((project) => project.id === id)) {
        throw new HttpError(409, `项目 id 已存在：${id}`);
      }
      const projectPath = path.resolve(config.configDir, rawPath);
      let isDir = false;
      try {
        isDir = fs.statSync(projectPath).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new HttpError(400, `目录不存在：${projectPath}`);
      // 绕过 30 秒缓存：刚 git init 的目录也要能立即加入。
      if (!(await isGitRepo(projectPath, { ttlMs: 0 }))) {
        throw new HttpError(400, `不是 git 仓库：${projectPath}`);
      }
      const projectsFile = config.projectsFile ?? path.join(config.configDir, "projects.yaml");
      const existing = readProjectsFile(projectsFile, config.configDir);
      if (existing.error) {
        throw new HttpError(400, `项目文件无法读取，先修复 ${projectsFile}：${existing.error}`);
      }
      // 探测 git 期间可能有另一个请求写入同一 id，落盘前再查一次。
      if (
        existing.projects.some((project) => project.id === id)
        || config.projects.some((project) => project.id === id)
      ) {
        throw new HttpError(409, `项目 id 已存在：${id}`);
      }
      const project: ProjectConfig = { id, name, path: projectPath, permission, isolated: false };
      appendProjectToFile(projectsFile, project);
      config.projects.push(project);
      sendJson(res, 201, { project: await projectView(project, ctx.permissions.current, true) });
      return;
    }
    if (url.pathname === "/api/projects/new" && method === "POST") {
      // 在机器上新建 git 仓库并加入项目列表：只填仓库名称和母目录。
      const body = asRecord(await readJson(req));
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const rawParent = typeof body.parent === "string" ? body.parent.trim() : "";
      const permission = body.permission === undefined ? "acceptEdits" : body.permission;
      if (!name) throw new HttpError(400, "仓库名称不能为空");
      if (!rawParent) throw new HttpError(400, "目录路径不能为空");
      if (!isPermission(permission)) {
        throw new HttpError(400, "permission 必须是 default、acceptEdits、plan、auto 或 bypassPermissions");
      }
      const projectsFile = config.projectsFile ?? path.join(config.configDir, "projects.yaml");
      const existing = readProjectsFile(projectsFile, config.configDir);
      if (existing.error) {
        throw new HttpError(400, `项目文件无法读取，先修复 ${projectsFile}：${existing.error}`);
      }
      const id = newRepoProjectId(name, config, existing.projects);
      let target: string;
      try {
        target = resolveNewRepoPath(path.resolve(config.configDir, rawParent), name);
        await createGitRepo(target);
      } catch (error) {
        if (error instanceof RepoCreateError) throw new HttpError(error.status, error.message);
        throw error;
      }
      // git init 期间可能有另一个请求写入同一 id；删掉刚建的目录后报冲突。
      if (
        config.projects.some((project) => project.id === id)
        || existing.projects.some((project) => project.id === id)
      ) {
        fs.rmSync(target, { recursive: true, force: true });
        throw new HttpError(409, `项目 id 已存在：${id}`);
      }
      const project: ProjectConfig = { id, name, path: target, permission, isolated: false };
      appendProjectToFile(projectsFile, project);
      config.projects.push(project);
      sendJson(res, 201, { project: await projectView(project, ctx.permissions.current, true) });
      return;
    }
    if (url.pathname === "/api/sessions" && method === "GET") {
      const query = (url.searchParams.get("q") || "").trim();
      const sessions = query ? store.search(query) : store.listAll();
      sendJson(res, 200, { sessions: sessions.map(withQueue) });
      return;
    }
    const projectPermission = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]{0,62})$/);
    if (projectPermission && method === "PUT") {
      const project = findProject(config, projectPermission[1] || "");
      const body = asRecord(await readJson(req));
      if (!isPermission(body.permission)) {
        throw new HttpError(400, "permission 必须是 default、acceptEdits、plan、auto 或 bypassPermissions");
      }
      ctx.permissions.current = { ...ctx.permissions.current, [project.id]: body.permission };
      saveProjectPermissions(config.dataDir, ctx.permissions.current);
      sendJson(res, 200, {
        project: await projectView(project, ctx.permissions.current, removableProjectIds(config).has(project.id)),
      });
      return;
    }
    if (projectPermission && method === "DELETE") {
      // 只删除额外项目文件里的条目；config.yaml 自带的项目和内置项目不可删。
      const id = projectPermission[1] || "";
      const project = findProject(config, id);
      if (project.builtin) throw new HttpError(400, "内置项目不能删除");
      if ((config.projectsBase ?? []).some((item) => item.id === id)) {
        throw new HttpError(400, "该项目来自 config.yaml，请在配置文件里删除后重启；这里只能删除运行期添加的项目");
      }
      const projectsFile = config.projectsFile ?? path.join(config.configDir, "projects.yaml");
      const existing = readProjectsFile(projectsFile, config.configDir);
      if (existing.error) {
        throw new HttpError(400, `项目文件无法读取，先修复 ${projectsFile}：${existing.error}`);
      }
      if (!existing.projects.some((item) => item.id === id)) {
        throw new HttpError(400, "该项目不在运行期项目文件里，无法在这里删除");
      }
      if (!removeProjectFromFile(projectsFile, id)) {
        throw new HttpError(400, `无法从项目文件移除 ${id}：${projectsFile} 的格式无法识别，请手动编辑`);
      }
      const index = config.projects.findIndex((item) => item.id === id);
      if (index !== -1) config.projects.splice(index, 1);
      if (id in ctx.permissions.current) {
        const next = { ...ctx.permissions.current };
        delete next[id];
        ctx.permissions.current = next;
        try {
          saveProjectPermissions(config.dataDir, next);
        } catch {
          // 权限文件写失败不影响删除；残留的 id 下次保存时会被覆盖。
        }
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/events" && method === "GET") {
      // DetailPage 用 ?session=<uuid> 只订阅自己的会话；不带参数时是 BoardPage 的全量订阅。
      // ID_RE 带 /i 接受大写，但事件里的 id 是小写；统一转小写后再校验和过滤。
      const rawSession = url.searchParams.get("session");
      const session = rawSession === null ? null : rawSession.toLowerCase();
      if (session !== null && !ID_RE.test(session)) throw new HttpError(400, "对话 id 无效");
      streamEvents(req, res, store, session, withQueue, currentLimits().historyPage);
      return;
    }
    const projectSessions = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]{0,62})\/sessions$/);
    if (projectSessions && method === "GET") {
      const project = findProject(config, projectSessions[1] || "");
      sendJson(res, 200, { sessions: store.list(project.id).map(withQueue) });
      return;
    }
    if (projectSessions && method === "POST") {
      const project = findProject(config, projectSessions[1] || "");
      if (ctx.runtime.isShuttingDown()) throw new HttpError(503, "服务正在退出");
      const body = await readJson(req);
      const session = await createSession(project, body, ctx);
      sendJson(res, 201, { session: withQueue(store.summary(session.id, true)) });
      return;
    }
    // 会话列表用来显示分支是否已合入 main，也供「全部归档」过滤未合入的会话。
    const projectMergeStatus = url.pathname.match(
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,62})\/merge-status$/,
    );
    if (projectMergeStatus) {
      if (method !== "GET") throw new HttpError(405, "不支持的方法");
      const project = findProject(config, projectMergeStatus[1] || "");
      const info = await describeProject(project);
      if (!info.git) {
        sendJson(res, 200, { base: null, merged: [], untouched: [] });
        return;
      }
      sendJson(res, 200, await mergedSessionBranches(project.path));
      return;
    }
    const projectSchedules = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]{0,62})\/schedules$/);
    if (projectSchedules) {
      const project = findProject(config, projectSchedules[1] || "");
      const schedules = ctx.schedules;
      if (!schedules) throw new HttpError(503, "定时任务不可用");
      if (method === "GET") {
        sendJson(res, 200, { schedules: schedules.list(project.id) });
        return;
      }
      if (method === "POST") {
        const body = asRecord(await readJson(req));
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
        const provider = findProvider(ctx.settings.current, providerId);
        if (!provider) throw new HttpError(400, "先选择一套接口配置");
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!provider.models.includes(model)) throw new HttpError(400, "模型不在这套配置里");
        const effort = body.effort === undefined ? ctx.settings.current.effort : body.effort;
        if (!isEffort(effort)) throw new HttpError(400, "effort 必须是 low、medium、high、xhigh 或 max");
        const intervalMinutes = body.intervalMinutes;
        if (typeof intervalMinutes !== "number") throw new HttpError(400, "间隔必须是数字");
        try {
          const schedule = schedules.create({
            projectId: project.id,
            prompt,
            providerId: provider.id,
            model,
            effort,
            intervalMinutes,
          });
          sendJson(res, 201, { schedule });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "无法创建定时任务");
        }
        return;
      }
      throw new HttpError(405, "不支持的方法");
    }
    const projectSchedule = url.pathname.match(
      /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,62})\/schedules\/([0-9a-f-]{36})(\/run)?$/i,
    );
    if (projectSchedule) {
      const project = findProject(config, projectSchedule[1] || "");
      const schedules = ctx.schedules;
      if (!schedules) throw new HttpError(503, "定时任务不可用");
      const id = (projectSchedule[2] || "").toLowerCase();
      const action = projectSchedule[3] || "";
      const existing = schedules.list(project.id).find((item) => item.id === id);
      if (!existing) throw new HttpError(404, "找不到定时任务");
      if (action === "/run") {
        if (method !== "POST") throw new HttpError(405, "不支持的方法");
        if (!ctx.scheduleRunner) throw new HttpError(503, "定时任务不可用");
        const result = await ctx.scheduleRunner.runNow(id);
        if (!result.ok) {
          const status = result.error === "找不到定时任务" ? 404 : result.error === "定时任务正在运行" ? 409 : 400;
          throw new HttpError(status, result.error || "运行失败");
        }
        sendJson(res, 200, result);
        return;
      }
      if (method === "PATCH") {
        const body = asRecord(await readJson(req));
        const patch: { enabled?: boolean; intervalMinutes?: number; prompt?: string } = {};
        if (body.enabled !== undefined) patch.enabled = body.enabled as boolean;
        if (body.intervalMinutes !== undefined) patch.intervalMinutes = body.intervalMinutes as number;
        if (body.prompt !== undefined) patch.prompt = body.prompt as string;
        try {
          sendJson(res, 200, { schedule: schedules.update(id, patch) });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "无法更新定时任务");
        }
        return;
      }
      if (method === "DELETE") {
        schedules.remove(id);
        sendJson(res, 200, { ok: true });
        return;
      }
      throw new HttpError(405, "不支持的方法");
    }
    if (url.pathname === "/api/archive/status") {
      if (method !== "GET") throw new HttpError(405, "不支持的方法");
      if (!ctx.archive) {
        sendJson(res, 200, { archive: { enabled: false } });
        return;
      }
      const status = await ctx.archive.status();
      // 保留天数以设置页为准（首次启动时继承部署配置），归档目录本身仍是部署配置。
      sendJson(res, 200, {
        archive: {
          ...status,
          retentionDays: ctx.settings.current.archiveRetentionDays ?? status.retentionDays,
        },
      });
      return;
    }
    if (url.pathname === "/api/archive/sessions") {
      if (method !== "GET") throw new HttpError(405, "不支持的方法");
      if (!ctx.archive) {
        sendJson(res, 200, { enabled: false, sessions: [] });
        return;
      }
      const projectId = url.searchParams.get("projectId") || undefined;
      const sessions = (await ctx.archive.list(projectId))
        // local 告诉前端本机是否还有同名会话：恢复/清理的按钮要看它。
        .map((entry) => ({ ...entry, local: Boolean(store.get(entry.id)) }))
        // 到期前会做快照；还在 SSD 上的会话默认不必重复显示在归档列表里。
        // 但手动删除时冷备已完成、本机清理失败（pendingDelete）的条目必须
        // 露出来，否则用户既删不掉会话、也看不到归档，只能手工修磁盘。
        .filter((entry) => !entry.local || entry.pendingDelete === true);
      sendJson(res, 200, { enabled: true, sessions });
      return;
    }
    const archiveSession = url.pathname.match(/^\/api\/archive\/sessions\/([^/]+)(\/restore)?$/);
    if (archiveSession) {
      if (!ctx.archive) throw new HttpError(503, "未配置归档");
      const id = (archiveSession[1] || "").toLowerCase();
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      const action = archiveSession[2] || "";
      if (!action && method === "GET") {
        try {
          sendJson(res, 200, await ctx.archive.detail(id));
        } catch (error) {
          throw archiveHttpError(error, "找不到归档");
        }
        return;
      }
      if (!action && method === "DELETE") {
        if (!tryLockSession(id)) throw new HttpError(409, "对话正在归档或清理，请稍后再试");
        try {
          const removed = await ctx.archive.remove(id);
          if (!removed) throw new HttpError(404, "找不到归档");
          sendJson(res, 200, { ok: true });
        } finally {
          unlockSession(id);
        }
        return;
      }
      if (action === "/restore" && method === "POST") {
        if (!tryLockSession(id)) throw new HttpError(409, "对话正在归档或清理，请稍后再试");
        try {
          const meta = await ctx.archive.meta(id);
          if (!meta) throw new HttpError(404, "找不到归档");
          const project = config.projects.find((item) => item.id === meta.projectId);
          if (!project) throw new HttpError(409, "归档所属项目已不在配置里");
          if (ctx.store.get(id)) throw new HttpError(409, "同名对话还在，先归档它或等它过期");
          const info = await describeProject(project);
          if (!info.available) throw new HttpError(409, "归档所属项目目录不存在");
          // 恢复路径只从当前配置推导，绝不使用归档 JSON 里的 cwd/projectPath。
          const cwd = info.git
            ? path.join(config.dataDir, "worktrees", project.id, id)
            : info.isolated
              ? path.join(project.path, id)
              : project.path;
          try {
            await ctx.archive.restore(id, {
              projectId: project.id,
              projectPath: project.path,
              cwd,
              git: info.git,
              branch: info.git ? sessionBranch(id) : undefined,
            });
          } catch (error) {
            throw archiveHttpError(error, "无法恢复归档");
          }
          const session = ctx.store.loadFromDisk(id);
          if (!session) throw new HttpError(500, "恢复后无法重新载入对话");
          sendJson(res, 200, { session: withQueue(ctx.store.summary(id, true)) });
        } finally {
          unlockSession(id);
        }
        return;
      }
      throw new HttpError(405, "不支持的方法");
    }
    if (url.pathname.startsWith("/api/archive/sessions/")) {
      throw new HttpError(404, "没有这个接口");
    }
    if (url.pathname === "/api/archive/sweep") {
      if (method !== "POST") throw new HttpError(405, "不支持的方法");
      if (!ctx.sweeper) throw new HttpError(503, "未配置归档");
      void ctx.sweeper.run().catch((error) => {
        console.error("[archive] 手动整理失败:", error);
      });
      sendJson(res, 202, { ok: true, sweeping: true });
      return;
    }
    const imagePath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/images\/([^/]+)$/);
    if (imagePath && method === "GET") {
      const session = requireSession(store, imagePath[1] || "");
      const image = findImage(session, imagePath[2] || "");
      if (!image) throw new HttpError(404, "找不到图片");
      const file = imageFilePath(config.dataDir, session.id, image);
      if (!file || !fs.existsSync(file)) throw new HttpError(404, "找不到图片");
      sendImage(res, file, image.mediaType);
      return;
    }
    /* 排队消息：GET 取完整正文用于编辑，PATCH 改写，POST .../send 提前发送，
       DELETE 从队列和对话记录里一起删除。promptId 是运行时生成的 id。 */
    const queuePath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)(\/send)?$/);
    if (queuePath) {
      const id = queuePath[1] || "";
      const promptId = queuePath[2] || "";
      const promoting = queuePath[3] === "/send";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      if (typeof runtime.promptEntry !== "function" || typeof runtime.cancelPrompt !== "function") {
        throw new HttpError(503, "排队消息操作不可用");
      }
      if (method === "GET" && !promoting) {
        requireSession(store, id);
        const entry = runtime.promptEntry(id, promptId);
        if (!entry) throw new HttpError(404, "这条消息已经开始执行");
        sendJson(res, 200, {
          entry: {
            id: entry.id,
            text: entry.text,
            images: entry.images.length,
            createdAt: entry.createdAt,
          },
        });
        return;
      }
      if (method === "PATCH" && !promoting) {
        requireWritableSession(store, id);
        const body = asRecord(await readJson(req));
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new HttpError(400, "消息内容不能为空");
        if (text.length > 160_000) throw new HttpError(400, "内容过长");
        if (typeof runtime.editPrompt !== "function" || !runtime.editPrompt(id, promptId, text)) {
          throw new HttpError(404, "这条消息已经开始执行，无法编辑");
        }
        const entry = runtime.promptEntry(id, promptId);
        if (entry?.uuid) store.editUserMessage(id, entry.uuid, text);
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      if (method === "POST" && promoting) {
        requireWritableSession(store, id);
        if (typeof runtime.promotePrompt !== "function" || !runtime.promotePrompt(id, promptId)) {
          throw new HttpError(404, "这条消息已经开始执行，无法提前发送");
        }
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      if (method === "DELETE" && !promoting) {
        requireWritableSession(store, id);
        const entry = runtime.promptEntry(id, promptId);
        if (!entry) throw new HttpError(404, "这条消息已经开始执行，无法删除");
        if (!runtime.cancelPrompt(id, promptId)) {
          throw new HttpError(404, "这条消息已经开始执行，无法删除");
        }
        // 排队消息还没发给 agent，删除时要连对话记录一起移除，否则会留下一句
        // 永远不会执行的用户消息。
        if (entry.uuid) store.removeUserMessage(id, entry.uuid);
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      throw new HttpError(405, "不支持的方法");
    }
    const gitPath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/git$/);
    if (gitPath) {
      const id = gitPath[1] || "";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      const session = requireWritableSession(store, id);
      if (!session.git) throw new HttpError(400, "这个目录不是 git 仓库");
      if (method === "GET") {
        sendJson(res, 200, await gitStatus(session.cwd));
        return;
      }
      if (method !== "POST") throw new HttpError(405, "不支持的方法");
      // agent 正在跑的时候提交容易和它抢工作区；等这一轮结束再操作。
      if (session.phase === "queued" || session.phase === "running" || session.phase === "needs_input") {
        throw new HttpError(409, "对话进行中，完成后再提交或推送");
      }
      const body = asRecord(await readJson(req));
      const action = body.action;
      if (action !== "commit" && action !== "commit-push" && action !== "push") {
        throw new HttpError(400, "action 必须是 commit、commit-push 或 push");
      }
      const message = typeof body.message === "string" ? body.message : "";
      if (action !== "push" && !message.trim()) throw new HttpError(400, "提交信息不能为空");
      try {
        // 与创建 PR/MR 共用同一把锁，避免两个流程同时抢工作区或分支。
        sendJson(res, 200, await withGitAction(id, () => commitAndPush(session.cwd, {
          message: action === "push" ? "" : message,
          push: action !== "commit",
        })));
      } catch (error) {
        if (error instanceof GitActionBusyError) throw new HttpError(409, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : "git 操作失败");
      }
      return;
    }
    // 后台任务：/tasks/:taskId/output、/tasks/:taskId/stop、/tasks/background。
    // 放在 sessionPath 之前，避免 /tasks 被当成会话子动作。
    const taskPath = url.pathname.match(
      /^\/api\/sessions\/([^/]+)\/tasks(?:\/([^/]+))?(?:\/(output|stop))?$/,
    );
    if (taskPath) {
      // session id 不解码，和 sessionPath/images/queue/git 路由保持一致。
      const id = taskPath[1] || "";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      const rawSegment = taskPath[2] === undefined ? "" : taskPath[2];
      const action = taskPath[3] || "";
      if (action === "output" || action === "stop") {
        // 方法不匹配优先 404，此时不校验也不解码 taskId。
        if (action === "output" ? method !== "GET" : method !== "POST") {
          throw new HttpError(404, "没有这个接口");
        }
        const segment = decodeTaskId(rawSegment);
        if (!segment) throw new HttpError(404, "没有这个接口");
        if (segment.length > 200) throw new HttpError(400, "任务 id 过长");
        if (action === "output") {
          requireSession(store, id);
          let result;
          try {
            result = await runtime.taskOutput(id, segment);
          } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : "读取后台任务输出失败");
          }
          sendJson(res, 200, {
            output: result.output,
            totalBytes: result.totalBytes,
            truncated: result.truncated,
          });
          return;
        }
        requireWritableSession(store, id);
        try {
          await runtime.stopTask(id, segment);
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : "停止后台任务失败");
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      // `/tasks/background`：把前台任务转到后台运行（这里不是 taskId，不解码）。
      if (rawSegment === "background") {
        if (method !== "POST") throw new HttpError(404, "没有这个接口");
        requireWritableSession(store, id);
        const body = asRecord(await readJson(req));
        const toolUseId = typeof body.toolUseId === "string" ? body.toolUseId.trim() : "";
        if (!toolUseId) throw new HttpError(400, "缺少 toolUseId");
        if (toolUseId.length > 200) throw new HttpError(400, "toolUseId 过长");
        let backgrounded: boolean;
        try {
          backgrounded = await runtime.backgroundTask(id, toolUseId);
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : "转后台失败");
        }
        sendJson(res, 200, { ok: true, backgrounded: backgrounded === true });
        return;
      }
      throw new HttpError(404, "没有这个接口");
    }
    // `/tasks` 命名下所有未识别形态（裸 /tasks、多余段、未知动作等）都必须是
    // JSON 404，不能落到静态回退返回 index.html。
    if (/^\/api\/sessions\/[^/]+\/tasks(?:\/|$)/.test(url.pathname)) {
      throw new HttpError(404, "没有这个接口");
    }
    // 子任务详情：读取 SDK 写在磁盘上的 sidechain transcript（只读尾部）。
    const subagentPath = url.pathname.match(
      /^\/api\/sessions\/([^/]+)\/subagents\/([^/]+)$/,
    );
    if (subagentPath) {
      if (method !== "GET") throw new HttpError(404, "没有这个接口");
      const id = subagentPath[1] || "";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      const taskId = subagentPath[2] || "";
      // 非法 id 按不存在的接口处理，同时避免它被拼进文件路径。
      if (!SUBAGENT_TASK_ID_RE.test(taskId)) throw new HttpError(404, "没有这个接口");
      requireSession(store, id);
      let transcript;
      try {
        transcript = await readSubagentTranscript(id, taskId, options.sdkConfigDir);
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "读取子任务记录失败");
      }
      if (!transcript) throw new HttpError(404, "找不到这个子任务的记录");
      sendJson(res, 200, transcript);
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/subagents(?:\/|$)/.test(url.pathname)) {
      throw new HttpError(404, "没有这个接口");
    }
    // 回滚/分叉必须在通用会话路由之前匹配，否则会被当成未知子路径落到静态回退。
    const rewindPath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/rewind$/);
    if (rewindPath) {
      const id = rewindPath[1] || "";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      if (method !== "POST") throw new HttpError(405, "方法不被允许");
      const body = asRecord(await readJson(req));
      const result = await rewindSession(id, body, ctx);
      sendJson(res, 200, {
        session: withQueue(store.summary(id, true)),
        prompt: result.prompt,
      });
      return;
    }
    const forkPath = url.pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/);
    if (forkPath) {
      const id = forkPath[1] || "";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      if (method !== "POST") throw new HttpError(405, "方法不被允许");
      const body = asRecord(await readJson(req));
      const newId = await forkSession(id, body, ctx);
      sendJson(res, 201, { session: withQueue(store.summary(newId, true)) });
      return;
    }
    // 未识别的 rewind/fork 形态（多余段等）也必须是 JSON 404。
    if (/^\/api\/sessions\/[^/]+\/(?:rewind|fork)(?:\/|$)/.test(url.pathname)) {
      throw new HttpError(404, "没有这个接口");
    }
    // 多模型讨论：保存参与者并开始一轮讨论。
    const discussionStart = url.pathname.match(/^\/api\/sessions\/([^/]+)\/discussion\/start$/);
    if (discussionStart) {
      const id = discussionStart[1] || "";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      if (method !== "POST") throw new HttpError(405, "方法不被允许");
      requireWritableSession(store, id);
      requireNotBusy(id);
      const body = asRecord(await readJson(req));
      const participants = readDiscussionParticipants(body.participants, ctx.settings.current);
      const session = store.require(id);
      if (
        session.workflow?.skill !== "discuss"
        && session.workflow?.skill !== "dis-prl"
        && !session.discussion
      ) {
        throw new HttpError(409, "这个对话不是多模型讨论模式");
      }
      if (runtime.isDiscussing(id) || session.phase === "running" || session.turnActive) {
        throw new HttpError(409, "讨论已经在进行中");
      }
      try {
        const strategy = session.workflow?.skill === "dis-prl" || session.discussion?.strategy === "parallel"
          ? "parallel"
          : "flat";
        runtime.startDiscussion(id, participants, strategy);
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "无法开始讨论");
      }
      sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/discussion(?:\/|$)/.test(url.pathname)) {
      throw new HttpError(404, "没有这个接口");
    }
    const sessionPath = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/messages|\/answer|\/stop|\/diff)?$/);
    if (sessionPath) {
      const id = sessionPath[1] || "";
      if (!ID_RE.test(id)) throw new HttpError(400, "对话 id 无效");
      const action = sessionPath[2] || "";
      if (!action && method === "GET") {
        requireSession(store, id);
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      if (!action && method === "PATCH") {
        const session = requireWritableSession(store, id);
        const body = asRecord(await readJson(req));
        let updated = session;
        try {
          if (body.title !== undefined || body.pinned !== undefined) {
            updated = store.updateMeta(id, {
              title: body.title === undefined ? undefined : body.title as string,
              pinned: body.pinned === undefined ? undefined : body.pinned as boolean,
            });
          }
          if (body.providerId !== undefined || body.model !== undefined || body.effort !== undefined) {
            const providerId = body.providerId === undefined ? updated.providerId : body.providerId;
            if (typeof providerId !== "string") throw new HttpError(400, "providerId 必须是字符串");
            const provider = findProvider(ctx.settings.current, providerId);
            if (!provider) throw new HttpError(400, "接口配置不存在");
            const model = body.model === undefined ? updated.model : body.model;
            if (typeof model !== "string" || !provider.models.includes(model)) {
              throw new HttpError(400, "模型不在这套配置里");
            }
            const effort = body.effort === undefined ? updated.effort : body.effort;
            if (!isEffort(effort)) throw new HttpError(400, "effort 必须是 low、medium、high、xhigh 或 max");
            updated = store.updateRunConfig(id, {
              providerId: provider.id,
              providerName: provider.name,
              model,
              effort,
            });
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, error instanceof Error ? error.message : "更新失败");
        }
        if (updated === session) throw new HttpError(400, "没有可更新的字段");
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      if (!action && method === "DELETE") {
        await deleteSession(id, ctx);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (action === "/messages" && method === "GET") {
        // 历史分页：before 是完整数组的排他上界，返回 [start, before) 的一页。
        const session = requireSession(store, id);
        const count = session.messages.length;
        const beforeRaw = url.searchParams.get("before");
        let before = count;
        if (beforeRaw !== null) {
          before = parsePageIndex(beforeRaw, "before");
        }
        before = Math.max(0, Math.min(before, count));
        const limitRaw = url.searchParams.get("limit");
        const historyPage = currentLimits().historyPage;
        const limit = Math.min(500, Math.max(1, limitRaw === null ? historyPage : parsePageIndex(limitRaw, "limit")));
        const start = Math.max(0, before - limit);
        const slice = store.detailSlice(id, start, before);
        if (!slice) throw new HttpError(404, "找不到对话");
        sendJson(res, 200, { start, messageCount: slice.messageCount, messages: slice.messages });
        return;
      }
      if (action === "/messages" && method === "POST") {
        requireWritableSession(store, id);
        const body = await readJson(req);
        const input = readPrompt(body);
        // 读请求体期间 sweeper 可能刚好开始归档/删除，写前再同步检查一次。
        requireNotBusy(id);
        // discuss 不经过 SDK 队列：消息先落库，再由 runtime 依次调用各个模型。
        const skill = input.workflow ?? detectWorkflowSkill(input.text) ?? undefined;
        if (skill === "discuss" || skill === "dis-prl") {
          const current = store.require(id);
          if (current.phase === "running" || current.phase === "needs_input" || current.turnActive) {
            throw new HttpError(409, "讨论进行中，等这一轮结束再发消息");
          }
          const images = saveImages(config.dataDir, id, input.images);
          store.addUserMessage(id, input.text, images);
          const participants = current.discussion?.participants ?? [];
          if (participants.length === 0) {
            store.prepareDiscussion(id, undefined, skill);
          } else {
            try {
              runtime.startDiscussion(id, participants, skill === "dis-prl" ? "parallel" : "flat");
            } catch (error) {
              throw new HttpError(409, error instanceof Error ? error.message : "无法开始讨论");
            }
          }
          sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
          return;
        }
        // 先检查上限再写用户消息；否则消息进了对话却排不到执行。
        const check = runtime.canSubmit(id);
        if (!check.ok) throw new HttpError(check.status, check.error);
        const images = saveImages(config.dataDir, id, input.images);
        // 每条用户消息都带一个 uuid：SDK 会把它作为 transcript 的 chain uuid，
        // 回滚/分叉依赖它。
        const sdkUuid = randomUUID();
        // 没有活跃 query 时，立即把工作流写进 summary，前端不必等 agent 消费
        // prompt。已有 live query 时让 submit 先走配置重启判断，工作流仍由
        // runtime 在 prompt 被消费/轮末时切换。
        if (!runtime.isActive(id)) store.previewWorkflow(id, input.workflow, input.text);
        // 记录由 runtime 统一写入：排队中的消息带内部标记，固定排在正在运行
        // 那一轮的输出之后，而不是插在发送位置。
        runtime.submit(id, toRuntimePrompt(input, sdkUuid, images), { interject: input.interject });
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      if (action === "/answer" && method === "POST") {
        requireWritableSession(store, id);
        const body = await readJson(req);
        requireNotBusy(id);
        const approval = readApproval(body);
        const requestId = body && typeof body === "object" && typeof (body as { requestId?: unknown }).requestId === "string"
          ? (body as { requestId: string }).requestId
          : "";
        if (!requestId) throw new HttpError(400, "缺少 requestId");
        try {
          runtime.answer(id, requestId, approval);
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : "没有等待中的确认");
        }
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      if (action === "/stop" && method === "POST") {
        requireWritableSession(store, id);
        await runtime.stop(id);
        // 停止期间可能被并发 DELETE 移除。
        if (!store.get(id)) throw new HttpError(404, "找不到对话");
        sendJson(res, 200, { session: withQueue(store.summary(id, true)) });
        return;
      }
      if (action === "/diff" && method === "GET") {
        // 只读，不受归档/删除期间的 busy 锁影响。
        const session = requireSession(store, id);
        const diff = await diffSummary(session.cwd, session.git);
        sendJson(res, 200, diff);
        return;
      }
    }
    // 独立功能路由（diff 行级评论、PR/MR）各自处理自己的路径；返回 null
    // 表示没匹配到，继续走静态资源或 404。
    const feature = await handleFeatureRoutes({
      req,
      res,
      url,
      method,
      config,
      store,
      runtime,
      settings: ctx.settings,
      readJson,
      sendJson,
    });
    if (feature) {
      sendJson(res, feature.status, feature.body);
      return;
    }
    if (method === "GET") {
      await serveStatic(req, res, webDist, url.pathname);
      return;
    }
    throw new HttpError(404, "没有这个接口");
  }
}

export async function createSession(
  project: ProjectConfig,
  body: unknown,
  ctx: { config: AppConfig; store: Store; runtime: Runtime; settings: { current: StoredSettings } },
) {
  const info = await describeProject(project);
  if (!info.available) throw new HttpError(400, "项目目录不存在");
  const input = readPrompt(body);
  const prompt = input.text;
  const record = asRecord(body);
  const effort = record.effort === undefined ? ctx.settings.current.effort : record.effort;
  if (!isEffort(effort)) throw new HttpError(400, "effort 必须是 low、medium、high、xhigh 或 max");
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  const provider = findProvider(ctx.settings.current, providerId);
  if (!provider) throw new HttpError(400, "先选择一套接口配置");
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (!provider.models.includes(model)) throw new HttpError(400, "模型不在这套配置里");
  const fake = envFlag("QUBIUS_FAKE_AGENT");
  if (!fake && !provider.apiKey.trim()) throw new HttpError(400, "这套配置还没有 API key");
  // 隔离项目每个对话有独立目录，多个对话可以同时进行。
  if (!info.git && !info.isolated) {
    const busy = ctx.store.list(project.id).some((session) =>
      session.phase === "queued" || session.phase === "running" || session.phase === "needs_input"
    );
    if (busy) throw new HttpError(409, "非 git 项目同时只能有一个进行中的对话");
  }
  const id = randomUUID();
  let cwd = project.path;
  let branch: string | undefined;
  if (info.git) {
    try {
      const created = await createWorktree({
        projectPath: project.path,
        projectId: project.id,
        sessionId: id,
        dataDir: ctx.config.dataDir,
      });
      cwd = created.cwd;
      branch = created.branch;
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? error.message : "无法创建 worktree");
    }
  } else if (info.isolated) {
    cwd = path.join(project.path, id);
    try {
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? error.message : "无法创建对话目录");
    }
  }
  // 创建目录/ worktree 可能耗时；如果此时开始退出，回滚并拒绝。
  const discardWorkspace = async () => {
    if (info.git) {
      await removeWorktree(project.path, cwd, branch, { sessionId: id }).catch(() => undefined);
    } else if (info.isolated) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // 尽力清理；进程退出时不再阻塞。
      }
    }
  };
  if (ctx.runtime.isShuttingDown()) {
    await discardWorkspace();
    throw new HttpError(503, "服务正在退出");
  }
  // 新 worktree 是干净 checkout：复制 .env 等 gitignored 文件、链接共享目录、
  // 执行项目配置的 setup。失败时不留下半成品 worktree。
  if (info.git) {
    try {
      const prep = await prepareWorktree({ project, worktreePath: cwd });
      for (const warning of prep.warnings) console.warn(`[worktree] ${warning}`);
    } catch (error) {
      await discardWorkspace();
      throw new HttpError(
        500,
        `worktree 准备失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  }
  // 调用方（定时任务/API）显式给标题时直接采用；否则先用用户首条消息的原文
  // 做标题，首个成功轮次结束后再由 agent 总结成更贴合实际的标题。
  const explicitTitle = typeof record.title === "string" && record.title.trim()
    ? record.title.trim().slice(0, 80)
    : undefined;
  const title = explicitTitle ?? titleFromPrompt(prompt);
  let images;
  try {
    images = saveImages(ctx.config.dataDir, id, input.images);
  } catch (error) {
    await discardWorkspace();
    throw new HttpError(500, error instanceof Error ? error.message : "无法保存图片");
  }
  const sdkUuid = randomUUID();
  const session = ctx.store.create({
    id,
    projectId: project.id,
    projectPath: project.path,
    title,
    titlePending: explicitTitle === undefined,
    providerId: provider.id,
    providerName: provider.name,
    model,
    effort,
    cwd,
    branch,
    git: info.git,
    prompt,
    images,
    sdkUuid,
    workflow: input.workflow,
  });
  // 讨论模式先停在配置阶段：用户添加参与模型并点「开始讨论」后才调用模型。
  const skill = input.workflow ?? detectWorkflowSkill(prompt) ?? undefined;
  if (skill === "discuss" || skill === "dis-prl") {
    return ctx.store.prepareDiscussion(session.id, undefined, skill);
  }
  ctx.runtime.submit(session.id, toRuntimePrompt(input, sdkUuid, images));
  return session;
}

function requireSession(store: Store, id: string) {
  const session = store.get(id);
  if (!session) throw new HttpError(404, "找不到对话");
  return session;
}

/** 归档/删除进行中时禁止写操作；只读的 summary/图片仍允许。 */
function requireNotBusy(id: string): void {
  if (isSessionBusy(id)) throw new HttpError(409, "对话正在归档或清理，请稍后再试");
}

function requireWritableSession(store: Store, id: string) {
  requireNotBusy(id);
  return requireSession(store, id);
}

/** 归档相关错误：找不到 → 404，内容损坏/不一致 → 409，其余 → 500。 */
function archiveHttpError(error: unknown, fallback: string): HttpError {
  if (error instanceof ArchiveError) {
    return new HttpError(/找不到归档|没有找到归档/.test(error.message) ? 404 : 409, error.message);
  }
  return new HttpError(500, error instanceof Error ? error.message : fallback);
}

async function deleteSession(
  id: string,
  ctx: { config: AppConfig; store: Store; runtime: Runtime; archive?: ArchiveStore },
): Promise<void> {
  const session = requireSession(ctx.store, id);
  if (!tryLockSession(id)) throw new HttpError(409, "对话正在归档或清理，请稍后再试");
  try {
    // 归档盘已知不可写时先失败，不要把用户正在跑的轮次停掉。
    if (ctx.archive) {
      const status = await ctx.archive.status();
      if (!status.writable) {
        throw new HttpError(500, `归档失败，会话仍在：归档目录不可写 ${status.dir}`);
      }
    }
    // 必须等 start() 真正退出，之后才能动 worktree / 目录 / store。
    await ctx.runtime.stop(id);
    if (typeof ctx.runtime.forgetApprovals === "function") ctx.runtime.forgetApprovals(id);
    // stop() 收尾期间 SDK 仍可能提交最后的消息，Store 是写时复制，必须重新读。
    const latest = ctx.store.get(id) ?? session;
    // 顺序：冷备份 → transcript → workspace → store。归档副本保留，可在归档
    // 面板恢复或永久删除；前一步失败时会话和后续资源都还在，用户可以重试 DELETE。
    if (ctx.archive) {
      try {
        await ctx.archive.archiveBeforeDelete(latest);
      } catch (error) {
        // 归档盘不可写等情况下中止删除，不删除 SSD 上的会话/图片/目录/transcript
        //（stop() 会提交停止状态）。
        throw new HttpError(
          500,
          `归档失败，会话仍在：${error instanceof Error ? error.message : "无法写入归档"}`,
        );
      }
      await ctx.archive.removeSdkIdsAsync(sessionSdkIds(latest));
    } else {
      removeSdkSessionFilesForIds(sessionSdkIds(latest));
    }
    try {
      await removeSessionWorkspace(latest);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "无法清理对话目录";
      // 冷备已经在上面完成，这里失败只差本机副本；归档列表会把它显示成
      // 「待清理」，用户结束占用目录的进程后可以直接重试（不会重复冷备）。
      throw new HttpError(
        500,
        `无法清理对话目录 ${latest.cwd}：${reason}。`
        + "目录可能被终端或后台进程占用，请先结束它们，再在归档面板点「重试清理」",
      );
    }
    // 评论文件不属于会话 JSON；本机副本删除成功后直接移除文件，避免孤儿
    // 文件长期积累。失败只记警告，不阻断会话删除。
    await removeDiffComments(ctx.config.dataDir, id).catch((error) => {
      console.warn(`[diff-comments] 清理会话评论失败 ${id}:`, error);
    });
    ctx.store.remove(id);
    // 本机副本已删除：把归档条目标记回普通归档（失败不影响删除结果）。
    if (ctx.archive) {
      await ctx.archive.clearPendingDelete(id).catch((error) => {
        console.warn(`[archive] 清理待删除标记失败 ${id}:`, error);
      });
    }
  } finally {
    unlockSession(id);
  }
}

interface RewindRequest {
  messageId: string;
  files: boolean;
  /** 只有字段存在时才表示“回滚后编辑重发”；空字符串表示纯图片消息。 */
  prompt?: string;
  keepImages: Array<{ id: string; mediaType: ImageMediaType }>;
  editing: boolean;
  workflow?: WorkflowSkill;
}

function readRewindRequest(body: Record<string, unknown>): RewindRequest {
  const messageId = typeof body.messageId === "string" ? body.messageId : "";
  if (!messageId) throw new HttpError(400, "缺少 messageId");
  if (messageId.length > 200) throw new HttpError(400, "messageId 过长");
  const files = body.files === undefined ? false : body.files;
  if (typeof files !== "boolean") throw new HttpError(400, "files 必须是布尔值");

  let prompt: string | undefined;
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string") throw new HttpError(400, "prompt 必须是字符串");
    // 和 POST /messages 一致：落库和发给 agent 的都是去掉首尾空白后的文本。
    const text = body.prompt.trim();
    if (text.length > 160_000) throw new HttpError(400, "内容过长");
    prompt = text;
  }
  const keepImages: RewindRequest["keepImages"] = [];
  if (body.keepImages !== undefined) {
    if (!Array.isArray(body.keepImages)) throw new HttpError(400, "keepImages 必须是数组");
    if (body.keepImages.length > MAX_IMAGES) {
      throw new HttpError(400, `一条消息最多 ${MAX_IMAGES} 张图片`);
    }
    body.keepImages.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new HttpError(400, `第 ${index + 1} 张图片格式无效`);
      }
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || !record.id.trim()) {
        throw new HttpError(400, `第 ${index + 1} 张图片缺少 id`);
      }
      if (!isImageMediaType(record.mediaType)) {
        throw new HttpError(400, `第 ${index + 1} 张图片只支持 JPEG、PNG、GIF、WebP`);
      }
      keepImages.push({ id: record.id.trim(), mediaType: record.mediaType });
    });
  }
  // 只有 prompt 字段存在才是编辑重发；文本可以为空（纯图片），此时必须有图片。
  const editing = prompt !== undefined;
  if (body.keepImages !== undefined && !editing) {
    throw new HttpError(400, "keepImages 需要配合 prompt 使用");
  }
  if (editing && !(prompt ?? "").trim() && keepImages.length === 0) {
    throw new HttpError(400, "请填写要做的事或保留图片");
  }
  const rawWorkflow = body.workflow;
  if (rawWorkflow !== undefined && rawWorkflow !== "prl" && rawWorkflow !== "ser" && rawWorkflow !== "plan") {
    throw new HttpError(400, "回滚重发只支持 prl、ser、plan 或省略");
  }
  return {
    messageId,
    files,
    ...(prompt !== undefined ? { prompt } : {}),
    keepImages,
    editing,
    ...(rawWorkflow !== undefined ? { workflow: rawWorkflow as WorkflowSkill } : {}),
  };
}

/** 会话是否完全落定：没有排队/运行中的轮次、确认请求、子 agent、后台任务或排队消息。 */
function assertSessionSettled(session: SessionCore, runtime: Runtime): void {
  const runningSubagent = session.subagents.some((item) => item.status === "running");
  // 回滚会关闭 query，进而杀掉后台 shell 任务；有任务在跑时先让用户主动停止，
  // 不要静默终止。
  const runningBackground = (session.backgroundTasks ?? []).some((item) => item.status === "running");
  const queue = typeof runtime.queueSnapshot === "function" ? runtime.queueSnapshot(session.id) : [];
  const busy = session.phase === "queued"
    || session.phase === "running"
    || session.phase === "needs_input"
    || Boolean(session.pending)
    || session.turnActive
    || runningSubagent
    || runningBackground
    || queue.length > 0;
  if (busy) throw new HttpError(409, "对话进行中，完成或停止后再操作");
}

/**
 * 校验 keepImages 必须是目标消息自己的图片，且文件仍在磁盘上。
 * 返回目标消息里的原始 ImageRef（带 name），不信任请求体里的额外字段。
 */
function resolveKeepImages(
  target: TranscriptItem,
  requested: RewindRequest["keepImages"],
  dataDir: string,
  sessionId: string,
): ImageRef[] {
  if (requested.length === 0) return [];
  const available = target.images ?? [];
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  for (const item of requested) {
    const key = `${item.id}:${item.mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const match = available.find((image) => image.id === item.id && image.mediaType === item.mediaType);
    if (!match) throw new HttpError(400, "原消息的图片已不存在");
    const file = imageFilePath(dataDir, sessionId, match);
    if (!file || !fs.existsSync(file)) throw new HttpError(400, "原消息的图片已不存在");
    out.push(match);
  }
  return out;
}

/** 去掉本地消息上指向旧 SDK transcript 的指针；重映射失败时使用。 */
function clearSdkPointers(messages: TranscriptItem[]): TranscriptItem[] {
  return messages.map((item) => {
    if (item.sdkUuid === undefined && item.forkPoint === undefined) return item;
    const copy = { ...item };
    delete copy.sdkUuid;
    delete copy.forkPoint;
    return copy;
  });
}

/**
 * 按新 SDK transcript 重映射回滚/分叉后的本地指针；transcript 读不到或为空时
 * 降级清空，绝不能保留指向旧 uuid 的指针。
 */
async function remapViaSdk(
  runtime: Runtime,
  messages: TranscriptItem[],
  sdkId: string,
  cwd: string,
  label: string,
): Promise<{ messages: TranscriptItem[]; lastSdkUuid?: string }> {
  try {
    const sdkMessages = await runtime.sdkSessionMessages(sdkId, cwd);
    const entries = entriesFromSdkMessages(sdkMessages);
    if (entries.length > 0) return remapForks(messages, entries);
    console.warn(`[${label}] SDK transcript 为空，已清除本地回滚标记`);
  } catch (error) {
    console.warn(`[${label}] 无法读取 SDK transcript，已清除本地回滚标记:`, error);
  }
  return { messages: clearSdkPointers(messages) };
}

async function rewindSession(
  id: string,
  body: Record<string, unknown>,
  ctx: { config: AppConfig; store: Store; runtime: Runtime },
): Promise<{ prompt: { text: string; images: ImageRef[] } }> {
  const request = readRewindRequest(body);
  if (!tryLockSession(id)) throw new HttpError(409, "对话正在归档或清理，请稍后再试");
  try {
    // 读请求体/等锁期间 SSE 可能刚更新过状态，重新读最新会话。
    const latest = ctx.store.get(id);
    if (!latest) throw new HttpError(404, "找不到对话");
    assertSessionSettled(latest, ctx.runtime);

    const index = findUserMessageIndex(latest.messages, request.messageId);
    if (index < 0) {
      if (latest.messages.some((item) => item.id === request.messageId)) {
        throw new HttpError(409, "只能回滚用户消息");
      }
      throw new HttpError(404, "找不到这条消息");
    }
    const target = latest.messages[index];
    if (!target.sdkUuid || !target.forkPoint) {
      throw new HttpError(409, "这条消息不支持回滚（旧消息缺少 SDK 标记）");
    }
    const keepImages = resolveKeepImages(target, request.keepImages, ctx.config.dataDir, id);
    // 图片必须在任何破坏性操作（dryRun/fork/rewind/stop/applyRewind）之前读完：
    // 否则文件恰好消失时会返回 400，但会话已经被回滚。
    let resendImages: IncomingImage[] = [];
    if (request.editing && keepImages.length > 0) {
      try {
        resendImages = readSavedImages(ctx.config.dataDir, id, keepImages);
      } catch (error) {
        if (error instanceof ImageInputError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    if (request.editing) {
      const check = ctx.runtime.canSubmit(id);
      if (!check.ok) throw new HttpError(check.status, check.error);
    }

    if (request.files) {
      if (!ctx.runtime.canRewindFiles(id)) {
        throw new HttpError(409, "当前对话进程已结束或没有文件检查点，无法回滚代码；可以只回滚对话");
      }
      let dryRun;
      try {
        dryRun = await ctx.runtime.rewindFiles(id, target.sdkUuid, true);
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "无法回滚代码");
      }
      if (!dryRun.canRewind) throw new HttpError(409, dryRun.error || "无法回滚代码");
    }

    // forkPoint 指向目标消息之前的最后一条 chain 条目；root 表示全新会话。
    let newSdkId: string;
    let newSdkSession = false;
    if (target.forkPoint === ROOT_FORK_POINT) {
      newSdkId = randomUUID();
      newSdkSession = true;
    } else {
      const sourceSdkId = latest.claudeSessionId;
      if (!sourceSdkId) throw new HttpError(409, "这个对话没有 SDK 上下文，无法回滚");
      try {
        newSdkId = await ctx.runtime.forkSdkSession(sourceSdkId, target.forkPoint, latest.cwd);
      } catch (error) {
        // SDK 抛错时可能已经写入半份 fork；拿不到 id，只能记录后明确失败，
        // 不能继续回滚到一半。
        console.warn("[rewind] 创建 SDK 分叉失败:", error);
        throw new HttpError(500, error instanceof Error ? error.message : "无法创建 SDK 分叉");
      }
      if (!newSdkId) throw new HttpError(500, "无法创建 SDK 分叉");
    }

    if (request.files) {
      let result;
      try {
        result = await ctx.runtime.rewindFiles(id, target.sdkUuid, false);
      } catch (error) {
        try {
          removeSdkSessionFilesForIds([newSdkId]);
        } catch (cleanupError) {
          console.warn("[rewind] 无法删除新建的 fork transcript:", cleanupError);
        }
        throw new HttpError(409, error instanceof Error ? error.message : "无法回滚代码");
      }
      if (!result.canRewind) {
        // 真实回滚失败：撤掉刚建的 fork，会话状态保持不变。
        try {
          removeSdkSessionFilesForIds([newSdkId]);
        } catch (cleanupError) {
          console.warn("[rewind] 无法删除新建的 fork transcript:", cleanupError);
        }
        throw new HttpError(409, result.error || "无法回滚代码");
      }
    }

    // 关闭空闲 query：新上下文由回滚后的 claudeSessionId 决定。
    await ctx.runtime.stop(id);

    const kept = sliceBefore(latest.messages, index);
    let messages: TranscriptItem[];
    let lastSdkUuid: string | undefined;
    if (ctx.runtime.isFake()) {
      // 假运行没有真实 transcript，无法精确推算 chain uuid，保留本地指针即可。
      messages = kept;
      lastSdkUuid = latest.lastSdkUuid;
    } else {
      const remapped = await remapViaSdk(ctx.runtime, kept, newSdkId, latest.cwd, "rewind");
      messages = remapped.messages;
      lastSdkUuid = remapped.lastSdkUuid;
    }

    ctx.store.applyRewind(id, {
      messages,
      claudeSessionId: newSdkId,
      ...(newSdkSession ? { newSdkSession: true } : {}),
      forkedSdkId: newSdkId,
      ...(lastSdkUuid ? { lastSdkUuid } : {}),
      summary: "已回滚，可以继续",
      cutAt: target.at,
    });

    // 旧 SDK 会话文件已经没有任何本地消息指向，删掉避免留下孤儿 transcript。
    const oldSdkId = latest.claudeSessionId;
    if (!ctx.runtime.isFake() && oldSdkId && oldSdkId !== newSdkId) {
      try {
        removeSdkSessionFilesForIds([oldSdkId]);
      } catch (error) {
        console.warn(`[rewind] 无法删除旧 SDK 会话 ${oldSdkId}:`, error);
      }
    }

    if (request.editing) {
      const prompt = request.prompt ?? "";
      const input: PromptInput = {
        text: prompt,
        images: resendImages,
        ...(request.workflow ? { workflow: request.workflow } : {}),
      };
      const sdkUuid = randomUUID();
      ctx.store.addUserMessage(id, prompt, keepImages, sdkUuid);
      if (!ctx.runtime.isActive(id)) ctx.store.previewWorkflow(id, request.workflow, prompt);
      ctx.runtime.submit(id, toRuntimePrompt(input, sdkUuid));
    }

    return { prompt: { text: target.text, images: target.images ?? [] } };
  } finally {
    unlockSession(id);
  }
}

/** 收集前缀消息里的所有图片引用，按 id+mediaType 去重。 */
function collectImageRefs(messages: TranscriptItem[]): ImageRef[] {
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  for (const item of messages) {
    for (const image of item.images ?? []) {
      const key = `${image.id}:${image.mediaType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(image);
    }
  }
  return out;
}

async function forkSession(
  id: string,
  body: Record<string, unknown>,
  ctx: { config: AppConfig; store: Store; runtime: Runtime },
): Promise<string> {
  const messageId = typeof body.messageId === "string" ? body.messageId : "";
  if (!messageId) throw new HttpError(400, "缺少 messageId");
  if (messageId.length > 200) throw new HttpError(400, "messageId 过长");
  if (!tryLockSession(id)) throw new HttpError(409, "对话正在归档或清理，请稍后再试");
  try {
    const latest = ctx.store.get(id);
    if (!latest) throw new HttpError(404, "找不到对话");
    assertSessionSettled(latest, ctx.runtime);

    const index = findUserMessageIndex(latest.messages, messageId);
    if (index < 0) {
      if (latest.messages.some((item) => item.id === messageId)) {
        throw new HttpError(409, "只能分叉用户消息");
      }
      throw new HttpError(404, "找不到这条消息");
    }
    const target = latest.messages[index];
    // 和回滚一样要求两个指针，但两种缺失的提示分开：真正旧消息没有 sdkUuid；
    // 只有 sdkUuid 没有 forkPoint 说明消息还没被 agent 取走，拿它调 forkSession
    // 只会得到 SDK 500。
    if (!target.sdkUuid) {
      throw new HttpError(409, "这条消息不支持分叉（旧消息缺少 SDK 标记）");
    }
    if (!target.forkPoint) {
      throw new HttpError(409, "这条消息尚未被 agent 取走，暂时不能分叉");
    }

    const project = ctx.config.projects.find((item) => item.id === latest.projectId);
    if (!project) throw new HttpError(409, "项目已不在配置里");
    const info = await describeProject(project);
    if (!info.available) throw new HttpError(409, "项目目录不存在");
    // 真实模式必须有可以 fork 的源 transcript；假模式忽略 SDK 参数。
    if (!ctx.runtime.isFake() && !latest.claudeSessionId) {
      throw new HttpError(409, "这个对话没有 SDK 上下文，无法分叉");
    }

    const newId = randomUUID();
    const title = `${latest.title}（分叉）`.slice(0, 80);
    const summary = clip(target.text, 160) || "图片对话";

    let cwd = project.path;
    let branch: string | undefined;
    let workspaceCreated = false;
    let newSdkId: string | undefined;
    try {
      if (info.git) {
        const created = await createWorktree({
          projectPath: project.path,
          projectId: project.id,
          sessionId: newId,
          dataDir: ctx.config.dataDir,
          startPoint: latest.branch,
        });
        cwd = created.cwd;
        branch = created.branch;
        workspaceCreated = true;
        // 分叉出的新 worktree 也是干净 checkout：重复创建会话时的准备步骤
        //（复制 .env、链接共享目录、执行 setup）。失败由下面的 catch 清理。
        const prep = await prepareWorktree({ project, worktreePath: cwd });
        for (const warning of prep.warnings) console.warn(`[worktree] ${warning}`);
      } else if (info.isolated) {
        cwd = path.join(project.path, newId);
        fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
        workspaceCreated = true;
      }

      newSdkId = await ctx.runtime.forkSdkSession(
        latest.claudeSessionId ?? "",
        target.sdkUuid,
        latest.cwd,
        title,
      );
      if (!newSdkId) throw new Error("无法创建 SDK 分叉");

      if (!ctx.runtime.isFake() && path.resolve(cwd) !== path.resolve(latest.cwd)) {
        // 路径 slug 超过 SDK 的 200 字符上限时无法推算目标目录，这是确定性失败：
        // 让外层清理 worktree/图片/fork 文件并返回 500，不能静默返回一个不可
        // resume 的会话。
        sdkProjectSlug(cwd);
        // 其他搬运失败（权限/磁盘等）仍可回退到源目录读取 transcript。
        try {
          await relocateSdkSession(newSdkId, cwd);
        } catch (error) {
          console.warn("[fork] 无法移动 SDK 会话文件，后续从源目录读取:", error);
        }
      }

      const kept = sliceThrough(latest.messages, index);
      let messages: TranscriptItem[];
      let lastSdkUuid: string | undefined;
      if (ctx.runtime.isFake()) {
        // 假运行无法精确推算 chain uuid，沿用父会话的本地指针。
        messages = kept;
        lastSdkUuid = latest.lastSdkUuid;
      } else {
        const dirs = path.resolve(cwd) === path.resolve(latest.cwd) ? [cwd] : [cwd, latest.cwd];
        let remapped: { messages: TranscriptItem[]; lastSdkUuid?: string } | undefined;
        for (const dir of dirs) {
          try {
            const entries = entriesFromSdkMessages(await ctx.runtime.sdkSessionMessages(newSdkId, dir));
            if (entries.length > 0) {
              remapped = remapForks(kept, entries);
              break;
            }
          } catch (error) {
            console.warn("[fork] 无法读取 SDK transcript:", error);
          }
        }
        if (remapped) {
          messages = remapped.messages;
          lastSdkUuid = remapped.lastSdkUuid;
        } else {
          console.warn("[fork] 分叉后的 SDK transcript 为空，已清除本地回滚标记");
          messages = clearSdkPointers(kept);
          lastSdkUuid = undefined;
        }
      }

      copyImageRefs(ctx.config.dataDir, latest.id, newId, collectImageRefs(kept));

      ctx.store.createBranch({
        id: newId,
        projectId: latest.projectId,
        projectPath: project.path,
        title,
        titlePending: latest.titlePending === true,
        providerId: latest.providerId,
        providerName: latest.providerName,
        model: latest.model,
        effort: latest.effort,
        cwd,
        branch,
        git: info.git,
        messages,
        claudeSessionId: newSdkId,
        lastSdkUuid,
        summary,
      });
      return newId;
    } catch (error) {
      // 尽力清理已经建好的 worktree/目录、图片副本和 fork transcript。
      if (workspaceCreated) {
        if (info.git) {
          await removeWorktree(project.path, cwd, branch, { sessionId: newId }).catch(() => undefined);
        } else {
          try {
            fs.rmSync(cwd, { recursive: true, force: true });
          } catch {
            // 尽力清理；失败时保留错误返回给调用方。
          }
        }
      }
      removeSessionImages(ctx.config.dataDir, newId);
      if (newSdkId) {
        try {
          removeSdkSessionFilesForIds([newSdkId]);
        } catch (cleanupError) {
          console.warn("[fork] 无法删除新建的 fork transcript:", cleanupError);
        }
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, error instanceof Error ? error.message : "无法分叉对话");
    }
  } finally {
    unlockSession(id);
  }
}

/**
 * 新建仓库的项目 id：优先用名称推导的 slug；纯中文等推不出时用随机 id。
 * slug 已存在时视为冲突，避免悄悄接管已有项目。
 */
function newRepoProjectId(name: string, config: AppConfig, extras: ProjectConfig[]): string {
  const taken = (id: string) =>
    id === CHAT_PROJECT_ID
    || config.projects.some((project) => project.id === id)
    || extras.some((project) => project.id === id);
  const slug = projectIdFromName(name);
  if (slug) {
    if (taken(slug)) throw new HttpError(409, `项目 id 已存在：${slug}，请换一个仓库名称`);
    return slug;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `repo-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (!taken(id)) return id;
  }
  throw new HttpError(400, "无法生成唯一的项目 id，请换一个包含字母或数字的仓库名称");
}

async function projectView(
  project: ProjectConfig,
  saved: Record<string, PermissionLevel>,
  removable: boolean,
): Promise<ProjectInfo> {
  const info = await describeProject(project);
  return {
    ...info,
    permission: resolvePermission(project.id, project.permission, saved),
    removable,
  };
}

/**
 * 可以从设置页删除的项目：存在于额外项目文件、且没有在 config.yaml 里定义。
 * 同时出现在两处时删除只会让 config.yaml 的条目重新出现，因此视为不可删。
 */
function removableProjectIds(config: AppConfig): Set<string> {
  const file = config.projectsFile ?? path.join(config.configDir, "projects.yaml");
  const extras = readProjectsFile(file, config.configDir);
  const base = new Set((config.projectsBase ?? []).map((project) => project.id));
  return new Set(
    extras.projects
      .map((project) => project.id)
      .filter((id) => !base.has(id)),
  );
}

function findProject(config: AppConfig, id: string): ProjectConfig {
  const project = config.projects.find((item) => item.id === id);
  if (!project) throw new HttpError(404, "找不到项目");
  return project;
}

function requireSecondary(config: AppConfig): void {
  if (config.role !== "secondary" || !config.secondary) throw new HttpError(404, "没有这个接口");
}

function requirePush(ctx: { push?: PushService }): PushService {
  if (!ctx.push) throw new HttpError(503, "推送未配置");
  return ctx.push;
}

interface PromptInput {
  text: string;
  images: IncomingImage[];
  /** 聊天输入区显式选择的工作流；缺省时由正文末尾的 token 推导。 */
  workflow?: WorkflowSkill;
  /** 插话：立即交给正在跑的 agent，而不是排队等这一轮结束。 */
  interject?: boolean;
}

function readPrompt(body: unknown): PromptInput {
  const record = asRecord(body);
  const text = typeof record.prompt === "string" ? record.prompt.trim() : "";
  let images: IncomingImage[];
  try {
    images = parseIncomingImages(record.images);
  } catch (error) {
    if (error instanceof ImageInputError) throw new HttpError(400, error.message);
    throw error;
  }
  const rawWorkflow = readWorkflow(record.workflow);
  if (!text && images.length === 0) throw new HttpError(400, "请填写要做的事或添加图片");
  // 文本附件合计上限 150k，再给用户自己的输入留一点余量。
  if (text.length > 160_000) throw new HttpError(400, "内容过长");
  return {
    text,
    images,
    ...(rawWorkflow !== undefined ? { workflow: rawWorkflow } : {}),
    ...(record.interject === true ? { interject: true } : {}),
  };
}

/** 请求体里的显式工作流；只接受已知的几种。 */
function readWorkflow(value: unknown): WorkflowSkill | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "prl"
    && value !== "ser"
    && value !== "plan"
    && value !== "discuss"
    && value !== "dis-prl"
  ) {
    throw new HttpError(400, "workflow 必须是 prl、ser、plan、discuss、dis-prl 或省略");
  }
  return value;
}

/**
 * 校验讨论参与模型：接口配置必须存在，模型必须在配置里，effort 合法。
 * 名称可留空（退回模型名），允许重复选同一个模型。
 */
function readDiscussionParticipants(
  value: unknown,
  settings: StoredSettings,
): DiscussionParticipant[] {
  if (!Array.isArray(value)) throw new HttpError(400, "participants 必须是数组");
  if (value.length === 0) throw new HttpError(400, "请先添加参与讨论的模型");
  if (value.length > MAX_DISCUSSION_PARTICIPANTS) {
    throw new HttpError(400, `参与讨论的模型最多 ${MAX_DISCUSSION_PARTICIPANTS} 个`);
  }
  const participants: DiscussionParticipant[] = [];
  value.forEach((item, index) => {
    const order = index + 1;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, `第 ${order} 个参与者的格式无效`);
    }
    const record = item as Record<string, unknown>;
    const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
    const provider = findProvider(settings, providerId);
    if (!provider) throw new HttpError(400, `第 ${order} 个参与者的接口配置不存在`);
    const model = typeof record.model === "string" ? record.model.trim() : "";
    if (!provider.models.includes(model)) {
      throw new HttpError(400, `第 ${order} 个参与者的模型不在这套配置里`);
    }
    if (!isEffort(record.effort)) {
      throw new HttpError(400, "effort 必须是 low、medium、high、xhigh 或 max");
    }
    const rawName = typeof record.name === "string" ? record.name.trim() : "";
    if (rawName.length > 40) throw new HttpError(400, "参与者名称最多 40 个字符");
    participants.push({
      name: rawName || model,
      providerId: provider.id,
      providerName: provider.name,
      model,
      effort: record.effort,
    });
  });
  return participants;
}

function toRuntimePrompt(input: PromptInput, uuid?: string, storedImages?: ImageRef[]): RuntimePrompt {
  return {
    text: input.text,
    images: input.images.map((image) => ({
      mediaType: image.mediaType,
      // 解析时已经拿到 base64，直接复用；只有手工构造的图片才需要再编码。
      data: image.base64 ?? image.data.toString("base64"),
    })),
    // 供 runtime 在 prompt 真正被 agent 取走时写进对话记录。
    ...(storedImages && storedImages.length > 0 ? { storedImages } : {}),
    ...(input.workflow ? { workflow: input.workflow } : {}),
    ...(uuid ? { uuid } : {}),
  };
}

function readApproval(body: unknown): Approval {
  const record = asRecord(body);
  if (record.behavior !== "allow" && record.behavior !== "deny") {
    throw new HttpError(400, "behavior 必须是 allow 或 deny");
  }
  let answers: Record<string, string> | undefined;
  if (record.answers !== undefined) {
    if (!record.answers || typeof record.answers !== "object" || Array.isArray(record.answers)) {
      throw new HttpError(400, "answers 必须是对象");
    }
    answers = {};
    for (const [key, value] of Object.entries(record.answers as Record<string, unknown>)) {
      if (typeof value !== "string") throw new HttpError(400, "答案必须是字符串");
      answers[key] = value;
    }
  }
  const remember = record.remember === true;
  const approvedFull = record.approvedFull === true;
  return {
    behavior: record.behavior,
    answers,
    ...(remember ? { remember: true } : {}),
    ...(approvedFull ? { approvedFull: true } : {}),
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "请求不是 JSON 对象");
  return body as Record<string, unknown>;
}

/** taskId 可能含百分号编码；非法编码直接 400，不能把坏值带进 runtime。 */
function decodeTaskId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "任务 id 编码无效");
  }
}

/** 历史分页参数只接受非负整数；其余一律 400。 */
function parsePageIndex(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${name} 必须是非负整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, `${name} 必须是非负整数`);
  return parsed;
}

/**
 * `sessionId` 为 null 时是全量订阅（BoardPage）：直接发 store 广播的 summary，
 * 不带 messages。removed 占位事件原样转发。
 *
 * 指定会话时（DetailPage）改为增量帧：连接建立先推一帧全量快照，之后每帧都带
 * 元数据，消息只在真正变化时带 `messagesFrom` + 尾部片段。客户端会丢掉本地从
 * `messagesFrom` 起的内容再追加。每个连接记住已发送的条数和最后一条 id，探测
 * 不变量被破坏（截断/重排）时退回全量。
 *
 * 慢连接（手机切后台、网络抖动）不会读走数据。这里按连接做合并 + 背压：
 * res.write 返回 false 后不再继续写，只记录“有新状态”，等 drain 再补发
 * 最新快照。否则流式输出时会把每一帧完整 detail 都叠进 Node 的写缓冲，
 * 一个长会话就能把堆撑爆（qubius 主实例 502 的 OOM 事故）。SseQueue 的构建器
 * 是惰性的，所以游标只在构建器真正执行时更新。
 */
function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  sessionId: string | null,
  enrich: (summary: SessionEvent) => SessionEvent,
  historyPage: number,
): void {
  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // 立刻把响应头发出去：Board 连接在首个事件之前没有正文，浏览器/代理需要先看到 200。
  res.flushHeaders();
  // 写缓冲满时停止写、只保留最新状态，等 drain 再补发，避免慢连接把堆撑爆。
  const queue = new SseQueue((payload) => res.write(`event: session\ndata: ${JSON.stringify(payload)}\n\n`));

  // Board：store.emit 只广播 summary（不带 messages），直接转发，同一会话只留最新一条。
  if (sessionId === null) {
    const unsubscribe = store.subscribe((event) => queue.enqueue(event.id, () => enrich(event)));
    res.on("drain", () => queue.drain());
    // 连接卡在背压上时不再往缓冲里塞心跳；恢复后下一次事件/drain 会继续。
    const ping = setInterval(() => {
      if (!queue.isBlocked) res.write(": ping\n\n");
    }, 20_000);
    const stop = () => {
      clearInterval(ping);
      unsubscribe();
    };
    res.on("error", stop);
    req.on("close", stop);
    return;
  }

  // 详情连接游标：上次发送时整段 messages 的原始引用（不复制）。
  // store 对变化的消息总是替换对象（写时复制），引用相等即可判断内容未变。
  let sentItems: TranscriptItem[] = [];
  /**
   * 上次 reset 帧发送的页面起点，对应客户端本地的 historyStart。
   * 增量帧的 messagesFrom 必须 >= 它，否则客户端会丢弃整帧。
   */
  let sentStart = 0;

  const buildDetail = (initial: boolean): (SessionEvent & { reset?: boolean }) | null => {
    const session = store.get(sessionId);
    if (!session) return null; // 会话已不存在。
    const messages = session.messages;
    // 从 0 逐项比较引用，找到第一个变化的条目；这能覆盖非尾部变化（如思考片段继续增长）。
    const common = Math.min(messages.length, sentItems.length);
    let from = 0;
    while (from < common && messages[from] === sentItems[from]) from += 1;
    const include = initial || from < messages.length || sentItems.length !== messages.length;

    let frame: SessionEvent & { reset?: boolean };
    if (include) {
      // 初始帧、整段变短（limitTranscript 丢弃了旧消息），或变化点落在客户端
      // 已加载窗口之前（from < sentStart，包括丢下标 1 但长度不变的情况）：
      // 客户端无法安全拼接，改发最近一页并带 reset，由客户端整段替换。
      // 这样任何非 reset 帧都满足 messagesFrom >= 客户端 historyStart。
      const reset = initial
        || messages.length < sentItems.length
        || from < sentStart;
      const start = reset ? Math.max(0, messages.length - historyPage) : from;
      // detailSlice 同时带回 summary，避免再单独调用 store.summary 复制一次元数据。
      const slice = store.detailSlice(sessionId, start);
      if (!slice) return null;
      frame = { ...enrich(slice.summary), messageCount: messages.length };
      if (reset) frame.reset = true;
      frame.messagesFrom = start;
      frame.messages = slice.messages;
      // 保存原始引用；后续用它与 store 里的对象做引用比较。
      sentItems = messages;
      // 只有 reset 帧会刷新客户端的历史起点；增量帧沿用上次的起点。
      if (reset) sentStart = start;
    } else {
      // 只发元数据时才需要单独构造 summary。
      frame = { ...enrich(store.summary(sessionId, false)), messageCount: messages.length };
    }
    return frame;
  };

  // 初次连接立刻推一帧全量快照（同样走队列，保留背压语义）。
  queue.enqueue(sessionId, () => buildDetail(true));
  const unsubscribe = store.subscribe((event) => {
    // removed 事件同样带原 id，保持原样转发。
    if (event.id !== sessionId) return;
    if (event.removed) {
      queue.enqueue(event.id, () => enrich(event));
      return;
    }
    queue.enqueue(event.id, () => buildDetail(false));
  });
  res.on("drain", () => queue.drain());
  const ping = setInterval(() => {
    if (!queue.isBlocked) res.write(": ping\n\n");
  }, 20_000);
  const stop = () => {
    clearInterval(ping);
    unsubscribe();
  };
  res.on("error", stop);
  req.on("close", stop);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "请求过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求不是 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function statFile(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(file);
  } catch {
    return undefined;
  }
}

/** 静态文件用 size+mtime 生成弱 ETag：内容没变就不必重传。 */
function weakEtag(stat: fs.Stats): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function matchesEtag(header: string, etag: string): boolean {
  return header.split(",").some((part) => {
    const value = part.trim();
    return value === "*" || value === etag;
  });
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webDist: string,
  pathname: string,
): Promise<void> {
  const root = path.resolve(webDist);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.resolve(root, `.${requested}`);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  const fileStat = await statFile(file);
  if (fileStat?.isFile()) {
    // Vite 的 /assets/* 是内容哈希文件，可以长期缓存；其余（尤其 index.html）不缓存。
    sendFile(req, res, file, requested.startsWith("/assets/") ? IMMUTABLE_CACHE : NO_CACHE, fileStat);
    return;
  }
  const index = path.join(root, "index.html");
  const indexStat = await statFile(index);
  if (!path.extname(requested) && indexStat?.isFile()) {
    sendFile(req, res, index, NO_CACHE, indexStat);
    return;
  }
  if (!indexStat) {
    res.writeHead(200, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    res.end("qubius 服务已启动。开发时打开 Vite，或先构建 web/dist。");
    return;
  }
  res.writeHead(404, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function sendImage(res: ServerResponse, file: string, mediaType: ImageMediaType): void {
  const stat = fs.statSync(file);
  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": mediaType,
    "Content-Length": stat.size,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  const stream = fs.createReadStream(file);
  // 文件在 stat 与打开之间消失时不能让未处理的 'error' 事件杀死进程。
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  cacheControl: string,
  stat: fs.Stats,
): void {
  const ext = path.extname(file);
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
  };
  const etag = weakEtag(stat);
  const headers: Record<string, string | number> = {
    ...securityHeaders(),
    "Content-Type": types[ext] || "application/octet-stream",
    "Cache-Control": cacheControl,
    "Content-Length": stat.size,
    ETag: etag,
  };
  if (matchesEtag(headerValue(req.headers["if-none-match"]), etag)) {
    // 304 只回校验信息，不带正文，也不需要 Content-Length。
    delete headers["Content-Length"];
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(file);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
