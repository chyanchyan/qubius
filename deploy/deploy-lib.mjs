// qubius 页面部署任务（Windows / macOS）的纯函数库。
//
// 这个文件只依赖 Node 内置模块，不能 import 仓库里的依赖：部署任务在
// `npm ci` 之前就可能运行，此时 node_modules 还不存在。
// 逻辑刻意与 deploy/lib.sh + deploy/install.sh 保持一致，方便测试。
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 部署任务状态的时间戳：秒精度 UTC，与 server/src/job-state.ts 一致。 */
export function jobTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 日志里脱敏 user:pass@host。 */
export function redactUrl(text) {
  return String(text).replace(/(:\/\/)[^/@\s]+@/g, "$1***@");
}

/** 去掉 npm/vite 等命令输出的 ANSI 颜色，避免部署页日志里出现转义序列。 */
export function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Windows 上还没有展开的 %VAR%；$HOME/${HOME} 与 shell 侧保持一致。 */
export function expandHome(value, env = process.env) {
  const home = env.HOME || env.USERPROFILE || "";
  let text = String(value);
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(home, text.slice(2));
  text = text
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => env[name] ?? match);
  return text;
}

/**
 * 解析 shell 风格的 env 文件（与 server/src/deploy.ts 的 parseEnvFile 对齐）。
 * 只读取，不执行任何内容。
 */
export function parseEnvFile(text, env = process.env) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    // 引号值允许后面跟行尾注释（shell 里合法且常见）。
    const unwrap = (quote) => {
      if (!value.startsWith(quote)) return false;
      const close = value.lastIndexOf(quote);
      if (close <= 0) return false;
      const rest = value.slice(close + 1).trim();
      if (rest && !rest.startsWith("#")) return false;
      value = value.slice(1, close);
      return true;
    };
    if (unwrap("'")) {
      // shell 单引号里唯一需要还原的是 '\'' 拼接写法。
      value = value.replace(/'\\''/g, "'");
    } else if (unwrap('"')) {
      value = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    values[key] = expandHome(value, env);
  }
  return values;
}

/** YAML 单引号字符串；含控制字符时退回 JSON 双引号（YAML 兼容）。 */
export function yamlString(value) {
  const text = String(value);
  if (CONTROL_RE.test(text)) return JSON.stringify(text);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 生成 config.yaml / config-secondary.yaml 的内容。
 * 结构必须与 deploy/templates/config.yaml.in + install.sh 的渲染结果兼容。
 */
export function renderConfigYaml(options) {
  const {
    role,
    dataDir,
    port,
    publicHost,
    maxConcurrent = 4,
    approvalTimeoutMinutes = 0,
    archiveDir = "",
    archiveRetentionDays = 30,
    archiveInstance = role === "secondary" ? "bak" : "main",
    peerId,
    peerName,
    peerPath,
    projectsText = "",
    secondary = null,
  } = options;

  const lines = [];
  lines.push("# qubius 配置（由部署页生成，不要手工编辑）。");
  lines.push("# 默认保留已有配置；只有渲染结果不同时才备份 *.bak.<时间戳> 后覆盖。");
  lines.push(`role: ${role}`);
  if (secondary) {
    lines.push("secondary:");
    lines.push(`  primaryRepo: ${yamlString(secondary.primaryRepo)}`);
    lines.push(`  primaryRef: ${yamlString(secondary.primaryRef)}`);
    lines.push(`  script: ${yamlString(secondary.script)}`);
    lines.push(`  restart: ${yamlString(secondary.restart)}`);
  }
  lines.push(`listen: 127.0.0.1:${port}`);
  lines.push(`dataDir: ${yamlString(dataDir)}`);
  // publicHost 可能就是 localhost/回环地址，去重后再写，避免重复条目。
  const hosts = ["127.0.0.1", "localhost", "[::1]"];
  if (publicHost && !hosts.includes(publicHost)) hosts.push(publicHost);
  const hostList = hosts
    .map((host) => (/^[A-Za-z0-9.-]+$/.test(host) ? host : yamlString(host)))
    .join(", ");
  lines.push(`allowedHosts: [${hostList}]`);
  lines.push(`maxConcurrent: ${maxConcurrent}`);
  lines.push(`approvalTimeoutMinutes: ${approvalTimeoutMinutes}`);
  lines.push("# limits 可选，不写时使用默认值；也可以用环境变量覆盖（见 README）。");
  if (archiveDir) {
    lines.push("archive:");
    lines.push(`  dir: ${yamlString(archiveDir)}`);
    lines.push(`  retentionDays: ${archiveRetentionDays}`);
    lines.push(`  instance: ${yamlString(archiveInstance)}`);
  }
  const extra = String(projectsText).replace(/\s+$/, "");
  // 对端 checkout 未配置时不写空 path（server 会拒绝空 path），
  // 也不要留下一个空的 projects: 键。
  if (peerPath || extra) {
    lines.push("projects:");
    if (peerPath) {
      lines.push(`  - id: ${yamlString(peerId)}`);
      lines.push(`    name: ${yamlString(peerName)}`);
      lines.push(`    path: ${yamlString(peerPath)}`);
    }
    if (extra) lines.push(extra);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * QUBIUS_PROJECTS_FILE 的内容会直接挂在 projects: 下，缩进必须是
 * 两空格的顶层条目或四空格续行；出错时返回行号。
 */
export function validateProjectsIndent(text) {
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes("\t")) {
      return { ok: false, line: index + 1, reason: "包含制表符；只允许空格缩进" };
    }
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;
    if (/^  - /.test(line)) continue;
    if (/^    [^ ]/.test(line)) continue;
    return {
      ok: false,
      line: index + 1,
      reason: "缩进不合法（只允许空行、注释、两个空格加短横的顶层条目、四空格续行）",
    };
  }
  return { ok: true };
}

/** 把 QUBIUS_GITHUB_REPO 转成 fetch 用的 URL；空或无法识别时返回空串。 */
export function githubRepoPullUrl(value = "") {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return `https://github.com/${trimmed}.git`;
  if (/^(?:https?|ssh|file):\/\/|^git@/.test(trimmed)) return trimmed;
  return "";
}

/**
 * 选择部署前拉取的源，与 deploy/pull-latest.sh 的 resolve_source 保持一致：
 *   - 显式 override（QUBIUS_PULL_REMOTE）优先；
 *   - preferGithub 且存在名为 github 的远端时用它；
 *   - preferGithub 且 origin 指向 github.com 时用 origin；
 *   - preferGithub 且配置了 QUBIUS_GITHUB_REPO 时直接 fetch 该地址；
 *   - 其它情况回落 origin（常见于安装时从私有仓库克隆）。
 * 返回 { kind: "remote" | "url", value }。
 */
export function choosePullSource({
  override = "",
  preferGithub = false,
  hasGithub = false,
  originUrl = "",
  githubRepo = "",
} = {}) {
  if (override) return { kind: "remote", value: override };
  if (preferGithub) {
    if (hasGithub) return { kind: "remote", value: "github" };
    if (/github\.com[:/]/.test(originUrl)) return { kind: "remote", value: "origin" };
    const url = githubRepoPullUrl(githubRepo);
    if (url) return { kind: "url", value: url };
  }
  return { kind: "remote", value: "origin" };
}

/** sha256 摘要；文件不存在时返回 undefined。 */
export function sha256File(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

/** node_modules 缺失或 package-lock.json 变化时需要 npm ci。与 build.sh 一致。 */
export function needsInstall(repo) {
  if (!fs.existsSync(path.join(repo, "node_modules"))) return true;
  const lock = path.join(repo, "package-lock.json");
  const hash = sha256File(lock);
  if (!hash) return true;
  try {
    const stored = fs.readFileSync(path.join(repo, "node_modules", ".qubius-lock-hash"), "utf8").trim();
    return stored !== hash;
  } catch {
    return true;
  }
}

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
}

// 构建 staging 的中间目录不算源码改动；不依赖 .gitignore（staging 单元可能还没落地）。
const BUILD_EXCLUDES = [
  ":(exclude)server/dist.next",
  ":(exclude)server/dist.prev",
  ":(exclude)web/dist.next",
  ":(exclude)web/dist.prev",
  ":(exclude)dist.next",
  ":(exclude)dist.prev",
];

/** 构建输入里是否有未提交改动（未跟踪的新文件也算）。 */
export function buildDirtyStatus(repo) {
  return git(repo, [
    "status", "--porcelain", "--untracked-files=normal", "--",
    "server", "web", "package.json", "package-lock.json",
    ...BUILD_EXCLUDES,
  ]);
}

/** 构建产物缺失、HEAD 变化或工作区有改动时需要重新构建。 */
export function needsBuild(repo) {
  for (const file of ["server/dist/index.js", "web/dist/index.html"]) {
    if (!fs.existsSync(path.join(repo, file))) return true;
  }
  if (!fs.existsSync(path.join(repo, "node_modules"))) return true;
  const head = (git(repo, ["rev-parse", "HEAD"]).stdout ?? "").trim();
  if (!head) return true;
  if (needsInstall(repo)) return true;
  // 只看源码/构建输入；未跟踪的新文件也要算，文档/部署脚本改动不算。
  if (buildDirtyStatus(repo).stdout?.trim()) return true;
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(repo, "server", "dist", "build.json"), "utf8"));
  } catch {
    return true;
  }
  if (stamp.dirty === true) return true;
  return stamp.head !== head;
}

// ── staging / 原子切换 / 回滚（与 deploy/build.sh 的 --stage/--swap/--rollback 对齐）──
// 目录必须和 live 在同一个文件系统里，全部用 rename 完成，不做跨盘复制。
function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** 一个 checkout 的 live/staging/回滚目录。 */
export function distPaths(repo) {
  const server = path.join(repo, "server");
  const web = path.join(repo, "web");
  return {
    server: {
      live: path.join(server, "dist"),
      prev: path.join(server, "dist.prev"),
      next: path.join(server, "dist.next"),
    },
    web: {
      live: path.join(web, "dist"),
      prev: path.join(web, "dist.prev"),
      next: path.join(web, "dist.next"),
    },
  };
}

/** staging 不完整的原因列表；空数组表示可以切换。 */
export function stagingProblems(repo) {
  const paths = distPaths(repo);
  const problems = [];
  for (const [label, required] of [
    ["server/dist.next/index.js", path.join(paths.server.next, "index.js")],
    ["server/dist.next/build.json", path.join(paths.server.next, "build.json")],
    ["web/dist.next/index.html", path.join(paths.web.next, "index.html")],
  ]) {
    if (!fs.existsSync(required)) problems.push(label);
  }
  return problems;
}

/**
 * 把 server/web 的 .next 原子切换为 live：旧 live 先移到 .prev，两侧要么都切换
 * 成功，要么恢复原状并抛错。切换前会校验 staging 的入口文件，拒绝半成品。
 */
export function swapDist(repo) {
  const problems = stagingProblems(repo);
  if (problems.length > 0) {
    throw new Error(`staging 不完整，缺少 ${problems.join("、")}`);
  }
  const paths = distPaths(repo);
  const sides = [paths.server, paths.web];
  // 旧备份先删；此时 live/.next 还没动，删失败只损失上一次的 .prev。
  for (const side of sides) removePath(side.prev);

  let serverPrev = false;
  let webPrev = false;
  let serverLive = false;
  let webLive = false;
  try {
    if (pathExists(paths.server.live)) {
      fs.renameSync(paths.server.live, paths.server.prev);
      serverPrev = true;
    }
    if (pathExists(paths.web.live)) {
      fs.renameSync(paths.web.live, paths.web.prev);
      webPrev = true;
    }
    fs.renameSync(paths.server.next, paths.server.live);
    serverLive = true;
    fs.renameSync(paths.web.next, paths.web.live);
    webLive = true;
  } catch (error) {
    if (webLive) {
      try { fs.renameSync(paths.web.live, paths.web.next); } catch {}
    }
    if (serverLive) {
      try { fs.renameSync(paths.server.live, paths.server.next); } catch {}
    }
    if (webPrev) {
      try { fs.renameSync(paths.web.prev, paths.web.live); } catch {}
    }
    if (serverPrev) {
      try { fs.renameSync(paths.server.prev, paths.server.live); } catch {}
    }
    throw new Error(`切换失败（已尽量恢复原状）：${error instanceof Error ? error.message : error}`);
  }
}

/**
 * 用 .prev 恢复 live：先把失败的 live 改名到临时目录，.prev 恢复成功后再删临时；
 * 任一步失败就还原，避免两侧 live 都缺失。要求两侧都有 .prev。成功后清掉 .next。
 */
export function rollbackDist(repo) {
  const paths = distPaths(repo);
  if (!pathExists(paths.server.prev)) {
    throw new Error("没有 server/dist.prev，无法回滚（未找到上一次的构建）");
  }
  if (!pathExists(paths.web.prev)) {
    throw new Error("没有 web/dist.prev，无法回滚（未找到上一次的构建）");
  }
  const serverTmp = `${paths.server.live}.rollback.${process.pid}`;
  const webTmp = `${paths.web.live}.rollback.${process.pid}`;
  removePath(serverTmp);
  removePath(webTmp);

  let serverMoved = false;
  let webMoved = false;
  let serverRestored = false;
  let webRestored = false;
  try {
    if (pathExists(paths.server.live)) {
      fs.renameSync(paths.server.live, serverTmp);
      serverMoved = true;
    }
    if (pathExists(paths.web.live)) {
      fs.renameSync(paths.web.live, webTmp);
      webMoved = true;
    }
    fs.renameSync(paths.server.prev, paths.server.live);
    serverRestored = true;
    fs.renameSync(paths.web.prev, paths.web.live);
    webRestored = true;
  } catch (error) {
    if (webRestored) {
      try { fs.renameSync(paths.web.live, paths.web.prev); } catch {}
    }
    if (serverRestored) {
      try { fs.renameSync(paths.server.live, paths.server.prev); } catch {}
    }
    if (webMoved) {
      try { fs.renameSync(webTmp, paths.web.live); } catch {}
    }
    if (serverMoved) {
      try { fs.renameSync(serverTmp, paths.server.live); } catch {}
    }
    throw new Error(`回滚失败（已尽量恢复原状）：${error instanceof Error ? error.message : error}`);
  }

  removePath(serverTmp);
  removePath(webTmp);
  // 清掉残留 staging，避免下次 swap 把旧 .next 提升为 live。
  removePath(paths.server.next);
  removePath(paths.web.next);
}

/**
 * 安装依赖前备份 node_modules：先删旧 .prev，再把 node_modules 改名为 .prev。
 * 原来没有 node_modules 时返回 false（没有备份可恢复）。
 */
export function backupNodeModules(repo) {
  const nodeModules = path.join(repo, "node_modules");
  const prev = path.join(repo, "node_modules.prev");
  // node_modules 缺失时保留旧 .prev（可能是上次失败留下的可用依赖）。
  if (!pathExists(nodeModules)) return false;
  removePath(prev);
  fs.renameSync(nodeModules, prev);
  return true;
}

/** 把 node_modules.prev 恢复为 node_modules；没有备份时返回 false。 */
export function restoreNodeModules(repo) {
  const nodeModules = path.join(repo, "node_modules");
  const prev = path.join(repo, "node_modules.prev");
  if (!pathExists(prev)) return false;
  removePath(nodeModules);
  fs.renameSync(prev, nodeModules);
  return true;
}

/**
 * 只在本次部署确实做过备份时才恢复 node_modules。
 * 上一次部署留下的 .prev 可能是旧 lock 的依赖，未备份的部署失败时绝不能拿它
 * 覆盖当前正确的 node_modules。
 */
export function restoreNodeModulesWhenBackedUp(repo, backedUp) {
  if (!backedUp) return false;
  return restoreNodeModules(repo);
}

/** 清理旧 node_modules.prev（一次成功部署/安装后再执行）。 */
export function cleanupNodeModulesPrev(repo) {
  removePath(path.join(repo, "node_modules.prev"));
}

/** staging 目录清理（构建失败或中止时丢弃未切换产物）。 */
export function discardStaging(repo) {
  const paths = distPaths(repo);
  removePath(paths.server.next);
  removePath(paths.web.next);
}

/** 当前 git HEAD；不是 git 仓库时返回空串。 */
export function gitHead(repo) {
  return (git(repo, ["rev-parse", "HEAD"]).stdout ?? "").trim();
}

/**
 * 从 server 的 argv[1]（<repo>/server/dist/index.js）推出 checkout 根目录。
 * 非生产 server（例如 tsx 跑 src/index.ts）返回空串。
 */
export function repoRootFromServerScript(script) {
  const normalized = String(script ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const suffix = "/server/dist/index.js";
  if (!normalized.endsWith(suffix)) return "";
  return path.resolve(normalized.slice(0, -suffix.length) || "/");
}

/** 比较两个路径；Windows 盘符大小写不敏感。 */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 工作区是否有未提交改动（只看构建输入）。 */
export function gitDirty(repo) {
  return Boolean((buildDirtyStatus(repo).stdout ?? "").trim());
}

/** /api/health 里进行中的会话数（排队/运行/等待确认）；字段缺失或非法时返回 0。 */
export function activeSessionsFromHealth(health) {
  const value = health && typeof health === "object" ? health.activeSessions : undefined;
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * 忙碌保护决策（与 deploy/lib.sh 的 qubius_guard_busy 一致）：
 * 返回 { action: "proceed" | "wait" | "fail", waitSeconds, reason }。
 * waitSeconds 为 undefined 表示没有设置 QUBIUS_DEPLOY_WAIT；NaN 表示取值非法。
 */
export function busyDecision({ activeSessions = 0, force = false, waitSeconds } = {}) {
  const active = Number.isInteger(activeSessions) && activeSessions > 0 ? activeSessions : 0;
  if (active <= 0) return { action: "proceed", waitSeconds: null, reason: "" };
  if (force) {
    return {
      action: "proceed",
      waitSeconds: null,
      reason: `有 ${active} 个进行中的会话，QUBIUS_DEPLOY_FORCE 已强制继续（这些会话会被中断）`,
    };
  }
  if (waitSeconds !== undefined) {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0) {
      return {
        action: "fail",
        waitSeconds: null,
        reason: "QUBIUS_DEPLOY_WAIT 必须是整数秒",
      };
    }
    return {
      action: "wait",
      waitSeconds,
      reason: `有 ${active} 个进行中的会话，最多等待 ${waitSeconds} 秒空闲`,
    };
  }
  return {
    action: "fail",
    waitSeconds: null,
    reason: `有 ${active} 个会话进行中，非交互部署已中止（可设 QUBIUS_DEPLOY_FORCE=1 强制重启，或设 QUBIUS_DEPLOY_WAIT=<秒> 等待空闲）`,
  };
}

/**
 * 读取 <dataDir>/.deploy-stamp。结构缺失或损坏时返回 null，调用方据此重启。
 * 字段：head（构建/部署时的 git HEAD）、configHash、envHash。
 */
export function readDeployStamp(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    for (const key of ["head", "configHash", "envHash"]) {
      if (typeof parsed[key] !== "string") return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 原子写入部署 stamp（tmp + rename）。
 * port 记录本次实际使用的端口，供以后改端口时也检查旧端口上的会话。
 */
export function writeDeployStamp(file, { head = "", configHash = "none", envHash = "none", port = "" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ head, configHash, envHash, port: String(port ?? "") })}\n`);
  fs.renameSync(tmp, file);
}

/**
 * 该角色重启前要检查的端口：新端口 + stamp 里上次实际使用的端口 +
 * 父进程已知的旧端口（仅父角色）。按范围校验并去重。
 */
export function deployPorts({ port, stampPort, parentPort, isParent = false } = {}) {
  const result = [];
  const add = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return;
    if (!result.includes(number)) result.push(number);
  };
  add(port);
  add(stampPort);
  if (isParent) add(parentPort);
  return result;
}

/** 局域网代理在无变化部署时的动作：restart / keep / start。 */
export function proxyPlan({ restart = false, pidAlive = false, listening = false } = {}) {
  if (restart) return "restart";
  if (pidAlive || listening) return "keep";
  return "start";
}

// ── 局域网 IPv4 分类与地址选择 ──────────────────────────────────────────────
// 只把私有/链路本地/CGNAT 段当作局域网地址。公网、回环、0.0.0.0、组播和保留段
// 一律不自动选用，避免把公网网卡当成内网入口暴露出去。
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 点分十进制 IPv4 -> 32 位无符号整数；非法地址（含前导零写法）返回 null。 */
function ipv4ToInt(address) {
  const text = String(address).trim();
  const match = IPV4_RE.exec(text);
  if (!match) return null;
  const parts = match.slice(1);
  const octets = parts.map((part) => Number(part));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  // 拒绝 "010.0.0.1" 这类写法：不同工具可能按八进制解析，导致分类和实际不一致。
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) return null;
  const [a, b, c, d] = octets;
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function ipv4InRange(value, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((network & mask) >>> 0);
}

const IPV4_RANGES = [
  ["unspecified", ipv4ToInt("0.0.0.0"), 8],
  ["loopback", ipv4ToInt("127.0.0.0"), 8],
  ["private", ipv4ToInt("10.0.0.0"), 8],
  ["private", ipv4ToInt("172.16.0.0"), 12],
  ["private", ipv4ToInt("192.168.0.0"), 16],
  ["shared", ipv4ToInt("100.64.0.0"), 10],
  ["link-local", ipv4ToInt("169.254.0.0"), 16],
  ["multicast", ipv4ToInt("224.0.0.0"), 4],
  ["reserved", ipv4ToInt("240.0.0.0"), 4],
  ["reserved", ipv4ToInt("192.0.0.0"), 24],
  ["reserved", ipv4ToInt("192.0.2.0"), 24],
  ["reserved", ipv4ToInt("198.18.0.0"), 15],
  ["reserved", ipv4ToInt("198.51.100.0"), 24],
  ["reserved", ipv4ToInt("203.0.113.0"), 24],
];

/**
 * IPv4 分类：invalid / unspecified / loopback / private / shared / link-local /
 * multicast / reserved / public。shared 是 100.64/10（CGNAT），与私有段一样可用作局域网。
 */
export function classifyIPv4(address) {
  const value = ipv4ToInt(address);
  if (value === null) return "invalid";
  for (const [category, network, prefix] of IPV4_RANGES) {
    if (ipv4InRange(value, network, prefix)) return category;
  }
  return "public";
}

const LAN_IPV4_CATEGORIES = new Set(["private", "shared", "link-local"]);

/** 可自动选用的优先级：真实私有段 > CGNAT > 链路本地。 */
const LAN_IPV4_PRIORITY = { private: 0, shared: 1, "link-local": 2 };

/** 是否是可自动选用的局域网 IPv4（私有 / CGNAT / 链路本地）。 */
export function isLanIPv4(address) {
  return LAN_IPV4_CATEGORIES.has(classifyIPv4(address));
}

// RFC 1123 主机名：标签只含字母数字和连字符，不以连字符开头/结尾，可带结尾点。
const HOSTNAME_RE = /^(?=.{1,253}\.?$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/;

/** 显式监听地址：合法 IPv4/IPv6 或主机名；像 IPv4 但越界/前导零的写法直接拒绝。 */
function isValidListenHost(value) {
  const text = String(value).trim();
  if (!text) return false;
  if (net.isIP(text) !== 0) return true;
  // 纯数字点分但 net.isIP 不认（越界、前导零、段数不对），明确报错而不是当主机名。
  if (/^[0-9.]+$/.test(text)) return false;
  return HOSTNAME_RE.test(text);
}

const warnedPublicHosts = new Set();

/**
 * 选择局域网入口地址（lan-proxy 与 deploy-job 共用）：
 * - LAN_PROXY_HOST / QUBIUS_LAN_HOST 显式指定优先；显式给公网 IPv4 时允许但告警。
 * - 否则遍历网卡，只接受私有/CGNAT/链路本地 IPv4，跳过回环、docker 等虚拟网卡；
 *   同时存在多类地址时按 private > shared > link-local 选择。
 * - 找不到可用地址时抛错，提示显式设置，而不是退回公网或回环。
 */
export function lanAddress({
  env = process.env,
  interfaces = os.networkInterfaces(),
  warn = (text) => console.warn(text),
} = {}) {
  const explicit = String(env.LAN_PROXY_HOST ?? "").trim() || String(env.QUBIUS_LAN_HOST ?? "").trim();
  if (explicit) {
    if (!isValidListenHost(explicit)) {
      throw new Error(
        `LAN_PROXY_HOST/QUBIUS_LAN_HOST 不是合法的 IP 或主机名：${explicit}（不能含空格或非法字符）`,
      );
    }
    if (classifyIPv4(explicit) === "public" && !warnedPublicHosts.has(explicit)) {
      warnedPublicHosts.add(explicit);
      warn(
        `警告：LAN_PROXY_HOST/QUBIUS_LAN_HOST 指定了公网地址 ${explicit}。`
        + "局域网入口会用明文 HTTP 传输 Basic 凭据，公网可被嗅探或中间人截获；"
        + "请改用私有地址，或把入口放在 TLS/VPN 之后。",
      );
    }
    return explicit;
  }
  const skip = /^(lo|docker|br-|veth|virbr|tun|tap|cni)/;
  let best = "";
  let bestPriority = Infinity;
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (skip.test(name) || !addrs) continue;
    for (const addr of addrs) {
      // 新版 Node 是 "IPv4"，老版本可能是数字 4。
      const family = typeof addr.family === "string" ? addr.family : addr.family === 4 ? "IPv4" : "";
      if (family !== "IPv4" || addr.internal) continue;
      const priority = LAN_IPV4_PRIORITY[classifyIPv4(addr.address)];
      if (priority === undefined || priority >= bestPriority) continue;
      best = addr.address;
      bestPriority = priority;
    }
  }
  if (best) return best;
  throw new Error(
    "找不到可用的局域网 IPv4 地址（只接受 10/8、172.16/12、192.168/16、100.64/10、169.254/16）；"
    + "请用 LAN_PROXY_HOST 或 QUBIUS_LAN_HOST 显式指定",
  );
}

/**
 * 生成局域网入口子进程的环境：监听地址使用调用方已经解析好的 host，
 * 保证端口探活与子进程实际绑定的是同一个地址。LAN_PROXY_HOST 与
 * QUBIUS_LAN_HOST 同时存在且不同时，也以解析结果为准。
 */
export function proxyChildEnv(env, host) {
  return { ...env, LAN_PROXY_HOST: host };
}

/**
 * 判断某个角色是否需要重启（与 deploy/lib.sh 的 qubius_deploy_should_restart 一致）。
 * 返回 { restart, build, reason }；forceRestart 对应 QUBIUS_DEPLOY_RESTART=1。
 */
export function deployDecision({
  buildNeeded = false,
  configHash,
  envHash,
  stamp,
  head,
  healthy = false,
  forceRestart = false,
} = {}) {
  const build = Boolean(buildNeeded);
  if (forceRestart) {
    return { restart: true, build, reason: "QUBIUS_DEPLOY_RESTART=1，强制重启" };
  }
  if (!healthy) {
    return { restart: true, build, reason: "服务未运行或不健康" };
  }
  if (build) {
    return { restart: true, build: true, reason: "构建产物不是最新" };
  }
  if (!stamp) {
    return { restart: true, build: false, reason: "没有部署 stamp（首次部署？）" };
  }
  if (!head) {
    return { restart: true, build: false, reason: "无法读取 git HEAD" };
  }
  if (stamp.head !== head) {
    return { restart: true, build: false, reason: "git HEAD 变化" };
  }
  if (stamp.configHash !== configHash) {
    return { restart: true, build: false, reason: "config 文件变化" };
  }
  if (stamp.envHash !== envHash) {
    return { restart: true, build: false, reason: "env 文件变化" };
  }
  return { restart: false, build: false, reason: "无变化" };
}
