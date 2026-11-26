import {
  Component,
  Fragment,
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import {
  backgroundTask,
  getSubagentTranscript,
  imageUrl,
  SUBAGENT_LABEL,
  type ImageRef,
  type OutgoingImage,
  type RequestError,
  type Session,
  type Subagent,
  type SubagentTranscriptEntry,
  type TokenUsage,
  type Transcript,
} from "../api";
import type { Density } from "../density";
import {
  buildEditDiff,
  isEditTool,
  mergeChanges,
  type DiffLine,
  type EditDiff,
} from "../edit-diff";
import { estimateTokens, formatThinkingDuration } from "../thinking";
import { formatToolDuration, summarizeTool } from "../tool-summary";
import { currentTurnUsage, formatTurnUsageLabel } from "../turn-usage";
import {
  groupTranscript,
  summarizeActivity,
  type ActivityGroup,
  type TranscriptGroup,
} from "../transcript-groups";
import {
  formatMessageFullTime,
  formatRelativeTime,
  formatUsageLabel,
  formatUsageTitle,
  hasTokenUsage,
} from "../format";
import { splitTextAttachments } from "../text-attachments";
import { pinnedPushOffset } from "../sticky-push";
import { canOfferMessageActions, canSubmitMessageEdit, rewindCheckboxState } from "../message-actions";
import { Lightbox, Menu, type LightboxImage } from "../ui";
import { useNow } from "../useNow";
import { subagentMetrics, subagentStats } from "../subagent-meta";
import { stripAgentTag } from "../workflow-progress";

/* react-markdown/remark-gfm 是首包的大头，且只有对话页才会用到，因此拆成
   按需加载的 chunk（Markdown 的具名导出需要包一层 default）。 */
const LazyMarkdown = lazy(() =>
  import("../Markdown").then((module) => ({ default: module.Markdown })),
);

/* TaskRail 内部 import 了自己的 CSS；Thread 会被 node:test 直接 import，
   Node 的 tsx 加载器不认识 .css，因此和 Markdown 一样按需加载。 */
const LazyTaskRail = lazy(() =>
  import("./TaskRail").then((module) => ({ default: module.TaskRail })),
);

/* 历史消息一页的条数：首屏只挂最近一页，更早的消息按页往前展开。 */
export const HISTORY_PAGE = 200;

/**
 * 计算还要显示多少条更早的消息。
 *
 * - `historyStart` 是数字（详情帧/翻页片段，含翻到 0 的情况）：保持 remote
 *   模式，隐藏数 = 总数 - 本地已加载条数，渲染全部已加载片段，展开向服务端要一页。
 * - `historyStart` 缺失（完整 GET / 发送响应等）：本地已有完整历史，按 200 条
 *   本地窗口切片，展开继续走本地窗口。
 */
export function resolveHistoryView(
  session: Session,
  visibleCount: number,
): { usingRemoteHistory: boolean; hiddenCount: number; visibleMessages: Transcript[] } {
  const messages = session.messages ?? [];
  // 只有 historyStart 缺失（完整 GET / 发送/停止等响应直接 setSession）才是
  // “本地完整历史”，用本地 200 条窗口。分页翻到 start=0 时 historyStart 是
  // 数字 0，必须继续保持 remote 模式，否则刚加载的历史会被本地窗口重新切掉。
  if (session.historyStart === undefined) {
    const localHiddenCount = Math.max(0, messages.length - visibleCount);
    return {
      usingRemoteHistory: false,
      hiddenCount: localHiddenCount,
      visibleMessages: localHiddenCount > 0 ? messages.slice(localHiddenCount) : messages,
    };
  }
  return {
    usingRemoteHistory: true,
    hiddenCount: Math.max(0, (session.messageCount ?? messages.length) - messages.length),
    visibleMessages: messages,
  };
}

/* 多模型讨论发言的阶段标签；和服务端 discussion.kind 一致。 */
const DISCUSSION_KIND_LABEL: Record<NonNullable<Transcript["discussion"]>["kind"], string> = {
  decompose: "拆分",
  answer: "回答",
  review: "审阅",
  rebuttal: "答辩",
  final: "最终结论",
};

/* 子任务列表默认只展示最近几条；仍在运行的条目始终显示，不受这个窗口限制。 */
const SUBAGENT_RECENT = 5;

/* 展开子任务后，运行中的记录按这个间隔刷新；结束后停止轮询。 */
const SUBAGENT_DETAIL_POLL_MS = 2_000;

/* 详情里的 Markdown 不需要让主对话贴底，共用这个空滚动容器。 */
const NO_SCROLL: RefObject<HTMLDivElement | null> = { current: null };

/* 空历史/分组复用同一个数组，避免没有消息时每帧都生成新的 items/elements。 */
const EMPTY_IMAGES: ImageRef[] = [];
const EMPTY_PENDING_IMAGES: OutgoingImage[] = [];
const EMPTY_GROUPS: TranscriptGroup[] = [];

/* 流式 partial 的 Markdown 重排节流：每 250ms 最多解析一次；结束时立刻用
   完整文本，最后一个增量不会丢。 */
const PARTIAL_RENDER_MS = 250;

/**
 * The conversation transcript: messages, running indicator and subagents. The
 * parent owns the scroll container ref and its onScroll handler so
 * auto-scrolling can stay in the same place as before.
 */
export function Thread({
  session,
  scrollRef,
  onScroll,
  stickRef,
  onLoadEarlier,
  historyLoading = false,
  density = "compact",
  messageBusy = false,
  sending = false,
  continuing = false,
  backgroundBusy = false,
  onRewindMessage,
  onEditMessage,
  onForkMessage,
}: {
  session: Session;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  /** 父组件的“是否自动贴底”意图；Markdown chunk 到位后只在贴底时补一次滚动。 */
  stickRef?: RefObject<boolean>;
  /** 详细：原样平铺每一行；简要：活动组折叠、进行中展开；精简：活动组始终折叠。 */
  density?: Density;
  /** 按 historyStart 向服务端再拉一页更早的历史。 */
  onLoadEarlier?: () => void;
  /** 更早历史正在加载；期间禁用重复点击。 */
  historyLoading?: boolean;
  /** 回滚/编辑重发/分叉进行中；菜单项随之禁用，避免重复触发。 */
  messageBusy?: boolean;
  /** Composer 发送在途（POST/SSE 未确认）；期间隐藏菜单并关闭内联编辑器。 */
  sending?: boolean;
  /** 「继续上次」发送在途；本地 phase 可能仍是 failed/stopped，菜单要一并隐藏。 */
  continuing?: boolean;
  /** 有运行中的后台任务：phase 仍是 completed，但服务端会拒绝回滚/分叉。 */
  backgroundBusy?: boolean;
  /** 回滚到这条用户消息之前（气泡旁的操作面板已经确认，父组件直接执行）。 */
  onRewindMessage: (item: Transcript, files: boolean) => Promise<void>;
  /** 编辑后回滚并重发；返回 true 表示已提交，内联编辑器可以关闭。 */
  onEditMessage: (item: Transcript, text: string, options: EditSendOptions) => Promise<boolean>;
  /** 从这条用户消息分叉新对话（气泡旁的操作面板已经确认）。 */
  onForkMessage: (item: Transcript) => Promise<void>;
}) {
  /* 渲染期校正 state：session.id 变化时立即回到最近一页，避免先按旧会话的
     展开量渲染一帧新会话。 */
  const [historyWindow, setHistoryWindow] = useState({ sessionId: session.id, count: HISTORY_PAGE });
  if (historyWindow.sessionId !== session.id) {
    setHistoryWindow({ sessionId: session.id, count: HISTORY_PAGE });
  }
  const visibleCount = historyWindow.sessionId === session.id ? historyWindow.count : HISTORY_PAGE;

  const { usingRemoteHistory, hiddenCount, visibleMessages } = resolveHistoryView(session, visibleCount);

  /* 精简档运行中在底部指示器上显示本轮实时 token；其它密度保持原样。 */
  const turnUsage = useMemo(
    () => (density === "compact" && (session.phase === "queued" || session.phase === "running"))
      ? currentTurnUsage(session.messages ?? [])
      : undefined,
    [density, session.phase, session.messages],
  );

  /* 所有消息共用一次 now，相对时间每分钟更新；避免每条消息各起一个 interval。 */
  const now = useNow(60_000);

  /* 先把可见消息按「用户 / assistant 正文 / 连续工具·思考」分组，再沿用原来的
     “最后一个是 live tail、其余是历史”拆分：分组只在 tail 边界上变化，历史组
     的 item 引用稳定，因此可以像以前一样缓存它们渲染出的 React element 数组。 */
  const groups = useMemo(() => groupTranscript(visibleMessages), [visibleMessages]);
  const historyGroups = groups.length > 0 ? groups.slice(0, -1) : EMPTY_GROUPS;
  const liveGroup = groups.length > 0 ? groups[groups.length - 1] : undefined;

  /* 服务端增量帧只替换变化的尾部对象，历史组的 item 引用不变；缓存历史组渲染出的
     element 数组，key/kind/items 全都等价时直接复用，单个 memo 组件就不会在每个
     token 到来时重新渲染。历史元素和 live 元素作为同一个 .thread 父级下的兄弟渲染
     （key 用 group.key），所以 tail 移入历史时 React 能按 key/type 复用 fiber，
     展开状态、Lightbox 和焦点都不会因跨父节点重挂而丢失。 */
  const rowCache = useRef<RowCache | null>(null);
  const rowContext: RowContext = {
    sessionId: session.id,
    now,
    scrollRef,
    stickRef,
    cwd: session.cwd,
    density,
    phase: session.phase,
    canRewindFiles: session.canRewindFiles === true,
    messageBusy,
    sending,
    continuing,
    backgroundBusy,
    onRewindMessage,
    onEditMessage,
    onForkMessage,
  };
  const cached = rowCache.current;
  const historyUnchanged =
    cached !== null
    && cached.sessionId === session.id
    && cached.now === now
    && cached.scrollRef === scrollRef
    && cached.stickRef === stickRef
    && cached.cwd === session.cwd
    && cached.density === density
    && cached.phase === session.phase
    && cached.canRewindFiles === (session.canRewindFiles === true)
    && cached.messageBusy === messageBusy
    && cached.sending === sending
    && cached.continuing === continuing
    && cached.backgroundBusy === backgroundBusy
    && cached.onRewindMessage === onRewindMessage
    && cached.onEditMessage === onEditMessage
    && cached.onForkMessage === onForkMessage
    && groupsMatch(cached.groups, historyGroups);
  let historyElements: ReactElement[];
  if (cached !== null && historyUnchanged) {
    historyElements = cached.elements;
  } else {
    historyElements = historyGroups.map((group) => renderGroup(group, rowContext));
    rowCache.current = {
      sessionId: session.id,
      now,
      scrollRef,
      stickRef,
      cwd: session.cwd,
      density,
      phase: session.phase,
      canRewindFiles: session.canRewindFiles === true,
      messageBusy,
      sending,
      continuing,
      backgroundBusy,
      onRewindMessage,
      onEditMessage,
      onForkMessage,
      groups: historyGroups,
      elements: historyElements,
    };
  }
  const liveElement = liveGroup ? renderGroup(liveGroup, rowContext) : null;
  /* 每帧只重建这个很短的引用数组；历史 element 本身仍是缓存里的同一批对象。 */
  const rowElements = liveElement ? [...historyElements, liveElement] : historyElements;

  /* 层级吸顶：用户消息固定在记录区顶部，下层的工具行 / 活动组摘要排在它
     下面。用户消息高度随文字、图片和发送状态变化，CSS 里算不出来；滚动时
     找出当前吸住的最后一条用户消息，把高度写进 --pinned-user-h。直接改
     样式而不是 setState，滚动过程中不触发 React 重渲染。
     下一条用户消息升上来时不能让它盖在吸顶气泡上（两层文字会叠成一团），
     而是从气泡下沿把它整条往上顶出去：新气泡越过下沿多少，旧气泡就上移
     多少，到新气泡吸顶时旧气泡刚好让出。同样走内联 transform。 */
  useLayoutEffect(() => {
    const current = scrollRef.current;
    if (!current) return;
    const node: HTMLDivElement = current;
    let frame = 0;
    let observed: HTMLElement | null = null;
    /* 当前被隐藏掉的吸顶消息下标；-2 是「还没算过」的哨兵，保证首帧会把
       上一轮留下的内联 visibility 清掉。 */
    let hiddenBefore = -2;
    /* 当前带着推出位移的那条消息：只有吸顶的这一条会带 transform，下一帧
       测量前先把它还原，换吸顶对象时也不会留下上一次的位移。 */
    let pushedEl: HTMLElement | null = null;
    const resize = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => schedule());

    function measure() {
      frame = 0;
      const paddingTop = Number.parseFloat(getComputedStyle(node).paddingTop) || 0;
      const line = node.getBoundingClientRect().top + node.clientTop + paddingTop;
      const exchanges = node.querySelectorAll<HTMLElement>(":scope > .exchange");
      /* 上一帧写在吸顶气泡上的位移会带进 rect；先清掉再量，否则「吸顶后都停
         在同一条线上」的二分前提会被位移打破。清掉和重新写回在同一帧内完成，
         用户看不到闪动。 */
      if (pushedEl) {
        pushedEl.style.transform = "";
        pushedEl = null;
      }
      /* 用户消息按文档顺序排列，吸顶后 rect.top 都停在同一条线上；二分找
         最后一个停在线上的，也就是当前盖在最上面的那条。 */
      let low = 0;
      let high = exchanges.length - 1;
      let pinnedIndex = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (exchanges[mid].getBoundingClientRect().top <= line + 0.5) {
          pinnedIndex = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      const pinned = pinnedIndex >= 0 ? exchanges[pinnedIndex] : null;
      /* 算出要把吸顶气泡往上顶多少。下一条用户消息不会带位移（位移只写在吸
         顶的那条上），它的 rect.top 就是真实位置；吸顶气泡自己上一帧的位移
         已经在上面清掉，rect.top 也是吸附位置。 */
      const pinnedRect = pinned ? pinned.getBoundingClientRect() : null;
      const following = pinnedIndex >= 0 ? exchanges[pinnedIndex + 1] : undefined;
      const push = pinnedRect
        ? pinnedPushOffset(
            pinnedRect.top,
            pinnedRect.height,
            following ? following.getBoundingClientRect().top : Number.POSITIVE_INFINITY,
          )
        : 0;
      if (pinned && push > 0) {
        pinned.style.transform = `translateY(${-push}px)`;
        pushedEl = pinned;
      }
      /* 后一条消息吸顶后，前面吸过的消息不能再露出来：它们都停在 top:0，
         较早那条比新消息高时，超出的下半截会从新消息下面露出来，看起来像
         好几条同时吸顶。visibility 而非 display，保留它们在文档流里的高度，
         滚动位置不会跳动。 */
      if (pinnedIndex !== hiddenBefore) {
        for (let i = 0; i < exchanges.length; i++) {
          exchanges[i].style.visibility = i < pinnedIndex ? "hidden" : "";
        }
        hiddenBefore = pinnedIndex;
      }
      /* 只观察当前吸住的那条：图片加载、发送状态变化导致的高度变化要重新量。 */
      if (pinned !== observed) {
        if (observed) resize?.unobserve(observed);
        if (pinned) resize?.observe(pinned);
        observed = pinned;
      }
      /* 下层的吸顶行（工具 / 活动组摘要）跟在气泡可见下沿后面：气泡被顶上移
         多少，它们的起点就跟着上移多少。 */
      const visibleHeight = pinnedRect ? Math.max(0, pinnedRect.height - push) : 0;
      const next = `${visibleHeight}px`;
      if (node.style.getPropertyValue("--pinned-user-h") !== next) {
        node.style.setProperty("--pinned-user-h", next);
      }
    }

    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    }

    measure();
    node.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      node.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
      if (observed) resize?.unobserve(observed);
      resize?.disconnect();
      /* 重跑 effect 时新闭包不认识旧的位移，留着会让那一条永久悬空。 */
      if (pushedEl) pushedEl.style.transform = "";
    };
    /* 增删消息（新消息 / 更早历史）、切换展开档（下层高度变了，下一条用户
       消息的位置也变了）后重新量一次并更新观察对象。 */
  }, [scrollRef, session.id, visibleMessages.length, density]);

  function showEarlier() {
    if (usingRemoteHistory) {
      if (!historyLoading) onLoadEarlier?.();
      return;
    }
    setHistoryWindow((current) => ({
      sessionId: session.id,
      count: (current.sessionId === session.id ? current.count : HISTORY_PAGE) + HISTORY_PAGE,
    }));
  }

  return (
    <div className="thread" data-density={density} ref={scrollRef} onScroll={onScroll}>
      {hiddenCount > 0 && (
        <div style={{ display: "flex", justifyContent: "center", padding: "calc(8px * var(--control-scale)) 0" }}>
          <button className="text-btn" type="button" disabled={historyLoading} onClick={showEarlier}>
            {historyLoading
              ? "正在加载更早的消息…"
              : `显示更早的 ${Math.min(HISTORY_PAGE, hiddenCount)} 条`}
          </button>
        </div>
      )}
      {rowElements}
      {(session.phase === "queued" || session.phase === "running") && (
        <div className="loading" role="status" data-density={density}>
          {density === "brief" ? (
            <span className="loading-asterisk" aria-hidden="true">✳</span>
          ) : (
            <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>
          )}
          <span>{session.phase === "queued" ? "排队" : "进行中"}</span>
          {turnUsage && (
            <span
              className="loading-usage"
              aria-live="off"
              title={`本轮已消耗（进行中的输出为估算） · ${formatUsageTitle(turnUsage)}`}
            >
              {formatTurnUsageLabel(turnUsage)}
            </span>
          )}
        </div>
      )}
      {session.subagentTotal > 0 && <SubagentRail session={session} />}
      <TaskRailBoundary>
        <Suspense fallback={null}>
          <LazyTaskRail session={session} />
        </Suspense>
      </TaskRailBoundary>
    </div>
  );
}

/** 编辑重发的三种去向：分叉新会话、当前对话重发、当前对话重发并回滚代码。 */
export interface EditSendOptions {
  fork: boolean;
  files: boolean;
}

interface RowContext {
  sessionId: string;
  now: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickRef?: RefObject<boolean>;
  /** 工具输入里的绝对路径按它换成相对路径（摘要用）；变化会一并让缓存失效。 */
  cwd: string;
  density: Density;
  /** 会话是否仍在跑决定用户消息的操作菜单；phase 变化要让缓存失效。 */
  phase: Session["phase"];
  /** 当前能否回滚文件，决定操作面板里的勾选项是否可用。 */
  canRewindFiles: boolean;
  messageBusy: boolean;
  sending: boolean;
  continuing: boolean;
  backgroundBusy: boolean;
  onRewindMessage: (item: Transcript, files: boolean) => Promise<void>;
  onEditMessage: (item: Transcript, text: string, options: EditSendOptions) => Promise<boolean>;
  onForkMessage: (item: Transcript) => Promise<void>;
}

interface RowCache {
  sessionId: string;
  now: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickRef?: RefObject<boolean>;
  cwd: string;
  density: Density;
  phase: Session["phase"];
  canRewindFiles: boolean;
  messageBusy: boolean;
  sending: boolean;
  continuing: boolean;
  backgroundBusy: boolean;
  onRewindMessage: (item: Transcript, files: boolean) => Promise<void>;
  onEditMessage: (item: Transcript, text: string, options: EditSendOptions) => Promise<boolean>;
  onForkMessage: (item: Transcript) => Promise<void>;
  groups: TranscriptGroup[];
  elements: ReactElement[];
}

/* 判断两组历史是否等价：kind/key 相同、item 引用逐个相同（activity 组比 items，
   其余比单条 item）。groupTranscript 每帧会新建 group 对象，所以这里不能比对象本身。 */
function sameGroup(a: TranscriptGroup, b: TranscriptGroup): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "activity" && b.kind === "activity") {
    if (a.items.length !== b.items.length) return false;
    for (let index = 0; index < a.items.length; index += 1) {
      if (a.items[index] !== b.items[index]) return false;
    }
    return true;
  }
  if (a.kind === "user" && b.kind === "user") return a.item === b.item;
  if (a.kind === "assistant" && b.kind === "assistant") return a.item === b.item;
  return false;
}

function groupsMatch(previous: TranscriptGroup[], next: TranscriptGroup[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (!sameGroup(previous[index], next[index])) return false;
  }
  return true;
}

/**
 * 把一个分组渲染成稳定 key 的元素。历史与 live 共用：tail 移入历史时 key/type
 * 不变，React 会复用原 fiber（展开状态、Lightbox、焦点得以保留）。
 * 详细密度平铺子行；简要密度把相邻的编辑合并成改动卡、其余步骤照常平铺；
 * 精简密度把活动组折成一个可展开的外壳。
 */
function renderGroup(group: TranscriptGroup, ctx: RowContext): ReactElement {
  if (group.kind === "activity") {
    if (ctx.density === "detail") {
      return (
        <Fragment key={group.key}>
          {group.items.map((item) => renderRow(item, ctx))}
        </Fragment>
      );
    }
    if (ctx.density === "brief") return renderBriefActivity(group, ctx);
    return <ActivityGroupRow key={group.key} group={group} ctx={ctx} />;
  }
  if (group.kind === "user") {
    return renderUserRow(group.item, group.key, ctx);
  }
  return (
    <AssistantRow
      key={group.key}
      item={group.item}
      now={ctx.now}
      scrollRef={ctx.scrollRef}
      stickRef={ctx.stickRef}
    />
  );
}

/**
 * 一条消息（只用于活动组内部，或详细密度平铺）：工具行用 summarizeTool 生成
 * 人话摘要，思考行保持折叠。历史工具输出由 ToolRow 的 memo 兜住，不随 token 重算。
 */
function renderRow(item: Transcript, ctx: RowContext): ReactElement | null {
  const variant = ctx.density === "brief" ? "brief" : undefined;
  if (item.role === "tool") {
    return (
      <ToolRow
        key={item.id}
        name={item.toolName || "工具"}
        text={item.text}
        cwd={ctx.cwd}
        tone={item.partial ? "run" : item.toolStatus === "error" ? "bad" : "ok"}
        status={item.toolStatus}
        durationMs={item.durationMs}
        result={item.result}
        sessionId={ctx.sessionId}
        toolUseId={item.toolUseId}
        partial={item.partial}
        variant={variant}
      />
    );
  }
  if (item.kind === "thinking") {
    return item.text ? (
      <ThinkingRow
        key={item.id}
        text={item.text}
        partial={item.partial}
        durationMs={item.durationMs}
        variant={variant}
        scrollRef={ctx.scrollRef}
        stickRef={ctx.stickRef}
      />
    ) : null;
  }
  if (item.role === "user") {
    return renderUserRow(item, item.id, ctx);
  }
  return item.text ? (
    <AssistantRow
      key={item.id}
      item={item}
      now={ctx.now}
      scrollRef={ctx.scrollRef}
      stickRef={ctx.stickRef}
    />
  ) : null;
}

/* 编辑工具的 diff 只跟这条记录的文本和 cwd 有关；按记录对象缓存，流式期间
   后续条目不断变化时，已完成的编辑不会每个 token 重跑一次 LCS。 */
const briefDiffCache = new WeakMap<Transcript, { cwd: string; diff: EditDiff | null }>();

function briefEditDiff(item: Transcript, cwd: string): EditDiff | null {
  if (item.role !== "tool" || item.partial || item.toolStatus === "error") return null;
  if (!isEditTool(item.toolName || "")) return null;
  const cached = briefDiffCache.get(item);
  if (cached && cached.cwd === cwd) return cached.diff;
  const diff = buildEditDiff(item.toolName || "", item.text, cwd);
  briefDiffCache.set(item, { cwd, diff });
  return diff;
}

/**
 * 简要密度的活动组：相邻的编辑（中间没有别的工具/思考）合并成一张改动卡，
 * 其余步骤照原顺序平铺。编辑输入还没收全时解析不出 diff，先按普通工具行
 * 显示，完整后自然变成改动卡。
 */
function renderBriefActivity(group: ActivityGroup, ctx: RowContext): ReactElement {
  const rows: ReactElement[] = [];
  let run: EditDiff[] = [];
  let runKey = "";
  const flush = () => {
    if (run.length === 0) return;
    rows.push(<ChangeCard key={`changes:${runKey}`} diffs={run} />);
    run = [];
  };
  for (const item of group.items) {
    const diff = briefEditDiff(item, ctx.cwd);
    if (diff) {
      if (run.length === 0) runKey = item.id;
      run.push(diff);
      continue;
    }
    flush();
    const row = renderRow(item, ctx);
    if (row) rows.push(row);
  }
  flush();
  return <Fragment key={group.key}>{rows}</Fragment>;
}

/**
 * 精简密度下的活动组：折成一行摘要，点击摘要才展开组内每个工具/思考行。
 * 详细密度平铺、简要密度走改动卡。
 */
function ActivityGroupRow({ group, ctx }: { group: ActivityGroup; ctx: RowContext }) {
  const summary = summarizeActivity(group);
  const [open, setOpen] = useState(false);
  const tone = group.failed ? "bad" : group.active ? "run" : "ok";
  return (
    <details
      className="tool tool-group"
      data-kind="group"
      data-tone={tone}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-name tool-badge">{summary.title}</span>
        {summary.meta && <span className="tool-extra">{summary.meta}</span>}
      </summary>
      {open && (
        <div className="tool-group-body">
          {group.items.map((item) => renderRow(item, ctx))}
        </div>
      )}
    </details>
  );
}

/**
 * 把 partial 文本按固定间隔节流后再交给 Markdown；非流式时直接返回完整文本，
 * 保证完成帧不会被节流推迟、最后一段不会丢。
 */
function useThrottledText(text: string, streaming: boolean): string {
  const [throttled, setThrottled] = useState(text);
  const latest = useRef(text);
  const timer = useRef<number | undefined>(undefined);
  const lastFlush = useRef(0);
  latest.current = text;

  useEffect(() => {
    if (!streaming) {
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      }
      return;
    }
    const wait = PARTIAL_RENDER_MS - (Date.now() - lastFlush.current);
    if (wait <= 0) {
      lastFlush.current = Date.now();
      setThrottled(text);
      return;
    }
    /* 已经有排队的刷新就只更新 latest，等它到点统一取最新文本。 */
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      lastFlush.current = Date.now();
      setThrottled(latest.current);
    }, wait);
  }, [text, streaming]);

  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);

  return streaming ? throttled : text;
}

/** 尚未上传的本地图片直接用 data URL 预览，上传完成后由服务端图片替换。 */
function pendingImageSrc(image: OutgoingImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** 用户消息统一从 RowContext 取操作菜单需要的会话状态和稳定回调。 */
function renderUserRow(item: Transcript, key: string, ctx: RowContext): ReactElement {
  return (
    <UserRow
      key={key}
      item={item}
      sessionId={ctx.sessionId}
      canOffer={canOfferMessageActions(
        { phase: ctx.phase },
        item,
        {
          busy: ctx.messageBusy || ctx.sending || ctx.continuing,
          backgroundBusy: ctx.backgroundBusy,
        },
      )}
      busy={ctx.messageBusy}
      composerSending={ctx.sending}
      continuing={ctx.continuing}
      canRewindFiles={ctx.canRewindFiles}
      onRewind={ctx.onRewindMessage}
      onEdit={ctx.onEditMessage}
      onFork={ctx.onForkMessage}
    />
  );
}

/** 气泡旁的内联确认面板：回滚/分叉/编辑重发的前置选择。 */
type InlinePrompt = "rewind" | "fork" | "edit-send";

/** 编辑重发面板的三个按钮，对应 EditSendOptions 里的 fork/files 两种开关。 */
type EditAction = "fork" | "resend" | "resend-code";

/**
 * 用户消息；图片作为独立缩略图显示在气泡外上方，保留原始链接（新标签/键盘
 * 打开），单击则进共享 Lightbox，不触发气泡的点击编辑。
 * 发送中的消息由本地乐观渲染，带 status = "sending"，在气泡下显示状态。
 * 可回滚的消息点气泡直接进入内联编辑，气泡下方同时保留「⋯」菜单。
 * 回滚/分叉/重发前在气泡旁的内联面板里选择，不弹阻塞式对话框。
 */
const UserRow = memo(function UserRow({
  item,
  sessionId,
  canOffer,
  busy,
  composerSending,
  continuing,
  canRewindFiles,
  onRewind,
  onEdit,
  onFork,
}: {
  item: Transcript;
  sessionId: string;
  canOffer: boolean;
  busy: boolean;
  composerSending: boolean;
  continuing: boolean;
  canRewindFiles: boolean;
  onRewind: (item: Transcript, files: boolean) => Promise<void>;
  onEdit: (item: Transcript, text: string, options: EditSendOptions) => Promise<boolean>;
  onFork: (item: Transcript) => Promise<void>;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(item.text);
  const [submitting, setSubmitting] = useState(false);
  /* 编辑重发面板里正在提交的按钮：只给被点的那一个显示进行中文案。 */
  const [pendingEdit, setPendingEdit] = useState<EditAction | null>(null);
  const [prompt, setPrompt] = useState<InlinePrompt | null>(null);
  const [rewindFiles, setRewindFiles] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const images = item.images ?? EMPTY_IMAGES;
  const pending = item.pendingImages ?? EMPTY_PENDING_IMAGES;
  const sending = item.status === "sending";
  const views = useMemo(
    () => [
      ...images.map((image) => {
        const src = imageUrl(sessionId, image);
        return { key: image.id, src, label: image.name || "图片" };
      }),
      ...pending.map((image, index) => ({
        key: `pending-${index}`,
        src: pendingImageSrc(image),
        label: image.name || `图片 ${images.length + index + 1}`,
      })),
    ],
    [images, pending, sessionId],
  );
  const lightboxImages = useMemo<LightboxImage[]>(
    () => views.map((view) => ({ src: view.src, alt: view.label, href: view.src })),
    [views],
  );
  /* 勾选项文案和禁用状态由服务端算出的 canRewindFiles 决定。 */
  const rewindState = rewindCheckboxState(canRewindFiles);

  /* 进入编辑时把光标放到末尾，长消息也能直接继续输入。 */
  useEffect(() => {
    if (!editing) return;
    const node = editorRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [editing]);

  /* 编辑态点气泡及其操作面板外任意位置直接取消（丢弃草稿），不需要再点
     「取消」按钮。提交中/发送中不响应，避免重发请求被误取消。 */
  useEffect(() => {
    if (!editing) return;
    function onPointerDown(event: PointerEvent) {
      if (submitting || composerSending || continuing) return;
      const target = event.target as Node;
      if (bubbleRef.current?.contains(target) || promptRef.current?.contains(target)) return;
      /* 缩略图在气泡外，点开大图时不能顺带把编辑草稿丢掉。 */
      if (target instanceof Element && target.closest(".msg-images")) return;
      setEditing(false);
      setDraftText(item.text);
      setPrompt(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [editing, submitting, composerSending, continuing, item.text]);

  /* 对话重新变成运行中/有后台任务时收起面板，避免展示一个服务端会拒绝的操作。 */
  useEffect(() => {
    if (!canOffer) setPrompt(null);
  }, [canOffer]);

  /* 内联操作面板不阻塞页面：点面板外或按 Escape 收起，其他区域照常可用。 */
  useEffect(() => {
    if (!prompt) return;
    function onPointerDown(event: PointerEvent) {
      if (promptRef.current?.contains(event.target as Node)) return;
      setPrompt(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPrompt(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [prompt]);

  /* 非编辑态只显示一行摘要，进入编辑后 textarea 按内容撑到原高度（上限由
     CSS 的 max-height 兜底），一次就能看全整条消息。窗口尺寸变化会改变折行，
    需要重新量。 */
  useLayoutEffect(() => {
    if (!editing) return;
    const node = editorRef.current;
    if (!node) return;
    const fit = () => {
      node.style.height = "auto";
      /* scrollHeight 含 padding 不含边框，+2 补上上下各 1px。 */
      node.style.height = `${node.scrollHeight + 2}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [editing, draftText]);

  /* Composer 发送或「继续上次」在途时关闭编辑器：不能和乐观消息并发。 */
  useEffect(() => {
    if ((!composerSending && !continuing) || !editing) return;
    setEditing(false);
    setDraftText(item.text);
    setPrompt(null);
  }, [composerSending, continuing, editing, item.text]);

  function openPreview(event: ReactMouseEvent<HTMLAnchorElement>, index: number) {
    /* 带修饰键/中键仍然走浏览器默认行为（新标签打开原图）。 */
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setPreview(index);
  }

  function startEdit() {
    if (busy || composerSending || continuing) return;
    setDraftText(item.text);
    setEditing(true);
  }

  /* 点气泡直接进入编辑；图片链接和拖选文字不触发，避免误伤预览/复制。 */
  function onBubbleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (editing || prompt || !canOffer) return;
    if ((event.target as HTMLElement).closest("a, button, textarea, input")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    startEdit();
  }

  function openPrompt(next: InlinePrompt) {
    setRewindFiles(false);
    setPrompt(next);
  }

  function cancelEdit() {
    if (submitting || composerSending || continuing) return;
    setEditing(false);
    setDraftText(item.text);
    setPrompt(null);
  }

  async function confirmRewind() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRewind(item, rewindFiles);
      setPrompt(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmFork() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onFork(item);
      setPrompt(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmEdit(action: EditAction) {
    if (submitting || busy || composerSending || continuing) return;
    /* 纯图片消息允许空文本：服务端用 keepImages 复用原消息的图片。 */
    if (!canSubmitMessageEdit(draftText, images.length)) return;
    setPendingEdit(action);
    setSubmitting(true);
    try {
      /* 请求在父组件里；失败时父组件显示错误，这里保留编辑内容。 */
      const done = await onEdit(item, draftText, {
        fork: action === "fork",
        files: action === "resend-code",
      });
      if (done) {
        setEditing(false);
        setPrompt(null);
      }
    } catch {
      /* 父组件负责展示错误；意外异常也不能让编辑器消失。 */
    } finally {
      setSubmitting(false);
      setPendingEdit(null);
    }
  }

  async function submitEdit() {
    if (submitting || busy || composerSending || continuing) return;
    /* 纯图片消息允许空文本：服务端用 keepImages 复用原消息的图片。 */
    if (!canSubmitMessageEdit(draftText, images.length)) return;
    /* 直接在气泡旁给出三个去向（分叉 / 当前对话 / 当前对话并回滚代码），
       一层就能选定，不再先进「是否分叉」再问「是否回滚代码」。 */
    openPrompt("edit-send");
  }

  function onEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitEdit();
    }
  }

  return (
    <div className="exchange" data-sending={sending ? "true" : undefined}>
      {/* 图片是独立缩略图，放在气泡外上方，不进气泡的滚动区和点击编辑区域。 */}
      {views.length > 0 && (
        <div className="msg-images">
          {views.map((image, index) => (
            <a
              key={image.key}
              className="msg-image"
              href={image.src}
              target="_blank"
              rel="noreferrer"
              aria-label={`查看图片：${image.label}`}
              aria-haspopup="dialog"
              onClick={(event) => openPreview(event, index)}
            >
              <img src={image.src} alt={image.label} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {/* 纯图片消息没有正文时不渲染空气泡；编辑态仍要显示编辑器。 */}
      {(editing || item.text) && (
        <div
          ref={bubbleRef}
          className={editing ? "user-msg user-msg-editing" : "user-msg"}
          aria-busy={sending || undefined}
          data-editable={canOffer && !editing && !prompt ? "true" : undefined}
          title={canOffer && !editing && !prompt ? "点击编辑这条消息" : undefined}
          onClick={onBubbleClick}
        >
          {editing ? (
            <div className="msg-editor">
              <textarea
                ref={editorRef}
                className="msg-editor-input"
                value={draftText}
                rows={Math.min(10, Math.max(2, draftText.split("\n").length))}
                aria-label="编辑消息内容"
                disabled={submitting || composerSending || continuing}
                onChange={(event) => setDraftText(event.target.value)}
                onKeyDown={onEditorKeyDown}
              />
              <div className="msg-editor-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    submitting || busy || composerSending || continuing
                    || !canSubmitMessageEdit(draftText, images.length)
                  }
                  onClick={() => void submitEdit()}
                >
                  {submitting ? "重发中…" : "保存并重发"}
                </button>
              </div>
            </div>
          ) : (
            <UserMessageText text={item.text} />
          )}
        </div>
      )}
      {prompt && (
        <div className="msg-prompt" ref={promptRef} role="group" aria-label="消息操作">
          <button
            type="button"
            className="msg-prompt-close"
            aria-label="关闭"
            onClick={() => setPrompt(null)}
          >
            ×
          </button>
          {prompt === "rewind" && (
            <>
              <span className="msg-prompt-text">回滚到这条消息之前？删除这条及之后的记录。</span>
              <label className="msg-prompt-check">
                <input
                  type="checkbox"
                  checked={rewindFiles}
                  disabled={rewindState.disabled || submitting}
                  onChange={(event) => setRewindFiles(event.target.checked)}
                />
                同时回滚代码改动
              </label>
              {rewindState.disabled && <span className="msg-prompt-hint">{rewindState.description}</span>}
              <div className="msg-prompt-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={submitting}
                  onClick={() => void confirmRewind()}
                >
                  {submitting ? "回滚中…" : "回滚"}
                </button>
              </div>
            </>
          )}
          {prompt === "fork" && (
            <>
              <span className="msg-prompt-text">分叉新对话？保留这条及之前的内容，父对话不变。</span>
              <div className="msg-prompt-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={submitting}
                  onClick={() => void confirmFork()}
                >
                  {submitting ? "分叉中…" : "分叉"}
                </button>
              </div>
            </>
          )}
          {prompt === "edit-send" && (
            <>
              <span className="msg-prompt-text">
                编辑后重新发送：分叉会新建独立对话、原对话不变；后两项回滚这条消息及之后的记录再发送，
                原消息里的图片会保留。
              </span>
              <div className="msg-prompt-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={submitting || busy}
                  onClick={() => void confirmEdit("fork")}
                >
                  {pendingEdit === "fork" ? "处理中…" : "分叉新会话"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={submitting || busy}
                  onClick={() => void confirmEdit("resend")}
                >
                  {pendingEdit === "resend" ? "重发中…" : "当前对话重发"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={submitting || busy || rewindState.disabled}
                  onClick={() => void confirmEdit("resend-code")}
                >
                  {pendingEdit === "resend-code" ? "重发中…" : "回滚代码并重发"}
                </button>
              </div>
              {rewindState.disabled && <span className="msg-prompt-hint">{rewindState.description}</span>}
            </>
          )}
        </div>
      )}
      {canOffer && !editing && !prompt && (
        <div className="user-actions">
          <Menu
            label="⋯"
            ariaLabel="消息操作"
            title="消息操作"
            align="left"
            className="user-actions-menu"
            buttonClassName="text-btn user-actions-trigger"
            disabled={busy}
            items={[
              {
                id: "rewind",
                label: "回滚到这条消息之前",
                onSelect: () => openPrompt("rewind"),
                disabled: busy,
              },
              {
                id: "edit",
                label: "编辑并重新发送",
                onSelect: startEdit,
                disabled: busy,
              },
              {
                id: "fork",
                label: "分叉新对话",
                onSelect: () => openPrompt("fork"),
                disabled: busy,
              },
            ]}
          />
        </div>
      )}
      {sending && (
        <span className="msg-status" role="status">
          <span className="msg-status-dot" aria-hidden="true" />
          发送中…
        </span>
      )}
      {preview !== null && lightboxImages.length > 0 && (
        <Lightbox
          images={lightboxImages}
          index={preview}
          onIndexChange={setPreview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
});

/** assistant 正文；历史项与 live tail 共用，partial 时走节流后的 Markdown。 */
const AssistantRow = memo(function AssistantRow({
  item,
  now,
  scrollRef,
  stickRef,
}: {
  item: Transcript;
  now: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickRef?: RefObject<boolean>;
}) {
  const text = useThrottledText(item.text, Boolean(item.partial));
  return (
    <div className="assistant">
      {item.speaker && item.discussion && (
        <div className="discussion-speaker">
          <span className="discussion-speaker-name">{item.speaker}</span>
          {item.discussion.subtask && (
            <span className="discussion-speaker-subtask" title={item.discussion.subtask.title}>
              子任务 {item.discussion.subtask.index}
            </span>
          )}
          {item.discussion.integration && (
            <span className="discussion-speaker-subtask">集成</span>
          )}
          <span className="discussion-speaker-kind">{DISCUSSION_KIND_LABEL[item.discussion.kind]}</span>
          {item.discussion.round > 1 && (
            <span className="discussion-speaker-round">第 {item.discussion.round} 轮</span>
          )}
        </div>
      )}
      <MarkdownBody text={text} scrollRef={scrollRef} stickRef={stickRef} />
      {item.partial ? (
        <span className="caret" />
      ) : item.role === "assistant" ? (
        <MessageMeta at={item.at} usage={item.usage} now={now} />
      ) : null}
    </div>
  );
});

/** 用户消息里的文本附件块只显示文件名，不把整段文件内容铺在气泡里。
 *  流式刷新时历史消息文本不变，memo 让 splitTextAttachments 不必每帧重跑。 */
const UserMessageText = memo(function UserMessageText({ text }: { text: string }) {
  const { text: visible, files } = splitTextAttachments(text);
  return (
    <>
      {files.length > 0 && (
        <span className="user-attachments">
          附件 ×{files.length}：{files.join("、")}
        </span>
      )}
      {/* 非编辑态由 CSS 压成一行，悬停时用 title 看全文。 */}
      {visible && <span className="user-text" title={visible}>{visible}</span>}
    </>
  );
});

/* assistant 正文下方的一行元信息：相对时间 + 这次回答消耗的 token。
   流式过程中（partial）不显示，完成后再出现。 */
const MessageMeta = memo(function MessageMeta({
  at,
  usage,
  now,
}: {
  at?: string;
  usage?: TokenUsage;
  now: number;
}) {
  const clock = formatRelativeTime(at, now);
  const full = formatMessageFullTime(at);
  const showUsage = hasTokenUsage(usage);
  if (!clock && !showUsage) return null;
  return (
    <div className="msg-meta">
      {clock && (
        <time dateTime={at} title={full}>
          {clock}
        </time>
      )}
      {showUsage && (
        <span title={formatUsageTitle(usage)}>{formatUsageLabel(usage)}</span>
      )}
    </div>
  );
});

/* TaskRail chunk 加载失败时静默降级，不让整段对话被错误边界带走。 */
class TaskRailBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    console.error("后台任务栏加载失败", error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/* chunk 加载失败时退回纯文本，避免 React.lazy 的 rejection 卸载整棵页面。 */
class MarkdownBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error): void {
    console.error("Markdown 加载失败，退回纯文本", error);
  }
  render() {
    if (this.state.failed) return <div className="md md-pending">{this.props.text}</div>;
    return this.props.children;
  }
}

/* 每条消息各自一层 Suspense：用户消息、工具行不等待 markdown chunk；
   fallback 直接显示原文，不是空白。 */
function MarkdownBody({ text, scrollRef, stickRef }: {
  text: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickRef?: RefObject<boolean>;
}) {
  return (
    <MarkdownBoundary text={text}>
      <Suspense fallback={<div className="md md-pending">{text}</div>}>
        <LoadedMarkdown text={text} scrollRef={scrollRef} stickRef={stickRef} />
      </Suspense>
    </MarkdownBoundary>
  );
}

/* 占位切到排版结果后高度会变；用父组件的贴底意图判断，避免在替换后才测量导致永远不贴底。 */
function LoadedMarkdown({ text, scrollRef, stickRef }: {
  text: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  stickRef?: RefObject<boolean>;
}) {
  useLayoutEffect(() => {
    if (!stickRef?.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [scrollRef, stickRef]);
  return <LazyMarkdown text={text} />;
}

/* 思考一律默认折叠在“思考”条目里，点击摘要才展开；流式过程中也保持折叠，
   完整内容到达时服务端复用同一条记录，展开状态不会被重置。
   简要档显示 Cursor 风格的「思考中… N tokens」/「思考了 Ns」。 */
const ThinkingRow = memo(function ThinkingRow({
  text,
  partial,
  durationMs,
  variant,
  scrollRef,
  stickRef,
}: {
  text: string;
  partial?: boolean;
  durationMs?: number;
  variant?: "brief";
  scrollRef: RefObject<HTMLDivElement | null>;
  stickRef?: RefObject<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const extra = variant === "brief"
    ? partial
      ? `思考中… ${estimateTokens(text)} tokens`
      : durationMs !== undefined
        ? `思考了 ${formatThinkingDuration(durationMs)}`
        : "思考"
    : partial ? "进行中" : preview(text);
  return (
    <details
      className="tool thinking"
      data-kind="thinking"
      data-tone={partial ? "run" : undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-name tool-badge">思考</span>
        <span className="tool-extra">{extra}</span>
      </summary>
      {open && (
        <div className="thinking-body" tabIndex={0}>
          {partial ? (
            <div className="md md-pending">{text}</div>
          ) : (
            <MarkdownBody text={text} scrollRef={scrollRef} stickRef={stickRef} />
          )}
        </div>
      )}
    </details>
  );
});

/* 能 JSON.parse 就按缩进重排输入（工具输入通常是压缩 JSON），否则原样显示。 */
function formatToolInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/* 行内 diff：只渲染已经算好的行，解析和 LCS 都在调用方的 useMemo / 缓存里。 */
const EditDiffBody = memo(function EditDiffBody({
  lines,
  truncated,
}: {
  lines: DiffLine[];
  truncated: boolean;
}) {
  return (
    <div className="edit-diff">
      {lines.map((line, index) =>
        line.kind === "hunk" ? (
          <div className="edit-diff-hunk" key={index}>{line.text}</div>
        ) : (
          <div className="edit-diff-line" data-kind={line.kind} key={index}>
            <span className="diff-mark" aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            <span className="diff-text">{line.text || " "}</span>
          </div>
        ),
      )}
      {truncated && <div className="edit-diff-hunk">… diff 已截断</div>}
    </div>
  );
});

/**
 * 简要档的代码改动卡：一段连续编辑合并成一张卡，按文件列出路径、增删行数
 * 和绿红行内 diff。单文件时标题就是文件名，多文件时标题是汇总、卡内分块。
 * 默认展开；点标题可以收起，长 diff 单文件内部滚动。
 */
const ChangeCard = memo(function ChangeCard({ diffs }: { diffs: EditDiff[] }) {
  const files = useMemo(() => mergeChanges(diffs), [diffs]);
  const [open, setOpen] = useState(true);
  const single = files.length === 1 ? files[0] : null;
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return (
    <details
      className="change-card"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {single ? (
          <span className="change-card-path" title={single.path}>
            {single.path || "改动"}
          </span>
        ) : (
          <>
            <span className="change-card-title">代码变更</span>
            <span className="change-card-count">{files.length} 个文件</span>
          </>
        )}
        {single && single.edits > 1 && (
          <span className="change-card-count">{single.edits} 处</span>
        )}
        <span
          className="diff-stats"
          title={`新增 ${added} 行，删除 ${removed} 行`}
        >
          {added > 0 && <span className="diff-add">+{added}</span>}
          {removed > 0 && <span className="diff-del">−{removed}</span>}
        </span>
      </summary>
      {open && (single ? (
        <EditDiffBody lines={single.lines} truncated={single.truncated} />
      ) : (
        <div className="change-card-body">
          {files.map((file, index) => (
            <div className="change-file" key={`${file.path}-${index}`}>
              <div className="change-file-head">
                <span className="change-file-path" title={file.path}>
                  {file.path || "改动"}
                </span>
                {file.edits > 1 && <span className="change-file-edits">{file.edits} 处</span>}
                <span
                  className="diff-stats"
                  title={`新增 ${file.added} 行，删除 ${file.removed} 行`}
                >
                  {file.added > 0 && <span className="diff-add">+{file.added}</span>}
                  {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
                </span>
              </div>
              <EditDiffBody lines={file.lines} truncated={file.truncated} />
            </div>
          ))}
        </div>
      ))}
    </details>
  );
});

/* 每来一次流式增量，历史消息的 props 通常不变；memo 让工具输出（尤其是
   大 diff）不必跟着整段对话重新 reconcile。摘要（summarizeTool）在组件内部
   用 useMemo 算，历史工具行不会随每个 token 重算。 */
const ToolRow = memo(function ToolRow({
  name,
  kind = "tool",
  extra: extraProp,
  text,
  tone,
  status,
  durationMs,
  result,
  cwd,
  patch,
  onToggle,
  sessionId,
  toolUseId,
  partial,
  variant,
}: {
  name: string;
  /** data-kind：普通工具 / Diff / 子任务，保持三类行原有的展开行为。 */
  kind?: "tool" | "diff" | "subagent";
  /** 显式摘要（Diff/子任务用）；不传时用 summarizeTool 生成人话摘要。 */
  extra?: string;
  text: string;
  tone?: string;
  /** 工具结果状态，写到 data-status 供样式区分成功/失败。 */
  status?: "ok" | "error";
  durationMs?: number;
  /** 工具结果正文，展开后显示在输入下方。 */
  result?: string;
  /** 摘要里把绝对路径换成相对路径用。 */
  cwd?: string;
  patch?: string;
  /** 展开/收起时通知父级（Diff 行用它懒加载并按展开状态刷新）。 */
  onToggle?: (open: boolean) => void;
  /** 当前会话 id；Bash 行“转到后台”需要。 */
  sessionId?: string;
  /** SDK 的 tool_use id；只有正在跑的前台 Bash 行才有。 */
  toolUseId?: string;
  /** 流式输入阶段不提供“转到后台”。 */
  partial?: boolean;
  /** 简要档：编辑工具（完整后由改动卡接管）的流式行默认展开。 */
  variant?: "brief";
}) {
  /* 折叠时只保留 summary；正文和 patch 展开后才挂载，避免历史里大量工具输出
     和大 diff 占 DOM。展开仍是 <details> 的原生交互，本地 state 只负责同步。
     简要档里完整的编辑已经合并成改动卡，走到这里的编辑只剩流式输入阶段，
     默认展开让用户能看到正在写入的输入。 */
  const [open, setOpen] = useState(() => variant === "brief" && isEditTool(name));
  /* 前台 Bash 尚未返回结果时允许一键转到后台；成功后由 SSE 带来任务栏。 */
  const [background, setBackground] = useState<{
    state: "idle" | "pending" | "done" | "failed";
    error?: string;
  }>({ state: "idle" });
  const extra = useMemo(
    () => extraProp ?? summarizeTool(name, text, cwd),
    [extraProp, name, text, cwd],
  );
  const duration = formatToolDuration(durationMs);
  const canBackground = name === "Bash"
    && Boolean(toolUseId)
    && status === undefined
    && result === undefined
    && !partial;

  async function handleBackground(event: ReactMouseEvent<HTMLButtonElement>) {
    /* summary 里的按钮：阻止默认行为，避免点一下把工具行展开。 */
    event.preventDefault();
    event.stopPropagation();
    if (!canBackground || !sessionId || !toolUseId) return;
    if (background.state === "pending" || background.state === "done") return;
    setBackground({ state: "pending" });
    try {
      const result = await backgroundTask(sessionId, toolUseId);
      if (!result.backgrounded) {
        /* SDK 没真正转后台（例如命令已结束），按失败处理并允许重试。 */
        setBackground({ state: "failed", error: "命令已结束或不在前台运行，无法转入后台" });
        return;
      }
      setBackground({ state: "done" });
    } catch (error) {
      setBackground({
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <details
      className="tool"
      data-kind={kind}
      data-tone={tone}
      data-status={status}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        onToggle?.(next);
      }}
    >
      <summary>
        <span className="tool-name tool-badge">{name}</span>
        {extra && <span className="tool-extra">{extra}</span>}
        {duration && <span className="tool-duration">{duration}</span>}
        {canBackground && (
          <button
            className="tool-bg-btn"
            type="button"
            /* 有耗时时它已经靠 margin-left:auto 推到了右侧，按钮直接跟在后面。 */
            style={duration ? undefined : { marginLeft: "auto" }}
            disabled={background.state === "pending" || background.state === "done"}
            title={background.state === "failed" ? background.error : undefined}
            onClick={handleBackground}
          >
            {background.state === "pending"
              ? "转后台中…"
              : background.state === "done"
                ? "已转到后台"
                : background.state === "failed"
                  ? "无法转到后台"
                  : "转到后台"}
          </button>
        )}
      </summary>
      {open && (
        <>
          <pre className="tool-body">{formatToolInput(text)}</pre>
          {result && <pre className="tool-body tool-result">{result}</pre>}
          {patch && <Patch text={patch} />}
        </>
      )}
    </details>
  );
});

/**
 * 输入框上方的常驻 Diff 面板。
 *
 * 从记录区底部挪出来固定在工作流/子任务进度条之下、排队消息之上，翻看旧
 * 消息时也能直接展开当前改动。懒加载仍由父组件驱动：第一次展开触发
 * onToggle(true)，轮末刷新按展开状态由父组件重新拉取。
 */
export function DiffDock({
  diff,
  patch,
  cwd,
  loaded = false,
  loading = false,
  onToggle,
}: {
  diff: string;
  patch: string;
  cwd: string;
  /** diff 是否已经加载过；未加载时只显示占位，展开才触发加载。 */
  loaded?: boolean;
  loading?: boolean;
  /** 展开/收起时通知父级，父级据此懒加载并在轮末刷新。 */
  onToggle?: (open: boolean) => void;
}) {
  /* diff 可能很大；每来一个流式 token 都 trim/拼接整段字符串很浪费，
     只依赖 diff 本身和 cwd 缓存结果。 */
  const info = useMemo(() => {
    const text = diff.trim();
    return text
      ? { summary: preview(text), body: `${cwd}\n${text}` }
      : { summary: "没有改动", body: "没有改动" };
  }, [diff, cwd]);

  return (
    <div className="diff-dock">
      <ToolRow
        name="Diff"
        kind="diff"
        extra={loading ? "读取中…" : loaded ? info.summary : "展开查看"}
        text={loading ? "正在读取改动…" : loaded ? info.body : "展开后读取改动"}
        tone={patch ? "ok" : undefined}
        patch={patch}
        onToggle={onToggle}
      />
    </div>
  );
}

/* 子任务区域默认收起，只显示完成数/总数；点开后先给最近几条，更早的再单独展开。
   仍在运行的条目在展开后始终显示，避免活跃任务被窗口截掉。 */
function SubagentRail({ session }: { session: Session }) {
  const agents = session.subagents;
  /* 有子任务在跑时每秒刷新一次，让行内的运行时长和 token 数持续走动。 */
  const now = useNow(agents.some((agent) => agent.status === "running") ? 1_000 : 60_000);
  const bodyId = useId();
  /* 与历史消息一样在渲染期校正：切换会话时立即回到收起状态。 */
  const [railWindow, setRailWindow] = useState({ sessionId: session.id, open: false, showAll: false });
  if (railWindow.sessionId !== session.id) {
    setRailWindow({ sessionId: session.id, open: false, showAll: false });
  }
  const open = railWindow.sessionId === session.id ? railWindow.open : false;
  const showAll = railWindow.sessionId === session.id ? railWindow.showAll : false;

  const keep = new Set([
    ...agents.slice(-SUBAGENT_RECENT),
    ...agents.filter((agent) => agent.status === "running"),
  ]);
  const recent = agents.filter((agent) => keep.has(agent));
  const visible = showAll ? agents : recent;
  const hidden = agents.length - recent.length;

  function toggleOpen() {
    setRailWindow({ sessionId: session.id, open: !open, showAll: false });
  }

  return (
    <div className="rail">
      <button
        className="rail-label rail-summary"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={toggleOpen}
      >
        <span>子任务 {session.subagentDone}/{session.subagentTotal}</span>
        <svg className="rail-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
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
        <div className="rail-body" id={bodyId}>
          {visible.map((agent) => (
            <SubagentRow key={agent.taskId} agent={agent} now={now} sessionId={session.id} />
          ))}
          {hidden > 0 && (
            <button
              className="text-btn rail-toggle"
              type="button"
              onClick={() => setRailWindow({ sessionId: session.id, open: true, showAll: !showAll })}
            >
              {showAll ? "只看最近的" : `显示更早的 ${hidden} 个`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentRow({ agent, now, sessionId }: { agent: Subagent; now: number; sessionId: string }) {
  const tone = agent.status === "completed" ? "ok" : agent.status === "failed" ? "bad" : agent.status === "running" ? "run" : "queue";
  const extra = [SUBAGENT_LABEL[agent.status], agent.lastToolName].filter(Boolean).join(" · ");
  /* 工作流子任务的 description 带 `[wf:...]` 进度标签，这里只显示标题。 */
  const name = stripAgentTag(agent.description);
  /* 折叠和展开都显示 token 量和运行时间：折叠行放紧凑指标，展开后再给完整明细。 */
  const metrics = subagentMetrics(agent, now);
  const stats = subagentStats(agent, now);
  const [open, setOpen] = useState(false);
  return (
    <details
      className="tool subagent"
      data-kind="subagent"
      data-tone={tone}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-name tool-badge">{name}</span>
        {extra && <span className="tool-extra">{extra}</span>}
        {metrics && <span className="subagent-metrics">{metrics}</span>}
      </summary>
      {open && (
        <div className="subagent-detail">
          {stats.length > 0 && <div className="subagent-stats">{stats.join(" · ")}</div>}
          {agent.summary && <div className="subagent-summary">{agent.summary}</div>}
          <SubagentTranscriptView
            sessionId={sessionId}
            taskId={agent.taskId}
            running={agent.status === "running"}
          />
        </div>
      )}
    </details>
  );
}

interface SubagentTranscriptState {
  sessionId: string;
  taskId: string;
  status: "loading" | "ready" | "missing" | "error";
  entries: SubagentTranscriptEntry[];
  truncated: boolean;
  error?: string;
}

/**
 * 子任务的完整记录：展开时才读取，运行中按固定间隔轮询。
 *
 * 记录来自 SDK 写在 ~/.claude 下的 sidechain transcript，服务端只返回尾部
 * 最近一部分。进程刚启动或旧会话被清理时读不到，这两种情况都安静降级。
 */
const SubagentTranscriptView = memo(function SubagentTranscriptView({
  sessionId,
  taskId,
  running,
}: {
  sessionId: string;
  taskId: string;
  running: boolean;
}) {
  const [state, setState] = useState<SubagentTranscriptState>({
    sessionId,
    taskId,
    status: "loading",
    entries: [],
    truncated: false,
  });
  /* 切换会话/子任务时渲染期先回到加载态，避免闪一帧上一条记录。 */
  const current = state.sessionId === sessionId && state.taskId === taskId
    ? state
    : { status: "loading" as const, entries: [], truncated: false, error: undefined };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | undefined;

    const load = async (): Promise<void> => {
      try {
        const data = await getSubagentTranscript(sessionId, taskId, controller.signal);
        if (cancelled) return;
        setState({
          sessionId,
          taskId,
          status: "ready",
          entries: data.entries,
          truncated: data.truncated,
        });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const missing = (error as RequestError | undefined)?.status === 404;
        setState({
          sessionId,
          taskId,
          status: missing ? "missing" : "error",
          entries: [],
          truncated: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      /* 运行中记录还会继续写；结束后再拉一次就停。 */
      if (running && !cancelled) {
        timer = window.setTimeout(() => { void load(); }, SUBAGENT_DETAIL_POLL_MS);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sessionId, taskId, running]);

  if (current.status === "loading") {
    return <div className="subagent-empty">正在读取子任务记录…</div>;
  }
  if (current.status === "missing") {
    return (
      <div className="subagent-empty">
        {running ? "正在等待子任务记录…" : "没有可读取的子任务记录（可能已被清理）"}
      </div>
    );
  }
  if (current.status === "error") {
    return <div className="subagent-empty subagent-error">读取失败：{current.error}</div>;
  }
  if (current.entries.length === 0) {
    return <div className="subagent-empty">没有可显示的内容</div>;
  }
  return (
    <div className="subagent-transcript">
      {current.entries.map((entry) => (
        <SubagentTranscriptEntryRow key={entry.id} entry={entry} />
      ))}
      {current.truncated && <div className="subagent-empty">仅显示最近的一部分记录</div>}
    </div>
  );
});

const SubagentTranscriptEntryRow = memo(function SubagentTranscriptEntryRow({
  entry,
}: {
  entry: SubagentTranscriptEntry;
}) {
  if (entry.kind === "tool") {
    const status = entry.toolStatus;
    return (
      <ToolRow
        name={entry.toolName || "工具"}
        text={entry.text}
        tone={status === "error" ? "bad" : status === "ok" ? "ok" : "run"}
        status={status}
        result={entry.result}
      />
    );
  }
  if (entry.kind === "thinking") {
    return <ThinkingRow text={entry.text} scrollRef={NO_SCROLL} />;
  }
  if (entry.kind === "prompt") {
    return (
      <div className="subagent-prompt">
        <span className="subagent-label">提示</span>
        <pre>{entry.text}</pre>
      </div>
    );
  }
  return (
    <div className="subagent-text">
      <MarkdownBody text={entry.text} scrollRef={NO_SCROLL} />
    </div>
  );
});

export interface PatchLine {
  text: string;
  kind: "add" | "del" | "";
}

export interface PatchFile {
  name: string;
  added: number;
  removed: number;
  lines: PatchLine[];
}

/** `diff --git a/x b/x` 的显示名；兼容带引号/空格的路径（重命名取目标名）。 */
export function diffFileName(line: string): string {
  const rest = line.slice("diff --git ".length).trim();
  const quoted = /"b\/(.+)"\s*$/.exec(rest);
  if (quoted) return quoted[1];
  const marker = rest.lastIndexOf(" b/");
  return marker >= 0 ? rest.slice(marker + 3) : rest;
}

/**
 * 按 `diff --git` 拆分补丁；没有文件头时整段作为一条。
 *
 * +/- 只在 hunk（遇到 `@@`）之后统计和着色：文件头 `--- a/x` / `+++ b/x`
 * 在首个 hunk 之前，不能仅凭前缀排除，否则内容行本身以 `++`/`--` 开头时
 * （整行 `+++...` / `---...`）会被误当成文件头。
 */
export function splitPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    /* 服务端 patch 会在已暂存/未暂存两段之间插入这一行标签；它不是文件，
       也不能挂在上一段最后一个文件里。 */
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (bare === "已暂存" || bare === "未暂存") {
      current = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = { name: diffFileName(line), added: 0, removed: 0, lines: [] };
      files.push(current);
      inHunk = false;
      current.lines.push({ text: line, kind: "" });
      continue;
    }
    if (!current) {
      current = { name: "", added: 0, removed: 0, lines: [] };
      files.push(current);
    }
    if (line.startsWith("@@")) inHunk = true;
    let kind: PatchLine["kind"] = "";
    if (inHunk) {
      if (line.startsWith("+")) {
        kind = "add";
        current.added += 1;
      } else if (line.startsWith("-")) {
        kind = "del";
        current.removed += 1;
      }
    }
    current.lines.push({ text: line, kind });
  }
  return files;
}

/* diff 可能很大，且按行生成大量节点；文本不变时跳过重渲染。每个文件一个
   details，summary 显示文件名与 +/- 行数；单文件时默认展开。 */
const Patch = memo(function Patch({ text }: { text: string }) {
  const files = useMemo(() => splitPatch(text), [text]);
  return (
    <div className="patch-files">
      {files.map((file, fileIndex) => (
        <details
          className="patch-file"
          key={`${file.name}-${fileIndex}`}
          open={files.length === 1}
        >
          <summary
            className="patch-summary"
            aria-label={`${file.name || "改动"}：新增 ${file.added} 行，删除 ${file.removed} 行`}
          >
            <span className="patch-name">{file.name || "改动"}</span>
            <span className="patch-add">+{file.added}</span>
            <span className="patch-del">-{file.removed}</span>
          </summary>
          <pre className="tool-body patch">
            {file.lines.map((line, index) => (
              <div key={index} className={line.kind || undefined}>{line.text || " "}</div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
});

/** 取第一行非空内容做摘要；用 indexOf 逐行切片，不 split 整段工具输出。 */
export function preview(text: string): string {
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    if (line.trim()) return line.length > 80 ? `${line.slice(0, 80)}…` : line;
    if (newline === -1) break;
    start = newline + 1;
  }
  return "";
}
