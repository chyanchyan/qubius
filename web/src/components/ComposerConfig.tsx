import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { ChipSelectOption } from "./ChipSelect";
import "./ChipSelect.css";

/**
 * 窄屏发送区的「模型与授权」抽屉。
 *
 * 接口、模型、授权三个选择项放在一行 chips 里太挤，窄屏上收进这个
 * 底部面板：触发器只占一个 chip，面板里按分组展示当前值和全部选项，
 * 选中即生效，可以连续调整多项。桌面端仍然用行内 ChipSelect。
 */

export interface ComposerConfigGroup {
  /** 分组标题，例如「接口」「模型」「授权」。 */
  label: string;
  value: string;
  options: ChipSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ComposerConfig({
  ariaLabel = "模型与授权",
  label = "配置",
  groups,
}: {
  ariaLabel?: string;
  label?: string;
  groups: ComposerConfigGroup[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  /* 打开后把焦点送到当前选中项，键盘用户可以直接继续切换。 */
  useLayoutEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const selected = panel.querySelector<HTMLElement>('.chip-option[data-selected="true"]');
      const target = selected ?? panel.querySelector<HTMLElement>("button");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  /* 焦点在面板内循环，Tab 不会跑到背后的页面上。 */
  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusables = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)"),
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="chip chip-select"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="chip-value">{label}</span>
        <svg className="chip-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && createPortal(
        <>
          <div className="chip-pop-backdrop" aria-hidden="true" onClick={() => close()} />
          <div className="chip-pop-dock chip-config-dock">
            <div
              ref={panelRef}
              id={dialogId}
              className="chip-pop chip-config"
              role="dialog"
              aria-modal="true"
              aria-label={ariaLabel}
              onKeyDown={onPanelKeyDown}
            >
              <div className="chip-pop-grip" aria-hidden="true" />
              <div className="chip-pop-head">
                <span>{ariaLabel}</span>
                <button type="button" className="chip-pop-close" aria-label="关闭" onClick={() => close(true)}>
                  ×
                </button>
              </div>
              <div className="chip-pop-list chip-config-body">
                {groups.map((group) => (
                  <section key={group.label} className="chip-config-group">
                    <h3 className="chip-config-title">{group.label}</h3>
                    <div role="group" aria-label={group.label} className="chip-config-options">
                      {group.options.length === 0 && <p className="chip-pop-empty">没有可选项</p>}
                      {group.options.map((option) => {
                        const selected = option.value === group.value;
                        return (
                          <button
                            key={option.value || "__empty"}
                            type="button"
                            aria-pressed={selected}
                            className="chip-option"
                            data-selected={selected || undefined}
                            disabled={group.disabled}
                            onClick={() => {
                              if (!selected) group.onChange(option.value);
                            }}
                          >
                            <span className="chip-option-copy">
                              <span className="chip-option-label">{option.label}</span>
                              {option.description && <span className="chip-option-desc">{option.description}</span>}
                            </span>
                            <span className="chip-option-check" aria-hidden="true">
                              {selected && (
                                <svg viewBox="0 0 14 14">
                                  <path d="M3 7.3 5.8 10 11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
