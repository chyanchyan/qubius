import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveStore } from "./archive.js";
import { AUTH_TOKEN_FILE, resolveAuthToken } from "./auth.js";
import { bootstrapConfig, DEFAULT_ALLOWED_HOSTS, loadConfig, type AppConfig } from "./config.js";
import { envCompat, envFlag } from "./env.js";
import { deployConfigDir, parseEnvFile } from "./deploy.js";
import { createAppServer, createSession } from "./http.js";
import { loadProjectPermissions, resolvePermission } from "./project-permissions.js";
import { PushService } from "./push.js";
import { mergeProjectLists, readProjectsFile } from "./project-source.js";
import { ArchiveSweeper } from "./retention.js";
import { Runtime } from "./runtime.js";
import { ScheduleRunner, ScheduleStore } from "./schedules.js";
import { defaultSdkConfigDir } from "./sdk-files.js";
import { createSdkTitleSummarizer } from "./session-title.js";
import { createSdkDiscussant } from "./discussion.js";
import { findProvider, loadSettings } from "./settings.js";
import { enabledSkillFilter, SkillSettings } from "./skills.js";
import { configureLimits } from "./status.js";
import { Store } from "./store.js";
import { TerminalManager } from "./terminal.js";
import { TerminalController } from "./terminal-http.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Windows / macOS 上没有 start-all.sh 帮忙 source env：手工 `npm start` 时也把
// 部署生成的 env 补进来，否则 QUBIUS_AUTH / QUBIUS_PROJECTS_FILE 等只会出现在部署任务里。
const manualStartReadsConfigDir = process.platform === "win32" || process.platform === "darwin";
if (manualStartReadsConfigDir && !process.env.QUBIUS_ENV) {
  const envFile = path.join(deployConfigDir(), "env");
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

function configPath(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf("--config");
  const fromArg = index >= 0 ? args[index + 1] : undefined;
  if (fromArg) return path.resolve(fromArg);
  // 新变量优先，旧变量保留兼容。
  const fromEnv = envCompat("QUBIUS_CONFIG");
  if (fromEnv) return path.resolve(fromEnv);
  const local = path.resolve(here, "../../config.yaml");
  // Windows / macOS 的页面部署把配置写在配置目录；仓库根目录没有 config.yaml 时
  // 回落到部署生成的配置，这样不设 QUBIUS_CONFIG 也能手工重启服务。
  if (manualStartReadsConfigDir && !fs.existsSync(local)) {
    const secondary = envCompat("QUBIUS_SECONDARY") === "1";
    const deployed = path.join(deployConfigDir(), secondary ? "config-secondary.yaml" : "config.yaml");
    if (fs.existsSync(deployed)) return deployed;
  }
  return local;
}

const repoRoot = path.resolve(here, "../..");
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
if (authToken) {
  if (config.auth && !config.authToken) {
    console.log(`已启用 API 访问令牌（自动生成：${path.join(config.dataDir, AUTH_TOKEN_FILE)}）`);
  } else {
    console.log("已启用 API 访问令牌");
  }
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
// 会话裁剪/截断上限来自配置；在加载会话前生效，旧文件也会按新上限收敛。
configureLimits(config.limits);
// config.yaml / env 的 maxConcurrent 只作为设置文件的初始默认；之后以设置页保存的值为准。
const settings = { current: loadSettings(config.dataDir, { maxConcurrent: config.maxConcurrent }) };
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
const credential = (providerId: string) => {
  const provider = findProvider(settings.current, providerId);
  if (!provider) throw new Error("这个对话的接口配置已删除，请新开一个对话");
  const apiKey = provider.apiKey.trim();
  if (!apiKey) throw new Error("这个接口配置还没有 API key");
  return { apiKey, baseUrl: provider.baseUrl };
};
const runtime = new Runtime(store, {
  maxConcurrent: settings.current.maxConcurrent,
  approvalTimeoutMinutes: config.approvalTimeoutMinutes,
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
    retentionDays: archiveConfig.retentionDays,
  })
  : undefined;
const sweeper = archive && archiveConfig
  ? new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: archiveConfig.retentionDays,
  })
  : undefined;
if (archive) {
  console.log(`归档目录：${archive.root}（列表保留 ${archiveConfig?.retentionDays ?? 0} 天）`);
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
  fs.writeFileSync(shutdownTokenFile, `${shutdownToken}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(shutdownTokenFile, 0o600);
  } catch {
    // 某些文件系统不支持 chmod；文件仍只在 dataDir 里。
  }
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
  setupRequired,
  skills: { store: skillStore, configDir: claudeConfigDir },
  sdkConfigDir: claudeConfigDir,
  authToken,
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
