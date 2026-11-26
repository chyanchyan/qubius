import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "./api";
import { listAllSessions } from "./api-sessions";
import { setAttentionCount } from "./title";
import { useEventStream } from "./useEventStream";

/**
 * 全局待处理会话：等待确认，或 24 小时内失败的对话。
 * 顶栏 badge 和标签页标题共用同一份计数；SSE 只更新内部的 ref，
 * 计数不变时不会触发 App 重渲染（流式输出期间每帧都会来一个 session 事件）。
 */

export const ATTENTION_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/* 初始播种失败后的退避间隔；用尽后保持最后一档，避免永久停在 0。 */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
/* 顶栏速度的衰减刻度与发布间隔：每秒最多让 App 重渲染一次。 */
const SPEED_TICK_MS = 500;
const SPEED_PUBLISH_MS = 1_000;

type AttentionSession = Pick<Session, "phase" | "updatedAt">;

/** 失败超过 24 小时就不再提醒；时间无效时按需要处理算，避免漏掉异常数据。 */
export function needsAttention(session: AttentionSession, now = Date.now()): boolean {
  if (session.phase === "needs_input") return true;
  if (session.phase !== "failed") return false;
  const updatedAt = Date.parse(session.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return now - updatedAt < ATTENTION_FAILED_WINDOW_MS;
}

export function countAttention(sessions: Iterable<AttentionSession>, now = Date.now()): number {
  let count = 0;
  for (const session of sessions) {
    if (needsAttention(session, now)) count += 1;
  }
  return count;
}

/**
 * 所有对话里正在运行的 agent 数量之和：每个主 agent 算一个，运行中的子 agent
 * 各算一个；顶栏用它显示全局负载。
 */
export function countRunningAgents(
  sessions: Iterable<Pick<Session, "subagents" | "mainAgentRunning">>,
): number {
  let count = 0;
  for (const session of sessions) {
    // 旧版服务端的 SSE 帧可能没有这些字段，按主 agent 空闲、无子 agent 处理。
    if (session.mainAgentRunning) count += 1;
    for (const agent of session.subagents ?? []) {
      if (agent.status === "running") count += 1;
    }
  }
  return count;
}

/**
 * 列表快照与 SSE 增量合并：旧快照不能覆盖较新的单项；快照里没有的项
 * 只有在请求发出后收到过 SSE 的才保留（否则视为已删除/归档）。
 * removedIds 过滤删除占位/旧快照，收到同 id 的正常事件时调用方应先把它移除。
 */
export function mergeAttentionSessions(
  current: Map<string, Session>,
  incoming: Session[],
  requestedAt: number,
  removedIds: Set<string>,
  touchedAt: Map<string, number>,
): Map<string, Session> {
  const merged = new Map<string, Session>();
  const incomingIds = new Set<string>();
  for (const item of incoming) {
    if (removedIds.has(item.id)) continue;
    incomingIds.add(item.id);
    const existing = current.get(item.id);
    merged.set(item.id, existing && existing.updatedAt > item.updatedAt ? existing : item);
  }
  for (const [id, item] of current) {
    if (removedIds.has(id) || incomingIds.has(id)) continue;
    if ((touchedAt.get(id) ?? 0) > requestedAt) merged.set(id, item);
  }
  return merged;
}

/** 服务端的实时速度按 2 秒滑动窗口计算；客户端用同一窗口把最后值衰减到 0。 */
export const TOKEN_RATE_WINDOW_MS = 2_000;

type SpeedSession = Pick<Session, "updatedAt" | "tokensPerSecond">;

/**
 * 所有会话当前输出速度之和（tokens/s）。
 *
 * 服务端只在有新增量时更新 tokensPerSecond，输出停止后不会补发 0。这里以
 * updatedAt 作为最后一次增量的时间，把窗口内的速度按剩余窗口线性衰减；
 * 超过窗口后视为 0。顶栏因此不需要额外请求，也不依赖服务端定时器。
 */
export function sumTokenSpeed(sessions: Iterable<SpeedSession>, now = Date.now()): number {
  let total = 0;
  for (const session of sessions) {
    const rate = session.tokensPerSecond;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    const age = now - updatedAt;
    if (age >= TOKEN_RATE_WINDOW_MS) continue;
    // 服务端算的是窗口平均值；窗口内剩余的比例按线性衰减近似。
    total += age <= 0 ? rate : rate * (1 - age / TOKEN_RATE_WINDOW_MS);
  }
  return total;
}

export interface GlobalAttention {
  count: number;
  /** 所有对话里正在运行的 agent 总数（主 agent + 子 agent）。 */
  runningAgents: number;
  /** 所有对话当前输出速度之和（tokens/s，整数）；没有输出时为 0。 */
  tokenSpeed: number;
  refresh: () => Promise<boolean>;
}

export function useGlobalAttention(): GlobalAttention {
  const [count, setCount] = useState(0);
  const [runningAgents, setRunningAgents] = useState(0);
  const [tokenSpeed, setTokenSpeed] = useState(0);
  /* 流式期间 session 事件非常频繁；计数不变时连 setState 都不调用，
     App 及其页面不会因为全局订阅而重渲染。 */
  const countRef = useRef(0);
  const runningAgentsRef = useRef(0);
  /* 速度变化频繁，最多每秒发布一次；停止输出后由衰减计时器归零。 */
  const tokenSpeedRef = useRef(0);
  const speedPublishedAt = useRef(0);
  const speedTimer = useRef(0);
  const sessions = useRef(new Map<string, Session>());
  const removedIds = useRef(new Set<string>());
  const touchedAt = useRef(new Map<string, number>());
  const expiryTimer = useRef(0);
  const expiryAt = useRef(Number.POSITIVE_INFINITY);
  const recomputeRef = useRef<() => void>(() => {});
  /* 单飞：mount、SSE open、可见性刷新共享同一个在途请求，避免并发竞态。 */
  const inFlight = useRef<Promise<boolean> | null>(null);
  const seeded = useRef(false);
  const firstOpen = useRef(true);
  const retryTimer = useRef(0);
  const retryIndex = useRef(0);
  const disposed = useRef(false);
  const liveRef = useRef(false);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);

  /* failed 会话满 24 小时后计数要自动下降；只挂一个到期的计时器，
     每次重算都把它对齐到最早的到期时间，频繁的流式事件不会反复重建。 */
  const scheduleExpiry = useCallback((now: number) => {
    let soonest = Number.POSITIVE_INFINITY;
    for (const session of sessions.current.values()) {
      if (session.phase !== "failed" || !needsAttention(session, now)) continue;
      const updatedAt = Date.parse(session.updatedAt);
      if (!Number.isFinite(updatedAt)) continue;
      const remaining = updatedAt + ATTENTION_FAILED_WINDOW_MS - now;
      if (remaining <= 0) continue;
      soonest = Math.min(soonest, remaining);
    }
    const dueAt = Number.isFinite(soonest) ? now + Math.max(1_000, soonest + 50) : Number.POSITIVE_INFINITY;
    if (dueAt === expiryAt.current) return;
    expiryAt.current = dueAt;
    if (expiryTimer.current) {
      window.clearTimeout(expiryTimer.current);
      expiryTimer.current = 0;
    }
    if (Number.isFinite(dueAt)) {
      expiryTimer.current = window.setTimeout(() => {
        expiryTimer.current = 0;
        expiryAt.current = Number.POSITIVE_INFINITY;
        recomputeRef.current();
      }, Math.max(1_000, dueAt - now));
    }
  }, []);

  /* 速度只在有增量时刷新；停止输出后靠这个计时器让衰减值最终归零。 */
  const scheduleSpeedTick = useCallback(() => {
    if (speedTimer.current) return;
    const now = Date.now();
    let active = false;
    for (const session of sessions.current.values()) {
      const rate = session.tokensPerSecond;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
      const updatedAt = Date.parse(session.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt < TOKEN_RATE_WINDOW_MS) {
        active = true;
        break;
      }
    }
    if (!active) return;
    speedTimer.current = window.setTimeout(() => {
      speedTimer.current = 0;
      recomputeRef.current();
    }, SPEED_TICK_MS);
  }, []);

  const recompute = useCallback(() => {
    const now = Date.now();
    const next = countAttention(sessions.current.values(), now);
    if (next !== countRef.current) {
      countRef.current = next;
      setCount(next);
    }
    const nextAgents = countRunningAgents(sessions.current.values());
    if (nextAgents !== runningAgentsRef.current) {
      runningAgentsRef.current = nextAgents;
      setRunningAgents(nextAgents);
    }
    const nextSpeed = Math.round(sumTokenSpeed(sessions.current.values(), now));
    if (nextSpeed !== tokenSpeedRef.current) {
      /* 归零立即发布，其它变化按秒节流；App 不会因为流式令牌每 50ms 重渲染。 */
      if (nextSpeed === 0 || now - speedPublishedAt.current >= SPEED_PUBLISH_MS) {
        speedPublishedAt.current = now;
        tokenSpeedRef.current = nextSpeed;
        setTokenSpeed(nextSpeed);
      }
    }
    scheduleExpiry(now);
    scheduleSpeedTick();
  }, [scheduleExpiry, scheduleSpeedTick]);

  useEffect(() => {
    recomputeRef.current = recompute;
  }, [recompute]);

  const clearRetry = useCallback(() => {
    if (retryTimer.current) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = 0;
    }
    retryIndex.current = 0;
  }, []);

  /* SSE 在线时才重试；离线期间由下一次 open 触发整表对齐。 */
  const scheduleRetry = useCallback(() => {
    if (disposed.current || !liveRef.current || retryTimer.current) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex.current, RETRY_DELAYS_MS.length - 1)]!;
    retryIndex.current += 1;
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = 0;
      if (disposed.current || !liveRef.current) return;
      void refreshRef.current();
    }, delay);
  }, []);

  /**
   * 单飞的全表对齐。只有成功响应写 sessions；失败保留 last-good 并安排退避，
   * 较新的失败不会作废已经成功的旧结果（不再按请求序号丢弃成功响应）。
   */
  const refresh = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const requestedAt = Date.now();
    const promise = (async (): Promise<boolean> => {
      try {
        const data = await listAllSessions();
        /* 卸载后到达的响应不再写状态或重排 expiry 计时器。 */
        if (disposed.current) return false;
        sessions.current = mergeAttentionSessions(
          sessions.current,
          data.sessions,
          requestedAt,
          removedIds.current,
          touchedAt.current,
        );
        seeded.current = true;
        clearRetry();
        recompute();
        return true;
      } catch {
        // 全局提醒是辅助功能，读取失败不影响页面本身；保留上次成功的数据。
        scheduleRetry();
        return false;
      }
    })();
    inFlight.current = promise;
    void promise.finally(() => {
      if (inFlight.current === promise) inFlight.current = null;
    });
    return promise;
  }, [clearRetry, recompute, scheduleRetry]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const { status } = useEventStream({
    url: "/api/events",
    handlers: {
      session: (event) => {
        let data: Session;
        try {
          data = JSON.parse(event.data) as Session;
        } catch {
          return;
        }
        if (!data || typeof data.id !== "string") return;
        if (data.removed) {
          removedIds.current.add(data.id);
          sessions.current.delete(data.id);
          recompute();
          return;
        }
        /* 归档恢复后会以同 id 重新出现：清掉删除墓碑，让它重新计入。 */
        removedIds.current.delete(data.id);
        const previous = sessions.current.get(data.id);
        // SSE 帧按顺序到达；忽略明显更旧的帧，避免快照回退。
        if (previous && previous.updatedAt > data.updatedAt) return;
        touchedAt.current.set(data.id, Date.now());
        sessions.current.set(data.id, data);
        recompute();
      },
    },
    onOpen: () => {
      liveRef.current = true;
      /* 首次 open 时挂载播种已经在飞/已成功就不用再对齐；重连仍做整表对齐。 */
      if (firstOpen.current) {
        firstOpen.current = false;
        if (seeded.current || inFlight.current) return;
      }
      void refresh();
    },
  });

  /* 渲染期同步在线状态；onOpen 会在事件里先置 true，避免错过首次重试。 */
  liveRef.current = status === "live";

  useEffect(() => {
    disposed.current = false;
    void refresh();
    return () => {
      disposed.current = true;
      clearRetry();
    };
  }, [clearRetry, refresh]);

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  useEffect(() => {
    setAttentionCount(count);
  }, [count]);

  useEffect(() => () => {
    if (expiryTimer.current) window.clearTimeout(expiryTimer.current);
    if (speedTimer.current) window.clearTimeout(speedTimer.current);
  }, []);

  return { count, runningAgents, tokenSpeed, refresh };
}
