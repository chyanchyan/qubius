import { memo, useMemo, useState } from "react";
import { PHASE_LABEL, type Phase, type Session } from "../api";
import type { BatchWatchTargetView } from "../api-batch-watch";
import { MAX_WATCH_SESSIONS } from "../batch-watch";
import { Notice } from "../ui";
import "./WatchTargetsEditor.css";

interface EditorOption {
  id: string;
  title: string;
  phase: Phase | "missing";
  skipped?: boolean;
}

/**
 * 监听任务的会话集合编辑器：勾选新增、取消勾选移除。
 *
 * `targets` 里已归档/删除的来源会话仍然列出，允许取消勾选把它移出任务，
 * 但不能重新勾选（Store 里已经找不到它了）。
 */
export const WatchTargetsEditor = memo(function WatchTargetsEditor({
  sessions,
  targets,
  initialSessionIds,
  busy = false,
  onSave,
  onCancel,
}: {
  sessions: readonly Session[];
  targets: readonly BatchWatchTargetView[];
  initialSessionIds?: readonly string[];
  busy?: boolean;
  onSave: (sessionIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initialSessionIds ?? targets.map((target) => target.sessionId)),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const options = useMemo<EditorOption[]>(() => {
    const known = targets.map((target) => ({
      id: target.sessionId,
      title: target.currentTitle,
      phase: target.phase,
      ...(target.skipped ? { skipped: true } : {}),
    }));
    const knownIds = new Set(known.map((item) => item.id));
    const extra = sessions
      .filter((session) => !knownIds.has(session.id))
      .map((session) => ({ id: session.id, title: session.title, phase: session.phase as Phase }));
    return [...known, ...extra];
  }, [targets, sessions]);

  function toggle(id: string): void {
    setError("");
    if (!selected.has(id) && selected.size >= MAX_WATCH_SESSIONS) {
      setError(`最多同时监听 ${MAX_WATCH_SESSIONS} 个会话`);
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (saving) return;
    if (selected.size === 0) {
      setError("请至少勾选一个要监听的会话");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave([...selected]);
    } catch (reason) {
      setError(reason instanceof Error && reason.message.trim() ? reason.message : "保存监听会话失败");
    } finally {
      setSaving(false);
    }
  }

  const disabled = busy || saving;

  return (
    <div className="wte">
      <p className="wte-hint">
        勾选要一起监听的会话，取消勾选会从监听任务里移除。已选 {selected.size}/{MAX_WATCH_SESSIONS}。
      </p>
      <div className="wte-picker" role="group" aria-label="编辑监听会话">
        {options.length === 0 && <p className="muted">当前项目还没有会话。</p>}
        {options.map((option) => {
          const checked = selected.has(option.id);
          return (
            <label key={option.id} className="wte-option" data-missing={option.phase === "missing" ? "true" : undefined}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || (option.phase === "missing" && !checked)}
                onChange={() => toggle(option.id)}
              />
              <span className="wte-title" title={option.title}>{option.title}</span>
              <span className="wte-phase">
                {option.phase === "missing" ? "已删除" : PHASE_LABEL[option.phase]}
                {option.skipped ? " · 已跳过" : ""}
              </span>
            </label>
          );
        })}
      </div>
      {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}
      <div className="actions">
        <button type="button" className="btn" disabled={disabled || selected.size === 0} onClick={() => void save()}>
          {saving ? "保存中…" : `保存监听会话（已选 ${selected.size} 个）`}
        </button>
        <button type="button" className="text-btn" disabled={saving} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
});
