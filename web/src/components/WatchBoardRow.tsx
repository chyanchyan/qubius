import { memo, useState } from "react";
import { PHASE_LABEL, type Session } from "../api";
import {
  cancelBatchWatch,
  resumeBatchWatch,
  updateBatchWatchTargets,
  type BatchWatch,
} from "../api-batch-watch";
import {
  WATCH_STATUS_LABEL,
  summarizeActions,
  watchCanEditTargets,
  watchReadyCount,
  watchTitle,
} from "../batch-watch";
import { effortLabel } from "../format";
import { Notice } from "../ui";
import { WatchTargetsEditor } from "./WatchTargetsEditor";
import "./WatchBoardRow.css";

type ActionKey = "" | "resume" | "skip" | "cancel";

/**
 * 项目页列表里的监听任务行。
 *
 * 脚本监听中/已暂停的任务还不存在对应的整合审核会话，直接作为一条「会话条目」
 * 留在列表里；点开可以看到来源会话、处理阻塞，并在开始审核前增减监听会话。
 */
export const WatchBoardRow = memo(function WatchBoardRow({
  projectId,
  watch,
  sessions,
  onChanged,
  onOpenPanel,
  go,
}: {
  projectId: string;
  watch: BatchWatch;
  sessions: readonly Session[];
  onChanged: () => Promise<void> | void;
  onOpenPanel?: () => void;
  go: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<ActionKey>("");
  const [error, setError] = useState("");

  const ready = watchReadyCount(watch);
  const total = watch.targetViews.length;
  const paused = watch.status === "paused";
  const hasBlockers = (watch.pausedSessionIds?.length ?? 0) > 0;
  const canCancel = watch.status === "waiting" || watch.status === "paused";
  const canEdit = watchCanEditTargets(watch);

  async function run(key: Exclude<ActionKey, "">, action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await action();
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error && reason.message.trim() ? reason.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="board-session watch-board">
      <div className="convo-row">
        <button
          type="button"
          className="convo watch-convo"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="watch-mark" data-status={watch.status} aria-hidden="true" />
          <span className="convo-text">
            <span className="convo-head">
              <span className="watch-badge" data-status={watch.status}>
                {WATCH_STATUS_LABEL[watch.status]}
              </span>
              <strong className="convo-title">{watchTitle(watch)}</strong>
            </span>
            <span className="convo-sub">
              就绪 {ready}/{total} · {summarizeActions(watch.actions)}
            </span>
            {paused && watch.pauseReason && <span className="error">{watch.pauseReason}</span>}
          </span>
          <span className="convo-meta watch-toggle">{open ? "收起" : "详情"}</span>
        </button>
      </div>

      {open && (
        <div className="watch-detail">
          <div className="watch-detail-head">
            <span className="watch-detail-meta">
              审核模型：{watch.providerName} · {watch.model} · {effortLabel(watch.effort)}
            </span>
            {onOpenPanel && (
              <button type="button" className="text-btn" onClick={onOpenPanel}>
                打开监听整合
              </button>
            )}
          </div>

          {!editing && (
            <ul className="watch-targets">
              {watch.targetViews.map((target) => (
                <li
                  key={target.sessionId}
                  className="watch-target"
                  data-skipped={target.skipped ? "true" : undefined}
                  data-blocked={target.blocker ? "true" : undefined}
                >
                  <button
                    type="button"
                    className="watch-target-link"
                    disabled={target.phase === "missing"}
                    onClick={() => go(`/sessions/${target.sessionId}`)}
                  >
                    {target.currentTitle}
                  </button>
                  <span className="watch-target-state">
                    {target.skipped
                      ? "已跳过"
                      : target.phase === "missing"
                        ? "已删除"
                        : PHASE_LABEL[target.phase]}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}

          {editing ? (
            <WatchTargetsEditor
              sessions={sessions}
              targets={watch.targetViews}
              initialSessionIds={watch.targetViews.map((target) => target.sessionId)}
              busy={Boolean(busy)}
              onSave={async (sessionIds) => {
                await updateBatchWatchTargets(projectId, watch.id, sessionIds);
                await onChanged();
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="actions">
              {canEdit && (
                <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => setEditing(true)}>
                  编辑监听会话
                </button>
              )}
              {paused && (
                <button
                  type="button"
                  className="btn"
                  disabled={Boolean(busy)}
                  onClick={() => void run("resume", () => resumeBatchWatch(projectId, watch.id, { skipBlockers: false }))}
                >
                  {busy === "resume" ? "检查中…" : "重新检查并继续"}
                </button>
              )}
              {paused && hasBlockers && (
                <button
                  type="button"
                  className="text-btn"
                  disabled={Boolean(busy)}
                  onClick={() => void run("skip", () => resumeBatchWatch(projectId, watch.id, { skipBlockers: true }))}
                >
                  {busy === "skip" ? "处理中…" : "跳过异常会话继续"}
                </button>
              )}
              {canCancel && (
                <button
                  type="button"
                  className="text-btn danger"
                  disabled={Boolean(busy)}
                  onClick={() => void run("cancel", () => cancelBatchWatch(projectId, watch.id))}
                >
                  {busy === "cancel" ? "取消中…" : "取消监听"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
