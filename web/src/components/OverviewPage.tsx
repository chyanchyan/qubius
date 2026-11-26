import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  answerSession,
  deleteSession,
  getProjects,
  PHASE_LABEL,
  type Phase,
  type Project,
  type Session,
} from "../api";
import { answerBody } from "../answers";
import { addPending, hasPending, removePending } from "../pending-actions";
import { listAllSessions, patchSession } from "../api-sessions";
import { Approval } from "./Approval";
import { BranchBadge } from "./BranchBadge";
import { ARCHIVE_RESTORE_NOTE, deleteDetail } from "../archive-copy";
import { formatMessageFullTime, formatRelativeTime } from "../format";
import { applySessionRemoved, applySessionUpdate, sortSessions } from "../overview-search";
import {
  ConnectionBanner,
  ErrorState,
  Menu,
  Notice,
  Skeleton,
  useDialogs,
} from "../ui";
import { useEventStream } from "../useEventStream";
import { useNow } from "../useNow";
import "./OverviewPage.css";

/**
 * 全部项目的对话总览：按状态分组、支持搜索/置顶/改名/归档。
 * 路由由 App.tsx 接进来（建议 /overview），点行进入 /sessions/:id。
 */

interface Props {
  go: (to: string) => void;
  /** 页面底部附加内容，例如用量面板。 */
  children?: ReactNode;
}

interface GroupDef {
  title: string;
  phases: readonly Phase[];
}

const GROUPS: readonly GroupDef[] = [
  { title: "待配置 / 等待确认", phases: ["setup", "needs_input"] },
  { title: "进行中 / 排队", phases: ["running", "queued"] },
  { title: "失败 / 已停止", phases: ["failed", "stopped"] },
  { title: "最近完成", phases: ["completed"] },
];

/** 每组默认展示条数；其余折叠在「显示更多」后面，避免长列表淹没重点。 */
const GROUP_PREVIEW = 8;

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * 把命中搜索词的片段包进 <mark>；只拼文本节点，不碰 innerHTML。
 * 用带捕获组的 split 直接拿到命中原文，避免对 lowercase 副本取下标时
 * 遇到 İ 等大小写映射改变长度的字符而切错位置。
 */
function HighlightText({ text, query }: { text?: string | null; query: string }) {
  const source = text ?? "";
  const needle = query.trim();
  if (!source) return null;
  if (!needle) return <>{source}</>;

  const pattern = new RegExp(`(${needle.replace(REGEXP_SPECIALS, "\\$&")})`, "gi");
  const parts = source.split(pattern);
  return (
    <>
      {parts.map((part, index) => (
        index % 2 === 1
          ? <mark key={index} className="search-hit">{part}</mark>
          : part
      ))}
    </>
  );
}

/** 本页删除标记：at 与事件时间比较；requestId 判断整表请求是否晚于删除。 */
interface DeleteMark {
  at: number;
  requestId: number;
}

/** 解析事件里的服务端时间；缺失/非法返回 null（按“可能已恢复”的保守处理）。 */
function eventTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * 本页删除某个 id 后，判断随后的非 removed 事件/结果是否已被服务端恢复。
 * 未删除 → 接受；updatedAt 缺失/解析失败 → 按恢复处理并清除 tombstone；
 * updatedAt 明显早于删除时间 → 视为迟到的旧事件，忽略。
 */
function acceptsAfterDelete(
  marks: Map<string, DeleteMark>,
  id: string,
  updatedAt: unknown,
): boolean {
  const mark = marks.get(id);
  if (!mark) return true;
  const time = eventTimestamp(updatedAt);
  if (time !== null && time < mark.at) return false;
  marks.delete(id);
  return true;
}

export function OverviewPage({ go, children }: Props) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  /* 是否至少成功完成过一次整表加载；决定空列表文案和“列表可能不完整”提示。 */
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [listError, setListError] = useState("");
  const [projectsError, setProjectsError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  /* 内联回答：按会话记录在途状态，会话之间互不影响；同一会话防连点。 */
  const [answeringIds, setAnsweringIds] = useState<ReadonlySet<string>>(() => new Set());
  const answeringIdsRef = useRef(new Set<string>());
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const dialogs = useDialogs();
  /* 列表里的相对时间每分钟刷新一次。 */
  const now = useNow(60_000);

  const queryRef = useRef("");
  /* 只允许最新一次列表请求写状态；搜索、可见性刷新会并发触发。 */
  const fetchSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const firstQuery = useRef(true);
  /* 请求期间到达的 SSE 事件：整表响应可能比事件旧，落地前再补一遍。
     只在这段窗口内缓存，按 id 去重，避免长期驻留。 */
  const eventSeq = useRef(0);
  const fetching = useRef(false);
  const loaded = useRef(false);
  /* SSE 监听器只注册一次，用 ref 读取最新的错误状态，避免把它加进 effect 依赖。 */
  const listErrorRef = useRef("");
  const pendingEvents = useRef(new Map<string, { seq: number; session: Session }>());
  /* 本页删除成功的 id → 删除标记。只挡删除前发起的整表响应和更新早于删除的
     迟到事件；服务端恢复（同 id 的新事件/新请求）会清除它。 */
  const deleteMarks = useRef(new Map<string, DeleteMark>());
  /* 每次整表请求递增；用于判断请求是否在删除之后发起，避免 Date.now 同毫秒歧义。 */
  const requestSeq = useRef(0);
  /* 首次 open 不重复拉取（挂载 effect 已经请求），重连时整表对齐。 */
  const streamOpened = useRef(false);

  const refreshSessions = useCallback(() => {
    const seq = ++fetchSeq.current;
    const eventMark = eventSeq.current;
    /* 本请求的序号：大于删除时的序号说明请求在删除之后发起，结果权威。 */
    const requestId = ++requestSeq.current;
    // 整表请求与回放必须用同一个搜索词，避免回放时按新词过滤出不一致的结果。
    const requestQuery = queryRef.current;
    fetching.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    listAllSessions(requestQuery, controller.signal)
      .then((data) => {
        if (seq !== fetchSeq.current) return;
        const deleted = deleteMarks.current;
        let next = sortSessions(data.sessions.filter((item) => {
          const mark = deleted.get(item.id);
          if (!mark) return true;
          /* 请求在删除之后才发起：服务端结果权威（可能是恢复），清掉 tombstone。 */
          if (requestId > mark.requestId) {
            deleted.delete(item.id);
            return true;
          }
          /* 请求早于删除：这是删除前的旧快照，过滤掉。 */
          return false;
        }));
        for (const [id, pending] of pendingEvents.current) {
          // 更早的事件已经被服务端列表包含，只补请求开始后到达的。
          if (pending.seq <= eventMark) continue;
          if (pending.session.removed) {
            next = applySessionRemoved(next, id);
            continue;
          }
          /* 删除前更新的迟到事件不能插回来；更新更晚（或时间缺失）视为恢复。 */
          if (!acceptsAfterDelete(deleted, id, pending.session.updatedAt)) continue;
          next = applySessionUpdate(next, pending.session, requestQuery);
        }
        pendingEvents.current.clear();
        fetching.current = false;
        loaded.current = true;
        setLoadedOnce(true);
        setSessions(next);
        setListError("");
      })
      .catch((reason: unknown) => {
        if (seq !== fetchSeq.current || controller.signal.aborted) return;
        fetching.current = false;
        // 首次加载失败也要结束 loading：先快照再清空，避免 setState 更新函数
        // 异步执行时读到空 Map。期间收到的事件仍可拼出一份最小列表。
        const buffered = [...pendingEvents.current.values()]
          .filter((pending) => !pending.session.removed)
          .map((pending) => pending.session);
        pendingEvents.current.clear();
        if (!loaded.current && buffered.length > 0) {
          let fallback: Session[] = [];
          for (const session of buffered) {
            if (!acceptsAfterDelete(deleteMarks.current, session.id, session.updatedAt)) continue;
            fallback = applySessionUpdate(fallback, session, requestQuery);
          }
          if (fallback.length > 0) {
            /* 只有事件拼出的部分列表：保留完整性提示，不标记 loaded/loadedOnce，
               也不清 listError；等整表成功后再由 then 分支收尾。 */
            setSessions((current) => (current && current.length > 0 ? current : fallback));
          }
        }
        setListError(errorText(reason, "加载对话失败"));
        /* 列表置空而不是停在 null/整页错误：稳定连接下后续 SSE 事件仍能落地，
           错误以可关闭的 Notice + 重试继续展示；loaded 仍为 false，等下一次
           open/可见性/重试做整表对齐。 */
        if (!loaded.current) setSessions((current) => current ?? []);
      });
  }, []);

  const loadProjects = useCallback(() => {
    getProjects()
      .then((data) => {
        setProjects(data.projects);
        setProjectsError("");
      })
      .catch((reason: unknown) => setProjectsError(errorText(reason, "加载项目失败")));
  }, []);

  useEffect(() => {
    loadProjects();
    refreshSessions();
    return () => abortRef.current?.abort();
  }, [loadProjects, refreshSessions]);

  useEffect(() => {
    listErrorRef.current = listError;
  }, [listError]);

  /* 输入防抖 300ms；首帧由挂载 effect 直接拉取，不重复请求。 */
  useEffect(() => {
    queryRef.current = query;
    if (firstQuery.current) {
      firstQuery.current = false;
      return;
    }
    const timer = window.setTimeout(() => refreshSessions(), 300);
    return () => window.clearTimeout(timer);
  }, [query, refreshSessions]);

  const onSessionEvent = useCallback((event: MessageEvent) => {
    let data: Session;
    try {
      data = JSON.parse(event.data as string) as Session;
    } catch {
      return;
    }
    if (!data || typeof data.id !== "string") return;
    /* 非 removed 事件若更新时间明显早于本页删除，说明是迟到的旧帧，忽略；
       updatedAt 缺失/解析失败或更新更晚时按“服务端已恢复”处理并清除 tombstone。 */
    if (!data.removed && !acceptsAfterDelete(deleteMarks.current, data.id, data.updatedAt)) {
      return;
    }
    // 事件能正常应用说明连接与数据都可用，清掉旧的加载错误提示。
    if (loaded.current) setListError("");
    const seq = ++eventSeq.current;
    // 只有请求在飞时才需要缓存：落地后它会覆盖这份旧快照。
    if (fetching.current) pendingEvents.current.set(data.id, { seq, session: data });
    setSessions((current) => {
      /* 只有整表成功前才是 null；失败时 catch 会把列表置为 []，事件随后可落地。 */
      if (!current) return current;
      if (data.removed) return applySessionRemoved(current, data.id);
      /* 搜索态规则统一放在 applySessionUpdate：字段命中转不命中移除，
         正文命中的旧行保留，新会话需字段命中才插入。 */
      return applySessionUpdate(current, data, queryRef.current);
    });
  }, []);

  const onStreamOpen = useCallback(() => {
    // 首次连接若挂载请求尚未成功或仍有加载错误，补一次自愈；
    // 重连时整表对齐，补齐断线期间漏掉的事件。
    if (streamOpened.current || !loaded.current || listErrorRef.current !== "") {
      refreshSessions();
    }
    streamOpened.current = true;
  }, [refreshSessions]);

  const { status, reconnect } = useEventStream({
    url: "/api/events",
    handlers: { session: onSessionEvent },
    onOpen: onStreamOpen,
  });

  /* 回前台整表刷新，补齐隐藏期间的遗漏；事件本身已增量应用到本地列表。 */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshSessions();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshSessions]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

  const groups = useMemo(
    () => GROUPS.map((group) => ({
      ...group,
      items: (sessions ?? []).filter((session) => group.phases.includes(session.phase)),
    })),
    [sessions],
  );

  function replaceSession(next: Session) {
    /* 本地改名/置顶与 SSE 用同一套搜索规则：改名后不再命中时也会移出结果。 */
    setSessions((current) => (current ? applySessionUpdate(current, next, queryRef.current) : current));
  }

  /* 列表里直接回答提问/授权，不进入详情页；后续 SSE 帧会覆盖同一会话。 */
  async function answerPending(
    session: Session,
    behavior: "allow" | "deny",
    answers?: Record<string, string>,
    remember?: boolean,
    approvedFull?: boolean,
  ) {
    if (!session.pending || hasPending(answeringIdsRef.current, session.id)) return;
    const next = addPending(answeringIdsRef.current, session.id);
    if (!next) return;
    answeringIdsRef.current = next;
    setAnsweringIds(next);
    setActionError("");
    try {
      const data = await answerSession(
        session.id,
        answerBody(session.pending, behavior, answers, remember, approvedFull),
      );
      replaceSession(data.session);
    } catch (reason) {
      setActionError(errorText(reason, "提交回答失败"));
    } finally {
      answeringIdsRef.current = removePending(answeringIdsRef.current, session.id);
      setAnsweringIds(answeringIdsRef.current);
    }
  }

  async function togglePin(session: Session) {
    if (busyId) return;
    setBusyId(session.id);
    setActionError("");
    try {
      const data = await patchSession(session.id, { pinned: !session.pinned });
      replaceSession(data.session);
    } catch (reason) {
      setActionError(errorText(reason, "置顶失败"));
    } finally {
      setBusyId("");
    }
  }

  async function renameSession(session: Session) {
    if (busyId) return;
    const input = await dialogs.prompt({
      title: "重命名对话",
      message: "标题会显示在总览和对话页里。",
      label: "标题",
      initialValue: session.title,
      placeholder: "输入 1-80 个字符",
      maxLength: 80,
      confirmLabel: "保存",
      validate: (value) => {
        const title = value.trim();
        if (title.length < 1) return "标题不能为空";
        if (title.length > 80) return "标题最多 80 个字符";
        return "";
      },
    });
    if (input === null) return;
    const title = input.trim();
    if (title.length < 1 || title.length > 80) {
      setActionError("标题需要 1 到 80 个字符");
      return;
    }
    setBusyId(session.id);
    setActionError("");
    try {
      const data = await patchSession(session.id, { title });
      replaceSession(data.session);
    } catch (reason) {
      setActionError(errorText(reason, "改名失败"));
    } finally {
      setBusyId("");
    }
  }

  async function removeSession(session: Session) {
    if (busyId) return;
    const name = session.title || "未命名对话";
    const ok = await dialogs.confirm({
      title: "归档对话",
      message: `将归档「${name}」：${deleteDetail(session)}。${ARCHIVE_RESTORE_NOTE}`,
      confirmLabel: "归档",
      cancelLabel: "取消",
      danger: true,
    });
    if (!ok) return;
    setBusyId(session.id);
    setActionError("");
    try {
      await deleteSession(session.id);
      /* 记录删除时间：删除前发起的整表响应和迟到旧事件会被过滤；删除后发起的
         请求、或更新时间更晚的事件视为服务端权威（可能已被其他客户端恢复）。 */
      deleteMarks.current.set(session.id, { at: Date.now(), requestId: requestSeq.current });
      setSessions((current) => (
        current ? current.filter((item) => item.id !== session.id) : current
      ));
      /* 立即用服务端权威结果重建，顺带清掉不再需要的 tombstone。 */
      refreshSessions();
    } catch (reason) {
      setActionError(errorText(reason, "归档失败"));
    } finally {
      setBusyId("");
    }
  }

  function toggleGroup(title: string) {
    setExpandedGroups((current) => ({ ...current, [title]: !current[title] }));
  }

  const trimmedQuery = query.trim();
  /* 与动作函数里的 busyId 守卫保持一致：有动作在飞时全部菜单项禁用。 */
  const actionsDisabled = busyId !== "";
  const hasRows = (sessions?.length ?? 0) > 0;
  /* 从未成功整表加载、但 SSE 已经带来部分行：提示不完整，而不是报加载失败。 */
  const partialList = !loadedOnce && hasRows;

  return (
    <section className="page overview-page">
      <h1>总览</h1>
      <p className="lead">所有项目的对话；等待确认和进行中的排在最前面。</p>

      <div className="overview-search" role="search">
        <input
          type="search"
          value={query}
          placeholder="搜索所有对话…"
          aria-label="搜索所有对话"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query !== "" && (
          <button className="text-btn" type="button" onClick={() => setQuery("")}>
            清除
          </button>
        )}
      </div>

      <ConnectionBanner status={status} onRetry={reconnect} />

      {actionError && (
        <Notice tone="error" className="overview-notice" onDismiss={() => setActionError("")}>
          {actionError}
        </Notice>
      )}
      {projectsError && (
        <Notice
          tone="warn"
          className="overview-notice"
          action={{ label: "重试", onClick: loadProjects }}
          onDismiss={() => setProjectsError("")}
        >
          项目名称加载失败：{projectsError}
        </Notice>
      )}
      {sessions !== null && listError && (
        <Notice
          /* 已有数据时用温和提示，避免“错误 + 数据”同时出现。 */
          tone={hasRows ? "warn" : "error"}
          className="overview-notice"
          action={{ label: "重试", onClick: refreshSessions }}
          onDismiss={() => setListError("")}
        >
          {partialList
            ? `列表可能不完整：${listError}。可重新加载列表。`
            : hasRows
              ? `${listError}（当前显示的是上次加载结果，可重试）`
              : listError}
        </Notice>
      )}

      {/* 正常失败路径会在 catch 里把列表置空并走上方的 Notice；这里只兜底
          列表尚未初始化就带着错误的极端状态。 */}
      {sessions === null && listError && (
        <ErrorState message={listError} onRetry={refreshSessions} />
      )}
      {sessions === null && !listError && (
        <div className="overview-loading" role="status" aria-live="polite">
          <p className="muted overview-loading-label">正在加载对话…</p>
          <Skeleton lines={6} className="overview-loading-skeleton" />
        </div>
      )}

      {sessions !== null && sessions.length === 0 && !listError && (
        loadedOnce ? (
          <p className="muted">
            {trimmedQuery ? `没有匹配「${trimmedQuery}」的对话。` : "还没有对话。去项目里发起一个吧。"}
          </p>
        ) : (
          /* 从未成功加载过时不要复用“还没有对话”的空列表文案。 */
          <div className="overview-incomplete" role="status">
            <p className="muted">对话列表尚未成功加载，请稍后重试。</p>
            <button className="btn" type="button" onClick={refreshSessions}>重试</button>
          </div>
        )
      )}

      {groups.map((group, groupIndex) => {
        if (group.items.length === 0) return null;
        const expanded = expandedGroups[group.title] === true;
        const items = expanded ? group.items : group.items.slice(0, GROUP_PREVIEW);
        const hidden = group.items.length - items.length;
        /* 组顺序固定，id 在整页生命周期内稳定，供 aria-controls 引用。 */
        const listId = `overview-group-${groupIndex}-list`;
        return (
          <section key={group.title} className="overview-group" aria-label={group.title}>
            <h2 className="overview-group-title">
              {group.title}
              <span className="overview-count">
                {group.items.length}
                <span className="visually-hidden"> 个对话</span>
              </span>
            </h2>
            <div className="overview-list" id={listId}>
              {items.map((session) => {
                const projectName = projectNames.get(session.projectId) ?? session.projectId;
                const title = session.title || "未命名对话";
                return (
                  <div key={session.id} className="overview-item">
                    <div className="overview-row" data-phase={session.phase}>
                      <button
                        className="overview-row-main"
                        type="button"
                        onClick={() => go(`/sessions/${session.id}`)}
                      >
                        <span
                          className={`overview-pin${session.pinned ? " pinned" : ""}`}
                          aria-hidden={!session.pinned}
                        >
                          {session.pinned ? "★" : "·"}
                        </span>
                        <span className="convo-text">
                          <strong className="convo-title">
                            {session.title
                              ? <HighlightText text={session.title} query={trimmedQuery} />
                              : title}
                          </strong>
                          <span className="convo-sub">
                            {session.summary ? (
                              <>
                                <HighlightText text={session.summary} query={trimmedQuery} />
                                <span aria-hidden="true"> · </span>
                              </>
                            ) : null}
                            {projectName}
                            {session.branch && (
                              <>
                                <span aria-hidden="true"> · </span>
                                <BranchBadge branch={session.branch} />
                              </>
                            )}
                            <span aria-hidden="true"> · </span>
                            <span className="phase-label" data-phase={session.phase}>
                              {PHASE_LABEL[session.phase]}
                            </span>
                          </span>
                        </span>
                        <span className="convo-meta overview-model">{session.model}</span>
                        <time
                          className="convo-meta overview-time"
                          dateTime={session.updatedAt}
                          title={formatMessageFullTime(session.updatedAt)}
                        >
                          {formatRelativeTime(session.updatedAt, now)}
                        </time>
                      </button>
                      <div className="overview-actions">
                        <Menu
                          label="⋯"
                          title="会话操作"
                          ariaLabel={`会话操作：${title}`}
                          items={[
                            {
                              id: "pin",
                              label: session.pinned ? "取消置顶" : "置顶",
                              onSelect: () => void togglePin(session),
                              disabled: actionsDisabled,
                            },
                            {
                              id: "rename",
                              label: "改名",
                              onSelect: () => void renameSession(session),
                              disabled: actionsDisabled,
                            },
                            {
                              id: "delete",
                              label: "归档",
                              onSelect: () => void removeSession(session),
                              disabled: actionsDisabled,
                              danger: true,
                              separatorBefore: true,
                            },
                          ]}
                        />
                      </div>
                    </div>
                    {session.pending && (
                      <Approval
                        pending={session.pending}
                        variant="inline"
                        busy={answeringIds.has(session.id)}
                        onAnswer={(behavior, answers, remember, approvedFull) => {
                          void answerPending(session, behavior, answers, remember, approvedFull);
                        }}
                      />
                    )}
                  </div>
                );
              })}
              {group.items.length > GROUP_PREVIEW && (
                <button
                  className="text-btn overview-more"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => toggleGroup(group.title)}
                >
                  {expanded ? "收起" : `显示更多（${hidden}）`}
                </button>
              )}
            </div>
          </section>
        );
      })}
      {children}
    </section>
  );
}
