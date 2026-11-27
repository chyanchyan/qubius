import assert from "node:assert/strict";
import test from "node:test";
import type { Session, Subagent } from "./api";
import {
  deriveWorkflow,
  formatElapsed,
  parseAgentTag,
  prlTrackCells,
  stripAgentTag,
  unitStages,
} from "./workflow-progress";

const STARTED = "2026-01-01T00:00:00.000Z";

function agent(partial: Partial<Subagent> & Pick<Subagent, "taskId" | "description" | "status">): Subagent {
  return { ...partial };
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "s1",
    projectId: "p1",
    title: "测试对话",
    providerId: "provider",
    providerName: "接口",
    model: "model",
    effort: "high",
    phase: "running",
    summary: "",
    git: false,
    cwd: "/tmp",
    isolated: false,
    subagentDone: 0,
    subagentTotal: 0,
    subagents: [],
    pending: null,
    createdAt: STARTED,
    updatedAt: STARTED,
    ...overrides,
  };
}

function scoped(description: string, status: Subagent["status"], extra: Partial<Subagent> = {}): Subagent {
  return agent({ taskId: description + status, description, status, workflowAt: STARTED, ...extra });
}

test("parseAgentTag：解析开发/评审/集成标签，拒绝非法序号", () => {
  assert.deepEqual(parseAgentTag("[wf:prl:1/4:dev] 登录接口"), {
    skill: "prl", unit: 1, total: 4, role: "dev", title: "登录接口",
  });
  assert.deepEqual(parseAgentTag("[wf:ser:2/6:review] 会话存储"), {
    skill: "ser", unit: 2, total: 6, role: "review", title: "会话存储",
  });
  assert.deepEqual(parseAgentTag("[wf:plan:1/1:dev] 开发计划"), {
    skill: "plan", unit: 1, total: 1, role: "dev", title: "开发计划",
  });
  assert.deepEqual(parseAgentTag("[wf:prl:final:review] 集成 diff"), {
    skill: "prl", unit: "final", total: 0, role: "review", title: "集成 diff",
  });
  assert.equal(parseAgentTag("[wf:prl:5/4:dev] 越界"), null);
  assert.equal(parseAgentTag("[wf:prl:1/4:qa] 未知角色"), null);
  assert.equal(parseAgentTag("登录接口"), null);
});

test("stripAgentTag：去掉合法标签，非法/无标签原样保留", () => {
  assert.equal(stripAgentTag("[wf:prl:1/4:dev] 登录接口"), "登录接口");
  assert.equal(stripAgentTag("[wf:prl:1/4:dev]"), "子任务");
  assert.equal(stripAgentTag("[wf:prl:final:review]"), "集成评审");
  assert.equal(stripAgentTag("[wf:prl:5/4:dev] 越界"), "[wf:prl:5/4:dev] 越界");
  assert.equal(stripAgentTag("普通子任务"), "普通子任务");
});

test("formatElapsed：分秒与小时", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(65_000), "01:05");
  assert.equal(formatElapsed(3_665_000), "1:01:05");
});

test("deriveWorkflow：没有工作流时返回 null", () => {
  assert.equal(deriveWorkflow(session({}), 0), null);
});

test("deriveWorkflow：讨论和并行讨论走自己的面板，不返回轨道", () => {
  assert.equal(deriveWorkflow(session({
    workflow: { skill: "discuss", startedAt: STARTED },
  }), 0), null);
  assert.equal(deriveWorkflow(session({
    workflow: { skill: "dis-prl", startedAt: STARTED },
  }), 0), null);
  // prl-role 有自己的角色团队面板，也不显示 prl/ser 轨道。
  assert.equal(deriveWorkflow(session({
    workflow: { skill: "prl-role", startedAt: STARTED },
  }), 0), null);
});

test("deriveWorkflow：只统计当前 workflowAt 的子任务", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/2:dev] 旧任务", "completed", { workflowAt: "2025-12-31T00:00:00.000Z" }),
      agent({ taskId: "old", description: "[wf:prl:1/2:dev] 无标记", status: "completed" }),
      scoped("[wf:prl:1/2:dev] 登录接口", "running"),
    ],
  }), Date.parse(STARTED) + 5000);
  assert.ok(view);
  // prl 只展示实际出现的单元，不再按标签总数补齐占位行。
  assert.equal(view.unitTotal, 1);
  assert.equal(view.units.length, 1);
  assert.equal(view.units[0]?.title, "登录接口");
  assert.equal(view.stage, "并行开发");
  assert.equal(view.current, "子任务1 开发中");
  assert.equal(view.percent, 0);
  assert.equal(view.stageIndex, 1);
});

test("deriveWorkflow：prl 标签总数偏大时不多出没有工作的单元", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/4:dev] 登录接口", "running", { taskId: "d1" }),
      scoped("[wf:prl:2/4:dev] 会话存储", "running", { taskId: "d2" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.unitTotal, 2);
  assert.equal(view.units.length, 2);
  assert.equal(view.units[1]?.title, "会话存储");
  assert.equal(view.stepsTotal, 4);
});

test("deriveWorkflow：ser 串行队列保留还没轮到的占位单元", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "ser", startedAt: STARTED },
    subagents: [
      scoped("[wf:ser:1/3:dev] 登录接口", "running", { taskId: "d1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.unitTotal, 3);
  assert.equal(view.units.length, 3);
  assert.equal(view.units[2]?.state, "pending");
});

test("deriveWorkflow：评审完成后开发又跑起来是修复轮", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/2:dev] 登录接口", "running", { taskId: "dev-1", runs: 2, lastToolName: "Edit" }),
      scoped("[wf:prl:1/2:review] 登录接口", "completed", { taskId: "review-1" }),
      scoped("[wf:prl:2/2:dev] 会话存储", "completed", { taskId: "dev-2" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  const first = view.units[0];
  assert.equal(first?.state, "fixing");
  assert.equal(first?.runs, 2);
  assert.equal(view.stage, "修复复审 · 第 2 轮");
  assert.equal(view.current, "子任务1 修复中 · Edit · 第 2 轮");
  assert.equal(view.stepsDone, 2); // 子任务1 评审完成 + 子任务2 开发完成
  assert.equal(view.stepsTotal, 4);
  assert.equal(view.percent, 50);
  assert.equal(view.stageIndex, 3);
});

test("deriveWorkflow：等待确认显示工具名", () => {
  const view = deriveWorkflow(session({
    phase: "needs_input",
    pending: { requestId: "r1", kind: "permission", toolName: "Bash", inputPreview: "rm -rf /" },
    workflow: { skill: "ser", startedAt: STARTED },
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.state, "wait");
  assert.equal(view.active, true);
  assert.equal(view.stage, "等待确认");
  assert.equal(view.detail, "Bash");
});

test("deriveWorkflow：完成后 100%，用时按 endedAt 冻结", () => {
  const view = deriveWorkflow(session({
    phase: "completed",
    workflow: { skill: "ser", startedAt: STARTED, endedAt: "2026-01-01T00:01:05.000Z" },
    subagents: [
      scoped("[wf:ser:1/1:dev] 登录接口", "completed", { taskId: "d1" }),
      scoped("[wf:ser:1/1:review] 登录接口", "completed", { taskId: "r1" }),
    ],
  }), Date.parse("2026-02-01T00:00:00.000Z"));
  assert.ok(view);
  assert.equal(view.state, "done");
  assert.equal(view.percent, 100);
  assert.equal(view.doneUnits, 1);
  assert.equal(view.elapsedMs, 65_000);
  assert.equal(view.stage, "完成");
});

test("deriveWorkflow：子任务失败时保留 running 状态但标记失败", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/2:dev] 登录接口", "failed", { taskId: "d1" }),
      scoped("[wf:prl:2/2:dev] 会话存储", "running", { taskId: "d2" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.state, "running");
  assert.equal(view.hasFailures, true);
  assert.equal(view.failedUnits, 1);
  assert.equal(view.detail, "0/2 单元 · 1 个失败");
});

test("deriveWorkflow：没有标签时退化为每个子任务一个单元", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("查看项目结构", "completed", { taskId: "a1" }),
      scoped("实现接口", "running", { taskId: "a2" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.units.length, 2);
  assert.equal(view.units[0]?.agent?.role, "agent");
  assert.equal(view.unitTotal, 2);
  assert.equal(view.stepsTotal, 2);
  assert.equal(view.stepsDone, 1);
  assert.equal(view.percent, 50);
  assert.equal(view.current, "实现接口 · 进行中");
});

test("deriveWorkflow：有标签时无标签子任务放进 extras，不参与进度", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/1:dev] 登录接口", "completed", { taskId: "d1" }),
      scoped("顺带查一下日志", "running", { taskId: "x1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.unitTotal, 1);
  assert.equal(view.stepsTotal, 2);
  assert.equal(view.stepsDone, 1);
  assert.equal(view.extras.length, 1);
  assert.equal(view.extras[0]?.title, "顺带查一下日志");
});

test("deriveWorkflow：plan 模式的阶段文案", () => {
  const base = {
    workflow: { skill: "plan" as const, startedAt: STARTED },
  };
  const drafting = deriveWorkflow(session({
    ...base,
    subagents: [scoped("[wf:plan:1/1:dev] 开发计划", "running", { lastToolName: "Read" })],
  }), Date.parse(STARTED));
  assert.ok(drafting);
  assert.equal(drafting.stage, "制定计划");
  assert.equal(drafting.current, "计划 制定中 · Read");

  const reviewing = deriveWorkflow(session({
    ...base,
    subagents: [
      scoped("[wf:plan:1/1:dev] 开发计划", "completed", { taskId: "d1" }),
      scoped("[wf:plan:1/1:review] 开发计划", "running", { taskId: "r1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(reviewing);
  assert.equal(reviewing.stage, "评审计划");
  assert.equal(reviewing.current, "计划 评审中");

  const revising = deriveWorkflow(session({
    ...base,
    subagents: [
      scoped("[wf:plan:1/1:dev] 开发计划", "running", { taskId: "d1", runs: 2 }),
      scoped("[wf:plan:1/1:review] 开发计划", "completed", { taskId: "r1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(revising);
  assert.equal(revising.stage, "修改计划 · 第 2 轮");
  assert.equal(revising.current, "计划 修改中 · 第 2 轮");

  const done = deriveWorkflow(session({
    ...base,
    phase: "completed",
    workflow: { skill: "plan", startedAt: STARTED, endedAt: STARTED },
    subagents: [
      scoped("[wf:plan:1/1:dev] 开发计划", "completed", { taskId: "d1" }),
      scoped("[wf:plan:1/1:review] 开发计划", "completed", { taskId: "r1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(done);
  assert.equal(done.stage, "计划完成");
  assert.equal(done.percent, 100);
});

test("parseAgentTag：拒绝异常大的单元总数，避免生成过多占位单元", () => {
  assert.equal(parseAgentTag("[wf:prl:1/999:dev] 登录接口"), null);
});

test("deriveWorkflow：全部单元完成、主会话仍在验证时进入集成阶段", () => {
  const agents: Subagent[] = [];
  for (const unit of [1, 2]) {
    agents.push(scoped(`[wf:prl:${unit}/2:dev] 单元${unit}`, "completed", { taskId: `d${unit}` }));
    agents.push(scoped(`[wf:prl:${unit}/2:review] 单元${unit}`, "completed", { taskId: `r${unit}` }));
  }
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: agents,
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.stage, "集成验证中");
  assert.equal(view.stageIndex, 4);
  assert.equal(view.doneUnits, 2);
});

test("deriveWorkflow：等待确认时阶段条保留当前评审阶段", () => {
  const view = deriveWorkflow(session({
    phase: "needs_input",
    pending: { requestId: "r1", kind: "question", toolName: "AskUserQuestion", inputPreview: "" },
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/1:dev] 登录接口", "completed", { taskId: "d1" }),
      scoped("[wf:prl:1/1:review] 登录接口", "running", { taskId: "r1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.equal(view.state, "wait");
  assert.equal(view.stageIndex, 2);
});

test("prlTrackCells：分析未拆分时 3 格，拆出子任务后变成 子任务数+2 格", () => {
  const analysing = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [],
  }), Date.parse(STARTED));
  assert.ok(analysing);
  assert.deepEqual(prlTrackCells(analysing), ["active", "pending", "pending"]);

  const split = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/2:dev] 登录接口", "completed", { taskId: "d1" }),
      scoped("[wf:prl:1/2:review] 登录接口", "completed", { taskId: "r1" }),
      scoped("[wf:prl:2/2:dev] 会话存储", "running", { taskId: "d2" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(split);
  assert.deepEqual(prlTrackCells(split), ["done", "done", "active", "pending"]);
});

test("prlTrackCells：全部子任务完成且没有集成评审时集成格为运行中", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/1:dev] 登录接口", "completed", { taskId: "d1" }),
      scoped("[wf:prl:1/1:review] 登录接口", "completed", { taskId: "r1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.deepEqual(prlTrackCells(view), ["done", "done", "active"]);
});

test("prlTrackCells：分析阶段失败时第一格标红", () => {
  const view = deriveWorkflow(session({
    phase: "failed",
    workflow: { skill: "prl", startedAt: STARTED, endedAt: STARTED },
    subagents: [],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.deepEqual(prlTrackCells(view), ["failed", "pending", "pending"]);
});

test("unitStages：开发 → 第1轮评审 → 第1轮修复，最后一步按当前状态着色", () => {
  const view = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/1:dev] 登录接口", "running", { taskId: "d1", runs: 2 }),
      scoped("[wf:prl:1/1:review] 登录接口", "completed", { taskId: "r1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.deepEqual(unitStages(view.units[0]!, "prl"), [
    { label: "开发", state: "done" },
    { label: "第1轮评审", state: "done" },
    { label: "第1轮修复", state: "running" },
  ]);
});

test("unitStages：完成的单元追加通过，多轮评审保留轮次", () => {
  const view = deriveWorkflow(session({
    phase: "completed",
    workflow: { skill: "prl", startedAt: STARTED, endedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/1:dev] 登录接口", "completed", { taskId: "d1", runs: 2 }),
      scoped("[wf:prl:1/1:review] 登录接口", "completed", { taskId: "r1", runs: 2 }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.deepEqual(unitStages(view.units[0]!, "prl"), [
    { label: "开发", state: "done" },
    { label: "第1轮评审", state: "done" },
    { label: "第1轮修复", state: "done" },
    { label: "第2轮评审", state: "done" },
    { label: "通过", state: "done" },
  ]);
});

test("unitStages：评审失败标在评审胶囊上", () => {
  const view = deriveWorkflow(session({
    phase: "failed",
    workflow: { skill: "prl", startedAt: STARTED, endedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/1:dev] 登录接口", "completed", { taskId: "d1" }),
      scoped("[wf:prl:1/1:review] 登录接口", "failed", { taskId: "r1" }),
    ],
  }), Date.parse(STARTED));
  assert.ok(view);
  assert.deepEqual(unitStages(view.units[0]!, "prl"), [
    { label: "开发", state: "done" },
    { label: "第1轮评审", state: "failed" },
  ]);
});

test("deriveWorkflow：子任务用时取 agent 最早开始到最近结束/当前时间", () => {
  const running = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [
      scoped("[wf:prl:1/2:dev] 登录接口", "completed", {
        taskId: "d1",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:30.000Z",
      }),
      scoped("[wf:prl:1/2:review] 登录接口", "running", {
        taskId: "r1",
        startedAt: "2026-01-01T00:00:40.000Z",
      }),
    ],
  }), Date.parse("2026-01-01T00:01:00.000Z"));
  assert.ok(running);
  assert.equal(running.units[0]?.durationMs, 60_000);

  const finished = deriveWorkflow(session({
    phase: "completed",
    workflow: { skill: "prl", startedAt: STARTED, endedAt: "2026-01-01T00:02:00.000Z" },
    subagents: [
      scoped("[wf:prl:1/2:dev] 登录接口", "completed", {
        taskId: "d1",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:30.000Z",
      }),
      scoped("[wf:prl:1/2:review] 登录接口", "completed", {
        taskId: "r1",
        startedAt: "2026-01-01T00:00:40.000Z",
        endedAt: "2026-01-01T00:01:20.000Z",
      }),
    ],
  }), Date.parse("2026-02-01T00:00:00.000Z"));
  assert.ok(finished);
  assert.equal(finished.units[0]?.durationMs, 80_000);

  const unknown = deriveWorkflow(session({
    workflow: { skill: "prl", startedAt: STARTED },
    subagents: [scoped("[wf:prl:1/1:dev] 登录接口", "completed", { taskId: "d1" })],
  }), Date.parse(STARTED));
  assert.ok(unknown);
  assert.equal(unknown.units[0]?.durationMs, undefined);
});
