import assert from "node:assert/strict";
import test from "node:test";
import { pinnedPushOffset } from "./sticky-push";

test("下一条还没碰到气泡下沿时不推", () => {
  // 气泡占 [0, 30]，下一条从 40 开始。
  assert.equal(pinnedPushOffset(0, 30, 40), 0);
  // 刚好贴着下沿也算没接触。
  assert.equal(pinnedPushOffset(0, 30, 30), 0);
});

test("越过下沿多少就推多少", () => {
  // 下一条顶到 20，越过 10px，整条气泡上移 10px。
  assert.equal(pinnedPushOffset(0, 30, 20), 10);
  assert.equal(pinnedPushOffset(100, 30, 110), 20);
});

test("下一条到达吸附线时旧气泡整条让出，不会推过头", () => {
  assert.equal(pinnedPushOffset(0, 30, 0), 30);
  assert.equal(pinnedPushOffset(0, 30, -50), 30);
});

test("没有下一条消息（Infinity）时不推", () => {
  assert.equal(pinnedPushOffset(0, 30, Number.POSITIVE_INFINITY), 0);
});

test("高度非正或坐标异常时不推", () => {
  assert.equal(pinnedPushOffset(0, 0, -10), 0);
  assert.equal(pinnedPushOffset(0, -5, -10), 0);
  assert.equal(pinnedPushOffset(Number.NaN, 30, 0), 0);
  assert.equal(pinnedPushOffset(0, 30, Number.NaN), 0);
});
