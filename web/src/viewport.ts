import { useEffect } from "react";

/* Keep the layout inside the area the user can actually see.
 *
 * On phones and in the Tesla browser the on-screen keyboard shrinks the
 * visual viewport instead of the layout viewport, so an app sized at 100%
 * keeps its bottom edge (the composer) underneath the keyboard. Tracking
 * visualViewport and exposing its rect as CSS variables keeps the composer
 * above the keyboard. Pinch zoom is left alone so zooming still works the
 * way the browser intends.
 *
 * 键盘收起时不要用 visualViewport.height 定高：iOS 独立网页会把它少算一条
 * 状态栏，输入框因此停在离屏幕底部很远的位置。这时让 .app 直接铺满布局
 * 视口；只有检测到键盘占掉一大块时，才切到视觉视口的高度和位移。
 */

/* 键盘至少占一两百像素；状态栏、地址栏这类小偏差（几十像素）不算键盘。 */
const KEYBOARD_MIN = 120;

/**
 * 判断键盘是否弹出。
 *
 * @param maxBottom 本次窗口方向下见过的最高可视底边（offsetTop + height）
 * @param bottom 当前可视底边
 * @param layoutHeight 布局视口高度（documentElement.clientHeight）
 *
 * 两条线索任一成立即可：
 * - 可视底边比历史最高位置矮了一大截。键盘把可见区域顶上去；Chrome 打开
 *   `interactive-widget=resizes-content` 时布局视口会一起缩，布局视口和可视
 *   视口之间看不出覆盖，只剩“可见区域变矮”这一条线索。
 * - 布局视口底边比可视底边高出一大截。iOS Safari 上键盘弹出时布局视口不缩，
 *   键盘只是盖在页面上。
 */
export function keyboardOpen(maxBottom: number, bottom: number, layoutHeight: number): boolean {
  return maxBottom - bottom > KEYBOARD_MIN || layoutHeight - bottom > KEYBOARD_MIN;
}

export function useVisibleViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    /* The resize events for one keyboard animation arrive many times per frame;
       coalesce them and skip DOM writes when nothing changed. */
    let frame = 0;
    let settle = 0;
    let signature = "";
    /* 见过的最高的可视底边。键盘弹出时可见区域变矮，底边随之下降；拿它和
       历史最高值比，不论浏览器缩不缩布局视口都能认出键盘。 */
    let maxBottom = 0;
    const apply = () => {
      frame = 0;
      if (!viewport || viewport.scale > 1.01) {
        if (signature === "hidden") return;
        signature = "hidden";
        delete root.dataset.keyboard;
        root.style.removeProperty("--app-height");
        root.style.removeProperty("--app-top");
        return;
      }
      const bottom = viewport.offsetTop + viewport.height;
      if (bottom > maxBottom) maxBottom = bottom;
      const open = keyboardOpen(maxBottom, bottom, document.documentElement.clientHeight);
      const next = open ? `keyboard:${viewport.height}:${viewport.offsetTop}` : "full";
      if (next === signature) return;
      signature = next;
      if (open) {
        /* 键盘弹出：贴住视觉视口，同时收掉输入框底部外边距（由 CSS 用
           data-keyboard 处理），否则会离键盘隔出一条空白。 */
        root.dataset.keyboard = "true";
        root.style.setProperty("--app-height", `${viewport.height}px`);
        root.style.setProperty("--app-top", `${viewport.offsetTop}px`);
      } else {
        delete root.dataset.keyboard;
        root.style.removeProperty("--app-height");
        root.style.removeProperty("--app-top");
      }
    };
    const resync = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    const schedule = () => {
      resync();
      /* 键盘动画的最后一次尺寸变化在部分浏览器上没有事件；事件静默后
         再读一次，别让高度停在动画途中的中间值。 */
      window.clearTimeout(settle);
      settle = window.setTimeout(resync, 300);
    };
    const onOrientation = () => {
      /* 横竖屏切换后整屏尺寸都变了，历史底边不再有参考价值。 */
      maxBottom = 0;
      schedule();
    };
    apply();
    viewport?.addEventListener("resize", schedule);
    /* 键盘弹出时浏览器也可能只平移可见视口而不发 resize，光靠 resize
       会让 --app-top 停在旧值，输入框就跑到键盘上方很远的地方。 */
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", onOrientation);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", onOrientation);
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, []);
}

/** Run a callback whenever the visible area changes, e.g. the keyboard opens. */
export function onVisibleViewportChange(callback: () => void): () => void {
  const viewport = window.visualViewport;
  /* Run after the visible viewport settles, once per frame at most. */
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      callback();
    });
  };
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  viewport?.addEventListener("resize", schedule);
  /* 只平移、不改变高度时只有 scroll 事件（键盘弹起常见）。 */
  viewport?.addEventListener("scroll", schedule);
  return () => {
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    if (frame) window.cancelAnimationFrame(frame);
  };
}
