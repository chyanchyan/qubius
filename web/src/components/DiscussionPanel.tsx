import { useState } from "react";
import {
  EFFORTS,
  type DiscussionKind,
  type DiscussionParticipant,
  type DiscussionSubtaskState,
  type Effort,
  type Provider,
  type Session,
} from "../api";
import { effortOptionLabel } from "../format";
import "./DiscussionPanel.css";

/**
 * 多模型讨论的参与模型列表。
 *
 * 讨论模式下发送消息后，会话先停在这里：用户添加若干行（名称 / 模型 /
 * effort），点「开始讨论」后服务端依次调用这些模型。讨论结束后面板保留
 * 上一次的参与者，可以直接修改后再讨论一轮。
 */

/** 与服务端 MAX_DISCUSSION_PARTICIPANTS 保持一致。 */
const MAX_PARTICIPANTS = 8;

const KIND_LABEL: Record<DiscussionKind, string> = {
  decompose: "拆分",
  answer: "回答",
  review: "审阅",
  rebuttal: "答辩",
  final: "最终结论",
};

interface Row {
  key: number;
  name: string;
  providerId: string;
  model: string;
  effort: Effort;
}

let nextRowKey = 1;

function defaultRow(providers: Provider[], effort: Effort): Row {
  const provider = providers[0];
  const model = provider?.models[0] ?? "";
  return {
    key: nextRowKey++,
    name: model,
    providerId: provider?.id ?? "",
    model,
    effort,
  };
}

function rowsFromSession(session: Session, providers: Provider[]): Row[] {
  const saved = session.discussion?.participants ?? [];
  if (saved.length === 0) return [];
  return saved.map((participant) => ({
    key: nextRowKey++,
    name: participant.name,
    providerId: participant.providerId,
    model: participant.model,
    effort: participant.effort,
  }));
}

/** 某一行可选的接口配置：当前保存的 provider 已从设置里删除时补一个占位项。 */
function providerOptions(row: Row, providers: Provider[]): Array<{ id: string; label: string; models: string[] }> {
  const options = providers.map((provider) => ({
    id: provider.id,
    label: provider.name,
    models: provider.models,
  }));
  if (row.providerId && !options.some((provider) => provider.id === row.providerId)) {
    options.unshift({ id: row.providerId, label: "已删除的接口", models: [row.model] });
  }
  return options;
}

/** 并行讨论里一个子任务的状态文案；没有正在发言时显示阶段。 */
function subtaskStatusText(
  subtask: DiscussionSubtaskState,
  participants: DiscussionParticipant[],
): string {
  if (subtask.phase === "running") {
    const active = subtask.activeIndex === undefined ? undefined : participants[subtask.activeIndex];
    const kind = subtask.activeKind ? KIND_LABEL[subtask.activeKind] : "";
    const round = subtask.round > 1 ? `第 ${subtask.round} 轮 · ` : "";
    if (active && kind) return `${round}${active.name} ${kind}中…`;
    return "准备中…";
  }
  if (subtask.phase === "completed") {
    return subtask.agreed === false ? "已完成 · 仍有分歧" : "已完成";
  }
  if (subtask.phase === "failed") return subtask.error ? `失败：${subtask.error}` : "失败";
  return "已停止";
}

function statusText(session: Session): string {
  const discussion = session.discussion;
  if (!discussion) return "";
  const parallel = discussion.strategy === "parallel";
  if (discussion.phase === "setup") return "添加参与讨论的模型后开始";
  if (discussion.phase === "running") {
    if (parallel) {
      if (discussion.integrating) {
        const active = discussion.participants[discussion.activeIndex ?? -1];
        const kind = discussion.activeKind ? KIND_LABEL[discussion.activeKind] : "发言";
        const round = discussion.round > 0 ? `第 ${discussion.round} 轮 · ` : "";
        return `集成讨论 · ${round}${active ? `${active.name} ${kind}中…` : "准备中…"}`;
      }
      const subtasks = discussion.subtasks ?? [];
      if (subtasks.length === 0) {
        // 拆分不可靠时会退回普通讨论，这时还没有子任务，按普通进度显示。
        if (discussion.activeKind && discussion.activeIndex !== undefined) {
          const active = discussion.participants[discussion.activeIndex];
          const kind = KIND_LABEL[discussion.activeKind];
          const round = discussion.round > 0 ? `第 ${discussion.round} 轮 · ` : "";
          return `${round}${active ? `${active.name} ${kind}中…` : "准备中…"}`;
        }
        const lead = discussion.participants[0];
        return lead ? `${lead.name} 正在拆分主题…` : "正在拆分主题…";
      }
      const done = subtasks.filter((item) => item.phase !== "running").length;
      return `并行讨论 · ${done}/${subtasks.length} 个子任务完成`;
    }
    const active = discussion.participants[discussion.activeIndex ?? -1];
    const kind = discussion.activeKind ? KIND_LABEL[discussion.activeKind] : "发言";
    const round = discussion.round > 0 ? `第 ${discussion.round} 轮 · ` : "";
    return `${round}${active ? `${active.name} ${kind}中…` : "准备中…"}`;
  }
  if (discussion.phase === "completed") {
    const prefix = parallel ? "并行讨论完成" : "讨论完成";
    if (parallel && (discussion.subtasks ?? []).some((item) => item.phase === "failed")) {
      return `${prefix} · 部分子任务失败`;
    }
    return discussion.agreed === false ? `${prefix} · 仍有分歧` : `${prefix} · 所有模型达成一致`;
  }
  if (discussion.phase === "stopped") return parallel ? "并行讨论已停止" : "讨论已停止";
  return discussion.error ? `讨论失败：${discussion.error}` : "讨论失败";
}

export function DiscussionPanel({
  session,
  providers,
  onStart,
  onError,
}: {
  session: Session;
  providers: Provider[];
  onStart: (participants: DiscussionParticipant[]) => Promise<void>;
  onError: (message: string) => void;
}) {
  const discussion = session.discussion;
  const [rows, setRows] = useState<Row[]>(() => rowsFromSession(session, providers));
  const [starting, setStarting] = useState(false);
  if (!discussion) return null;
  const running = discussion.phase === "running";
  const parallel = discussion.strategy === "parallel";
  const subtasks = discussion.subtasks ?? [];

  function addRow() {
    setRows((current) => {
      if (current.length >= MAX_PARTICIPANTS) return current;
      return [...current, defaultRow(providers, session.effort)];
    });
  }

  function patchRow(key: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removeRow(key: number) {
    setRows((current) => current.filter((row) => row.key !== key));
  }

  async function start() {
    if (starting) return;
    if (rows.length === 0) {
      onError("请先添加参与讨论的模型");
      return;
    }
    const participants: DiscussionParticipant[] = rows.map((row) => {
      const provider = providers.find((item) => item.id === row.providerId);
      return {
        name: row.name.trim() || row.model,
        providerId: row.providerId,
        providerName: provider?.name ?? "已删除的接口",
        model: row.model,
        effort: row.effort,
      };
    });
    setStarting(true);
    try {
      await onStart(participants);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "无法开始讨论");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="discussion-panel" data-phase={discussion.phase}>
      <div className="discussion-head">
        <span className="discussion-title">{parallel ? "并行讨论" : "多模型讨论"}</span>
        <span className="discussion-status" data-state={discussion.phase}>{statusText(session)}</span>
      </div>
      {running ? (
        parallel && subtasks.length > 0 ? (
          <ol className="discussion-running discussion-subtasks">
            {subtasks.map((subtask) => (
              <li
                key={subtask.index}
                className="discussion-running-item"
                data-phase={subtask.phase}
                data-active={subtask.phase === "running" || undefined}
              >
                <span className="discussion-index">{subtask.index}</span>
                <span className="discussion-running-name">{subtask.title}</span>
                <span className="discussion-running-kind">{subtaskStatusText(subtask, discussion.participants)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <ol className="discussion-running">
            {discussion.participants.map((participant, index) => (
              <li
                key={`${participant.name}:${index}`}
                className="discussion-running-item"
                data-active={discussion.activeIndex === index || undefined}
              >
                <span className="discussion-index">{index + 1}</span>
                <span className="discussion-running-name">{participant.name}</span>
                <span className="discussion-running-model">{participant.model} · {effortOptionLabel(participant.effort)}</span>
                {discussion.activeIndex === index && discussion.activeKind && (
                  <span className="discussion-running-kind">{KIND_LABEL[discussion.activeKind]}中</span>
                )}
              </li>
            ))}
          </ol>
        )
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="discussion-empty">
              {providers.length === 0
                ? "还没有可用的接口配置，先到设置页添加接口和模型。"
                : "还没有参与模型。添加一行，选择名称、模型和 effort。"}
            </p>
          ) : (
            <div className="discussion-rows">
              {rows.map((row, index) => {
                const options = providerOptions(row, providers);
                const models = options.find((provider) => provider.id === row.providerId)?.models ?? [];
                return (
                  <div className="discussion-row" key={row.key}>
                    <span className="discussion-index">{index + 1}</span>
                    <input
                      className="discussion-name"
                      value={row.name}
                      placeholder="名称"
                      maxLength={40}
                      aria-label={`第 ${index + 1} 个模型的名称`}
                      onChange={(event) => patchRow(row.key, { name: event.target.value })}
                    />
                    {options.length > 1 && (
                      <select
                        className="discussion-select"
                        value={row.providerId}
                        aria-label={`第 ${index + 1} 个模型的接口`}
                        onChange={(event) => {
                          const provider = options.find((item) => item.id === event.target.value);
                          patchRow(row.key, {
                            providerId: event.target.value,
                            model: provider?.models[0] ?? "",
                          });
                        }}
                      >
                        {options.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.label}</option>
                        ))}
                      </select>
                    )}
                    <select
                      className="discussion-select"
                      value={row.model}
                      aria-label={`第 ${index + 1} 个模型的模型`}
                      onChange={(event) => patchRow(row.key, { model: event.target.value })}
                    >
                      {models.length === 0 && <option value={row.model}>{row.model || "没有模型"}</option>}
                      {models.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                    <select
                      className="discussion-select discussion-effort"
                      value={row.effort}
                      aria-label={`第 ${index + 1} 个模型的思考强度`}
                      onChange={(event) => patchRow(row.key, { effort: event.target.value as Effort })}
                    >
                      {EFFORTS.map((effort) => (
                        <option key={effort} value={effort}>{effortOptionLabel(effort)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="discussion-remove"
                      aria-label={`删除第 ${index + 1} 个模型`}
                      disabled={starting}
                      onClick={() => removeRow(row.key)}
                    >×</button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="discussion-actions">
            <button
              type="button"
              className="discussion-add"
              disabled={starting || providers.length === 0 || rows.length >= MAX_PARTICIPANTS}
              onClick={addRow}
            >添加模型</button>
            <button
              type="button"
              className="discussion-start"
              disabled={starting || rows.length === 0}
              onClick={() => void start()}
            >
              {starting
                ? "正在开始…"
                : discussion.phase === "setup"
                  ? (parallel ? "开始并行讨论" : "开始讨论")
                  : (parallel ? "重新并行讨论" : "重新讨论")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
