#!/usr/bin/env node
// qubius 备份：把配置、env、数据目录和可选归档复制到一个自校验的目录快照。
//
// 布局（目录快照，不是 tar，跨平台）：
//   <dest>/config/<配置文件>      config.yaml / config-secondary.yaml / env / projects.yaml / lan-proxy.credentials
//   <dest>/data/<相对路径>        整个 dataDir，默认排除 worktrees/、运行期文件、*.log、node_modules、dist、.git
//   <dest>/archive/<相对路径>     archive.dir 的内容（--without-archive 可排除）
//   <dest>/manifest.json          每个文件的相对路径、大小和 sha256
//   <dest>/manifest.sha256        manifest.json 的 sha256
//
// 备份目录里包含明文密钥（env、auth-token、lan-proxy.credentials、secrets 等），
// 生成后请限制访问并妥善保管。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { expandHome, parseEnvFile } from "./deploy-lib.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_NAME = "manifest.json";
export const MANIFEST_HASH_NAME = "manifest.sha256";
export const BACKUP_FORMAT_VERSION = 1;

/** configDir 里值得备份的固定文件名；不存在的自动跳过。 */
export const CONFIG_FILE_NAMES = [
  "config.yaml",
  "config-secondary.yaml",
  "env",
  "projects.yaml",
  "lan-proxy.credentials",
];

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
const EXCLUDED_FILE_SUFFIX = ".log";
// 运行期状态文件：重启/停止后会重新生成，单独备份反而会让恢复后的实例沿用旧 pid/token。
const EXCLUDED_FILE_NAMES = new Set(["qubius.pid", "lan-proxy.pid", "shutdown-token"]);

export function backupUsage() {
  return [
    "用法：node deploy/backup.mjs [--to DIR] [--online] [--with-worktrees] [--without-archive] [--help]",
    "",
    "把 qubius 的配置、env、数据目录和归档备份到一个目录快照。",
    "",
    "选项：",
    "  --to DIR           指定备份目录（默认 $QUBIUS_BACKUP_DIR/qubius-YYYYmmdd-HHMMSS）",
    "  --online           服务运行中也允许备份（数据可能处于变更中，一致性不保证）",
    "  --with-worktrees   把 dataDir/worktrees 一并备份（默认排除）",
    "  --without-archive  不备份 archive.dir（默认备份）",
    "  -h, --help         显示本帮助",
    "",
    "路径来源（进程环境优先于 env 文件）：",
    "  QUBIUS_REPO_DIR       仓库根，默认脚本所在的 deploy/ 上一级",
    "  QUBIUS_CONFIG_DIR     配置目录，默认 <repo>/.qubius",
    "  QUBIUS_ENV            env 文件；未设置时依次找 <configDir>/env、<repo>/deploy/env",
    "  QUBIUS_SECONDARY      1 表示副实例，使用 config-secondary.yaml",
    "  QUBIUS_DATA_PRIMARY   / QUBIUS_DATA_SECONDARY  数据目录显式覆盖",
    "  QUBIUS_ARCHIVE_DIR    归档目录，未设置时读配置文件的 archive.dir",
    "  QUBIUS_PRIMARY_PORT / QUBIUS_SECONDARY_PORT  健康探测端口，默认 8787 / 8788",
    "  QUBIUS_BACKUP_DIR     默认备份根目录，默认 $HOME/qubius-backups",
    "",
    "数据目录优先级：QUBIUS_DATA_* → 配置文件 dataDir（相对 configDir）→ <configDir>/data。",
    "备份目录含明文密钥，请按敏感数据保管。",
  ].join("\n");
}

/** 把 ~ / $HOME / %VAR% 展开后，相对路径按 base 解析（默认 repoRoot）。 */
export function resolvePath(value, env = process.env, base = REPO_ROOT) {
  const text = expandHome(String(value), env);
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(base, text);
}

/** 仓库根：QUBIUS_REPO_DIR 可覆盖，默认是脚本所在 deploy/ 的上一级（与 deploy/lib.sh 一致）。 */
export function repoRoot(env = process.env) {
  if (env.QUBIUS_REPO_DIR) return path.resolve(expandHome(env.QUBIUS_REPO_DIR, env));
  return REPO_ROOT;
}

let yamlModulePromise;

/** 懒加载 yaml：--help 等不解析配置的路径在缺少 node_modules 时也能运行。 */
function loadYaml() {
  if (!yamlModulePromise) yamlModulePromise = import("yaml");
  return yamlModulePromise;
}

function readEnvValues(envFile, env) {
  if (!envFile || !fs.existsSync(envFile)) return {};
  try {
    return parseEnvFile(fs.readFileSync(envFile, "utf8"), env);
  } catch (error) {
    console.warn(`qubius-backup: 无法解析 env 文件 ${envFile}：${error.message}`);
    return {};
  }
}

function parseBool(value, name) {
  if (value === undefined || value === "") return false;
  switch (String(value).trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} 无效：${value}（用 0/1）`);
  }
}

function resolveConfigPath(value, configDir) {
  const text = String(value).trim();
  if (!text) return "";
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(configDir, text);
}

/**
 * 读取配置文件的 dataDir 和 archive.dir；相对路径按 configDir 解析。
 * 文件不存在、解析失败或字段未配置时返回空串。
 */
export async function readConfigDirs(configFile, configDir) {
  const empty = { dataDir: "", archiveDir: "" };
  if (!fs.existsSync(configFile)) return empty;
  let doc;
  try {
    const { parse } = await loadYaml();
    doc = parse(fs.readFileSync(configFile, "utf8"));
  } catch (error) {
    console.warn(`qubius-backup: 无法解析 ${configFile}：${error.message}`);
    return empty;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return empty;
  const dataDir =
    typeof doc.dataDir === "string" ? resolveConfigPath(doc.dataDir, configDir) : "";
  let archiveDir = "";
  const archive = doc.archive;
  if (archive && typeof archive === "object" && !Array.isArray(archive)) {
    archiveDir =
      typeof archive.dir === "string" ? resolveConfigPath(archive.dir, configDir) : "";
  }
  return { dataDir, archiveDir };
}

/**
 * 解析本次操作涉及的路径。
 *
 * env 文件优先级：进程 QUBIUS_ENV → <configDir>/env → <repo>/deploy/env（取第一个存在的）。
 * 数据目录优先级：QUBIUS_DATA_PRIMARY / QUBIUS_DATA_SECONDARY（显式覆盖）
 *   → 配置文件 dataDir（相对 configDir）→ <configDir>/data。
 * 副实例（QUBIUS_SECONDARY=1）使用 config-secondary.yaml、QUBIUS_DATA_SECONDARY，
 * 默认健康探测端口 8788。
 */
export async function resolveSettings(env = process.env, { envFileOverride } = {}) {
  const root = repoRoot(env);
  const configDir = env.QUBIUS_CONFIG_DIR
    ? resolvePath(env.QUBIUS_CONFIG_DIR, env, root)
    : path.join(root, ".qubius");

  const envCandidates = [];
  if (envFileOverride && fs.existsSync(envFileOverride)) {
    // 恢复时优先用备份里的 env 决定 dataDir/归档/角色，
    // 保证恢复后的数据位置与即将写入的 env 一致。
    envCandidates.push(envFileOverride);
  } else {
    if (env.QUBIUS_ENV) {
      const explicit = resolvePath(env.QUBIUS_ENV, env, root);
      envCandidates.push(explicit);
      if (!fs.existsSync(explicit)) {
        console.warn(
          `qubius-backup: QUBIUS_ENV 指向的文件不存在：${explicit}，继续尝试其他 env 文件`,
        );
      }
    }
    envCandidates.push(path.join(configDir, "env"), path.join(root, "deploy", "env"));
  }
  const envFile = envCandidates.find((candidate) => fs.existsSync(candidate)) || "";
  const fileEnv = readEnvValues(envFile, env);
  const get = (name) => {
    const fromProcess = env[name];
    if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
    const fromFile = fileEnv[name];
    return fromFile !== undefined && fromFile !== "" ? fromFile : undefined;
  };

  const secondary = parseBool(get("QUBIUS_SECONDARY"), "QUBIUS_SECONDARY");
  const role = secondary ? "secondary" : "primary";
  const configFile = path.join(
    configDir,
    secondary ? "config-secondary.yaml" : "config.yaml",
  );
  const configDirs = await readConfigDirs(configFile, configDir);

  const dataVarName = secondary ? "QUBIUS_DATA_SECONDARY" : "QUBIUS_DATA_PRIMARY";
  const dataOverride = get(dataVarName);
  let dataDir;
  let dataSource;
  if (dataOverride) {
    dataDir = resolvePath(dataOverride, env, root);
    dataSource = dataVarName;
  } else if (configDirs.dataDir) {
    dataDir = configDirs.dataDir;
    dataSource = `${path.basename(configFile)} dataDir`;
  } else {
    dataDir = path.join(configDir, "data");
    dataSource = "默认 <configDir>/data";
  }

  let archiveDir = "";
  let archiveSource = "";
  const archiveRaw = get("QUBIUS_ARCHIVE_DIR");
  if (archiveRaw) {
    archiveDir = resolvePath(archiveRaw, env, root);
    archiveSource = "QUBIUS_ARCHIVE_DIR";
  } else if (configDirs.archiveDir) {
    archiveDir = configDirs.archiveDir;
    archiveSource = `${path.basename(configFile)} archive.dir`;
  }

  const portVarName = secondary ? "QUBIUS_SECONDARY_PORT" : "QUBIUS_PRIMARY_PORT";
  const defaultPort = secondary ? 8788 : 8787;
  const rawPort = get(portVarName) || String(defaultPort);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${portVarName} 无效：${rawPort}`);
  }

  return {
    repoRoot: root,
    role,
    secondary,
    configDir,
    configFile,
    envFile,
    envFileExists: Boolean(envFile) && fs.existsSync(envFile),
    fileEnv,
    dataDir,
    dataSource,
    archiveDir,
    archiveSource,
    port,
  };
}

/** 探测本机健康接口；任何 HTTP 响应都视为服务在运行。 */
export async function serviceReachable(port, timeoutMs = 800) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function textSha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** 本地时间戳：YYYYmmdd-HHMMSS。 */
export function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 同目录下找一个不存在的名字（存在时追加 -1、-2…）。 */
export function uniquePath(base) {
  let candidate = base;
  let index = 1;
  while (fs.existsSync(candidate)) candidate = `${base}-${index++}`;
  return candidate;
}

/** child 是否严格位于 parent 内（不含相等）。 */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** child 是否等于 parent 或位于其内。 */
export function isSameOrInside(parent, child) {
  return path.resolve(parent) === path.resolve(child) || isInside(parent, child);
}

/**
 * 递归列出目录下的普通文件，返回相对 root 的 POSIX 路径。
 * 排除 node_modules / dist / .git 目录、运行期文件、*.log；dataDir 顶层 worktrees 可按需保留。
 * 符号链接直接跳过并给出警告，避免备份把链接目标带进来或形成环。
 */
export function walkFiles(root, { excludeWorktrees = false } = {}) {
  const files = [];
  const warnings = [];
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return { files, warnings };
  }
  if (!stat.isDirectory()) {
    warnings.push(`不是目录，已跳过：${root}`);
    return { files, warnings };
  }
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      warnings.push(`无法读取 ${abs}：${error.message}`);
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        warnings.push(`跳过符号链接：${path.join(root, childRel)}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        if (excludeWorktrees && rel === "" && entry.name === "worktrees") continue;
        stack.push(childRel);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(EXCLUDED_FILE_SUFFIX)) continue;
        if (EXCLUDED_FILE_NAMES.has(entry.name)) continue;
        files.push(childRel);
      }
    }
  }
  files.sort();
  return { files, warnings };
}

/**
 * 收集要备份的文件：[{ backupPath, sourcePath }]。
 * config 只取固定文件名；data / archive 取目录内全部（应用排除规则）。
 */
export function collectSources(settings, { withWorktrees = false, withoutArchive = false } = {}) {
  const sources = [];
  const warnings = [];

  const configDir = settings.configDir;
  if (fs.existsSync(configDir) && fs.statSync(configDir).isDirectory()) {
    for (const name of CONFIG_FILE_NAMES) {
      // env 走下面实际生效的 envFile，避免 QUBIUS_ENV / deploy/env 布局漏备份。
      if (name === "env") continue;
      const abs = path.join(configDir, name);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        sources.push({ backupPath: `config/${name}`, sourcePath: abs });
      }
    }
  } else {
    warnings.push(`配置目录不存在，跳过来自配置目录的文件：${configDir}`);
  }

  // 实际被读取的 env 文件可能不在 configDir 下（旧布局 <repo>/deploy/env 或显式 QUBIUS_ENV）。
  // 统一以 config/env 收进快照，恢复时写回当前解析出的 env 路径。
  if (settings.envFileExists && settings.envFile) {
    sources.push({ backupPath: "config/env", sourcePath: settings.envFile });
  } else {
    warnings.push("没有找到 env 文件，备份不含 env");
  }

  const dataWalk = walkFiles(settings.dataDir, { excludeWorktrees: !withWorktrees });
  warnings.push(...dataWalk.warnings);
  if (dataWalk.files.length === 0) {
    warnings.push(`数据目录为空或不存在：${settings.dataDir}`);
  }
  for (const rel of dataWalk.files) {
    sources.push({ backupPath: `data/${rel}`, sourcePath: path.join(settings.dataDir, rel) });
  }

  let includeArchive = false;
  if (!withoutArchive && settings.archiveDir) {
    // config 只按固定文件名备份，归档放在 configDir 下不会重复；
    // 但归档与递归备份的 dataDir 重叠时必须跳过，避免同一批文件被备份两次。
    if (
      path.resolve(settings.archiveDir) === path.resolve(settings.configDir) ||
      isSameOrInside(settings.dataDir, settings.archiveDir) ||
      isSameOrInside(settings.archiveDir, settings.dataDir)
    ) {
      warnings.push(
        `归档目录与数据目录重叠，跳过归档以避免重复备份：${settings.archiveDir}`,
      );
    } else {
      const archiveWalk = walkFiles(settings.archiveDir);
      warnings.push(...archiveWalk.warnings);
      if (archiveWalk.files.length > 0) {
        includeArchive = true;
        for (const rel of archiveWalk.files) {
          sources.push({
            backupPath: `archive/${rel}`,
            sourcePath: path.join(settings.archiveDir, rel),
          });
        }
      } else {
        warnings.push(`归档目录为空或不存在：${settings.archiveDir}`);
      }
    }
  }

  return { sources, warnings, includeArchive };
}

/** 把快照里的目录（含各层子目录）都收紧到 0700；不支持 POSIX 权限的平台忽略。 */
function chmodDirs0700(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Windows 等平台可能不支持 POSIX 权限，忽略。
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function defaultBackupRoot(settings, env) {
  const fromEnv =
    env.QUBIUS_BACKUP_DIR && env.QUBIUS_BACKUP_DIR !== ""
      ? env.QUBIUS_BACKUP_DIR
      : settings.fileEnv.QUBIUS_BACKUP_DIR;
  if (fromEnv && fromEnv !== "") return resolvePath(fromEnv, env, settings.repoRoot);
  const home = env.HOME || env.USERPROFILE || "";
  if (!home) throw new Error("无法确定 HOME，请用 --to 指定备份目录");
  return path.join(home, "qubius-backups");
}

/**
 * 执行备份。返回进程退出码；失败时抛出错误由调用方打印。
 */
export async function runBackup(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        to: { type: "string" },
        online: { type: "boolean", default: false },
        "with-worktrees": { type: "boolean", default: false },
        "without-archive": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`qubius-backup: ${error.message}`);
    console.error(backupUsage());
    return 1;
  }

  if (parsed.values.help) {
    console.log(backupUsage());
    return 0;
  }

  const settings = await resolveSettings(env);
  const online = parsed.values.online;

  const reachable = await serviceReachable(settings.port);
  if (reachable && !online) {
    console.error(
      `qubius-backup: 服务正在运行（127.0.0.1:${settings.port}）。请先停止服务（make stop），或加 --online 接受可能不一致的备份。`,
    );
    return 1;
  }

  let dest;
  if (parsed.values.to) {
    dest = resolvePath(parsed.values.to, env, process.cwd());
  } else {
    dest = uniquePath(path.join(defaultBackupRoot(settings, env), `qubius-${timestamp()}`));
  }

  const sourceRoots = [settings.configDir, settings.dataDir, settings.archiveDir].filter(Boolean);
  for (const root of sourceRoots) {
    if (isSameOrInside(root, dest)) {
      throw new Error(`备份目标不能位于源目录内：${dest}`);
    }
  }
  if (fs.existsSync(dest)) {
    throw new Error(`备份目标已存在，请换一个目录：${dest}`);
  }

  const { sources, warnings, includeArchive } = collectSources(settings, {
    withWorktrees: parsed.values["with-worktrees"],
    withoutArchive: parsed.values["without-archive"],
  });
  for (const warning of warnings) console.warn(`qubius-backup: ${warning}`);

  if (sources.length === 0) {
    throw new Error("没有找到可备份的配置或数据，请检查 QUBIUS_CONFIG_DIR / 数据目录配置");
  }

  console.log("qubius 备份");
  console.log(`  角色：${settings.role}`);
  console.log(`  配置文件：${settings.configFile}`);
  console.log(`  配置目录：${settings.configDir}`);
  console.log(
    `  env 文件：${settings.envFile || "（未找到，忽略）"}${settings.envFileExists ? "" : "（不存在，忽略）"}`,
  );
  console.log(`  数据目录：${settings.dataDir}（来源：${settings.dataSource}）`);
  console.log(
    `  归档目录：${
      settings.archiveDir
        ? `${settings.archiveDir}${includeArchive ? "" : "（未包含）"}`
        : "（未配置，跳过）"
    }`,
  );
  console.log(`  服务状态：${reachable ? "运行中（--online，数据可能处于变更中）" : "未运行"}`);
  console.log(`  worktrees：${parsed.values["with-worktrees"] ? "包含" : "排除"}`);
  console.log(`  输出目录：${dest}`);
  console.log(
    `qubius-backup: 备份包含明文密钥（env、auth-token、lan-proxy.credentials、secrets 等），请妥善保管。`,
  );

  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dest, 0o700);
  } catch {
    // Windows 等平台可能不支持 POSIX 权限，忽略。
  }

  try {
    const files = [];
    let totalBytes = 0;
    for (const source of sources) {
      const target = path.join(dest, ...source.backupPath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const inputHash = await fileSha256(source.sourcePath);
      fs.cpSync(source.sourcePath, target, { dereference: true });
      const outputHash = await fileSha256(target);
      if (inputHash !== outputHash) {
        throw new Error(`复制后哈希不一致：${source.backupPath}`);
      }
      const size = fs.statSync(target).size;
      files.push({ path: source.backupPath, size, sha256: outputHash });
      totalBytes += size;
    }

    // 快照里的目录（config/data/archive 及其子目录）一并收紧到 0700。
    chmodDirs0700(dest);

    const manifest = {
      tool: "qubius-backup",
      version: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      role: settings.role,
      online,
      includeWorktrees: Boolean(parsed.values["with-worktrees"]),
      includeArchive,
      source: {
        repoRoot: settings.repoRoot,
        configDir: settings.configDir,
        configFile: settings.configFile,
        envFile: settings.envFileExists ? settings.envFile : "",
        dataDir: settings.dataDir,
        dataSource: settings.dataSource,
        archiveDir: includeArchive ? settings.archiveDir : "",
      },
      totals: { files: files.length, bytes: totalBytes },
      files,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(dest, MANIFEST_NAME), manifestText);
    fs.writeFileSync(
      path.join(dest, MANIFEST_HASH_NAME),
      `${textSha256(manifestText)}  ${MANIFEST_NAME}\n`,
    );

    // 写完清单后再整体核对一遍，确保清单与落盘内容一致。
    for (const entry of manifest.files) {
      const abs = path.join(dest, ...entry.path.split("/"));
      const hash = await fileSha256(abs);
      if (hash !== entry.sha256 || fs.statSync(abs).size !== entry.size) {
        throw new Error(`备份校验失败：${entry.path}`);
      }
    }

    console.log(
      `备份完成：${dest}（${manifest.totals.files} 个文件，${humanBytes(manifest.totals.bytes)}）`,
    );
    console.log(`清单：${path.join(dest, MANIFEST_NAME)} / ${MANIFEST_HASH_NAME}`);
    return 0;
  } catch (error) {
    console.error(`qubius-backup: 备份失败，清理半成品目录 ${dest}`);
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      // 清理失败也保留原始错误。
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runBackup()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`qubius-backup: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
