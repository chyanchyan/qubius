import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendMessage } from "../api";
import {
  createDiffComment,
  deleteDiffComment,
  getDiffComments,
  updateDiffComment,
  type DiffComment,
  type DiffCommentSide,
} from "../api-diff-comments";
import {
  buildReviewPrompt,
  commentAnchor,
  parseReviewDiff,
  type ReviewFile,
  type ReviewLine,
} from "../diff-review";

/*
 * 可评论的 unified diff：按文件折叠、显示 old/new 行号，每行可以写行级评论，
 * 并把未解决评论拼成一条 prompt 发给当前会话的 agent。
 *
 * 评论读写都走 api-diff-comments；切换会话会重新加载。CSS 由 Thread.css 的
 * @import 引入，避免 Thread.tsx 被 node:test 直接 import 时遇到 .css。
 */

interface DraftComment {
  file: string;
  side: DiffCommentSide;
  line: number;
  text: string;
}

interface EditingComment {
  id: string;
  text: string;
}

interface CommentState {
  sessionId: string;
  status: "loading" | "ready" | "error";
  comments: DiffComment[];
  error?: string;
}

type SendState = "idle" | "pending" | "sent" | "error";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileKey(file: ReviewFile, index: number): string {
  return `${file.section ?? ""}\u0000${file.name}\u0000${index}`;
}

function lineKey(file: ReviewFile, line: ReviewLine, index: number): string {
  return `${file.name}\u0000${line.kind}\u0000${line.oldLine ?? ""}\u0000${line.newLine ?? ""}\u0000${index}`;
}

export function DiffReview({ sessionId, text }: { sessionId: string; text: string }) {
  const files = useMemo(() => parseReviewDiff(text), [text]);

  const [state, setState] = useState<CommentState>({
    sessionId,
    status: "loading",
    comments: [],
  });
  /* 切换会话时渲染期立即回到加载态，避免闪一帧上一个会话的评论。 */
  const current: CommentState = state.sessionId === sessionId
    ? state
    : { sessionId, status: "loading", comments: [] };
  const comments = current.comments;

  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<DraftComment | null>(null);
  const [editing, setEditing] = useState<EditingComment | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /* 异步回调返回时用它确认会话没被切走，避免把结果写到新会话的提示里。 */
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const load = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((prev) => (prev.sessionId === sessionId
      ? { ...prev, status: "loading", error: undefined }
      : { sessionId, status: "loading", comments: [] }));
    getDiffComments(sessionId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({ sessionId, status: "ready", comments: result.comments });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          sessionId,
          status: "error",
          comments: [],
          error: errorText(error),
        });
      });
  }, [sessionId]);

  useEffect(() => {
    load();
    return () => controllerRef.current?.abort();
  }, [load]);

  /* 会话切换后清掉本地编辑状态，避免把评论写到新会话。 */
  useEffect(() => {
    setDraft(null);
    setEditing(null);
    setOpenFiles({});
    setBusyId(null);
    setSavingDraft(false);
    setActionError(null);
    setSendState("idle");
    setSendError(null);
  }, [sessionId]);

  function replaceComment(next: DiffComment): void {
    const sid = sessionId;
    setState((prev) => (prev.sessionId !== sid
      ? prev
      : {
          ...prev,
          comments: prev.comments.map((item) => (item.id === next.id ? next : item)),
        }));
  }

  function removeComment(id: string): void {
    const sid = sessionId;
    setState((prev) => (prev.sessionId !== sid
      ? prev
      : { ...prev, comments: prev.comments.filter((item) => item.id !== id) }));
  }

  async function submitDraft(): Promise<void> {
    if (!draft || savingDraft) return;
    const text = draft.text.trim();
    if (!text) return;
    setSavingDraft(true);
    setActionError(null);
    try {
      const result = await createDiffComment(sessionId, {
        file: draft.file,
        side: draft.side,
        line: draft.line,
        text,
      });
      const sid = sessionId;
      setState((prev) => (prev.sessionId !== sid
        ? prev
        : { ...prev, comments: [...prev.comments, result.comment] }));
      setDraft(null);
      setSendState("idle");
      setSendError(null);
    } catch (error) {
      setActionError(`保存评论失败：${errorText(error)}`);
    } finally {
      setSavingDraft(false);
    }
  }

  async function toggleResolved(comment: DiffComment): Promise<void> {
    if (busyId) return;
    setBusyId(comment.id);
    setActionError(null);
    try {
      const result = await updateDiffComment(sessionId, comment.id, {
        resolved: !comment.resolved,
      });
      replaceComment(result.comment);
    } catch (error) {
      setActionError(`更新评论失败：${errorText(error)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(comment: DiffComment): Promise<void> {
    if (!editing || editing.id !== comment.id || busyId) return;
    const text = editing.text.trim();
    if (!text) return;
    setBusyId(comment.id);
    setActionError(null);
    try {
      const result = await updateDiffComment(sessionId, comment.id, { text });
      replaceComment(result.comment);
      setEditing(null);
    } catch (error) {
      setActionError(`更新评论失败：${errorText(error)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(comment: DiffComment): Promise<void> {
    if (busyId) return;
    setBusyId(comment.id);
    setActionError(null);
    try {
      await deleteDiffComment(sessionId, comment.id);
      removeComment(comment.id);
      if (editing?.id === comment.id) setEditing(null);
    } catch (error) {
      setActionError(`删除评论失败：${errorText(error)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function sendToAgent(): Promise<void> {
    if (sendState === "pending") return;
    const pending = comments.filter((comment) => !comment.resolved);
    if (pending.length === 0) return;
    const prompt = buildReviewPrompt(pending, files);
    const sid = sessionId;
    setSendState("pending");
    setSendError(null);
    setActionError(null);
    try {
      await sendMessage(sid, prompt);
      if (sessionRef.current === sid) setSendState("sent");
    } catch (error) {
      if (sessionRef.current !== sid) return;
      setSendState("error");
      setSendError(errorText(error));
    }
  }

  function openDraft(anchor: { file: string; side: DiffCommentSide; line: number }): void {
    setEditing(null);
    setDraft({ file: anchor.file, side: anchor.side, line: anchor.line, text: "" });
  }

  const unresolved = comments.filter((comment) => !comment.resolved).length;

  function renderComment(comment: DiffComment) {
    if (editing && editing.id === comment.id) {
      const saving = busyId === comment.id;
      return (
        <div className="diff-review-comment" key={comment.id}>
          <div className="diff-review-compose">
            <textarea
              className="diff-review-input"
              value={editing.text}
              rows={3}
              autoFocus
              aria-label="编辑评论"
              onChange={(event) => setEditing({ id: comment.id, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(null);
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void saveEdit(comment);
                }
              }}
            />
            <div className="diff-review-compose-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || !editing.text.trim()}
                onClick={() => void saveEdit(comment)}
              >
                {saving ? "保存中…" : "保存"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={saving}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      );
    }
    const busy = busyId === comment.id;
    return (
      <div
        className={comment.resolved ? "diff-review-comment is-resolved" : "diff-review-comment"}
        key={comment.id}
      >
        <div className="diff-review-comment-head">
          <span className="diff-review-comment-side">
            {comment.side === "old" ? "旧行" : "新行"} {comment.line}
          </span>
          {comment.resolved && <span className="diff-review-comment-resolved">已解决</span>}
        </div>
        <div className="diff-review-comment-text">{comment.text}</div>
        <div className="diff-review-comment-actions">
          <button
            type="button"
            className="text-btn"
            disabled={busy}
            onClick={() => void toggleResolved(comment)}
          >
            {comment.resolved ? "重新打开" : "标记解决"}
          </button>
          <button
            type="button"
            className="text-btn"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setEditing({ id: comment.id, text: comment.text });
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className="text-btn"
            disabled={busy}
            onClick={() => void remove(comment)}
          >
            删除
          </button>
        </div>
      </div>
    );
  }

  function renderLine(file: ReviewFile, line: ReviewLine, index: number) {
    if (line.kind === "hunk") {
      return (
        <div className="diff-review-hunk" key={`hunk-${index}`}>
          {line.text}
        </div>
      );
    }
    if (line.kind === "nonewline") {
      return (
        <div className="diff-review-note" key={`note-${index}`}>
          {line.content}
        </div>
      );
    }
    if (line.kind === "meta") return null;

    const anchor = commentAnchor(line);
    if (!anchor) return null;
    const rowComments = comments.filter((comment) =>
      comment.file === file.name
      && ((comment.side === "old" && comment.line === line.oldLine)
        || (comment.side === "new" && comment.line === line.newLine)));
    const draftHere = draft !== null
      && draft.file === file.name
      && draft.side === anchor.side
      && draft.line === anchor.line;
    const mark = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";

    return (
      <Fragment key={lineKey(file, line, index)}>
        <div className="diff-review-line" data-kind={line.kind}>
          <span className="diff-review-ln" aria-hidden="true">{line.oldLine ?? ""}</span>
          <span className="diff-review-ln" aria-hidden="true">{line.newLine ?? ""}</span>
          <span className="diff-review-mark" aria-hidden="true">{mark}</span>
          <button
            type="button"
            className="diff-review-comment-btn"
            title="评论这一行"
            aria-label={`评论 ${file.name || "改动"} ${anchor.side === "old" ? "旧" : "新"}行 ${anchor.line}`}
            onClick={() => openDraft({ file: file.name, side: anchor.side, line: anchor.line })}
          >
            ＋
          </button>
          <span className="diff-review-text">{line.content || " "}</span>
        </div>
        {draftHere && (
          <div className="diff-review-compose">
            <textarea
              className="diff-review-input"
              value={draft.text}
              rows={3}
              autoFocus
              placeholder="写下对这行的意见…"
              aria-label={`评论 ${file.name || "改动"} 第 ${anchor.line} 行`}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(null);
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitDraft();
                }
              }}
            />
            <div className="diff-review-compose-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={savingDraft || !draft.text.trim()}
                onClick={() => void submitDraft()}
              >
                {savingDraft ? "保存中…" : "保存"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={savingDraft}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {rowComments.map((comment) => renderComment(comment))}
      </Fragment>
    );
  }

  return (
    <div className="diff-review">
      <div className="diff-review-head">
        <span className="diff-review-count">
          {unresolved > 0 ? `${unresolved} 条未解决评论` : "暂无未解决评论"}
        </span>
        <span className="diff-review-actions">
          <button
            type="button"
            className="text-btn"
            disabled={current.status === "loading"}
            onClick={load}
          >
            {current.status === "loading" ? "刷新中…" : "刷新"}
          </button>
          <button
            type="button"
            className="btn btn-primary diff-review-send"
            disabled={sendState === "pending" || unresolved === 0 || current.status === "loading"}
            onClick={() => void sendToAgent()}
          >
            {sendState === "pending" ? "发送中…" : "发送给 agent"}
          </button>
        </span>
      </div>
      {current.status === "loading" && comments.length === 0 && (
        <div className="diff-review-status">正在加载评论…</div>
      )}
      {current.status === "error" && (
        <div className="diff-review-status" data-tone="error">
          评论加载失败：{current.error}
          <button type="button" className="text-btn" onClick={load}>重试</button>
        </div>
      )}
      {actionError && (
        <div className="diff-review-status" data-tone="error">{actionError}</div>
      )}
      {sendState === "sent" && (
        <div className="diff-review-status" data-tone="ok">已发送给 agent</div>
      )}
      {sendState === "error" && (
        <div className="diff-review-status" data-tone="error">发送失败：{sendError}</div>
      )}
      {files.length === 0 && (
        <div className="diff-review-status">没有可显示的改动</div>
      )}
      {files.map((file, fileIndex) => {
        const key = fileKey(file, fileIndex);
        const open = openFiles[key] ?? fileIndex === 0;
        return (
          <details
            className="diff-review-file"
            key={key}
            open={open}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              setOpenFiles((prev) => ({ ...prev, [key]: next }));
            }}
          >
            <summary
              className="diff-review-file-head"
              aria-label={`${file.name || "改动"}：新增 ${file.added} 行，删除 ${file.removed} 行`}
            >
              {file.section && <span className="diff-review-section">{file.section}</span>}
              <span className="diff-review-name" title={file.name}>{file.name || "改动"}</span>
              <span className="diff-review-add">+{file.added}</span>
              <span className="diff-review-del">-{file.removed}</span>
            </summary>
            <div className="diff-review-body">
              {file.lines.map((line, lineIndex) => renderLine(file, line, lineIndex))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
