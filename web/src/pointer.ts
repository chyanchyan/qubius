/**
 * 隐藏手势（左滑/右滑）只服务触摸输入。
 *
 * 鼠标和笔是精确指针：用可见按钮等显式入口，避免拖动被当成手势，也避免
 * 抢走选择文字。判断用事件里的 pointerType，而不是屏幕宽度——触屏笔记本、
 * 接了触控板的平板都可能同时存在两种输入方式。
 */
export function isTouchPointer(event: { pointerType: string }): boolean {
  return event.pointerType === "touch";
}
