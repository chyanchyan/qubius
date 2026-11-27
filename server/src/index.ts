import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveStore } from "./archive.js";
import { writeFileAtomic } from "./atomic-file.js";
import { AUTH_TOKEN_FILE, resolveAuthToken } from "./auth.js";
import { BatchWatchManager, BatchWatchStore } from "./batch-watch.js";
import { bootstrapConfig, DEFAULT_ALLOWED_HOSTS, loadConfig, type AppConfig } from "./config.js";
import { envCompat, envFlag } from "./env.js";
import { deployConfigDir, parseEnvFile } from "./deploy.js";
import { scanLegacyConfigs } from "./legacy-config.js";
import { createAppServer, createSession } from "./http.js";
import { loadProjectPermissions, resolvePermission } from "./project-permissions.js";
import { PushService } from "./push.js";
import { mergeProjectLists, readProjectsFile } from "./project-source.js";
import type { AuthTokenState } from "./credential-reset.js";
import { ArchiveSweeper } from "./retention.js";
import { Runtime } from "./runtime.js";
import { ScheduleRunner, ScheduleStore } from "./schedules.js";
import { defaultSdkConfigDir } from "./sdk-files.js";
import { createSdkTitleSummarizer } from "./session-title.js";
import { createSdkDiscussant } from "./discussion.js";
import { createSdkRoleAgent } from "./role-agent.js";
import { GeminiBridge } from "./gemini-bridge.js";
import { findProvider, loadSettings, providerKind } from "./settings.js";
import { enabledSkillFilter, SkillSettings } from "./skills.js";
import { configureLimits } from "./status.js";
import { Store } from "./store.js";
import { TerminalManager } from "./terminal.js";
import { TerminalController } from "./terminal-http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// 手工 `npm start` 时也读取 checkout 内的 <配置目录>/env，让 quickstart、部署页
// 和服务进程看到同一份配置。部署脚本启动时会设置 QUBIUS_ENV，这里不重复读取。
if (!process.env.QUBIUS_ENV) {
  const envFile = path.join(deployConfigDir(process.env, process.platform, repoRoot), "env");
  if (fs.existsSync(envFile)) {
    try {
      const stored = parseEnvFile(fs.readFileSync(envFile, "utf8"), process.env);
      for (const [key, value] of Object.entries(stored)) {
        if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
      }
    } catch (error) {
      console.warn(`无法读取部署 env 文件 ${envFile}`, error);
    }
  }
}

// Node 的内置 fetch 默认不读代理环境变量；打开这个开关后，服务端请求（Gemini
// 适配层、测试、余额）才跟随机器/部署环境的 HTTP(S)_PROXY，和子进程里的
// git/curl 保持一致。部署方显式设为 "0" 时不覆盖；Node 22.21 以下会忽略它。
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

function configPath(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf("--config");
  const fromArg = index >= 0 ? args[index + 1] : undefined;
  if (fromArg) return path.resolve(fromArg);
  // 新变量优先，旧变量保留兼容。
  const fromEnv = envCompat("QUBIUS_CONFIG");
  if (fromEnv) return path.resolve(fromEnv);
  // 兼容旧布局：仓库根的 config.yaml 优先。
  const local = path.resolve(here, "../../config.yaml");
  if (fs.existsSync(local)) return local;
  // 默认布局：配置在 <checkout>/.qubius/config.yaml，不设 QUBIUS_CONFIG 也能手工重启。
  const secondary = envCompat("QUBIUS_SECONDARY") === "1";
  return path.join(
    deployConfigDir(process.env, process.platform, repoRoot),
    secondary ? "config-secondary.yaml" : "config.yaml",
  );
}

const configFile = configPath();
// 冷启动：配置文件还不存在时用 bootstrap 默认配置启动，保证部署页能打开。
const setupRequired = !fs.existsSync(configFile);
let config: AppConfig;
if (setupRequired) {
  console.warn(`找不到配置文件 ${configFile}，使用启动默认配置（部署页可用）`);
  config = bootstrapConfig(configFile, repoRoot);
} else {
  config = loadConfig(configFile);
}
// 部署页要和当前实际使用的配置目录一致：仓库根有旧 config.yaml 时，
// 页面继续读写那个目录，而不是另算一个 .qubius/。
process.env.QUBIUS_CONFIG_DIR ??= config.configDir;
process.env.QUBIUS_REPO_DIR ??= repoRoot;
// 未配置 allowedHosts 时默认只允许回环主机（失败关闭），公网/局域网访问需显式配置。
const effectiveHosts = config.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS];
const defaultHosts = effectiveHosts.length === DEFAULT_ALLOWED_HOSTS.length
  && DEFAULT_ALLOWED_HOSTS.every((host) => effectiveHosts.includes(host));
if (defaultHosts) {
  console.log(
    `allowedHosts 未配置：默认只允许回环主机（${DEFAULT_ALLOWED_HOSTS.join("、")}）；`
    + "公网/局域网访问请显式配置 allowedHosts",
  );
}
const authToken = resolveAuthToken(config);
/** 令牌来源，供 /api/config 和启动日志说明「去哪里看令牌」。 */
const authTokenSource: "config" | "env" | "file" | undefined = authToken
  ? config.authToken
    ? "config"
    : envCompat("QUBIUS_AUTH_TOKEN")
      ? "env"
      : "file"
  : undefined;
const authTokenFile = authTokenSource === "file" ? path.join(config.dataDir, AUTH_TOKEN_FILE) : undefined;
/** 可变的令牌状态：部署页重置令牌后立即生效，不需要重启服务。 */
const authTokenState: AuthTokenState = {
  ...(authToken ? { current: authToken } : {}),
  ...(authTokenSource ? { source: authTokenSource } : {}),
  ...(authTokenFile ? { file: authTokenFile } : {}),
};
// 启动时打印一份「实际生效的位置和值」，排查「配置改在哪 / 为什么没生效」时先看这里。
const envFileForLog = path.join(config.configDir, "env");
console.log(`[config] 配置文件：${configFile}`);
console.log(
  `[config] 配置目录：${config.configDir}；env：${envFileForLog}`
    + (fs.existsSync(envFileForLog) ? "" : "（不存在）"),
);
console.log(
  `[config] 数据目录：${config.dataDir}；监听：${config.host}:${config.port}；角色：${config.role}`,
);
console.log(`[config] allowedHosts：${effectiveHosts.join("、")}`);
console.log(
  `[config] 访问令牌：${authToken ? `已启用（来源：${authTokenSource}${authTokenFile ? `，文件：${authTokenFile}` : ""}）` : "未启用"}`
    + `；归档：${config.archive ? config.archive.dir : "未启用"}`,
);
// 旧版默认配置目录（%APPDATA%\qubius、~/.config/qubius 等）只提示，不自动迁移：
// 迁移会删除旧目录里的配置文件，必须由用户在部署页确认。
for (const legacy of scanLegacyConfigs({
  currentConfigDir: deployConfigDir(process.env, process.platform, repoRoot),
})) {
  console.log(
    `[legacy] 检测到旧版配置目录：${legacy.path}（${legacy.files.length} 个配置文件）；可在部署页迁移`,
  );
}
// 隔离项目按对话建子目录，根目录可能还没创建；失败时项目会显示为不可用。
for (const project of config.projects) {
  if (!project.isolated) continue;
  try {
    fs.mkdirSync(project.path, { recursive: true, mode: 0o700 });
  } catch (error) {
    console.warn(`无法创建隔离项目的目录 ${project.path}`, error);
  }
}
/**
 * 额外项目文件（设置页添加/删除或手工编辑）变化后热更新列表，不用重启实例。
 * 以 config.yaml 自带的项目为底稿，文件里的同 id 项目覆盖它。
 */
const projectsFile = config.projectsFile;
const projectsBase = config.projectsBase ?? config.projects;
if (projectsFile) {
  let lastExtras = JSON.stringify(readProjectsFile(projectsFile, config.configDir).projects);
  const reloadProjects = (reason: string): void => {
    const result = readProjectsFile(projectsFile, config.configDir);
    if (result.error) {
      console.warn(`[projects] 热加载失败（${reason}）：${result.error}；保留当前项目列表`);
      return;
    }
    const serialized = JSON.stringify(result.projects);
    if (serialized === lastExtras) return;
    lastExtras = serialized;
    const next = mergeProjectLists(projectsBase, result.projects);
    for (const project of next) {
      if (!project.isolated) continue;
      try {
        fs.mkdirSync(project.path, { recursive: true, mode: 0o700 });
      } catch (error) {
        console.warn(`无法创建隔离项目的目录 ${project.path}`, error);
      }
    }
    config.projects.splice(0, config.projects.length, ...next);
    const moved = store.reconcileProjects(config.projects);
    console.log(`[projects] 已热加载项目列表（${reason}）：${next.length} 个项目`);
    if (moved > 0) console.log(`[store] 已按当前项目配置修正 ${moved} 个会话的项目路径`);
  };
  // watchFile 按 mtime/size 轮询，文件还没创建时也能等到第一次写入。
  fs.watchFile(projectsFile, { interval: 1000, persistent: false }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    reloadProjects("项目文件变化");
  });
}
// config.yaml / env 的运行参数只作为设置文件的初始默认；之后以设置页保存的值为准。
const settings = {
  current: loadSettings(config.dataDir, {
    maxConcurrent: config.maxConcurrent,
    approvalTimeoutMinutes: config.approvalTimeoutMinutes,
    limits: config.limits,
    archiveRetentionDays: config.archive?.retentionDays,
  }),
};
// 会话裁剪/截断上限来自设置（首次启动时继承配置）；在加载会话前生效，旧文件也会按新上限收敛。
configureLimits(settings.current.limits);
const permissions = { current: loadProjectPermissions(config.dataDir) };
const store = new Store(config.dataDir);
// 会话记录的是创建时的项目绝对路径；项目改名/搬移后按当前配置重新对齐，
// 否则旧会话会在下一轮因为 `--project-config-root` 不存在而启动失败。
const reconciled = store.reconcileProjects(config.projects);
if (reconciled > 0) console.log(`[store] 已按当前项目配置修正 ${reconciled} 个会话的项目路径`);
// 每 60 秒记录一行内存日志，便于观察长会话/慢连接是否推高堆；unref 不阻止退出。
setInterval(() => {
  const usage = process.memoryUsage();
  const mb = (value: number): number => Math.round(value / (1024 * 1024));
  console.log(
    `[memory] rss=${mb(usage.rss)}MB heapUsed=${mb(usage.heapUsed)}MB sessions=${store.count()}`,
  );
}, 60_000).unref();
// 推送初始化失败不能阻止服务启动：dataDir 不可写等情况下只记录错误，
// 由 HTTP 路由回退到 503「推送未配置」。
let push: PushService | undefined;
try {
  push = new PushService(config.dataDir);
} catch (error) {
  console.error("[push] 初始化推送服务失败，推送通知不可用:", error);
}
if (push) {
  const pushService = push;
  // 先于 HTTP server 订阅：启动后产生的事件都能收到。发送失败不应影响
  // 其他 store 订阅者（例如 SSE 连接）。
  store.subscribe((event) => {
    try {
      pushService.onSessionEvent(
        event,
        config.projects.find((project) => project.id === event.projectId)?.name ?? event.projectId,
      );
    } catch (error) {
      console.error("[push] 处理会话事件失败:", error);
    }
  });
}
const fake = envFlag("QUBIUS_FAKE_AGENT");
if (fake) {
  console.warn("QUBIUS_FAKE_AGENT=1（或 REMOTE_CODER_FAKE_AGENT=1），对话不会调用模型");
}
// 技能开关与来源域发现共用同一个 store；HTTP 改开关，运行时在下一轮 query 里读过滤列表。
const skillStore = new SkillSettings(config.dataDir);
const claudeConfigDir = defaultSdkConfigDir();
// Gemini 接口不能让 SDK 直连（协议不同），统一指向本机适配服务。
// 启动失败只影响 Gemini 配置；Anthropic 兼容配置照常可用。
const geminiBridge = new GeminiBridge({
  provider: (providerId) => {
    const provider = findProvider(settings.current, providerId);
    if (!provider || providerKind(provider) !== "gemini") return undefined;
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey.trim(),
    };
  },
});
void geminiBridge.start().catch((error) => {
  console.error("[gemini] 本地适配服务启动失败，Gemini 接口配置将不可用:", error);
});
const credential = (providerId: string) => {
  const provider = findProvider(settings.current, providerId);
  if (!provider) throw new Error("这个对话的接口配置已删除，请新开一个对话");
  const apiKey = provider.apiKey.trim();
  if (!apiKey) throw new Error("这个接口配置还没有 API key");
  const gemini = providerKind(provider) === "gemini";
  const baseUrl = gemini ? geminiBridge.baseUrl(provider.id) : provider.baseUrl;
  return { apiKey, baseUrl };
};
const runtime = new Runtime(store, {
  maxConcurrent: settings.current.maxConcurrent,
  approvalTimeoutMinutes: settings.current.approvalTimeoutMinutes,
  fake,
  permission: (projectId) => {
    const project = config.projects.find((item) => item.id === projectId);
    return resolvePermission(projectId, project?.permission ?? "acceptEdits", permissions.current);
  },
  credential,
  // 假运行没有真实模型，标题保持占位；真实模式在首个成功轮次后总结标题。
  ...(fake ? {} : { titleSummarizer: createSdkTitleSummarizer({ credential }) }),
  // 多模型讨论的每次发言都是一次独立模型调用；假运行使用运行时内置的假实现。
  ...(fake ? {} : { discussant: createSdkDiscussant({ credential }) }),
  // prl-role 的每次角色调用同样是独立模型调用；假运行使用运行时内置的假实现。
  ...(fake ? {} : { roleAgent: createSdkRoleAgent({ credential }) }),
  secrets: () => settings.current.providers.map((provider) => provider.apiKey),
  skills: {
    filter: (projectId) => enabledSkillFilter({
      config,
      configDir: claudeConfigDir,
      disabled: skillStore.snapshot(),
      projectId,
    }),
    version: () => skillStore.version,
  },
});
const archiveConfig = config.archive;
const archive = archiveConfig
  ? new ArchiveStore({
    dir: archiveConfig.dir,
    instance: archiveConfig.instance,
    dataDir: config.dataDir,
    retentionDays: settings.current.archiveRetentionDays,
    projects: config.projects,
  })
  : undefined;
const sweeper = archive && archiveConfig
  ? new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: settings.current.archiveRetentionDays,
    dataDir: config.dataDir,
  })
  : undefined;
if (archive) {
  console.log(`归档目录：${archive.root}（列表保留 ${settings.current.archiveRetentionDays} 天）`);
} else {
  console.warn("未配置 archive：会话不会归档，也不会按 30 天自动清理");
}
const webDist = path.resolve(here, "../../web/dist");
// 日程文件损坏时不能拖垮整个服务：记录错误并禁用定时任务。
let scheduleStore: ScheduleStore | undefined;
try {
  scheduleStore = new ScheduleStore(config.dataDir);
} catch (error) {
  console.error("[schedules] 初始化定时任务失败，定时任务不可用:", error);
}
const scheduleRunner = scheduleStore
  ? new ScheduleRunner({
    store: scheduleStore,
    createSession: async (schedule) => {
      const project = config.projects.find((item) => item.id === schedule.projectId);
      if (!project) throw new Error("定时任务所属项目已从配置移除");
      const session = await createSession(project, {
        prompt: schedule.prompt,
        providerId: schedule.providerId,
        model: schedule.model,
        effort: schedule.effort,
        title: `定时 · ${schedule.prompt.split("\n")[0]?.slice(0, 60) || "任务"}`,
      }, { config, store, runtime, settings });
      return { id: session.id };
    },
  })
  : undefined;
// 批量会话监听与自动整合：等待阶段订阅 Store 事件不消耗模型 token，全部完成后自动启动指定模型的审核会话。
let batchWatchManager: BatchWatchManager | undefined;
try {
  const watchStore = new BatchWatchStore(config.dataDir);
  batchWatchManager = new BatchWatchManager({
    config,
    store,
    runtime,
    settings,
    watchStore,
    createReviewSession: async (input) => {
      const session = await createSession(input.project, {
        prompt: input.prompt,
        providerId: input.providerId,
        model: input.model,
        effort: input.effort,
        title: input.title,
      }, { config, store, runtime, settings });
      return { id: session.id };
    },
  });
} catch (error) {
  console.error("[batch-watch] 初始化批量会话监听失败，该功能暂不可用:", error);
}
// 命令行与 /api 共用同一套 Host/令牌校验；PTY 走普通 HTTP 流。
const terminalController = config.terminal === false
  ? undefined
  : new TerminalController(new TerminalManager());
if (!terminalController) console.log("命令行页已关闭（terminal: false / QUBIUS_TERMINAL=0）");
// 部署任务用这个令牌让旧进程优雅退出：Windows 上 process.kill 不会触发 SIGTERM
// 处理器，直接硬杀会跳过 store.flush()，最多丢掉一个防抖窗口的会话改动。
// 令牌每次启动重新生成，写到 dataDir 供本机的部署任务读取。
const shutdownToken = randomBytes(32).toString("hex");
const shutdownTokenFile = path.join(config.dataDir, "shutdown-token");
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  writeFileAtomic(shutdownTokenFile, `${shutdownToken}\n`, { mode: 0o600 });
} catch (error) {
  console.warn(`无法写入 ${shutdownTokenFile}，Windows 部署将退回强制结束进程`, error);
}
const server = createAppServer({
  config,
  store,
  runtime,
  webDist,
  settings,
  permissions,
  repoRoot,
  archive,
  sweeper,
  push,
  schedules: scheduleStore,
  scheduleRunner,
  batchWatches: batchWatchManager,
  setupRequired,
  configFile,
  ...(authTokenSource ? { authTokenSource } : {}),
  ...(authTokenFile ? { authTokenFile } : {}),
  skills: { store: skillStore, configDir: claudeConfigDir },
  sdkConfigDir: claudeConfigDir,
  authToken,
  authTokenState,
  shutdownToken,
  shutdown: (reason) => runShutdown(reason, 0),
  ...(terminalController ? { terminal: terminalController } : {}),
});

server.on("error", (error: NodeJS.ErrnoException) => {
  // 端口冲突是首次启动最常见的失败：给一句能直接照做的提示，而不是堆栈。
  if (error.code === "EADDRINUSE") {
    console.error(
      `端口 ${config.host}:${config.port} 已被占用；请停止占用该端口的进程后重试，`
        + "或换一个端口（QUBIUS_PRIMARY_PORT / QUBIUS_SECONDARY_PORT，或 config.yaml 的 listen）。",
    );
    process.exit(1);
  }
  throw error;
});

server.listen(config.port, config.host, () => {
  console.log(`qubius listening on http://${config.host}:${config.port}`);
});
scheduleRunner?.start();
batchWatchManager?.start();

if (sweeper) {
  const tick = () => {
    void sweeper.run().then((result) => {
      if (result.removed > 0 || result.failed.length > 0) {
        console.log(
          `[archive] 整理完成：归档 ${result.archived}，移除 ${result.removed}，失败 ${result.failed.length}`,
        );
      }
    }).catch((error) => {
      console.error("[archive] 定时整理失败:", error);
    });
  };
  // 启动后再跑，避免和加载会话、恢复服务抢磁盘。
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}

let shuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // 先停止接收新工作，避免 close 等待期间又开新会话。
  scheduleRunner?.stop();
  batchWatchManager?.stop();
  runtime.beginShutdown();
  console.log(`收到 ${signal}，停止接收新请求`);
  // server.close 只停止接收新连接；SSE 这类长连接必须主动断开，否则会等满宽限。
  if (signal === "uncaughtException") {
    // 已经处于异常状态，不再等待连接优雅结束。
    server.close();
    server.closeAllConnections();
  } else {
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    server.closeAllConnections();
  }
  // SSE 长连接不在 closeAllConnections 的清理里，显式结束 PTY 子进程。
  terminalController?.closeAll();
  const force = setTimeout(() => {
    console.error("退出清理超过 10 秒，强制结束进程");
    process.exit(exitCode);
  }, 10_000);
  let cleanupFailed = false;
  try {
    await runtime.shutdown();
  } catch (error) {
    console.error("退出时清理运行时失败", error);
    cleanupFailed = true;
  }
  clearTimeout(force);
  process.exit(cleanupFailed ? 1 : exitCode);
}

function runShutdown(signal: string, exitCode: number): void {
  void shutdown(signal, exitCode).catch((error) => {
    console.error("退出流程失败", error);
    process.exit(1);
  });
}

process.on("SIGTERM", () => {
  runShutdown("SIGTERM", 0);
});
process.on("SIGINT", () => {
  runShutdown("SIGINT", 0);
});
// 未捕获的异常不能静默：先记录，再走一遍收尾流程并以失败码退出。
process.on("uncaughtException", (error) => {
  console.error("uncaughtException", error);
  runShutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection", reason);
});
