import assert from "node:assert/strict";
import test from "node:test";
import { addPending, hasPending, removePending } from "./pending-actions";

test("同一会话重复添加返回 null，只保留一份", () => {
  const first = addPending(new Set(), "a");
  assert.ok(first);
  assert.equal(hasPending(first, "a"), true);

  const second = addPending(first, "a");
  assert.equal(second, null);
  assert.equal(first.size, 1);
});

test("不同会话互不影响，可以同时处于在途", () => {
  const one = addPending(new Set(), "a");
  assert.ok(one);
  const two = addPending(one, "b");
  assert.ok(two);

  assert.equal(hasPending(two, "a"), true);
  assert.equal(hasPending(two, "b"), true);
  assert.equal(two.size, 2);
});

test("添加不会修改原集合（不可变更新）", () => {
  const original = new Set(["a"]);
  const next = addPending(original, "b");
  assert.ok(next);
  assert.deepEqual([...original], ["a"]);
  assert.notEqual(next, original);
});

test("移除只影响目标会话，且不修改原集合", () => {
  const original = new Set(["a", "b"]);
  const next = removePending(original, "a");

  assert.equal(hasPending(next, "a"), false);
  assert.equal(hasPending(next, "b"), true);
  assert.deepEqual([...original], ["a", "b"]);
  assert.notEqual(next, original);
});

test("移除不存在的会话是空操作", () => {
  const original = new Set(["a"]);
  const next = removePending(original, "b");
  assert.deepEqual([...next], ["a"]);
  assert.equal(hasPending(next, "b"), false);
});
