/** 用户消息气泡只显示一行摘要，悬停时在气泡旁浮出完整正文。
 *  这里放不依赖 DOM 的判定和定位计算，方便 node:test 直接覆盖。 */

/** 悬停多久才浮出全文：短到不打断阅读，长到扫过气泡时不会闪。 */
export const PEEK_DELAY_MS = 350;

/** 触屏长按多久算"要看全文"。和系统选词起始时间接近，过早会和选择手势抢。 */
export const LONG_PRESS_MS = 500;

/** 长按期间手指移动超过这个距离就当成滚动/拖动，取消预览。 */
export const LONG_PRESS_MOVE_PX = 10;

/** 触屏浮层离触点至少这么远，避免被手指和手掌挡住。 */
export const TOUCH_PEEK_GAP = 40;

/** 浮层和气泡之间留的空隙。 */
export const PEEK_GAP = 6;

/** 浮层和视口边缘的最小距离。 */
export const PEEK_MARGIN = 8;

/** 长消息也不铺满整屏，超出后浮层内部滚动。 */
export const PEEK_MAX_WIDTH = 560;
export const PEEK_MAX_HEIGHT = 0.6;

export interface PeekAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PeekViewport {
  width: number;
  height: number;
}

export interface PeekPlacement {
  /** 浮层在气泡上方（up）还是下方（down）。 */
  side: "up" | "down";
  /** 浮层左边缘的视口坐标。 */
  left: number;
  /** 距视口下沿（up）或上沿（down）的固定坐标，配合 position: fixed。 */
  offset: number;
  maxWidth: number;
  maxHeight: number;
}

export interface TouchPoint {
  x: number;
  y: number;
}

export interface ContentSize {
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  scrollHeight: number;
}

/** 元素内容是否被裁切（横向省略号或纵向限高）。留 1px 容差给亚像素取整。 */
export function isContentTruncated(size: ContentSize, tolerance = 1): boolean {
  return (
    size.scrollWidth > size.clientWidth + tolerance
    || size.scrollHeight > size.clientHeight + tolerance
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 以气泡为锚点算浮层位置：优先放到空间更大的一侧，左右夹在视口内，
 *  高度不超过视口的 60%，文字再长也在浮层里滚动。 */
export function peekPlacement(anchor: PeekAnchor, viewport: PeekViewport): PeekPlacement {
  const maxWidth = Math.min(PEEK_MAX_WIDTH, Math.max(0, viewport.width - PEEK_MARGIN * 2));
  const left = clamp(
    anchor.left,
    PEEK_MARGIN,
    viewport.width - PEEK_MARGIN - maxWidth,
  );
  const above = anchor.top - PEEK_MARGIN - PEEK_GAP;
  const below = viewport.height - anchor.bottom - PEEK_MARGIN - PEEK_GAP;
  const side = above >= below ? "up" : "down";
  const space = Math.max(0, side === "up" ? above : below);
  return {
    side,
    left,
    offset: side === "up" ? viewport.height - anchor.top + PEEK_GAP : anchor.bottom + PEEK_GAP,
    maxWidth,
    maxHeight: Math.min(viewport.height * PEEK_MAX_HEIGHT, space),
  };
}

/** 触屏长按按触点定位：浮层左右对齐手指并夹在视口内，上下都离触点留出
 *  安全距离（手掌和手指会挡住触点附近）。空间更大的一侧优先。 */
export function touchPeekPlacement(point: TouchPoint, viewport: PeekViewport): PeekPlacement {
  const maxWidth = Math.min(PEEK_MAX_WIDTH, Math.max(0, viewport.width - PEEK_MARGIN * 2));
  const left = clamp(point.x, PEEK_MARGIN, viewport.width - PEEK_MARGIN - maxWidth);
  const above = point.y - PEEK_MARGIN - TOUCH_PEEK_GAP;
  const below = viewport.height - point.y - PEEK_MARGIN - TOUCH_PEEK_GAP;
  const side = above >= below ? "up" : "down";
  const space = Math.max(0, side === "up" ? above : below);
  return {
    side,
    left,
    offset: side === "up"
      ? viewport.height - point.y + TOUCH_PEEK_GAP
      : point.y + TOUCH_PEEK_GAP,
    maxWidth,
    maxHeight: Math.min(viewport.height * PEEK_MAX_HEIGHT, space),
  };
}
