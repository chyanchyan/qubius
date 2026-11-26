import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveStatus } from "./ui";
import { subscribeBoard, type BoardSubscription } from "./board-stream";

/** EventSource 的在线状态；用于断线提示和手动重连。 */
export type StreamStatus = LiveStatus;
export type StreamEvent = "start" | "open" | "error" | "fatal" | "retry";

/** 看板流地址；其它地址（带 ?session=）是详情流。 */
export const BOARD_EVENTS_URL = "/api/events";

export function isBoardEventsUrl(url: string): boolean {
  return url === BOARD_EVENTS_URL;
}

/** 纯状态迁移，方便测试；超时转 offline 由 hook 的计时器负责。 */
export function nextStreamStatus(current: StreamStatus, event: StreamEvent): StreamStatus {
  switch (event) {
    case "start":
      return "connecting";
    case "open":
      return "live";
    case "error":
      return current === "offline" ? "offline" : "reconnecting";
    case "fatal":
      return "offline";
    case "retry":
      return "connecting";
    default:
      return current;
  }
}

export interface EventStreamOptions {
  url: string;
  /** 事件名 → 处理函数；只注册一次，处理函数本身可以随渲染更新。 */
  handlers: Record<string, (event: MessageEvent) => void>;
  onOpen?: () => void;
  enabled?: boolean;
  /** 断线多久后从「重连中」变成「已断开」并给出手动重连。 */
  offlineAfterMs?: number;
}

export interface EventStreamState {
  status: StreamStatus;
  reconnect: () => void;
}

function tabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** 把看板事件包装成处理函数期望的 MessageEvent；测试环境没有构造器时退化为对象。 */
function boardEvent(data: string): MessageEvent {
  if (typeof MessageEvent === "function") return new MessageEvent("session", { data });
  return { data } as MessageEvent;
}

/**
 * 用 EventSource 订阅服务端事件，并暴露连接状态。
 *
 * 看板流（/api/events）走 board-stream：多个页面共用一条连接，整个浏览器
 * profile 最多一条 SSE，避免多开标签把 HTTP/1.1 的 6 条连接占满。
 * 详情流（/api/events?session=）仍由本页独占，但标签隐藏时断开；回到前台
 * 重连后服务端会先发一帧 reset 完成同步，因此后台标签不再占用连接。
 */
export function useEventStream({
  url,
  handlers,
  onOpen,
  enabled = true,
  offlineAfterMs = 10_000,
}: EventStreamOptions): EventStreamState {
  const handlersRef = useRef(handlers);
  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
    onOpenRef.current = onOpen;
  });

  const [status, setStatus] = useState<StreamStatus>(() => nextStreamStatus("connecting", "start"));
  const [epoch, setEpoch] = useState(0);
  const board = isBoardEventsUrl(url);

  /* 详情流跟随标签页可见性：隐藏时断开，避免多个后台标签各占一条连接。 */
  const [visible, setVisible] = useState(tabVisible);
  useEffect(() => {
    if (board) return;
    const onVisibility = () => setVisible(tabVisible());
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [board]);

  const active = enabled && (board || visible);
  const boardSubscription = useRef<BoardSubscription | null>(null);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let offlineTimer = 0;
    const clearOfflineTimer = () => {
      if (!offlineTimer) return;
      window.clearTimeout(offlineTimer);
      offlineTimer = 0;
    };
    const armOfflineTimer = () => {
      if (offlineTimer) return;
      offlineTimer = window.setTimeout(() => {
        offlineTimer = 0;
        if (!disposed) setStatus((current) => nextStreamStatus(current, "fatal"));
      }, offlineAfterMs);
    };

    setStatus((current) => nextStreamStatus(current, "start"));

    if (board) {
      const subscription = subscribeBoard({
        onEvent: (data) => handlersRef.current.session?.(boardEvent(data)),
        onOpen: () => {
          clearOfflineTimer();
          setStatus((current) => nextStreamStatus(current, "open"));
          onOpenRef.current?.();
        },
        onError: () => {
          setStatus((current) => nextStreamStatus(current, "error"));
          armOfflineTimer();
        },
      });
      boardSubscription.current = subscription;
      return () => {
        disposed = true;
        clearOfflineTimer();
        if (boardSubscription.current === subscription) boardSubscription.current = null;
        subscription.unsubscribe();
      };
    }

    if (typeof EventSource === "undefined") {
      setStatus((current) => nextStreamStatus(current, "fatal"));
      return;
    }

    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch {
      setStatus((current) => nextStreamStatus(current, "fatal"));
      return;
    }

    const onOpenEvent = () => {
      if (disposed) return;
      clearOfflineTimer();
      setStatus((current) => nextStreamStatus(current, "open"));
      onOpenRef.current?.();
    };
    const onErrorEvent = () => {
      if (disposed) return;
      setStatus((current) => nextStreamStatus(current, "error"));
      if (source.readyState === EventSource.CLOSED) {
        setStatus((current) => nextStreamStatus(current, "fatal"));
        return;
      }
      armOfflineTimer();
    };

    source.addEventListener("open", onOpenEvent);
    source.addEventListener("error", onErrorEvent);

    const named: Array<[string, (event: Event) => void]> = [];
    for (const name of Object.keys(handlersRef.current)) {
      const listener = (event: Event) => {
        if (disposed) return;
        handlersRef.current[name]?.(event as MessageEvent);
      };
      named.push([name, listener]);
      source.addEventListener(name, listener);
    }

    return () => {
      disposed = true;
      clearOfflineTimer();
      source.removeEventListener("open", onOpenEvent);
      source.removeEventListener("error", onErrorEvent);
      for (const [name, listener] of named) source.removeEventListener(name, listener);
      source.close();
    };
  }, [url, active, epoch, offlineAfterMs]);

  const reconnect = useCallback(() => {
    setStatus((current) => nextStreamStatus(current, "retry"));
    if (isBoardEventsUrl(url)) boardSubscription.current?.retry();
    else setEpoch((value) => value + 1);
  }, [url]);

  return { status, reconnect };
}
