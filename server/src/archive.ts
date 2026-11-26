import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildSdkDirIndex,
  defaultSdkConfigDir,
  listSdkSessionFilesFromIndex,
  removeSdkSessionFilesForIds,
  removeSdkSessionFilesForIdsFromIndex,
  SESSION_ID_RE,
  sessionSdkIds,
  type SdkDirIndex,
  type SdkSessionFile,
} from "./sdk-files.js";
import { removeRestoredWorkspace, restoreSessionWorkspace } from "./session-cleanup.js";
import { toSummary } from "./store.js";
import type { SessionCore, SessionSummary, TranscriptItem } from "./types.js";

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const META_SUFFIX = ".meta.json";
const META_VERSION = 1;
/** 文件复制并发度；会话 JSON 仍在所有文件之后单独写。 */
const ARCHIVE_COPY_CONCURRENCY = 4;
/** 列表读取 meta / 校验文件的并发度。 */
const ARCHIVE_IO_CONCURRENCY = 8;
/** SDK 目录索引的复用窗口；一轮 sweep 开始时还会再强制刷新一次。 */
const SDK_INDEX_TTL_MS = 5_000;
/** 旧归档自身不可用、可以隔离 meta 后重建的错误（区别于磁盘/权限错误）。 */
const ARCHIVE_UNUSABLE_RE = /归档 meta 损坏|归档文件缺失|归档校验失败|归档文件大小不一致/;

let writeSeq = 0;

export interface ArchiveOptions {
  /** 归档根目录，例如 /archive/qubius。 */
  dir: string;
  /** 同一根目录下区分实例，例如 main / bak。 */
  instance: string;
  /** 当前实例的 dataDir（sessions / images 的源和恢复目标）。 */
  dataDir: string;
  /** SSD 保留天数；只用于状态展示，实际判断由 sweeper 做。 */
  retentionDays: number;
  /** 测试时可覆盖 Claude 配置目录。 */
  sdkConfigDir?: string;
  now?: () => Date;
}

interface ArchiveFile {
  /** 相对于实例根目录的 POSIX 路径。 */
  path: string;
  sha256: string;
  size: number;
}

export interface ArchiveMeta {
  version: number;
  id: string;
  projectId: string;
  title: string;
  summary: string;
  providerName: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  instance: string;
  messageCount: number;
  /** 会话 JSON 在归档里的相对路径。 */
  session: string;
  files: ArchiveFile[];
}

/**
 * 恢复目标必须由当前配置推导，不能信任归档 JSON 里的 cwd/projectPath；
 * 否则被篡改或项目迁移后的归档可以让 restore 删除任意目录。
 */
export interface RestoreTarget {
  projectId: string;
  projectPath: string;
  cwd: string;
  git: boolean;
  branch?: string;
}

export interface ArchivedSessionSummary {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  providerName: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  messageCount: number;
}

export interface ArchiveStatus {
  enabled: boolean;
  dir: string;
  instance: string;
  retentionDays: number;
  writable: boolean;
  archived: number;
  sweeping: boolean;
  lastSweepAt?: string;
  lastSweepError?: string;
}

export class ArchiveError extends Error {}

interface SourceFile {
  /** 源文件绝对路径。 */
  abs: string;
  /** 归档里的相对路径（POSIX）。 */
  rel: string;
}

export class ArchiveStore {
  private lastSweepAt?: string;
  private lastSweepError?: string;
  private sweeping = false;
  private configSdkIndexCache?: { at: number; index: SdkDirIndex };

  constructor(private options: ArchiveOptions) {
    if (!INSTANCE_RE.test(options.instance) || options.instance === "." || options.instance === "..") {
      throw new ArchiveError("归档实例名无效");
    }
  }

  /** <dir>/<instance>，所有归档内容都在这里。 */
  get root(): string {
    return path.join(this.options.dir, this.options.instance);
  }

  get sdkDir(): string {
    return this.options.sdkConfigDir ?? defaultSdkConfigDir();
  }

  /** 整理任务开始/结束时由 sweeper 调用，供 /api/archive/status 展示。 */
  beginSweep(): void {
    this.sweeping = true;
    this.lastSweepError = undefined;
    // 一轮整理开始前重建索引：之后所有会话复用同一份目录快照。
    this.configSdkIndexCache = undefined;
  }

  endSweep(error?: string): void {
    this.sweeping = false;
    this.lastSweepAt = this.now().toISOString();
    this.lastSweepError = error;
  }

  async status(): Promise<ArchiveStatus> {
    // 状态栏只需要数量：直接数 meta 文件，不要把所有 meta 读出来解析 JSON。
    let archived = 0;
    try {
      for (const name of await readdir(path.join(this.root, "sessions"))) {
        if (isMetaName(name)) archived += 1;
      }
    } catch {
      // 读不到目录时按 0 展示，writable 会说明问题。
    }
    const probe = fs.existsSync(this.root) ? this.root : this.options.dir;
    return {
      enabled: true,
      dir: this.root,
      instance: this.options.instance,
      retentionDays: this.options.retentionDays,
      writable: isWritable(probe),
      archived,
      sweeping: this.sweeping,
      lastSweepAt: this.lastSweepAt,
      lastSweepError: this.lastSweepError,
    };
  }

  async list(projectId?: string): Promise<ArchivedSessionSummary[]> {
    const dir = path.join(this.root, "sessions");
    const names = await readdir(dir);
    const ids = names
      .filter(isMetaName)
      .map((name) => name.slice(0, -META_SUFFIX.length));
    // 并行读 meta，但限制并发，避免一次列出大量归档时打爆文件句柄。
    const metas = await mapLimit(ids, ARCHIVE_IO_CONCURRENCY, async (id) => {
      try {
        const meta = await this.readMeta(id);
        if (!meta || meta.id !== id) return null;
        if (projectId && meta.projectId !== projectId) return null;
        if (!isSafeArchivePath(meta.session)) return null;
        // 没有会话文件说明上次归档写了一半；不把它当成可恢复的归档。
        if (!(await isFile(archivePath(this.root, meta.session)))) return null;
        return meta;
      } catch {
        // 单条损坏/被篡改的 meta 只跳过这一条，不影响整个列表。
        return null;
      }
    });
    const valid = metas.filter((meta): meta is ArchiveMeta => meta !== null);
    valid.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return valid.map(toArchivedSummary);
  }

  /** 读取归档 meta；不存在或损坏时返回 undefined。 */
  async meta(id: string): Promise<ArchiveMeta | undefined> {
    assertId(id);
    return this.readMeta(id);
  }

  async detail(id: string): Promise<{ session: SessionSummary; archivedAt: string }> {
    assertId(id);
    const meta = await this.readMeta(id);
    if (!meta) throw new ArchiveError("找不到归档");
    const data = await fs.promises.readFile(archivePath(this.root, meta.session), "utf8");
    const core = JSON.parse(data) as SessionCore;
    if (!core || core.id !== id) throw new ArchiveError("归档内容与会话 id 不一致");
    return { session: toSummary(core, true), archivedAt: meta.archivedAt };
  }

  /**
   * 把一次会话完整写入归档：会话 JSON、图片、Claude SDK transcript。
   * 所有文件写完后才写 meta；meta 存在且校验通过才算归档成功。
   */
  async archive(session: SessionCore): Promise<ArchiveMeta> {
    assertId(session.id);
    await this.ensureRoot();

    const root = this.root;
    // 重归档时保留旧归档里仍然有效的图片/transcript。源文件可能已经被
    // Claude 自身的 30 天清理删掉，如果先清空旧归档再重建，会丢掉最后
    // 一份完整记录。新复制的同路径文件会覆盖旧条目。
    const files = new Map<string, ArchiveFile>();
    const retained = new Map<string, ArchiveFile>();
    const imagePrefix = `images/${session.id}/`;
    const existing = await this.readMeta(session.id);
    if (!existing && fs.existsSync(this.metaPath(session.id))) {
      // meta 存在但无法解析：不能再从旧 meta 合并，重建会丢掉旧 transcript
      // 的索引。保留源，等人工删除损坏归档后再重试。
      throw new ArchiveError("归档 meta 损坏，拒绝重建；请先删除该归档");
    }
    if (existing) {
      for (const file of existing.files) {
        if (!isSafeArchivePath(file.path)) continue;
        if (file.path.startsWith(imagePrefix) || file.path.startsWith("sdk/")) {
          retained.set(file.path, file);
        }
      }
    }

    const sessionData = Buffer.from(JSON.stringify(session), "utf8");
    const sessionRel = `sessions/${session.id}.json`;

    // 每个文件读两遍：复制时流式计算源 sha256（读源一次），rename 后
    // 回读目标算一次 sha256 并比对内容和大小（读目标一次）。长度相同但
    // 内容写坏的磁盘错误也能在删源前发现。
    await mapLimit(await this.collectSources(session), ARCHIVE_COPY_CONCURRENCY, async (source) => {
      const dest = archivePath(root, source.rel);
      const copied = await copyAndHash(source.abs, dest);
      if (copied.writtenSize !== copied.size || copied.writtenSha256 !== copied.sha256) {
        throw new ArchiveError(`归档校验失败：${source.rel}`);
      }
      files.set(source.rel, { path: source.rel, sha256: copied.sha256, size: copied.size });
    });

    // 没有重新复制、直接沿用旧归档的图片/transcript 也要确认没损坏，
    // 否则 meta 会继续声称一个已经坏掉的文件是有效的。
    // 这一步放在写会话 JSON 之前：失败时旧 meta + 旧会话 JSON 仍然匹配。
    await mapLimit([...retained.values()].filter((file) => !files.has(file.path)), ARCHIVE_IO_CONCURRENCY, async (file) => {
      let actual: { sha256: string; size: number };
      try {
        actual = await hashFile(archivePath(root, file.path));
      } catch {
        throw new ArchiveError(`归档文件缺失：${file.path}`);
      }
      if (actual.size !== file.size || actual.sha256 !== file.sha256) {
        throw new ArchiveError(`归档校验失败：${file.path}`);
      }
      files.set(file.path, { path: file.path, sha256: actual.sha256, size: actual.size });
    });

    // 会话 JSON 最后写：源文件复制失败时旧 meta + 旧会话 JSON 仍然匹配，
    // 旧归档保持可校验，源也不会被误删。
    // 写后同样回读比对内容，避免等长写坏被 meta 认可后删掉源文件。
    const sessionSha256 = createHash("sha256").update(sessionData).digest("hex");
    await writeAtomic(archivePath(root, sessionRel), sessionData);
    const sessionFile = await describeArchivedFile(root, sessionRel);
    if (sessionFile.size !== sessionData.length || sessionFile.sha256 !== sessionSha256) {
      throw new ArchiveError(`归档校验失败：${sessionRel}`);
    }
    files.set(sessionRel, sessionFile);

    const list = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    const meta: ArchiveMeta = {
      version: META_VERSION,
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      summary: session.summary,
      providerName: session.providerName,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archivedAt: this.now().toISOString(),
      instance: this.options.instance,
      messageCount: session.messages.length,
      session: sessionRel,
      files: list,
    };
    const metaData = Buffer.from(JSON.stringify(meta, null, 2), "utf8");
    await writeAtomic(this.metaPath(session.id), metaData);
    return meta;
  }

  /**
   * 删除会话前的冷备份。旧归档损坏/文件缺失时 archive() 会拒绝重建，
   * 而在线会话又不会出现在归档列表里，用户没法从界面清掉它。这里把损坏
   * 的 meta 改名隔离（保留原文件，不删字节）后重建一次；重建成功即可继续
   * 删除。磁盘不可写等其它错误直接抛出，保持 fail-closed。
   */
  async archiveBeforeDelete(session: SessionCore): Promise<ArchiveMeta> {
    assertId(session.id);
    // 不能复用整理期间（或 5 秒窗口内）的旧 SDK 索引：随后 removeSdk 会用
    // 新索引删除 transcript，两边必须看到同一批文件。
    this.configSdkIndexCache = undefined;
    try {
      return await this.archive(session);
    } catch (error) {
      if (
        !(error instanceof ArchiveError)
        || !ARCHIVE_UNUSABLE_RE.test(error.message)
        || !fs.existsSync(this.metaPath(session.id))
      ) {
        throw error;
      }
    }
    const metaPath = this.metaPath(session.id);
    const brokenPath = `${metaPath}.broken-${Date.now()}`;
    await fs.promises.rename(metaPath, brokenPath);
    try {
      return await this.archive(session);
    } catch (error) {
      // 重建仍失败时把旧 meta 放回去（尽力而为），避免归档从列表里消失。
      await fs.promises.rename(brokenPath, metaPath).catch(() => undefined);
      throw error;
    }
  }

  /** 校验归档里的每个文件；失败时抛 ArchiveError。返回 meta。 */
  async verify(id: string): Promise<ArchiveMeta> {
    assertId(id);
    const meta = await this.readMeta(id);
    if (!meta) throw new ArchiveError("没有找到归档");
    if (!meta.files.some((file) => file.path === meta.session)) {
      throw new ArchiveError("归档缺少会话文件");
    }
    for (const file of meta.files) {
      const abs = archivePath(this.root, file.path);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(abs);
      } catch {
        throw new ArchiveError(`归档文件缺失：${file.path}`);
      }
      if (!stat.isFile() || stat.size !== file.size) {
        throw new ArchiveError(`归档文件大小不一致：${file.path}`);
      }
      const actual = await hashFile(abs);
      if (actual.sha256 !== file.sha256) {
        throw new ArchiveError(`归档文件校验失败：${file.path}`);
      }
    }
    return meta;
  }

  /**
   * 把归档恢复到 dataDir 和 Claude 配置目录。调用方负责在成功后让
   * Store 重新载入该会话（loadFromDisk）。
   */
  async restore(id: string, target: RestoreTarget): Promise<SessionCore> {
    assertId(id);
    if (!path.isAbsolute(target.projectPath) || !path.isAbsolute(target.cwd)) {
      throw new ArchiveError("恢复目标路径必须是绝对路径");
    }
    const meta = await this.verify(id);
    const root = this.root;
    const sessionData = await fs.promises.readFile(archivePath(root, meta.session), "utf8");
    const core = JSON.parse(sessionData) as SessionCore;
    if (!core || core.id !== id) throw new ArchiveError("归档内容与会话 id 不一致");
    if (core.projectId !== meta.projectId) {
      throw new ArchiveError("归档内容与 meta 的项目不一致");
    }
    if (core.projectId !== target.projectId) {
      throw new ArchiveError("归档项目与恢复目标不一致");
    }
    // 恢复视为一次新的活动：否则下一轮 sweeper 会因为它仍然是 30 天前的
    // updatedAt 而立刻再次归档删除。归档副本本身保持原样。
    // cwd/projectPath/git/branch 只接受调用方从当前配置推导出的目标。
    const sdkIds = sessionSdkIds(core);
    const candidateSdkId = core.claudeSessionId;
    // cwd 变了以后旧 transcript 的 slug 对不上，resume 会失败；从新上下文开始。
    // 只接受当前会话确实关联、且归档里真的带回了 transcript 的 SDK session id，
    // 避免损坏/篡改的归档让 resume 跳到别的会话或一个不存在的文件。
    const keepClaudeSessionId = target.cwd === core.cwd
      && typeof candidateSdkId === "string"
      && sdkIds.includes(candidateSdkId)
      && meta.files.some((file) =>
        isSafeArchivePath(file.path)
        && file.path.startsWith("sdk/")
        && file.path.endsWith(`/${candidateSdkId}.jsonl`));
    const restoreSdk = keepClaudeSessionId && Boolean(candidateSdkId);
    const restored: SessionCore = {
      ...core,
      updatedAt: this.now().toISOString(),
      projectId: target.projectId,
      projectPath: target.projectPath,
      cwd: target.cwd,
      git: target.git,
      branch: target.branch,
      // 丢弃 SDK 上下文时，本地消息上的 sdkUuid/forkPoint 也必须一起失效：
      // 否则前端仍显示可回滚/分叉，恢复后的第一条消息还会把旧的 lastSdkUuid
      // 当作 forkPoint。保留上下文时指针与恢复的 transcript 一致，可以保留。
      messages: restoreSdk ? core.messages : clearSdkPointers(core.messages ?? []),
      ...(restoreSdk && candidateSdkId
        ? { claudeSessionId: candidateSdkId }
        : { claudeSessionId: undefined }),
    };
    // 恢复后永远是已有上下文或全新上下文，不再需要“下次新建 SDK 会话”标记。
    delete restored.newSdkSession;
    if (restoreSdk) {
      if (core.lastSdkUuid) restored.lastSdkUuid = core.lastSdkUuid;
      else delete restored.lastSdkUuid;
    } else {
      delete restored.lastSdkUuid;
    }
    if (!restoreSdk && typeof candidateSdkId === "string" && candidateSdkId) {
      // 归档复制循环仍会按 meta.files 把这个 transcript/session-env 拷回 SSD；
      // 它已不是当前上下文，但必须继续被会话跟踪，否则后续 DELETE/归档/retention
      // 都找不到它，成为孤儿文件。
      const forked = [...(restored.forkedSdkIds ?? [])];
      if (!forked.includes(candidateSdkId)) forked.push(candidateSdkId);
      restored.forkedSdkIds = forked;
    }

    const destSession = path.join(this.options.dataDir, "sessions", `${id}.json`);
    await fs.promises.mkdir(path.dirname(destSession), { recursive: true, mode: 0o700 });
    let createdWorkspace = false;
    try {
      // 先重建 cwd，再写会话文件：失败时不会留下一个指向不存在目录的会话。
      createdWorkspace = await restoreSessionWorkspace(restored);
      await writeAtomic(destSession, Buffer.from(JSON.stringify(restored), "utf8"));
      // 先清掉同名会话可能残留的图片和 transcript，再按归档恢复。
      await fs.promises.rm(path.join(this.options.dataDir, "images", id), {
        recursive: true,
        force: true,
      });
      removeSdkSessionFilesForIds(sdkIds, this.sdkDir);
      for (const file of meta.files) {
        if (file.path === meta.session) continue;
        const source = archivePath(root, file.path);
        if (file.path.startsWith("images/")) {
          const rel = file.path.slice("images/".length);
          await copyAtomic(source, path.join(this.options.dataDir, "images", ...rel.split("/")));
        } else if (file.path.startsWith("sdk/")) {
          const rel = file.path.slice("sdk/".length);
          await copyAtomic(source, path.join(this.sdkDir, ...rel.split("/")));
        } else {
          throw new ArchiveError(`归档里有未知路径：${file.path}`);
        }
      }
    } catch (error) {
      // 不留下加载到一半的会话/图片/transcript；归档本身保持不动，可以重试。
      await fs.promises.rm(destSession, { force: true }).catch(() => undefined);
      await fs.promises.rm(path.join(this.options.dataDir, "images", id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      try {
        removeSdkSessionFilesForIds(sdkIds, this.sdkDir);
      } catch {
        // 清理 transcript 失败时保留归档，恢复接口会返回错误供重试。
      }
      if (createdWorkspace) {
        await removeRestoredWorkspace(restored).catch(() => undefined);
      }
      throw error;
    }
    return restored;
  }

  /** 永久删除归档副本（不会删除 SSD 上的源文件）。 */
  async remove(id: string): Promise<boolean> {
    assertId(id);
    const root = this.root;
    const meta = await this.readMeta(id);
    if (meta) {
      // 不直接信任 meta.files：它可能被篡改成别的会话路径。只认归档里实际
      // 会话 JSON 的 id 和 SDK 指针，删除范围也限定在本会话的固定路径和这些
      // SDK id 的 transcript 上。
      const expectedSession = `sessions/${id}.json`;
      let sdkIds: string[] = [id];
      if (meta.session === expectedSession) {
        try {
          const data = await fs.promises.readFile(archivePath(root, expectedSession), "utf8");
          const core = JSON.parse(data) as SessionCore;
          if (core && core.id === id) sdkIds = sessionSdkIds(core);
        } catch {
          // 会话 JSON 缺失/损坏：退化为只按会话 id 清理，绝不动其它 id。
        }
      }
      await this.removeArchivedById(id, sdkIds);
      return true;
    }
    // meta 缺失/损坏：保留原有按 id 的兜底行为，至少清掉同 id 的归档。
    // 一次 readdir 建好归档里 SDK 目录的 slug 快照，判断和删除复用同一份结果。
    const sdkIndex = await buildSdkDirIndex(path.join(root, "sdk"));
    const sdkFiles = await listSdkSessionFilesFromIndex(id, sdkIndex);
    const existed = fs.existsSync(this.metaPath(id))
      || fs.existsSync(archivePath(root, `sessions/${id}.json`))
      || fs.existsSync(archivePath(root, `images/${id}`))
      || sdkFiles.length > 0;
    await this.removeArchivedFiles(id, sdkFiles);
    return existed;
  }

  /** 删除 SSD 上这些 SDK session 的 Claude transcript / session-env（归档副本保留）。 */
  removeSdkIds(ids: readonly string[]): void {
    removeSdkSessionFilesForIds(ids, this.sdkDir);
  }

  /** removeSdkIds 的异步版本：复用 sweep 期间建好的目录索引。 */
  async removeSdkIdsAsync(ids: readonly string[]): Promise<void> {
    await removeSdkSessionFilesForIdsFromIndex(ids, await this.configSdkIndex());
  }

  /** 兼容旧调用：删除单个 SDK session id 的 SSD 文件。 */
  removeSdk(id: string): void {
    this.removeSdkIds([id]);
  }

  /** removeSdk 的异步版本：复用 sweep 期间建好的目录索引。 */
  async removeSdkAsync(id: string): Promise<void> {
    await this.removeSdkIdsAsync([id]);
  }

  private metaPath(id: string): string {
    return archivePath(this.root, `sessions/${id}${META_SUFFIX}`);
  }

  private async readMeta(id: string): Promise<ArchiveMeta | undefined> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.metaPath(id), "utf8")) as ArchiveMeta;
      if (!parsed || parsed.version !== META_VERSION || parsed.id !== id) return undefined;
      if (!Array.isArray(parsed.files) || typeof parsed.session !== "string") return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async ensureRoot(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(this.root, 0o700);
    } catch {
      // 非 POSIX 文件系统或权限不足时忽略；写入失败会在下面暴露。
    }
  }

  /**
   * Claude 配置目录的索引：一轮 sweep 内多个会话共用，避免每个会话都
   * 重新遍历 projects/<slug> 并逐个 stat。
   */
  private async configSdkIndex(): Promise<SdkDirIndex> {
    const now = Date.now();
    if (!this.configSdkIndexCache || now - this.configSdkIndexCache.at >= SDK_INDEX_TTL_MS) {
      this.configSdkIndexCache = { at: now, index: await buildSdkDirIndex(this.sdkDir) };
    }
    return this.configSdkIndexCache.index;
  }

  private async collectSources(session: SessionCore): Promise<SourceFile[]> {
    const sources: SourceFile[] = [];
    const imagesDir = path.join(this.options.dataDir, "images", session.id);
    for (const file of await walkFiles(imagesDir)) {
      sources.push({
        abs: file.abs,
        rel: `images/${session.id}/${file.rel}`,
      });
    }
    // 图片按会话 id 存，transcript 则可能分散在 id / claudeSessionId / forkedSdkIds。
    const index = await this.configSdkIndex();
    for (const sdkId of sessionSdkIds(session)) {
      for (const entry of await listSdkSessionFilesFromIndex(sdkId, index)) {
        if (entry.directory) {
          for (const file of await walkFiles(entry.abs)) {
            sources.push({
              abs: file.abs,
              rel: `sdk/${entry.rel}/${file.rel}`,
            });
          }
        } else {
          sources.push({ abs: entry.abs, rel: `sdk/${entry.rel}` });
        }
      }
    }
    sources.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    return sources;
  }

  /**
   * 永久删除归档里属于本会话的固定路径，以及这些 SDK id 的 transcript。
   * 先删文件、最后删 meta：中途失败时 meta 仍在，用户可以重试。
   */
  private async removeArchivedById(id: string, sdkIds: readonly string[]): Promise<void> {
    const root = this.root;
    await rmFile(archivePath(root, `sessions/${id}.json`));
    await rmTree(archivePath(root, `images/${id}`));
    // 按 id 扫描 archive 的 sdk 目录，不会碰到 meta 里可能被篡改的任意路径。
    const sdkIndex = await buildSdkDirIndex(path.join(root, "sdk"));
    for (const sdkId of sdkIds) {
      for (const entry of await listSdkSessionFilesFromIndex(sdkId, sdkIndex)) {
        if (entry.directory) await rmTree(entry.abs);
        else await rmFile(entry.abs);
      }
    }
    // 删掉文件后可能留下空的 projects/<slug>/<id> 目录；不清掉会让下一次
    // remove() 的按 id 兜底扫描误以为归档还在。
    await pruneEmptyDirs(path.join(root, "sdk"), true);
    await rmFile(this.metaPath(id));
  }

  private async removeArchivedFiles(id: string, sdkFiles: SdkSessionFile[]): Promise<void> {
    const root = this.root;
    await rmFile(archivePath(root, `sessions/${id}.json`));
    await rmFile(this.metaPath(id));
    await rmTree(archivePath(root, `images/${id}`));
    for (const entry of sdkFiles) {
      if (entry.directory) await rmTree(entry.abs);
      else await rmFile(entry.abs);
    }
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }
}

function toArchivedSummary(meta: ArchiveMeta): ArchivedSessionSummary {
  return {
    id: meta.id,
    projectId: meta.projectId,
    title: meta.title,
    summary: meta.summary,
    providerName: meta.providerName,
    model: meta.model,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    archivedAt: meta.archivedAt,
    messageCount: meta.messageCount,
  };
}

function assertId(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new ArchiveError("会话 id 无效");
}

/** `<会话 id>.meta.json`，且 id 合法。 */
function isMetaName(name: string): boolean {
  return name.endsWith(META_SUFFIX) && SESSION_ID_RE.test(name.slice(0, -META_SUFFIX.length));
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * 固定并发度地跑完所有任务。任一任务失败后其余 worker 不再领取新任务，
 * 等在途任务结束后抛出第一个错误，避免失败后还在后台继续复制/覆盖文件。
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }));
  if (failed) throw failure;
  return results;
}

function isSafeArchivePath(rel: unknown): rel is string {
  if (typeof rel !== "string") return false;
  const parts = rel.split("/");
  return parts.length > 0 && parts.every((part) => Boolean(part) && part !== "." && part !== "..");
}

function archivePath(root: string, rel: string): string {
  if (!isSafeArchivePath(rel)) throw new ArchiveError("归档路径无效");
  return path.join(root, ...rel.split("/"));
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readdir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

async function rmFile(file: string): Promise<void> {
  // force 只忽略“不存在”；权限/只读盘错误要继续抛给调用方。
  await fs.promises.rm(file, { force: true });
}

async function rmTree(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/** 清掉消息上指向已丢弃 SDK transcript 的指针。 */
function clearSdkPointers(messages: TranscriptItem[]): TranscriptItem[] {
  return messages.map((item) => {
    if (item.sdkUuid === undefined && item.forkPoint === undefined) return item;
    const copy = { ...item };
    delete copy.sdkUuid;
    delete copy.forkPoint;
    return copy;
  });
}

/** 递归删除空目录（keepRoot 时保留传入的根）；返回根是否为空。 */
async function pruneEmptyDirs(dir: string, keepRoot: boolean): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const childEmpty = await pruneEmptyDirs(path.join(dir, entry.name), false);
      if (!childEmpty) empty = false;
    } else {
      empty = false;
    }
  }
  if (empty && !keepRoot) await fs.promises.rmdir(dir).catch(() => undefined);
  return empty;
}

interface WalkedFile {
  /** 相对于根目录的 POSIX 路径。 */
  rel: string;
  abs: string;
}

async function walkFiles(dir: string, base = ""): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...await walkFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push({ rel, abs });
    }
  }
  return out;
}

async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      size += buffer.length;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), size }));
  });
}

async function describeArchivedFile(root: string, rel: string): Promise<ArchiveFile> {
  const { sha256, size } = await hashFile(archivePath(root, rel));
  return { path: rel, sha256, size };
}

/**
 * 流式复制的同时计算源文件的 sha256（读源一次）；rename 之后回读目标
 * 文件再算一次 sha256（读目标一次），由调用方比对。这样每文件两次读，
 * 且能在删除源文件前发现“长度相同但内容写坏”的磁盘错误。
 */
async function copyAndHash(
  source: string,
  dest: string,
): Promise<{ sha256: string; size: number; writtenSha256: string; writtenSize: number }> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.${++writeSeq}.tmp`;
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(source),
      tap,
      // 与 copyAtomic 一致：覆盖已有归档文件时也保证最终权限是 0600。
      fs.createWriteStream(tmp, { mode: 0o600 }),
    );
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, dest);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  const written = await hashFile(dest);
  return {
    sha256: hash.digest("hex"),
    size,
    writtenSha256: written.sha256,
    writtenSize: written.size,
  };
}

async function copyAtomic(source: string, dest: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.${++writeSeq}.tmp`;
  try {
    await fs.promises.copyFile(source, tmp);
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, dest);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeAtomic(dest: string, data: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.${++writeSeq}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, { mode: 0o600 });
    await fs.promises.rename(tmp, dest);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
