import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSessionFrame,
  prependHistoryPage,
  type Session,
  type Transcript,
} from "./api";

/**
 * /api/events?session= 帧的合并规则：
 * - 有 messages 时按 messagesFrom 拼接（0 视为全量）；
 * - 没有 messages 时只更新元数据，本地消息必须保留；
 * - removed 帧不参与合并。
 */

function transcript(id: string, text: string): Transcript {
  return { id, role: "assistant", text };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "chat",
    title: "测试会话",
    providerId: "provider",
    providerName: "Provider",
    model: "model",
    effort: "high",
    phase: "running",
    summary: "",
    git: false,
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

test("没有本地会话时，初始帧直接建立会话", () => {
  const frame = session({
    messagesFrom: 0,
    messageCount: 2,
    messages: [transcript("a", "一"), transcript("b", "二")],
  });

  const merged = mergeSessionFrame(null, frame);

  assert.ok(merged);
  assert.equal(merged.id, frame.id);
  assert.equal(merged.messageCount, 2);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["a", "b"]);
});

test("messagesFrom=0 的帧覆盖全部本地消息（全量快照）", () => {
  const previous = session({
    messages: [transcript("old", "旧")],
    title: "旧标题",
  });
  const frame = session({
    title: "新标题",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messagesFrom: 0,
    messageCount: 1,
    messages: [transcript("new", "新")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.equal(merged.title, "新标题");
  assert.deepEqual(merged.messages?.map((item) => item.id), ["new"]);
});

test("messagesFrom 保留本地前段并追加新消息（增量帧）", () => {
  const previous = session({
    messages: [transcript("a", "一"), transcript("b", "二"), transcript("b-partial", "旧的增量")],
    messageCount: 3,
  });
  const frame = session({
    messagesFrom: 2,
    messageCount: 3,
    messages: [transcript("b-done", "完成")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["a", "b", "b-done"]);
  assert.equal(merged.messageCount, 3);
});

test("没有 messages 的帧只更新元数据并保留本地消息", () => {
  const previous = session({
    phase: "running",
    messages: [transcript("a", "一")],
  });
  const frame = session({
    phase: "completed",
    summary: "做完了",
    updatedAt: "2026-01-03T00:00:00.000Z",
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.equal(merged.phase, "completed");
  assert.equal(merged.summary, "做完了");
  assert.deepEqual(merged.messages?.map((item) => item.id), ["a"]);
});

test("带 messages 但缺省 messagesFrom 时按全量处理", () => {
  const previous = session({ messages: [transcript("old", "旧")] });
  const frame = session({ messages: [transcript("new", "新")] });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["new"]);
});

test("removed 帧返回 null，由调用方负责移除/跳转", () => {
  const previous = session({ messages: [transcript("a", "一")] });
  const frame = session({ removed: true });

  assert.equal(mergeSessionFrame(previous, frame), null);
});

test("增量帧从本地末端开始（offset=len）时保留全部本地并追加", () => {
  const previous = session({
    messages: [transcript("a", "一"), transcript("b", "二"), transcript("c", "三")],
    historyStart: 0,
    messageCount: 3,
  });
  const frame = session({
    messagesFrom: 3,
    messageCount: 4,
    messages: [transcript("d", "四")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(merged.historyStart, 0);
  assert.equal(merged.messageCount, 4);
});

test("增量帧从本地起点开始（offset=0）时用完整尾部替换本地窗口", () => {
  const previous = session({
    messages: [transcript("e-old", "五（旧）"), transcript("f", "六")],
    historyStart: 4,
    messageCount: 6,
  });
  const frame = session({
    messagesFrom: 4,
    messageCount: 7,
    messages: [transcript("e", "五"), transcript("f", "六"), transcript("g", "七")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["e", "f", "g"]);
  assert.equal(merged.historyStart, 4);
  assert.equal(merged.messageCount, 7);
});

test("messagesFrom 超出本地末端时不留下空档，接受帧内容并重置起点", () => {
  const previous = session({
    messages: [transcript("a", "一")],
    historyStart: 0,
    messageCount: 2,
  });
  const frame = session({
    messagesFrom: 5,
    messageCount: 6,
    messages: [transcript("f", "六")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["f"]);
  assert.equal(merged.historyStart, 5);
  assert.equal(merged.messageCount, 6);
});

test("reset 帧整段替换本地消息并记录 historyStart", () => {
  const previous = session({
    messages: [transcript("old", "旧")],
    historyStart: 10,
    messageCount: 12,
  });
  const frame = session({
    reset: true,
    messagesFrom: 8,
    messageCount: 10,
    messages: [transcript("t8", "八"), transcript("t9", "九")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["t8", "t9"]);
  assert.equal(merged.historyStart, 8);
  assert.equal(merged.messageCount, 10);
});

test("增量帧按 messagesFrom - historyStart 保留本地前段再拼接", () => {
  const previous = session({
    messages: [transcript("t2", "二"), transcript("t3", "三"), transcript("t4-old", "四（旧）")],
    historyStart: 2,
    messageCount: 5,
  });
  const frame = session({
    messagesFrom: 4,
    messageCount: 5,
    messages: [transcript("t4", "四")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["t2", "t3", "t4"]);
  assert.equal(merged.historyStart, 2);
  assert.equal(merged.messageCount, 5);
});

test("变化早于 historyStart 时切掉帧内前缀，用尾部替换本地窗口", () => {
  const previous = session({
    messages: [transcript("t4-old", "四（旧）"), transcript("t5", "五")],
    historyStart: 4,
    messageCount: 6,
    summary: "",
  });
  // 真实帧语义：messages 是从 messagesFrom 到末尾的完整尾部。
  const frame = session({
    messagesFrom: 1,
    messageCount: 7,
    messages: [
      transcript("t1", "一"),
      transcript("t2", "二"),
      transcript("t3", "三"),
      transcript("t4", "四"),
      transcript("t5", "五"),
      transcript("t6", "六"),
    ],
    summary: "更新后的摘要",
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  // offset = historyStart - from = 3：丢掉帧内已在本地的前缀，尾部更新不丢。
  assert.deepEqual(merged.messages?.map((item) => item.id), ["t4", "t5", "t6"]);
  assert.equal(merged.historyStart, 4);
  assert.equal(merged.messageCount, 7);
  assert.equal(merged.summary, "更新后的摘要");
});

test("变化早于 historyStart 且帧尾部比本地窗口还短时接受帧内容", () => {
  const previous = session({
    messages: [transcript("t4", "四"), transcript("t5", "五")],
    historyStart: 4,
    messageCount: 6,
  });
  const frame = session({
    messagesFrom: 1,
    messageCount: 3,
    messages: [transcript("t1", "一"), transcript("t2", "二")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  // offset=3 超出帧长 2：不能留下“计数新、内容旧”的组合。
  assert.deepEqual(merged.messages?.map((item) => item.id), ["t1", "t2"]);
  assert.equal(merged.historyStart, 1);
  assert.equal(merged.messageCount, 3);
});

test("加载更早一页时 prepend 消息并更新 historyStart", () => {
  const previous = session({
    messages: [transcript("t4", "四"), transcript("t5", "五")],
    historyStart: 4,
    messageCount: 6,
  });

  const merged = prependHistoryPage(previous, {
    start: 2,
    messageCount: 6,
    messages: [transcript("t2", "二"), transcript("t3", "三")],
  });

  assert.equal(merged.id, previous.id);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["t2", "t3", "t4", "t5"]);
  assert.equal(merged.historyStart, 2);
  assert.equal(merged.messageCount, 6);
});

test("增量帧保留本地已加载的更早历史", () => {
  const previous = session({
    messages: [transcript("t0", "零"), transcript("t1", "一"), transcript("t2-old", "二（旧）")],
    historyStart: 0,
    messageCount: 3,
  });
  const frame = session({
    messagesFrom: 2,
    messageCount: 3,
    messages: [transcript("t2", "二")],
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.deepEqual(merged.messages?.map((item) => item.id), ["t0", "t1", "t2"]);
  assert.equal(merged.historyStart, 0);
});

test("帧里没有 workflow 时清掉本地旧工作流", () => {
  const previous = session({
    workflow: { skill: "prl", startedAt: "2026-01-01T00:00:00.000Z" },
  });
  const frame = session({
    phase: "running",
    updatedAt: "2026-01-01T00:01:00.000Z",
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.equal(merged.workflow, undefined);
});

test("帧里带新 workflow 时覆盖本地旧工作流", () => {
  const previous = session({
    workflow: { skill: "prl", startedAt: "2026-01-01T00:00:00.000Z" },
  });
  const frame = session({
    workflow: { skill: "plan", startedAt: "2026-01-01T00:02:00.000Z" },
    updatedAt: "2026-01-01T00:02:00.000Z",
  });

  const merged = mergeSessionFrame(previous, frame);

  assert.ok(merged);
  assert.equal(merged.workflow?.skill, "plan");
});
