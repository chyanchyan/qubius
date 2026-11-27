import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface LightboxImage {
  src: string;
  alt: string;
  href?: string;
}

/** 对话图片的全屏查看层；点图片或背景关闭，左右键/按钮切换同一条消息里的图片。 */
export function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: LightboxImage[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const open = index !== null && images.length > 0;

  /* 只在打开/关闭时保存和恢复焦点；切换图片不能重新抢焦点。
     没有关闭按钮后焦点落在对话框本身，Esc 仍然可以关闭。 */
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backdropRef.current?.focus();
    return () => previous?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft" && images.length > 1) {
        event.preventDefault();
        onIndexChange(((index ?? 0) - 1 + images.length) % images.length);
      } else if (event.key === "ArrowRight" && images.length > 1) {
        event.preventDefault();
        onIndexChange(((index ?? 0) + 1) % images.length);
      } else if (event.key === "Tab") {
        const nodes = backdropRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!nodes || nodes.length === 0) {
          // 单张图片且没有外链时页内没有可聚焦控件，把焦点留在对话框上。
          event.preventDefault();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === backdropRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || active === backdropRef.current)) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, index, images.length, onClose, onIndexChange]);

  if (!open) return null;
  const image = images[index];
  if (!image) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lightbox-body">
        {/* 再点一次图片即关闭，不再需要单独的关闭按钮。 */}
        <img src={image.src} alt={image.alt} onClick={onClose} />
      </div>
      {(images.length > 1 || image.href) && (
        <div className="lightbox-bar">
          {images.length > 1 && (
            <>
              <button
                type="button"
                className="lightbox-btn"
                aria-label="上一张"
                onClick={() => onIndexChange(((index ?? 0) - 1 + images.length) % images.length)}
              >
                ‹
              </button>
              <span className="lightbox-count">{index + 1} / {images.length}</span>
              <button
                type="button"
                className="lightbox-btn"
                aria-label="下一张"
                onClick={() => onIndexChange(((index ?? 0) + 1) % images.length)}
              >
                ›
              </button>
            </>
          )}
          {image.href && (
            <a className="lightbox-link" href={image.href} target="_blank" rel="noreferrer">
              新标签打开原图
            </a>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
