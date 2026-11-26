import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** Web Speech API 的最小类型；TypeScript 的 DOM lib 还没有带 SpeechRecognition。 */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

function recognitionCtor(): SpeechRecognitionCtor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function errorText(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限被拒绝。请在 Safari 设置里允许本站使用麦克风，并确认「Siri 与听写」已开启。";
    case "audio-capture":
      return "没有找到可用的麦克风。";
    case "network":
      return "语音识别连不上服务，请检查网络，并确认 Siri 已开启。";
    case "language-not-supported":
      return "系统不支持中文语音识别。";
    case "no-speech":
    case "aborted":
      return "";
    default:
      return `语音识别失败（${code}）`;
  }
}

const UNSUPPORTED_MESSAGE = "当前浏览器不支持语音输入，可以点输入框，用键盘上的麦克风听写。";

/** 把听写结果接到已有输入后面，英文和中文都不会粘在一起。 */
export function appendDictation(current: string, text: string): string {
  const addition = text.replace(/\s+/g, " ").trim();
  if (!addition) return current;
  const base = current.trimEnd();
  return base ? `${base} ${addition}` : addition;
}

/**
 * 按住录音、松开出字的按钮。
 *
 * 用的是系统语音识别（iOS Safari 的 webkitSpeechRecognition），
 * 页面必须是 HTTPS；第一次按住时系统会询问麦克风权限。
 *
 * `big` 是左滑输入框后露出的那一版：占满整块露出区域，带文字提示，
 * 手指不用瞄准小图标。
 */
export function VoiceButton({
  disabled,
  lang = "zh-CN",
  onText,
  onError,
  big = false,
}: {
  disabled?: boolean;
  lang?: string;
  onText: (text: string) => void;
  onError?: (message: string) => void;
  big?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [supported] = useState(() => Boolean(recognitionCtor()));
  const heldRef = useRef(false);
  const finalRef = useRef("");
  const interimRef = useRef("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const restartTimerRef = useRef<number | undefined>(undefined);
  const commitTimerRef = useRef<number | undefined>(undefined);
  const disabledRef = useRef(disabled);
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);

  disabledRef.current = disabled;
  onTextRef.current = onText;
  onErrorRef.current = onError;

  useEffect(() => () => {
    heldRef.current = false;
    window.clearTimeout(restartTimerRef.current);
    window.clearTimeout(commitTimerRef.current);
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // 页面已经离开，忽略。
      }
    }
  }, []);

  function commit() {
    window.clearTimeout(commitTimerRef.current);
    const text = `${finalRef.current}${interimRef.current}`.trim();
    finalRef.current = "";
    interimRef.current = "";
    if (text) onTextRef.current(text);
  }

  function listen(Recognition: SpeechRecognitionCtor) {
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    let finalized = 0;

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      // Web Speech 保证 resultIndex 之前的结果已经是 final；只从变化的位置开始，
      // 避免长按听写时每次事件都重扫整段累积结果（O(n²)）。老实现可能没有这个字段，回退到 0。
      const start = event.resultIndex ?? 0;
      for (let index = start; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          // 有些实现会重复上报已经完成的结果，按索引去重。
          if (index >= finalized) {
            finalText += transcript;
            finalized = index + 1;
          }
        } else {
          interimText += transcript;
        }
      }
      if (finalText) finalRef.current += finalText;
      interimRef.current = interimText;
    };

    recognition.onerror = (event) => {
      const message = errorText(event.error);
      if (message) onErrorRef.current?.(message);
      if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") {
        heldRef.current = false;
        setRecording(false);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      // iOS 在停顿后可能自己结束；手指还没松开就重新开始。
      if (heldRef.current) {
        // 结束前最后一段可能只有临时结果，先当作最终结果留下来。
        if (interimRef.current) {
          finalRef.current += interimRef.current;
          interimRef.current = "";
        }
        restartTimerRef.current = window.setTimeout(() => {
          if (!heldRef.current) return;
          const next = recognitionCtor();
          if (!next) {
            commit();
            return;
          }
          try {
            listen(next);
          } catch {
            heldRef.current = false;
            setRecording(false);
            commit();
          }
        }, 250);
        return;
      }
      commit();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      heldRef.current = false;
      setRecording(false);
      onErrorRef.current?.("无法开始录音，请再按住说话试试。");
    }
  }

  function begin() {
    if (disabledRef.current || heldRef.current) return;
    const Recognition = recognitionCtor();
    if (!Recognition) {
      onErrorRef.current?.(UNSUPPORTED_MESSAGE);
      return;
    }
    window.clearTimeout(commitTimerRef.current);
    window.clearTimeout(restartTimerRef.current);
    heldRef.current = true;
    finalRef.current = "";
    interimRef.current = "";
    onErrorRef.current?.("");
    setRecording(true);
    listen(Recognition);
  }

  function end() {
    if (!heldRef.current) return;
    heldRef.current = false;
    window.clearTimeout(restartTimerRef.current);
    setRecording(false);
    const recognition = recognitionRef.current;
    if (!recognition) {
      commit();
      return;
    }
    try {
      recognition.stop();
    } catch {
      commit();
      return;
    }
    // 兜底：onend 迟迟不来时也把已听到的内容写进输入框。
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
        try {
          recognition.abort();
        } catch {
          // 忽略。
        }
      }
      commit();
    }, 3000);
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (disabledRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    begin();
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    end();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    begin();
  }

  function onKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    end();
  }

  return (
    <span className={big ? "voice-wrap voice-wrap-big" : "voice-wrap"}>
      <button
        type="button"
        className={big ? "attach-btn voice-btn voice-btn-big" : "attach-btn voice-btn"}
        data-recording={recording}
        /* 不支持语音时不置 disabled：按钮仍可聚焦/点击，按下后由 begin()
           通过 onError 说明原因，而不是让用户面对一个点不动的灰按钮。 */
        data-unsupported={!supported ? "true" : undefined}
        disabled={disabled}
        aria-disabled={disabled || !supported || undefined}
        aria-label={recording ? "松开结束语音输入" : "按住说话"}
        aria-pressed={recording}
        title={supported ? "按住说话，松开转成文字" : "当前浏览器不支持语音输入，点击查看说明"}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        /* 读屏/语音控制合成的 click 不一定先发 pointerdown；对不支持的浏览器
           在这里兜底给提示（detail === 0 表示不是鼠标/触摸点出来的 click）。 */
        onClick={(event) => {
          if (supported || disabledRef.current || event.detail !== 0) return;
          onErrorRef.current?.(UNSUPPORTED_MESSAGE);
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <svg
          width={big ? 24 : 16}
          height={big ? 24 : 16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="2.5" width="6" height="11" rx="3" />
          <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0" />
          <path d="M12 17v4.5" />
          <path d="M8.5 21.5h7" />
        </svg>
        {big && <span className="voice-btn-label">{recording ? "松手转文字" : "按住说话"}</span>}
      </button>
      {recording && !big && <span className="voice-live" role="status">正在听，松手转文字</span>}
    </span>
  );
}
