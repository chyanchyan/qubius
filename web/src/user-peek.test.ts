import assert from "node:assert/strict";
import test from "node:test";
import {
  isContentTruncated,
  PEEK_GAP,
  PEEK_MARGIN,
  peekPlacement,
  TOUCH_PEEK_GAP,
  touchPeekPlacement,
} from "./user-peek";

test("内容没有被裁切时不浮出全文", () => {
  assert.equal(
    isContentTruncated({ clientWidth: 300, scrollWidth: 300, clientHeight: 20, scrollHeight: 20 }),
    false,
  );
});

test("横向省略号或纵向限高都算被裁切", () => {
  assert.equal(
    isContentTruncated({ clientWidth: 300, scrollWidth: 480, clientHeight: 20, scrollHeight: 20 }),
    true,
  );
  assert.equal(
    isContentTruncated({ clientWidth: 300, scrollWidth: 300, clientHeight: 20, scrollHeight: 60 }),
    true,
  );
});

test("亚像素取整不算裁切", () => {
  assert.equal(
    isContentTruncated({ clientWidth: 300, scrollWidth: 301, clientHeight: 20, scrollHeight: 21 }),
    false,
  );
});

test("气泡靠下时浮层放在上方", () => {
  const placement = peekPlacement(
    { left: 120, top: 600, right: 500, bottom: 640 },
    { width: 1000, height: 800 },
  );

  assert.equal(placement.side, "up");
  assert.equal(placement.offset, 800 - 600 + PEEK_GAP);
  assert.equal(placement.left, 120);
});

test("气泡靠上时浮层放在下方", () => {
  const placement = peekPlacement(
    { left: 40, top: 60, right: 420, bottom: 100 },
    { width: 1000, height: 800 },
  );

  assert.equal(placement.side, "down");
  assert.equal(placement.offset, 100 + PEEK_GAP);
});

test("左侧和右侧都夹在视口内", () => {
  const viewport = { width: 1000, height: 800 };

  assert.equal(
    peekPlacement({ left: -20, top: 300, right: 300, bottom: 340 }, viewport).left,
    PEEK_MARGIN,
  );

  const right = peekPlacement({ left: 900, top: 300, right: 990, bottom: 340 }, viewport);
  assert.equal(right.left + right.maxWidth, viewport.width - PEEK_MARGIN);
});

test("窄视口时浮层宽度跟着缩，留出两侧边距", () => {
  const placement = peekPlacement(
    { left: 10, top: 300, right: 200, bottom: 340 },
    { width: 400, height: 800 },
  );

  assert.equal(placement.maxWidth, 400 - PEEK_MARGIN * 2);
});

test("长消息高度封顶到视口的 60%", () => {
  const placement = peekPlacement(
    { left: 10, top: 120, right: 300, bottom: 160 },
    { width: 1000, height: 800 },
  );

  assert.equal(placement.side, "down");
  assert.equal(placement.maxHeight, 800 * 0.6);
});

test("触屏长按：浮层放在触点上方并留出手指安全距离", () => {
  const placement = touchPeekPlacement({ x: 120, y: 700 }, { width: 1000, height: 800 });

  assert.equal(placement.side, "up");
  assert.equal(placement.offset, 800 - 700 + TOUCH_PEEK_GAP);
  assert.equal(placement.left, 120);
});

test("触屏长按：触点靠上时放到下方，仍然避开手指", () => {
  const placement = touchPeekPlacement({ x: 120, y: 80 }, { width: 400, height: 800 });

  assert.equal(placement.side, "down");
  assert.equal(placement.offset, 80 + TOUCH_PEEK_GAP);
});

test("触屏长按：右侧触点把浮层夹回视口内", () => {
  const placement = touchPeekPlacement({ x: 390, y: 700 }, { width: 400, height: 800 });

  assert.equal(placement.left, 400 - PEEK_MARGIN - placement.maxWidth);
});

test("可用空间不够时按剩余空间限高", () => {
  const placement = peekPlacement(
    { left: 10, top: 60, right: 300, bottom: 100 },
    { width: 1000, height: 200 },
  );

  assert.equal(placement.side, "down");
  assert.equal(placement.maxHeight, 200 - 100 - PEEK_MARGIN - PEEK_GAP);
});
