import { memo, useEffect, useRef, useState } from "react";
import { getGitStatus, runGitAction, type GitAction, type GitStatus } from "../api-git";
import { PullRequestPanel } from "./PullRequestPanel";
import "./GitPanel.css";

const MAX_DIRTY_SHOWN = 100;

// 展开的面板不该跟着对话流每次推送都重新渲染；props 由父组件保持稳定。
export const GitPanel = memo(function GitPanel({ sessionId, git, onError }: {
  sessionId: string;
  git: boolean;
  onError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  // 父组件通常传内联回调；用 ref 避免它每次渲染都触发重新取状态。
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // 只接受最新一次状态请求的响应，避免旧的 GET 覆盖刷新后的结果。
  const seqRef = useRef(0);
  // 和 busy state 同步防重入：连点或回车可能在 state 更新前再次进入。
  const busyRef = useRef(false);

  useEffect(() => {
    if (!git) return;
    const controller = new AbortController();
    const seq = ++seqRef.current;
    setStatus(null);
    setError("");
    setOutput("");
    setLoading(true);
    void (async () => {
      try {
        const next = await getGitStatus(sessionId, controller.signal);
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setStatus(next);
      } catch (reason) {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        const text = errorText(reason, "无法读取 git 状态");
        setError(text);
        onErrorRef.current?.(text);
      } finally {
        if (!controller.signal.aborted && seq === seqRef.current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [sessionId, git]);

  if (!git) {
    return (
      <section className="git-panel">
        <p className="git-panel-hint">这个目录不是 git 仓库</p>
      </section>
    );
  }

  async function refresh(): Promise<void> {
    const seq = ++seqRef.current;
    try {
      const next = await getGitStatus(sessionId);
      if (seq !== seqRef.current) return;
      setStatus(next);
    } catch (reason) {
      if (seq !== seqRef.current) return;
      const text = errorText(reason, "无法读取 git 状态");
      setError(text);
      onErrorRef.current?.(text);
    }
  }

  async function run(action: GitAction): Promise<void> {
    if (busyRef.current) return;
    const trimmed = message.trim();
    if (action !== "push" && !trimmed) {
      setError("请先填写提交信息");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    setOutput("");
    try {
      const result = await runGitAction(
        sessionId,
        action === "push" ? { action } : { action, message: trimmed },
      );
      setOutput(result.output || (result.pushed ? "推送完成" : "提交完成"));
    } catch (reason) {
      const text = errorText(reason, "git 操作失败");
      setError(text);
      onErrorRef.current?.(text);
    } finally {
      busyRef.current = false;
      setBusy(false);
      // 失败时也要刷新：push 失败可能已经产生本地提交，状态已经变了。
      await refresh();
    }
  }

  return (
    <section className="git-panel" aria-label="Git">
      <div className="git-head">
        <span className="git-branch" title={status?.branch || "分支"}>
          {status?.branch || (loading ? "读取中…" : "未知分支")}
        </span>
        {status && (
          <span className={status.clean ? "git-state clean" : "git-state dirty"}>
            {status.clean ? "工作区干净" : `${status.dirty.length} 个改动`}
          </span>
        )}
      </div>
      {loading && !status && <p className="git-panel-hint">正在读取 git 状态…</p>}
      {status && !status.clean && (
        <ul className="git-files">
          {status.dirty.slice(0, MAX_DIRTY_SHOWN).map((file, index) => (
            <li key={`${file}-${index}`} title={file}>{file}</li>
          ))}
          {status.dirty.length > MAX_DIRTY_SHOWN && (
            <li className="git-more">… 还有 {status.dirty.length - MAX_DIRTY_SHOWN} 个文件</li>
          )}
        </ul>
      )}
      <form
        className="git-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run("commit");
        }}
      >
        <input
          className="git-message"
          value={message}
          maxLength={500}
          placeholder="提交信息"
          disabled={busy}
          aria-label="提交信息"
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="git-buttons">
          <button type="submit" disabled={busy || !message.trim()}>提交</button>
          <button type="button" disabled={busy || !message.trim()} onClick={() => void run("commit-push")}>
            提交并推送
          </button>
          <button type="button" disabled={busy} onClick={() => void run("push")}>只推送</button>
        </div>
      </form>
      {busy && <p className="git-panel-hint" role="status">正在执行…</p>}
      {error && <p className="error git-error">{error}</p>}
      {output && <pre className="git-output">{output}</pre>}
      <PullRequestPanel sessionId={sessionId} />
    </section>
  );
});

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
