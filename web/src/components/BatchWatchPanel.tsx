import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { EFFORTS, PHASE_LABEL, type Effort, type Provider, type Session } from "../api";
import {
  cancelBatchWatch,
  createBatchWatch,
  deleteBatchWatch,
  resumeBatchWatch,
  updateBatchWatchTargets,
  type BatchMergeMode,
  type BatchWatch,
  type BatchWatchActions,
} from "../api-batch-watch";
import {
  MERGE_MODE_LABEL,
  WATCH_STATUS_LABEL,
  defaultWatchSessionIds,
  summarizeActions,
  toggleWatchAction,
  watchCanEditTargets,
} from "../batch-watch";
import { effortLabel, effortOptionLabel, formatMessageFullTime, formatRelativeTime } from "../format";
import { Notice, useDialogs } from "../ui";
import { useNow } from "../useNow";
import { WatchTargetsEditor } from "./WatchTargetsEditor";
import "./BatchWatchPanel.css";

const NOW_REFRESH_MS = 30_000;

export interface BatchWatchPanelProps {
  projectId: string;
  sessions: readonly Session[];
  providers: readonly Provider[];
  defaultProviderId: string;
  defaultModel: string;
  defaultEffort: Effort;
  /** 由项目页统一轮询的监听任务列表；null 表示还没读取到。 */
  watches: readonly BatchWatch[] | null;
  /** 列表读取失败时的提示；操作刷新失败由面板自己提示。 */
  loadError?: string;
  /** 重新读取监听任务（创建/恢复/取消/删除/编辑后调用）。 */
  onRefresh: () => Promise<void>;
  /** 从外部（如列表多选模式）一键带入要监听的会话 id。 */
  initialSessionIds?: readonly string[];
  onInitialConsumed?: () => void;
  /** 创建成功：项目页据此收起整合框，新任务作为列表条目展示。 */
  onCreated?: (watch: BatchWatch) => void;
  go: (to: string) => void;
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return fallback;
}

export const BatchWatchPanel = memo(function BatchWatchPanel({
  projectId,
  sessions,
  providers,
  defaultProviderId,
  defaultModel,
  defaultEffort,
  watches,
  loadError,
  onRefresh,
  initialSessionIds,
  onInitialConsumed,
  onCreated,
  go,
}: BatchWatchPanelProps) {
  const dialogs = useDialogs();
  const now = useNow(NOW_REFRESH_MS);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const busyAnywhere = busy.size > 0;
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busyAnywhere;
  }, [busyAnywhere]);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => {
    if (initialSessionIds && initialSessionIds.length > 0) return new Set(initialSessionIds);
    return new Set(defaultWatchSessionIds(sessions));
  });
  const [providerId, setProviderId] = useState(defaultProviderId);
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<Effort>(defaultEffort);
  const [actions, setActions] = useState<BatchWatchActions>({
    commit: true,
    mergeMode: "merge",
    push: false,
    deploy: false,
    baseBranch: "main",
  });
  const [extraPrompt, setExtraPrompt] = useState("");

  // 外部传入预选会话（例如在列表多选后点「监听整合」）时覆盖当前勾选。
  useEffect(() => {
    if (!initialSessionIds || initialSessionIds.length === 0) return;
    setSelectedIds(new Set(initialSessionIds));
    onInitialConsumed?.();
  }, [initialSessionIds, onInitialConsumed]);

  // 接口列表就绪或变化时，对齐默认接口和模型。
  useEffect(() => {
    const provider = providers.find((item) => item.id === providerId)
      ?? providers.find((item) => item.id === defaultProviderId)
      ?? providers[0];
    if (!provider) return;
    if (provider.id !== providerId) setProviderId(provider.id);
    if (!provider.models.includes(model)) {
      const nextModel = provider.models.includes(defaultModel) ? defaultModel : (provider.models[0] ?? "");
      if (nextModel !== model) setModel(nextModel);
    }
  }, [providers, providerId, model, defaultProviderId, defaultModel]);

  // 会话被归档/删除后，从表单勾选中剔除无效 id。
  useEffect(() => {
    const valid = new Set(sessions.map((item) => item.id));
    setSelectedIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [sessions]);

  const currentProvider = providers.find((item) => item.id === providerId);

  function markBusy(key: string): void {
    setBusy((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function clearBusy(key: string): void {
    setBusy((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function toggleSession(id: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectActiveSessions(): void {
    setSelectedIds(new Set(defaultWatchSessionIds(sessions)));
  }

  function chooseProvider(nextProviderId: string): void {
    const provider = providers.find((item) => item.id === nextProviderId);
    setProviderId(nextProviderId);
    setModel(provider?.models[0] ?? "");
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busyAnywhere) return;
    if (selectedIds.size === 0) {
      setError("请至少勾选一个要监听的会话");
      return;
    }
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) {
      setError("先在设置里添加一套接口配置");
      return;
    }
    const resolvedModel = model || provider.models[0] || "";
    if (!resolvedModel) {
      setError("这套配置还没有模型，先在设置里添加");
      return;
    }
    const key = "create";
    markBusy(key);
    setError("");
    setNote("");
    try {
      const data = await createBatchWatch(projectId, {
        sessionIds: [...selectedIds],
        providerId: provider.id,
        model: resolvedModel,
        effort,
        actions,
        extraPrompt: extraPrompt.trim() || undefined,
      });
      setExtraPrompt("");
      setNote(
        data.watch.status === "reviewing"
          ? "所选会话已全部完成，已自动启动整合审核会话"
          : data.watch.status === "launching"
            ? "所选会话已全部完成，正在采集改动并启动整合审核"
            : data.watch.status === "paused"
              ? "监听已创建，但有会话需要处理，已暂停等待确认"
              : "已开始脚本监听（等待阶段零 token），全部完成后将自动启动审核整合",
      );
      await onRefresh();
      onCreated?.(data.watch);
    } catch (reason) {
      setError(errorText(reason, "创建批量监听失败"));
    } finally {
      clearBusy(key);
    }
  }

  async function onResume(watch: BatchWatch, options: { skipBlockers?: boolean; skipSessionId?: string }): Promise<void> {
    if (busyAnywhere) return;
    const key = `${watch.id}:resume`;
    markBusy(key);
    setError("");
    setNote("");
    try {
      const data = await resumeBatchWatch(projectId, watch.id, options);
      if (data.watch.status === "reviewing") {
        setNote("已恢复并自动启动整合审核会话");
      } else if (data.watch.status === "waiting") {
        setNote("已恢复脚本监听，等待其余会话完成");
      }
      await onRefresh();
    } catch (reason) {
      setError(errorText(reason, "恢复监听失败"));
    } finally {
      clearBusy(key);
    }
  }

  async function onCancel(watch: BatchWatch): Promise<void> {
    if (busyAnywhere) return;
    const key = `${watch.id}:cancel`;
    markBusy(key);
    setError("");
    try {
      await cancelBatchWatch(projectId, watch.id);
      await onRefresh();
    } catch (reason) {
      setError(errorText(reason, "取消监听失败"));
    } finally {
      clearBusy(key);
    }
  }

  async function onRemove(watch: BatchWatch): Promise<void> {
    if (busyAnywhere) return;
    const confirmed = await dialogs.confirm({
      title: "删除监听记录",
      message: "确定删除这条批量监听记录吗？已创建的来源会话和整合审核会话不会受影响。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed || busyRef.current) return;
    const key = `${watch.id}:delete`;
    markBusy(key);
    setError("");
    try {
      await deleteBatchWatch(projectId, watch.id);
      await onRefresh();
    } catch (reason) {
      setError(errorText(reason, "删除监听记录失败"));
    } finally {
      clearBusy(key);
    }
  }

  return (
    <section className="batch-watch" aria-label="批量监听整合">
      <div className="bw-head">
        <strong>批量监听整合</strong>
        <span className="muted">服务端脚本监听所选会话（等待阶段 0 token），全部完成后自动用指定模型审核修订</span>
      </div>

      {providers.length === 0 && (
        <Notice tone="warn">
          还没有接口配置，无法创建审核整合任务。
          {" "}
          <button type="button" className="text-btn" onClick={() => go("/settings")}>去设置里添加</button>
        </Notice>
      )}

      {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}
      {note && <Notice tone="success" onDismiss={() => setNote("")}>{note}</Notice>}
      {loadError && <Notice tone="error">{loadError}</Notice>}

      {watches === null && !loadError && <p className="muted">正在读取监听任务…</p>}
      {watches && watches.length > 0 && (
        <div className="bw-list">
          {watches.map((watch) => {
            const readyCount = watch.targetViews.filter((t) => t.ready).length;
            const totalCount = watch.targetViews.length;
            const canCancel = watch.status === "waiting" || watch.status === "paused";
            const canResume = watch.status === "paused" || watch.status === "failed";
            const hasBlockers = (watch.pausedSessionIds?.length ?? 0) > 0;
            return (
              <article key={watch.id} className="bw-item" data-status={watch.status}>
                <div className="bw-item-head">
                  <span className="bw-badge" data-status={watch.status}>
                    {WATCH_STATUS_LABEL[watch.status]}
                  </span>
                  <span className="bw-progress">
                    就绪 {readyCount}/{totalCount}
                  </span>
                  <span className="bw-meta-inline">
                    审核模型：{watch.providerName} · {watch.model} · {effortLabel(watch.effort)}
                  </span>
                </div>
                <p className="bw-meta">
                  收尾动作：{summarizeActions(watch.actions)} · 创建于{" "}
                  <time
                    dateTime={watch.createdAt}
                    title={formatMessageFullTime(watch.createdAt) || watch.createdAt}
                  >
                    {formatRelativeTime(watch.createdAt, now) || watch.createdAt}
                  </time>
                </p>

                {editingId === watch.id ? (
                  <WatchTargetsEditor
                    sessions={sessions}
                    targets={watch.targetViews}
                    busy={busyAnywhere}
                    onSave={async (sessionIds) => {
                      await updateBatchWatchTargets(projectId, watch.id, sessionIds);
                      setEditingId("");
                      await onRefresh();
                    }}
                    onCancel={() => setEditingId("")}
                  />
                ) : (
                  <ul className="bw-targets">
                    {watch.targetViews.map((target) => (
                      <li
                        key={target.sessionId}
                        className="bw-target"
                        data-skipped={target.skipped ? "true" : undefined}
                        data-blocked={target.blocker ? "true" : undefined}
                      >
                        <button
                          type="button"
                          className="bw-target-link"
                          disabled={target.phase === "missing"}
                          onClick={() => go(`/sessions/${target.sessionId}`)}
                        >
                          {target.currentTitle}
                        </button>
                        <span className="bw-target-state">
                          {target.skipped
                            ? "已跳过"
                            : target.phase === "missing"
                              ? "已删除"
                              : PHASE_LABEL[target.phase]}
                        </span>
                        {canResume && !target.skipped && target.blocker && (
                          <button
                            type="button"
                            className="text-btn bw-skip-one"
                            disabled={busyAnywhere}
                            onClick={() => void onResume(watch, { skipSessionId: target.sessionId })}
                          >
                            跳过此会话
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {watch.pauseReason && watch.status === "paused" && (
                  <Notice tone="warn" className="bw-notice">
                    已暂停：{watch.pauseReason}
                  </Notice>
                )}
                {watch.lastError && watch.status === "failed" && (
                  <Notice tone="error" className="bw-notice">
                    失败：{watch.lastError}
                  </Notice>
                )}

                {editingId !== watch.id && (
                  <div className="actions">
                    {watchCanEditTargets(watch) && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busyAnywhere}
                        onClick={() => setEditingId(watch.id)}
                      >
                        编辑监听会话
                      </button>
                    )}
                    {watch.reviewSessionId && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => go(`/sessions/${watch.reviewSessionId}`)}
                      >
                        打开审核会话
                        {watch.reviewPhase && watch.reviewPhase !== "missing"
                          ? `（${PHASE_LABEL[watch.reviewPhase]}）`
                          : ""}
                      </button>
                    )}
                    {canResume && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busyAnywhere}
                        onClick={() => void onResume(watch, { skipBlockers: false })}
                      >
                        重新检查并继续
                      </button>
                    )}
                    {canResume && hasBlockers && (
                      <button
                        type="button"
                        className="text-btn"
                        disabled={busyAnywhere}
                        onClick={() => void onResume(watch, { skipBlockers: true })}
                      >
                        跳过异常会话继续
                      </button>
                    )}
                    {canCancel && (
                      <button
                        type="button"
                        className="text-btn danger"
                        disabled={busyAnywhere}
                        onClick={() => void onCancel(watch)}
                      >
                        取消监听
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-btn danger"
                      disabled={busyAnywhere}
                      onClick={() => void onRemove(watch)}
                    >
                      删除记录
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <form className="bw-form" onSubmit={(event) => void onCreate(event)}>
        <div className="bw-section-head">
          <strong>新建监听任务</strong>
          <div className="bw-quick-actions">
            <button
              type="button"
              className="text-btn"
              disabled={sessions.length === 0}
              onClick={selectActiveSessions}
            >
              选运行中
            </button>
            <button
              type="button"
              className="text-btn"
              disabled={sessions.length === 0}
              onClick={() => setSelectedIds(new Set(sessions.map((item) => item.id)))}
            >
              全选
            </button>
            <button
              type="button"
              className="text-btn"
              disabled={selectedIds.size === 0}
              onClick={() => setSelectedIds(new Set())}
            >
              清空
            </button>
          </div>
        </div>

        <div className="bw-session-picker" role="group" aria-label="选择要监听的会话">
          {sessions.length === 0 && (
            <p className="muted">当前项目还没有会话，先发起开发会话后再监听。</p>
          )}
          {sessions.map((item) => (
            <label key={item.id} className="bw-session-option">
              <input
                type="checkbox"
                checked={selectedIds.has(item.id)}
                disabled={busyAnywhere}
                onChange={() => toggleSession(item.id)}
              />
              <span className="bw-session-title">{item.title}</span>
              <span className="bw-session-phase">{PHASE_LABEL[item.phase]}</span>
            </label>
          ))}
        </div>

        <div className="bw-grid">
          <div className="field">
            <label htmlFor="bw-provider">审核接口</label>
            <select
              id="bw-provider"
              value={providerId}
              disabled={busyAnywhere || providers.length === 0}
              onChange={(event) => chooseProvider(event.target.value)}
            >
              {providers.length === 0 && <option value="">无可用配置</option>}
              {providers.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="bw-model">审核模型</label>
            <select
              id="bw-model"
              value={model}
              disabled={busyAnywhere || !currentProvider || currentProvider.models.length === 0}
              onChange={(event) => setModel(event.target.value)}
            >
              {(!currentProvider || currentProvider.models.length === 0) && <option value="">无可用模型</option>}
              {(currentProvider?.models ?? []).map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="bw-effort">Effort</label>
            <select
              id="bw-effort"
              value={effort}
              disabled={busyAnywhere}
              onChange={(event) => setEffort(event.target.value as Effort)}
            >
              {EFFORTS.map((item) => (
                <option key={item} value={item}>{effortOptionLabel(item)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="bw-actions-box">
          <span className="bw-actions-label">收尾动作</span>
          <div className="bw-actions-row">
            <label className="bw-check">
              <input
                type="checkbox"
                checked={actions.commit}
                disabled={busyAnywhere}
                onChange={(event) => setActions((cur) => toggleWatchAction(cur, { commit: event.target.checked }))}
              />
              提交
            </label>
            <label className="bw-inline-select">
              合入方式
              <select
                aria-label="合入方式"
                value={actions.mergeMode}
                disabled={busyAnywhere}
                onChange={(event) => setActions((cur) =>
                  toggleWatchAction(cur, { mergeMode: event.target.value as BatchMergeMode }),
                )}
              >
                {(["none", "merge", "rebase"] as const).map((mode) => (
                  <option key={mode} value={mode}>{MERGE_MODE_LABEL[mode]}</option>
                ))}
              </select>
            </label>
            {actions.mergeMode !== "none" && (
              <label className="bw-inline-input">
                目标分支
                <input
                  type="text"
                  aria-label="目标分支"
                  value={actions.baseBranch ?? "main"}
                  disabled={busyAnywhere}
                  onChange={(event) => setActions((cur) => ({ ...cur, baseBranch: event.target.value }))}
                  placeholder="main"
                />
              </label>
            )}
            <label className="bw-check">
              <input
                type="checkbox"
                checked={actions.push}
                disabled={busyAnywhere}
                onChange={(event) => setActions((cur) => toggleWatchAction(cur, { push: event.target.checked }))}
              />
              推送
            </label>
            <label className="bw-check">
              <input
                type="checkbox"
                checked={actions.deploy}
                disabled={busyAnywhere}
                onChange={(event) => setActions((cur) => toggleWatchAction(cur, { deploy: event.target.checked }))}
              />
              部署
            </label>
          </div>
        </div>

        <div className="field">
          <label htmlFor="bw-extra">额外审核说明（可选）</label>
          <textarea
            id="bw-extra"
            className="bw-textarea"
            rows={2}
            value={extraPrompt}
            disabled={busyAnywhere}
            onChange={(event) => setExtraPrompt(event.target.value)}
            placeholder="例如：重点检查移动端布局回归、合入后按项目规范递增版本号…"
          />
        </div>

        <div className="actions">
          <button
            type="submit"
            className="btn"
            disabled={busyAnywhere || selectedIds.size === 0 || providers.length === 0}
          >
            {busy.has("create") ? "创建中…" : `开始监听（已选 ${selectedIds.size} 个）`}
          </button>
        </div>
      </form>
    </section>
  );
});
