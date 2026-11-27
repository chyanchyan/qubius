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

function branch(phase: Phase, extra: { branch?: string; hasEarlierReply?: boolean } = {}) {
  return { phase, ...extra };
}

test("首轮答复中、没有改动时是灰灯", () => {
  assert.equal(
    branchLampState({ untouched: true, merged: true, active: true, earlierReply: false }),
    "starting",
  );
  // 旧服务端不返回 hasEarlierReply：无法判断首轮，保持蓝灯。
  assert.equal(
    branchLampState({ untouched: true, merged: true, active: true }),
    "untouched",
  );
});

test("做过一轮答复且没有改动时是蓝灯", () => {
  assert.equal(
    branchLampState({ untouched: true, merged: true, active: false, earlierReply: true }),
    "untouched",
  );
  // 第二轮正在跑，但此前已经答复过：仍然显示蓝灯。
  assert.equal(
    branchLampState({ untouched: true, merged: true, active: true, earlierReply: true }),
    "untouched",
  );
});

test("未提交改动是橙灯，优先于其它状态", () => {
  assert.equal(branchLampState({ dirty: true, merged: true, earlierReply: true }), "dirty");
  assert.equal(branchLampState({ dirty: true, untouched: true, active: true }), "dirty");
  assert.equal(branchLampState({ dirty: true, merged: false }), "dirty");
});

test("有提交但没合入是黄灯，已合入是绿灯", () => {
  assert.equal(branchLampState({ merged: false, untouched: false }), "unmerged");
  assert.equal(branchLampState({ merged: true, untouched: false }), "merged");
});

test("合入状态未知时不着色", () => {
  assert.equal(branchLampState({}), undefined);
  assert.equal(branchLampState({ merged: undefined, untouched: false }), undefined);
});

test("项目灯按橙 > 黄 > 蓝 > 绿 > 灰取第一个存在的状态", () => {
  const blue = "qubius/bbbbbbbb";
  const green = "qubius/cccccccc";
  const yellow = "qubius/dddddddd";
  const orange = "qubius/eeeeeeee";
  const status = branchStatus({
    merged: new Set([blue, green]),
    untouched: new Set([blue]),
    dirty: new Set([orange]),
  });
  const sessions = [
    branch("completed", { branch: green }),
    branch("running", { branch: yellow }),
    branch("completed", { branch: blue, hasEarlierReply: true }),
    branch("failed", { branch: orange }),
  ];
  // 五盏灯同时存在时取优先级最高的橙灯。
  assert.equal(projectLampState(sessions, status), "dirty");
  assert.equal(projectLampState(sessions.slice(0, 3), status), "unmerged");
  assert.equal(projectLampState([sessions[0]], status), "merged");
  assert.equal(projectLampState([sessions[0], sessions[2]], status), "untouched");

  // 灰灯优先级最低：有绿灯时显示绿灯。
  const startingBranch = "qubius/ffffffff";
  const starting = branch("running", { branch: startingBranch, hasEarlierReply: false });
  const withGray = branchStatus({
    merged: new Set([green]),
    untouched: new Set([startingBranch]),
  });
  assert.equal(projectLampState([sessions[0], starting], withGray), "merged");
  // 只有首轮中的会话时显示灰灯。
  assert.equal(projectLampState([starting], withGray), "starting");
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
  const sessions = [branch("completed", { branch: branchName })];
  const unknown = branchStatus({ mergedKnown: false });
  assert.equal(projectLampState(sessions, unknown), undefined);
  // 蓝灯和橙灯不依赖合入状态，仍然可见。
  assert.equal(
    projectLampState(sessions, branchStatus({ mergedKnown: false, untouched: new Set([branchName]) })),
    "untouched",
  );
  assert.equal(
    projectLampState(sessions, branchStatus({ mergedKnown: false, dirty: new Set([branchName]) })),
    "dirty",
  );
});
