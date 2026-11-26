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
export function useVisibleViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    /* The resize events for one keyboard animation arrive many times per frame;
       coalesce them and skip DOM writes when nothing changed. */
    let frame = 0;
    let settle = 0;
    let signature = "";
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
      /* 状态栏/地址栏这类小偏差（几十像素）不算键盘；键盘至少占一两百像素。
         iOS 的布局视口不会随键盘缩小，所以底部差得多就是键盘弹出。 */
      const keyboardOpen =
        document.documentElement.clientHeight - (viewport.offsetTop + viewport.height) > 120;
      const next = keyboardOpen ? `keyboard:${viewport.height}:${viewport.offsetTop}` : "full";
      if (next === signature) return;
      signature = next;
      if (keyboardOpen) {
        /* 键盘弹出：贴住视觉视口，同时让输入框收起安全区外边距（由 CSS 用
           data-keyboard 处理），否则会离键盘隔出一条比手指还宽的空白。 */
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
    apply();
    viewport?.addEventListener("resize", schedule);
    /* 键盘弹出时浏览器也可能只平移可见视口而不发 resize，光靠 resize
       会让 --app-top 停在旧值，输入框就跑到键盘上方很远的地方。 */
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
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
