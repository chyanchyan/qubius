import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  EFFORTS,
  PHASE_LABEL,
  getDiff,
  getSessions,
  type Effort,
  type Provider,
  type Session,
} from "../api";
import { getUsage, type SessionUsage } from "../api-usage";
import { effortOptionLabel, formatRelativeTime } from "../format";
import {
  createMultiModelGroup,
  deleteMultiModelGroup,
  getMultiModelGroups,
} from "../api-multi-model";
import {
  MAX_SELECTIONS,
  MIN_SELECTIONS,
  duplicateSelectionIndexes,
  groupMemberStatuses,
  groupsForProject,
  isCurrentResponse,
  nextSelection,
  promptPreview,
  summarizeMembers,
  validateSelections,
  type GroupMember,
  type GroupMemberStatus,
  type MultiModelGroup,
} from "../multi-model";
import type { MultiModelRunProps, RunSelection } from "../run-selection";
import "./MultiModelRun.css";

/**
 * 多模型并行对比入口。BoardPage 只在输入区下方挂载一次：组件自己负责
 * 「多模型」按钮、模型选择对话框和最近对比记录面板。
 */

interface Row {
  key: number;
  providerId: string;
  model: string;
  effort: Effort;
}

let nextRowKey = 1;

function makeRow(selection: RunSelection): Row {
  return { key: nextRowKey++, ...selection };
}

function rowSelection(row: Row): RunSelection {
  return { providerId: row.providerId, model: row.model, effort: row.effort };
}

/** 从当前默认值取一行合法的选择；默认接口被删除时退回第一个接口。 */
function baseSelection(providers: readonly Provider[], defaults: RunSelection): RunSelection {
  const provider = providers.find((item) => item.id === defaults.providerId) ?? providers[0];
  if (!provider) return { providerId: "", model: "", effort: defaults.effort };
  const model = provider.models.includes(defaults.model) ? defaults.model : (provider.models[0] ?? "");
  return { providerId: provider.id, model, effort: defaults.effort };
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "—";
  if (!Number.isFinite(cost) || cost <= 0) return "$0.0000";
  return `$${cost.toFixed(4)}`;
}

function phaseText(status: GroupMemberStatus, loaded: boolean): string {
  if (status.phase !== "unknown") return PHASE_LABEL[status.phase];
  return loaded ? "已删除" : "未刷新";
}

export function MultiModelRun({
  projectId,
  providers,
  defaults,
  disabled,
  createOne,
  onError,
  onDone,
  onOpen,
}: MultiModelRunProps) {
  const [groups, setGroups] = useState<MultiModelGroup[]>([]);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  /** 正在创建时给出 1-based 的当前序号；null 表示空闲。 */
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const submitting = progress !== null;

  const [showPanel, setShowPanel] = useState(false);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [usage, setUsage] = useState<SessionUsage[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [diffStats, setDiffStats] = useState<Record<string, string>>({});
  const [diffState, setDiffState] = useState<Record<string, "loading" | "failed">>({});

  const projectGroups = useMemo(() => groupsForProject(groups, projectId), [groups, projectId]);

  /* 只接受最新一次刷新、且组件仍挂载时的响应。切项目或卸载时一并中止，
     避免旧项目的会话列表覆盖新项目。 */
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /* 分组列表单独用一个序号和 AbortController：它和会话/成本刷新互不影响，
     但切项目时同样要丢弃旧项目的响应。 */
  const groupsSeqRef = useRef(0);
  const groupsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      groupsSeqRef.current += 1;
      groupsAbortRef.current?.abort();
      groupsAbortRef.current = null;
    };
  }, []);

  /* 分组记录存在服务端：挂载和切项目时重新读取，旧项目的响应直接丢弃。 */
  useEffect(() => {
    const seq = ++groupsSeqRef.current;
    groupsAbortRef.current?.abort();
    const controller = new AbortController();
    groupsAbortRef.current = controller;
    setGroupsError(null);
    getMultiModelGroups(projectId, controller.signal)
      .then(({ groups: loaded }) => {
        if (!isCurrentResponse({
          mounted: mountedRef.current,
          seq,
          currentSeq: groupsSeqRef.current,
          aborted: controller.signal.aborted,
        })) {
          return;
        }
        setGroups(loaded);
      })
      .catch((reason) => {
        if (!isCurrentResponse({
          mounted: mountedRef.current,
          seq,
          currentSeq: groupsSeqRef.current,
          aborted: controller.signal.aborted,
        })) {
          return;
        }
        setGroupsError(reason instanceof Error ? reason.message : "无法读取对比记录");
      });
    return () => controller.abort();
  }, [projectId]);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRefreshing(true);
    setRefreshError(null);

    // 两个接口互不阻塞：成本读取失败时仍显示会话状态。
    const [sessionResult, usageResult] = await Promise.allSettled([
      getSessions(projectId, controller.signal),
      getUsage(controller.signal),
    ]);
    if (!isCurrentResponse({
      mounted: mountedRef.current,
      seq,
      currentSeq: seqRef.current,
      aborted: controller.signal.aborted,
    })) {
      return;
    }

    let failure: string | null = null;
    if (sessionResult.status === "fulfilled") {
      setSessions(sessionResult.value.sessions);
    } else {
      failure = sessionResult.reason instanceof Error
        ? sessionResult.reason.message
        : "无法刷新会话状态";
      setRefreshError(failure);
      onError(`多模型对比：${failure}`);
    }
    if (usageResult.status === "fulfilled") {
      setUsage(usageResult.value.bySession);
    } else if (!failure) {
      const usageMessage = usageResult.reason instanceof Error
        ? usageResult.reason.message
        : "无法读取成本数据";
      setRefreshError(`会话已刷新，成本读取失败：${usageMessage}`);
    }
    if (mountedRef.current && seq === seqRef.current) setRefreshing(false);
  }, [onError, projectId]);

  // 切换项目时中止在途请求，并清掉上一个项目的状态和展开项。
  useEffect(() => {
    seqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSessions(null);
    setUsage(null);
    setDiffStats({});
    setDiffState({});
    setShowPanel(false);
    setExpandedGroupId(null);
    setRefreshError(null);
    setRefreshing(false);
  }, [projectId]);

  function openDialog() {
    setRows([makeRow(baseSelection(providers, defaults))]);
    setFormError(null);
    setProgress(null);
    setOpen(true);
  }

  function addRow() {
    const fallback = baseSelection(providers, defaults);
    const used = rows.map(rowSelection);
    setRows([...rows, makeRow(nextSelection(providers, used, fallback))]);
  }

  function removeRow(key: number) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  function patchRow(key: number, patch: Partial<Omit<Row, "key">>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  const selections = useMemo(() => rows.map(rowSelection), [rows]);
  const duplicateIndexes = useMemo(
    () => new Set(duplicateSelectionIndexes(selections)),
    [selections],
  );
  const validation = validateSelections(selections);

  async function submit() {
    if (submitting) return;
    const result = validateSelections(selections);
    if (!result.ok) {
      const message = result.error ?? "请检查模型选择";
      setFormError(message);
      onError(message);
      return;
    }

    setFormError(null);
    const members: GroupMember[] = [];
    let preview = "";
    let savedGroup: MultiModelGroup | null = null;

    try {
      for (let index = 0; index < selections.length; index += 1) {
        const selection = selections[index]!;
        const provider = providers.find((item) => item.id === selection.providerId);
        setProgress({ current: index + 1, total: selections.length });
        try {
          const session = await createOne(selection);
          if (index === 0) preview = session.summary || session.title || "";
          members.push({
            id: session.id,
            providerId: selection.providerId,
            providerName: session.providerName || provider?.name || selection.providerId,
            model: selection.model,
            effort: selection.effort,
            title: session.title,
          });
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "创建失败";
          const label = `${provider?.name || selection.providerId} · ${selection.model} · ${effortOptionLabel(selection.effort)}`;
          onError(
            `多模型对比：${label} 创建失败（${message}）；已成功的 ${members.length} 个会话已保留在列表中`,
          );
          setOpen(false);
          return;
        }
      }

      // 会话都建好后再保存分组；保存失败不能回滚已创建的会话，也不清草稿。
      try {
        const { group } = await createMultiModelGroup(projectId, {
          promptPreview: promptPreview(preview),
          sessions: members,
        });
        savedGroup = group;
        // 作废在途的列表读取，避免旧响应覆盖刚保存的分组。
        groupsSeqRef.current += 1;
        setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)]);
        setGroupsError(null);
        setOpen(false);
        setExpandedGroupId(group.id);
        setShowPanel(true);
        onDone();
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "保存失败";
        onError(`多模型对比：会话已创建，但对比记录保存失败（${message}）`);
        // 会话已经创建，关闭对话框避免重复提交；不调用 onDone，保留草稿。
        setOpen(false);
      }
    } finally {
      setProgress(null);
    }

    // 面板已经打开，顺手拉一次状态和成本；失败时由 refresh 内部提示。
    if (savedGroup) void refresh();
  }

  function togglePanel() {
    const next = !showPanel;
    setShowPanel(next);
    if (next) void refresh();
  }

  function toggleGroup(groupId: string) {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null);
      return;
    }
    setExpandedGroupId(groupId);
    void refresh();
  }

  async function deleteGroup(groupId: string) {
    if (deletingGroupId) return;
    setDeletingGroupId(groupId);
    try {
      await deleteMultiModelGroup(projectId, groupId);
      // 删除成功才改本地状态；作废在途的列表读取，避免旧响应把记录带回来。
      groupsSeqRef.current += 1;
      setGroups((current) => current.filter((item) => item.id !== groupId));
      if (expandedGroupId === groupId) setExpandedGroupId(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "删除失败";
      onError(`多模型对比：删除对比记录失败（${message}）`);
    } finally {
      setDeletingGroupId(null);
    }
  }

  /** 差异按需加载；失败只标记这一行，不打断对比面板，再点一次可重试。 */
  async function loadDiff(sessionId: string) {
    if (diffState[sessionId] === "loading") return;
    setDiffState((state) => ({ ...state, [sessionId]: "loading" }));
    try {
      const { stat } = await getDiff(sessionId);
      if (!mountedRef.current) return;
      const firstLine = stat.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
      setDiffStats((state) => ({ ...state, [sessionId]: firstLine || "无改动" }));
      setDiffState((state) => {
        const next = { ...state };
        delete next[sessionId];
        return next;
      });
    } catch {
      if (!mountedRef.current) return;
      setDiffState((state) => ({ ...state, [sessionId]: "failed" }));
    }
  }

  const groupCount = projectGroups.length;

  return (
    <div className="multi-model">
      <div className="multi-model-bar">
        <button
          type="button"
          className="multi-model-btn"
          disabled={disabled || submitting || providers.length === 0}
          title={
            providers.length === 0
              ? "先在设置里添加接口和模型"
              : "同一个提示用多个模型各建一个会话并对比"
          }
          onClick={openDialog}
        >
          多模型
        </button>
        {progress && (
          <span className="multi-model-progress" role="status">
            正在创建 {progress.current}/{progress.total}
          </span>
        )}
        {groupCount > 0 && (
          <button
            type="button"
            className="multi-model-history"
            aria-expanded={showPanel}
            onClick={togglePanel}
          >
            对比记录 <span className="multi-model-count">{groupCount}</span>
            <span className="multi-model-caret" data-open={showPanel || undefined} aria-hidden="true">▾</span>
          </button>
        )}
      </div>
      {groupsError && (
        <p className="multi-model-error">对比记录读取失败：{groupsError}</p>
      )}

      {showPanel && groupCount > 0 && (
        <div className="multi-model-panel">
          <div className="multi-model-panel-head">
            <span className="multi-model-panel-title">最近的多模型对比</span>
            <button
              type="button"
              className="multi-model-refresh"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? "刷新中…" : "刷新"}
            </button>
          </div>
          {refreshError && <p className="multi-model-error">{refreshError}</p>}
          {projectGroups.map((item) => {
            const expanded = expandedGroupId === item.id;
            const statuses = groupMemberStatuses(item, sessions, usage);
            const summary = summarizeMembers(statuses);
            return (
              <section className="multi-model-group" key={item.id} data-open={expanded || undefined}>
                <div className="multi-model-group-head">
                  <button
                    type="button"
                    className="multi-model-group-toggle"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(item.id)}
                  >
                    <span className="multi-model-group-caret" data-open={expanded || undefined} aria-hidden="true">▸</span>
                    <span className="multi-model-group-preview" title={item.promptPreview}>
                      {item.promptPreview || "（无提示摘要）"}
                    </span>
                    <span className="multi-model-group-meta">
                      {summary.total} 个 · {sessions === null ? "—" : formatCost(summary.cost)}
                    </span>
                    <span className="multi-model-group-time">{formatRelativeTime(item.createdAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="multi-model-group-delete"
                    aria-label="删除这组对比记录"
                    disabled={deletingGroupId === item.id}
                    onClick={() => void deleteGroup(item.id)}
                  >
                    {deletingGroupId === item.id ? "删除中…" : "删除"}
                  </button>
                </div>
                {expanded && (
                  <div className="multi-model-members">
                    {statuses.map((status) => {
                      const diffStateValue = diffState[status.id];
                      return (
                        <div className="multi-model-member" key={status.id} data-phase={status.phase}>
                          <div className="multi-model-member-main">
                            <span
                              className="multi-model-member-model"
                              title={`${status.providerName} · ${status.model}`}
                            >
                              {status.model}
                            </span>
                            <span className="multi-model-member-provider">{status.providerName}</span>
                            <span className="multi-model-member-effort">{effortOptionLabel(status.effort)}</span>
                            <span className="multi-model-member-phase" data-phase={status.phase}>
                              {phaseText(status, sessions !== null)}
                            </span>
                            {status.branch && (
                              <span className="multi-model-member-branch" title={status.branch}>{status.branch}</span>
                            )}
                            <span className="multi-model-member-cost">{formatCost(status.cost)}</span>
                          </div>
                          <div className="multi-model-member-actions">
                            <button
                              type="button"
                              className="text-btn"
                              disabled={!status.present}
                              title={status.present ? undefined : "会话已删除或尚未刷新"}
                              onClick={() => onOpen(status.id)}
                            >
                              打开
                            </button>
                            <button
                              type="button"
                              className="text-btn"
                              disabled={diffStateValue === "loading"}
                              onClick={() => void loadDiff(status.id)}
                            >
                              {diffStateValue === "loading" ? "差异…" : "差异"}
                            </button>
                            {diffStats[status.id] && (
                              <span className="multi-model-member-diff" title={diffStats[status.id]}>
                                {diffStats[status.id]}
                              </span>
                            )}
                            {diffStateValue === "failed" && (
                              <span className="multi-model-member-diff" data-failed="true">差异不可用</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {open && typeof document !== "undefined" && createPortal(
        <div
          className="multi-model-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget && !submitting) setOpen(false);
          }}
        >
          <div
            className="multi-model-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="多模型并行对比"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !submitting) setOpen(false);
            }}
          >
            <div className="multi-model-dialog-head">
              <div className="multi-model-dialog-copy">
                <strong>多模型并行对比</strong>
                <p>同一个提示分别用多个模型各建一个独立会话，完成后可在对比记录里查看结果。</p>
              </div>
              <button
                type="button"
                className="multi-model-dialog-close"
                aria-label="关闭"
                disabled={submitting}
                onClick={() => setOpen(false)}
              >×</button>
            </div>

            {providers.length === 0 ? (
              <p className="multi-model-dialog-empty">还没有可用的接口配置，请先到设置页添加接口和模型。</p>
            ) : (
              <>
                <div className="multi-model-rows">
                  {rows.map((row, index) => {
                    const provider = providers.find((item) => item.id === row.providerId);
                    const models = provider?.models ?? [];
                    return (
                      <div
                        className="multi-model-row"
                        key={row.key}
                        data-duplicate={duplicateIndexes.has(index) || undefined}
                      >
                        <span className="multi-model-row-index">{index + 1}</span>
                        <select
                          className="multi-model-select"
                          aria-label={`第 ${index + 1} 行的接口`}
                          value={row.providerId}
                          disabled={submitting}
                          onChange={(event) => {
                            const nextProvider = providers.find((item) => item.id === event.target.value);
                            patchRow(row.key, {
                              providerId: event.target.value,
                              model: nextProvider?.models[0] ?? "",
                            });
                          }}
                        >
                          {providers.map((item) => (
                            <option key={item.id} value={item.id}>{item.name}</option>
                          ))}
                        </select>
                        <select
                          className="multi-model-select"
                          aria-label={`第 ${index + 1} 行的模型`}
                          value={row.model}
                          disabled={submitting}
                          onChange={(event) => patchRow(row.key, { model: event.target.value })}
                        >
                          {models.length === 0 && (
                            <option value={row.model}>{row.model || "没有模型"}</option>
                          )}
                          {models.map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                        <select
                          className="multi-model-select multi-model-effort"
                          aria-label={`第 ${index + 1} 行的思考强度`}
                          value={row.effort}
                          disabled={submitting}
                          onChange={(event) => patchRow(row.key, { effort: event.target.value as Effort })}
                        >
                          {EFFORTS.map((effort) => (
                            <option key={effort} value={effort}>{effortOptionLabel(effort)}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="multi-model-row-remove"
                          aria-label={`删除第 ${index + 1} 行`}
                          disabled={submitting || rows.length <= 1}
                          onClick={() => removeRow(row.key)}
                        >×</button>
                      </div>
                    );
                  })}
                </div>

                {duplicateIndexes.size > 0 && (
                  <p className="multi-model-hint" data-tone="warn">
                    有重复的接口 + 模型 + 强度组合，请调整。
                  </p>
                )}
                {rows.length < MIN_SELECTIONS && (
                  <p className="multi-model-hint">至少添加 {MIN_SELECTIONS} 行才能对比。</p>
                )}
                {!validation.ok && rows.length >= MIN_SELECTIONS && duplicateIndexes.size === 0 && (
                  <p className="multi-model-hint">{validation.error}</p>
                )}
                {formError && (
                  <p className="multi-model-hint" data-tone="error">{formError}</p>
                )}

                <div className="multi-model-dialog-actions">
                  <button
                    type="button"
                    className="text-btn"
                    disabled={submitting || rows.length >= MAX_SELECTIONS}
                    onClick={addRow}
                  >添加模型</button>
                  <span className="multi-model-dialog-spacer" />
                  <button
                    type="button"
                    className="text-btn"
                    disabled={submitting}
                    onClick={() => setOpen(false)}
                  >取消</button>
                  <button
                    type="button"
                    className="multi-model-submit"
                    disabled={submitting || !validation.ok}
                    onClick={() => void submit()}
                  >
                    {submitting && progress
                      ? `正在创建 ${progress.current}/${progress.total}`
                      : "开始对比"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
