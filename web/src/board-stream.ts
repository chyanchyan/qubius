/**
 * 跨标签页共享的看板事件流（/api/events）。
 *
 * 浏览器对同一 origin 的 HTTP/1.1 连接上限是 6 条。原先每个标签页会为看板
 * 开一条 EventSource，几个标签就能把连接池占满，其它请求只能排队到超时
 * （页面表现为一直 loading）。这里优先用 SharedWorker 在整个 profile 里
 * 复用一条连接；不支持 SharedWorker 时退回本标签一条，并在标签隐藏时暂停，
 * 避免多开时互相挤占。
 */

export type BoardStatus = "connecting" | "live" | "error";

export interface BoardListener {
  /** SSE 的 session 事件负载，原样转交。 */
  onEvent: (data: string) => void;
  /** 连接建立（含重连成功）；调用方据此做一次整表同步。 */
  onOpen: () => void;
  /** 连接出错；调用方据此进入重连/离线提示。 */
  onError: () => void;
}

export interface BoardSubscription {
  unsubscribe: () => void;
  /** 手动重连。SharedWorker 模式下会重建全局的那条连接。 */
  retry: () => void;
}

interface Transport {
  add: (listener: BoardListener) => () => void;
  retry: () => void;
}

const WORKER_URL = "/board-worker.js";

interface WorkerMessage {
  type?: string;
  status?: BoardStatus;
  data?: unknown;
  /** hello 的定向回复：只通知发起订阅的那个 listener。 */
  helloId?: number;
}

function sharedTransport(): Transport | null {
  if (typeof SharedWorker === "undefined" || typeof window === "undefined") return null;
  let port: MessagePort;
  try {
    const worker = new SharedWorker(WORKER_URL);
    port = worker.port;
    port.start?.();
  } catch {
    /* 非安全上下文或浏览器不支持时退回本标签连接。 */
    return null;
  }

  const listeners = new Set<BoardListener>();
  const pendingHellos = new Map<number, BoardListener>();
  let helloSeq = 0;
  const notify = (listener: BoardListener, status: BoardStatus) => {
    if (!listeners.has(listener)) return;
    if (status === "live") listener.onOpen();
    else if (status === "error") listener.onError();
  };
  port.onmessage = (event: MessageEvent) => {
    const message = event.data as WorkerMessage | null;
    if (!message) return;
    if (message.type === "event" && typeof message.data === "string") {
      for (const listener of [...listeners]) listener.onEvent(message.data);
      return;
    }
    if (message.type !== "status") return;
    if (typeof message.helloId === "number") {
      const listener = pendingHellos.get(message.helloId);
      pendingHellos.delete(message.helloId);
      if (listener && message.status) {
        notify(listener, message.status);
        return;
      }
    }
    if (!message.status) return;
    for (const listener of [...listeners]) notify(listener, message.status);
  };

  const onPageHide = () => {
    try {
      port.postMessage({ type: "close" });
    } catch {
      /* 端口已关闭。 */
    }
    try {
      port.close();
    } catch {
      /* 已关闭。 */
    }
  };
  window.addEventListener("pagehide", onPageHide);

  return {
    add(listener) {
      listeners.add(listener);
      const helloId = ++helloSeq;
      pendingHellos.set(helloId, listener);
      try {
        port.postMessage({ type: "hello", helloId });
      } catch {
        pendingHellos.delete(helloId);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      try {
        port.postMessage({ type: "retry" });
      } catch {
        /* 端口已关闭。 */
      }
    },
  };
}

/** 没有 SharedWorker 时的单标签实现：一条连接，标签隐藏时断开。 */
function localTransport(): Transport {
  const listeners = new Set<BoardListener>();
  let source: EventSource | null = null;
  let status: BoardStatus = "connecting";
  let visible = typeof document === "undefined" || document.visibilityState !== "hidden";

  const notifyOpen = () => {
    for (const listener of [...listeners]) listener.onOpen();
  };
  const notifyError = () => {
    for (const listener of [...listeners]) listener.onError();
  };
  const close = () => {
    source?.close();
    source = null;
  };
  const open = () => {
    if (!visible || source) return;
    status = "connecting";
    const next = new EventSource("/api/events");
    source = next;
    next.addEventListener("open", () => {
      if (source !== next) return;
      status = "live";
      notifyOpen();
    });
    next.addEventListener("error", () => {
      if (source !== next) return;
      status = "error";
      notifyError();
    });
    next.addEventListener("session", (event) => {
      if (source !== next) return;
      const data = (event as MessageEvent).data;
      if (typeof data !== "string") return;
      for (const listener of [...listeners]) listener.onEvent(data);
    });
  };
  const onVisibility = () => {
    const next = document.visibilityState !== "hidden";
    if (next === visible) return;
    visible = next;
    if (visible) open();
    else close();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  return {
    add(listener) {
      listeners.add(listener);
      if (visible) open();
      /* 与 SharedWorker 的 hello 回复保持一致：已有连接时补一次同步信号。 */
      if (status === "live") {
        window.setTimeout(() => {
          if (listeners.has(listener)) listener.onOpen();
        }, 0);
      } else if (status === "error") {
        window.setTimeout(() => {
          if (listeners.has(listener)) listener.onError();
        }, 0);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) close();
      };
    },
    retry() {
      close();
      open();
    },
  };
}

let transport: Transport | null = null;

function getTransport(): Transport {
  if (!transport) transport = sharedTransport() ?? localTransport();
  return transport;
}

export function subscribeBoard(listener: BoardListener): BoardSubscription {
  const current = getTransport();
  const remove = current.add(listener);
  return {
    unsubscribe: remove,
    retry: () => current.retry(),
  };
}
