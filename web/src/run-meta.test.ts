import assert from "node:assert/strict";
import test from "node:test";
import type { Phase } from "./api";
import { runMeta } from "./run-meta";

function meta(phase: Phase, runStartedAt?: string, runEndedAt?: string, now = Date.now()) {
  return runMeta({ phase, runStartedAt, runEndedAt }, now);
}

test("运行中即使残留结束时间也显示运行时长", () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const now = Date.parse(startedAt) + 65_000;
  // 后台子 agent 的通知会在主轮 result 之后让会话重新跑起来，旧的 runEndedAt 可能还在。
  const result = meta("running", startedAt, "2026-01-01T00:00:30.000Z", now);
  assert.equal(result.live, true);
  assert.equal(result.timing, "运行 1:05");
});

test("落定后显示结束时刻", () => {
  const result = meta("completed", "2026-01-01T00:00:00.000Z", "2026-01-01T00:06:56.000Z");
  assert.equal(result.live, false);
  assert.match(result.timing, /^结束 /);
});

test("等待确认也按运行中计时", () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const result = meta("needs_input", startedAt, undefined, Date.parse(startedAt) + 5_000);
  assert.equal(result.live, true);
  assert.equal(result.timing, "运行 0:05");
});

test("排队中没有时间文案", () => {
  const result = meta("queued", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z");
  assert.equal(result.live, false);
  assert.equal(result.timing, "");
});

test("运行中缺少开始时间时不显示计时（旧会话）", () => {
  const result = meta("running", undefined, undefined);
  assert.equal(result.live, false);
  assert.equal(result.timing, "");
});
