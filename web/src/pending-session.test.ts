import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "./api";
import {
  beginPendingSession,
  dropMatchedPending,
  matchesPending,
  pendingTitle,
  PROVISIONAL_TITLE,
} from "./pending-session";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "qubius",
    title: "修一下登录",
    providerId: "provider",
    providerName: "Provider",
    model: "model",
    effort: "high",
    phase: "queued",
    summary: "",
    git: true,
    cwd: "/tmp/work",
    isolated: false,
    subagentDone: 0,
    subagentTotal: 0,
    subagents: [],
    pending: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("占位标题直接取用户首条消息原文，规则与服务端一致", () => {
  assert.equal(pendingTitle("修一下登录"), "修一下登录");
  assert.equal(pendingTitle("  修一下   登录  "), "修一下 登录");
  assert.equal(pendingTitle("修一下登录\n顺便补测试"), "修一下登录");
  // 超长消息按字符截断。
  assert.equal(pendingTitle("字".repeat(50)).length, 40);
  // 只发图片时退回占位词。
  assert.equal(pendingTitle(""), PROVISIONAL_TITLE);
});

test("占位行带 local- 前缀和提交时间，记录已有的会话 id", () => {
  const pending = beginPendingSession({
    projectId: "qubius",
    existingIds: ["old-1", "old-2"],
    prompt: "修一下登录",
    now: 1000,
  });

  assert.ok(pending.id.startsWith("local-"));
  assert.equal(pending.projectId, "qubius");
  assert.equal(pending.title, "修一下登录");
  assert.equal(pending.startedAt, 1000);
  assert.deepEqual([...pending.knownIds], ["old-1", "old-2"]);
});

test("同项目、同标题、且是插入后新出现的会话才算匹配", () => {
  const pending = beginPendingSession({
    projectId: "qubius",
    existingIds: ["old"],
    prompt: "修一下登录",
    now: 1000,
  });

  assert.equal(matchesPending(pending, session({ id: "real-new" })), true);
  // 插入前就存在的同名会话不能被当成这一条。
  assert.equal(matchesPending(pending, session({ id: "old" })), false);
  assert.equal(matchesPending(pending, session({ id: "real-new", projectId: "other" })), false);
  assert.equal(matchesPending(pending, session({ id: "real-new", title: "别的任务" })), false);
});

test("只发图片时仍按占位标题匹配", () => {
  const pending = beginPendingSession({
    projectId: "qubius",
    existingIds: [],
    prompt: "",
    now: 1000,
  });

  assert.equal(pending.title, PROVISIONAL_TITLE);
  assert.equal(matchesPending(pending, session({ id: "real-new", title: PROVISIONAL_TITLE })), true);
});

test("真实会话出现后去掉占位行；没有变化时返回原数组", () => {
  const pending = beginPendingSession({
    projectId: "qubius",
    existingIds: [],
    prompt: "修一下登录",
    now: 1000,
  });

  const unchanged = dropMatchedPending([pending], [session({ id: "unrelated", title: "无关" })]);
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged[0], pending);
  assert.deepEqual(dropMatchedPending([pending], [session({ id: "real-new" })]), []);
});
