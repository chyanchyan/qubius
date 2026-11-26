import assert from "node:assert/strict";
import test from "node:test";
import type { Phase, Session } from "./api";
import {
  activeProjectIds,
  applyActivity,
  emptyActivity,
  isActivePhase,
  mergeActivity,
} from "./project-activity";

type ActivityEvent = Pick<Session, "id" | "projectId" | "phase" | "updatedAt" | "removed">;

/** 构造一条最小会话事件；updatedAt 默认递增到固定时间，需要时显式覆盖。 */
function event(
  id: string,
  projectId: string,
  phase: Phase,
  updatedAt = "2026-01-01T00:00:00.000Z",
  removed = false,
): ActivityEvent {
  return { id, projectId, phase, updatedAt, removed };
}

test("isActivePhase：queued / running / needs_input 算进行中", () => {
  assert.equal(isActivePhase("queued"), true);
  assert.equal(isActivePhase("running"), true);
  assert.equal(isActivePhase("needs_input"), true);
  assert.equal(isActivePhase("completed"), false);
  assert.equal(isActivePhase("failed"), false);
  assert.equal(isActivePhase("stopped"), false);
});

test("applyActivity：活跃会话保持同项目时不产生新对象", () => {
  const first = applyActivity(emptyActivity(), event("s1", "p1", "running"));
  assert.equal(first.sessions.get("s1"), "p1");
  assert.equal(first.counts.get("p1"), 1);

  const next = applyActivity(first, event("s1", "p1", "needs_input", "2026-01-01T00:00:01.000Z"));
  assert.equal(next, first);
});

test("applyActivity：活跃转 completed 时移除会话并清理计数", () => {
  const first = applyActivity(emptyActivity(), event("s1", "p1", "running"));
  const done = applyActivity(first, event("s1", "p1", "completed", "2026-01-01T00:00:01.000Z"));
  assert.equal(done.sessions.has("s1"), false);
  assert.equal(done.counts.has("p1"), false);
  assert.equal(done.counts.size, 0);
});

test("applyActivity：removed 会移除会话；本就不存在时返回原对象", () => {
  const first = applyActivity(emptyActivity(), event("s1", "p1", "running"));
  const removed = applyActivity(first, event("s1", "p1", "running", "2026-01-01T00:00:01.000Z", true));
  assert.equal(removed.sessions.has("s1"), false);
  assert.equal(removed.counts.size, 0);

  assert.equal(applyActivity(removed, event("s1", "p1", "running", "2026-01-01T00:00:02.000Z", true)), removed);
});

test("applyActivity：同一 id 换项目时旧项目减一、新项目加一", () => {
  const first = applyActivity(emptyActivity(), event("s1", "p1", "running"));
  const moved = applyActivity(first, event("s1", "p2", "running", "2026-01-01T00:00:01.000Z"));
  assert.equal(moved.sessions.get("s1"), "p2");
  assert.equal(moved.counts.has("p1"), false);
  assert.equal(moved.counts.get("p2"), 1);
});

test("applyActivity：同项目两个会话时一个结束，计数与另一个会话保留", () => {
  let state = applyActivity(emptyActivity(), event("s1", "p1", "running"));
  state = applyActivity(state, event("s2", "p1", "queued"));
  assert.equal(state.counts.get("p1"), 2);

  const after = applyActivity(state, event("s1", "p1", "completed", "2026-01-01T00:00:01.000Z"));
  assert.equal(after.counts.get("p1"), 1);
  assert.equal(after.sessions.get("s2"), "p1");
  assert.equal(after.sessions.has("s1"), false);
});

test("mergeActivity：用快照播种，只保留活跃会话", () => {
  const state = mergeActivity(
    [
      event("s1", "p1", "running"),
      event("s2", "p1", "queued"),
      event("s3", "p2", "completed"),
    ],
    [],
  );
  assert.equal(state.sessions.size, 2);
  assert.equal(state.sessions.get("s1"), "p1");
  assert.equal(state.sessions.get("s2"), "p1");
  assert.equal(state.counts.get("p1"), 2);
  assert.equal(state.counts.has("p2"), false);
});

test("mergeActivity：比快照旧的 active 事件被忽略，不会把状态改回去", () => {
  const snapshot = [event("s1", "p1", "completed", "2026-01-02T00:00:00.000Z")];
  const state = mergeActivity(snapshot, [
    event("s1", "p1", "running", "2026-01-01T00:00:00.000Z"),
  ]);
  assert.equal(state.sessions.has("s1"), false);
  assert.equal(state.counts.size, 0);
});

test("mergeActivity：比快照新的事件生效", () => {
  const snapshot = [event("s1", "p1", "running", "2026-01-01T00:00:00.000Z")];
  const state = mergeActivity(snapshot, [
    event("s1", "p1", "completed", "2026-01-02T00:00:00.000Z"),
  ]);
  assert.equal(state.sessions.has("s1"), false);
  assert.equal(state.counts.has("p1"), false);
});

test("mergeActivity：比快照新的换项目事件生效", () => {
  const snapshot = [event("s1", "p1", "running", "2026-01-01T00:00:00.000Z")];
  const state = mergeActivity(snapshot, [
    event("s1", "p2", "running", "2026-01-02T00:00:00.000Z"),
  ]);
  assert.equal(state.sessions.get("s1"), "p2");
  assert.equal(state.counts.has("p1"), false);
  assert.equal(state.counts.get("p2"), 1);
});

test("mergeActivity：快照里没有的新会话事件直接生效", () => {
  const state = mergeActivity(
    [event("s1", "p1", "running", "2026-01-02T00:00:00.000Z")],
    [event("s9", "p9", "queued", "2026-01-01T00:00:00.000Z")],
  );
  assert.equal(state.sessions.get("s9"), "p9");
  assert.equal(state.counts.get("p9"), 1);
});

test("mergeActivity：removed 事件即使更旧也生效", () => {
  const snapshot = [event("s1", "p1", "running", "2026-01-02T00:00:00.000Z")];
  const state = mergeActivity(snapshot, [
    event("s1", "p1", "running", "2026-01-01T00:00:00.000Z", true),
  ]);
  assert.equal(state.sessions.has("s1"), false);
  assert.equal(state.counts.size, 0);
});

test("activeProjectIds：与 counts 的项目集合一致，且不保留计数为 0 的项目", () => {
  let state = mergeActivity(
    [
      event("s1", "p1", "running"),
      event("s2", "p1", "queued"),
      event("s3", "p2", "needs_input"),
    ],
    [],
  );
  assert.deepEqual([...activeProjectIds(state)].sort(), ["p1", "p2"]);
  assert.equal(activeProjectIds(state).size, state.counts.size);

  state = applyActivity(state, event("s3", "p2", "completed", "2026-01-01T00:00:01.000Z"));
  assert.deepEqual([...activeProjectIds(state)], ["p1"]);
  assert.equal(state.counts.has("p2"), false);
});
