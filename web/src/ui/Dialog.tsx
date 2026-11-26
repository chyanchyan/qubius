import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** 页内确认/输入对话框，替代 window.confirm / window.prompt。
 *  只负责交互与焦点：样式在 ui.css，调用方通过 useDialogs() 使用。 */

export interface DialogInput {
  label?: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  /** 返回非空字符串表示校验失败；对话框保持打开并显示这条错误。 */
  validate?: (value: string) => string;
}

/** 确认框里的可选勾选项；勾选状态随确认结果一起返回。 */
export interface DialogCheckbox {
  label: ReactNode;
  /** 初始勾选状态；默认 false。 */
  checked?: boolean;
  /** 勾选项下方的补充说明。 */
  description?: ReactNode;
  disabled?: boolean;
}

export interface DialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 宽版对话框：内容是自定义表单或列表时用，默认 440px 太窄。 */
  wide?: boolean;
  /** 是否显示底部的确认/取消按钮；内容自带操作时关掉。 */
  showActions?: boolean;
  input?: DialogInput;
  checkbox?: DialogCheckbox;
  /** 输入框为空时是否仍然允许确认；默认允许（由 validate 决定）。 */
  onConfirm: (value: string, checked: boolean) => void;
  onClose: () => void;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Dialog({
  open,
  title,
  description,
  children,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  wide = false,
  showActions = true,
  input,
  checkbox,
  onConfirm,
  onClose,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState(input?.initialValue ?? "");
  const [checked, setChecked] = useState(checkbox?.checked ?? false);
  const [error, setError] = useState("");

  /* 每次打开（包括连续打开不同请求）都回到初始值和初始焦点。 */
  useLayoutEffect(() => {
    if (!open) return;
    setValue(input?.initialValue ?? "");
    setChecked(checkbox?.checked ?? false);
    setError("");
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.focus();
      else if (!showActions) rootRef.current?.focus();
      else if (danger) cancelRef.current?.focus();
      else confirmRef.current?.focus();
    });
  }, [open, input?.initialValue, checkbox?.checked, danger, showActions]);

  useEffect(() => {
    if (!open) return;
    return () => {
      restoreRef.current?.focus();
    };
  }, [open]);

  const submit = useCallback(() => {
    if (busy) return;
    if (input?.validate) {
      const message = input.validate(value);
      if (message) {
        setError(message);
        inputRef.current?.focus();
        return;
      }
    }
    onConfirm(value, checked);
  }, [busy, checked, input, onConfirm, value]);

  if (!open) return null;

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={rootRef}
        className={wide ? "dialog dialog-wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="dialog-title">{title}</h2>
        {description && <div id={descriptionId} className="dialog-description">{description}</div>}
        {checkbox && (
          <label className="dialog-checkbox">
            <input
              type="checkbox"
              checked={checked}
              disabled={checkbox.disabled}
              onChange={(event) => setChecked(event.target.checked)}
            />
            <span className="dialog-checkbox-text">
              <span>{checkbox.label}</span>
              {checkbox.description && (
                <span className="dialog-checkbox-hint">{checkbox.description}</span>
              )}
            </span>
          </label>
        )}
        {input && (
          <label className="field dialog-field">
            {input.label && <span>{input.label}</span>}
            <input
              ref={inputRef}
              value={value}
              placeholder={input.placeholder}
              maxLength={input.maxLength}
              autoComplete="off"
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError("");
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                submit();
              }}
            />
            {input.maxLength !== undefined && (
              <span className="dialog-counter" aria-live="polite">
                {value.length}/{input.maxLength}
              </span>
            )}
          </label>
        )}
        {children}
        {error && <p className="error dialog-error" role="alert">{error}</p>}
        {showActions && (
          <div className="dialog-actions">
            <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onClose}>
              {cancelLabel}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={danger ? "btn btn-danger" : "btn btn-primary"}
              disabled={busy}
              onClick={submit}
            >
              {busy ? "处理中…" : confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface RequestBase {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface ConfirmOptions extends RequestBase {}

export interface PromptOptions extends RequestBase {
  label?: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  validate?: (value: string) => string;
}

export interface ChoiceOptions extends RequestBase {
  /** 可选的勾选项；不传时只返回是否确认。 */
  checkbox?: DialogCheckbox;
}

export interface ChoiceResult {
  confirmed: boolean;
  /** 勾选状态；没有勾选项或取消时是 false。 */
  checked: boolean;
}

interface Request {
  id: number;
  kind: "confirm" | "prompt" | "choice";
  options: ConfirmOptions | PromptOptions | ChoiceOptions;
  resolve: (value: boolean | string | null | ChoiceResult) => void;
}

export interface DialogApi {
  /** 返回 true 表示用户确认；false 表示取消。 */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** 带可选勾选项的确认；返回是否确认和勾选状态。 */
  confirmChoice: (options: ChoiceOptions) => Promise<ChoiceResult>;
  /** 返回输入内容；取消返回 null。 */
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Request[]>([]);
  const nextId = useRef(1);
  const settled = useRef(false);
  const current = queue[0] ?? null;

  useEffect(() => {
    settled.current = false;
  }, [current]);

  const enqueue = useCallback((
    kind: Request["kind"],
    options: ConfirmOptions | PromptOptions | ChoiceOptions,
  ) => {
    return new Promise<boolean | string | null | ChoiceResult>((resolve) => {
      setQueue((items) => [...items, { id: nextId.current++, kind, options, resolve }]);
    });
  }, []);

  const finish = useCallback((result: boolean | string | null | ChoiceResult) => {
    if (!current || settled.current) return;
    settled.current = true;
    current.resolve(result);
    setQueue((items) => items.slice(1));
  }, [current]);

  /* 上下文值保持稳定：对话框打开/关闭时不应让所有 useDialogs 调用方重渲染。 */
  const api = useMemo<DialogApi>(() => ({
    confirm: (options) => enqueue("confirm", options).then((value) => value === true),
    confirmChoice: (options) => enqueue("choice", options).then((value) => (
      typeof value === "object" && value !== null
        ? value as ChoiceResult
        : { confirmed: value === true, checked: false }
    )),
    prompt: (options) => enqueue("prompt", options).then((value) => typeof value === "string" ? value : null),
  }), [enqueue]);

  const promptOptions = current?.kind === "prompt" ? current.options as PromptOptions : null;
  const choiceOptions = current?.kind === "choice" ? current.options as ChoiceOptions : null;

  return (
    <DialogContext.Provider value={api}>
      {children}
      <Dialog
        key={current?.id ?? "closed"}
        open={current !== null}
        title={current?.options.title ?? ""}
        description={current?.options.message}
        confirmLabel={current?.options.confirmLabel}
        cancelLabel={current?.options.cancelLabel}
        danger={current?.options.danger}
        checkbox={choiceOptions?.checkbox}
        input={promptOptions ? {
          label: promptOptions.label,
          initialValue: promptOptions.initialValue,
          placeholder: promptOptions.placeholder,
          maxLength: promptOptions.maxLength,
          validate: promptOptions.validate,
        } : undefined}
        onConfirm={(value, checked) => {
          if (current?.kind === "prompt") finish(value);
          else if (current?.kind === "choice") finish({ confirmed: true, checked });
          else finish(true);
        }}
        onClose={() => {
          if (current?.kind === "prompt") finish(null);
          else if (current?.kind === "choice") finish({ confirmed: false, checked: false });
          else finish(false);
        }}
      />
    </DialogContext.Provider>
  );
}

export function useDialogs(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialogs 必须在 DialogProvider 内使用");
  return api;
}
