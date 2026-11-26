// qubius 页面部署任务（Windows / macOS）的纯函数库。
//
// 这个文件只依赖 Node 内置模块，不能 import 仓库里的依赖：部署任务在
// `npm ci` 之前就可能运行，此时 node_modules 还不存在。
// 逻辑刻意与 deploy/lib.sh + deploy/install.sh 保持一致，方便测试。
import crypto from "node:crypto";
import fs from "node:fs";
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
    approvalTimeoutMinutes = 10,
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
  const status = git(repo, [
    "status", "--porcelain", "--untracked-files=normal", "--",
    "server", "web", "package.json", "package-lock.json",
  ]);
  if ((status.stdout ?? "").trim()) return true;
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(repo, "server", "dist", "build.json"), "utf8"));
  } catch {
    return true;
  }
  if (stamp.dirty === true) return true;
  return stamp.head !== head;
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
  const status = git(repo, [
    "status", "--porcelain", "--untracked-files=normal", "--",
    "server", "web", "package.json", "package-lock.json",
  ]);
  return Boolean((status.stdout ?? "").trim());
}
