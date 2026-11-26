import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionCore } from "./types.js";

/** 和 http.ts / store.ts 使用同一套会话 id 规则，防止路径穿越。 */
export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SDK 把项目目录按绝对路径替换非字母数字字符成 slug；超过 200 字符会被它截断+哈希。 */
const MAX_SLUG_LENGTH = 200;

/**
 * 按 Claude Agent SDK 的规则把项目目录转换成 `projects/<slug>` 目录名。
 * 超过 200 字符时 SDK 会截断并追加哈希，无法自行推算，直接报错。
 */
export function sdkProjectSlug(dir: string): string {
  const slug = path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(`项目路径过长（slug 超过 ${MAX_SLUG_LENGTH} 字符），无法推算 SDK 会话目录`);
  }
  return slug;
}

/**
 * 一个 qubius 会话可能关联多个 SDK session id：会话自己的 id、当前 resume 的
 * claudeSessionId，以及回滚/分叉留下的 forkedSdkIds。假运行的 `fake-*` 不是
 * 合法 UUID，直接过滤，避免把伪造路径带进删除/归档。
 */
export function sessionSdkIds(
  session: Pick<SessionCore, "id" | "claudeSessionId" | "forkedSdkIds">,
): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined): void => {
    if (typeof id !== "string" || !SESSION_ID_RE.test(id) || ids.includes(id)) return;
    ids.push(id);
  };
  add(session.id);
  add(session.claudeSessionId);
  for (const id of session.forkedSdkIds ?? []) add(id);
  return ids;
}

/**
 * Claude Agent SDK 把会话 transcript 写在 `$CLAUDE_CONFIG_DIR`（默认 ~/.claude）下。
 * qubius 首次运行会把会话 id 当作 SDK sessionId，所以文件名就是会话 id。
 */
export function defaultSdkConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".claude");
}

export interface SdkSessionFile {
  /** 相对于 Claude 配置目录的 POSIX 路径，例如 projects/<slug>/<id>.jsonl。 */
  rel: string;
  abs: string;
  directory: boolean;
}

/**
 * 一次 readdir 得到的 projects/<slug> 快照。
 *
 * 一轮 sweep 会为多个会话反复查询同一个配置目录；每个会话都重新 readdir
 * `projects/` 是纯重复开销。这里把 slug 列表缓存下来复用。
 *
 * 注意只缓存 slug：命中与否仍以当前文件系统为准（异步 stat）。transcript
 * 可能在建好索引之后被 Claude 的 30 天清理删掉，过度缓存会让归档/删除
 * 误以为文件还在。
 */
export interface SdkDirIndex {
  /** 被索引的根目录，例如 Claude 配置目录或归档里的 sdk 目录。 */
  root: string;
  /** projects 下参与扫描的 slug 目录名。 */
  slugs: string[];
}

export async function buildSdkDirIndex(root = defaultSdkConfigDir()): Promise<SdkDirIndex> {
  const slugs: string[] = [];
  for (const entry of await readDirEntries(path.join(root, "projects"))) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) slugs.push(entry.name);
  }
  return { root, slugs };
}

function buildSdkDirIndexSync(root: string): SdkDirIndex {
  const slugs: string[] = [];
  for (const entry of readDirEntriesSync(path.join(root, "projects"))) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) slugs.push(entry.name);
  }
  return { root, slugs };
}

/**
 * 用 slug 快照异步 stat 某个会话的文件。
 *
 * 会话的 cwd 可能变化过（不同 worktree），所以按 id 扫描所有 projects/<slug>，
 * 而不是只按当前 cwd 推算 slug。
 */
export async function listSdkSessionFilesFromIndex(
  id: string,
  index: SdkDirIndex,
): Promise<SdkSessionFile[]> {
  if (!SESSION_ID_RE.test(id)) return [];
  const out: SdkSessionFile[] = [];
  for (const slug of index.slugs) {
    const slugDir = path.join(index.root, "projects", slug);
    const transcript = path.join(slugDir, `${id}.jsonl`);
    if (await isFile(transcript)) {
      out.push({ rel: posix("projects", slug, `${id}.jsonl`), abs: transcript, directory: false });
    }
    const detailDir = path.join(slugDir, id);
    if (await isDirectory(detailDir)) {
      out.push({ rel: posix("projects", slug, id), abs: detailDir, directory: true });
    }
  }
  const envDir = path.join(index.root, "session-env", id);
  if (await isDirectory(envDir)) {
    out.push({ rel: posix("session-env", id), abs: envDir, directory: true });
  }
  return out;
}

/** 子任务 id 由 SDK 生成；限制字符集，避免它被拼进路径时造成穿越。 */
export const SUBAGENT_TASK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 找到某个子 agent 的 sidechain transcript。
 *
 * Claude Code 把它写在 `projects/<slug>/<会话 id>/subagents/agent-<task id>.jsonl`，
 * 落定通知里的 output_file 也指向同一个文件。会话 cwd 可能变过，所以和主
 * transcript 一样按 id 扫描所有 slug；找不到（刚启动、旧数据被清理）时返回 undefined。
 */
export async function findSubagentTranscript(
  id: string,
  taskId: string,
  configDir = defaultSdkConfigDir(),
): Promise<string | undefined> {
  if (!SESSION_ID_RE.test(id) || !SUBAGENT_TASK_ID_RE.test(taskId)) return undefined;
  const index = await buildSdkDirIndex(configDir);
  for (const slug of index.slugs) {
    const file = path.join(index.root, "projects", slug, id, "subagents", `agent-${taskId}.jsonl`);
    if (await isFile(file)) return file;
  }
  return undefined;
}

/** 同步版本，语义与原来的逐 slug stat 一致，供同步调用点保持兼容。 */
export function listSdkSessionFiles(
  id: string,
  configDir = defaultSdkConfigDir(),
): SdkSessionFile[] {
  if (!SESSION_ID_RE.test(id)) return [];
  const out: SdkSessionFile[] = [];
  for (const slug of buildSdkDirIndexSync(configDir).slugs) {
    const slugDir = path.join(configDir, "projects", slug);
    const transcript = path.join(slugDir, `${id}.jsonl`);
    if (isFileSync(transcript)) {
      out.push({ rel: posix("projects", slug, `${id}.jsonl`), abs: transcript, directory: false });
    }
    const detailDir = path.join(slugDir, id);
    if (isDirectorySync(detailDir)) {
      out.push({ rel: posix("projects", slug, id), abs: detailDir, directory: true });
    }
  }
  const envDir = path.join(configDir, "session-env", id);
  if (isDirectorySync(envDir)) {
    out.push({ rel: posix("session-env", id), abs: envDir, directory: true });
  }
  return out;
}

/**
 * 删除某个会话在 Claude 配置目录里的 transcript / 子 agent / session-env。
 * 只清理按 id 命中的路径，不会动同目录下其他会话。
 */
export function removeSdkSessionFiles(
  id: string,
  configDir = defaultSdkConfigDir(),
): string[] {
  // 目录存在但不可读时不能当成“没有 transcript”，否则“真删”会静默漏删。
  assertReadable(path.join(configDir, "projects"));
  assertReadable(path.join(configDir, "session-env"));
  return removeEntries(listSdkSessionFiles(id, configDir));
}

/**
 * 使用已建好的 slug 索引异步删除；供 sweeper 在一轮整理里复用同一个快照。
 * 删除语义与 removeSdkSessionFiles 一致（失败会汇总抛出）。
 */
export async function removeSdkSessionFilesFromIndex(
  id: string,
  index: SdkDirIndex,
): Promise<string[]> {
  await assertReadableAsync(path.join(index.root, "projects"));
  await assertReadableAsync(path.join(index.root, "session-env"));
  const removed: string[] = [];
  const failures: unknown[] = [];
  for (const entry of await listSdkSessionFilesFromIndex(id, index)) {
    try {
      await fs.promises.rm(entry.abs, { recursive: entry.directory, force: true });
      removed.push(entry.abs);
    } catch (error) {
      failures.push(error);
      console.warn(`[sdk-files] 无法删除 ${entry.abs}:`, error);
    }
  }
  throwIfFailures(failures);
  return removed;
}

/** 按多个会话 id 聚合扫描；假运行等非法 id 会被忽略。 */
export async function listSdkSessionFilesForIds(
  ids: readonly string[],
  index: SdkDirIndex,
): Promise<SdkSessionFile[]> {
  const out: SdkSessionFile[] = [];
  for (const id of uniqueIds(ids)) {
    out.push(...await listSdkSessionFilesFromIndex(id, index));
  }
  return out;
}

/** 删除多个会话 id 的 transcript / 子目录 / session-env；语义与单 id 版本一致。 */
export function removeSdkSessionFilesForIds(
  ids: readonly string[],
  configDir = defaultSdkConfigDir(),
): string[] {
  assertReadable(path.join(configDir, "projects"));
  assertReadable(path.join(configDir, "session-env"));
  const entries: SdkSessionFile[] = [];
  for (const id of uniqueIds(ids)) entries.push(...listSdkSessionFiles(id, configDir));
  return removeEntries(entries);
}

/** 异步多 id 删除：复用调用方建好的 slug 索引。 */
export async function removeSdkSessionFilesForIdsFromIndex(
  ids: readonly string[],
  index: SdkDirIndex,
): Promise<string[]> {
  await assertReadableAsync(path.join(index.root, "projects"));
  await assertReadableAsync(path.join(index.root, "session-env"));
  const removed: string[] = [];
  const failures: unknown[] = [];
  for (const entry of await listSdkSessionFilesForIds(ids, index)) {
    try {
      await fs.promises.rm(entry.abs, { recursive: entry.directory, force: true });
      removed.push(entry.abs);
    } catch (error) {
      failures.push(error);
      console.warn(`[sdk-files] 无法删除 ${entry.abs}:`, error);
    }
  }
  throwIfFailures(failures);
  return removed;
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!SESSION_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * 把某个 SDK session 的 transcript 和详情目录搬到目标 cwd 对应的 slug 下。
 *
 * forkSession 总是写到源 cwd 对应的目录；分叉出的会话换了 worktree 后必须把
 * 文件搬过去，否则 resume 找不到。`session-env/<id>` 与路径无关，保持不动。
 * 已经在目标位置时直接返回 true；找不到 transcript 或复制失败时抛错。
 */
export async function relocateSdkSession(
  id: string,
  toDir: string,
  configDir = defaultSdkConfigDir(),
): Promise<boolean> {
  if (!SESSION_ID_RE.test(id)) throw new Error("SDK 会话 id 无效");
  const slug = sdkProjectSlug(toDir);
  const targetParent = path.join(configDir, "projects", slug);
  const targetTranscript = path.join(targetParent, `${id}.jsonl`);
  const targetDetail = path.join(targetParent, id);
  if (await isFile(targetTranscript)) return true;
  const sources = listSdkSessionFiles(id, configDir)
    .filter((entry) => entry.rel.startsWith("projects/"));
  const transcriptSource = sources.find((entry) => !entry.directory);
  if (!transcriptSource) throw new Error("找不到 SDK 会话 transcript");
  const detailSources = sources.filter((entry) =>
    entry.directory && path.resolve(entry.abs) !== path.resolve(targetDetail));

  await fs.promises.mkdir(targetParent, { recursive: true, mode: 0o700 });
  await copyFileAtomic(transcriptSource.abs, targetTranscript);
  for (const dir of detailSources) {
    // 多个源 slug 下同 id 的详情目录合并到目标目录，不覆盖已有文件之外的旧内容。
    await fs.promises.cp(dir.abs, targetDetail, { recursive: true, force: true });
  }
  if (!(await isFile(targetTranscript))) {
    throw new Error("复制 SDK transcript 后校验失败");
  }
  // 先确认目标就绪，再删源；session-env 不在 sources 里，不会被删。
  const failures: unknown[] = [];
  for (const entry of sources) {
    if (path.resolve(entry.abs) === path.resolve(targetTranscript)) continue;
    if (path.resolve(entry.abs) === path.resolve(targetDetail)) continue;
    try {
      await fs.promises.rm(entry.abs, { recursive: entry.directory, force: true });
    } catch (error) {
      failures.push(error);
      console.warn(`[sdk-files] 无法删除旧位置 ${entry.abs}:`, error);
    }
  }
  throwIfFailures(failures);
  return true;
}

async function copyFileAtomic(source: string, dest: string): Promise<void> {
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.copyFile(source, tmp);
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, dest);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function removeEntries(entries: SdkSessionFile[]): string[] {
  const removed: string[] = [];
  const failures: unknown[] = [];
  for (const entry of entries) {
    try {
      fs.rmSync(entry.abs, { recursive: entry.directory, force: true });
      removed.push(entry.abs);
    } catch (error) {
      failures.push(error);
      console.warn(`[sdk-files] 无法删除 ${entry.abs}:`, error);
    }
  }
  throwIfFailures(failures);
  return removed;
}

function throwIfFailures(failures: unknown[]): void {
  if (failures.length === 0) return;
  const first = failures[0];
  const detail = first instanceof Error ? first.message : String(first);
  throw new Error(`无法删除 Claude transcript（${failures.length} 项失败）：${detail}`);
}

function posix(...parts: string[]): string {
  return parts.join("/");
}

function assertReadable(dir: string): void {
  if (!fs.existsSync(dir)) return;
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
}

async function assertReadableAsync(dir: string): Promise<void> {
  try {
    await fs.promises.access(dir, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    // 不存在视为没有 transcript；权限不足继续抛出，避免静默漏删。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function readDirEntriesSync(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readDirEntries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isFileSync(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectorySync(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
