import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_STATES,
  isJobState,
  isJobTimestamp,
  isTerminalJobState,
  jobTimestamp,
} from "./job-state.js";

test("JOB_STATES 是共享状态词汇", () => {
  assert.deepEqual([...JOB_STATES], ["running", "success", "failed"]);
});

test("isJobState 只接受共享状态", () => {
  for (const state of JOB_STATES) assert.equal(isJobState(state), true);
  for (const value of ["idle", "pending", "SUCCESS", "", "running ", null, undefined, 1, {}]) {
    assert.equal(isJobState(value), false);
  }
});

test("isTerminalJobState 只接受 success/failed", () => {
  assert.equal(isTerminalJobState("success"), true);
  assert.equal(isTerminalJobState("failed"), true);
  assert.equal(isTerminalJobState("running"), false);
  assert.equal(isTerminalJobState("idle"), false);
  assert.equal(isTerminalJobState(null), false);
});

test("jobTimestamp 输出秒精度 UTC ISO", () => {
  assert.equal(jobTimestamp(new Date("2026-02-03T04:05:06.789Z")), "2026-02-03T04:05:06Z");
  assert.match(jobTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.doesNotMatch(jobTimestamp(), /\.\d{3}Z$/);
});

test("isJobTimestamp 接受秒精度并兼容带毫秒的旧值", () => {
  assert.equal(isJobTimestamp("2026-02-03T04:05:06Z"), true);
  // 旧数据：毫秒精度。
  assert.equal(isJobTimestamp("2026-02-03T04:05:06.789Z"), true);
  for (const value of [
    "2026-02-03T04:05:06+08:00",
    "2026-02-03",
    "2026-02-03T04:05:06",
    "",
    null,
    1_700_000_000,
  ]) {
    assert.equal(isJobTimestamp(value), false);
  }
});
