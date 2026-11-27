import assert from "node:assert/strict";
import test from "node:test";
import type { Transcript } from "./api";
import {
  groupTranscript,
  summarizeActivity,
  type ActivityGroup,
  type TranscriptGroup,
} from "./transcript-groups";

function item(overrides: Partial<Transcript> & Pick<Transcript, "id" | "role">): Transcript {
  return { text: "", ...overrides };
}

function user(id: string, text = "问题", extra: Partial<Transcript> = {}): Transcript {
  return item({ id, role: "user", text, ...extra });
}

function assistant(id: string, text: string, extra: Partial<Transcript> = {}): Transcript {
  return item({ id, role: "assistant", text, ...extra });
}

function tool(id: string, toolName: string, extra: Partial<Transcript> = {}): Transcript {
  return item({ id, role: "tool", toolName, text: "", ...extra });
}

function thinking(id: string, text: string, extra: Partial<Transcript> = {}): Transcript {
  return item({ id, role: "assistant", kind: "thinking", text, ...extra });
}

/** 按真实分组逻辑构造活动组，顺带验证 groupTranscript 对纯活动输入的处理。 */
function activity(items: Transcript[]): ActivityGroup {
  const groups = groupTranscript(items);
  assert.equal(groups.length, 1, "纯活动输入应只有一个分组");
  const [group] = groups;
  assert.equal(group.kind, "activity");
  return group as ActivityGroup;
}

function kinds(groups: TranscriptGroup[]): string[] {
  return groups.map((group) => group.kind);
}

test("用户、活动、assistant 正文按顺序交错", () => {
  const groups = groupTranscript([
    user("u1"),
    tool("t1", "Bash"),
    thinking("th1", "先看看目录"),
    tool("t2", "Read"),
    assistant("a1", "看完了"),
    user("u2", "继续"),
  ]);

  assert.deepEqual(kinds(groups), ["user", "activity", "assistant", "user"]);

  const group = groups[1] as ActivityGroup;
  assert.deepEqual(group.items.map((entry) => entry.id), ["t1", "th1", "t2"]);
  assert.equal(group.toolCount, 2);
  assert.equal(group.thinkingCount, 1);
});

test("多段活动合并，assistant 正文切断活动组", () => {
  const groups = groupTranscript([
    tool("t1", "Bash"),
    thinking("th1", "第一步"),
    assistant("a1", "中间结论"),
    tool("t2", "Read"),
    tool("t3", "Grep"),
    thinking("th2", "再想想"),
    assistant("a2", "最终结论"),
  ]);

  assert.deepEqual(kinds(groups), ["activity", "assistant", "activity", "assistant"]);
  assert.deepEqual((groups[0] as ActivityGroup).items.map((entry) => entry.id), ["t1", "th1"]);
  assert.deepEqual((groups[2] as ActivityGroup).items.map((entry) => entry.id), ["t2", "t3", "th2"]);
});

test("纯图片用户消息（text 为空）不被吞掉", () => {
  const groups = groupTranscript([
    user("u1", "", { images: [{ id: "img1", mediaType: "image/png" }] }),
    tool("t1", "Bash"),
  ]);

  assert.deepEqual(kinds(groups), ["user", "activity"]);
  assert.equal((groups[0] as { item: Transcript }).item.id, "u1");
});

test("空 user 消息也恒可渲染", () => {
  const groups = groupTranscript([user("u1", "")]);
  assert.deepEqual(kinds(groups), ["user"]);
});

test("空 assistant / 空 thinking 被跳过且不切断活动组", () => {
  const groups = groupTranscript([
    tool("t1", "Bash"),
    assistant("a-empty", ""),
    thinking("th-empty", ""),
    tool("t2", "Read"),
    assistant("a1", "完成"),
  ]);

  assert.deepEqual(kinds(groups), ["activity", "assistant"]);
  const group = groups[0] as ActivityGroup;
  assert.deepEqual(group.items.map((entry) => entry.id), ["t1", "t2"]);
  assert.equal(group.toolCount, 2);
  assert.equal(group.thinkingCount, 0);
  assert.equal((groups[1] as { item: Transcript }).item.id, "a1");
});

test("活动组的 key、计数、failed、active 正确", () => {
  const group = activity([
    tool("t1", "Bash", { toolStatus: "ok" }),
    thinking("th1", "分析"),
    tool("t2", "Read", { toolStatus: "error", partial: true }),
  ]);

  assert.equal(group.key, "t1");
  assert.equal(group.toolCount, 2);
  assert.equal(group.thinkingCount, 1);
  assert.equal(group.failed, true);
  assert.equal(group.active, true);

  const quiet = activity([tool("x1", "Bash", { toolStatus: "ok" }), thinking("x2", "想")]);
  assert.equal(quiet.key, "x1");
  assert.equal(quiet.failed, false);
  assert.equal(quiet.active, false);
});

test("空输入返回空数组，纯活动输入返回单个组", () => {
  assert.deepEqual(groupTranscript([]), []);

  const groups = groupTranscript([tool("t1", "Bash"), thinking("th1", "想")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "activity");
  assert.equal((groups[0] as ActivityGroup).toolCount, 1);
  assert.equal((groups[0] as ActivityGroup).thinkingCount, 1);
});

test("每条用户消息后的第一条带模型的回答才标记模型", () => {
  const groups = groupTranscript([
    user("u1"),
    tool("t1", "Bash"),
    assistant("a1", "第一段", { model: "model-a" }),
    assistant("a2", "同一轮的补充", { model: "model-a" }),
    user("u2"),
    // 旧数据没有 model：跳过它，等本轮第一条可标模型的正文。
    assistant("a3", "旧回答"),
    assistant("a4", "新回答", { model: "model-b" }),
  ]);

  const flags = groups.flatMap((group) => group.kind === "assistant" ? [group.showModel] : []);
  assert.deepEqual(flags, [true, false, false, true]);
});

test("活动组不打断本轮模型标记的等待", () => {
  const groups = groupTranscript([
    user("u1"),
    thinking("th1", "先想想"),
    tool("t1", "Read"),
    assistant("a1", "回答", { model: "model-a" }),
  ]);

  const assistantGroup = groups.find((group) => group.kind === "assistant");
  assert.equal(assistantGroup?.kind, "assistant");
  assert.equal(assistantGroup?.showModel, true);
});

test("summarizeActivity：工具优先标题，计数降序、同数按名称升序", () => {
  const group = activity([
    tool("t1", "Bash"),
    tool("t2", "Bash"),
    tool("t3", "Bash"),
    tool("t4", "Read"),
    tool("t5", "Read"),
    thinking("th1", "想"),
    thinking("th2", "再想"),
  ]);

  assert.deepEqual(summarizeActivity(group), {
    title: "执行 5 步",
    meta: "Bash ×3 · Read ×2 · 思考 ×2",
  });
});

test("summarizeActivity：同数工具按名称升序", () => {
  const group = activity([tool("t1", "Read"), tool("t2", "Bash")]);
  assert.deepEqual(summarizeActivity(group), {
    title: "执行 2 步",
    meta: "Bash · Read",
  });
});

test("summarizeActivity：单个工具与单个思考用单数", () => {
  const group = activity([tool("t1", "Bash"), thinking("th1", "想")]);
  assert.deepEqual(summarizeActivity(group), {
    title: "执行 1 步",
    meta: "Bash · 思考",
  });
});

test("summarizeActivity：没有工具时标题和明细只有思考", () => {
  assert.deepEqual(summarizeActivity(activity([thinking("th1", "想")])), {
    title: "思考 1 段",
    meta: "思考",
  });

  assert.deepEqual(summarizeActivity(activity([thinking("th1", "想"), thinking("th2", "再想")])), {
    title: "思考 2 段",
    meta: "思考 ×2",
  });
});

test("summarizeActivity：空组不抛错", () => {
  const empty: ActivityGroup = {
    kind: "activity",
    key: "empty",
    items: [],
    toolCount: 0,
    thinkingCount: 0,
    failed: false,
    active: false,
  };
  assert.deepEqual(summarizeActivity(empty), { title: "思考 0 段", meta: "" });
});
