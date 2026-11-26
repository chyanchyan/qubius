import assert from "node:assert/strict";
import test from "node:test";
import { keyboardOpen } from "./viewport";

test("keyboardOpen：底边没变化时不算键盘", () => {
  assert.equal(keyboardOpen(844, 844, 844), false);
});

test("keyboardOpen：布局视口随键盘一起缩（resizes-content）也认得出", () => {
  /* 布局视口缩到 508，可视视口同样 508，覆盖差为 0，只能靠历史底边发现。 */
  assert.equal(keyboardOpen(844, 508, 508), true);
});

test("keyboardOpen：iOS Safari 布局视口不缩，靠布局视口与底边的差发现", () => {
  assert.equal(keyboardOpen(844, 508, 844), true);
});

test("keyboardOpen：地址栏这类几十像素的收缩不算键盘", () => {
  assert.equal(keyboardOpen(844, 780, 844), false);
  assert.equal(keyboardOpen(844, 760, 844), false);
});

test("keyboardOpen：超过 120px 的收缩才算键盘", () => {
  assert.equal(keyboardOpen(844, 724, 844), false);
  assert.equal(keyboardOpen(844, 700, 844), true);
});

test("keyboardOpen：刚打开页面时底边就是当前值，不会误判", () => {
  assert.equal(keyboardOpen(700, 700, 700), false);
});
