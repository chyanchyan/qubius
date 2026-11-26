import assert from "node:assert/strict";
import test from "node:test";
import { answerBody, mergeAnswers } from "./answers";

const questions = [
  { question: "用哪个数据库？", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false },
  { question: "说明一下", options: [], multiSelect: false },
];

test("预设选项作为答案", () => {
  assert.deepEqual(mergeAnswers(questions, { "用哪个数据库？": "SQLite" }, {}), {
    "用哪个数据库？": "SQLite",
  });
});

test("自定义输入覆盖已选项并去除首尾空白", () => {
  assert.deepEqual(mergeAnswers(questions, { "用哪个数据库？": "SQLite" }, { "用哪个数据库？": "  DuckDB  " }), {
    "用哪个数据库？": "DuckDB",
  });
});

test("没有选项的问题用自定义输入回答", () => {
  assert.deepEqual(mergeAnswers(questions, {}, { 说明一下: "随便写点" }), {
    说明一下: "随便写点",
  });
});

test("空自定义输入不覆盖选项，全空则不是答案", () => {
  assert.deepEqual(mergeAnswers(questions, { "用哪个数据库？": "Postgres" }, { "用哪个数据库？": "   " }), {
    "用哪个数据库？": "Postgres",
  });
  assert.deepEqual(mergeAnswers(questions, {}, {}), {});
});

test("只收集当前问题，丢弃遗留答案", () => {
  assert.deepEqual(mergeAnswers(questions, { 其他问题: "旧值" }, {}), {});
});

test("没有问题时返回空对象", () => {
  assert.deepEqual(mergeAnswers(undefined, { a: "b" }, { a: "c" }), {});
});

test("问题允许时带上答案，不发送 remember", () => {
  assert.deepEqual(
    answerBody({ requestId: "r1", kind: "question" }, "allow", { q: "A" }, true),
    { requestId: "r1", behavior: "allow", answers: { q: "A" } },
  );
});

test("权限允许时只发送 remember", () => {
  assert.deepEqual(
    answerBody({ requestId: "r2", kind: "permission" }, "allow", { q: "A" }, true),
    { requestId: "r2", behavior: "allow", remember: true },
  );
  assert.deepEqual(
    answerBody({ requestId: "r2", kind: "permission" }, "allow", undefined, false),
    { requestId: "r2", behavior: "allow" },
  );
});

test("拒绝时不带答案和 remember", () => {
  assert.deepEqual(
    answerBody({ requestId: "r3", kind: "question" }, "deny", { q: "A" }, true),
    { requestId: "r3", behavior: "deny" },
  );
});

test("approvedFull 只在需要展开且允许时携带", () => {
  assert.deepEqual(
    answerBody({ requestId: "r4", kind: "permission", requiresExpand: true }, "allow", undefined, undefined, true),
    { requestId: "r4", behavior: "allow", approvedFull: true },
  );
  // 不需要展开时不带（即使调用方传了 true）。
  assert.deepEqual(
    answerBody({ requestId: "r5", kind: "permission", requiresExpand: false }, "allow", undefined, undefined, true),
    { requestId: "r5", behavior: "allow" },
  );
  // 没展开（false/缺省）时允许也不带。
  assert.deepEqual(
    answerBody({ requestId: "r6", kind: "permission", requiresExpand: true }, "allow"),
    { requestId: "r6", behavior: "allow" },
  );
  // 拒绝永远不带。
  assert.deepEqual(
    answerBody({ requestId: "r7", kind: "permission", requiresExpand: true }, "deny", undefined, undefined, true),
    { requestId: "r7", behavior: "deny" },
  );
  // 问题类型不带。
  assert.deepEqual(
    answerBody({ requestId: "r8", kind: "question", requiresExpand: true }, "allow", { q: "A" }, undefined, true),
    { requestId: "r8", behavior: "allow", answers: { q: "A" } },
  );
});
