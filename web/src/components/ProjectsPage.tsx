import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getInstance,
  getProjects,
  PERMISSION_LABEL,
  startSecondaryRollback,
  startSecondarySync,
  type InstanceInfo,
  type PrimaryComparison,
  type Project,
  type Session,
} from "../api";
import { listAllSessions } from "../api-sessions";
import { getMergeStatus, type MergeStatus } from "../api-git";
import { projectLampState } from "../branch-state";
import { formatRelativeTime } from "../format";
import {
  activeProjectIds,
  applyActivity,
  emptyActivity,
  mergeActivity,
  type ProjectActivity,
} from "../project-activity";
import { Dialog, ErrorState, Notice, Skeleton, useDialogs } from "../ui";
import { useEventStream } from "../useEventStream";
import { ProjectManager } from "./ProjectManager";
import "./ProjectsPage.css";

const LOAD_ERROR_FALLBACK = "请检查网络或服务器状态";
const UNAVAILABLE_HINT = "请检查服务器配置中的路径是否存在，以及运行用户是否有访问权限。";

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/** 两个 id 集合内容相同就不需要更新 state，避免每个流式事件都重渲染整个列表。 */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export function ProjectsPage({ go }: { go: (to: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [retrying, setRetrying] = useState(false);
  /* 项目列表和副实例信息共用一次重试：token 变化会同时重新请求两者。 */
  const [reloadToken, setReloadToken] = useState(0);
  /* 「管理项目」弹窗；旧链接 /settings?tab=projects 会带 ?manage=1 跳到这里。 */
  const [managing, setManaging] = useState(
    () => new URLSearchParams(window.location.search).get("manage") === "1",
  );
  const [activeIds, setActiveIds] = useState<ReadonlySet<string>>(() => new Set());
  const activeIdsRef = useRef<ReadonlySet<string>>(activeIds);
  const activityRef = useRef<ProjectActivity>(emptyActivity());
  /* 项目列表的灯：会话快照 + 每个项目的分支状态。灯数据没到位前沿用原来的
     活动灯（run / idle），避免首屏闪一下空心。 */
  const [lampSessions, setLampSessions] = useState<Session[] | null>(null);
  const [projectStatuses, setProjectStatuses] = useState<Record<string, MergeStatus>>({});
  const lampSeq = useRef(0);
  const fetchSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fetching = useRef(false);
  // 整表请求期间收到的事件：成功时与快照一起重放，避免响应覆盖掉更新的状态。
  const pendingEvents = useRef(new Map<string, Session>());

  const publishActivity = useCallback((state: ProjectActivity) => {
    activityRef.current = state;
    const next = activeProjectIds(state);
    if (sameIds(activeIdsRef.current, next)) return;
    activeIdsRef.current = next;
    setActiveIds(next);
  }, []);

  const refreshActivity = useCallback(() => {
    // 取消在途请求，避免旧响应晚到覆盖新状态。
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++fetchSeq.current;
    fetching.current = true;
    listAllSessions(undefined, controller.signal)
      .then((data) => {
        if (seq !== fetchSeq.current || controller.signal.aborted) return;
        // mergeActivity 会丢弃比快照旧的活跃事件，乱序时不会把状态改回去。
        const merged = mergeActivity(data.sessions, pendingEvents.current.values());
        publishActivity(merged);
      })
      .catch(() => {
        // 活动灯只是辅助信息，失败时静默保留现状，不新增错误横幅。
      })
      .finally(() => {
        if (seq !== fetchSeq.current) return;
        fetching.current = false;
        pendingEvents.current.clear();
      });
  }, [publishActivity]);

  useEffect(() => {
    const controller = new AbortController();
    getProjects(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setProjects(data.projects);
        setLoadError("");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorText(reason, LOAD_ERROR_FALLBACK));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRetrying(false);
      });
    return () => controller.abort();
  }, [reloadToken]);

  /* 项目灯的数据：一次拉全部会话，再为有分支的项目并发取 merge-status。
     merge-status 会按会话 worktree 探测未提交改动，比普通列表请求重，
     所以单独按 30 秒低频刷新；页面不可见时暂停。 */
  const refreshLamps = useCallback(async () => {
    if (!projects) return;
    const seq = ++lampSeq.current;
    let sessions: Session[];
    try {
      sessions = (await listAllSessions()).sessions;
    } catch {
      // 灯是辅助信息：失败时保留上一次结果，不打断项目列表。
      return;
    }
    if (seq !== lampSeq.current) return;
    const withBranches = new Set(
      sessions.filter((session) => session.branch).map((session) => session.projectId),
    );
    const targets = projects.filter(
      (project) => project.git && project.available && withBranches.has(project.id),
    );
    const results = await Promise.allSettled(targets.map((project) => getMergeStatus(project.id)));
    if (seq !== lampSeq.current) return;
    setProjectStatuses((current) => {
      const next: Record<string, MergeStatus> = {};
      targets.forEach((project, index) => {
        const result = results[index];
        // 单个项目请求失败时沿用上次成功的状态，灯不会突然变成空心。
        if (result?.status === "fulfilled") next[project.id] = result.value;
        else if (current[project.id]) next[project.id] = current[project.id];
      });
      return next;
    });
    setLampSessions(sessions);
  }, [projects]);

  useEffect(() => {
    if (!projects) return;
    void refreshLamps();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshLamps();
    }, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshLamps();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projects, refreshLamps]);

  const retry = useCallback(() => {
    setRetrying(true);
    setReloadToken((value) => value + 1);
    refreshActivity();
  }, [refreshActivity]);

  /* 订阅全部项目的会话事件，按 id 增量更新活动状态。走 useEventStream 的
     看板通道：同一浏览器里所有标签页共用一条 SSE，不会多开就占满连接池。 */
  useEventStream({
    url: "/api/events",
    onOpen: () => {
      // 订阅建立后再拉整表快照：若先拉快照、再建订阅，两步之间发生的变化
      // 既不在快照里也不会进 pendingEvents，会一直残留到下次重连。
      // 重连同理整表对齐，补齐断线期间漏掉的事件。
      // 首次请求失败后重连 open 也会再拉一次；refreshActivity 自己 abort
      // 旧请求并用序号丢弃迟到响应，重复调用是安全的。
      refreshActivity();
    },
    handlers: {
      session: (event) => {
        let data: Session;
        try {
          data = JSON.parse(event.data) as Session;
        } catch {
          return;
        }
        if (!data || typeof data.id !== "string") return;
        // 请求在途时缓存事件，成功响应会连同快照一起重放。
        if (fetching.current) pendingEvents.current.set(data.id, data);
        // 同时实时应用，灯不必等整表响应才变化。
        const next = applyActivity(activityRef.current, data);
        if (next !== activityRef.current) publishActivity(next);
      },
    },
  });

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshActivity();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      abortRef.current?.abort();
    };
  }, [refreshActivity]);

  /* 打开管理弹窗后去掉 ?manage=1，刷新页面不会再次弹出。 */
  useEffect(() => {
    if (!managing) return;
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("manage")) return;
      url.searchParams.delete("manage");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // 地址栏不可写时保留 query，不影响弹窗本身。
    }
  }, [managing]);

  // 内置「普通对话」放在最前面；它不依赖用户配置，永远可用。
  const ordered = projects
    ? [...projects].sort((a, b) => Number(b.builtin) - Number(a.builtin))
    : null;
  /* 按项目分组会话，用来算项目灯。 */
  const lampGroups = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const session of lampSessions ?? []) {
      const list = groups.get(session.projectId);
      if (list) list.push(session);
      else groups.set(session.projectId, [session]);
    }
    return groups;
  }, [lampSessions]);
  return (
    <section className="page projects-page">
      <div className="projects-head">
        <h1>选择项目</h1>
        <button type="button" className="btn" onClick={() => setManaging(true)}>
          管理项目
        </button>
      </div>
      <p className="lead">项目来自服务器配置；在「管理项目」里可以添加或删除跟踪的仓库，无需重启。</p>
      <SecondaryPanel reloadToken={reloadToken} />
      {loadError ? (
        <div className="projects-error" aria-busy={retrying || undefined}>
          <fieldset className="projects-error-field" disabled={retrying}>
            <ErrorState
              message={`无法加载项目列表：${loadError}`}
              onRetry={retry}
              retryLabel={retrying ? "正在重试…" : "重试"}
            />
          </fieldset>
        </div>
      ) : ordered ? (
        <>
          {ordered.length === 0 && <p className="muted">还没有项目。</p>}
          <div className="stack">
            {ordered.map((project) => {
              // 不可用项目优先显示红点；灯数据到位后按项目内的分支灯取
              // 橙 > 黄 > 浅绿 > 绿 > 灰，没有分支时用空心灯；数据加载前沿用活动灯。
              const status = projectStatuses[project.id];
              const lamp = lampSessions === null
                ? undefined
                : projectLampState(lampGroups.get(project.id) ?? [], {
                    mergedKnown: Boolean(status?.base),
                    merged: new Set(status?.merged ?? []),
                    untouched: new Set(status?.untouched ?? []),
                    dirty: new Set(status?.dirty ?? []),
                  });
              const tone = !project.available
                ? "bad"
                : lampSessions === null
                  ? (activeIds.has(project.id) ? "run" : "idle")
                  : (lamp ?? "empty");
              return (
                <button
                  key={project.id}
                  className="convo"
                  onClick={() => go(`/projects/${project.id}`)}
                  disabled={!project.available}
                  title={project.available ? undefined : UNAVAILABLE_HINT}
                  aria-label={project.available ? undefined : `${project.name}：不可用，${UNAVAILABLE_HINT}`}
                >
                  <i className="dot" data-tone={tone} />
                  <span className="convo-text">
                    <strong className="convo-title">{project.name}</strong>
                    <span className="convo-sub mono">{project.path}</span>
                  </span>
                  <span className="convo-meta">
                    {!project.available
                      ? "不可用"
                      : project.builtin
                        ? `${PERMISSION_LABEL[project.permission]} · 内置`
                        : `${PERMISSION_LABEL[project.permission]}${project.isolated ? " · 独立目录" : ""}`}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="projects-loading" role="status" aria-live="polite">
          <Skeleton lines={3} />
          <span className="visually-hidden">正在加载项目列表…</span>
        </div>
      )}
      <Dialog
        open={managing}
        title="管理项目"
        description="添加已有仓库、新建仓库或移除跟踪项；改动立即生效。"
        wide
        showActions={false}
        onConfirm={() => {}}
        onClose={() => setManaging(false)}
      >
        {managing && <ProjectManager onChange={() => setReloadToken((value) => value + 1)} />}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => setManaging(false)}>
            关闭
          </button>
        </div>
      </Dialog>
    </section>
  );
}

function PrimaryCompare({ primary }: { primary: PrimaryComparison }) {
  const behind = primary.relation === "behind";
  const meta = [
    behind && typeof primary.files === "number"
      ? `${primary.files} 个文件，+${primary.insertions ?? 0} / −${primary.deletions ?? 0}`
      : "",
    behind && primary.depsChanged ? "依赖有变化，同步时会重新安装" : "",
    primary.dirty ? "主实例有未提交改动，不会被同步" : "",
  ].filter(Boolean).join("；");
  const commits = primary.commits ?? [];
  const total = primary.behind ?? commits.length;
  return (
    <div className="maintenance-compare" data-relation={primary.relation}>
      <div className="maintenance-compare-main">
        {behind && (
          <>
            <strong>主实例领先 {primary.behind ?? "?"} 个提交</strong>
            <span className="mono muted">{primary.ref} · {primary.head}</span>
          </>
        )}
        {primary.relation === "up-to-date" && (
          <span className="muted">已是最新（{primary.ref} · {primary.head ?? "—"}）</span>
        )}
        {primary.relation === "diverged" && (
          <span>
            副实例有 {primary.ahead ?? "?"} 个主实例没有的提交，主实例另有 {primary.behind ?? "?"} 个，需要手动合并后才能同步。
          </span>
        )}
        {primary.relation === "unknown" && (
          <span className="muted">暂时无法比较主实例版本{primary.reason ? `：${primary.reason}` : ""}</span>
        )}
      </div>
      {primary.subject && primary.relation !== "unknown" && (
        <div className="maintenance-compare-sub" title={primary.subject}>
          {behind ? "最新提交" : primary.relation === "diverged" ? "主实例最新提交" : "当前提交"}：{primary.subject}
          {primary.committedAt ? ` · ${formatRelativeTime(primary.committedAt)}` : ""}
        </div>
      )}
      {meta && <div className="maintenance-compare-meta">{meta}</div>}
      {behind && commits.length > 0 && (
        <details className="maintenance-commits">
          <summary>
            {total > commits.length ? `查看最近 ${commits.length} / 共 ${total} 个提交` : `查看 ${commits.length} 个提交`}
          </summary>
          <ul>
            {commits.map((commit) => (
              <li key={commit.sha}>
                <span className="mono">{commit.sha}</span> {commit.subject}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SecondaryPanel({ reloadToken }: { reloadToken: number }) {
  const dialogs = useDialogs();
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"sync" | "rollback" | "">("");
  const [polling, setPolling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const baselineJob = useRef("");
  const jobStarted = useRef(false);
  const deadline = useRef(0);
  // 成功后延时刷新页面；离开这个页面时要能取消，避免刚切走就被强制刷新。
  const reloadTimer = useRef<number | null>(null);
  // 确认对话框是异步的；关闭页面后不再发起维护请求或写状态。
  const alive = useRef(true);
  // 防止双击在确认对话框出现前排队出两个相同的确认框。
  const confirming = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError("");
    getInstance()
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        if (next.secondary?.state === "running") {
          jobStarted.current = true;
          deadline.current = Date.now() + 180_000;
          setPolling(true);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorText(reason, "无法获取副实例状态"));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled) return;
      // 页面不可见时不轮询；切回来后下一次 tick 会补上状态。
      if (document.visibilityState === "hidden") return;
      // 先检查超时再防重入，卡住的请求也不会让 180s 截止时间失效。
      if (Date.now() > deadline.current) {
        setPolling(false);
        setError("维护任务超时，请查看副实例日志");
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getInstance();
        if (cancelled) return;
        setInfo(next);
        setRestarting(false);
        const status = next.secondary;
        if (!status || status.state === "running" || !jobStarted.current) return;
        if (!status.jobId) return;
        if (baselineJob.current && status.jobId === baselineJob.current) return;
        jobStarted.current = false;
        setPolling(false);
        if (status.state === "success") {
          reloadTimer.current = window.setTimeout(() => window.location.reload(), 700);
        }
      } catch {
        if (!cancelled) setRestarting(true);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling]);

  async function run(action: "sync" | "rollback") {
    if (confirming.current) return;
    confirming.current = true;
    const ref = info?.secondary?.primary?.ref ?? "main";
    const active = info?.activeSessions ?? 0;
    const text = action === "sync"
      ? `从主实例同步已验收的 ${ref}，构建并重启副实例？${active > 0 ? `当前 ${active} 个进行中的会话会被中断。` : ""}`
      : `回滚到上一次同步前的版本，构建并重启副实例？${active > 0 ? `当前 ${active} 个进行中的会话会被中断。` : ""}`;
    let confirmed = false;
    try {
      confirmed = await dialogs.confirm({
        title: action === "sync" ? "同步主功能" : "回滚副实例",
        message: text,
        confirmLabel: action === "sync" ? "同步并重启" : "回滚并重启",
        danger: action === "rollback",
      });
    } finally {
      confirming.current = false;
    }
    if (!confirmed || !alive.current) return;
    baselineJob.current = info?.secondary?.jobId ?? "";
    jobStarted.current = true;
    deadline.current = Date.now() + 180_000;
    setPending(action);
    setError("");
    try {
      await (action === "sync" ? startSecondarySync() : startSecondaryRollback());
      if (!alive.current) return;
      setRestarting(false);
      setPolling(true);
    } catch (reason) {
      if (!alive.current) return;
      jobStarted.current = false;
      setError(reason instanceof Error ? reason.message : "无法启动维护任务");
    } finally {
      if (alive.current) setPending("");
    }
  }

  const secondary = info?.secondary;
  if (!secondary) {
    /* 拉取失败时 info 为空；仍然要给出可读的错误，而不是整块消失。 */
    return error
      ? <Notice tone="error" className="maintenance-notice">副实例维护：{error}</Notice>
      : null;
  }
  const running = secondary.state === "running";
  const busy = running || polling || pending !== "";
  const primary = secondary.primary;
  const syncRef = primary?.ref ?? "main";
  const codeHead = secondary.currentHead ? secondary.currentHead.slice(0, 8) : "";
  const runningHead = secondary.runningHead;
  const activeSessions = info?.activeSessions ?? 0;
  // 与 secondary.sh 开头的检查一致：不在 main 或工作区不干净时任务会直接失败。
  const preflight = secondary.branch && secondary.branch !== "main"
    ? `副实例当前不在 main 分支（${secondary.branch}），同步会失败。`
    : secondary.dirty
      ? "副实例工作区有未提交改动（含未跟踪文件），同步会失败。"
      : "";

  return (
    <div className="maintenance">
      <div className="maintenance-head">
        <strong>副实例维护</strong>
        <span
          className="mono"
          title={codeHead && runningHead && codeHead !== runningHead ? `运行版本 ${runningHead}，代码 ${codeHead}` : undefined}
        >
          {runningHead ? `运行 ${runningHead}` : codeHead ? `代码 ${codeHead}` : "未知版本"}
        </span>
      </div>
      <p className="muted">
        从主实例拉取已验收的 {syncRef}，构建后重启副实例。
        {secondary.previousHead
          ? ` 可回滚到 ${secondary.previousHead.slice(0, 8)}${secondary.previousSubject ? `（${secondary.previousSubject}）` : ""}。`
          : ""}
      </p>
      {primary && <PrimaryCompare primary={primary} />}
      {!running && codeHead && runningHead && codeHead !== runningHead && (
        <Notice tone="error">
          代码已是 {codeHead}，但服务运行的是 {runningHead}；可能是构建或重启没有完成。
        </Notice>
      )}
      {!running && activeSessions > 0 && (
        <p className="muted maintenance-impact">
          同步或回滚会重启副实例，当前 {activeSessions} 个进行中的会话会被中断。
        </p>
      )}
      {preflight && <Notice tone="error">{preflight}</Notice>}
      <div className="maintenance-actions">
        <button
          className="text-btn maintenance-btn"
          disabled={busy || Boolean(preflight)}
          onClick={() => void run("sync")}
        >
          {primary?.relation === "behind" ? `同步主功能（${primary.behind ?? "?"} 个提交）` : "同步主功能"}
        </button>
        <button
          className="text-btn maintenance-btn"
          disabled={busy || Boolean(preflight) || !secondary.previousHead}
          onClick={() => void run("rollback")}
        >
          回滚
        </button>
      </div>
      {running && (
        <Notice tone="info">
          {restarting ? "服务重启中…" : `正在${secondary.action === "rollback" ? "回滚" : "同步"}…`}
        </Notice>
      )}
      {!running && secondary.message && (
        <Notice tone={secondary.state === "failed" ? "error" : secondary.state === "success" ? "success" : "info"}>
          {secondary.message}
          {secondary.finishedAt ? ` · ${formatRelativeTime(secondary.finishedAt)}` : ""}
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {secondary.logTail && (running || secondary.state === "failed") && (
        <pre className="maintenance-log">{secondary.logTail}</pre>
      )}
    </div>
  );
}
