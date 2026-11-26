import assert from "node:assert/strict";
import test from "node:test";
import { isTouchPointer } from "./pointer";

test("只有 touch 指针触发隐藏手势", () => {
  assert.equal(isTouchPointer({ pointerType: "touch" }), true);
  assert.equal(isTouchPointer({ pointerType: "mouse" }), false);
  assert.equal(isTouchPointer({ pointerType: "pen" }), false);
});
