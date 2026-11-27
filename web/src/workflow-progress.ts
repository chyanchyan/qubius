import type { Session, Subagent, WorkflowSkill } from "./api";

/**
 * prl / ser 底部进度条的纯逻辑。
 *
 * 子任务描述由 skill 约定成 `[wf:prl:1/4:dev] 登录接口` 的形式，这里解析标签、
 * 按单元聚合子任务并推导阶段，不依赖 React/DOM，方便单独测试。
 */

export type { WorkflowSkill } from "./api";
export type WorkflowRole = "dev" | "review" | "agent";
export type WorkflowState = "queued" | "running" | "wait" | "done" | "failed" | "stopped";
export type WorkflowUnitState =
  | "pending"
  | "dev-running"
  | "waiting-review"
  | "review-running"
  | "fixing"
  | "done"
  | "failed"
  | "stopped";

export interface ParsedAgentTag {
  skill: WorkflowSkill;
  unit: number | "final";
  total: number;
  role: "dev" | "review";
  title: string;
}

export interface WorkflowAgent {
  taskId: string;
  title: string;
  role: WorkflowRole;
  unit: number | "final" | "extra";
  status: Subagent["status"];
  summary?: string;
  lastToolName?: string;
  runs: number;
  startedAt?: string;
  endedAt?: string;
}

export interface WorkflowUnit {
  unit: number | "final";
  title: string;
  dev?: WorkflowAgent;
  review?: WorkflowAgent;
  /** 没有标签时，一个子任务就是一个单元。 */
  agent?: WorkflowAgent;
  state: WorkflowUnitState;
  runs: number;
  /** 开发和评审各自的累计运行次数，用来还原阶段历史。 */
  devRuns: number;
  reviewRuns: number;
  /** 单元从最早开始到最近结束（运行中取当前时间）的用时。 */
  durationMs?: number;
}

export interface WorkflowView {
  skill: WorkflowSkill;
  state: WorkflowState;
  /** 仍在推进（running / wait），组件据此决定是否每秒刷新用时。 */
  active: boolean;
  hasFailures: boolean;
  stage: string;
  detail: string;
  /** 当前在跑的子任务，例如 `u3 评审中 · Read`。 */
  current: string;
  units: WorkflowUnit[];
  /** 工作流里的无标签子任务，不计入进度，只展示。 */
  extras: WorkflowAgent[];
  unitTotal: number;
  doneUnits: number;
  failedUnits: number;
  stepsDone: number;
  stepsTotal: number;
  percent: number;
  elapsedMs: number;
  /** 0 分析 / 1 开发 / 2 评审 / 3 修复 / 4 集成 / 5 完成 */
  stageIndex: number;
  /** ser 的“当前单元”；没有未完成单元时是最后一个。 */
  focusUnit?: WorkflowUnit;
}

const TAG_RE = /^\[wf:(prl|ser|plan):(?:(\d{1,3})\/(\d{1,3})|final):(dev|review)\]\s*([\s\S]*)$/;

/** 解析 skill 写入子任务 description 的进度标签；格式不对时返回 null。 */
export function parseAgentTag(description: string): ParsedAgentTag | null {
  const match = TAG_RE.exec(description);
  if (!match) return null;
  const skill = match[1] as WorkflowSkill;
  const role = match[4] as "dev" | "review";
  const title = (match[5] ?? "").trim();
  if (match[2] === undefined) {
    return { skill, unit: "final", total: 0, role, title };
  }
  const unit = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isInteger(unit) || !Number.isInteger(total) || unit < 1 || total < 1 || unit > total || total > 50) return null;
  return { skill, unit, total, role, title };
}

/** 去掉标签后的展示名；没有标签或标签非法时原样返回。 */
export function stripAgentTag(description: string): string {
  const parsed = parseAgentTag(description);
  if (!parsed) return description;
  if (parsed.title) return parsed.title;
  return parsed.unit === "final" ? "集成评审" : "子任务";
}

/** 毫秒转 `mm:ss`，超过一小时转 `h:mm:ss`。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 由会话当前状态推导进度条视图；没有工作流时返回 null。 */
export function deriveWorkflow(session: Session, now: number): WorkflowView | null {
  const workflow = session.workflow;
  if (!workflow) return null;
  // 多模型讨论（包括并行讨论）和 prl-role 都有自己的进度面板，不走 prl/ser/plan 的轨道。
  if (workflow.skill === "discuss" || workflow.skill === "dis-prl" || workflow.skill === "prl-role") return null;

  const scoped = session.subagents.filter((agent) => agent.workflowAt === workflow.startedAt);
  const tagged: Array<{ agent: Subagent; tag: ParsedAgentTag }> = [];
  const untagged: Subagent[] = [];
  for (const agent of scoped) {
    const tag = parseAgentTag(agent.description);
    if (tag && tag.skill === workflow.skill) tagged.push({ agent, tag });
    else untagged.push(agent);
  }

  const units: WorkflowUnit[] = [];
  let extras: WorkflowAgent[] = [];
  let unitTotal = 0;

  if (tagged.length > 0) {
    const groups = new Map<number | "final", { dev: Subagent[]; review: Subagent[]; title: string; total: number }>();
    for (const { agent, tag } of tagged) {
      let group = groups.get(tag.unit);
      if (!group) {
        group = { dev: [], review: [], title: "", total: 0 };
        groups.set(tag.unit, group);
      }
      if (tag.role === "dev") group.dev.push(agent);
      else group.review.push(agent);
      if (!group.title && tag.title) group.title = tag.title;
      if (tag.unit !== "final") group.total = Math.max(group.total, tag.total);
    }
    if (workflow.skill === "prl") {
      // prl 的单元在同一条消息里并行启动，标签里的总数只是声明值：
      // 只按真正出现的子任务建单元，避免标签总数偏大时多出没有工作的
      // “单元 N”占位行，和子任务列表里的实际数量对不上。
      const started = [...groups.keys()]
        .filter((unit): unit is number => unit !== "final")
        .sort((a, b) => a - b);
      unitTotal = started.length;
      for (const unit of started) units.push(makeUnit(unit, groups.get(unit), unit, now));
    } else {
      // ser / plan 是串行队列，还没轮到的单元保留占位行，展示整体排队进度。
      for (const group of groups.values()) unitTotal = Math.max(unitTotal, group.total);
      for (let index = 1; index <= unitTotal; index += 1) {
        units.push(makeUnit(index, groups.get(index), index, now));
      }
    }
    const final = groups.get("final");
    if (final) units.push(makeUnit("final", final, unitTotal + 1, now));
    extras = untagged.map((agent) => toAgent(agent, "agent", "extra"));
  } else {
    for (const [index, agent] of scoped.entries()) {
      const item = toAgent(agent, "agent", index + 1);
      units.push({
        unit: index + 1,
        title: item.title,
        agent: item,
        state: agent.status === "completed"
          ? "done"
          : agent.status === "running"
            ? "dev-running"
            : agent.status,
        runs: item.runs,
        devRuns: 0,
        reviewRuns: 0,
        durationMs: unitTiming([item], now).durationMs,
      });
    }
    unitTotal = units.length;
  }

  const numericUnits = units.filter((unit) => unit.unit !== "final");
  const doneUnits = numericUnits.filter((unit) => unit.state === "done").length;
  const failedUnits = numericUnits.filter((unit) => unit.state === "failed").length;
  const hasFailures = scoped.some((agent) => agent.status === "failed");

  let stepsTotal = 0;
  let stepsDone = 0;
  if (tagged.length > 0) {
    for (const unit of units) {
      if (unit.unit === "final") {
        if (unit.dev || unit.review) {
          stepsTotal += 1;
          if (unit.state === "done") stepsDone += 1;
        }
        continue;
      }
      stepsTotal += 2;
      if (unit.dev?.status === "completed") stepsDone += 1;
      if (unit.review?.status === "completed") stepsDone += 1;
    }
  } else {
    stepsTotal = units.length;
    stepsDone = units.filter((unit) => unit.agent?.status === "completed").length;
  }

  const state = workflowState(session);
  const percent = state === "done"
    ? 100
    : stepsTotal === 0
      ? 0
      : Math.min(99, Math.round((stepsDone / stepsTotal) * 100));

  const fixing = units.find((unit) => unit.state === "fixing");
  const devRunning = numericUnits.some((unit) => unit.state === "dev-running" || unit.state === "fixing");
  const reviewRunning = numericUnits.some((unit) => unit.state === "review-running");
  const focusUnit = numericUnits.find((unit) => unit.state !== "done")
    ?? units[units.length - 1];
  const focusIndex = typeof focusUnit?.unit === "number" ? focusUnit.unit : undefined;

  let stage: string;
  let detail: string;
  if (state === "queued") {
    stage = "排队中";
    detail = "";
  } else if (state === "wait") {
    stage = "等待确认";
    detail = session.pending?.toolName ?? "";
  } else if (state === "done") {
    stage = workflow.skill === "plan" ? "计划完成" : "完成";
    detail = unitTotal > 0 ? `${doneUnits}/${unitTotal} 单元` : "";
  } else if (state === "failed") {
    stage = "本轮失败";
    detail = failedUnits > 0 ? `${failedUnits} 个单元失败` : "";
  } else if (state === "stopped") {
    stage = "已停止";
    detail = unitTotal > 0 ? `${doneUnits}/${unitTotal} 单元` : "";
  } else if (units.length === 0) {
    stage = workflow.skill === "prl" ? "分析拆解中" : workflow.skill === "ser" ? "串行分析中" : "分析需求";
    detail = "";
  } else if (fixing) {
    stage = workflow.skill === "plan"
      ? (fixing.runs > 1 ? `修改计划 · 第 ${fixing.runs} 轮` : "修改计划")
      : (fixing.runs > 1 ? `修复复审 · 第 ${fixing.runs} 轮` : "修复复审");
    detail = workflow.skill === "ser" && focusIndex !== undefined
      ? `${focusIndex}/${unitTotal} 单元`
      : `${doneUnits}/${unitTotal} 单元`;
  } else if (reviewRunning) {
    stage = workflow.skill === "prl" ? "并行评审" : workflow.skill === "ser" ? "评审单元" : "评审计划";
    detail = workflow.skill === "ser" && focusIndex !== undefined
      ? `${focusIndex}/${unitTotal} 单元`
      : `${doneUnits}/${unitTotal} 单元`;
  } else if (devRunning) {
    stage = workflow.skill === "prl" ? "并行开发" : workflow.skill === "ser" ? "开发单元" : "制定计划";
    detail = workflow.skill === "ser" && focusIndex !== undefined
      ? `${focusIndex}/${unitTotal} 单元`
      : `${doneUnits}/${unitTotal} 单元`;
  } else if (unitTotal > 0 && doneUnits === unitTotal) {
    stage = workflow.skill === "plan" ? "整理结论" : "集成验证中";
    detail = `${unitTotal}/${unitTotal} 单元`;
  } else {
    stage = workflow.skill === "prl" ? "并行推进" : workflow.skill === "ser" ? "串行推进" : "计划推进";
    detail = unitTotal > 0 ? `${doneUnits}/${unitTotal} 单元` : "";
  }
  if (failedUnits > 0 && state === "running") {
    detail = `${detail}${detail ? " · " : ""}${failedUnits} 个失败`;
  }

  const startedAt = Date.parse(workflow.startedAt);
  const endedAt = workflow.endedAt ? Date.parse(workflow.endedAt) : now;
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : 0;

  return {
    skill: workflow.skill,
    state,
    active: state === "running" || state === "wait",
    hasFailures,
    stage,
    detail,
    current: currentText(units, scoped, session),
    units,
    extras,
    unitTotal,
    doneUnits,
    failedUnits,
    stepsDone,
    stepsTotal,
    percent,
    elapsedMs,
    stageIndex: stageIndex(state, { units, doneUnits, unitTotal, fixing, devRunning, reviewRunning }),
    focusUnit,
  };
}

/** 顶部阶段轨道的格子状态；active 在 UI 里显示为黄色。 */
export type WorkflowTrackState = "done" | "active" | "failed" | "stopped" | "pending";

/**
 * prl 顶部轨道：分析、每个子任务、集成各占一格。
 *
 * 分析还没拆分出子任务时先给 3 格占位（分析 + 子任务 + 集成），
 * 拿到子任务数量后变成 子任务数 + 2 格，每格对应一个流程阶段。
 */
export function prlTrackCells(view: WorkflowView): WorkflowTrackState[] {
  if (view.units.length === 0) {
    if (view.state === "done") return ["done", "done"];
    const analysis: WorkflowTrackState = view.state === "failed"
      ? "failed"
      : view.state === "stopped"
        ? "stopped"
        : view.state === "queued"
          ? "pending"
          : "active";
    return [analysis, "pending", "pending"];
  }

  const numeric = view.units.filter((unit) => typeof unit.unit === "number");
  const cells: WorkflowTrackState[] = ["done"];
  for (const unit of numeric) cells.push(unitTrackState(unit.state));
  const final = view.units.find((unit) => unit.unit === "final");
  if (final) {
    cells.push(unitTrackState(final.state));
  } else if (view.state === "done") {
    cells.push("done");
  } else if (view.unitTotal > 0 && view.doneUnits === view.unitTotal) {
    // 所有子任务都过了，主会话正在做（或已结束）集成验证。
    cells.push(view.state === "failed" ? "failed" : view.state === "stopped" ? "stopped" : "active");
  } else {
    // 还有子任务没过时，失败/停止发生在单元里，集成阶段尚未开始。
    cells.push("pending");
  }
  return cells;
}

function unitTrackState(state: WorkflowUnitState): WorkflowTrackState {
  switch (state) {
    case "pending": return "pending";
    case "done": return "done";
    case "failed": return "failed";
    case "stopped": return "stopped";
    default: return "active";
  }
}

/** 子任务阶段胶囊的状态；running 在 UI 里显示为黄色。 */
export type UnitStageState = "done" | "running" | "failed" | "stopped" | "pending";

export interface UnitStage {
  label: string;
  state: UnitStageState;
}

/**
 * 还原一个子任务经历过的阶段：开发 → 第1轮评审 → 第1轮修复 → 第2轮评审 → 通过。
 *
 * 只依据 devRuns / reviewRuns 和当前状态推导；运行中的最后一步用 running，
 * 失败/停止落在实际失败的那个角色上。
 */
export function unitStages(unit: WorkflowUnit, skill: WorkflowSkill): UnitStage[] {
  const devLabel = skill === "plan" ? "计划" : "开发";
  const fixLabel = skill === "plan" ? "修改" : "修复";
  const seeds: Array<{ label: string; role: "dev" | "review" | "agent" | "pass" }> = [];

  if (unit.agent) {
    seeds.push({ label: skill === "plan" ? "计划" : "执行", role: "agent" });
  } else {
    const rounds = Math.max(unit.devRuns, unit.reviewRuns);
    for (let round = 1; round <= rounds; round += 1) {
      if (round <= unit.devRuns) {
        seeds.push({
          label: round === 1 ? devLabel : `第${round - 1}轮${fixLabel}`,
          role: "dev",
        });
      }
      if (round <= unit.reviewRuns) {
        seeds.push({ label: `第${round}轮评审`, role: "review" });
      }
    }
    if (unit.state === "done") seeds.push({ label: "通过", role: "pass" });
  }

  const stages: UnitStage[] = seeds.map(({ label }) => ({ label, state: "done" }));
  const markLast = (role: "dev" | "review" | "agent", state: UnitStageState) => {
    for (let index = seeds.length - 1; index >= 0; index -= 1) {
      if (seeds[index]?.role === role) {
        stages[index]!.state = state;
        return;
      }
    }
  };

  if (unit.agent) {
    const state = stageFromAgent(unit.agent.status);
    if (state !== "done") markLast("agent", state);
    return stages;
  }

  if (unit.state === "dev-running" || unit.state === "fixing") {
    markLast("dev", "running");
  } else if (unit.state === "review-running") {
    markLast("review", "running");
  } else if (unit.state === "failed" || unit.state === "stopped") {
    if (unit.review && (unit.review.status === "failed" || unit.review.status === "stopped")) {
      markLast("review", unit.state);
    } else if (unit.dev && (unit.dev.status === "failed" || unit.dev.status === "stopped")) {
      markLast("dev", unit.state);
    } else if (stages.length > 0) {
      stages[stages.length - 1]!.state = unit.state;
    }
  }
  return stages;
}

function stageFromAgent(status: Subagent["status"]): UnitStageState {
  if (status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "stopped";
}

function workflowState(session: Session): WorkflowState {
  if (session.phase === "needs_input") return "wait";
  if (session.phase === "completed") return "done";
  if (session.phase === "failed") return "failed";
  if (session.phase === "stopped") return "stopped";
  if (session.phase === "queued") return "queued";
  return "running";
}

function toAgent(agent: Subagent, role: WorkflowRole, unit: number | "final" | "extra"): WorkflowAgent {
  return {
    taskId: agent.taskId,
    title: stripAgentTag(agent.description),
    role,
    unit,
    status: agent.status,
    summary: agent.summary,
    lastToolName: agent.lastToolName,
    runs: agent.runs && agent.runs > 0 ? agent.runs : 1,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
  };
}

/** 最早开始到最近结束的用时；有 agent 还在跑就用 now。 */
function unitTiming(
  agents: Array<{ status: Subagent["status"]; startedAt?: string; endedAt?: string }>,
  now: number,
): { durationMs?: number } {
  let start: number | undefined;
  let end: number | undefined;
  let open = false;
  for (const agent of agents) {
    const started = parseTime(agent.startedAt);
    if (started !== undefined) start = start === undefined ? started : Math.min(start, started);
    const ended = parseTime(agent.endedAt);
    if (ended !== undefined) end = end === undefined ? ended : Math.max(end, ended);
    if (agent.status === "running") open = true;
  }
  if (start === undefined) return {};
  const stop = open ? now : end;
  return stop === undefined ? {} : { durationMs: Math.max(0, stop - start) };
}

function parseTime(value?: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function makeUnit(
  unit: number | "final",
  group: { dev: Subagent[]; review: Subagent[]; title: string; total: number } | undefined,
  fallbackIndex: number,
  now: number,
): WorkflowUnit {
  const devAgent = group?.dev[group.dev.length - 1];
  const reviewAgent = group?.review[group.review.length - 1];
  const dev = devAgent ? toAgent(devAgent, "dev", unit) : undefined;
  const review = reviewAgent ? toAgent(reviewAgent, "review", unit) : undefined;
  const devRuns = group?.dev.reduce((sum, item) => sum + (item.runs && item.runs > 0 ? item.runs : 1), 0) ?? 0;
  const reviewRuns = group?.review.reduce((sum, item) => sum + (item.runs && item.runs > 0 ? item.runs : 1), 0) ?? 0;
  const title = group?.title || (unit === "final" ? "集成验证" : `单元 ${fallbackIndex}`);
  return {
    unit,
    title,
    dev,
    review,
    state: unitState(devAgent, reviewAgent),
    runs: Math.max(devRuns, reviewRuns),
    devRuns,
    reviewRuns,
    ...unitTiming([...(group?.dev ?? []), ...(group?.review ?? [])], now),
  };
}

function unitState(dev: Subagent | undefined, review: Subagent | undefined): WorkflowUnitState {
  if (dev?.status === "failed" || review?.status === "failed") return "failed";
  if (dev?.status === "stopped" || review?.status === "stopped") return "stopped";
  if (dev?.status === "running") {
    // 评审已经跑过一次后又回到开发，就是修复轮。
    return review && review.status !== "running" ? "fixing" : "dev-running";
  }
  if (!dev) {
    if (review?.status === "running") return "review-running";
    if (review?.status === "completed") return "done";
    return "pending";
  }
  if (dev.status !== "completed") return "pending";
  if (!review) return "waiting-review";
  if (review.status === "running") return "review-running";
  if (review.status === "completed") return "done";
  return "pending";
}

function stageIndex(
  state: WorkflowState,
  view: {
    units: WorkflowUnit[];
    doneUnits: number;
    unitTotal: number;
    fixing?: WorkflowUnit;
    devRunning: boolean;
    reviewRunning: boolean;
  },
): number {
  if (state === "done") return 5;
  if (view.units.length === 0) return 0;
  if (view.fixing) return 3;
  if (view.devRunning) return 1;
  if (view.reviewRunning) return 2;
  // 全部数字单元都评审完成、且没有 agent 在跑，才是集成/整理阶段。
  // 这个判断必须排在 doneUnits > 0 之前，否则永远到不了第 4 阶段。
  if (view.unitTotal > 0 && view.doneUnits === view.unitTotal) return 4;
  if (view.doneUnits > 0) return 2;
  return 0;
}

function currentText(units: WorkflowUnit[], scoped: Subagent[], session: Session): string {
  // 终态不再展示“当前子任务”，避免显示一个已经结束的工具名。
  if (session.phase === "completed" || session.phase === "failed" || session.phase === "stopped") return "";
  const running = units.find((unit) =>
    unit.dev?.status === "running" || unit.review?.status === "running" || unit.agent?.status === "running");
  const agent = running?.dev?.status === "running"
    ? running.dev
    : running?.review?.status === "running"
      ? running.review
      : running?.agent?.status === "running"
        ? running.agent
        : undefined;
  if (agent) {
    if (agent.role === "agent") return `${agent.title} · 进行中`;
    const skill = session.workflow?.skill;
    const unitLabel = skill === "plan"
      ? "计划"
      : agent.unit === "final"
        ? "集成"
        : skill === "prl"
          ? `子任务${agent.unit}`
          : `u${agent.unit}`;
    const verb = agent.role === "review"
      ? "评审中"
      : running?.state === "fixing"
        ? (skill === "plan" ? "修改中" : "修复中")
        : (skill === "plan" ? "制定中" : "开发中");
    const tool = agent.lastToolName ? ` · ${agent.lastToolName}` : "";
    const round = agent.runs > 1 ? ` · 第 ${agent.runs} 轮` : "";
    return `${unitLabel} ${verb}${tool}${round}`;
  }
  if (session.pending) return `等待确认 · ${session.pending.toolName}`;
  if (scoped.some((item) => item.status === "running")) return "等待结果";
  const tool = lastMainTool(session);
  return tool ? `主会话 · ${tool}` : session.phase === "running" ? "等待结果" : "";
}

/** 最近一条主对话工具名；遇到用户消息就停，避免读到上一轮。 */
function lastMainTool(session: Session): string | undefined {
  const messages = session.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.role === "tool" && item.toolName) return item.toolName;
    if (item.role === "user") break;
  }
  return undefined;
}
