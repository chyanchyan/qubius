import assert from "node:assert/strict";
import test from "node:test";
import {
  canContinue,
  clearAllCandidates,
  pickArchiveTargets,
  pickSelected,
  pruneSelected,
  toggleSelected,
} from "./session-selection";
import type { Session } from "./api";

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    projectId: "p",
    title: id,
    summary: "",
    providerId: "x",
    providerName: "X",
    model: "m",
    effort: "high",
    phase: "completed",
    git: true,
    cwd: "/tmp",
    isolated: false,
    subagentDone: 0,
    subagentTotal: 0,
    subagents: [],
    pending: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

test("只有中断、失败的会话可以继续", () => {
  assert.equal(canContinue({ phase: "failed" }), true);
  assert.equal(canContinue({ phase: "stopped" }), true);
  assert.equal(canContinue({ phase: "running" }), false);
  assert.equal(canContinue({ phase: "completed" }), false);
  assert.equal(canContinue({ phase: "needs_input" }), false);
  assert.equal(canContinue({ phase: "queued" }), false);
});

test("切换选中态不修改原集合", () => {
  const current: ReadonlySet<string> = new Set(["a"]);
  const added = toggleSelected(current, "b");
  assert.deepEqual([...added], ["a", "b"]);
  assert.deepEqual([...current], ["a"]);

  const removed = toggleSelected(added, "a");
  assert.deepEqual([...removed], ["b"]);
});

test("列表刷新只丢弃已经不存在的选中项", () => {
  const current: ReadonlySet<string> = new Set(["a", "b"]);
  const unchanged = pruneSelected(current, [session("a"), session("b")]);
  assert.equal(unchanged, current);

  const pruned = pruneSelected(current, [session("a")]);
  assert.deepEqual([...pruned], ["a"]);

  const empty: ReadonlySet<string> = new Set();
  assert.equal(pruneSelected(empty, []), empty);
});

test("批量操作按列表顺序返回选中会话", () => {
  const current: ReadonlySet<string> = new Set(["b", "c"]);
  const picked = pickSelected(current, [session("a"), session("b"), session("c")]);
  assert.deepEqual(picked.map((item) => item.id), ["b", "c"]);
  assert.deepEqual(pickSelected(new Set(), [session("a")]), []);
});

test("仅归档已合入时只保留分支在合入列表里的会话", () => {
  const sessions = [
    session("merged", { branch: "qubius/aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa" }),
    session("pending", { branch: "qubius/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }),
    session("plain", { git: false, branch: undefined }),
  ];
  const merged = new Set(["qubius/aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa"]);

  assert.deepEqual(
    pickArchiveTargets(sessions, true, merged).map((item) => item.id),
    ["merged"],
  );
  // 关掉开关时退回全部会话；没有分支的会话也不会被误判为已合入。
  assert.deepEqual(
    pickArchiveTargets(sessions, false, merged).map((item) => item.id),
    ["merged", "pending", "plain"],
  );
  assert.deepEqual(pickArchiveTargets(sessions, true, new Set()), []);
});

test("全部归档始终跳过运行中的会话", () => {
  const sessions = [
    session("done", { phase: "completed", branch: "qubius/aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa" }),
    session("running", { phase: "running", branch: "qubius/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }),
    session("queued", { phase: "queued", branch: "qubius/cccccccc-cccc-cccc-cccc-cccccccccccc" }),
    session("waiting", { phase: "needs_input", branch: "qubius/dddddddd-dddd-dddd-dddd-dddddddddddd" }),
    session("stopped", { phase: "stopped", branch: "qubius/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" }),
  ];
  const merged = new Set(sessions.map((item) => item.branch ?? ""));

  assert.deepEqual(
    pickArchiveTargets(sessions, true, merged).map((item) => item.id),
    ["done", "stopped"],
  );
  // 关掉「仅归档已合入」也不能碰运行中的会话。
  assert.deepEqual(
    pickArchiveTargets(sessions, false, merged).map((item) => item.id),
    ["done", "stopped"],
  );
});

test("从未改过代码的分支默认跳过，取消勾选时归档", () => {
  const unchanged = "qubius/aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa";
  const sessions = [
    session("done", { branch: "qubius/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }),
    session("never", { branch: unchanged }),
  ];
  const merged = new Set([sessions[0]?.branch ?? "", unchanged]);
  const untouched = new Set([unchanged]);

  // 绿 / 灰灯的区分只影响默认过滤：灰灯分支虽然已合入，但没有改动，默认保留。
  assert.deepEqual(
    pickArchiveTargets(sessions, true, merged, untouched).map((item) => item.id),
    ["done"],
  );
  // 取消勾选后归档所有非运行中的会话，包括从未改过代码的。
  assert.deepEqual(
    pickArchiveTargets(sessions, false, merged, untouched).map((item) => item.id),
    ["done", "never"],
  );
  assert.deepEqual(
    clearAllCandidates(sessions).map((item) => item.id),
    ["done", "never"],
  );
});
