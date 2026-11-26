import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { AttachButton, AttachmentStrip, pastedImages, type AttachmentState } from "../Attachments";
import { enterSendMode } from "../composer-keys";
import { isTouchPointer } from "../pointer";
import { appendDictation, VoiceButton } from "../VoiceInput";
/* Thread 的 diff/图片行和这里的语音按钮共用一小组对话区样式。放在 Thread.css
   并由 Composer 引入：Thread.tsx 会被 node:test 直接 import，而 Node 的
   tsx 加载器不认识 .css。 */
import "./Thread.css";

/* 横向滑过这个距离才切换语音输入模式，避免误触。 */
const SWIPE_THRESHOLD = 48;

/**
 * Shared composer form used by the board and the conversation detail page.
 * The page owns the text state, the attachment state and the chips; this
 * component owns the textarea, the paste/enter handlers, the auto-grow and
 * the voice/attach/stop/send row.
 */
export const Composer = memo(function Composer({
  onSubmit,
  value,
  setValue,
  placeholder,
  canSend,
  sendLabel,
  textareaRef,
  attachments,
  chips,
  active,
  voiceDisabled,
  attachDisabled,
  onError,
  onStop,
  stopDisabled,
}: {
  /** 第二个参数为 true 表示 Ctrl+Enter / 长按发送：插话而不是排队。 */
  onSubmit: (event: FormEvent<HTMLFormElement>, interject: boolean) => void;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  placeholder: string;
  canSend: boolean;
  sendLabel: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  attachments: AttachmentState;
  chips: ReactNode;
  /** 当前轮正在跑/等待确认：Enter 变成排队，显示快捷键提示并启用长按插话。 */
  active?: boolean;
  voiceDisabled?: boolean;
  attachDisabled?: boolean;
  onError: (message: string) => void;
  onStop?: () => void;
  stopDisabled?: boolean;
}) {
  /* value 变化（发送后清空、恢复多行草稿、听写追加）后重新按内容量一次高度。
     发送后清空能恢复默认行高；恢复草稿时不会停留在两行内部滚动。 */
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    if (value === "") {
      node.style.height = "auto";
      return;
    }
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [value, textareaRef]);

  /* 左滑把整个输入框切换成「上方文字编辑框 + 下方大语音按钮」，
     右滑还原；竖向拖动让给页面滚动，横向才由这里接管。 */
  const [voiceMode, setVoiceMode] = useState(false);
  const gesture = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);
  /* 横向滑动后浏览器还会补一个 click；拦掉它，避免误触发送或附件。 */
  const suppressClick = useRef(false);
  /* 触摸端发送后软键盘不会自己收起，会一直盖住刚发出的消息和回复，所以
     提交时让输入框失焦。桌面端用物理键盘连着打字时不能被抢焦点，因此只
     记住最近一次按下是不是触摸，鼠标/笔发送保持原来的焦点行为。 */
  const touchInput = useRef(false);
  /* Ctrl+Enter（桌面）或长按发送（触摸）走插话；普通提交走排队。 */
  const interjectRef = useRef(false);
  const holdTimer = useRef(0);
  const longPressed = useRef(false);
  const [holding, setHolding] = useState(false);

  useEffect(() => () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
  }, []);

  /* 触摸端没有 Ctrl 键：按住发送按钮 450ms 视为「现在发送 / 插话」。
     松手后浏览器还会补一个 click，由 longPressed 拦掉。 */
  function beginHold(event: ReactPointerEvent<HTMLButtonElement>) {
    /* 先无条件清掉上一轮长按的残留：触屏笔电长按后按钮变 disabled 收不到
       click，标志可能一直是 true；下一次鼠标点击不能被误吞。 */
    longPressed.current = false;
    if (!active || !isTouchPointer(event) || !canSend) return;
    setHolding(true);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = 0;
      longPressed.current = true;
      setHolding(false);
      interjectRef.current = true;
      navigator.vibrate?.(10);
      textareaRef.current?.form?.requestSubmit();
    }, 450);
  }

  function endHold() {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = 0;
    }
    setHolding(false);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    /* 任何下一次按下都清掉上一次手势残留的 click 抑制，否则触摸被系统
       取消后，紧接着的鼠标点击会被误吞一次。 */
    suppressClick.current = false;
    /* 隐藏手势只留给触摸；鼠标和笔改用可见的切换按钮。 */
    if (!isTouchPointer(event)) return;
    if (!(event.target instanceof Element)) return;
    /* 按住语音按钮是在录音，横向滑动不能把它抢过来。 */
    if (event.target.closest(".voice-btn")) return;
    gesture.current = { x: event.clientX, y: event.clientY, axis: null };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.axis) {
      // 先分清方向：竖向让给滚动，横向才接管。
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (current.axis === "x") event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (current.axis === "x") suppressClick.current = true;
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (current.axis !== "x") return;
    const dx = event.clientX - current.x;
    if (dx <= -SWIPE_THRESHOLD) setVoiceMode(true);
    else if (dx >= SWIPE_THRESHOLD) setVoiceMode(false);
  }

  function onPointerCancel() {
    if (gesture.current?.axis === "x") suppressClick.current = true;
    gesture.current = null;
  }

  /* 两套底部面板高度不同：量出当前面板的高度，让外层高度平滑过渡，
     切换模式时不会整块瞬变。chips 换行等宽度变化也会同步更新。 */
  const actionsRef = useRef<HTMLDivElement>(null);
  const voicePadRef = useRef<HTMLDivElement>(null);
  const [bottomHeight, setBottomHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const node = voiceMode ? voicePadRef.current : actionsRef.current;
    if (!node) return;
    const sync = () => setBottomHeight(node.offsetHeight);
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [voiceMode]);

  return (
    <form
      className="composer"
      onPointerDownCapture={(event) => {
        touchInput.current = isTouchPointer(event);
      }}
      onSubmit={(event) => {
        setVoiceMode(false);
        const interject = interjectRef.current;
        interjectRef.current = false;
        const node = textareaRef.current;
        if (touchInput.current && document.activeElement === node) node?.blur();
        onSubmit(event, interject);
      }}
    >
      <div
        className={voiceMode ? "composer-box voice-mode" : "composer-box"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <AttachmentStrip
          images={attachments.images}
          texts={attachments.texts}
          onRemove={attachments.remove}
          onRemoveText={attachments.removeText}
        />
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          rows={2}
          onChange={(event) => {
            setValue(event.target.value);
            grow(event.target);
          }}
          onPaste={(event) => {
            const files = pastedImages(event);
            if (files.length === 0) return;
            event.preventDefault();
            void attachments.add(files);
          }}
          onKeyDown={(event) => {
            const mode = enterSendMode({
              key: event.key,
              shiftKey: event.shiftKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
            });
            if (!mode) return;
            event.preventDefault();
            if (!canSend) return;
            interjectRef.current = mode === "interject";
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <div
          className="composer-bottom"
          style={bottomHeight === undefined ? undefined : { height: bottomHeight }}
        >
          <div
            ref={actionsRef}
            className="composer-bottom-panel composer-actions"
            data-active={!voiceMode}
            aria-hidden={voiceMode}
            inert={voiceMode}
          >
            <div className="chips">{chips}</div>
            {active && (
              <span className="composer-hint">
                <span className="composer-hint-fine">Enter 排队 · Ctrl+Enter 插话</span>
                <span className="composer-hint-coarse">点 ↑ 排队 · 长按 ↑ 插话</span>
              </span>
            )}
            <div className="composer-end">
              {/* 精准指针设备用可见按钮进入语音模式，触摸端靠左滑。 */}
              <button
                type="button"
                className="voice-mode-toggle"
                title="切换到语音输入"
                aria-label="切换到语音输入"
                disabled={voiceDisabled}
                onClick={() => setVoiceMode(true)}
              >
                语音模式
              </button>
              <VoiceButton
                disabled={voiceDisabled}
                onError={onError}
                onText={(text) => {
                  setValue((current) => appendDictation(current, text));
                  window.requestAnimationFrame(() => {
                    if (textareaRef.current) grow(textareaRef.current);
                  });
                }}
              />
              {/* add 现在引用稳定，直接传入可让 memo 的 AttachButton 跳过无关重渲染。 */}
              <AttachButton disabled={attachDisabled} onFiles={attachments.add} />
              {onStop && <button type="button" className="send stop" onClick={onStop} disabled={stopDisabled} aria-label="停止">■</button>}
              <button
                className="send"
                disabled={!canSend}
                aria-label={sendLabel}
                data-active={active ? "true" : undefined}
                data-holding={holding ? "true" : undefined}
                title={active ? "发送并排队；Ctrl+Enter 或长按立即插话" : "发送"}
                onPointerDown={beginHold}
                onPointerUp={endHold}
                onPointerLeave={endHold}
                onPointerCancel={endHold}
                onClick={(event) => {
                  /* 长按已经提交过，松手补的 click 不能再排一条。 */
                  if (!longPressed.current) return;
                  longPressed.current = false;
                  event.preventDefault();
                }}
              >↑</button>
            </div>
          </div>
          <div
            ref={voicePadRef}
            className="composer-bottom-panel composer-voice-pad"
            data-active={voiceMode}
            aria-hidden={!voiceMode}
            inert={!voiceMode}
          >
            <div className="voice-mode-hint">右滑还原输入框</div>
            {/* 触摸端继续用右滑；精准指针设备用这个按钮返回。 */}
            <button
              type="button"
              className="voice-mode-toggle"
              title="返回文字输入"
              aria-label="返回文字输入"
              onClick={() => setVoiceMode(false)}
            >
              返回输入框
            </button>
            <VoiceButton
              big
              disabled={voiceDisabled}
              onError={onError}
              onText={(text) => {
                setValue((current) => appendDictation(current, text));
                window.requestAnimationFrame(() => {
                  if (textareaRef.current) grow(textareaRef.current);
                });
              }}
            />
          </div>
        </div>
      </div>
      {attachments.error && <p className="error composer-error">{attachments.error}</p>}
    </form>
  );
});

function grow(node: HTMLTextAreaElement) {
  /* CSS 已经用 max-height: calc(180px * var(--control-scale)) 限制了上限，
     这里只需要先归零再按内容撑开，避免每敲一个字都同步读取 computed style。 */
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight}px`;
}
