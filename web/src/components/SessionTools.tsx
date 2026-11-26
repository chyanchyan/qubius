import { useCallback, useEffect, useRef, useState } from "react";
import { sendMessage, type QueueEntry, type Session, type WorkflowSkill } from "../api";
import { startDiscussion } from "../api-discussion";
import {
  cancelQueuedPrompt,
  editQueuedPrompt,
  getQueuedPrompt,
  patchSession,
  sendQueuedPromptNow,
} from "../api-sessions";
import { formatMessageTime } from "../format";
import { queueEntryPreview, queueSummary } from "../queue-view";
import { runExport } from "../session-export";
import { canContinue } from "../session-selection";
import { Menu, Notice, useDialogs, type MenuItem } from "../ui";
import "./OverviewPage.css";

/**
 * 详情页的会话操作。头部只保留一个「更多」菜单（改名/置顶/导出/继续/归档/Git）；
 * 排队消息面板由页面放在输入框正上方（工作流进度条之下）。
 */

export type SessionAction = "" | "rename" | "pin" | "export" | "continue";

export interface SessionActions {
  busy: SessionAction;
  rename: () => Promise<void>;
  togglePin: () => Promise<void>;
  exportMarkdown: () => Promise<void>;
  continueLast: () => Promise<void>;
}

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * 中断/停止后继续：沿用上一轮的工作流，避免 prl/ser/plan 控件消失。
 * 讨论会话没有「继续」这种正文：直接用保存的参与者把上一轮讨论重跑一遍。
 * 详情页菜单和列表页的「继续」按钮共用这一条发送路径。
 */
export async function sendContinue(session: Session): Promise<Session> {
  if (session.discussion && session.discussion.participants.length > 0) {
    const data = await startDiscussion(session.id, session.discussion.participants);
    return data.session;
  }
  const workflow = session.workflow?.skill;
  const data = await sendMessage(session.id, "继续", undefined, undefined, workflow);
  return data.session;
}

/**
 * 菜单和失败提示卡片共用同一套操作，保证「继续上次」只有一条发送路径，
 * busy 守卫在 React 重新渲染前也能挡住第二次点击。
 */
export function useSessionActions(
  session: Session | null,
  onChange: (session: Session) => void,
  onError: (message: string) => void,
  /** 「继续上次」沿用上一轮工作流时，同步发送区的模式下拉。 */
  onContinueWorkflow?: (skill: WorkflowSkill) => void,
): SessionActions {
  const dialogs = useDialogs();
  const [busy, setBusy] = useState<SessionAction>("");
  const busyRef = useRef<SessionAction>("");

  function start(action: SessionAction): boolean {
    if (busyRef.current !== "") return false;
    busyRef.current = action;
    setBusy(action);
    return true;
  }

  function finish(): void {
    busyRef.current = "";
    setBusy("");
  }

  const rename = useCallback(async () => {
    if (!session) return;
    const input = await dialogs.prompt({
      title: "重命名对话",
      message: "标题会显示在列表和标签页上。",
      label: "标题（1-80 字）",
      initialValue: session.title,
      maxLength: 80,
      confirmLabel: "保存",
      validate: (value) => {
        const title = value.trim();
        return title.length >= 1 && title.length <= 80 ? "" : "标题需要 1 到 80 个字符";
      },
    });
    if (input === null) return;
    const title = input.trim();
    if (title.length < 1 || title.length > 80) {
      onError("标题需要 1 到 80 个字符");
      return;
    }
    if (!start("rename")) return;
    onError("");
    try {
      const data = await patchSession(session.id, { title });
      onChange(data.session);
    } catch (reason) {
      onError(errorText(reason, "改名失败"));
    } finally {
      finish();
    }
  }, [dialogs, onError, onChange, session]);

  const togglePin = useCallback(async () => {
    if (!session) return;
    if (!start("pin")) return;
    onError("");
    try {
      const data = await patchSession(session.id, { pinned: !session.pinned });
      onChange(data.session);
    } catch (reason) {
      onError(errorText(reason, "置顶失败"));
    } finally {
      finish();
    }
  }, [onError, onChange, session]);

  const exportMarkdown = useCallback(async () => {
    if (!session) return;
    if (!start("export")) return;
    onError("");
    try {
      // 历史未完整加载时这里会先拉一次完整会话；失败走和改名/置顶一样的提示。
      const failure = await runExport(session);
      if (failure) onError(failure);
    } finally {
      finish();
    }
  }, [onError, session]);

  const continueLast = useCallback(async () => {
    if (!session) return;
    if (!start("continue")) return;
    onError("");
    try {
      const workflow = session.workflow?.skill;
      if (workflow) onContinueWorkflow?.(workflow);
      onChange(await sendContinue(session));
    } catch (reason) {
      onError(errorText(reason, "发送「继续」失败"));
    } finally {
      finish();
    }
  }, [onContinueWorkflow, onError, onChange, session]);

  return { busy, rename, togglePin, exportMarkdown, continueLast };
}

export function SessionActionsMenu({
  session,
  actions,
  gitOpen,
  onToggleGit,
  onDelete,
  deleting,
  externallyLocked = false,
}: {
  session: Session;
  actions: SessionActions;
  gitOpen: boolean;
  onToggleGit: () => void;
  onDelete: () => void;
  deleting: boolean;
  /** 页面级的发送/消息操作在途时一并锁定，避免与「继续上次」等操作并发。 */
  externallyLocked?: boolean;
}) {
  const busy = actions.busy;
  const locked = busy !== "" || deleting || externallyLocked;
  const resumable = canContinue(session);
  const items: MenuItem[] = [
    {
      id: "rename",
      label: busy === "rename" ? "改名中…" : "改名",
      disabled: locked,
      onSelect: () => void actions.rename(),
    },
    {
      id: "pin",
      label: busy === "pin" ? "处理中…" : session.pinned ? "取消置顶" : "置顶",
      disabled: locked,
      onSelect: () => void actions.togglePin(),
    },
    {
      id: "export",
      label: busy === "export" ? "导出中…" : "导出 Markdown",
      disabled: locked,
      onSelect: () => void actions.exportMarkdown(),
    },
  ];
  if (resumable) {
    items.push({
      id: "continue",
      label: busy === "continue" ? "继续中…" : "继续上次",
      disabled: locked,
      onSelect: () => void actions.continueLast(),
    });
  }
  items.push(
    {
      id: "git",
      label: gitOpen ? "收起 Git 面板" : "Git 面板",
      disabled: locked,
      separatorBefore: true,
      onSelect: onToggleGit,
    },
  );
  items.push(
    {
      id: "delete",
      label: deleting ? "归档中" : "归档",
      disabled: locked,
      danger: true,
      separatorBefore: true,
      onSelect: onDelete,
    },
  );
  return (
    <Menu
      className="session-menu"
      buttonClassName="nav-btn menu-trigger"
      label="更多"
      ariaLabel="对话操作"
      align="right"
      items={items}
    />
  );
}

/**
 * 输入框上方的排队消息面板（参考 Cursor 的 queued messages）。
 *
 * 每条消息可以「现在发送」（提前放行，正在跑的会折叠进当前轮）、编辑或删除。
 * 触摸端所有操作都是常驻按钮，不依赖 hover；目标尺寸在 pointer:coarse 下放大。
 */
export function QueuePanel({ session, onChange }: { session: Session; onChange: (session: Session) => void }) {
  const dialogs = useDialogs();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loadingEdit, setLoadingEdit] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState("");
  const [editText, setEditText] = useState("");
  /* 同步防重入：连点同一个条目时 state 还没更新。 */
  const busyRef = useRef(new Set<string>());
  const queue = session.queue ?? [];

  /* 正在编辑的消息被发送/轮末取走后，收起编辑框，避免保存到不存在的条目。 */
  useEffect(() => {
    if (!editing) return;
    if (queue.some((entry) => entry.id === editing)) return;
    setEditing("");
    setEditText("");
  }, [editing, queue]);

  if (queue.length === 0) return null;

  async function sendNow(entry: QueueEntry) {
    if (busyRef.current.has(entry.id)) return;
    busyRef.current.add(entry.id);
    setBusy(entry.id);
    setError("");
    try {
      const data = await sendQueuedPromptNow(session.id, entry.id);
      onChange(data.session);
    } catch (reason) {
      setError(errorText(reason, "提前发送失败"));
    } finally {
      busyRef.current.delete(entry.id);
      setBusy("");
    }
  }

  async function startEdit(entry: QueueEntry) {
    if (loadingEdit) return;
    setLoadingEdit(entry.id);
    setError("");
    try {
      /* 列表里的 text 只截了前 200 字，编辑要拉完整正文。 */
      const data = await getQueuedPrompt(session.id, entry.id);
      setEditing(entry.id);
      setEditText(data.entry.text);
    } catch (reason) {
      setError(errorText(reason, "无法读取这条消息"));
    } finally {
      setLoadingEdit("");
    }
  }

  async function saveEdit(entry: QueueEntry) {
    const text = editText.trim();
    if (!text || busyRef.current.has(entry.id)) return;
    busyRef.current.add(entry.id);
    setBusy(entry.id);
    setError("");
    try {
      const data = await editQueuedPrompt(session.id, entry.id, text);
      onChange(data.session);
      setEditing("");
      setEditText("");
    } catch (reason) {
      setError(errorText(reason, "保存失败"));
    } finally {
      busyRef.current.delete(entry.id);
      setBusy("");
    }
  }

  async function remove(entry: QueueEntry) {
    if (busyRef.current.has(entry.id)) return;
    const confirmed = await dialogs.confirm({
      title: "删除排队消息",
      message: entry.images > 0
        ? "这条消息还没有发送，删除后会和它的图片一起从对话记录里移除。"
        : "这条消息还没有发送，删除后会从对话记录里移除。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed) return;
    busyRef.current.add(entry.id);
    setBusy(entry.id);
    setError("");
    try {
      const data = await cancelQueuedPrompt(session.id, entry.id);
      onChange(data.session);
    } catch (reason) {
      setError(errorText(reason, "删除失败"));
    } finally {
      busyRef.current.delete(entry.id);
      setBusy("");
    }
  }

  return (
    <section className="queue-panel" aria-label="排队消息">
      <div className="queue-head">
        <button
          type="button"
          className="queue-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronIcon open={!collapsed} />
          <span>{queueSummary(queue.length)}</span>
        </button>
        <span className="queue-tip">当前轮结束后依次发送</span>
      </div>
      {!collapsed && (
        <ul className="queue-list">
          {queue.map((entry) => {
            const isEditing = editing === entry.id;
            const working = busy === entry.id;
            const interjecting = entry.interjecting === true;
            return (
              <li
                key={entry.id}
                className="queue-item"
                data-busy={working ? "true" : undefined}
                data-interjecting={interjecting ? "true" : undefined}
              >
                {isEditing ? (
                  <div className="queue-edit">
                    <textarea
                      className="queue-edit-input"
                      value={editText}
                      rows={2}
                      aria-label="编辑排队消息"
                      autoFocus
                      onChange={(event) => setEditText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditing("");
                        } else if (
                          event.key === "Enter"
                          && !event.nativeEvent.isComposing
                          && (event.ctrlKey || event.metaKey)
                        ) {
                          event.preventDefault();
                          void saveEdit(entry);
                        }
                      }}
                    />
                    <div className="queue-edit-actions">
                      {entry.images > 0 && <span className="queue-edit-note">保留 {entry.images} 张图片</span>}
                      <button type="button" className="text-btn" onClick={() => setEditing("")}>取消</button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!editText.trim() || working}
                        onClick={() => void saveEdit(entry)}
                      >
                        {working ? "保存中…" : "保存"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="queue-text" title={entry.text}>
                      <span className="queue-firstline">{queueEntryPreview(entry)}</span>
                      <span className="convo-sub">
                        {interjecting ? "插话中 · " : ""}
                        {entry.images > 0 ? `${entry.images} 张图片 · ` : ""}
                        {formatMessageTime(entry.createdAt)}
                      </span>
                    </span>
                    <div className="queue-actions">
                      <button
                        type="button"
                        className="queue-send-now"
                        disabled={working || interjecting}
                        onClick={() => void sendNow(entry)}
                      >
                        {interjecting ? "已放行" : working ? "发送中…" : "现在发送"}
                      </button>
                      <button
                        type="button"
                        className="queue-icon-btn"
                        aria-label="编辑排队消息"
                        title={interjecting ? "已经开始发送，不能编辑" : "编辑"}
                        disabled={working || interjecting || Boolean(loadingEdit)}
                        onClick={() => void startEdit(entry)}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="queue-icon-btn danger"
                        aria-label="删除排队消息"
                        title="删除"
                        disabled={working}
                        onClick={() => void remove(entry)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <Notice tone="error" className="session-tools-error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
    </section>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="queue-chevron"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
      focusable="false"
      data-open={open}
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M3 11.2 2.6 13.4l2.2-.4 6.8-6.8a1.3 1.3 0 0 0 0-1.8l-.6-.6a1.3 1.3 0 0 0-1.8 0L3 11.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M3 4.5h10M6.2 4.5V3.2h3.6v1.3M4.5 4.5l.5 8h6l.5-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
