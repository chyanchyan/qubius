import assert from "node:assert/strict";
import test from "node:test";
import type { Session, Transcript } from "./api";
import { resolveHistoryView } from "./components/Thread";

function transcript(id: string): Transcript {
  return { id, role: "assistant", text: id };
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

function messages(count: number, prefix = "m"): Transcript[] {
  return Array.from({ length: count }, (_, index) => transcript(`${prefix}${index}`));
}

test("有 messageCount 时隐藏数按服务端总数减本地条数计算", () => {
  const view = resolveHistoryView(session({
    messages: messages(2),
    messageCount: 5,
    historyStart: 3,
  }), 200);

  assert.equal(view.usingRemoteHistory, true);
  assert.equal(view.hiddenCount, 3);
  // 本地已经全部加载的片段都渲染，不再做客户端窗口切片。
  assert.deepEqual(view.visibleMessages.map((item) => item.id), ["m0", "m1"]);
});

test("本地已加载完时不再显示“更早”", () => {
  const view = resolveHistoryView(session({
    messages: messages(5),
    messageCount: 5,
    historyStart: 0,
  }), 200);

  assert.equal(view.hiddenCount, 0);
  assert.equal(view.visibleMessages.length, 5);
});

test("没有 messageCount 时退回本地窗口逻辑", () => {
  const view = resolveHistoryView(session({
    messages: messages(5),
  }), 2);

  assert.equal(view.usingRemoteHistory, false);
  assert.equal(view.hiddenCount, 3);
  assert.deepEqual(view.visibleMessages.map((item) => item.id), ["m3", "m4"]);
});

test("本地已持有完整历史时，即使 SSE 补上 messageCount 也走本地 200 条窗口", () => {
  // 典型场景：reload()/发送响应给了完整 messages（不带 historyStart），
  // 随后某个 SSE 帧补上 messageCount。
  const view = resolveHistoryView(session({
    messages: messages(500),
    messageCount: 500,
  }), 200);

  assert.equal(view.usingRemoteHistory, false);
  assert.equal(view.hiddenCount, 300);
  assert.equal(view.visibleMessages.length, 200);
  assert.equal(view.visibleMessages[0]?.id, "m300");
  assert.equal(view.visibleMessages.at(-1)?.id, "m499");
});

test("分页翻到 start=0 后仍保持 remote 模式，全部已加载消息可见", () => {
  // prependHistoryPage 翻到最老一页时 historyStart=0，但 messages.length === messageCount；
  // 不能切回本地窗口，否则刚加载的历史会被重新隐藏。
  const view = resolveHistoryView(session({
    messages: messages(500),
    historyStart: 0,
    messageCount: 500,
  }), 200);

  assert.equal(view.usingRemoteHistory, true);
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.visibleMessages.length, 500);
  assert.equal(view.visibleMessages[0]?.id, "m0");
  assert.equal(view.visibleMessages.at(-1)?.id, "m499");
});

test("分页模式 historyStart 缺失 messageCount 时用本地条数兜底", () => {
  const view = resolveHistoryView(session({
    messages: messages(3),
    historyStart: 2,
  }), 200);

  assert.equal(view.usingRemoteHistory, true);
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.visibleMessages.length, 3);
});
