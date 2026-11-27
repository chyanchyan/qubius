import assert from "node:assert/strict";
import test from "node:test";
import { branchLampState } from "./branch-state";

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
