#!/usr/bin/env node
// qubius 恢复：从 deploy/backup.mjs 生成的目录快照恢复配置、数据和归档。
//
// 安全约束：
//   - 先校验 manifest.sha256 和每个文件的 sha256，任何不一致都拒绝恢复；
//   - 拒绝绝对路径和 .. 路径穿越，只允许 config/、data/、archive/ 三个前缀；
//   - 默认要求服务未运行（健康探测），--force 可覆盖；
//   - 不删除旧数据：先把将被替换的 configDir/dataDir/archiveDir 改名成
//     <path>.pre-restore.<时间戳>，失败时尽量回滚；
//   - 不自动启动或重启服务。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  MANIFEST_HASH_NAME,
  MANIFEST_NAME,
  fileSha256,
  isSameOrInside,
  resolvePath,
  resolveSettings,
  serviceReachable,
  textSha256,
  timestamp,
  uniquePath,
} from "./backup.mjs";

const PREFIX_ROOTS = new Set(["config", "data", "archive"]);

export function restoreUsage() {
  return [
    "用法：node deploy/restore.mjs <backup-dir> [--force] [--help]",
    "",
    "从 deploy/backup.mjs 生成的目录快照恢复配置、数据和归档。",
    "",
    "选项：",
    "  --force   服务运行中也允许恢复（请自行承担一致性风险）",
    "  -h, --help 显示本帮助",
    "",
    "恢复流程：",
    "  1. 校验 manifest.sha256 与每个文件的 sha256；",
    "  2. 默认要求服务未运行（127.0.0.1:$QUBIUS_PRIMARY_PORT/api/health）；",
    "  3. 把当前 configDir/dataDir/archiveDir 改名为 <path>.pre-restore.<时间戳>；",
    "  4. 把备份内容复制回去；失败时尽量回滚。",
    "",
    "路径解析（含副实例 QUBIUS_SECONDARY=1、config dataDir、deploy/env 兜底）与",
    "deploy/backup.mjs 完全一致。恢复完成后需要手工重启服务（make restart）。",
  ].join("\n");
}

/** 把路径拆成安全的相对段；拒绝绝对路径、盘符、.. 和空段。 */
export function safeSegments(rel) {
  if (typeof rel !== "string" || rel === "") throw new Error("清单里有空文件路径");
  if (rel.includes("\0")) throw new Error(`文件路径包含 NUL：${JSON.stringify(rel)}`);
  if (rel.startsWith("/") || rel.startsWith("\\")) throw new Error(`文件路径不能是绝对路径：${rel}`);
  if (/^[A-Za-z]:/.test(rel)) throw new Error(`文件路径不能带盘符：${rel}`);
  const normalized = rel.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`文件路径包含非法段：${rel}`);
    }
    if (segment.includes("\0")) throw new Error(`文件路径包含 NUL：${rel}`);
  }
  if (!PREFIX_ROOTS.has(segments[0])) {
    throw new Error(`不支持的文件前缀（只允许 config/、data/、archive/）：${rel}`);
  }
  if (segments.length < 2) throw new Error(`文件路径缺少文件名：${rel}`);
  return segments;
}

function validateManifest(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("manifest.json 不是对象");
  }
  if (doc.version !== 1) {
    throw new Error(`不支持的备份格式版本：${doc.version}`);
  }
  if (!Array.isArray(doc.files)) throw new Error("manifest.json 缺少 files 列表");
  const seen = new Set();
  for (const entry of doc.files) {
    if (!entry || typeof entry !== "object") throw new Error("manifest.files 条目不是对象");
    const segments = safeSegments(entry.path);
    const key = segments.join("/");
    if (seen.has(key)) throw new Error(`manifest.files 有重复路径：${entry.path}`);
    seen.add(key);
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      throw new Error(`文件大小无效：${entry.path}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`文件哈希无效：${entry.path}`);
    }
  }
  return doc;
}

/** 读取并校验清单：manifest.sha256 必须与 manifest.json 一致。 */
export function readManifest(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  const hashPath = path.join(backupDir, MANIFEST_HASH_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`找不到 ${MANIFEST_NAME}：${backupDir} 不是本工具生成的备份目录`);
  }
  if (!fs.existsSync(hashPath)) {
    throw new Error(`找不到 ${MANIFEST_HASH_NAME}，无法确认备份是否被篡改`);
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  const expected = fs.readFileSync(hashPath, "utf8").trim().split(/\s+/)[0];
  const actual = textSha256(raw);
  if (expected !== actual) {
    throw new Error("manifest.sha256 与 manifest.json 不一致（备份可能被篡改或损坏）");
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest.json 不是合法 JSON：${error.message}`);
  }
  return validateManifest(doc);
}

/** 校验备份里的每个文件：类型、大小、sha256。 */
export async function verifyBackupFiles(backupDir, manifest) {
  const verified = [];
  for (const entry of manifest.files) {
    const segments = safeSegments(entry.path);
    const abs = path.join(backupDir, ...segments);
    if (!isSameOrInside(backupDir, abs)) {
      throw new Error(`文件路径越界：${entry.path}`);
    }
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      throw new Error(`备份缺少文件：${entry.path}`);
    }
    if (!stat.isFile()) throw new Error(`备份里的不是普通文件：${entry.path}`);
    if (stat.size !== entry.size) {
      throw new Error(`文件大小不一致：${entry.path}（清单 ${entry.size}，实际 ${stat.size}）`);
    }
    const hash = await fileSha256(abs);
    if (hash !== entry.sha256) {
      throw new Error(`文件哈希不一致（备份可能被篡改或损坏）：${entry.path}`);
    }
    verified.push({ ...entry, segments, source: abs });
  }
  return verified;
}

/**
 * 把将要被替换的目录改名保存。父目录先处理，嵌套在已保存目录里的子目录跳过
 *（旧数据已经随父目录一起保存）。
 */
function moveExistingRoots(roots, ts) {
  const moved = [];
  const ordered = [...new Set(roots)].sort((a, b) => a.length - b.length);
  for (const root of ordered) {
    if (moved.some((item) => isSameOrInside(item.from, root))) continue;
    if (!fs.existsSync(root)) continue;
    const destination = uniquePath(`${root}.pre-restore.${ts}`);
    try {
      fs.renameSync(root, destination);
    } catch (error) {
      // 中途失败时把已经移动的目录改回去，避免半完成状态。
      rollback(moved, []);
      throw error;
    }
    moved.push({ from: root, to: destination });
  }
  return moved;
}

/**
 * 备份里的 config/env 应该写回哪个路径：当前的 env 解析链里已存在的位置
 *（旧布局 <repo>/deploy/env、显式 QUBIUS_ENV），否则落到 <configDir>/env。
 * 绝不能写回备份目录内部。
 */
function resolveEnvTarget(env, settings, backupDir) {
  const candidates = [];
  if (env.QUBIUS_ENV) {
    candidates.push(resolvePath(env.QUBIUS_ENV, env, settings.repoRoot));
  }
  candidates.push(
    path.join(settings.configDir, "env"),
    path.join(settings.repoRoot, "deploy", "env"),
  );
  const existing = candidates.find(
    (candidate) => fs.existsSync(candidate) && !isSameOrInside(backupDir, candidate),
  );
  return existing || path.join(settings.configDir, "env");
}

function rollback(moved, rootsThatDidNotExist) {
  for (const root of rootsThatDidNotExist) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 继续尽量回滚。
    }
  }
  for (const item of moved) {
    try {
      fs.rmSync(item.from, { recursive: true, force: true });
    } catch {
      // 继续尽量回滚。
    }
  }
  for (const item of [...moved].reverse()) {
    try {
      fs.renameSync(item.to, item.from);
    } catch {
      // 无法回滚时保留 .pre-restore.* 目录内容。
    }
  }
}

const SENSITIVE_BASENAMES = new Set([
  "env",
  "auth-token",
  "lan-proxy.credentials",
  "secrets.json",
]);

/** 恢复后需要收紧到 0600 的文件：配置目录全部（config.yaml 可能含 authToken）、
 *  secrets 目录以及常见的密钥文件。 */
export function isSensitiveSegments(segments) {
  if (segments[0] === "config") return true;
  if (segments.includes("secrets")) return true;
  return SENSITIVE_BASENAMES.has(segments[segments.length - 1]);
}

/**
 * 恢复的核心步骤：移动旧目录 → 复制 → 再校验，失败回滚。
 * copyFile / hashFile 可注入，便于测试复制或校验失败时的回滚路径。
 * files 为 verifyBackupFiles 的返回值；targets 形如 { config, data, archive }。
 * fileTargets 可覆盖单个文件的落点（例如把 config/env 写到实际生效的 env 路径）。
 */
export async function applyRestore({
  files,
  targets,
  fileTargets = {},
  copyFile = fs.cpSync,
  hashFile = fileSha256,
  ts = timestamp(),
}) {
  const isOverridden = (file) => Object.prototype.hasOwnProperty.call(fileTargets, file.path);
  const rootFor = (file) =>
    isOverridden(file) ? fileTargets[file.path] : targets[file.segments[0]];
  const destinationFor = (file) =>
    isOverridden(file)
      ? fileTargets[file.path]
      : path.join(targets[file.segments[0]], ...file.segments.slice(1));

  const rootsToMove = [...new Set(files.map(rootFor).filter(Boolean))];
  const rootsThatDidNotExist = rootsToMove.filter((root) => !fs.existsSync(root));
  const moved = moveExistingRoots(rootsToMove, ts);
  try {
    for (const file of files) {
      const destination = destinationFor(file);
      if (!destination) throw new Error(`恢复目标未配置：${file.path}`);
      const root = rootFor(file);
      if (!isOverridden(file) && !isSameOrInside(root, destination)) {
        throw new Error(`目标路径越界：${file.path}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      copyFile(file.source, destination, { dereference: true });
      // 不依赖 umask：敏感文件恢复后收紧到 0600。
      if (isSensitiveSegments(file.segments)) {
        try {
          fs.chmodSync(destination, 0o600);
        } catch {
          // Windows 等平台可能不支持 POSIX 权限，忽略。
        }
      }
    }

    // 恢复后再核对一次，确保落盘内容与清单一致。
    for (const file of files) {
      const destination = destinationFor(file);
      const hash = await hashFile(destination);
      if (hash !== file.sha256) throw new Error(`恢复后哈希不一致：${file.path}`);
    }
  } catch (error) {
    rollback(moved, rootsThatDidNotExist);
    throw error;
  }
  return { moved, rootsThatDidNotExist };
}

export async function runRestore(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`qubius-restore: ${error.message}`);
    console.error(restoreUsage());
    return 1;
  }

  if (parsed.values.help) {
    console.log(restoreUsage());
    return 0;
  }

  const positional = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !String(positional ?? "").trim()) {
    console.error("qubius-restore: 需要一个备份目录参数（例如 make restore BACKUP=<目录>）");
    console.error(restoreUsage());
    return 1;
  }

  const backupDir = resolvePath(positional, env, process.cwd());
  if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) {
    console.error(`qubius-restore: 备份目录不存在：${backupDir}`);
    return 1;
  }

  const manifest = readManifest(backupDir);
  const files = await verifyBackupFiles(backupDir, manifest);
  const snapshotEnv = files.find((file) => file.path === "config/env");

  // 用备份里的 env 决定 role/dataDir/archive/端口，避免灾备恢复时 env 尚未落盘
  // 导致数据恢复到默认路径、与恢复后的 env 不一致。
  const settings = await resolveSettings(env, { envFileOverride: snapshotEnv?.source });
  const prefixes = new Set(files.map((file) => file.segments[0]));
  if (prefixes.has("archive") && !settings.archiveDir) {
    console.error(
      "qubius-restore: 备份包含归档，但当前未配置 archive.dir / QUBIUS_ARCHIVE_DIR。请先在配置文件或 env 中配置归档目录后再恢复。",
    );
    return 1;
  }

  if (!parsed.values.force) {
    const reachable = await serviceReachable(settings.port);
    if (reachable) {
      console.error(
        `qubius-restore: 服务正在运行（127.0.0.1:${settings.port}）。请先停止服务（make stop），或加 --force 强制恢复。`,
      );
      return 1;
    }
  }

  const targets = {
    config: settings.configDir,
    data: settings.dataDir,
    ...(prefixes.has("archive") ? { archive: settings.archiveDir } : {}),
  };

  // 快照里的 config/env 写回当前实际解析出的 env 路径（旧布局可能是
  // <repo>/deploy/env，显式 QUBIUS_ENV 可能是任意路径）；没有 env 时落到
  // <configDir>/env，后续解析会优先使用它。
  const fileTargets = {};
  if (snapshotEnv) {
    fileTargets["config/env"] = resolveEnvTarget(env, settings, backupDir);
  }

  // 备份目录不能位于将被移动的目标目录里（否则移动后源文件路径失效），
  // 也不能把目标目录恢复到备份目录内部。
  for (const root of Object.values(targets)) {
    if (isSameOrInside(root, backupDir) || isSameOrInside(backupDir, root)) {
      console.error(
        `qubius-restore: 备份目录不能与配置/数据/归档目录重叠：${backupDir} <-> ${root}`,
      );
      return 1;
    }
  }

  console.log("qubius 恢复");
  console.log(`  备份目录：${backupDir}`);
  console.log(`  创建时间：${manifest.createdAt || "未知"}`);
  console.log(`  角色：${manifest.role || settings.role}`);
  console.log(`  配置文件：${settings.configFile}`);
  console.log(`  配置目录：${settings.configDir}`);
  console.log(`  数据目录：${settings.dataDir}（来源：${settings.dataSource}）`);
  if (fileTargets["config/env"]) {
    console.log(`  env 文件：${fileTargets["config/env"]}`);
  }
  console.log(
    `  归档目录：${prefixes.has("archive") ? settings.archiveDir : "（备份不含归档，跳过）"}`,
  );
  console.log(`  文件数量：${files.length}`);
  console.log(`  服务状态：${parsed.values.force ? "未检查（--force）" : "未运行"}`);

  let result;
  try {
    result = await applyRestore({ files, targets, fileTargets });
  } catch (error) {
    console.error("qubius-restore: 恢复失败，已尝试回滚");
    throw error;
  }

  console.log(`恢复完成：${files.length} 个文件`);
  console.log("请重启服务使配置和数据生效：make restart");
  if (result.moved.length === 0) {
    console.log("旧数据位置：恢复前这些目录不存在，没有旧数据需要保留。");
  } else {
    console.log("旧数据位置（未删除，确认无误后可自行清理）：");
    for (const item of result.moved) console.log(`  ${item.to}`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runRestore()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`qubius-restore: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
