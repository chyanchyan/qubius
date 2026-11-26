import assert from "node:assert/strict";
import test from "node:test";
import { currentTurnUsage, formatTurnUsageLabel } from "./turn-usage";
import type { TokenUsage, Transcript } from "./api";

function user(text: string): Transcript {
  return { id: `u-${text}`, role: "user", text };
}

function answer(text: string, usage?: TokenUsage): Transcript {
  return { id: `a-${text}`, role: "assistant", text, ...(usage ? { usage } : {}) };
}

function thinking(text: string, partial = false): Transcript {
  return { id: `t-${text}`, role: "assistant", kind: "thinking", text, partial };
}

function tool(text: string): Transcript {
  return { id: `tool-${text}`, role: "tool", toolName: "Bash", text };
}

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenUsage => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

test("currentTurnUsage：没有消息或只有用户消息时为 undefined", () => {
  assert.equal(currentTurnUsage([]), undefined);
  assert.equal(currentTurnUsage([user("试试")]), undefined);
});

test("currentTurnUsage：只统计最后一条用户消息之后的用量", () => {
  const messages = [
    user("旧问题"),
    answer("旧回答", usage(100, 10)),
    user("新问题"),
    answer("新回答", usage(200, 20, 30, 40)),
  ];
  assert.deepEqual(currentTurnUsage(messages), usage(200, 20, 30, 40));
});

test("currentTurnUsage：多轮调用累加真实用量", () => {
  const messages = [
    user("查一下"),
    answer("先看结构", usage(1000, 50)),
    tool("{\"command\":\"ls\"}"),
    answer("结论", usage(3000, 80, 500)),
  ];
  assert.deepEqual(currentTurnUsage(messages), usage(4000, 130, 500));
});

test("currentTurnUsage：流式思考、工具输入和正文按估算计入输出", () => {
  const messages = [
    user("继续"),
    thinking("先想想", true),
    tool("{\"command\":\"pwd\"}"),
    answer("正在写", undefined),
  ];
  const result = currentTurnUsage(messages);
  assert.ok(result);
  assert.equal(result.input, 0);
  assert.equal(result.output, 3 + 4 + 3); // 「先想想」+ 工具输入 + 「正在写」
});

test("currentTurnUsage：真实 usage 接管同段的估算，不重复计数", () => {
  const messages = [
    user("继续"),
    thinking("先想想"),
    answer("回答", usage(1500, 120)),
  ];
  assert.deepEqual(currentTurnUsage(messages), usage(1500, 120));
});

test("currentTurnUsage：没有用户消息时从第一条开始算", () => {
  assert.deepEqual(currentTurnUsage([answer("自动回复", usage(10, 2))]), usage(10, 2));
});

test("formatTurnUsageLabel：没有真实输入时只显示输出", () => {
  assert.equal(formatTurnUsageLabel(usage(0, 320)), "↓320");
});

test("formatTurnUsageLabel：有真实输入时显示 ↑输入 ↓输出", () => {
  assert.equal(formatTurnUsageLabel(usage(13586, 191, 2000)), "↑15.6k ↓191");
});
