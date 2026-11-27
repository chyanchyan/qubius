import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeFileAtomic } from "./atomic-file.js";

/**
 * 旧版默认配置目录的扫描与迁移。
 *
 * 新版把配置收敛到 `<checkout>/.qubius/`，旧版本默认放在 XDG 配置目录或
 * Windows 的 %APPDATA%。升级到新布局后旧配置不会自动生效，这里负责找到
 * 它们，并在用户确认后把配置文件和凭据搬到当前配置目录。
 *
 * 迁移范围只限配置文件：数据目录、归档目录保持原路径不动（迁移时会把
 * config.yaml 里的相对路径改成绝对路径，避免换基准目录后指到别处）。
 */

/** 旧版配置目录里值得迁移的文件；data/、日志、备份等一律不动。 */
export const LEGACY_CONFIG_FILES = [
  "config.yaml",
  "config-secondary.yaml",
  "env",
  "projects.yaml",
  "lan-proxy.credentials",
  "secondary.sh",
  "run.sh",
] as const;

/** 迁移时改写到新配置目录的 env 键：旧文件里通常还写死着旧目录。 */
const ENV_RELOCATED_KEYS = new Set(["QUBIUS_CONFIG_DIR", "QUBIUS_ENV"]);

/** 更早的变量前缀；迁移时统一改成 QUBIUS_，否则新版本不读取。 */
const LEGACY_ENV_PREFIXES: readonly [string, string][] = [
  ["REMOTE_CODER_", "QUBIUS_"],
  ["QODER_", "QUBIUS_"],
];

const IGNORED_FILE = ".legacy-config-ignored.json";
const CONFIG_NAMES = new Set(["config.yaml", "config-secondary.yaml"]);

export interface LegacyConfigFileInfo {
  name: string;
  size: number;
}

/** 一个检测到的旧配置目录。 */
export interface LegacyConfigCandidate {
  /** 旧配置目录的绝对路径。 */
  path: string;
  /** 目录来源，例如「Windows APPDATA」「XDG 配置目录」。 */
  origin: string;
  /** 目录里可迁移的文件。 */
  files: LegacyConfigFileInfo[];
  /** 是否带 config.yaml / config-secondary.yaml。 */
  hasConfig: boolean;
  /** 当前配置目录已有同名但内容不同的文件；非空时不能直接迁移。 */
  conflicts: string[];
}

export interface ScanLegacyOptions {
  /** 迁移目标：当前实际使用的配置目录。 */
  currentConfigDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 连已忽略的目录一起返回（校验迁移请求时用）。 */
  includeIgnored?: boolean;
}

export interface LegacyMigrationResult {
  path: string;
  /** 已写入当前配置目录的文件。 */
  copied: string[];
  /** 当前目录已有相同内容、不需要重写的文件。 */
  unchanged: string[];
  /** 校验通过后从旧目录删掉的文件。 */
  deleted: string[];
  /** 旧目录里没有迁移（data/、日志等），因此保留下来的条目。 */
  leftovers: string[];
  removedDir: boolean;
}

export class LegacyMigrationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function pathKey(target: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(target);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** child 是否等于 parent 或位于 parent 之内。 */
function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = pathKey(child, platform);
  const p = pathKey(parent, platform);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function overlap(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isWithin(a, b, platform) || isWithin(b, a, platform);
}

/** 旧版本可能用过的默认配置目录（按平台）。 */
function legacyDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { path: string; origin: string }[] {
  const names = ["qubius", "qoder", "remote-coder"];
  const dirs: { path: string; origin: string }[] = [];
  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA);
    if (!appData) return dirs;
    for (const name of names) {
      dirs.push({ path: path.join(appData, name), origin: "Windows APPDATA" });
    }
    return dirs;
  }
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE) ?? os.homedir();
  const xdg = nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config");
  for (const name of names) {
    dirs.push({ path: path.join(xdg, name), origin: "XDG 配置目录" });
  }
  return dirs;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 把旧配置里的相对路径改成基于旧目录的绝对路径。
 *
 * 迁移只搬配置文件，`dataDir: ./data` 这类相对路径换到新配置目录后会被
 * 解析成另一个目录，看起来像会话全丢了。没有解析出变化时原样返回，
 * 保留手工维护的注释和格式。
 */
function rewriteYamlPaths(
  text: string,
  legacyDir: string,
  mutate: (document: Record<string, unknown>) => boolean,
): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    // 内容不合法时交给 loadConfig 去报错，迁移保持原样。
    return text;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
  if (!mutate(parsed as Record<string, unknown>)) return text;
  return `# 从旧配置目录迁移，相对路径已改写为绝对路径。\n${stringifyYaml(parsed)}`;
}

function absolutize(value: unknown, baseDir: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return path.resolve(baseDir, value.trim());
}

/** config.yaml：dataDir、archive.dir、secondary 路径、projects[].path。 */
export function rewriteConfigPaths(text: string, legacyDir: string): string {
  return rewriteYamlPaths(text, legacyDir, (record) => {
    let changed = false;
    // 没写 dataDir 时默认 ./data；迁移后基准目录变了，必须显式写死。
    const rawDataDir = typeof record.dataDir === "string" ? record.dataDir.trim() : "";
    const dataDir = rawDataDir ? path.resolve(legacyDir, rawDataDir) : path.join(legacyDir, "data");
    if (record.dataDir !== dataDir) {
      record.dataDir = dataDir;
      changed = true;
    }
    if (record.archive && typeof record.archive === "object" && !Array.isArray(record.archive)) {
      const archive = record.archive as Record<string, unknown>;
      const dir = absolutize(archive.dir, legacyDir);
      if (dir !== undefined && archive.dir !== dir) {
        archive.dir = dir;
        changed = true;
      }
    }
    if (record.secondary && typeof record.secondary === "object" && !Array.isArray(record.secondary)) {
      const secondary = record.secondary as Record<string, unknown>;
      for (const key of ["primaryRepo", "script", "restart"]) {
        const abs = absolutize(secondary[key], legacyDir);
        if (abs !== undefined && secondary[key] !== abs) {
          secondary[key] = abs;
          changed = true;
        }
      }
    }
    if (Array.isArray(record.projects)) {
      for (const project of record.projects) {
        if (!project || typeof project !== "object" || Array.isArray(project)) continue;
        const entry = project as Record<string, unknown>;
        const abs = absolutize(entry.path, legacyDir);
        if (abs !== undefined && entry.path !== abs) {
          entry.path = abs;
          changed = true;
        }
      }
    }
    return changed;
  });
}

/** projects.yaml：顶层是项目列表，path 同样按配置目录解析。 */
export function rewriteProjectsPaths(text: string, legacyDir: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return text;
  }
  if (!Array.isArray(parsed)) return text;
  let changed = false;
  for (const project of parsed) {
    if (!project || typeof project !== "object" || Array.isArray(project)) continue;
    const entry = project as Record<string, unknown>;
    const abs = absolutize(entry.path, legacyDir);
    if (abs !== undefined && entry.path !== abs) {
      entry.path = abs;
      changed = true;
    }
  }
  if (!changed) return text;
  return `# 从旧配置目录迁移，相对路径已改写为绝对路径。\n${stringifyYaml(parsed)}`;
}

function replaceEnvValue(raw: string, value: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(['"])(.*?)\1(.*)$/);
  if (quoted) return `${quoted[1]}${value}${quoted[1]}${quoted[3]}`;
  // 行尾注释前面必须有空白才算注释，路径里的 # 不受影响。
  const comment = trimmed.search(/\s+#/);
  if (comment >= 0) return `${value}${trimmed.slice(comment)}`;
  return value;
}

/** 展开 env 里常见的路径写法（~、$HOME、%APPDATA%），只用于判断旧值指向哪里。 */
function expandEnvValue(raw: string, env: NodeJS.ProcessEnv): string {
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE) ?? os.homedir();
  let text = raw.trim();
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(home, text.slice(2));
  return text
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => env[name] ?? match);
}

/**
 * env 文件：把写死旧目录的 QUBIUS_CONFIG_DIR / QUBIUS_ENV 改到新目录，
 * 并把更早的 QODER_* / REMOTE_CODER_* 变量名统一成 QUBIUS_*。
 * 值里引用旧目录的其他配置保持原样，避免猜测语义。
 */
export function rewriteEnvFile(
  text: string,
  legacyDir: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const lines = text.split(/(?<=\n)/);
  const currentKeys = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match?.[1]) currentKeys.add(match[1]);
  }
  let changed = false;
  const out = lines.map((line) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;
    const match = body.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const [, lead = "", originalKey = "", eq = "", rawValue = ""] = match;
    let key = originalKey;
    for (const [from, to] of LEGACY_ENV_PREFIXES) {
      if (key.startsWith(from)) {
        const renamed = `${to}${key.slice(from.length)}`;
        // 文件里已经写了新名字时以新名字为准，不再重复生成旧键。
        if (!currentKeys.has(renamed)) key = renamed;
        break;
      }
    }
    let value = rawValue;
    if (ENV_RELOCATED_KEYS.has(key)) {
      const resolved = expandEnvValue(rawValue.replace(/^(['"])(.*)\1$/, "$2"), env);
      const absolute = path.resolve(legacyDir, resolved);
      if (key === "QUBIUS_CONFIG_DIR") {
        value = replaceEnvValue(rawValue, targetDir);
      } else if (isWithin(absolute, legacyDir, platform)) {
        value = replaceEnvValue(rawValue, path.join(targetDir, "env"));
      }
    }
    if (key !== originalKey || value !== rawValue) changed = true;
    return `${lead}${key}${eq}${value}${ending}`;
  });
  return changed ? out.join("") : text;
}

function migrateMode(name: string): number {
  return name === "env" || name === "lan-proxy.credentials" ? 0o600 : 0o644;
}

/** 迁移后写入目标目录的实际内容（配置文件会改写路径）。 */
function plannedContent(
  legacyDir: string,
  targetDir: string,
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Buffer {
  const source = fs.readFileSync(path.join(legacyDir, name));
  if (name === "config.yaml" || name === "config-secondary.yaml") {
    return Buffer.from(rewriteConfigPaths(source.toString("utf8"), legacyDir), "utf8");
  }
  if (name === "projects.yaml") {
    return Buffer.from(rewriteProjectsPaths(source.toString("utf8"), legacyDir), "utf8");
  }
  if (name === "env") {
    return Buffer.from(
      rewriteEnvFile(source.toString("utf8"), legacyDir, targetDir, platform, env),
      "utf8",
    );
  }
  return source;
}

function readIgnoredFile(configDir: string): string[] {
  const file = path.join(configDir, IGNORED_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  } catch {
    return [];
  }
}

/** 已忽略的旧目录（绝对路径）。 */
export function ignoredLegacyConfigs(configDir: string): string[] {
  return [...new Set(readIgnoredFile(configDir).map((item) => path.resolve(item)))];
}

/** 记录/取消忽略；写入配置目录下的小 JSON 文件。 */
export function setLegacyConfigIgnored(configDir: string, target: string, ignored: boolean): void {
  const resolved = path.resolve(target);
  const kept = ignoredLegacyConfigs(configDir)
    .filter((item) => pathKey(item, process.platform) !== pathKey(resolved, process.platform));
  if (ignored) kept.push(resolved);
  writeFileAtomic(path.join(configDir, IGNORED_FILE), `${JSON.stringify(kept, null, 2)}\n`, {
    mode: 0o600,
  });
}

function inspect(
  dir: string,
  targetDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Omit<LegacyConfigCandidate, "path" | "origin"> | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory()) return undefined;
  const files: LegacyConfigFileInfo[] = [];
  const conflicts: string[] = [];
  for (const name of LEGACY_CONFIG_FILES) {
    const file = path.join(dir, name);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(file);
    } catch {
      continue;
    }
    // 符号链接和目录不迁移，避免把别的目录内容带进来或删掉链接目标。
    if (!entry.isFile()) continue;
    files.push({ name, size: entry.size });
    const targetFile = path.join(targetDir, name);
    if (!fs.existsSync(targetFile)) continue;
    let planned: Buffer;
    let existing: Buffer;
    try {
      planned = plannedContent(dir, targetDir, name, platform, env);
      existing = fs.readFileSync(targetFile);
    } catch {
      // 读不了就按冲突处理，迁移时会给出手工处理的提示。
      conflicts.push(name);
      continue;
    }
    if (sha256(existing) !== sha256(planned)) conflicts.push(name);
  }
  if (files.length === 0) return undefined;
  return {
    files,
    hasConfig: files.some((file) => CONFIG_NAMES.has(file.name)),
    conflicts,
  };
}

/** 扫描旧版默认配置目录；当前配置目录及其所在目录不会被当成迁移来源。 */
export function scanLegacyConfigs(options: ScanLegacyOptions): LegacyConfigCandidate[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const current = path.resolve(options.currentConfigDir);
  const ignored = options.includeIgnored
    ? new Set<string>()
    : new Set(ignoredLegacyConfigs(current).map((item) => pathKey(item, platform)));
  const seen = new Set<string>();
  const result: LegacyConfigCandidate[] = [];
  for (const candidate of legacyDirs(env, platform)) {
    const dir = path.resolve(candidate.path);
    const key = pathKey(dir, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    if (overlap(dir, current, platform)) continue;
    if (ignored.has(key)) continue;
    const info = inspect(dir, current, platform, env);
    if (info) result.push({ path: dir, origin: candidate.origin, ...info });
  }
  return result;
}

/** 让请求里的路径对上扫描结果；不信任客户端传来的任意路径。 */
export function findLegacyConfig(
  requestedPath: string,
  options: ScanLegacyOptions,
): LegacyConfigCandidate | undefined {
  const platform = options.platform ?? process.platform;
  const drop = pathKey(requestedPath, platform);
  return scanLegacyConfigs({ ...options, includeIgnored: true }).find(
    (item) => pathKey(item.path, platform) === drop,
  );
}

/**
 * 把旧配置目录里的可迁移文件复制到当前配置目录，逐文件校验后删除源文件；
 * 旧目录里还有别的文件（data/、日志等）时保留目录并报告 leftovers。
 */
export function migrateLegacyConfig(options: {
  requestedPath: string;
  currentConfigDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): LegacyMigrationResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const targetDir = path.resolve(options.currentConfigDir);
  const candidate = findLegacyConfig(options.requestedPath, {
    currentConfigDir: targetDir,
    env,
    platform,
  });
  if (!candidate) {
    throw new LegacyMigrationError("没有找到这个旧配置目录，可能已被移动或删除", 404);
  }
  if (candidate.conflicts.length > 0) {
    throw new LegacyMigrationError(
      `当前配置目录已有内容不同的同名文件：${candidate.conflicts.join("、")}；请先手工合并或忽略`,
      409,
    );
  }

  // 先把全部文件写进目标目录并校验，任何一步失败都不动旧目录。
  let planned: { name: string; content: Buffer }[];
  try {
    planned = candidate.files.map((file) => ({
      name: file.name,
      content: plannedContent(candidate.path, targetDir, file.name, platform, env),
    }));
  } catch (error) {
    throw new LegacyMigrationError(
      `无法读取旧配置文件：${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }
  const copied: string[] = [];
  const unchanged: string[] = [];
  for (const file of planned) {
    const targetFile = path.join(targetDir, file.name);
    if (fs.existsSync(targetFile)) {
      unchanged.push(file.name);
      continue;
    }
    writeFileAtomic(targetFile, file.content.toString("utf8"), { mode: migrateMode(file.name) });
    const written = fs.readFileSync(targetFile);
    if (written.length !== file.content.length || sha256(written) !== sha256(file.content)) {
      throw new LegacyMigrationError(`写入 ${targetFile} 后校验失败，旧目录未改动`, 400);
    }
    copied.push(file.name);
  }
  // 已有同名文件的也再校验一遍，确认可以安全删除源文件。
  for (const file of planned) {
    const targetFile = path.join(targetDir, file.name);
    const written = fs.readFileSync(targetFile);
    if (written.length !== file.content.length || sha256(written) !== sha256(file.content)) {
      throw new LegacyMigrationError(`目标文件 ${targetFile} 与旧文件不一致，旧目录未改动`, 409);
    }
  }

  const deleted: string[] = [];
  const failures: string[] = [];
  for (const file of planned) {
    try {
      fs.unlinkSync(path.join(candidate.path, file.name));
      deleted.push(file.name);
    } catch {
      failures.push(file.name);
    }
  }
  let removedDir = false;
  let leftovers: string[] = [];
  try {
    fs.rmdirSync(candidate.path);
    removedDir = true;
  } catch {
    try {
      leftovers = fs.readdirSync(candidate.path).sort();
    } catch {
      leftovers = [];
    }
  }
  if (failures.length > 0) {
    leftovers = [...new Set([...failures, ...leftovers])].sort();
  }
  return { path: candidate.path, copied, unchanged, deleted, leftovers, removedDir };
}
