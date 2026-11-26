import assert from "node:assert/strict";
import test from "node:test";
import { enterSendMode } from "./composer-keys";

const base = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false };

test("Enter 默认排队", () => {
  assert.equal(enterSendMode(base), "queue");
});

test("Ctrl+Enter / Cmd+Enter 插话", () => {
  assert.equal(enterSendMode({ ...base, ctrlKey: true }), "interject");
  assert.equal(enterSendMode({ ...base, metaKey: true }), "interject");
});

test("Shift+Enter 换行、输入法组词和其它键都不提交", () => {
  assert.equal(enterSendMode({ ...base, shiftKey: true }), null);
  assert.equal(enterSendMode({ ...base, isComposing: true }), null);
  assert.equal(enterSendMode({ ...base, key: "a" }), null);
});
