import assert from "node:assert/strict";
import test from "node:test";
import type { RoleBinding, RoleTeam, Session } from "./api";
import { continueKind } from "./continue-target";

const STARTED = "2026-01-01T00:00:00.000Z";

function binding(): RoleBinding {
  return { providerId: "p1", providerName: "接口一", model: "m1", effort: "medium" };
}

function roleTeam(): RoleTeam {
  return {
    orchestrator: binding(),
    executor: binding(),
    subReviewer: binding(),
    integrationReviewer: binding(),
  };
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
    phase: "stopped",
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

test("continueKind：有参与者的讨论会话重跑讨论", () => {
  assert.equal(continueKind(session({
    discussion: {
      phase: "stopped",
      participants: [{
        name: "模型一",
        providerId: "p1",
        providerName: "接口一",
        model: "m1",
        effort: "medium",
      }],
      round: 1,
      subtasks: [],
    },
    workflow: { skill: "discuss", startedAt: STARTED },
  })), "discussion");
});

test("continueKind：prl-role 且保留团队时重跑团队", () => {
  assert.equal(continueKind(session({
    workflow: { skill: "prl-role", startedAt: STARTED },
    roleRun: { phase: "stopped", team: roleTeam(), units: [], round: 1, maxRounds: 3 },
  })), "role");
  // 停止/失败后 workflow.skill 仍是 prl-role，仍走团队分支。
  assert.equal(continueKind(session({
    workflow: { skill: "prl-role", startedAt: STARTED, endedAt: STARTED },
    roleRun: { phase: "failed", team: roleTeam(), units: [], round: 1, maxRounds: 3, error: "失败" },
  })), "role");
});

test("continueKind：roleRun 还在但工作流已切走时发普通消息", () => {
  assert.equal(continueKind(session({
    workflow: { skill: "plan", startedAt: STARTED },
    roleRun: { phase: "completed", team: roleTeam(), units: [], round: 1, maxRounds: 3 },
  })), "message");
  assert.equal(continueKind(session({
    roleRun: { phase: "completed", team: roleTeam(), units: [], round: 1, maxRounds: 3 },
  })), "message");
  // 当前工作流仍是 prl-role 但没有保留团队时也只能发普通消息。
  assert.equal(continueKind(session({
    workflow: { skill: "prl-role", startedAt: STARTED },
    roleRun: { phase: "stopped", units: [], round: 1, maxRounds: 3 },
  })), "message");
});

test("continueKind：普通会话发继续消息", () => {
  assert.equal(continueKind(session({})), "message");
  assert.equal(continueKind(session({
    workflow: { skill: "ser", startedAt: STARTED },
  })), "message");
});
