import assert from "node:assert/strict";
import test from "node:test";
import {
  boardEntryMatches,
  filterBoardEntries,
  isBoardEntryAlwaysVisible,
  type BoardEntry,
} from "./board-filter";
import type { Pending, Session } from "./api";
import type { BatchWatch } from "./api-batch-watch";

function approval(): Pending {
  return {
    requestId: "req-1",
    kind: "permission",
    toolName: "Bash",
    inputPreview: "rm -rf build",
  };
}

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

function entry(extra: Partial<Session> = {}): BoardEntry {
  return { kind: "session", session: session("id", extra) };
}

function ids(entries: BoardEntry[]): string[] {
  return entries.map((item) => (
    item.kind === "session"
      ? item.session.id
      : item.kind === "watch"
        ? `watch-${item.watch.id}`
        : item.pending.id
  ));
}

function watch(id: string, targets: Array<{ sessionId: string; title: string }>): BatchWatch {
  return {
    id,
    projectId: "p",
    providerId: "prov",
    providerName: "接口",
    model: "m",
    effort: "high",
    actions: { commit: true, mergeMode: "merge", push: false, deploy: false },
    status: "waiting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    targetViews: targets.map((target) => ({
      sessionId: target.sessionId,
      title: target.title,
      currentTitle: target.title,
      phase: "running",
      ready: false,
    })),
  };
}

function watchEntry(id: string, targets: Array<{ sessionId: string; title: string }>): BoardEntry {
  return { kind: "watch", watch: watch(id, targets) };
}

test("按标题匹配，大小写不敏感", () => {
  const entries = [
    entry({ id: "a", title: "Fix Login Bug" }),
    entry({ id: "b", title: "整理文档" }),
  ];
  assert.deepEqual(ids(filterBoardEntries(entries, "login")), ["a"]);
  assert.deepEqual(ids(filterBoardEntries(entries, "LOGIN BUG")), ["a"]);
  assert.deepEqual(ids(filterBoardEntries(entries, "文档")), ["b"]);
});

test("按摘要和分支名匹配", () => {
  const entries = [
    entry({ id: "a", title: "a", summary: "重构会话列表" }),
    entry({ id: "b", title: "b", branch: "qubius/Feature-X" }),
    entry({ id: "c", title: "c", summary: "无关内容", branch: "main" }),
  ];
  assert.deepEqual(ids(filterBoardEntries(entries, "会话")), ["a"]);
  assert.deepEqual(ids(filterBoardEntries(entries, "feature-x")), ["b"]);
  assert.deepEqual(ids(filterBoardEntries(entries, "main")), ["c"]);
});

test("查询词两端空白会被忽略", () => {
  const entries = [entry({ id: "a", title: "Alpha" })];
  assert.deepEqual(ids(filterBoardEntries(entries, "  alpha  ")), ["a"]);
  assert.deepEqual(ids(filterBoardEntries(entries, "   ")), ["a"]);
});

test("空查询返回全部行的副本", () => {
  const entries = [entry({ id: "a" }), entry({ id: "b" })];
  const filtered = filterBoardEntries(entries, "");
  assert.deepEqual(ids(filtered), ["a", "b"]);
  assert.notEqual(filtered, entries);
});

test("创建中的占位行始终保留", () => {
  const pending: BoardEntry = {
    kind: "pending",
    pending: {
      id: "pending-1",
      projectId: "p",
      title: "新对话",
      startedAt: Date.now(),
      knownIds: new Set<string>(),
    },
  };
  const entries: BoardEntry[] = [entry({ id: "a", title: "Alpha" }), pending];
  assert.deepEqual(ids(filterBoardEntries(entries, "alpha")), ["a", "pending-1"]);
  assert.deepEqual(ids(filterBoardEntries(entries, "zzz")), ["pending-1"]);
});

test("等待确认的会话始终保留", () => {
  const waiting = entry({
    id: "waiting",
    title: "需要授权",
    phase: "needs_input",
    pending: approval(),
  });
  const entries: BoardEntry[] = [entry({ id: "other", title: "其他" }), waiting];
  assert.deepEqual(ids(filterBoardEntries(entries, "其他")), ["other", "waiting"]);
  assert.deepEqual(ids(filterBoardEntries(entries, "zzz")), ["waiting"]);
  assert.equal(isBoardEntryAlwaysVisible(waiting), true);
  assert.equal(isBoardEntryAlwaysVisible(entry({ id: "done" })), false);
});

test("运行中的会话始终保留", () => {
  const running = entry({ id: "running", title: "后台跑", phase: "running" });
  const entries: BoardEntry[] = [entry({ id: "other", title: "其他" }), running];
  assert.deepEqual(ids(filterBoardEntries(entries, "zzz")), ["running"]);
});

test("排队中的会话不匹配也保留", () => {
  const queued = entry({ id: "queued", title: "排队中", phase: "queued" });
  const entries: BoardEntry[] = [entry({ id: "other", title: "其他" }), queued];
  assert.equal(boardEntryMatches(queued, "zzz"), false);
  assert.equal(isBoardEntryAlwaysVisible(queued), true);
  assert.deepEqual(ids(filterBoardEntries(entries, "zzz")), ["queued"]);
});

test("普通结束的会话不匹配时隐藏", () => {
  const done = entry({ id: "done", title: "已完成", phase: "completed" });
  const entries: BoardEntry[] = [entry({ id: "other", title: "其他" }), done];
  assert.equal(isBoardEntryAlwaysVisible(done), false);
  assert.deepEqual(ids(filterBoardEntries(entries, "zzz")), []);
  assert.deepEqual(ids(filterBoardEntries(entries, "已完成")), ["done"]);
});

test("等待确认但没有 pending 的会话也保留", () => {
  const waiting = entry({ id: "waiting", title: "等待输入", phase: "needs_input", pending: null });
  assert.equal(isBoardEntryAlwaysVisible(waiting), true);
});

test("boardEntryMatches 只判断元数据，不包含始终可见规则", () => {
  const waiting = entry({
    id: "waiting",
    title: "需要授权",
    pending: approval(),
  });
  assert.equal(boardEntryMatches(waiting, "授权"), true);
  assert.equal(boardEntryMatches(waiting, "zzz"), false);
  assert.equal(boardEntryMatches(waiting, "  "), true);
});

test("监听任务按来源会话标题匹配，且始终保留在列表里", () => {
  const watch = watchEntry("w1", [
    { sessionId: "s1", title: "修复移动端布局" },
    { sessionId: "s2", title: "补充测试" },
  ]);
  assert.equal(boardEntryMatches(watch, "移动端"), true);
  assert.equal(boardEntryMatches(watch, "补充"), true);
  assert.equal(boardEntryMatches(watch, "监听"), true);
  assert.equal(boardEntryMatches(watch, "zzz"), false);
  assert.equal(isBoardEntryAlwaysVisible(watch), true);

  const entries: BoardEntry[] = [entry({ id: "other", title: "其他" }), watch];
  assert.deepEqual(ids(filterBoardEntries(entries, "zzz")), ["watch-w1"]);
});
