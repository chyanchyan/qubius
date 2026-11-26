import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  closeTerminal,
  createTerminal,
  openTerminalStream,
  resizeTerminal,
  sendTerminalInput,
} from "../api-terminal";
import {
  chunkTerminalInput,
  TerminalStreamParser,
  type TerminalServerMessage,
} from "../terminal-protocol";
import "./TerminalPage.css";

/**
 * 开发机命令行页：xterm.js 渲染，服务端一个会话对应一个真实 PTY。
 * 传输用普通 HTTP（SSE 输出 + POST 输入），这样经过带 Basic 认证的
 * Caddy / lan-proxy 时 Safari 也不会卡在 WebSocket 握手上。
 * 进入页面即新建 shell：带 project 时在该项目仓库路径下启动，否则用用户主目录；
 * 离开页面或点「重连」会换一个新 shell。
 */

type Status = "connecting" | "open" | "closed";

interface ReadyInfo {
  shell: string;
  cwd: string;
}

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const BASE_FONT_SIZE = 13;
/** 尺寸变化后等一小会儿再提交，避免拖动窗口时连续 POST。 */
const RESIZE_DEBOUNCE_MS = 120;

/** xterm 的字号是像素值，跟着顶栏的全局字号缩放走。 */
function terminalFontSize(): number {
  if (typeof document === "undefined") return BASE_FONT_SIZE;
  const raw = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--font-scale"),
  );
  const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.min(28, Math.max(9, Math.round(BASE_FONT_SIZE * scale)));
}

function terminalTheme() {
  if (typeof document === "undefined") {
    return { background: "#181818", foreground: "#cccccc", cursor: "#d97757" };
  }
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const background = read("--bg", "#181818");
  return {
    background,
    foreground: read("--fg", "#cccccc"),
    cursor: read("--orange", "#d97757"),
    cursorAccent: background,
    selectionBackground: "rgba(217, 119, 87, 0.35)",
  };
}

function exitNotice(message: TerminalServerMessage & { type: "exit" }): string {
  return `终端已退出（退出码 ${message.exitCode}${message.signal ? `，信号 ${message.signal}` : ""}）`;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "连接中断";
  if (/Failed to fetch|Load failed|NetworkError|network error/i.test(error.message)) {
    return "连接中断。若服务端启用了访问令牌，请先在「设置 → 访问令牌」填入令牌。";
  }
  return error.message || "连接中断";
}

export function TerminalPage({ project = "" }: { project?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** 输入和尺寸都通过当前连接发；未连接时是空函数。 */
  const senderRef = useRef<(data: string) => void>(() => {});
  const resizerRef = useRef<(cols: number, rows: number) => void>(() => {});
  const [status, setStatus] = useState<Status>("connecting");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [attempt, setAttempt] = useState(0);

  // xterm 实例只创建一次；尺寸变化和字号变化都在这里处理。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: terminalFontSize(),
      fontFamily: MONO_FONT,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        // 容器暂时不可见（切换路由的瞬间）时忽略。
      }
    };
    const fitAndResize = () => {
      fitNow();
      resizerRef.current(term.cols, term.rows);
    };
    const raf = requestAnimationFrame(fitAndResize);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitAndResize);
    observer?.observe(host);
    window.addEventListener("resize", fitAndResize);

    // 顶栏「小/大」按钮改的是 :root 的 style；同步到 xterm。
    const fontObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
        const size = terminalFontSize();
        if (term.options.fontSize === size) return;
        term.options.fontSize = size;
        requestAnimationFrame(fitAndResize);
      });
    fontObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

    const dataSub = term.onData((data) => senderRef.current(data));

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      fontObserver?.disconnect();
      window.removeEventListener("resize", fitAndResize);
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 每条连接：创建 PTY -> 打开 SSE -> 把输入排队 POST 回去。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    const controller = new AbortController();
    let sessionId: string | undefined;
    let resizeTimer: number | undefined;
    let lastResize = { cols: term.cols, rows: term.rows };
    const queue: string[] = [];
    let sending = false;

    setStatus("connecting");
    setNotice("");
    setReady(null);

    const pump = async () => {
      if (sending) return;
      sending = true;
      let failed = false;
      try {
        while (!cancelled && sessionId && queue.length > 0) {
          const data = queue.splice(0).join("");
          for (const chunk of chunkTerminalInput(data)) {
            await sendTerminalInput(sessionId, chunk);
          }
        }
      } catch {
        // 连接已断或会话被回收；丢弃积压输入，状态由 SSE 断开统一展示，
        // 不能在这里重试，否则会对已结束的会话空转。
        failed = true;
        queue.length = 0;
      } finally {
        sending = false;
        // 发送期间如果又积累了输入，继续发。
        if (!failed && !cancelled && sessionId && queue.length > 0) void pump();
      }
    };

    senderRef.current = (data) => {
      queue.push(data);
      void pump();
    };
    resizerRef.current = (cols, rows) => {
      lastResize = { cols, rows };
      if (resizeTimer !== undefined) return;
      resizeTimer = window.setTimeout(() => {
        resizeTimer = undefined;
        if (sessionId) void resizeTerminal(sessionId, lastResize.cols, lastResize.rows).catch(() => {});
      }, RESIZE_DEBOUNCE_MS);
    };

    const onMessage = (message: TerminalServerMessage) => {
      if (message.type === "data") term.write(message.data);
      else if (message.type === "exit") setNotice(exitNotice(message));
      else if (message.type === "error") setNotice(message.message);
    };

    void (async () => {
      try {
        try {
          fitRef.current?.fit();
        } catch {
          // 尺寸探测失败时用 xterm 当前值。
        }
        const created = await createTerminal(term.cols, term.rows, {
          project,
          signal: controller.signal,
        });
        if (cancelled) {
          void closeTerminal(created.id).catch(() => {});
          return;
        }
        sessionId = created.id;
        setReady({ shell: created.shell, cwd: created.cwd });
        void pump();

        const response = await openTerminalStream(created.id, controller.signal);
        if (cancelled) return;
        setStatus("open");
        term.focus();
        resizerRef.current(term.cols, term.rows);

        const reader = response.body?.getReader();
        if (!reader) throw new Error("浏览器不支持流式输出");
        const decoder = new TextDecoder();
        const parser = new TerminalStreamParser();
        for (;;) {
          const { done, value } = await reader.read();
          // 清理时 xterm 已经 dispose，迟到的数据帧不能再写进去。
          if (cancelled) return;
          if (done) break;
          for (const message of parser.push(decoder.decode(value, { stream: true }))) onMessage(message);
        }
        if (!cancelled) {
          setStatus("closed");
          setNotice((current) => current || "终端连接已结束");
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setStatus("closed");
        setNotice((current) => current || errorText(error));
        if (sessionId) void closeTerminal(sessionId).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      senderRef.current = () => {};
      resizerRef.current = () => {};
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      controller.abort();
      // 主动回收服务端 PTY；断网时服务端也会在 SSE 关闭后自行清理。
      if (sessionId) void closeTerminal(sessionId).catch(() => {});
    };
  }, [attempt, project]);

  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  const focusTerminal = useCallback(() => termRef.current?.focus(), []);
  const clearTerminal = useCallback(() => termRef.current?.clear(), []);

  const meta = ready
    ? `${ready.shell} · ${ready.cwd}`
    : status === "open"
      ? "开发机"
      : "未连接";

  return (
    <section className="page terminal-page" aria-label="开发机命令行">
      <div className="terminal-toolbar">
        <div className="terminal-heading-group">
          <h1 className="terminal-heading">命令行</h1>
          <span className="terminal-meta" title={meta}>{meta}</span>
        </div>
        <div className="terminal-actions">
          <button type="button" onClick={focusTerminal}>键盘</button>
          <button type="button" onClick={clearTerminal}>清屏</button>
          <button type="button" onClick={reconnect} disabled={status === "connecting"}>重连</button>
        </div>
      </div>
      <div className="terminal-body">
        <div className="terminal-host" ref={hostRef} />
        {status !== "open" && (
          <div className="terminal-overlay" role="status">
            <p className="terminal-overlay-title">
              {status === "connecting" ? "正在连接开发机…" : notice || "连接已断开"}
            </p>
            {status === "closed" && (
              <button type="button" className="btn-primary" onClick={reconnect}>重新连接</button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
