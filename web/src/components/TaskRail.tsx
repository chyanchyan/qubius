import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  getTaskOutput,
  stopBackgroundTask,
  type BackgroundTask,
  type Session,
  type TaskOutput,
} from "../api";
import {
  countTasks,
  isTaskActive,
  latestTaskLine,
  parseTaskProgress,
  sortTasksForDisplay,
  taskDisplayName,
  taskDurationMs,
  taskStatusLabel,
  TASK_POLL_MS,
} from "../background-tasks";
import { formatToolDuration } from "../tool-summary";
import { taskRailTasks } from "../task-rail-view";
import { useNow } from "../useNow";
import "./TaskRail.css";

/** 任务栏最多展示的条数；排序已保证运行中的任务优先。 */
const MAX_TASKS = 8;

interface RailData {
  outputs: Record<string, TaskOutput>;
  errors: Record<string, string>;
  expanded: Record<string, boolean>;
  stopping: Record<string, boolean>;
  /** 停止请求已成功发出、但 SSE 还没把任务变为终态。 */
  stopRequested: Record<string, boolean>;
  stopErrors: Record<string, string>;
}

interface RailState extends RailData {
  sessionId: string;
}

const EMPTY_DATA: RailData = {
  outputs: {},
  errors: {},
  expanded: {},
  stopping: {},
  stopRequested: {},
  stopErrors: {},
};

function emptyState(sessionId: string): RailState {
  return {
    sessionId,
    outputs: {},
    errors: {},
    expanded: {},
    stopping: {},
    stopRequested: {},
    stopErrors: {},
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "").trim();
  return text || "未知错误";
}

/** 复制后删掉一个键；没有该键时原样返回，避免无意义的新对象。 */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** 百分比文案：整数直接显示，小数保留一位。 */
function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/**
 * 后台 shell 任务栏：默认收起，标题行汇总运行中/已完成/失败数量；
 * 展开后逐条显示 session.backgroundTasks 的状态、用时、进度和输出尾部。
 *
 * 只对 running 任务按 TASK_POLL_MS 轮询，且每个任务串行（上一轮完成后再排下一轮）；
 * 页面不可见时暂停，恢复可见后立即补一次。任务结束后补拉一次最终输出。
 * 输出/错误/展开状态按会话隔离，切换 session.id 时清空并中断在途请求。
 */
export function TaskRail({ session }: { session: Session }) {
  const tasks = useMemo(
    () => sortTasksForDisplay(session.backgroundTasks ?? []),
    [session.backgroundTasks],
  );
  /* 与历史消息一样在渲染期校正：切换会话时立即回到收起、不展开全部的状态。 */
  const bodyId = useId();
  const [rail, setRail] = useState({ sessionId: session.id, open: false, showAll: false });
  if (rail.sessionId !== session.id) setRail({ sessionId: session.id, open: false, showAll: false });
  const open = rail.sessionId === session.id ? rail.open : false;
  const showAll = rail.sessionId === session.id ? rail.showAll : false;
  /* 默认只展示 MAX_TASKS 条，展开后显示全部；排序不变，只是截断位置不同。 */
  const visibleTasks = useMemo(
    () => taskRailTasks(tasks, showAll, MAX_TASKS),
    [tasks, showAll],
  );
  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const runningCount = counts.running;
  /* 只比较运行中任务 id 的集合，避免每个 SSE 帧都重启轮询循环。 */
  const runningKey = useMemo(
    () => tasks.filter(isTaskActive).map((task) => task.taskId).sort().join("\u0000"),
    [tasks],
  );
  const now = useNow(runningCount > 0 ? TASK_POLL_MS : 60_000);

  /* 轮询循环读取最新任务列表，避免闭包拿到旧的 status。 */
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const [state, setState] = useState<RailState>(() => emptyState(session.id));
  const [announcement, setAnnouncement] = useState("");
  /* 渲染期先按新会话显示空数据，避免切换时闪一帧旧输出。 */
  const data = state.sessionId === session.id ? state : EMPTY_DATA;

  /* 每个任务最多一个在途请求；控制器用于卸载/切会话时中断。 */
  const controllersRef = useRef(new Map<string, AbortController>());
  const pendingRef = useRef(new Map<string, Promise<void>>());
  const timersRef = useRef(new Map<string, number>());
  const stopControllersRef = useRef(new Set<AbortController>());
  /* 会话代际：每次中断（切换会话/卸载）递增，阻止旧请求的续拉再发起新请求。 */
  const generationRef = useRef(0);
  /* 记录上一帧的任务状态，用于识别 running -> 终态。 */
  const previousStatusRef = useRef(new Map<string, BackgroundTask["status"]>());
  const finalFetchedRef = useRef(new Set<string>());

  const apply = useCallback(
    (change: (current: RailState) => RailState) => {
      const sessionId = session.id;
      setState((current) => (current.sessionId === sessionId ? change(current) : current));
    },
    [session.id],
  );

  /**
   * 拉取一个任务的最新输出。
   *
   * - 已有在途请求：默认直接复用；afterCurrent 时等它结束后再补一次。
   * - 成功只更新该任务的 output 并清掉错误；失败保留上次成功结果，只记录错误。
   */
  const fetchOutput = useCallback(
    (taskId: string, afterCurrent = false): Promise<void> => {
      const generation = generationRef.current;
      const existing = pendingRef.current.get(taskId);
      if (existing) {
        if (!afterCurrent) return existing;
        return existing.then(() => {
          /* 等前一个请求期间会话已切换/组件已卸载：不要再为旧会话发请求。 */
          if (generation !== generationRef.current) return;
          return fetchOutput(taskId);
        });
      }
      const controller = new AbortController();
      const sessionId = session.id;
      const promise = (async () => {
        try {
          const output = await getTaskOutput(sessionId, taskId, controller.signal);
          if (controller.signal.aborted) return;
          apply((current) => ({
            ...current,
            outputs: { ...current.outputs, [taskId]: output },
            errors: omitKey(current.errors, taskId),
          }));
        } catch (error) {
          if (controller.signal.aborted) return;
          apply((current) => ({
            ...current,
            errors: { ...current.errors, [taskId]: `读取失败：${messageOf(error)}` },
          }));
        } finally {
          /* 只有仍是本次请求的控制器时才清理，避免旧会话/旧一轮的 finally
             误删新一轮已登记的在途请求。 */
          if (controllersRef.current.get(taskId) === controller) {
            controllersRef.current.delete(taskId);
            pendingRef.current.delete(taskId);
          }
        }
      })();
      controllersRef.current.set(taskId, controller);
      pendingRef.current.set(taskId, promise);
      return promise;
    },
    [apply, session.id],
  );

  /* 卸载或切换会话：中断输出/停止请求并清掉所有定时器。 */
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
      pendingRef.current.clear();
      for (const controller of stopControllersRef.current) controller.abort();
      stopControllersRef.current.clear();
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
    };
  }, [session.id]);

  /* 切换会话时清空本地输出、错误和展开状态。 */
  useEffect(() => {
    setState((current) => (current.sessionId === session.id ? current : emptyState(session.id)));
    setAnnouncement("");
    previousStatusRef.current = new Map();
    finalFetchedRef.current = new Set();
  }, [session.id]);

  /* running -> 终态：补拉一次最终输出，并做一次适度的状态播报。 */
  useEffect(() => {
    const previous = previousStatusRef.current;
    const next = new Map<string, BackgroundTask["status"]>();
    const finished: BackgroundTask[] = [];
    for (const task of tasks) {
      next.set(task.taskId, task.status);
      const before = previous.get(task.taskId);
      if (
        before === "running"
        && task.status !== "running"
        && !finalFetchedRef.current.has(task.taskId)
      ) {
        finalFetchedRef.current.add(task.taskId);
        finished.push(task);
        void fetchOutput(task.taskId, true);
      }
    }
    previousStatusRef.current = next;
    if (finished.length > 0) {
      setAnnouncement(
        finished
          .map((task) => `任务「${taskDisplayName(task)}」${taskStatusLabel(task.status)}`)
          .join("；"),
      );
    }
  }, [tasks, fetchOutput]);

  /* 只轮询运行中的任务；每轮请求完成后再排下一次，页面隐藏时暂停。 */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const ids = runningKey ? runningKey.split("\u0000") : [];
    if (ids.length === 0) return;
    const timers = timersRef.current;
    let cancelled = false;

    const poll = async (taskId: string) => {
      timers.delete(taskId);
      if (cancelled || document.visibilityState !== "visible") return;
      await fetchOutput(taskId);
      if (cancelled || document.visibilityState !== "visible") return;
      const latest = tasksRef.current.find((task) => task.taskId === taskId);
      if (!latest || latest.status !== "running") return;
      /* 可见性切换等场景可能同时恢复两个循环，这里保证每个任务只有一个定时器。 */
      if (timers.has(taskId)) return;
      timers.set(taskId, window.setTimeout(() => { void poll(taskId); }, TASK_POLL_MS));
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const taskId of ids) {
        const timer = timers.get(taskId);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timers.delete(taskId);
        }
        void poll(taskId);
      }
    };

    for (const taskId of ids) void poll(taskId);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      for (const taskId of ids) {
        const timer = timers.get(taskId);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timers.delete(taskId);
        }
      }
    };
  }, [session.id, runningKey, fetchOutput]);

  async function stopTask(task: BackgroundTask) {
    if (data.stopping[task.taskId] || data.stopRequested[task.taskId]) return;
    const controller = new AbortController();
    const sessionId = session.id;
    stopControllersRef.current.add(controller);
    apply((current) => ({
      ...current,
      stopping: { ...current.stopping, [task.taskId]: true },
      stopRequested: omitKey(current.stopRequested, task.taskId),
      stopErrors: omitKey(current.stopErrors, task.taskId),
    }));
    try {
      await stopBackgroundTask(sessionId, task.taskId, controller.signal);
      /* 请求成功不等于任务已停：保持禁用，等 SSE 把状态变为 stopped。 */
      apply((current) => ({
        ...current,
        stopRequested: { ...current.stopRequested, [task.taskId]: true },
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      apply((current) => ({
        ...current,
        stopErrors: { ...current.stopErrors, [task.taskId]: `停止失败：${messageOf(error)}` },
      }));
    } finally {
      stopControllersRef.current.delete(controller);
      apply((current) => ({
        ...current,
        stopping: omitKey(current.stopping, task.taskId),
      }));
    }
  }

  function toggleTask(task: BackgroundTask, open: boolean) {
    apply((current) => ({
      ...current,
      expanded: { ...current.expanded, [task.taskId]: open },
    }));
    /* 终态任务默认不拉输出；用户第一次展开且还没有结果时按需补一次。 */
    if (
      open
      && task.status !== "running"
      && !data.outputs[task.taskId]
      && !pendingRef.current.has(task.taskId)
    ) {
      void fetchOutput(task.taskId);
    }
  }

  if (tasks.length === 0) return null;

  const hiddenCount = tasks.length - visibleTasks.length;

  return (
    <div className="task-rail">
      <button
        className="task-rail-head"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setRail({ sessionId: session.id, open: !open, showAll })}
      >
        <span className="task-rail-title">后台任务 {tasks.length}</span>
        <span className="task-rail-running" data-active={runningCount > 0 ? "true" : undefined}>
          {runningCount} 个运行中
        </span>
        <span
          className="task-rail-completed"
          data-completed={counts.completed > 0 ? "true" : undefined}
        >
          {counts.completed} 个已完成
        </span>
        {counts.failed > 0 && (
          <span className="task-rail-failed">{counts.failed} 个失败</span>
        )}
        <svg
          className="task-rail-chevron"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="task-rail-list" id={bodyId}>
          {visibleTasks.map((task) => {
            const output = data.outputs[task.taskId];
            const percent = output ? parseTaskProgress(output.output).percent : undefined;
            const latest = output ? latestTaskLine(output.output) : "";
            const duration = formatToolDuration(taskDurationMs(task, now));
            const name = taskDisplayName(task);
            const running = isTaskActive(task);
            const expanded = Boolean(data.expanded[task.taskId]);
            const stopping = Boolean(data.stopping[task.taskId]);
            const stopRequested = Boolean(data.stopRequested[task.taskId]);
            const error = data.errors[task.taskId];
            const stopError = data.stopErrors[task.taskId];
            return (
              <details
                key={task.taskId}
                className="task-rail-item"
                data-status={task.status}
                open={expanded}
                onToggle={(event) => toggleTask(task, event.currentTarget.open)}
              >
                <summary className="task-rail-summary">
                  <span className="task-rail-status">{taskStatusLabel(task.status)}</span>
                  <span className="task-rail-name" title={name}>{name}</span>
                  {percent !== undefined && (
                    <span className="task-rail-percent">{formatPercent(percent)}</span>
                  )}
                  {duration && <span className="task-rail-duration">{duration}</span>}
                  {running && (
                    <button
                      className="task-rail-stop"
                      type="button"
                      disabled={stopping || stopRequested}
                      onClick={(event) => {
                        /* 别让点击冒泡到 summary 把任务展开。 */
                        event.preventDefault();
                        event.stopPropagation();
                        void stopTask(task);
                      }}
                    >
                      {stopping ? "停止中…" : stopRequested ? "已请求停止" : "停止"}
                    </button>
                  )}
                  {latest ? (
                    <span className="task-rail-latest" title={latest}>{latest}</span>
                  ) : running ? (
                    <span className="task-rail-latest task-rail-latest-empty">等待输出…</span>
                  ) : null}
                  {/* 进度条和错误也放在 summary 里：折叠状态下同样能看到。 */}
                  {running && percent !== undefined && (
                    <span
                      className="task-rail-progress"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                      aria-label={`${name} 进度`}
                    >
                      <span className="task-rail-progress-fill" style={{ width: `${percent}%` }} />
                    </span>
                  )}
                  {(error || stopError) && (
                    <span className="task-rail-error">{error || stopError}</span>
                  )}
                </summary>
                {expanded && (
                  <div className="task-rail-body">
                    {output ? (
                      <>
                        {output.output ? (
                          <pre className="task-rail-output">{output.output}</pre>
                        ) : (
                          <div className="task-rail-empty">
                            {running ? "正在等待输出…" : "无输出"}
                          </div>
                        )}
                        <div className="task-rail-meta">
                          输出 {output.totalBytes} 字节（仅尾部{output.truncated ? "，已截断" : ""}）
                        </div>
                      </>
                    ) : (
                      <div className="task-rail-empty">正在等待输出…</div>
                    )}
                  </div>
                )}
              </details>
            );
          })}
          {hiddenCount > 0 && (
            <button
              className="task-rail-more"
              type="button"
              aria-expanded={false}
              onClick={() => setRail({ sessionId: session.id, open, showAll: true })}
            >
              显示全部（{hiddenCount}）
            </button>
          )}
          {showAll && tasks.length > MAX_TASKS && (
            <button
              className="task-rail-more"
              type="button"
              aria-expanded
              onClick={() => setRail({ sessionId: session.id, open, showAll: false })}
            >
              收起
            </button>
          )}
        </div>
      )}
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
    </div>
  );
}
