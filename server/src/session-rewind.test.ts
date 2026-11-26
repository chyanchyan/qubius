import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  entriesFromSdkMessages,
  findUserMessageIndex,
  remapForks,
  ROOT_FORK_POINT,
  sliceBefore,
  sliceThrough,
} from "./session-rewind.js";
import type { TranscriptItem } from "./types.js";

/** 构造一条 SDK transcript 消息；内容默认包成 user/assistant 的 message.content。 */
function sdk(
  type: SessionMessage["type"],
  uuid: string,
  content: unknown,
  extras: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    type,
    uuid,
    session_id: "sdk-session",
    message: { role: type, content },
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extras,
  };
}

function user(uuid: string, content: unknown, extras: Partial<SessionMessage> = {}): SessionMessage {
  return sdk("user", uuid, content, extras);
}

test("entriesFromSdkMessages：字符串 user 是 prompt，多个 text 块用换行连接", () => {
  const entries = entriesFromSdkMessages([
    user("u1", "第一问"),
    user("u2", [
      { type: "text", text: "指令前缀" },
      { type: "text", text: "真正的请求" },
    ]),
  ]);
  assert.deepEqual(entries, [
    {
      uuid: "u1",
      kind: "user",
      prompt: true,
      text: "第一问",
      texts: ["第一问"],
      hasImages: false,
    },
    {
      uuid: "u2",
      kind: "user",
      prompt: true,
      text: "指令前缀\n真正的请求",
      texts: ["指令前缀", "真正的请求"],
      hasImages: false,
    },
  ]);
});

test("entriesFromSdkMessages：纯 tool_result 不是 prompt，图片 prompt 标记 hasImages", () => {
  const entries = entriesFromSdkMessages([
    user("t1", [{ type: "tool_result", tool_use_id: "x", content: "结果" }]),
    user("img", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    ]),
  ]);
  assert.equal(entries[0]?.prompt, false);
  assert.equal(entries[0]?.text, "");
  assert.deepEqual(entries[0]?.texts, []);
  assert.equal(entries[1]?.prompt, true);
  assert.equal(entries[1]?.hasImages, true);
  assert.equal(entries[1]?.text, "");
  assert.deepEqual(entries[1]?.texts, []);
});

test("entriesFromSdkMessages：跳过子 agent 条目，assistant/system 只是 chain 条目", () => {
  const entries = entriesFromSdkMessages([
    user("u1", "你好"),
    user("sub", "子任务输入", { parent_tool_use_id: "tool-1" }),
    sdk("assistant", "a1", [{ type: "text", text: "回答" }]),
    sdk("system", "c1", {}),
  ]);
  assert.deepEqual(entries.map((item) => item.uuid), ["u1", "a1", "c1"]);
  assert.deepEqual(entries.map((item) => item.prompt), [true, false, false]);
  assert.deepEqual(entries.map((item) => item.kind), ["user", "assistant", "system"]);
  assert.deepEqual(entries[1]?.texts, []);
  assert.deepEqual(entries[2]?.texts, []);
});

test("remapForks：按顺序配对，forkPoint 指向前一条 chain 条目", () => {
  const entries = entriesFromSdkMessages([
    user("u1", "第一问"),
    sdk("assistant", "a1", [{ type: "text", text: "第一个回答" }]),
    user("u2", "第二问"),
    sdk("assistant", "a2", [{ type: "text", text: "第二个回答" }]),
  ]);
  const messages: TranscriptItem[] = [
    { id: "m1", role: "user", text: "第一问", sdkUuid: "stale", forkPoint: "stale-point" },
    { id: "m2", role: "assistant", text: "第一个回答" },
    { id: "m3", role: "user", text: "第二问" },
    { id: "m4", role: "assistant", text: "第二个回答" },
  ];
  const result = remapForks(messages, entries);
  assert.equal(result.messages[0]?.sdkUuid, "u1");
  assert.equal(result.messages[0]?.forkPoint, ROOT_FORK_POINT);
  assert.equal(result.messages[2]?.sdkUuid, "u2");
  assert.equal(result.messages[2]?.forkPoint, "a1");
  assert.equal(result.lastSdkUuid, "a2");
  // 非用户条目原样复用。
  assert.equal(result.messages[1], messages[1]);
});

test("remapForks：工作流前缀（额外 text 块）用结尾文本配对", () => {
  const entries = entriesFromSdkMessages([
    user("u1", [
      { type: "text", text: "本消息选择了 prl 工作流（并行开发 + 一对一评审）。请先调用 prl skill。" },
      { type: "text", text: "实现登录" },
    ]),
    sdk("assistant", "a1", []),
  ]);
  const result = remapForks([{ id: "m1", role: "user", text: "实现登录" }], entries);
  assert.equal(result.messages[0]?.sdkUuid, "u1");
  assert.equal(result.messages[0]?.forkPoint, ROOT_FORK_POINT);
});

test("remapForks：额外提醒 block 不影响精确块匹配，但块内结尾相同不会误配", () => {
  // 真实 prompt 后面跟随一个独立的提醒 block：精确命中第一个块。
  const withReminder = entriesFromSdkMessages([
    sdk("assistant", "a0", []),
    user("u1", [
      { type: "text", text: "实现登录" },
      { type: "text", text: "系统提醒：请注意上下文可能被裁剪" },
    ]),
  ]);
  const matched = remapForks([{ id: "m1", role: "user", text: "实现登录" }], withReminder);
  assert.equal(matched.messages[0]?.sdkUuid, "u1");
  assert.equal(matched.messages[0]?.forkPoint, "a0");

  // 单个 block 只是以本地文本结尾（"实现登录" vs "登录"）不再算匹配：
  // 旧的 endsWith 规则会把这条不相关的本地消息错配过去。
  const suffix = entriesFromSdkMessages([
    sdk("assistant", "a0", []),
    user("u2", [{ type: "text", text: "实现登录" }]),
  ]);
  const wrong = remapForks(
    [{ id: "m2", role: "user", text: "登录", sdkUuid: "old", forkPoint: "old-point" }],
    suffix,
  );
  assert.equal(wrong.messages[0]?.sdkUuid, undefined);
  assert.equal(wrong.messages[0]?.forkPoint, undefined);
});

test("remapForks：图片 prompt（本地文本为空）靠 hasImages 配对", () => {
  const entries = entriesFromSdkMessages([
    sdk("assistant", "a0", []),
    user("u1", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    ]),
  ]);
  const images = [{ id: "img1", mediaType: "image/png" as const }];
  const result = remapForks([{ id: "m1", role: "user", text: "", images }], entries);
  assert.equal(result.messages[0]?.sdkUuid, "u1");
  assert.equal(result.messages[0]?.forkPoint, "a0");
});

test("remapForks：没有对应 SDK 条目的用户消息清掉旧指针", () => {
  const entries = entriesFromSdkMessages([user("u1", "保留")]);
  const messages: TranscriptItem[] = [
    { id: "m1", role: "user", text: "保留", sdkUuid: "u1", forkPoint: ROOT_FORK_POINT },
    { id: "m2", role: "user", text: "本地独有", sdkUuid: "gone", forkPoint: "gone-point" },
  ];
  const result = remapForks(messages, entries);
  assert.equal(result.messages[1]?.sdkUuid, undefined);
  assert.equal(result.messages[1]?.forkPoint, undefined);
  // 配对上的条目保留新指针。
  assert.equal(result.messages[0]?.sdkUuid, "u1");
});

test("remapForks：空 transcript 返回空 lastSdkUuid 并清掉全部旧指针", () => {
  const result = remapForks(
    [{ id: "m1", role: "user", text: "旧消息", sdkUuid: "old", forkPoint: "old-point" }],
    [],
  );
  assert.equal(result.lastSdkUuid, undefined);
  assert.equal(result.messages[0]?.sdkUuid, undefined);
  assert.equal(result.messages[0]?.forkPoint, undefined);
});

test("findUserMessageIndex 只认用户消息", () => {
  const messages: TranscriptItem[] = [
    { id: "a1", role: "assistant", text: "回答" },
    { id: "u1", role: "user", text: "问题" },
    { id: "t1", role: "tool", text: "工具" },
  ];
  assert.equal(findUserMessageIndex(messages, "u1"), 1);
  assert.equal(findUserMessageIndex(messages, "a1"), -1);
  assert.equal(findUserMessageIndex(messages, "missing"), -1);
});

test("sliceBefore / sliceThrough 按目标消息切分并处理越界", () => {
  const messages: TranscriptItem[] = [
    { id: "m1", role: "user", text: "一" },
    { id: "m2", role: "assistant", text: "二" },
    { id: "m3", role: "user", text: "三" },
  ];
  assert.deepEqual(sliceBefore(messages, 1).map((item) => item.id), ["m1"]);
  assert.deepEqual(sliceThrough(messages, 1).map((item) => item.id), ["m1", "m2"]);
  assert.deepEqual(sliceBefore(messages, 0), []);
  assert.deepEqual(sliceThrough(messages, -1), []);
  assert.deepEqual(sliceThrough(messages, 99).map((item) => item.id), ["m1", "m2", "m3"]);
});
