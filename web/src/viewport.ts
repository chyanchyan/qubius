import { useEffect } from "react";

/* Keep the layout inside the area the user can actually see.
 *
 * On phones and in the Tesla browser the on-screen keyboard shrinks the
 * visual viewport instead of the layout viewport, so an app sized at 100%
 * keeps its bottom edge (the composer) underneath the keyboard. Tracking
 * visualViewport and exposing its rect as CSS variables keeps the composer
 * above the keyboard. Pinch zoom is left alone so zooming still works the
 * way the browser intends.
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
        root.style.removeProperty("--app-height");
        root.style.removeProperty("--app-top");
        return;
      }
      const next = `${viewport.height}:${viewport.offsetTop}`;
      if (next === signature) return;
      signature = next;
      root.style.setProperty("--app-height", `${viewport.height}px`);
      root.style.setProperty("--app-top", `${viewport.offsetTop}px`);
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
