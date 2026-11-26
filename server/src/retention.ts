import type { ArchiveStore } from "./archive.js";
import type { Runtime } from "./runtime.js";
import { removeSessionWorkspace } from "./session-cleanup.js";
import { sessionSdkIds } from "./sdk-files.js";
import { isAgentActive } from "./status.js";
import { tryLockSession, unlockSession } from "./session-lock.js";
import type { Store } from "./store.js";
import type { SessionCore } from "./types.js";

export interface SweepFailure {
  id: string;
  title: string;
  error: string;
}

export interface SweepResult {
  enabled: boolean;
  retentionDays: number;
  checked: number;
  archived: number;
  removed: number;
  skipped: number;
  failed: SweepFailure[];
  startedAt: string;
  finishedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Claude Agent SDK 默认 30 天清理 transcript；快照必须早于这个窗口。 */
const CLAUDE_CLEANUP_DAYS = 30;
const SNAPSHOT_SAFETY_DAYS = 7;

/**
 * 把超过保留期的会话先归档到机械盘，校验通过后再从 SSD 删除。
 *
 * 任何一步失败都保留 SSD 上的会话，下一轮继续重试；meta 没写完或校验
 * 不通过的归档不会被当成成功。
 */
export class ArchiveSweeper {
  private running: Promise<SweepResult> | null = null;

  constructor(
    private deps: {
      archive: ArchiveStore;
      store: Store;
      runtime: Runtime;
      retentionDays: number;
      now?: () => Date;
      log?: (message: string, error?: unknown) => void;
    },
  ) {}

  run(): Promise<SweepResult> {
    if (!this.running) {
      this.running = this.doSweep().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doSweep(): Promise<SweepResult> {
    const now = this.deps.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const result: SweepResult = {
      enabled: true,
      retentionDays: this.deps.retentionDays,
      checked: 0,
      archived: 0,
      removed: 0,
      skipped: 0,
      failed: [],
      startedAt,
      finishedAt: "",
    };
    let fatal: string | undefined;
    this.deps.archive.beginSweep();
    try {
      const status = await this.deps.archive.status();
      if (!status.writable) {
        throw new Error(`归档目录不可写：${status.dir}`);
      }
      const nowMs = now().getTime();
      const cutoff = nowMs - this.deps.retentionDays * DAY_MS;
      // 快照时点与到期日解耦：无论 retentionDays 多大，都要在 Claude 的
      // 30 天 transcript 清理之前保存一份。短保留期则提前 1 天快照。
      const snapshotAgeDays = Math.min(
        Math.max(1, this.deps.retentionDays - 1),
        CLAUDE_CLEANUP_DAYS - SNAPSHOT_SAFETY_DAYS,
      );
      const snapshotCutoff = nowMs - snapshotAgeDays * DAY_MS;
      // 归档使用内存中的会话；先尽量把防抖中的写入落盘，避免图片/文件不同步。
      try {
        await this.deps.store.flush();
      } catch (error) {
        this.log("归档前刷新会话失败，继续使用内存快照", error);
      }
      for (const summary of this.deps.store.list()) {
        result.checked += 1;
        const session = this.deps.store.get(summary.id);
        if (!session) {
          result.skipped += 1;
          continue;
        }
        const updated = Date.parse(session.updatedAt);
        const expired = Number.isFinite(updated) && updated <= cutoff;
        const snapshotDue = Number.isFinite(updated) && updated <= snapshotCutoff;
        if (!expired && !snapshotDue) {
          result.skipped += 1;
          continue;
        }
        if (isActive(session)) {
          result.skipped += 1;
          continue;
        }
        // 快照和删除都持锁：否则用户并发 DELETE 时，在途的快照可能把
        // 已经删掉的归档又写回 HDD；持锁也能阻止整理期间写入新消息。
        if (!tryLockSession(session.id)) {
          result.skipped += 1;
          continue;
        }
        try {
          const latest = this.deps.store.get(session.id);
          if (
            !latest
            || latest !== session
            || isActive(latest)
            || latest.updatedAt !== session.updatedAt
          ) {
            result.skipped += 1;
            continue;
          }
          // 内容没变时不必重写，避免用已经缺 transcript 的新快照覆盖之前的
          // 完整归档。未到期时也不做全量 sha256，否则长保留期下每个小时都
          // 会把全部文件重新校验一遍并长时间持锁。
          let current = false;
          let justArchived = false;
          const existing = await this.deps.archive.meta(session.id);
          if (existing && existing.updatedAt === session.updatedAt) {
            current = true;
          }
          if (!current) {
            // archive() 自己会在写 meta 前逐个校验文件（流式 hash + 大小），
            // 这里不再立刻 verify 一遍，避免刚写完就全量重读。
            await this.deps.archive.archive(session);
            result.archived += 1;
            current = true;
            justArchived = true;
          }
          if (!expired) {
            if (!justArchived) result.skipped += 1;
            continue;
          }
          // 到期删除前才校验旧归档；损坏则合并重建再校验，仍失败就保留源。
          if (!justArchived) {
            try {
              await this.deps.archive.verify(session.id);
            } catch {
              current = false;
            }
          }
          if (!current) {
            await this.deps.archive.archive(session);
            result.archived += 1;
          }
          // 归档/校验可能耗时；删除前再确认一次会话没有被新轮次替换。
          const latestAfterArchive = this.deps.store.get(session.id);
          if (
            !latestAfterArchive
            || latestAfterArchive !== session
            || isActive(latestAfterArchive)
            || latestAfterArchive.updatedAt !== session.updatedAt
          ) {
            result.skipped += 1;
            continue;
          }
          await this.deps.runtime.stop(session.id);
          if (typeof this.deps.runtime.forgetApprovals === "function") {
            this.deps.runtime.forgetApprovals(session.id);
          }
          // transcript 先删：失败时会话和 workspace 还在，下一轮可重试。
          // 用异步版本复用本轮 sweep 建好的目录索引。
          await this.deps.archive.removeSdkIdsAsync(sessionSdkIds(session));
          await removeSessionWorkspace(session);
          this.deps.store.remove(session.id);
          // 清理成功：手动删除失败留下的「待清理」标记不再需要（尽力而为）。
          await this.deps.archive.clearPendingDelete(session.id).catch(() => undefined);
          result.removed += 1;
        } catch (error) {
          result.failed.push({
            id: session.id,
            title: session.title,
            error: errorText(error),
          });
          this.log(`归档/清理会话失败 ${session.id}`, error);
        } finally {
          unlockSession(session.id);
        }
      }
      return result;
    } catch (error) {
      fatal = errorText(error);
      result.failed.push({ id: "", title: "", error: fatal });
      this.log("归档清理失败", error);
      return result;
    } finally {
      result.finishedAt = now().toISOString();
      this.deps.archive.endSweep(fatal ?? result.failed[0]?.error);
    }
  }

  private log(message: string, error?: unknown): void {
    if (this.deps.log) this.deps.log(message, error);
    else console.error(message, error);
  }
}

function isActive(session: SessionCore): boolean {
  // 只信实际状态字段：phase 是推导出来的，旧会话缺少 lastResult 时会显示成
  // "queued"，但它并没有在运行，应该允许过期归档。
  return session.turnActive
    || isAgentActive(session.agentState)
    || session.queued
    || Boolean(session.pending)
    || session.subagents.some((item) => item.status === "running");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
