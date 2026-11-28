import assert from "node:assert/strict";
import test from "node:test";
import { branchLampState, projectLampState, type ProjectBranchStatus } from "./branch-state";
import type { Phase } from "./api";

function branchStatus(overrides: Partial<ProjectBranchStatus> = {}): ProjectBranchStatus {
  return {
    mergedKnown: true,
    merged: new Set(),
    untouched: new Set(),
    dirty: new Set(),
    ...overrides,
  };
}

function branch(phase: Phase, branchName?: string) {
  return { phase, branch: branchName };
}

test("本轮进行中、没有未提交改动时是灰灯", () => {
  // 消息刚发出去：即使分支里已有未合入的提交，也先显示灰灯。
  assert.equal(
    branchLampState({ merged: false, untouched: false, active: true }),
    "starting",
  );
  // 从未改过代码的分支同样先显示灰灯。
  assert.equal(
    branchLampState({ merged: true, untouched: true, active: true }),
    "starting",
  );
  // 合入状态还没加载时，也要能立刻给出发送后的反馈。
  assert.equal(branchLampState({ active: true }), "starting");
});

test("本轮结束、没有改动时是浅绿灯", () => {
  assert.equal(
    branchLampState({ merged: true, untouched: true }),
    "untouched",
  );
  assert.equal(
    branchLampState({ merged: false, untouched: true }),
    "untouched",
  );
});

test("未提交改动是橙灯，优先于进行中的灰灯", () => {
  assert.equal(branchLampState({ dirty: true, merged: true, active: true }), "dirty");
  assert.equal(branchLampState({ dirty: true, untouched: true, active: true }), "dirty");
  assert.equal(branchLampState({ dirty: true, merged: false }), "dirty");
});

test("有提交但没合入是黄灯，已合入是绿灯", () => {
  assert.equal(branchLampState({ merged: false, untouched: false }), "unmerged");
  assert.equal(branchLampState({ merged: true, untouched: false }), "merged");
});

test("合入状态未知且本轮已结束时不着色", () => {
  assert.equal(branchLampState({}), undefined);
  assert.equal(branchLampState({ merged: undefined, untouched: false }), undefined);
});

test("项目灯按橙 > 黄 > 浅绿 > 绿 > 灰取第一个存在的状态", () => {
  const lightGreen = "qubius/bbbbbbbb";
  const green = "qubius/cccccccc";
  const yellow = "qubius/dddddddd";
  const orange = "qubius/eeeeeeee";
  const gray = "qubius/ffffffff";
  const status = branchStatus({
    merged: new Set([lightGreen, green]),
    untouched: new Set([lightGreen, gray]),
    dirty: new Set([orange]),
  });
  const sessions = [
    branch("completed", green),
    branch("completed", yellow),
    branch("completed", lightGreen),
    branch("failed", orange),
    branch("running", gray),
  ];
  // 五盏灯同时存在时取优先级最高的橙灯。
  assert.equal(projectLampState(sessions, status), "dirty");
  assert.equal(projectLampState(sessions.slice(0, 2), status), "unmerged");
  assert.equal(projectLampState([sessions[0]], status), "merged");
  assert.equal(projectLampState([sessions[0], sessions[2]], status), "untouched");

  // 灰灯优先级最低：有绿灯时显示绿灯。
  assert.equal(projectLampState([sessions[0], sessions[4]], status), "merged");
  // 只有进行中的会话时显示灰灯；分支里已有提交也一样。
  assert.equal(projectLampState([sessions[4]], status), "starting");
  assert.equal(projectLampState([branch("running", yellow)], status), "starting");
});

test("项目没有任何会话或没有分支时显示空心灯", () => {
  assert.equal(projectLampState([], branchStatus()), undefined);
  assert.equal(
    projectLampState([branch("completed"), branch("running")], branchStatus()),
    undefined,
  );
});

test("找不到基准分支时不显示黄灯或绿灯", () => {
  const branchName = "qubius/aaaaaaaa";
  const sessions = [branch("completed", branchName)];
  const unknown = branchStatus({ mergedKnown: false });
  assert.equal(projectLampState(sessions, unknown), undefined);
  // 浅绿灯、橙灯和进行中的灰灯不依赖合入状态，仍然可见。
  assert.equal(
    projectLampState(sessions, branchStatus({ mergedKnown: false, untouched: new Set([branchName]) })),
    "untouched",
  );
  assert.equal(
    projectLampState(sessions, branchStatus({ mergedKnown: false, dirty: new Set([branchName]) })),
    "dirty",
  );
  assert.equal(
    projectLampState([branch("running", branchName)], unknown),
    "starting",
  );
});
