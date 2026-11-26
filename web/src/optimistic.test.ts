import assert from "node:assert/strict";
import test from "node:test";
import type { Session, Transcript } from "./api";
import {
  appendOptimistic,
  beginOptimisticSend,
  dropOptimistic,
  isOptimistic,
  optimisticUserMessage,
  reconcileOptimistic,
} from "./optimistic";

function transcript(id: string, text: string, role: Transcript["role"] = "assistant"): Transcript {
  return { id, role, text };
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

test("乐观用户消息带 sending 状态和本地图片预览", () => {
  const message = optimisticUserMessage("你好", [
    { mediaType: "image/png", data: "AAAA", name: "a.png" },
  ], "2026-01-01T00:00:01.000Z");

  assert.equal(message.role, "user");
  assert.equal(message.text, "你好");
  assert.equal(message.status, "sending");
  assert.equal(message.at, "2026-01-01T00:00:01.000Z");
  assert.equal(message.images, undefined, "上传前不能伪造服务端图片 id");
  assert.deepEqual(message.pendingImages, [
    { mediaType: "image/png", data: "AAAA", name: "a.png" },
  ]);
  assert.ok(message.id.startsWith("local-"));
  assert.ok(isOptimistic(message));
});

test("两次发送的乐观消息 id 不同", () => {
  const a = optimisticUserMessage("一");
  const b = optimisticUserMessage("一");
  assert.notEqual(a.id, b.id);
});

test("appendOptimistic 接到末尾，同 id 不重复追加", () => {
  const base = session({ messages: [transcript("a", "历史")] });
  const item = optimisticUserMessage("新消息");

  const once = appendOptimistic(base, item);
  assert.deepEqual(once.messages?.map((message) => message.id), ["a", item.id]);
  assert.equal(appendOptimistic(once, item), once);
});

test("没有 messages 时也能先渲染一条", () => {
  const merged = appendOptimistic(session(), optimisticUserMessage("新消息"));
  assert.equal(merged.messages?.length, 1);
});

test("dropOptimistic 只删指定条目，不存在时原样返回", () => {
  const item = optimisticUserMessage("新消息");
  const base = session({ messages: [transcript("a", "历史"), item] });

  const dropped = dropOptimistic(base, item.id);
  assert.deepEqual(dropped.messages?.map((message) => message.id), ["a"]);
  assert.equal(dropOptimistic(dropped, item.id), dropped);
});

test("服务端总数增长后，用服务端消息替换乐观条目", () => {
  const item = optimisticUserMessage("新消息");
  const pending = { item, baseCount: 1 };
  const confirmed = session({
    messageCount: 2,
    messages: [transcript("a", "历史"), transcript("real", "新消息", "user")],
    // 帧里已经带上真实条目时，本地临时条目不应再出现。
  });
  // 客户端在合并时仍保留着乐观条目，需要 reconcile 把它清掉。
  const withLocal = appendOptimistic(confirmed, item);

  const reconciled = reconcileOptimistic(withLocal, pending);
  assert.deepEqual(reconciled.messages?.map((message) => message.id), ["a", "real"]);
});

test("旧帧把消息冲掉时，把乐观条目接回去", () => {
  const item = optimisticUserMessage("新消息");
  const pending = { item, baseCount: 1 };
  // 比发送更旧的帧：总数没涨，messages 里也没有新条目。
  const stale = session({ messageCount: 1, messages: [transcript("a", "历史")] });

  const reconciled = reconcileOptimistic(stale, pending);
  assert.deepEqual(reconciled.messages?.map((message) => message.id), ["a", item.id]);
});

test("分页加载时用服务端总数作为计数基线", () => {
  const item = optimisticUserMessage("新消息");
  const base = session({ messageCount: 300, messages: [transcript("a", "一页历史")] });
  const pending = beginOptimisticSend(base, "新消息");
  assert.equal(pending.baseCount, 300);
  assert.equal(pending.item.text, "新消息");
});
