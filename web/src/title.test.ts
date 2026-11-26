import assert from "node:assert/strict";
import test from "node:test";
import { composeTitle, shouldApplyTitle } from "./title";

test("没有待处理会话时使用普通标题", () => {
  assert.equal(composeTitle("设置 · Qubius", 0), "设置 · Qubius");
});

test("有待处理会话时在标题前加计数", () => {
  assert.equal(composeTitle("设置 · Qubius", 2), "(2) 设置 · Qubius");
  assert.equal(composeTitle("项目甲 · Qubius", 1), "(1) 项目甲 · Qubius");
});

test("空标题保持为空，不产生只有计数的标题", () => {
  assert.equal(composeTitle("", 3), "");
});

test("页面细化标题不会被迟到的路由兜底标题覆盖", () => {
  assert.equal(shouldApplyTitle(1, 0, false), false);
  assert.equal(shouldApplyTitle(1, 1, false), true);
  assert.equal(shouldApplyTitle(0, 0, false), true);
  assert.equal(shouldApplyTitle(1, 0, true), true);
});
