import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

/** 可键盘操作的轻量下拉菜单：顶栏「更多」和列表行「⋯」共用。 */

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 在这一项之前画一条分隔线。 */
  separatorBefore?: boolean;
}

export function Menu({
  label,
  title,
  ariaLabel,
  items,
  align = "right",
  className,
  buttonClassName,
  disabled = false,
}: {
  label: ReactNode;
  title?: string;
  ariaLabel?: string;
  items: MenuItem[];
  align?: "left" | "right";
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusableIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.disabled)
    .map(({ index }) => index);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, close]);

  function focusItem(index: number) {
    setActive(index);
    itemRefs.current[index]?.focus();
  }

  function openWithFocus(position: "first" | "last") {
    setOpen(true);
    const indexes = focusableIndexes;
    if (indexes.length === 0) return;
    const index = position === "first" ? indexes[0] : indexes[indexes.length - 1];
    if (index === undefined) return;
    window.requestAnimationFrame(() => focusItem(index));
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return;
    }
    /* 全都禁用时焦点可能仍停在触发器上；Tab 直接收起，避免菜单悬空。 */
    if (event.key === "Tab" && open) {
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openWithFocus(event.key === "ArrowDown" ? "first" : "last");
    }
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    /* Escape/Tab 必须在“没有可用项”检查之前处理，否则全禁用菜单无法关闭。 */
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const indexes = focusableIndexes;
    if (indexes.length === 0) return;
    const position = indexes.indexOf(active);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = position === -1 ? indexes[0]! : indexes[(position + 1) % indexes.length]!;
      focusItem(next);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous = position === -1
        ? indexes[indexes.length - 1]!
        : indexes[(position - 1 + indexes.length) % indexes.length]!;
      focusItem(previous);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(indexes[0]!);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(indexes[indexes.length - 1]!);
    }
  }

  return (
    <div className={`menu${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClassName ?? "text-btn menu-trigger"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          /* 鼠标、Enter、Space 打开时也把焦点送进菜单，否则所有菜单项
             tabIndex=-1，键盘用户会卡在触发器上。 */
          openWithFocus("first");
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
      </button>
      {open && (
        <div
          id={menuId}
          className="menu-popup"
          role="menu"
          data-align={align}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <div key={item.id} role="none">
              {item.separatorBefore && index > 0 && <div className="menu-sep" role="separator" />}
              <button
                ref={(node) => { itemRefs.current[index] = node; }}
                type="button"
                role="menuitem"
                className={`menu-item${item.danger ? " danger" : ""}`}
                disabled={item.disabled}
                tabIndex={active === index ? 0 : -1}
                onFocus={() => setActive(index)}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
