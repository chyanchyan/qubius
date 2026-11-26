import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./ChipSelect.css";

/**
 * 发送区配置 chip 的下拉。
 *
 * 原生 <select> 的弹层由系统绘制：深色页面上选项颜色发灰，手机上还会
 * 盖住整行 chips，选项和触发控件视觉上叠在一起。这里改用自绘弹层：
 * 精确指针设备在触发器上方弹出主题化浮层，触屏/窄屏弹出底部面板，
 * 两种形态共用同一份可键盘操作的列表。
 */

export interface ChipSelectOption {
  value: string;
  label: ReactNode;
  /** 选项下方的补充说明；没有时选项排得更紧凑。 */
  description?: ReactNode;
  /** 工作流等强调项的色调，对应 CSS 里的 --accent。 */
  tone?: string;
}

/** 浮层锚点：选择向上还是向下展开，并给出视口内的位置。 */
interface Anchor {
  side: "up" | "down";
  left: number;
  offset: number;
  maxHeight: number;
}

export function ChipSelect({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  className,
  placeholder,
  title,
}: {
  ariaLabel: string;
  value: string;
  options: ChipSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 触发器上的附加类名，例如工作流的 "wf-mode"。 */
  className?: string;
  /** 当前值不在选项里时显示的占位文字。 */
  placeholder?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const showTones = options.some((option) => option.tone);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setActive(-1);
    /* preventScroll：收起弹层时不要把页面滚回输入框。 */
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(300, Math.max(180, viewportWidth - 16));
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - 8 - width));
    const above = rect.top - 8;
    const below = viewportHeight - rect.bottom - 8;
    /* chips 在页面底部，通常向上展开；上方不够时才往下。 */
    const side = above >= below ? "up" : "down";
    const space = side === "up" ? above : below;
    setAnchor({
      side,
      left,
      offset: side === "up" ? viewportHeight - rect.top + 6 : rect.bottom + 6,
      maxHeight: Math.max(160, Math.min(360, space - 6)),
    });
    setOpen(true);
  }, []);

  /* 打开后把焦点送进列表；键盘用户可以直接上下选择。 */
  useLayoutEffect(() => {
    if (!open) return;
    const target = selectedIndex >= 0 ? selectedIndex : 0;
    setActive(target);
    const frame = window.requestAnimationFrame(() => {
      const node = itemRefs.current[target];
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    /* 点击弹层和触发器以外的地方收起；触发器自己负责 toggle。 */
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (dockRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    /* 页面或 chips 滚动后锚点就失效了，直接收起；面板内部的滚动不算。
       不监听 resize：手机上输入法收起会让窗口高度变化，刚打开的面板
       会被误关。 */
    function onScroll(event: Event) {
      if (dockRef.current?.contains(event.target as Node)) return;
      close();
    }
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open, close]);

  function moveTo(index: number) {
    if (options.length === 0) return;
    setActive(index);
    itemRefs.current[index]?.focus({ preventScroll: true });
    itemRefs.current[index]?.scrollIntoView({ block: "nearest" });
  }

  function choose(option: ChipSelectOption) {
    close(true);
    if (option.value !== value) onChange(option.value);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!open) {
      openMenu();
      return;
    }
    const target = selectedIndex >= 0 ? selectedIndex : 0;
    itemRefs.current[target]?.focus({ preventScroll: true });
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    /* Tab 直接收起，避免焦点跑到面板后面的页面元素上。 */
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    if (options.length === 0) return;
    const position = active;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTo((position + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTo((position - 1 + options.length) % options.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTo(options.length - 1);
    }
  }

  const label = selected?.label ?? placeholder ?? value;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`chip chip-select${className ? ` ${className}` : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-workflow={selected?.tone}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="chip-value">{label}</span>
        <svg className="chip-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && anchor && createPortal(
        <>
          <div className="chip-pop-backdrop" aria-hidden="true" onClick={() => close()} />
          <div
            ref={dockRef}
            className="chip-pop-dock"
            data-side={anchor.side}
            style={{
              "--chip-pop-left": `${anchor.left}px`,
              "--chip-pop-offset": `${anchor.offset}px`,
              "--chip-pop-max": `${anchor.maxHeight}px`,
            } as CSSProperties}
          >
            <div className="chip-pop">
              <div className="chip-pop-grip" aria-hidden="true" />
              <div className="chip-pop-head">
                <span>{ariaLabel}</span>
                <button type="button" className="chip-pop-close" aria-label="关闭" onClick={() => close(true)}>
                  ×
                </button>
              </div>
              <div
                id={listId}
                className="chip-pop-list"
                role="listbox"
                aria-label={ariaLabel}
                onKeyDown={onListKeyDown}
              >
                {options.length === 0 && <p className="chip-pop-empty">没有可选项</p>}
                {options.map((option, index) => {
                  const isSelected = option.value === value;
                  return (
                    <button
                      key={option.value || "__plain"}
                      ref={(node) => { itemRefs.current[index] = node; }}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      tabIndex={active === index ? 0 : -1}
                      className="chip-option"
                      data-selected={isSelected || undefined}
                      data-tone={option.tone}
                      onClick={() => choose(option)}
                      onFocus={() => setActive(index)}
                    >
                      {showTones && <span className="chip-option-tone" aria-hidden="true" />}
                      <span className="chip-option-copy">
                        <span className="chip-option-label">{option.label}</span>
                        {option.description && <span className="chip-option-desc">{option.description}</span>}
                      </span>
                      <span className="chip-option-check" aria-hidden="true">
                        {isSelected && (
                          <svg viewBox="0 0 14 14">
                            <path d="M3 7.3 5.8 10 11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
