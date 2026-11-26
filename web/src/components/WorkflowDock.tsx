import { useEffect, useId, useState } from "react";
import { SUBAGENT_LABEL, type Session, type Subagent } from "../api";
import {
  deriveWorkflow,
  formatElapsed,
  prlTrackCells,
  unitStages,
  type WorkflowAgent,
  type WorkflowSkill,
  type WorkflowTrackState,
  type WorkflowUnit,
  type WorkflowUnitState,
  type WorkflowView,
} from "../workflow-progress";
import "./WorkflowDock.css";

/* prl / plan 的展开阶段条；ser 用单元队列代替。 */
const PRL_STAGES = ["分析", "开发", "评审", "修复", "集成"];
const PLAN_STAGES = ["分析", "制定", "评审", "修改", "整理"];

/** 角色 pill 沿用 agent 原始状态命名。 */
type PillState = "done" | "running" | "failed" | "stopped" | "pending";

function trackFromAgent(status?: Subagent["status"]): WorkflowTrackState {
  if (status === "completed") return "done";
  if (status === "running") return "active";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  return "pending";
}

function trackFromUnit(state: WorkflowUnitState): WorkflowTrackState {
  switch (state) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "dev-running":
    case "review-running":
    case "fixing":
      return "active";
    default:
      return "pending";
  }
}

function pillFromAgent(agent?: WorkflowAgent): PillState {
  if (!agent) return "pending";
  if (agent.status === "completed") return "done";
  if (agent.status === "running") return "running";
  if (agent.status === "failed") return "failed";
  if (agent.status === "stopped") return "stopped";
  return "pending";
}

function unitStateLabel(state: WorkflowUnitState, skill: WorkflowSkill): string {
  switch (state) {
    case "pending":
      return "等待";
    case "dev-running":
      return skill === "plan" ? "制定中" : "开发中";
    case "waiting-review":
      return "待评审";
    case "review-running":
      return "评审中";
    case "fixing":
      return skill === "plan" ? "修改中" : "修复中";
    case "done":
      return "通过";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
  }
}

/** 当前正在跑的角色 agent；用于显示工具名。 */
function runningAgent(unit: WorkflowUnit): WorkflowAgent | undefined {
  if (unit.dev?.status === "running") return unit.dev;
  if (unit.review?.status === "running") return unit.review;
  if (unit.agent?.status === "running") return unit.agent;
  return undefined;
}

function unitLabel(unit: WorkflowUnit, skill: WorkflowSkill): string {
  if (unit.unit === "final") return "集成";
  return skill === "prl" ? `子任务${unit.unit}` : `u${unit.unit}`;
}

function trackValueText(view: WorkflowView): string {
  const steps = `已完成 ${view.stepsDone}/${view.stepsTotal} 步`;
  return view.unitTotal > 0 ? `${steps}，${view.doneUnits}/${view.unitTotal} 个单元` : steps;
}

/** ser / plan 沿用原来的轨道：有标签按开发+评审两格，无标签一单元一格。 */
function legacyTrackCells(view: WorkflowView, labeled: boolean): WorkflowTrackState[] {
  const cells: WorkflowTrackState[] = [];
  if (labeled) {
    for (const unit of view.units) {
      if (unit.unit === "final") {
        cells.push(trackFromUnit(unit.state));
      } else {
        cells.push(trackFromAgent(unit.dev?.status));
        cells.push(trackFromAgent(unit.review?.status));
      }
    }
  } else {
    for (const unit of view.units) cells.push(trackFromUnit(unit.state));
  }
  return cells;
}

/**
 * 对话详情页输入框上方的常驻工作流进度条。
 *
 * 折叠时一行显示状态、阶段和用时，展开后按 skill 展示阶段条/单元队列和
 * 每个单元的开发、评审状态。只有派生视图处于推进中时才每秒刷新用时。
 */
export function WorkflowDock({ session }: { session: Session }) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const view = deriveWorkflow(session, now);
  const active = view?.active ?? false;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!view) return null;

  const prl = view.skill === "prl";
  const stageDefs = view.skill === "plan" ? PLAN_STAGES : prl ? PRL_STAGES : null;
  const numericUnits = view.units.filter((unit) => typeof unit.unit === "number");
  /* 有 `[wf:...]` 标签时单元按开发/评审两格展示；无标签回退成一个子任务一格。 */
  const labeled = view.units.some((unit) => unit.agent === undefined);
  const trackCells: WorkflowTrackState[] = prl
    ? prlTrackCells(view)
    : legacyTrackCells(view, labeled);
  const trackDone = prl
    ? trackCells.filter((state) => state === "done").length
    : view.stepsDone;
  const trackTotal = prl ? trackCells.length : view.stepsTotal;
  const trackText = prl
    ? `已完成 ${trackDone}/${trackTotal} 个阶段`
    : trackValueText(view);

  return (
    <div
      className="wf-dock"
      data-state={view.state}
      data-failures={view.hasFailures ? "true" : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return;
        event.stopPropagation();
        setExpanded(false);
      }}
    >
      <div className="wf-head">
        <button
          type="button"
          className="wf-summary"
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="wf-dot" data-state={view.state} aria-hidden="true" />
          <span className="wf-skill" data-skill={view.skill}>{view.skill}</span>
          <span className="wf-stage">{view.stage}</span>
          {view.detail && <span className="wf-detail">{view.detail}</span>}
          {view.current && <span className="wf-current">{view.current}</span>}
          <span className="wf-elapsed">{formatElapsed(view.elapsedMs)}</span>
          <svg
            className="wf-chevron"
            data-open={expanded ? "true" : undefined}
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path
              d="M4 6l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {trackCells.length > 0 && (
          <div
            className="wf-track"
            role="progressbar"
            aria-label="工作流进度"
            aria-valuemin={0}
            aria-valuemax={trackTotal}
            aria-valuenow={trackDone}
            aria-valuetext={trackText}
          >
            {trackCells.map((state, index) => (
              <span key={index} className="wf-track-cell" data-state={state} />
            ))}
          </div>
        )}
      </div>
      {expanded && (
        <div className="wf-panel" id={panelId}>
          {stageDefs && (
            <div className="wf-stages" aria-label="工作流阶段">
              {stageDefs.map((label, index) => (
                <span
                  key={label}
                  className="wf-stage-chip"
                  data-stage={view.stageIndex > index ? "done" : view.stageIndex === index ? "active" : "pending"}
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          {view.skill === "ser" && numericUnits.length > 0 && (
            <div className="wf-queue" aria-label="单元队列">
              {numericUnits.map((unit) => (
                <span
                  key={String(unit.unit)}
                  className="wf-queue-dot"
                  data-state={trackFromUnit(unit.state)}
                  data-focus={view.focusUnit?.unit === unit.unit ? "true" : undefined}
                >
                  u{unit.unit}
                </span>
              ))}
            </div>
          )}
          {view.skill === "ser" && view.focusUnit && typeof view.focusUnit.unit === "number" && (
            <p className="wf-focus">当前单元 {view.focusUnit.unit}/{view.unitTotal} · {view.focusUnit.title}</p>
          )}
          {view.units.length > 0 && (
            <div className="wf-units">
              {view.units.map((unit) => {
                const agent = runningAgent(unit);
                const devLabel = view.skill === "plan" ? "计划" : "开发";
                const stages = prl ? unitStages(unit, view.skill) : [];
                const shownStages = stages.slice(-3);
                return (
                  <div className={prl ? "wf-unit wf-unit-prl" : "wf-unit"} data-state={unit.state} key={String(unit.unit)}>
                    <span className="wf-unit-id">{unitLabel(unit, view.skill)}</span>
                    <span className="wf-unit-title" title={unit.title}>{unit.title}</span>
                    {prl ? (
                      <>
                        <span className="wf-unit-stages" title={stages.map((stage) => stage.label).join(" → ")}>
                          {stages.length > shownStages.length && (
                            <span className="wf-stage-more" aria-hidden="true">…</span>
                          )}
                          {shownStages.map((stage, index) => (
                            <span className="wf-pill" data-state={stage.state} key={`${index}-${stage.label}`}>
                              {stage.label}
                            </span>
                          ))}
                        </span>
                        {unit.durationMs !== undefined && (
                          <span className="wf-unit-elapsed">{formatElapsed(unit.durationMs)}</span>
                        )}
                      </>
                    ) : (
                      <>
                        {labeled ? (
                          <>
                            <span className="wf-pill" data-state={pillFromAgent(unit.dev)}>{devLabel}</span>
                            <span className="wf-pill" data-state={pillFromAgent(unit.review)}>评审</span>
                          </>
                        ) : (
                          <span className="wf-pill" data-state={pillFromAgent(unit.agent)}>子任务</span>
                        )}
                        <span className="wf-unit-state">{unitStateLabel(unit.state, view.skill)}</span>
                        {agent?.lastToolName && <span className="wf-unit-tool">{agent.lastToolName}</span>}
                        {unit.runs > 1 && <span className="wf-unit-runs">×{unit.runs}</span>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {view.units.length === 0 && view.extras.length === 0 && (
            <p className="wf-empty">等待子任务</p>
          )}
          {view.extras.length > 0 && (
            <div className="wf-extras">
              <span className="wf-section-label">其他子任务</span>
              {view.extras.map((extra) => (
                <div className="wf-extra" key={extra.taskId}>
                  <span className="wf-extra-title">{extra.title}</span>
                  <span className="wf-extra-state">{SUBAGENT_LABEL[extra.status]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
