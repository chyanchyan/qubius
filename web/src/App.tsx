import {
  Component,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { answerBody } from "./answers";
import { addPending, hasPending, removePending } from "./pending-actions";
import { ARCHIVE_RESTORE_NOTE, deleteDetail } from "./archive-copy";
import { filterArchivedSessions, isPendingCleanup } from "./archive-search";
import { instanceBrand } from "./brand";
import { useAttachments } from "./Attachments";
import {
  EFFORT_DESCRIPTION,
  effortOptionLabel,
  formatMessageFullTime,
} from "./format";
import { Approval } from "./components/Approval";
import { BranchBadge } from "./components/BranchBadge";
import { ChipSelect, type ChipSelectOption } from "./components/ChipSelect";
import { ComposerConfig } from "./components/ComposerConfig";
import { Composer } from "./components/Composer";
import { DiscussionPanel } from "./components/DiscussionPanel";
import { GitPanel } from "./components/GitPanel";
import { MultiModelRun } from "./components/MultiModelRun";
import { ProjectsPage } from "./components/ProjectsPage";
import { SchedulesPanel } from "./components/SchedulesPanel";
import { QueuePanel, SessionActionsMenu, sendContinue, useSessionActions } from "./components/SessionTools";
import { DiffDock, HISTORY_PAGE, Thread } from "./components/Thread";
import { UsagePanel } from "./components/UsagePanel";
import { WorkflowDock } from "./components/WorkflowDock";
import { DENSITY_OPTIONS, useDensity } from "./density";
import { detectWorkflowSkill, WORKFLOW_OPTIONS } from "./workflow-mode";
import { getDeployState } from "./api-deploy";
import { startDiscussion } from "./api-discussion";
import { getMergeStatus, type MergeStatus } from "./api-git";
import { patchSession } from "./api-sessions";
import { projectDraftKey, sessionDraftKey } from "./drafts";
import { useGlobalAttention } from "./global-attention";
import { isTouchPointer } from "./pointer";
import { runMeta } from "./run-meta";
import type { RunSelection } from "./run-selection";
import { mergeTextAttachments } from "./text-attachments";
import {
  beginPendingSession,
  dropMatchedPending,
  type PendingSession,
} from "./pending-session";
import {
  appendOptimistic,
  beginOptimisticSend,
  dropOptimistic,
  reconcileOptimistic,
  type OptimisticSend,
} from "./optimistic";
import {
  canContinue,
  clearAllCandidates,
  pickArchiveTargets,
  pickSelected,
  pruneSelected,
  toggleSelected,
} from "./session-selection";
import {
  FONT_PERCENT_KEY,
  FONT_PERCENT_MAX,
  FONT_PERCENT_MIN,
  fontPercentToScale,
  readStoredFontPercent,
  stepFontPercent,
} from "./text-scale";
import { setBaseTitle } from "./title";
import { useDraftPersistence } from "./useDraftPersistence";
import { useEventStream } from "./useEventStream";
import { ConnectionBanner, ErrorState, InlineLoading, Menu, Notice, PageLoading, useDialogs, type MenuItem } from "./ui";
import { onVisibleViewportChange, useVisibleViewport } from "./viewport";
import {
  answerSession,
  clampMaxConcurrent,
  createSession,
  DEFAULT_MAX_CONCURRENT,
  deleteArchivedSession,
  deleteSession,
  EFFORTS,
  getArchivedSessions,
  getArchiveStatus,
  getDiff,
  getInstance,
  getProjects,
  getSession,
  getSessionMessages,
  getSessions,
  getSettings,
  mergeSessionFrame,
  PERMISSION_LABEL,
  prependHistoryPage,
  PERMISSIONS,
  PHASE_LABEL,
  readApiToken,
  restoreArchivedSession,
  saveProjectPermission,
  sendMessage,
  SETTINGS_SAVED_EVENT,
  startArchiveSweep,
  stopSession,
  UNAUTHORIZED_EVENT,
  writeApiToken,
  type ArchiveStatus,
  type ArchivedSession,
  type DiscussionParticipant,
  type Effort,
  type PermissionLevel,
  type Phase,
  type Project,
  type Session,
  type Settings,
  type Transcript,
  type WorkflowSkill,
} from "./api";
import { forkSession, rewindSession } from "./api-rewind";
import {
  canSubmitMessageEdit,
  hasRunningBackgroundTasks,
  rewindComposerRefill,
} from "./message-actions";

/* 低频页面各自拆成异步 chunk，首屏（项目列表/对话）不必先下载部署与设置。
   默认路由的 ProjectsPage 保持同步，避免打开应用时先闪一个加载占位。 */
const DeployPage = lazy(() =>
  import("./components/DeployPage").then((module) => ({ default: module.DeployPage })),
);
const SettingsPage = lazy(() =>
  import("./components/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);
const OverviewPage = lazy(() =>
  import("./components/OverviewPage").then((module) => ({ default: module.OverviewPage })),
);
const SkillsPage = lazy(() =>
  import("./components/SkillsPage").then((module) => ({ default: module.SkillsPage })),
);
const TerminalPage = lazy(() =>
  import("./components/TerminalPage").then((module) => ({ default: module.TerminalPage })),
);

function RouteFallback() {
  return (
    <section className="page center-note">
      <p className="muted">正在加载</p>
    </section>
  );
}

/** 服务端关闭 terminal（terminal:false / QUBIUS_TERMINAL=0）时的 /terminal 提示页。 */
function TerminalDisabledPage() {
  return (
    <section className="page">
      <h1>命令行</h1>
      <p className="muted">
        当前实例已关闭命令行功能（terminal: false 或 QUBIUS_TERMINAL=0）。
        如需使用，请在服务端配置中开启 terminal 后重启。
      </p>
    </section>
  );
}

/**
 * Route changes move focus to the new page heading so keyboard and screen
 * reader users start at the content instead of the header controls.
 * ProjectsPage owns its h1 and cannot be edited here, so make it focusable
 * at runtime; SettingsPage and the chat title set tabIndex directly.
 *
 * 挂在 Suspense 内部：懒加载页面解析完成、真实内容提交后才挂载并聚焦，
 * 避免首次进入 /overview、/deploy、/settings（含 setupRequired 自动跳转和深链）
 * 时只看到 fallback 而漏掉焦点。
 */
function RouteFocus({
  path,
  focusKey,
}: {
  path: string;
  /** 只在当前渲染页面确实变化时改变；不要传与路由无关的值，否则会抢焦点。 */
  focusKey?: boolean;
}) {
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>(".chat-title, .page h1");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }, [path, focusKey]);
  return null;
}

/**
 * 只包住三个懒加载路由。发布后旧 index.html 引用的 hashed chunk 会 404，
 * lazy 的 rejection 若无人捕获会卸载整个 App（手机上白屏）；这里退化为
 * 可恢复提示，页面框架和导航仍然可用。同步渲染的项目/对话页不经过这个
 * boundary，它们的错误照旧向上冒泡。
 */
class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error("页面资源加载失败，提示用户刷新", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <ErrorState
        message="页面资源已更新，请刷新后继续使用。"
        retryLabel="刷新页面"
        onRetry={() => window.location.reload()}
      />
    );
  }
}

/* SSE 首帧（全量快照）通常远快于此；超过该时间仍没有任何帧才用完整 GET 兜底，
   正常打开详情时只经 SSE 传输一次历史。 */
const SSE_FALLBACK_MS = 2500;

/* 固定选项的下拉内容；模块级常量避免每次渲染重新建数组。 */
const EFFORT_OPTIONS: ChipSelectOption[] = EFFORTS.map((effort) => ({
  value: effort,
  label: effortOptionLabel(effort),
  description: EFFORT_DESCRIPTION[effort],
}));

const PERMISSION_OPTIONS: ChipSelectOption[] = PERMISSIONS.map((permission) => ({
  value: permission,
  label: PERMISSION_LABEL[permission],
}));

/* Text size is a percentage of the normal 13px root size. The header buttons
   step it up and down by 10% at a time (holding one keeps stepping until it
   hits the bound), and the reset button returns to 100%. */
function useFontPercent() {
  const [percent, setPercent] = useState(() => readStoredFontPercent());
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--font-scale", String(fontPercentToScale(percent)));
    try {
      window.localStorage.setItem(FONT_PERCENT_KEY, String(percent));
    } catch {
      // Ignore storage failures; the size still applies for this session.
    }
  }, [percent]);
  return [percent, setPercent] as const;
}

function FontStepButton({
  symbol,
  label,
  disabled,
  onStep,
}: {
  symbol: string;
  label: string;
  disabled: boolean;
  onStep: () => void;
}) {
  const holdDelay = useRef(0);
  const holdTimer = useRef(0);
  function stop() {
    window.clearTimeout(holdDelay.current);
    window.clearInterval(holdTimer.current);
    holdDelay.current = 0;
    holdTimer.current = 0;
  }
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      className="nav-btn font-btn"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onStep}
      onPointerDown={() => {
        stop();
        holdDelay.current = window.setTimeout(() => {
          holdTimer.current = window.setInterval(onStep, 90);
        }, 400);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {symbol}
    </button>
  );
}

/**
 * 顶栏左上角：所有对话里正在运行的 agent 总数（主 agent + 子 agent）/ 设置里的上限，
 * 右侧是全部 agent 当前输出速度的合计（tokens/s，按流式增量估算）；空闲时隐藏。
 */
function AgentBadge({ running, limit, speed }: { running: number; limit: number; speed: number }) {
  const label = speed > 0
    ? `运行中的 agent ${running}，上限 ${limit}，当前输出速度 ${speed} token/s`
    : `运行中的 agent ${running}，上限 ${limit}`;
  return (
    <span
      className="agent-badge"
      data-over={running > limit || undefined}
      title={label}
      aria-label={label}
    >
      <span className="agent-badge-label">agent</span>
      <span className="agent-badge-count">{running}/{limit}</span>
      {speed > 0 && <span className="agent-badge-speed" aria-hidden="true">{speed} tok/s</span>}
    </span>
  );
}

/**
 * 服务端启用访问令牌时，任何请求收到 401 都会广播 qubius:unauthorized。
 * 保存后整页刷新，让 SSE 等已经失败的连接用新令牌重新建立。
 */
function TokenPrompt({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState(() => readApiToken());
  /** 自动生成的令牌在数据目录的 auth-token；健康检查只返回路径，不返回令牌。 */
  const [tokenFile, setTokenFile] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => response.json())
      .then((data: { authTokenFile?: unknown }) => {
        if (!cancelled && typeof data.authTokenFile === "string") setTokenFile(data.authTokenFile);
      })
      .catch(() => {
        // 健康检查失败不影响手动输入令牌。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // 按钮在空值时已禁用；这里再挡一次隐式提交（例如回车）。
    if (!value.trim()) return;
    writeApiToken(value);
    window.location.reload();
  }
  return createPortal(
    <div className="dialog-backdrop">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-prompt-title"
        onSubmit={onSubmit}
      >
        <h2 className="dialog-title" id="token-prompt-title">需要访问令牌</h2>
        <p className="dialog-description">
          服务端启用了访问令牌（auth / QUBIUS_AUTH_TOKEN），请输入后继续。
        </p>
        {tokenFile && (
          <p className="dialog-description mono">令牌文件：{tokenFile}</p>
        )}
        <label className="field dialog-field">
          <span>访问令牌</span>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            placeholder="粘贴访问令牌"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>稍后</button>
          <button type="submit" className="btn-primary" disabled={!value.trim()}>保存并重试</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function App() {
  useVisibleViewport();
  const [fontPercent, setFontPercent] = useFontPercent();
  /* 字号放大后顶栏会明显变宽，和窄屏一样把次要入口收进「更多」。 */
  const compact = fontPercent > 100;
  const [path, setPath] = useState(window.location.pathname);
  /* 全局订阅一次，badge 和标签页标题在项目/对话/总览页都一致。 */
  const attention = useGlobalAttention();
  /* 令牌不对时任何请求都会广播 401；布尔 state 天然去重，并发请求只弹一个框。 */
  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => {
    function onUnauthorized() {
      setNeedsToken(true);
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);
  /* 并发上限来自设置；顶栏的 agent 上限共用这个值。设置页保存后通过事件即时同步。 */
  const [sessionLimit, setSessionLimit] = useState(DEFAULT_MAX_CONCURRENT);
  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((data) => {
        if (!cancelled) setSessionLimit(clampMaxConcurrent(data.maxConcurrent));
      })
      .catch(() => {
        // 设置读取失败时保留默认值，不影响顶栏显示。
      });
    function onSaved(event: Event) {
      const detail = (event as CustomEvent<Partial<Settings>>).detail;
      if (detail) setSessionLimit(clampMaxConcurrent(detail.maxConcurrent));
    }
    window.addEventListener(SETTINGS_SAVED_EVENT, onSaved);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_SAVED_EVENT, onSaved);
    };
  }, []);
  /* 命令行页的项目上下文放在 query（/terminal?project=<id>）里：
     从项目页点「命令行」时据此让 PTY 在项目仓库路径下启动。 */
  const [terminalProject, setTerminalProject] = useState(
    () => new URLSearchParams(window.location.search).get("project") ?? "",
  );
  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
      setTerminalProject(new URLSearchParams(window.location.search).get("project") ?? "");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    window.history.pushState({}, "", to);
    // 路由匹配只看 pathname；query 里的 project 单独保存给命令行页。
    const url = new URL(to, window.location.origin);
    setPath(url.pathname);
    setTerminalProject(url.searchParams.get("project") ?? "");
  }, []);

  /* 项目配置已从设置页并入主页的「管理项目」弹窗；旧链接用 replace 跳过去，
     避免在浏览器历史里留下一条会再次触发跳转的记录。 */
  useEffect(() => {
    if (path !== "/settings") return;
    if (new URLSearchParams(window.location.search).get("tab") !== "projects") return;
    window.history.replaceState(window.history.state, "", "/?manage=1");
    setPath("/");
  }, [path]);

  /* 副实例换用 co-Qubius 品牌名，避免和主实例混淆。
     接口失败时退回主实例名称，不影响正常使用。 */
  const [instanceRole, setInstanceRole] = useState<"primary" | "secondary" | null>(null);
  /* 顶栏品牌名下方的小字版本号；旧服务端没有这个字段时留空。 */
  const [instanceVersion, setInstanceVersion] = useState("");
  /* null 表示实例信息还没拿到（请求失败也保持 null）：入口先不显示，
     /terminal 仍按旧服务端兼容渲染，避免入口闪一下再消失。 */
  const [terminalEnabled, setTerminalEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getInstance()
      .then((info) => {
        if (cancelled) return;
        setInstanceRole(info.role);
        setInstanceVersion(info.version ?? "");
        setTerminalEnabled(info.terminal !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const brand = instanceBrand(instanceRole);

  /* 还没有配置文件时，第一次打开应用直接带到部署页。
     接口失败（例如服务端是旧版本）时忽略，不影响正常使用。 */
  const setupChecked = useRef(false);
  useEffect(() => {
    if (setupChecked.current) return;
    setupChecked.current = true;
    const initialPath = window.location.pathname;
    getDeployState()
      .then((state) => {
        // 只在用户仍停留在启动时的路径才自动跳转，避免覆盖期间的手动导航。
        if (state.setupRequired && initialPath !== "/deploy" && window.location.pathname === initialPath) {
          go("/deploy");
        }
      })
      .catch(() => {});
    // 只在应用启动时检查一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const project = path.match(/^\/projects\/([a-z0-9][a-z0-9-]{0,62})$/);
  const session = path.match(/^\/sessions\/([0-9a-f-]{36})$/i);
  /* 在项目的会话列表页点「命令行」时带上项目 id，终端在项目仓库路径下启动。 */
  const projectId = project?.[1] ?? "";
  const openTerminal = useCallback(() => {
    // 已经在命令行页时重复点击不换掉当前终端会话。
    if (path === "/terminal") return;
    go(projectId ? `/terminal?project=${encodeURIComponent(projectId)}` : "/terminal");
  }, [go, path, projectId]);

  /* Keep the tab title in sync with the route. Pages that load their own data
     refine it once it arrives (project name, session title). 统一走 title.ts，
     全局待处理计数才能叠加在标题前。
     路由变化时强制重置优先级；同一路由下 brand 迟到更新不能覆盖页面已细化
     的标题（例如副实例名称从 Qubius 变为 co-Qubius）。 */
  const titlePath = useRef("");
  useEffect(() => {
    const force = titlePath.current !== path;
    titlePath.current = path;
    if (path === "/overview") setBaseTitle(`总览 · ${brand}`, 0, force);
    else if (path === "/terminal") setBaseTitle(`命令行 · ${brand}`, 0, force);
    else if (path === "/deploy") setBaseTitle(`部署 · ${brand}`, 0, force);
    else if (path === "/settings") setBaseTitle(`设置 · ${brand}`, 0, force);
    else if (path === "/skills") setBaseTitle(`技能 · ${brand}`, 0, force);
    else if (project) setBaseTitle(`${project[1]} · ${brand}`, 0, force);
    else if (session) setBaseTitle(`对话 · ${brand}`, 0, force);
    else setBaseTitle(brand, 0, force);
  }, [path, brand]);

  /* 路由焦点由 Suspense 内部的 RouteFocus 负责：它只有在真实页面提交后才挂载，
     因此懒加载页面首次出现时也能聚焦到标题。 */

  let page: ReactNode;
  if (path === "/overview") {
    page = (
      <OverviewPage go={go}>
        <UsagePanel />
      </OverviewPage>
    );
  } else if (path === "/deploy") page = <DeployPage />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/skills") page = <SkillsPage />;
  else if (path === "/terminal") {
    /* 明确关闭时不加载 TerminalPage（它一挂载就会请求 /api/terminal 并 404）；
       实例信息未知时仍渲染，兼容没有 terminal 字段的旧服务端。 */
    page = terminalEnabled === false
      ? <TerminalDisabledPage />
      : <TerminalPage project={terminalProject} />;
  } else if (project) page = <BoardPage key={project[1]} projectId={project[1] || ""} go={go} brand={brand} />;
  else if (session) page = <DetailPage key={session[1]} sessionId={session[1] || ""} go={go} brand={brand} />;
  else page = <ProjectsPage go={go} />;

  /* 只有低频页面是异步 chunk；error boundary 也只包它们。key 随 path 变化，
     切到别的路由时不会把旧的失败状态带过去；真正恢复仍靠刷新重新拿 index.html。 */
  const lazyRoute = path === "/overview" || path === "/deploy" || path === "/settings"
    || path === "/skills" || path === "/terminal";

  /* 窄屏或字号放大时，次要导航入口收进这个菜单；字号按钮常驻顶栏，不在这里。 */
  const moreItems = [
    { id: "overview", label: "总览", onSelect: () => go("/overview") },
    ...(terminalEnabled === true ? [{ id: "terminal", label: "命令行", onSelect: openTerminal }] : []),
    { id: "skills", label: "技能", onSelect: () => go("/skills") },
    { id: "deploy", label: "部署", onSelect: () => go("/deploy") },
    { id: "settings", label: "设置", onSelect: () => go("/settings") },
  ];

  return (
    <div className="app">
      <header className={compact ? "bar compact" : "bar"}>
        <button
          className="brand"
          title={instanceVersion ? `返回首页 · v${instanceVersion}` : "返回首页"}
          onClick={() => go("/")}
        >
          <span className="brand-name">{brand}</span>
          {instanceVersion && <span className="brand-version">v{instanceVersion}</span>}
        </button>
        <AgentBadge
          running={attention.runningAgents}
          limit={sessionLimit}
          speed={attention.tokenSpeed}
        />
        <nav className="bar-actions">
          {/* 极窄宽度下只有这层导航滚动；字号组和「更多」菜单留在滚动层外面，
              前者始终可见，后者弹层不会被裁剪。 */}
          <div className="bar-scroll">
            <button className="nav-btn bar-secondary" data-on={path === "/overview"} onClick={() => go("/overview")}>总览</button>
            {terminalEnabled === true && (
              <button className="nav-btn bar-secondary" data-on={path === "/terminal"} onClick={openTerminal}>命令行</button>
            )}
            <button className="nav-btn bar-secondary" data-on={path === "/skills"} onClick={() => go("/skills")}>技能</button>
            <button className="nav-btn bar-secondary" data-on={path === "/deploy"} onClick={() => go("/deploy")}>部署</button>
            <button className="nav-btn bar-secondary" data-on={path === "/settings"} onClick={() => go("/settings")}>设置</button>
          </div>
          {/* 字号按钮常驻在滚动层外：任何宽度/字号下都不隐藏，也不随导航横向滚动。
             缩小/放大保留长按连发。 */}
          <div className="font-controls" role="group" aria-label="字号">
            <FontStepButton
              symbol="小"
              label={`缩小字号（当前 ${fontPercent}%）`}
              disabled={fontPercent <= FONT_PERCENT_MIN}
              onStep={() => setFontPercent((value) => stepFontPercent(value, -1))}
            />
            <FontStepButton
              symbol="大"
              label={`放大字号（当前 ${fontPercent}%）`}
              disabled={fontPercent >= FONT_PERCENT_MAX}
              onStep={() => setFontPercent((value) => stepFontPercent(value, 1))}
            />
          </div>
          {/* 待处理 badge 放在滚动层外：极窄/大字号时它也必须一眼可见。 */}
          {attention.count > 0 && (
            <button
              type="button"
              className="attention-badge"
              aria-live="polite"
              aria-label={`${attention.count} 个对话待处理，前往总览`}
              title={`${attention.count} 个对话需要处理`}
              onClick={() => go("/overview")}
            >
              {attention.count > 99 ? "99+" : attention.count}
              <span className="attention-label"> 待处理</span>
            </button>
          )}
          <Menu
            className="bar-more"
            buttonClassName="nav-btn menu-trigger"
            label="更多"
            ariaLabel="更多导航"
            align="right"
            items={moreItems}
          />
          {/* iOS 主屏 PWA 没有地址栏，也没有原生下拉刷新，部署后需要顶栏里的
              刷新入口。index.html 走 no-cache + ETag，reload 会重新校验并拿到新构建。
              放在最右侧，任何页面都能重新加载。 */}
          <button
            type="button"
            className="nav-btn"
            aria-label="刷新页面"
            title="重新加载页面"
            onClick={() => window.location.reload()}
          >
            刷新
          </button>
        </nav>
      </header>
      {lazyRoute ? (
        <RouteErrorBoundary key={path}>
          <Suspense fallback={<RouteFallback />}>
            {page}
            {/* 停留在 /terminal 时实例信息迟到、页面从 TerminalPage 换成
                TerminalDisabledPage：path 没变，靠 focusKey 变化重新聚焦新标题。 */}
            <RouteFocus path={path} focusKey={path === "/terminal" && terminalEnabled === false} />
          </Suspense>
        </RouteErrorBoundary>
      ) : (
        <>
          {page}
          <RouteFocus path={path} focusKey={path === "/terminal" && terminalEnabled === false} />
        </>
      )}
      {needsToken && <TokenPrompt onClose={() => setNeedsToken(false)} />}
    </div>
  );
}

/**
 * 列表 GET 返回的是请求发出那一刻的整表，而同一时间 SSE 可能已经送来了更新的
 * 单项，或在请求期间新增了会话。这里以 current 为基础按 updatedAt 合并：
 * 旧整表不会覆盖较新的单项；GET 里没有的项只有在请求发出后经 SSE 新增时才保留
 * （否则说明服务端已删除）。removedIds 记录删除时间，防止删除前发出的旧 GET
 * 把会话加回来；删除后发起的新 GET 仍返回它时视为服务端已恢复，清除标记。
 */
function mergeSessions(
  current: Session[],
  incoming: Session[],
  requestedAt: number,
  removedIds: Map<string, number>,
  touchedAt: Map<string, number>,
): Session[] {
  const merged = new Map<string, Session>();
  for (const item of incoming) {
    const removedAt = removedIds.get(item.id);
    if (removedAt !== undefined) {
      // 删除前发出的整表请求：结果可能还包含已删除会话，过滤。
      if (requestedAt <= removedAt) continue;
      // 删除后发出的新请求仍然返回它：服务端权威结果（例如归档恢复），清墓碑。
      removedIds.delete(item.id);
    }
    merged.set(item.id, item);
  }
  for (const item of current) {
    if (removedIds.has(item.id)) continue;
    const fetched = merged.get(item.id);
    if (!fetched) {
      // GET 里没有：只有请求发出后才由 SSE 新增的会话才保留，否则视为已删除。
      if ((touchedAt.get(item.id) ?? 0) > requestedAt) merged.set(item.id, item);
      continue;
    }
    // GET 的快照可能比已经收到的 SSE 增量旧；updatedAt 较新的一方胜出。
    if (item.updatedAt > fetched.updatedAt) merged.set(item.id, item);
  }
  /* 删除后发起的整表已经由服务端确认过：列表里没有的 id 不必再保留墓碑，
     避免长时间运行的页面累积；列表里有的 id 已在上面清除。 */
  const incomingIds = new Set(incoming.map((item) => item.id));
  for (const [id, removedAt] of removedIds) {
    if (requestedAt > removedAt && !incomingIds.has(id)) removedIds.delete(id);
  }
  return [...merged.values()].sort(compareSessions);
}

/** 列表行：真实会话，或发送后还在创建的本地占位行。 */
type BoardEntry =
  | { kind: "session"; session: Session }
  | { kind: "pending"; pending: PendingSession };

/** 置顶优先，其余按创建时间倒序。 */
function compareSessionOrder(
  a: { pinned?: boolean; createdAt: string },
  b: { pinned?: boolean; createdAt: string },
): number {
  const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinned !== 0) return pinned;
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt < b.createdAt ? 1 : -1;
}

function compareSessions(a: Session, b: Session): number {
  return compareSessionOrder(a, b);
}

/** 占位行和真实会话混排；占位行的置顶状态固定为 false。 */
function compareBoardEntries(a: BoardEntry, b: BoardEntry): number {
  const left = a.kind === "session"
    ? a.session
    : { pinned: false, createdAt: new Date(a.pending.startedAt).toISOString() };
  const right = b.kind === "session"
    ? b.session
    : { pinned: false, createdAt: new Date(b.pending.startedAt).toISOString() };
  return compareSessionOrder(left, right);
}

/**
 * 把单条 SSE 更新放进列表。排序只看 pinned 和 createdAt，这两项没变时
 * 原位替换即可，避免每个 token 都对整张列表重新排序。
 */
function upsertSession(current: Session[], incoming: Session): Session[] {
  const index = current.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...current, incoming].sort(compareSessions);
  const previous = current[index];
  if (previous === incoming) return current;
  const next = current.slice();
  next[index] = incoming;
  if (previous.pinned === incoming.pinned && previous.createdAt === incoming.createdAt) return next;
  return next.sort(compareSessions);
}

/* 左滑露出的删除按钮在 100% 字号下的基准宽度；实际宽度是它乘以
   --control-scale，和 styles.css 里 .convo-del 的 width 保持一致。 */
const SWIPE_DELETE_WIDTH = 76;

/* 读取当前控件缩放，让左滑距离和 .convo-del 的实际宽度同步。
   只在渲染/手势事件里调用，不要放到模块顶层。 */
function swipeDeleteWidth(): number {
  if (typeof document === "undefined") return SWIPE_DELETE_WIDTH;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--control-scale");
  const scale = Number.parseFloat(raw);
  return SWIPE_DELETE_WIDTH * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}

/**
 * 对话列表的一行：向左拖动露出删除按钮，向右或点正文收起。
 * 竖向拖动交给页面滚动（touch-action: pan-y），横向才由这里接管。
 */
const SwipeRow = memo(function SwipeRow({
  open,
  onOpen,
  onDelete,
  busy,
  deleteLabel,
  hasContinue = false,
  children,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  onDelete: () => void;
  busy: boolean;
  deleteLabel: string;
  /** 行内已有「继续」按钮时，桌面的归档按钮左移，避免两个入口重叠。 */
  hasContinue?: boolean;
  children: ReactNode;
}) {
  const [dragX, setDragX] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const gesture = useRef<{ x: number; y: number; base: number; axis: "x" | "y" | null; width: number } | null>(null);
  /* 拖动或点按展开行后浏览器仍会派发 click；拦掉它，避免误进对话。 */
  const suppressClick = useRef(false);
  /* 只有真正展开或正在拖动时才挂删除按钮。静止的行不能靠正文层去“盖住”
     红色按钮：iOS Safari 会把带 transform 的正文层提升成合成层，频繁更新
     （运行中的会话）时这一层可能整块不绘制，露出背后的红色删除区。 */
  const revealed = open || dragX !== null;

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (busy) return;
    /* 任何下一次按下都清掉上一次手势残留的 click 抑制，否则触摸被系统
       取消后，紧接着的鼠标点击会被误吞一次。 */
    suppressClick.current = false;
    /* 隐藏手势只服务触摸；鼠标/笔改用行右侧的可见删除按钮。 */
    if (!isTouchPointer(event)) return;
    /* 手势开始时读取一次当前宽度；move/up 都用这份缓存。 */
    const width = swipeDeleteWidth();
    gesture.current = {
      x: event.clientX,
      y: event.clientY,
      base: open ? -width : 0,
      axis: null,
      width,
    };
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
    if (current.axis !== "x") return;
    suppressClick.current = true;
    const next = Math.min(0, Math.max(-current.width, current.base + dx));
    dragRef.current = next;
    setDragX(next);
  }

  function onPointerUp() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (current.axis === "x") {
      const next = dragRef.current ?? current.base;
      dragRef.current = null;
      setDragX(null);
      onOpen(next <= -current.width / 2);
      return;
    }
    if (current.axis === null && open) {
      // 已展开时点按正文只收起，不进入对话。
      suppressClick.current = true;
      onOpen(false);
    }
  }

  function onPointerCancel() {
    if (gesture.current?.axis === "x") {
      suppressClick.current = true;
      dragRef.current = null;
      setDragX(null);
    }
    gesture.current = null;
  }

  return (
    <div
      className={
        (dragX === null ? "convo-swipe" : "convo-swipe dragging")
        + (hasContinue ? " has-continue" : "")
      }
      /* 展开或拖动中标记出来，桌面端据此隐藏行内删除按钮，避免和红色滑出按钮重叠。 */
      data-open={open || dragX !== null || undefined}
    >
      {revealed && (
        <button
          type="button"
          className="convo-del"
          aria-label={deleteLabel}
          tabIndex={open ? 0 : -1}
          disabled={busy}
          onClick={onDelete}
        >
          {busy ? "归档中" : "归档"}
        </button>
      )}
      <div
        className="convo-swipe-body"
        /* 静止时不写 transform：没有合成层，Safari 不会漏画这一层。
           展开态用 CSS 变量，字号变化时位移会自动跟随，不会留下 stale 像素值。 */
        style={
          dragX !== null
            ? { transform: `translateX(${dragX}px)` }
            : open
              ? { transform: "translateX(calc(-1 * var(--swipe-delete-width)))" }
              : undefined
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          /* 混合输入：触摸滑开后用鼠标点正文只收起，不进入对话。 */
          if (open) {
            event.preventDefault();
            event.stopPropagation();
            onOpen(false);
          }
        }}
      >
        {children}
      </div>
      {/* 精确指针（鼠标/笔）的可见删除入口；触摸端仍用左滑。必须是正文层的兄弟，
          不能放进 .convo 里，避免 button 嵌套。 */}
      <button
        type="button"
        className="convo-del-inline"
        aria-label={deleteLabel}
        title={busy ? "正在归档" : "归档对话"}
        disabled={busy}
        onClick={onDelete}
      >
        {busy ? "归档中" : "归档"}
      </button>
    </div>
  );
});

/**
 * Board 上的一行会话。memo 的边界放在 SwipeRow 外面：children 是每次渲染新建的
 * React 元素，只有把整行作为组件缓存，未变化的会话才能真正跳过重渲染。
 */
const BoardSessionRow = memo(function BoardSessionRow({
  session,
  open,
  busy,
  continuing,
  selectMode,
  selected,
  merged,
  untouched,
  mergeBase,
  onToggleOpen,
  onDelete,
  onContinue,
  onToggleSelect,
  go,
}: {
  session: Session;
  open: boolean;
  busy: boolean;
  continuing: boolean;
  selectMode: boolean;
  selected: boolean;
  /** 分支是否已合入基准分支；合入状态还没加载时为 undefined。 */
  merged?: boolean;
  /** 分支创建后从未改过代码：显示灰灯。 */
  untouched?: boolean;
  mergeBase?: string;
  onToggleOpen: (id: string, open: boolean) => void;
  onDelete: (session: Session) => void;
  onContinue: (session: Session) => void;
  onToggleSelect: (id: string) => void;
  go: (to: string) => void;
}) {
  const handleOpen = useCallback(
    (value: boolean) => onToggleOpen(session.id, value),
    [onToggleOpen, session.id],
  );
  const handleDelete = useCallback(() => onDelete(session), [onDelete, session]);
  const handleContinue = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // 按钮是正文按钮的兄弟节点；停掉冒泡，避免意外触发整行导航。
      event.stopPropagation();
      onContinue(session);
    },
    [onContinue, session],
  );
  const handleSelect = useCallback(() => onToggleSelect(session.id), [onToggleSelect, session.id]);
  const handleBody = useCallback(
    () => (selectMode ? handleSelect() : go(`/sessions/${session.id}`)),
    [go, handleSelect, selectMode, session.id],
  );
  /* 选择模式下隐藏「继续」，整行点击用于勾选，避免两个动作抢点击。 */
  const resumable = canContinue(session) && !selectMode;
  return (
    <SwipeRow
      open={open}
      onOpen={handleOpen}
      onDelete={handleDelete}
      busy={busy}
      deleteLabel={`归档对话「${session.title}」`}
      hasContinue={resumable}
    >
      <div className={`convo-row${resumable ? " has-continue" : ""}${selectMode ? " selecting" : ""}`}>
        <button
          className={`convo${selected ? " selected" : ""}`}
          onClick={handleBody}
          aria-pressed={selectMode ? selected : undefined}
        >
          {selectMode
            ? <span className={`convo-check${selected ? " on" : ""}`} aria-hidden="true" />
            : <PhaseMark phase={session.phase} />}
          <span className="convo-text">
            <span className="convo-head">
              {session.branch && (
                <BranchBadge
                  branch={session.branch}
                  className="convo-branch"
                  merged={merged}
                  untouched={untouched}
                  base={mergeBase}
                />
              )}
              <strong className="convo-title">{session.title}</strong>
            </span>
            <span className="convo-sub">{session.summary || PHASE_LABEL[session.phase]}</span>
            {session.lastError && session.phase === "failed" && <span className="error">{session.lastError}</span>}
          </span>
          <SessionMeta session={session} />
        </button>
        {resumable && (
          <button
            type="button"
            className="convo-continue"
            aria-label={`继续对话「${session.title}」`}
            title={session.lastError ? `上一轮失败：${session.lastError}` : "继续这个对话"}
            disabled={continuing || busy}
            onClick={handleContinue}
          >
            {continuing ? "继续中" : "继续"}
          </button>
        )}
      </div>
    </SwipeRow>
  );
});

/**
 * 发送后、服务端建好 worktree/会话之前的占位行。
 * 不可点击、不可滑动归档：还没有真实 id，点进去也没有内容。
 */
const PendingSessionRow = memo(function PendingSessionRow({ pending }: { pending: PendingSession }) {
  return (
    <div className="board-session" data-creating="true">
      <div className="convo-row">
        <div
          className="convo convo-creating"
          role="status"
          aria-live="polite"
          title="正在创建对话，请稍候"
        >
          <PhaseMark phase="queued" />
          <span className="convo-text">
            <span className="convo-head">
              <strong className="convo-title">{pending.title}</strong>
            </span>
            <span className="convo-sub">正在创建对话…</span>
          </span>
        </div>
      </div>
    </div>
  );
});

/**
 * 列表右侧：运行中的会话显示已运行时长（每秒刷新），落定后显示结束时间。
 * 运行状态只看 phase：后台子 agent 的通知会在主轮 result 之后唤醒主 agent 继续跑，
 * 这时残留的 runEndedAt 不能再决定“结束”。没有时间数据（旧会话、还没运行过）时
 * 退回子 agent 计数或阶段文案。
 */
function SessionMeta({ session }: { session: Session }) {
  const [now, setNow] = useState(() => Date.now());
  const { live, timing } = runMeta(session, now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live, session.runStartedAt]);
  const counts = session.subagentTotal > 0
    ? `${session.subagentDone}/${session.subagentTotal}`
    : "";
  return (
    <span className="convo-meta convo-run-meta">
      {timing ? (
        <span
          className="convo-run-time"
          title={live
            ? `开始 ${formatMessageFullTime(session.runStartedAt)}`
            : `结束 ${formatMessageFullTime(session.runEndedAt)}`}
        >
          {timing}
        </span>
      ) : counts ? null : PHASE_LABEL[session.phase]}
      {counts && <span className="convo-meta-sub">{counts}</span>}
    </span>
  );
}

function formatArchiveTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 距底部 80px 以内都算贴底，允许轻微抖动。 */
function nearBottom(node: HTMLDivElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

/** 真正贴着底部（2px 内）才算。键盘触发的重排用严格判定，避免手机上的
    80px 容差把“只是往上滑了一点”误判成跟随。 */
function atExactBottom(node: HTMLDivElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
}

function BoardPage({ projectId, go, brand }: { projectId: string; go: (to: string) => void; brand: string }) {
  const dialogs = useDialogs();
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  /* 供 onCreate 读取最新列表；ref 不参与依赖，避免 SSE 更新让回调不断重建。 */
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const [settings, setSettings] = useState<Settings | null>(null);
  const attachments = useAttachments();
  const draft = useDraftPersistence(projectDraftKey(projectId), attachments.texts, attachments.restoreTexts);
  const prompt = draft.prompt;
  const setPrompt = draft.setPrompt;
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort>("high");
  /* 发送区选择的工作流；保持粘性，不因发送而重置。 */
  const [workflowMode, setWorkflowMode] = useState<WorkflowSkill | "">("");
  const [error, setError] = useState("");
  /* 加载失败才给「重新加载」；创建/删除/权限等操作错误只允许关闭提示。 */
  const [errorRetry, setErrorRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  /* listReady：本次列表请求已结束；listLoaded：至少成功加载过一次。
     失败时 listReady 为 true 但 listLoaded 仍为 false，不能显示「还没有对话」。 */
  const [listReady, setListReady] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  /* 发送后、服务端返回前的占位行：建 worktree 要一两秒，列表先出现一条
     「正在创建对话…」，否则点发送后看起来毫无反应。 */
  const [pendingSessions, setPendingSessions] = useState<readonly PendingSession[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /* Only the newest list request may write state, so a refresh triggered by a
     reconnect or the tab becoming visible cannot overwrite fresher data. */
  const listSeq = useRef(0);
  /* 已收到 removed 的会话，旧列表 GET 不能再把它加回来。 */
  /* 会话 id → 本地删除时间；只过滤删除前发出的旧整表，重连后的新整表可恢复它。 */
  const removedIds = useRef(new Map<string, number>());
  /* 每个会话最近一次通过 SSE 更新的本地时间，用来判断“GET 期间新增”的会话。 */
  const sseTouchedAt = useRef(new Map<string, number>());
  /* 连续保存权限时只认最新一次响应。 */
  const permissionSeq = useRef(0);
  /* 左滑一次只展开一行；点删除后请求返回前禁用该行。 */
  const [swipeOpenId, setSwipeOpenId] = useState("");
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const deletingIdsRef = useRef(new Set<string>());
  /* 多选：进入选择模式后点整行或勾选图标都能切换选中，批量归档只处理选中的项。 */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  /* 从列表直接「继续」时的在途请求；按会话 id 记录，互不影响。 */
  const [continuingIds, setContinuingIds] = useState<ReadonlySet<string>>(() => new Set());
  const continuingIdsRef = useRef(new Set<string>());
  /* 列表内联回答：按会话记录在途状态，会话之间互不影响；同一会话防连点。 */
  const [answeringIds, setAnsweringIds] = useState<ReadonlySet<string>>(() => new Set());
  const answeringIdsRef = useRef(new Set<string>());
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);
  /* 分支合入 / 改动状态：列表里用分支标签底色展示（绿=已合入，灰=从未改过代码），
     「全部归档」跳过运行中和从未改过代码的会话，默认只归档已合入的。 */
  const [mergeStatus, setMergeStatus] = useState<MergeStatus | null>(null);
  const mergeSeq = useRef(0);
  const mergedBranches = useMemo(() => new Set(mergeStatus?.merged ?? []), [mergeStatus]);
  /* 分支创建后从未提交过代码；标签显示灰灯，「全部归档」始终跳过。 */
  const untouchedBranches = useMemo(() => new Set(mergeStatus?.untouched ?? []), [mergeStatus]);
  const mergeBase = mergeStatus?.base ?? undefined;
  const [archived, setArchived] = useState<ArchivedSession[]>([]);
  const [archiveStatus, setArchiveStatus] = useState<ArchiveStatus | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState("");
  const visibleArchived = useMemo(
    () => filterArchivedSessions(archived, archiveQuery),
    [archived, archiveQuery],
  );
  /* 冷备完成但本机副本没删掉的条目数：在面板顶部提示，用户不用往下翻。 */
  const pendingCleanupCount = useMemo(
    () => archived.filter(isPendingCleanup).length,
    [archived],
  );
  const [archivedBusy, setArchivedBusy] = useState<{ id: string; action: "restore" | "delete" | "cleanup" } | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const archiveSeq = useRef(0);

  const refreshArchive = useCallback(async () => {
    // 只允许最新一次刷新写状态：mount/SSE/visibility/删除后都会并发触发，
    // 旧响应不能把刚删掉的归档或更新的 sweeping 状态写回来。
    const seq = ++archiveSeq.current;
    // 归档是辅助功能；读取失败不打断对话列表，但能拿到多少就展示多少。
    const [list, status] = await Promise.allSettled([
      getArchivedSessions(projectId),
      getArchiveStatus(),
    ]);
    if (seq !== archiveSeq.current) return;
    if (list.status === "fulfilled") setArchived(list.value.sessions);
    if (status.status === "fulfilled") setArchiveStatus(status.value.archive);
  }, [projectId]);

  /* 合入状态是辅助信息：失败时保留上一次结果，不打断对话列表。 */
  const refreshMerge = useCallback(async () => {
    const seq = ++mergeSeq.current;
    try {
      const status = await getMergeStatus(projectId);
      if (seq !== mergeSeq.current) return;
      // 内容没变时保留旧对象，避免定时刷新让整个列表重渲染。
      const sameBranches = (a: readonly string[], b: readonly string[]) => (
        a.length === b.length && a.every((branch, index) => branch === b[index])
      );
      setMergeStatus((current) => (
        current
        && current.base === status.base
        && sameBranches(current.merged, status.merged)
        && sameBranches(current.untouched, status.untouched)
          ? current
          : status
      ));
    } catch {
      // 读取失败不影响列表；下一次刷新会再试。
    }
  }, [projectId]);

  /* 操作类错误（创建/删除/保存权限等）没有可重放的加载动作，只允许关闭。 */
  const reportActionError = useCallback((message: string) => {
    setError(message);
    setErrorRetry(false);
  }, []);

  /* 页面基础数据：失败时标记为可重试的加载错误。 */
  const loadProject = useCallback(() => {
    getProjects()
      .then((data) => setProject(data.projects.find((item) => item.id === projectId) ?? null))
      .catch((reason: Error) => {
        setError(reason.message);
        setErrorRetry(true);
      });
  }, [projectId]);

  const loadSettings = useCallback(() => {
    getSettings()
      .then((data) => {
        setSettings(data);
        const first = data.providers[0];
        setProviderId(first?.id ?? "");
        setModel(first?.models[0] ?? "");
        setEffort(data.effort);
      })
      .catch((reason: Error) => {
        setError(reason.message);
        setErrorRetry(true);
      });
  }, []);

  async function onRestoreArchived(item: ArchivedSession) {
    if (archivedBusy) return;
    // 作废在途刷新，避免它把即将恢复的归档项又写回来。
    archiveSeq.current += 1;
    setArchivedBusy({ id: item.id, action: "restore" });
    setError("");
    try {
      const data = await restoreArchivedSession(item.id);
      setArchived((current) => current.filter((entry) => entry.id !== item.id));
      setShowArchive(false);
      go(`/sessions/${data.session.id}`);
    } catch (reason) {
      reportActionError(reason instanceof Error ? reason.message : "恢复归档失败");
      void refreshArchive();
    } finally {
      setArchivedBusy(null);
    }
  }

  async function onDeleteArchived(item: ArchivedSession) {
    if (archivedBusy) return;
    const confirmed = await dialogs.confirm({
      title: "永久删除归档",
      message: `永久删除归档「${item.title}」？\n\nSSD 上如果还有正在使用的副本，不受影响。`,
      confirmLabel: "永久删除",
      danger: true,
    });
    if (!confirmed) return;
    archiveSeq.current += 1;
    setArchivedBusy({ id: item.id, action: "delete" });
    setError("");
    try {
      await deleteArchivedSession(item.id);
      setArchived((current) => current.filter((entry) => entry.id !== item.id));
    } catch (reason) {
      reportActionError(reason instanceof Error ? reason.message : "删除归档失败");
    } finally {
      setArchivedBusy(null);
      // 删除成功后也刷新一次，修正在途旧响应可能带回来的数据。
      void refreshArchive();
    }
  }

  /* 冷备已完成、本机副本上次没删掉：重试 DELETE。服务端会复用现有归档，
     只补做没完成的步骤，不会重新复制整份 transcript。 */
  async function onCleanupArchived(item: ArchivedSession) {
    if (archivedBusy) return;
    setArchivedBusy({ id: item.id, action: "cleanup" });
    setError("");
    try {
      await deleteSession(item.id);
      removedIds.current.set(item.id, Date.now());
      setSessions((current) => current.filter((entry) => entry.id !== item.id));
      setSelectedIds((current) => {
        if (!current.has(item.id)) return current;
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    } catch (reason) {
      reportActionError(reason instanceof Error ? reason.message : "清理失败");
    } finally {
      setArchivedBusy(null);
      // 成功时条目会变成普通归档（本机副本没了），失败时保留「待清理」状态；
      // 两种情况都以服务端结果为准。
      void refreshArchive();
      void refreshSessions();
    }
  }

  async function onSweepArchive() {
    // 服务端已经在整理时也允许点击：后端会复用同一个任务，前端重新开始轮询。
    if (sweeping) return;
    setSweeping(true);
    setError("");
    try {
      await startArchiveSweep();
      // 整理在服务端后台执行；轮询到 sweeping 结束。单次状态读取失败不
      // 代表整理失败，继续有限轮询。
      for (let index = 0; index < 45; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const status = await getArchiveStatus();
          setArchiveStatus(status.archive);
          if (!status.archive.sweeping) break;
        } catch {
          // 继续下一轮。
        }
      }
    } catch (reason) {
      reportActionError(reason instanceof Error ? reason.message : "整理归档失败");
    } finally {
      setSweeping(false);
      // 轮询超时/失败也要刷新状态；按钮的 disabled 只看本地 sweeping，
      // 不会因为服务端仍 sweeping 而永久卡死。
      try {
        const status = await getArchiveStatus();
        setArchiveStatus(status.archive);
      } catch {
        setArchiveStatus((current) => current ? { ...current, sweeping: false } : current);
      }
      await refreshArchive();
    }
  }

  /* 依次归档一组会话：单项失败不阻断其余项，成功的立刻从列表和选中集合里移除。 */
  async function archiveSessions(targets: Session[]): Promise<string[]> {
    const failed: string[] = [];
    for (const target of targets) {
      // 单独删除或已经在别的流程里删除的，不重复处理。
      if (deletingIdsRef.current.has(target.id) || removedIds.current.has(target.id)) continue;
      try {
        await deleteSession(target.id);
        removedIds.current.set(target.id, Date.now());
        setSessions((current) => current.filter((item) => item.id !== target.id));
        setSelectedIds((current) => {
          if (!current.has(target.id)) return current;
          const next = new Set(current);
          next.delete(target.id);
          return next;
        });
        setSwipeOpenId((current) => (current === target.id ? "" : current));
      } catch {
        failed.push(target.title);
      }
    }
    return failed;
  }

  async function onClearAll() {
    if (clearingRef.current) return;
    if (sessions.length === 0) return;
    // project 和会话列表可能先后到达；非 git 项目没有可比较的会话分支。
    const isGitProject = project?.git ?? sessions.some((session) => session.git);
    if (isGitProject && !mergeStatus) {
      reportActionError("正在读取分支合入状态，请稍后再试");
      return;
    }
    const base = mergeStatus?.base ?? "";
    const mergedBranches = new Set(mergeStatus?.merged ?? []);
    const untouchedBranches = new Set(mergeStatus?.untouched ?? []);
    // 只有找到基准分支时才能在弹窗里提供「仅归档已合入」；找不到时明确提示会归档全部。
    const canFilter = isGitProject && Boolean(mergeStatus?.base);
    // 运行中的会话始终保留；其余会话在取消勾选时都会归档（包括未合入和从未改过代码的）。
    const candidates = clearAllCandidates(sessions);
    const runningCount = sessions.length - candidates.length;
    // 勾选项默认打开：只归档已合入且确实改过代码的会话。
    const defaultTargets = pickArchiveTargets(sessions, canFilter, mergedBranches, untouchedBranches);
    if (candidates.length === 0) {
      reportActionError("没有可归档的对话：运行中的会话会保留");
      return;
    }
    const choice = await dialogs.confirmChoice({
      title: "全部归档",
      message:
        (canFilter
          ? `归档「${project?.name || projectId}」下的对话？共 ${sessions.length} 个，可归档 ${candidates.length} 个；默认只归档已合入 ${base} 且改过代码的 ${defaultTargets.length} 个。`
          : `归档「${project?.name || projectId}」下的对话？共 ${sessions.length} 个，可归档 ${candidates.length} 个。`
            + (isGitProject ? "\n\n找不到 main 分支，无法判断哪些会话已合入，将归档所有可归档的对话。" : ""))
        + (runningCount > 0 ? `\n\n运行中的 ${runningCount} 个对话会保留。` : "")
        + `\n\n每个对话的记录、图片，以及它自己的目录或 git worktree 和分支都会从 SSD 删除，开启归档时只保留对话记录、图片和 transcript。${ARCHIVE_RESTORE_NOTE}`,
      checkbox: canFilter
        ? {
            label: `仅归档已合入 ${base} 的会话`,
            checked: true,
            description: candidates.length > defaultTargets.length
              ? `取消勾选会把可归档的 ${candidates.length} 个对话全部归档（多 ${candidates.length - defaultTargets.length} 个），包括尚未合入 ${base} 和从未改过代码的会话。`
              : undefined,
          }
        : undefined,
      confirmLabel: "全部归档",
      danger: true,
    });
    if (!choice.confirmed) return;
    const targets = pickArchiveTargets(sessions, canFilter && choice.checked, mergedBranches, untouchedBranches);
    if (targets.length === 0) {
      reportActionError(`没有已合入 ${base || "main"} 且改过代码的对话可归档`);
      return;
    }
    clearingRef.current = true;
    setClearing(true);
    setError("");
    let failed: string[] = [];
    try {
      failed = await archiveSessions(targets);
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
    void refreshArchive();
    if (failed.length > 0) reportActionError(`${failed.length} 个对话没有归档：${failed.join("、")}`);
  }

  async function onArchiveSelected() {
    if (clearingRef.current) return;
    const targets = pickSelected(selectedIds, sessions);
    if (targets.length === 0) return;
    const confirmed = await dialogs.confirm({
      title: "批量归档",
      message:
        `归档选中的 ${targets.length} 个对话？\n\n`
        + `每个对话的记录、图片，以及它自己的目录或 git worktree 和分支都会从 SSD 删除，开启归档时只保留对话记录、图片和 transcript。${ARCHIVE_RESTORE_NOTE}`,
      confirmLabel: "归档",
      danger: true,
    });
    if (!confirmed) return;
    clearingRef.current = true;
    setClearing(true);
    setError("");
    let failed: string[] = [];
    try {
      failed = await archiveSessions(targets);
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
    void refreshArchive();
    if (failed.length > 0) {
      // 失败项仍在选中集合里，方便直接重试；保持选择模式。
      reportActionError(`${failed.length} 个对话没有归档：${failed.join("、")}`);
      return;
    }
    setSelectMode(false);
  }

  const onToggleSelect = useCallback((id: string) => {
    setSelectedIds((current) => toggleSelected(current, id));
  }, []);

  /* 从列表直接继续，不跳转详情页；SSE 会推后续输出。 */
  const onContinueSession = useCallback(async (target: Session) => {
    if (!canContinue(target) || continuingIdsRef.current.has(target.id)) return;
    continuingIdsRef.current.add(target.id);
    setContinuingIds(new Set(continuingIdsRef.current));
    setError("");
    try {
      const next = await sendContinue(target);
      /* 本地写入结果，不必等下一次整表刷新；SSE 帧之后会覆盖同一会话。 */
      sseTouchedAt.current.set(next.id, Date.now());
      setSessions((current) => upsertSession(current, next));
    } catch (reason) {
      reportActionError(reason instanceof Error ? reason.message : "发送「继续」失败");
    } finally {
      continuingIdsRef.current.delete(target.id);
      setContinuingIds(new Set(continuingIdsRef.current));
    }
  }, [reportActionError]);

  /* 列表里直接回答提问/授权，不进入详情页；结果先写回列表，后续 SSE 会覆盖。 */
  const onAnswerSession = useCallback(async (
    target: Session,
    behavior: "allow" | "deny",
    answers?: Record<string, string>,
    remember?: boolean,
    approvedFull?: boolean,
  ) => {
    if (!target.pending || hasPending(answeringIdsRef.current, target.id)) return;
    const next = addPending(answeringIdsRef.current, target.id);
    if (!next) return;
    answeringIdsRef.current = next;
    setAnsweringIds(next);
    setError("");
    try {
      const data = await answerSession(
        target.id,
        answerBody(target.pending, behavior, answers, remember, approvedFull),
      );
      sseTouchedAt.current.set(data.session.id, Date.now());
      setSessions((current) => upsertSession(current, data.session));
    } catch (reason) {
      reportActionError(reason instanceof Error ? reason.message : "提交回答失败");
    } finally {
      answeringIdsRef.current = removePending(answeringIdsRef.current, target.id);
      setAnsweringIds(answeringIdsRef.current);
    }
  }, [reportActionError]);

  const onDeleteSession = useCallback(async (target: Session) => {
    if (clearingRef.current || deletingIdsRef.current.has(target.id)) return;
    const confirmed = await dialogs.confirm({
      title: "归档对话",
      message: `归档「${target.title}」？\n\n${deleteDetail(target)}。${ARCHIVE_RESTORE_NOTE}`,
      confirmLabel: "归档",
      danger: true,
    });
    if (!confirmed) return;
    deletingIdsRef.current.add(target.id);
    setDeletingIds(new Set(deletingIdsRef.current));
    setError("");
    try {
      await deleteSession(target.id);
      removedIds.current.set(target.id, Date.now());
      setSessions((current) => current.filter((item) => item.id !== target.id));
      setSwipeOpenId((current) => (current === target.id ? "" : current));
      void refreshArchive();
    } catch (reason) {
      reportActionError(reason instanceof Error ? reason.message : "归档失败");
    } finally {
      deletingIdsRef.current.delete(target.id);
      setDeletingIds(new Set(deletingIdsRef.current));
    }
  }, [dialogs, refreshArchive, reportActionError]);

  /* 稳定的按 id 分发：memo 行不需要因为父组件重渲染而换回调。 */
  const onToggleSwipe = useCallback((id: string, open: boolean) => {
    setSwipeOpenId(open ? id : "");
  }, []);

  async function refreshSessions() {
    const seq = ++listSeq.current;
    const requestedAt = Date.now();
    try {
      const data = await getSessions(projectId);
      if (seq !== listSeq.current) return;
      setSessions((current) =>
        mergeSessions(current, data.sessions, requestedAt, removedIds.current, sseTouchedAt.current),
      );
      setListLoaded(true);
    } catch (reason) {
      if (seq === listSeq.current) {
        setError(reason instanceof Error ? reason.message : "无法加载对话");
        setErrorRetry(true);
      }
    } finally {
      if (seq === listSeq.current) setListReady(true);
    }
  }

  useEffect(() => {
    loadProject();
    setListReady(false);
    setListLoaded(false);
    setSelectMode(false);
    setSelectedIds(new Set());
    setMergeStatus(null);
    void refreshSessions();
    void refreshArchive();
    void refreshMerge();
    loadSettings();
  }, [projectId, loadProject, loadSettings, refreshMerge]);

  /* 会话被归档或被其他端删除后，选中集合里已经不在列表中的 id 要丢掉。 */
  useEffect(() => {
    setSelectedIds((current) => pruneSelected(current, sessions));
  }, [sessions]);

  /* SSE / 整表刷新可能比创建请求先带回真实会话：同一条对话不能同时出现两行。 */
  useEffect(() => {
    setPendingSessions((current) => dropMatchedPending(current, sessions));
  }, [sessions]);

  /* Replace the slug fallback from App with the project's display name. */
  useEffect(() => {
    if (project) setBaseTitle(`${project.name} · ${brand}`, 1);
  }, [project, brand]);

  const { status: connection, reconnect } = useEventStream({
    url: "/api/events",
    /* 每次 open 都刷新；listSeq 会丢弃重复/过期请求，也能覆盖首次连接失败的情况。 */
    onOpen: () => {
      void refreshSessions();
      void refreshArchive();
      void refreshMerge();
    },
    handlers: {
      session: (event) => {
        const data = JSON.parse(event.data) as Session;
        if (data.removed) {
          removedIds.current.set(data.id, Date.now());
          setSessions((current) => current.filter((item) => item.id !== data.id));
          void refreshArchive();
          return;
        }
        if (data.projectId !== projectId) return;
        /* 归档恢复会以同 id 重新出现：清掉删除墓碑，后续整表刷新不会把它过滤掉。 */
        removedIds.current.delete(data.id);
        sseTouchedAt.current.set(data.id, Date.now());
        setSessions((current) => upsertSession(current, data));
      },
    },
  });

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") {
        void refreshSessions();
        void refreshArchive();
        void refreshMerge();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [projectId, refreshMerge]);

  /* 分支合入状态可能在本页打开期间变化（例如在终端里跑完 ttb）：低频轮询，
     页面不可见时暂停；内容没变时 refreshMerge 不会触发重渲染。非 git 项目
     没有可比较的分支，不轮询。 */
  useEffect(() => {
    if (project?.git === false) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshMerge();
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [refreshMerge, project?.git]);

  /* Composer 是 memo 组件：回调引用必须稳定，否则列表/会话更新会连带重渲染输入框。 */
  const onCreate = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (
      (!prompt.trim() && attachments.images.length === 0 && attachments.texts.length === 0)
      || !providerId
      || !model
      || attachments.busy
    ) return;
    setBusy(true);
    setError("");
    /* 清空输入区要用的快照；创建失败时据此恢复，用户可以直接重发。 */
    const draftText = prompt;
    const draftImages = attachments.images;
    const draftTexts = attachments.texts;
    let pending: PendingSession | null = null;
    try {
      // 正文末尾的 token 在本地立即生效：切换发送区选项，并作为显式 workflow
      // 随请求发出，不依赖服务端等 agent 消费 prompt 后再识别。
      const detected = detectWorkflowSkill(prompt);
      const workflow = detected ?? (workflowMode || undefined);
      if (detected) setWorkflowMode(detected);
      const text = mergeTextAttachments(prompt, attachments.texts);
      /* 建 worktree 可能要一两秒：先把占位行插进列表并清空输入区，点发送立刻有反馈。
         发送成功不再重复清空，避免覆盖创建期间用户新输入的内容。 */
      const createdPending = beginPendingSession({
        projectId,
        existingIds: sessionsRef.current.map((item) => item.id),
        prompt: text,
      });
      pending = createdPending;
      setPendingSessions((current) => [createdPending, ...current]);
      draft.clearDraft();
      attachments.clear();
      const created = await createSession(projectId, {
        prompt: text,
        providerId,
        model,
        effort,
        images: draftImages.length > 0 ? draftImages : undefined,
        workflow,
      });
      setPendingSessions((current) => current.filter((item) => item.id !== createdPending.id));
      /* 本地刚创建的会话与 GET 期间新增的会话同理：记录时间戳，避免在途的旧列表快照把它丢掉。 */
      sseTouchedAt.current.set(created.session.id, Date.now());
      setSessions((current) => upsertSession(current, created.session));
    } catch (reason) {
      if (pending) {
        setPendingSessions((current) => current.filter((item) => item.id !== pending!.id));
        // 创建期间用户可能已经在输入新内容；只补回空白的输入框，不覆盖新输入。
        setPrompt((current) => (current.trim() ? current : draftText));
        attachments.restoreImages(draftImages);
        attachments.restoreTexts(draftTexts);
      }
      reportActionError(reason instanceof Error ? reason.message : "无法创建对话");
    } finally {
      setBusy(false);
    }
  }, [attachments, draft.clearDraft, effort, model, projectId, prompt, providerId, reportActionError, setPrompt, workflowMode]);

  /* 多模型对比：同一个 prompt/附件，按用户选的模型各建一个独立会话。
     这里只负责“建一个”，选择、逐个调用和汇总由 MultiModelRun 负责。 */
  const createRunOne = useCallback(async (selection: RunSelection) => {
    const detected = detectWorkflowSkill(prompt);
    const workflow = detected ?? (workflowMode || undefined);
    const text = mergeTextAttachments(prompt, attachments.texts);
    const created = await createSession(projectId, {
      prompt: text,
      providerId: selection.providerId,
      model: selection.model,
      effort: selection.effort,
      images: attachments.images.length > 0 ? attachments.images : undefined,
      workflow,
      title: `多模型 · ${selection.model}`.slice(0, 80),
    });
    sseTouchedAt.current.set(created.session.id, Date.now());
    setSessions((current) => upsertSession(current, created.session));
    return created.session;
  }, [attachments, projectId, prompt, workflowMode]);

  const provider = settings?.providers.find((item) => item.id === providerId);
  const canSend = Boolean(
    (prompt.trim() || attachments.images.length > 0 || attachments.texts.length > 0)
      && providerId
      && model
      && project?.available !== false
      && !busy
      && !attachments.busy,
  );

  const providerOptions = useMemo(
    () => (settings?.providers ?? []).map((item) => ({ value: item.id, label: item.name })),
    [settings],
  );
  const modelOptions = useMemo(
    () => (provider?.models ?? []).map((item) => ({ value: item, label: item })),
    [provider],
  );

  /* Composer 的 chips 每次渲染新建会让 memo 失效；只在这些配置真正变化时更新。 */
  const boardChips = useMemo(() => {
    const changeProvider = (nextId: string) => {
      const next = settings?.providers.find((item) => item.id === nextId);
      setProviderId(nextId);
      setModel(next?.models[0] ?? "");
    };
    const changePermission = (next: string) => {
      // 连续保存只认最新响应，避免先发后到的旧权限覆盖新值。
      const seq = ++permissionSeq.current;
      saveProjectPermission(projectId, next as PermissionLevel)
        .then((saved) => {
          if (seq === permissionSeq.current) setProject(saved.project);
        })
        .catch((reason) => reportActionError(reason instanceof Error ? reason.message : "无法保存授权级别"));
    };
    return (
      <>
        <ChipSelect
          ariaLabel="工作流"
          className="wf-mode"
          value={workflowMode}
          options={WORKFLOW_OPTIONS}
          onChange={(next) => setWorkflowMode(next as WorkflowSkill | "")}
        />
        <div className="composer-config-inline">
          <ChipSelect
            ariaLabel="接口"
            value={providerId}
            placeholder={providerOptions.length > 0 ? "接口" : "未配置"}
            disabled={providerOptions.length === 0}
            options={providerOptions}
            onChange={changeProvider}
          />
          <ChipSelect
            ariaLabel="模型"
            value={model}
            placeholder="模型"
            disabled={modelOptions.length === 0}
            options={modelOptions}
            onChange={setModel}
          />
        </div>
        <ChipSelect
          ariaLabel="思考强度"
          title={EFFORT_DESCRIPTION[effort]}
          value={effort}
          options={EFFORT_OPTIONS}
          onChange={(next) => setEffort(next as Effort)}
        />
        <div className="composer-config-inline">
          <ChipSelect
            ariaLabel="授权"
            value={project?.permission ?? ""}
            placeholder="授权"
            disabled={!project?.permission}
            options={PERMISSION_OPTIONS}
            onChange={changePermission}
          />
        </div>
        <div className="composer-config-drawer">
          <ComposerConfig
            groups={[
              {
                label: "接口",
                value: providerId,
                options: providerOptions,
                disabled: providerOptions.length === 0,
                onChange: changeProvider,
              },
              {
                label: "模型",
                value: model,
                options: modelOptions,
                disabled: modelOptions.length === 0,
                onChange: setModel,
              },
              {
                label: "授权",
                value: project?.permission ?? "",
                options: PERMISSION_OPTIONS,
                disabled: !project?.permission,
                onChange: changePermission,
              },
            ]}
          />
        </div>
      </>
    );
  }, [providerOptions, modelOptions, providerId, model, effort, project, projectId, reportActionError, settings, workflowMode]);

  /* 窄屏顶栏只留返回图标，其余入口收进「更多」，避免文字按钮把标题挤没。
     宽屏仍用原来的文字按钮，行为不变。 */
  const narrowMoreItems: MenuItem[] = [
    {
      id: "select",
      label: selectMode ? "取消选择" : "选择",
      disabled: sessions.length === 0 && !selectMode,
      onSelect: () => {
        if (selectMode) {
          setSelectMode(false);
          setSelectedIds(new Set());
        } else {
          setSelectMode(true);
        }
      },
    },
    {
      id: "clear-all",
      label: clearing ? "归档中" : "全部归档",
      danger: true,
      disabled: clearing || sessions.length === 0,
      onSelect: () => void onClearAll(),
    },
    ...(archiveStatus?.enabled
      ? [
          {
            id: "archive",
            label: showArchive ? "收起归档" : `归档${archived.length > 0 ? ` (${archived.length})` : ""}`,
            separatorBefore: true,
            onSelect: () => {
              const next = !showArchive;
              setShowArchive(next);
              if (next) void refreshArchive();
            },
          },
          {
            id: "sweep",
            label: archiveStatus.writable === false
              ? "目录不可写"
              : sweeping || archiveStatus.sweeping
                ? "整理中"
                : "立即整理",
            disabled: sweeping || archiveStatus.writable === false,
            onSelect: () => void onSweepArchive(),
          },
          ...(!archiveStatus.writable
            ? [{ id: "archive-error", label: `归档目录不可写：${archiveStatus.dir}`, disabled: true, onSelect: () => {} }]
            : []),
          ...(archiveStatus.lastSweepError
            ? [{ id: "sweep-error", label: archiveStatus.lastSweepError, disabled: true, onSelect: () => {} }]
            : []),
        ]
      : []),
    {
      id: "schedules",
      label: showSchedules ? "收起定时任务" : "定时任务",
      separatorBefore: true,
      onSelect: () => setShowSchedules((value) => !value),
    },
  ];

  /* 真实会话和“创建中”占位行一起排序：置顶优先，其余按创建时间倒序。 */
  const boardEntries = useMemo<BoardEntry[]>(() => {
    const entries: BoardEntry[] = [
      ...sessions.map((session) => ({ kind: "session" as const, session })),
      ...pendingSessions.map((pending) => ({ kind: "pending" as const, pending })),
    ];
    return entries.sort(compareBoardEntries);
  }, [sessions, pendingSessions]);

  return (
    <section className="chat">
      <div className="chat-head">
        <button className="text-btn chat-back" title="返回" aria-label="返回" onClick={() => go("/")}>
          <span className="wide-only" aria-hidden="true">返回</span>
          <span className="narrow-only" aria-hidden="true">←</span>
        </button>
        <div className="chat-title" tabIndex={-1}>
          <strong>{project?.name || projectId}</strong>
          {project && <span className="mono">{project.path}</span>}
        </div>
        <button
          className="text-btn chat-select"
          disabled={sessions.length === 0 && !selectMode}
          aria-pressed={selectMode}
          onClick={() => {
            if (selectMode) {
              setSelectMode(false);
              setSelectedIds(new Set());
            } else {
              setSelectMode(true);
            }
          }}
        >
          {selectMode ? "取消选择" : "选择"}
        </button>
        <button
          className="text-btn danger chat-clear-all"
          disabled={clearing || sessions.length === 0}
          onClick={() => void onClearAll()}
        >
          {clearing ? "归档中" : "全部归档"}
        </button>
        {archiveStatus?.enabled && (
          <div className="archive-bar chat-archive-wide">
            <button
              className="text-btn"
              aria-expanded={showArchive}
              aria-controls="archive-panel"
              onClick={() => {
                const next = !showArchive;
                setShowArchive(next);
                if (next) void refreshArchive();
              }}
            >
              {showArchive ? "收起归档" : `归档${archived.length > 0 ? ` (${archived.length})` : ""}`}
            </button>
            {!archiveStatus.writable && <span className="error">归档目录不可写：{archiveStatus.dir}</span>}
            {archiveStatus.lastSweepError && <span className="error">{archiveStatus.lastSweepError}</span>}
            <button
              className="text-btn"
              disabled={sweeping || archiveStatus.writable === false}
              title={archiveStatus.writable === false ? "归档目录不可写" : undefined}
              onClick={() => void onSweepArchive()}
            >
              {archiveStatus.writable === false
                ? "目录不可写"
                : sweeping || archiveStatus.sweeping
                  ? "整理中"
                  : "立即整理"}
            </button>
          </div>
        )}
        <Menu
          className="chat-more"
          buttonClassName="text-btn menu-trigger"
          label="更多"
          ariaLabel="更多操作"
          align="right"
          items={narrowMoreItems}
        />
      </div>
      <ConnectionBanner status={connection} onRetry={reconnect} />
      {project && !project.git && !project.isolated && <p className="banner">这个目录不是 git 仓库，同时只能有一个进行中的对话。</p>}
      {settings && settings.providers.length === 0 && <p className="banner">还没有接口配置。先到设置里添加名称、地址、密钥和模型。</p>}
      {showArchive && archiveStatus?.enabled && (
        <div className="archive-panel" id="archive-panel">
          <div className="archive-panel-head">
            <span className="archive-path">
              {archiveStatus.instance ?? "main"} · 列表保留 {archiveStatus.retentionDays ?? 30} 天 · 到期归档到冷存储
              {pendingCleanupCount > 0 && (
                <span className="error"> · {pendingCleanupCount} 条待清理</span>
              )}
            </span>
            <div className="archive-search" role="search">
              <input
                type="search"
                value={archiveQuery}
                placeholder="搜索归档…"
                aria-label="搜索归档"
                onChange={(event) => setArchiveQuery(event.target.value)}
              />
              {archiveQuery !== "" && (
                <button className="text-btn" type="button" onClick={() => setArchiveQuery("")}>
                  清除
                </button>
              )}
            </div>
          </div>
          {archived.length === 0 && (
            <p className="empty">
              还没有归档的对话。手动归档的会话，以及会话列表里超过 {archiveStatus.retentionDays ?? 30} 天的会话，都会先完整归档到这里再从列表移除；归档不按天数清理，只有在这里永久删除才会消失。
            </p>
          )}
          {archived.length > 0 && visibleArchived.length === 0 && (
            <p className="empty">没有匹配「{archiveQuery.trim()}」的归档。</p>
          )}
          {visibleArchived.map((item) => {
            const restoring = archivedBusy?.id === item.id && archivedBusy.action === "restore";
            const deleting = archivedBusy?.id === item.id && archivedBusy.action === "delete";
            const cleaning = archivedBusy?.id === item.id && archivedBusy.action === "cleanup";
            const rowBusy = Boolean(archivedBusy) || sweeping || Boolean(archiveStatus?.sweeping);
            /* 冷备已完成、本机副本还在：恢复会被服务端拒绝，只能重试清理。 */
            const pendingCleanup = isPendingCleanup(item);
            return (
              <div className={pendingCleanup ? "archive-row pending-cleanup" : "archive-row"} key={item.id}>
                <div className="archive-text">
                  <strong className="convo-title">{item.title}</strong>
                  <span className="convo-sub">{item.summary}</span>
                  <span className="archive-meta">
                    {pendingCleanup && <span className="error">待清理 · 本机副本仍在 · </span>}
                    更新 {formatArchiveTime(item.updatedAt)} · 归档 {formatArchiveTime(item.archivedAt)} · {item.messageCount} 条
                  </span>
                </div>
                {pendingCleanup ? (
                  <button
                    className="text-btn"
                    disabled={rowBusy}
                    title="重新删除本机副本；归档已完成，不会重复写入"
                    aria-label={`重试清理「${item.title}」`}
                    onClick={() => void onCleanupArchived(item)}
                  >
                    {cleaning ? "清理中" : "重试清理"}
                  </button>
                ) : (
                  <>
                    <button
                      className="text-btn"
                      disabled={rowBusy}
                      aria-label={`恢复归档「${item.title}」`}
                      onClick={() => void onRestoreArchived(item)}
                    >
                      {restoring ? "恢复中" : "恢复"}
                    </button>
                    <button
                      className="text-btn danger"
                      disabled={rowBusy}
                      aria-label={`永久删除归档「${item.title}」`}
                      onClick={() => void onDeleteArchived(item)}
                    >
                      {deleting ? "删除中" : "删除"}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="archive-bar schedules-bar-wide">
        <button
          className="text-btn"
          aria-expanded={showSchedules}
          onClick={() => setShowSchedules((value) => !value)}
        >
          {showSchedules ? "收起定时任务" : "定时任务"}
        </button>
        <span className="archive-path">按固定间隔自动新建对话</span>
      </div>
      {showSchedules && <SchedulesPanel projectId={projectId} go={go} />}
      {selectMode && (
        <div className="archive-bar select-bar">
          <span className="archive-path">已选 {selectedIds.size} 个</span>
          <button
            className="text-btn"
            disabled={clearing || sessions.length === 0 || selectedIds.size === sessions.length}
            onClick={() => setSelectedIds(new Set(sessions.map((item) => item.id)))}
          >
            全选
          </button>
          <button
            className="text-btn"
            disabled={clearing || selectedIds.size === 0}
            onClick={() => setSelectedIds(new Set())}
          >
            清除
          </button>
          <button
            className="text-btn danger"
            disabled={clearing || selectedIds.size === 0}
            onClick={() => void onArchiveSelected()}
          >
            {clearing ? "归档中" : `归档 (${selectedIds.size})`}
          </button>
        </div>
      )}
      <div className="thread">
        {!listReady && boardEntries.length === 0 && <InlineLoading label="正在加载对话" />}
        {listReady && !listLoaded && boardEntries.length === 0 && (
          <p className="empty">对话列表暂时没有加载出来。</p>
        )}
        {listLoaded && boardEntries.length === 0 && <p className="empty">还没有对话。在下面写下要做的事。</p>}
        {boardEntries.map((entry) => (
          entry.kind === "pending"
            ? <PendingSessionRow key={entry.pending.id} pending={entry.pending} />
            : (
              <div className="board-session" key={entry.session.id}>
                <BoardSessionRow
                  session={entry.session}
                  open={swipeOpenId === entry.session.id}
                  busy={deletingIds.has(entry.session.id)}
                  continuing={continuingIds.has(entry.session.id)}
                  selectMode={selectMode}
                  selected={selectedIds.has(entry.session.id)}
                  merged={mergeBase && entry.session.branch ? mergedBranches.has(entry.session.branch) : undefined}
                  untouched={Boolean(entry.session.branch && untouchedBranches.has(entry.session.branch))}
                  mergeBase={mergeBase}
                  onToggleOpen={onToggleSwipe}
                  onDelete={onDeleteSession}
                  onContinue={onContinueSession}
                  onToggleSelect={onToggleSelect}
                  go={go}
                />
                {entry.session.pending && !selectMode && (
                  <Approval
                    pending={entry.session.pending}
                    variant="inline"
                    busy={answeringIds.has(entry.session.id)}
                    onAnswer={(behavior, answers, remember, approvedFull) => {
                      void onAnswerSession(entry.session, behavior, answers, remember, approvedFull);
                    }}
                  />
                )}
              </div>
            )
        ))}
      </div>
      {error && (
        <Notice
          tone="error"
          className="dock-notice"
          onDismiss={() => {
            setError("");
            setErrorRetry(false);
          }}
          action={errorRetry ? {
            label: "重新加载",
            onClick: () => {
              setError("");
              setErrorRetry(false);
              setListReady(false);
              loadProject();
              /* 设置已成功加载时不要重拉：会把用户选好的接口/模型/强度重置。 */
              if (!settings) loadSettings();
              void refreshSessions();
              void refreshArchive();
            },
          } : undefined}
        >
          {error}
        </Notice>
      )}
      {draft.restored && (
        <Notice tone="info" className="draft-notice" onDismiss={draft.dismissRestored}>
          已恢复上次未发送的草稿
        </Notice>
      )}
      <Composer
        onSubmit={onCreate}
        value={prompt}
        setValue={setPrompt}
        placeholder="要做的事，可粘贴图片/文件"
        canSend={canSend}
        sendLabel={busy ? "正在创建" : "开始对话"}
        textareaRef={inputRef}
        attachments={attachments}
        chips={boardChips}
        voiceDisabled={busy}
        attachDisabled={busy || attachments.busy}
        onError={reportActionError}
      />
      <MultiModelRun
        projectId={projectId}
        providers={settings?.providers ?? []}
        defaults={{ providerId, model, effort }}
        disabled={
          busy
          || attachments.busy
          || (!prompt.trim() && attachments.images.length === 0 && attachments.texts.length === 0)
        }
        createOne={createRunOne}
        onError={reportActionError}
        onDone={() => {
          draft.clearDraft();
          attachments.clear();
        }}
        onOpen={(id) => go(`/sessions/${id}`)}
      />
    </section>
  );
}

function DetailPage({ sessionId, go, brand }: { sessionId: string; go: (to: string) => void; brand: string }) {
  const dialogs = useDialogs();
  const [session, setSession] = useState<Session | null>(null);
  /* 对话展开程度：详细（逐行平铺）/ 简要（活动组折叠，进行中展开）/ 精简（默认，始终折叠）。 */
  const [density, setDensity] = useDensity();
  /* 继续对话时选择的工作流；保持粘性，不因发送而重置。 */
  const [workflowMode, setWorkflowMode] = useState<WorkflowSkill | "">("");
  const [diff, setDiff] = useState("");
  const [patch, setPatch] = useState("");
  const [diffLoaded, setDiffLoaded] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [permission, setPermission] = useState<PermissionLevel | "">("");
  /* 标题下的副标题显示项目名，和总览的会话列表一致；分支/目录只放在提示里。 */
  const [projectName, setProjectName] = useState("");
  const [showGit, setShowGit] = useState(false);
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /* 回滚/编辑重发/分叉共用一份 busy，避免同时触发多个记录变更。 */
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageNotice, setMessageNotice] = useState("");
  /* 用户手动关掉失败提示后，同一轮失败不再重复出现；下一轮结束再恢复。 */
  const [failureDismissed, setFailureDismissed] = useState(false);
  const attachments = useAttachments();
  const draft = useDraftPersistence(sessionDraftKey(sessionId), attachments.texts, attachments.restoreTexts);
  const prompt = draft.prompt;
  const setPrompt = draft.setPrompt;
  const handleSessionChange = useCallback((next: Session) => setSession(next), []);
  const actions = useSessionActions(session, handleSessionChange, setError, setWorkflowMode);
  /* 讨论会话重新打开时，发送区默认继续留在对应模式（discuss 或 dis-prl），
     用户接着发消息就能用同一批参与模型再讨论一轮。 */
  const discussionSkill = session?.discussion
    ? (session.workflow?.skill === "dis-prl" ? "dis-prl" : "discuss")
    : undefined;
  useEffect(() => {
    if (discussionSkill) setWorkflowMode(discussionSkill);
  }, [sessionId, discussionSkill]);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const titleFocused = useRef(false);
  const stickToBottom = useRef(true);
  /* 输入框获得焦点那一刻的消息区位置。键盘弹出会同时改变可见视口并触发布局
     重排，只有原本就贴着底部才继续跟随；否则按这里的位置钉住，避免 iPhone
     为了露出输入框滚动页面时把正在读的内容顶走。 */
  const composerFocus = useRef<{ scrollTop: number; atBottom: boolean } | null>(null);
  const composerBlurTimer = useRef(0);
  /* 统一在途 guard：Composer 发送、「继续上次」和三种消息操作共用。
     同步置位，React 重新渲染前也能挡住第二次点击。 */
  const operationBusyRef = useRef(false);
  /* 在途发送的本地乐观消息：POST/SSE 只要没确认这条，就把它保留在记录末尾。 */
  const optimisticRef = useRef<OptimisticSend | null>(null);
  const answeringRef = useRef(false);
  const stoppingRef = useRef(false);
  /* Only the newest reload may write state; a GET that resolves after a more
     recent one (or after switching sessions) is dropped. */
  const reloadSeq = useRef(0);
  const permissionSeq = useRef(0);
  /* 挂载 effect 与首次 SSE open 可能同时触发 reload；共享在途请求避免重复 GET。 */
  const reloadInFlight = useRef<Promise<Session | null> | null>(null);
  /* 本页是否已经拿到过数据（GET 成功或收到任一 SSE 帧）。open 用它与在途
     状态判断首次加载是否已被覆盖，不依赖墙钟，慢网络下也不会重复 GET。 */
  const initialLoadDone = useRef(false);
  /* 首帧迟迟不到时的兜底 GET 计时器；收到帧或卸载时清掉。 */
  const fallbackTimer = useRef(0);
  const reloadAbort = useRef<AbortController | null>(null);
  const diffAbort = useRef<AbortController | null>(null);
  /* Diff 行/Git 面板当前是否展开；展开时终态变化要按新 key 重拉 diff。 */
  const diffOpenRef = useRef(false);
  const showGitRef = useRef(false);
  /* 供稳定回调读取最新会话（diff 懒加载时拿当前 id/updatedAt）。 */
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  showGitRef.current = showGit;
  const showJumpRef = useRef(false);
  const historyLoadingRef = useRef(false);
  const historyAbort = useRef<AbortController | null>(null);
  const scrollFrame = useRef(0);

  function reload(): Promise<Session | null> {
    if (reloadInFlight.current) return reloadInFlight.current;
    const controller = new AbortController();
    reloadAbort.current = controller;
    const promise = (async () => {
      const seq = ++reloadSeq.current;
      try {
        const data = await getSession(sessionId, controller.signal);
        if (controller.signal.aborted || seq !== reloadSeq.current) return null;
        initialLoadDone.current = true;
        clearFallbackTimer();
        // 完整 GET 可能比在途发送旧：仍在发送中的消息要继续显示。
        setSession(reconcileOptimistic(data.session, optimisticRef.current));
        return data.session;
      } catch (reason) {
        // 被更新的 GET/SSE 取代或页面卸载时，错误也不应写到当前页面。
        if (controller.signal.aborted) return null;
        if (seq === reloadSeq.current) setError(reason instanceof Error ? reason.message : "加载失败");
        return null;
      }
    })().finally(() => {
      // 只有在途请求仍是这一次时才清理；StrictMode 重挂载时新请求可能已经接替。
      if (reloadAbort.current === controller) {
        reloadAbort.current = null;
        reloadInFlight.current = null;
      }
    });
    reloadInFlight.current = promise;
    return promise;
  }

  /* 丢弃在途的完整历史 GET：SSE 帧比它新，或页面已经卸载。 */
  function cancelReload() {
    const controller = reloadAbort.current;
    if (!controller) return;
    controller.abort();
    reloadAbort.current = null;
    reloadInFlight.current = null;
  }

  function clearFallbackTimer() {
    if (!fallbackTimer.current) return;
    window.clearTimeout(fallbackTimer.current);
    fallbackTimer.current = 0;
  }

  /* 展开/收起“回到底部”只在值变化时写 state，避免滚动事件每帧都触发渲染。 */
  const updateShowJump = useCallback((next: boolean) => {
    if (showJumpRef.current === next) return;
    showJumpRef.current = next;
    setShowJump(next);
  }, []);

  /* 一帧最多读/写一次 scrollTop；连续 token 的布局请求合并到同一个 rAF。 */
  const scrollToBottom = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const node = threadRef.current;
      if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
    });
  }, []);

  useEffect(() => () => {
    if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
  }, []);

  useEffect(() => {
    stickToBottom.current = true;
    updateShowJump(false);
    initialLoadDone.current = false;
    /* 正常路径由 SSE 首帧（全量快照）提供历史，避免挂载 GET 与首帧各传一遍。
       只有连接迟迟没有任何帧时才用完整 GET 兜底。StrictMode 重挂载会清掉旧 timer。 */
    fallbackTimer.current = window.setTimeout(() => {
      fallbackTimer.current = 0;
      if (!initialLoadDone.current && !reloadInFlight.current) void reload();
    }, SSE_FALLBACK_MS);
    return () => {
      clearFallbackTimer();
      cancelReload();
      diffAbort.current?.abort();
      historyAbort.current?.abort();
      historyAbort.current = null;
    };
    // reload/updateShowJump 只依赖 ref 与 setState，切换会话时重新订阅即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /* App's route effect cannot focus the heading while the session is still
     loading, so focus it on the first render that actually has one.
     有审批请求时把焦点留给 Approval 的标题，避免父组件 effect 后跑把它抢走。 */
  useEffect(() => {
    if (!session || titleFocused.current) return;
    titleFocused.current = true;
    if (session.pending) return;
    titleRef.current?.focus();
  }, [session]);

  /* Follow the session title as the conversation is renamed or updated. */
  useEffect(() => {
    if (session) setBaseTitle(`${session.title || "对话"} · ${brand}`, 1);
  }, [session?.title, brand]);

  /* Fetch the project's permission and display name from whichever load first
     supplies the session. A manual save invalidates an in-flight fetch. */
  useEffect(() => {
    const projectId = session?.projectId;
    if (!projectId) return;
    const seq = ++permissionSeq.current;
    setPermission("");
    setProjectName("");
    getProjects()
      .then((data) => {
        if (seq !== permissionSeq.current) return;
        const project = data.projects.find((item) => item.id === projectId);
        setPermission(project?.permission ?? "");
        setProjectName(project?.name ?? "");
      })
      .catch((reason: Error) => {
        if (seq === permissionSeq.current) setError(reason.message);
      });
  }, [session?.projectId]);

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {
      // 设置只用于切换接口/模型；加载失败不阻断对话。
    });
  }, []);

  // 只订阅当前会话的事件；服务端只推这个会话的帧，其他会话的流量不会进来。
  const { status: connection, reconnect } = useEventStream({
    url: `/api/events?session=${encodeURIComponent(sessionId)}`,
    /* 首次加载由 SSE 首帧负责，挂载时另有定时器兜底；open 不抢先发完整 GET。
       只有定时器已经触发过（或重连仍无数据）时才补一次，避免正常路径传两遍。 */
    onOpen: () => {
      if (initialLoadDone.current || reloadInFlight.current || fallbackTimer.current) return;
      void reload();
    },
    handlers: {
      session: (event) => {
        const frame = JSON.parse(event.data) as Session;
        if (frame.id !== sessionId) return;
        if (frame.removed) {
          go("/");
          return;
        }
        // reset 帧会重建本地历史起点；在途的“加载更早”页面可能已错位，直接取消。
        if (frame.reset) {
          historyAbort.current?.abort();
          historyAbort.current = null;
        }
        // SSE 帧（首帧即全量快照）总是比在途 GET 新：作废并在必要时中止它，
        // 避免打开详情时把完整历史传输两遍。
        reloadSeq.current += 1;
        cancelReload();
        clearFallbackTimer();
        initialLoadDone.current = true;
        setSession((previous) => {
          const merged = mergeSessionFrame(previous, frame);
          // 帧可能比在途 POST 旧：服务端还没确认的乐观消息要留在末尾，
          // 否则刚发出的内容会被一帧旧快照冲掉再出现。
          return merged ? reconcileOptimistic(merged, optimisticRef.current) : merged;
        });
      },
    },
  });

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") void reload();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [sessionId]);

  const tail = session?.messages?.at(-1);
  useEffect(() => {
    scrollToBottom();
  }, [session?.updatedAt, session?.messages?.length, tail?.text, session?.phase, session?.subagents.length, session?.pending?.requestId, scrollToBottom]);

  /* 只有用户滚动才允许关闭自动跟随。键盘开着时用户主动滚动，要同步更新锚点，
     否则下一次视口变化会把位置拽回点击输入框之前的旧位置。 */
  const onThreadScroll = useCallback(() => {
    const node = threadRef.current;
    if (!node) return;
    const focus = composerFocus.current;
    if (focus) {
      focus.scrollTop = node.scrollTop;
      focus.atBottom = atExactBottom(node);
    }
    const near = nearBottom(node);
    stickToBottom.current = near;
    updateShowJump(!near);
  }, [updateShowJump]);

  /* 视口、字号、审批面板等尺寸变化只刷新按钮；若原本在跟随，继续保持贴底。
     键盘引起的视口变化按输入框获得焦点时的位置决定：原来真贴底才跟着输入框
     上移，否则钉住原来的滚动位置，正在读的消息不会跟着键盘跑。
     贴底写入和 token 滚动共用同一个 rAF，避免每帧多次强制布局。 */
  function followResize() {
    const node = threadRef.current;
    if (!node) return;
    const focus = composerFocus.current;
    if (focus) {
      if (focus.atBottom) {
        stickToBottom.current = true;
        scrollToBottom();
        updateShowJump(false);
        return;
      }
      if (node.scrollTop !== focus.scrollTop) node.scrollTop = focus.scrollTop;
      updateShowJump(!nearBottom(node));
      return;
    }
    if (stickToBottom.current) {
      scrollToBottom();
      updateShowJump(false);
      return;
    }
    updateShowJump(!nearBottom(node));
  }

  useEffect(() => onVisibleViewportChange(followResize), []);

  /* 键盘弹出/收起会让可见视口连续变化，iPhone 还会另外滚动页面来露出输入框。
     输入框获得焦点时记下当时的滚动位置；收起键盘的 resize 紧跟失焦到达，
     所以延迟清掉锚点，让那次 resize 也按同一个位置处理。输入框内部换焦点
     会在 400ms 内重新触发 focusin 并取消清理。 */
  useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".composer")) return;
      /* 已经记过位置（输入框内部换焦点）时不重新锚定，保住最初的位置。 */
      if (composerFocus.current) {
        window.clearTimeout(composerBlurTimer.current);
        composerBlurTimer.current = 0;
        return;
      }
      const node = threadRef.current;
      if (!node) return;
      composerFocus.current = { scrollTop: node.scrollTop, atBottom: atExactBottom(node) };
    }
    function onFocusOut(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".composer")) return;
      window.clearTimeout(composerBlurTimer.current);
      composerBlurTimer.current = window.setTimeout(() => {
        composerBlurTimer.current = 0;
        composerFocus.current = null;
      }, 400);
    }
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.clearTimeout(composerBlurTimer.current);
    };
  }, []);

  useEffect(() => {
    const node = threadRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => followResize());
    observer.observe(node);
    return () => observer.disconnect();
  }, [session?.id]);

  /* diff 只在用户展开 Diff 行/Git 面板时按需加载，并按 id + updatedAt 缓存：
     进入会话和每轮完成都不再无条件拉取整个 patch。 */
  const diffSeq = useRef(0);
  const diffLoadedKey = useRef("");
  const diffLoadingKey = useRef("");

  const loadDiff = useCallback((id: string, updatedAt: string) => {
    const key = `${id}:${updatedAt}`;
    if (diffLoadedKey.current === key || diffLoadingKey.current === key) return;
    diffAbort.current?.abort();
    const controller = new AbortController();
    diffAbort.current = controller;
    diffLoadingKey.current = key;
    const seq = ++diffSeq.current;
    setDiffLoading(true);
    void (async () => {
      try {
        const data = await getDiff(id, controller.signal);
        if (controller.signal.aborted || seq !== diffSeq.current) return;
        diffLoadedKey.current = key;
        setDiff(data.stat);
        setPatch(data.patch);
        setDiffLoaded(true);
      } catch (reason) {
        if (controller.signal.aborted || seq !== diffSeq.current) return;
        // 失败的 key 也记下来，避免每次展开都重复请求同一个错误。
        diffLoadedKey.current = key;
        setDiff(reason instanceof Error ? reason.message : "无法读取 diff");
        setPatch("");
        setDiffLoaded(true);
      } finally {
        if (!controller.signal.aborted && seq === diffSeq.current) {
          diffLoadingKey.current = "";
          setDiffLoading(false);
        }
      }
    })();
  }, []);

  /* 稳定回调：ToolRow 是 memo 的，避免每个流式 token 都换一个 onOpen。 */
  const onDiffOpen = useCallback(() => {
    const current = sessionRef.current;
    if (current) loadDiff(current.id, current.updatedAt);
  }, [loadDiff]);

  const onDiffToggle = useCallback((open: boolean) => {
    diffOpenRef.current = open;
    if (open) onDiffOpen();
  }, [onDiffOpen]);

  /* 首帧只带最近一页；点“显示更早”时按 historyStart 向前拉一页并 prepend。 */
  const loadEarlier = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || historyLoadingRef.current) return;
    const before = current.historyStart ?? 0;
    if (before <= 0) {
      // 起点已是 0 但仍有隐藏历史（计数与本地不一致）：退回一次完整 GET，
      // 避免“显示更早”按钮点了没有反应。
      if ((current.messageCount ?? 0) > (current.messages?.length ?? 0)) void reload();
      return;
    }
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const controller = new AbortController();
    historyAbort.current = controller;
    try {
      const page = await getSessionMessages(current.id, before, HISTORY_PAGE, controller.signal);
      setSession((previous) => {
        if (!previous || previous.id !== current.id) return previous;
        // 加载期间若收到 reset 帧（历史起点被重置），这一页可能已错位，丢弃。
        if ((previous.historyStart ?? 0) !== before) return previous;
        return prependHistoryPage(previous, page);
      });
    } catch (reason) {
      // 切换会话/卸载时的主动取消不显示为错误。
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "加载更早的消息失败");
      }
    } finally {
      if (historyAbort.current === controller) historyAbort.current = null;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  }, []);

  /* 稳定引用：Thread 可能被 memo，每次渲染新建箭头函数会让优化失效。 */
  const onLoadEarlier = useCallback(() => {
    void loadEarlier();
  }, [loadEarlier]);

  /* 每轮结束（completed/failed/stopped）后让旧 patch 失效；Diff/Git 若仍展开，
     按新的 id+updatedAt 自动重拉，加载期间由 Thread 显示“读取中…”并隐藏旧 patch。
     运行中 updatedAt 会随 token 变化，这里只在终态触发，避免变回逐 token 加载。 */
  useEffect(() => {
    const current = sessionRef.current;
    if (!current) return;
    if (current.phase !== "completed" && current.phase !== "failed" && current.phase !== "stopped") return;
    diffLoadedKey.current = "";
    setDiffLoaded(false);
    if (diffOpenRef.current || showGitRef.current) loadDiff(current.id, current.updatedAt);
  }, [session?.updatedAt, session?.phase, loadDiff]);

  function toggleGit() {
    const next = !showGit;
    setShowGit(next);
    if (next) onDiffOpen();
  }

  /* Composer 是 memo 组件：流式输出期间这些回调必须保持引用稳定。
     interject 为 true 表示插话（Ctrl+Enter / 长按发送），否则排队。 */
  const onSend = useCallback(async (event: FormEvent, interject = false) => {
    event.preventDefault();
    if (operationBusyRef.current) return;
    if ((!prompt.trim() && attachments.images.length === 0 && attachments.texts.length === 0) || attachments.busy) return;
    operationBusyRef.current = true;
    setSending(true);
    setError("");
    const text = mergeTextAttachments(prompt, attachments.texts);
    /* 清空输入区要用的快照；发送失败时据此恢复，用户可以直接重发。 */
    const draftText = prompt;
    const draftImages = attachments.images;
    const draftTexts = attachments.texts;
    // 正文末尾的 token 在本地立即生效：切换发送区选项，并作为显式 workflow
    // 随请求发出，不依赖服务端等 agent 消费 prompt 后再识别。
    const detected = detectWorkflowSkill(prompt);
    const workflow = detected ?? (workflowMode || undefined);
    if (detected) setWorkflowMode(detected);
    /* 先把这条消息画进记录，再发请求：POST 往返 + SSE 回显期间的空白不再出现。
       条目带 status = "sending"，由服务端返回的真实条目替换。 */
    const current = sessionRef.current;
    const optimistic = current ? beginOptimisticSend(current, text, draftImages) : null;
    if (optimistic) {
      optimisticRef.current = optimistic;
      setSession((previous) => (previous ? appendOptimistic(previous, optimistic.item) : previous));
      draft.clearDraft();
      attachments.clear();
    }
    try {
      const data = await sendMessage(
        sessionId,
        text,
        draftImages.length > 0 ? draftImages : undefined,
        undefined,
        workflow,
        interject,
      );
      optimisticRef.current = null;
      setSession(data.session);
      attachments.clear();
      draft.clearDraft();
    } catch (reason) {
      // 失败：撤掉临时条目并把内容放回输入区（若服务端其实已落库，SSE 会带来真实条目）。
      if (optimistic) {
        optimisticRef.current = null;
        setSession((previous) => (previous ? dropOptimistic(previous, optimistic.item.id) : previous));
        // 发送期间用户可能已经在输入新内容；只补回空白的输入框，不覆盖新输入。
        setPrompt((current) => (current.trim() ? current : draftText));
        attachments.restoreImages(draftImages);
        attachments.restoreTexts(draftTexts);
      }
      setError(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      operationBusyRef.current = false;
      setSending(false);
    }
  }, [attachments, draft.clearDraft, prompt, sessionId, setPrompt, workflowMode]);

  /* 用户消息的回滚 / 编辑重发 / 分叉共用 busy：同步 ref 挡重复点击，
     state 让菜单项和编辑器按钮一起禁用。 */
  const beginMessageAction = useCallback((): boolean => {
    /* 发送/「继续上次」在途时不再回滚：乐观消息会被已删除的记录复活。 */
    if (operationBusyRef.current) return false;
    operationBusyRef.current = true;
    setMessageBusy(true);
    setError("");
    return true;
  }, []);

  const endMessageAction = useCallback(() => {
    operationBusyRef.current = false;
    setMessageBusy(false);
  }, []);

  /* 回滚/分叉的前置选择已经由气泡旁的内联面板完成，这里直接执行请求。 */
  const onRewindMessage = useCallback(async (item: Transcript, files: boolean) => {
    if (!sessionRef.current || !beginMessageAction()) return;
    try {
      const result = await rewindSession(sessionId, item.id, files);
      setSession(result.session);
      /* 不覆盖用户已经输入的草稿；纯回滚只回填文本，不挂载服务端图片。 */
      setPrompt((value) => rewindComposerRefill(value, result.prompt.text) ?? value);
      setMessageNotice("已回滚到这条消息之前");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "回滚失败");
    } finally {
      endMessageAction();
    }
  }, [beginMessageAction, endMessageAction, sessionId, setPrompt]);

  const onEditMessage = useCallback(async (
    item: Transcript,
    text: string,
    choice: { fork: boolean; files: boolean },
  ): Promise<boolean> => {
    /* 纯图片消息允许空文本；服务端按 keepImages 复用原消息图片。 */
    if (
      !sessionRef.current
      || !canSubmitMessageEdit(text, item.images?.length ?? 0)
      || !beginMessageAction()
    ) return false;
    try {
      const options = {
        prompt: text,
        /* 图片按原消息的 ref 交给服务端复用，输入框不会再上传一遍。 */
        keepImages: item.images && item.images.length > 0 ? item.images : undefined,
        workflow: detectWorkflowSkill(text) ?? undefined,
      };
      if (choice.fork) {
        const forked = await forkSession(sessionId, item.id);
        const forkedId = forked.session.id;
        try {
          await rewindSession(forkedId, item.id, false, options);
        } catch (reason) {
          /* 新分叉没被使用，删掉避免留下半成品；编辑内容仍留在原会话编辑器里。 */
          deleteSession(forkedId).catch(() => undefined);
          const detail = reason instanceof Error ? reason.message : "未知错误";
          setError(`分叉后重新发送失败：${detail}`);
          return false;
        }
        go("/sessions/" + forkedId);
        return true;
      }
      const result = await rewindSession(sessionId, item.id, choice.files, options);
      setSession(result.session);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重新发送失败");
      return false;
    } finally {
      endMessageAction();
    }
  }, [beginMessageAction, endMessageAction, go, sessionId]);

  const onForkMessage = useCallback(async (item: Transcript) => {
    if (!beginMessageAction()) return;
    try {
      const result = await forkSession(sessionId, item.id);
      go("/sessions/" + result.session.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "分叉失败");
    } finally {
      endMessageAction();
    }
  }, [beginMessageAction, endMessageAction, go, sessionId]);

  /* 「继续上次」也是发送路径：和 Composer/消息操作共用同一个同步 guard，
     成功时仍由 useSessionActions 更新会话，不改变原有行为。 */
  const onContinueLast = useCallback(async () => {
    if (operationBusyRef.current) return;
    operationBusyRef.current = true;
    try {
      await actions.continueLast();
    } finally {
      operationBusyRef.current = false;
    }
  }, [actions]);

  /* 多模型讨论：提交参与模型并开始一轮讨论。讨论本身在服务端串行调用模型，
     每一轮发言通过 SSE 追加到对话记录。 */
  const onStartDiscussion = useCallback(async (participants: DiscussionParticipant[]) => {
    const data = await startDiscussion(sessionId, participants);
    setSession(data.session);
  }, [sessionId]);

  async function onAnswer(
    behavior: "allow" | "deny",
    answers?: Record<string, string>,
    remember?: boolean,
    approvedFull?: boolean,
  ) {
    if (!session?.pending || answeringRef.current) return;
    answeringRef.current = true;
    setAnswering(true);
    setError("");
    try {
      const data = await answerSession(
        sessionId,
        answerBody(session.pending, behavior, answers, remember, approvedFull),
      );
      setSession(data.session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败");
    } finally {
      answeringRef.current = false;
      setAnswering(false);
    }
  }

  const onStop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setError("");
    try {
      const data = await stopSession(sessionId);
      setSession(data.session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停止失败");
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [sessionId]);

  function jumpToBottom() {
    stickToBottom.current = true;
    updateShowJump(false);
    scrollToBottom();
  }

  const onConfigChange = useCallback(async (patch: { providerId?: string; model?: string; effort?: Effort }) => {
    try {
      const data = await patchSession(sessionId, patch);
      setSession(data.session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法切换配置");
    }
  }, [sessionId]);

  /* 一轮结束后重新允许失败提示；运行中/完成时不显示。 */
  useEffect(() => {
    if (session?.phase !== "failed" && session?.phase !== "stopped") setFailureDismissed(false);
  }, [session?.phase]);

  /* 接口/模型/思考强度从原来的独立配置行挪进输入框 chips；memo 稳定引用。 */
  const detailChips = useMemo(() => {
    if (!session) return null;
    const provider = settings?.providers.find((item) => item.id === session.providerId);
    const models = provider && provider.models.length > 0 ? provider.models : [session.model];
    const providerOptions = (settings?.providers ?? []).map((item) => ({ value: item.id, label: item.name }));
    if (!settings || settings.providers.every((item) => item.id !== session.providerId)) {
      providerOptions.unshift({ value: session.providerId, label: session.providerName || "已删除的接口" });
    }
    const modelOptions = models.map((item) => ({ value: item, label: item }));
    const changeProvider = (providerId: string) => {
      const next = settings?.providers.find((item) => item.id === providerId);
      void onConfigChange({ providerId, model: next?.models[0] ?? session.model });
    };
    const changeModel = (model: string) => void onConfigChange({ model });
    const changeEffort = (effort: string) => void onConfigChange({ effort: effort as Effort });
    const changePermission = (next: string) => {
      // 用户手动保存后，丢弃仍在途的项目权限拉取；连续保存只认最新响应。
      const seq = ++permissionSeq.current;
      saveProjectPermission(session.projectId, next as PermissionLevel)
        .then((saved) => {
          if (seq === permissionSeq.current) setPermission(saved.project.permission);
        })
        .catch((reason) => setError(reason instanceof Error ? reason.message : "无法保存授权级别"));
    };
    return (
      <>
        <ChipSelect
          ariaLabel="工作流"
          className="wf-mode"
          value={workflowMode}
          options={WORKFLOW_OPTIONS}
          onChange={(next) => setWorkflowMode(next as WorkflowSkill | "")}
        />
        <div className="composer-config-inline">
          <ChipSelect
            ariaLabel="接口"
            value={session.providerId}
            options={providerOptions}
            onChange={changeProvider}
          />
          <ChipSelect
            ariaLabel="模型"
            value={session.model}
            placeholder="模型"
            disabled={!session.model}
            options={modelOptions}
            onChange={changeModel}
          />
        </div>
        <ChipSelect
          ariaLabel="思考强度"
          title={EFFORT_DESCRIPTION[session.effort]}
          value={session.effort}
          placeholder="思考强度"
          disabled={!session.effort}
          options={EFFORT_OPTIONS}
          onChange={changeEffort}
        />
        <div className="composer-config-inline">
          <ChipSelect
            ariaLabel="授权"
            value={permission || ""}
            placeholder="授权"
            disabled={!permission}
            options={PERMISSION_OPTIONS}
            onChange={changePermission}
          />
        </div>
        <div className="composer-config-drawer">
          <ComposerConfig
            groups={[
              {
                label: "接口",
                value: session.providerId,
                options: providerOptions,
                onChange: changeProvider,
              },
              {
                label: "模型",
                value: session.model,
                options: modelOptions,
                disabled: !session.model,
                onChange: changeModel,
              },
              {
                label: "授权",
                value: permission || "",
                options: PERMISSION_OPTIONS,
                disabled: !permission,
                onChange: changePermission,
              },
            ]}
          />
        </div>
      </>
    );
  }, [
    session?.providerId,
    session?.providerName,
    session?.model,
    session?.effort,
    session?.projectId,
    settings,
    permission,
    onConfigChange,
    workflowMode,
  ]);

  async function onDelete() {
    if (!session) return;
    const confirmed = await dialogs.confirm({
      title: "归档对话",
      message: `归档这个对话？\n\n${deleteDetail(session)}。${ARCHIVE_RESTORE_NOTE}`,
      confirmLabel: "归档",
      danger: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    setError("");
    try {
      await deleteSession(sessionId);
      go(`/projects/${session.projectId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档失败");
    } finally {
      setDeleting(false);
    }
  }

  if (!session) {
    return (
      <section className="chat">
        <ConnectionBanner status={connection} onRetry={reconnect} />
        {error
          ? (
            <ErrorState
              message={error}
              onRetry={() => {
                setError("");
                void reload();
              }}
            />
          )
          : <PageLoading label="正在加载对话" />}
      </section>
    );
  }

  const active = session.phase === "queued" || session.phase === "running" || session.phase === "needs_input";
  /* 轮次刚落定但还有排队消息没被取走时，Enter 仍然是排队语义。 */
  const queueMode = active || Boolean(session.queue && session.queue.length > 0);
  const continueBusy = actions.busy === "continue";
  /* 后台 shell 任务运行时不改变 phase（仍是 completed），但服务端会拒绝
     回滚/分叉；菜单要按这里一起隐藏。 */
  const backgroundBusy = hasRunningBackgroundTasks(session.backgroundTasks);
  /* 讨论运行中不能在会话里再发消息：服务端会拒绝，输入框先禁用。 */
  const discussionRunning = session.discussion?.phase === "running";
  const canSend = Boolean(
    (prompt.trim() || attachments.images.length > 0 || attachments.texts.length > 0)
      && !attachments.busy
      && !sending
      /* 回滚/编辑重发/分叉/继续上次进行中不能并发发送。 */
      && !messageBusy
      && !continueBusy
      && !discussionRunning,
  );

  return (
    <section className="chat">
      <div className="chat-head">
        <button className="text-btn" onClick={() => go(`/projects/${session.projectId}`)}>返回</button>
        <div className="chat-title" tabIndex={-1} ref={titleRef}>
          <div className="chat-title-head">
            {session.branch && <BranchBadge branch={session.branch} />}
            <strong>{session.title}</strong>
          </div>
          <span className="chat-sub" title={session.branch || session.cwd}>
            <span className="chat-sub-project">{projectName || session.projectId}</span>
          </span>
        </div>
        <span className="phase-label" data-phase={session.phase} aria-live="polite">{PHASE_LABEL[session.phase]}</span>
        <div className="density-toggle" role="group" aria-label="对话展开程度">
          {DENSITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="density-option"
              data-on={density === option.value}
              aria-pressed={density === option.value}
              title={option.hint}
              onClick={() => setDensity(option.value)}
            >{option.label}</button>
          ))}
        </div>
        <SessionActionsMenu
          session={session}
          actions={{ ...actions, continueLast: onContinueLast }}
          gitOpen={showGit}
          onToggleGit={toggleGit}
          onDelete={() => void onDelete()}
          deleting={deleting}
          externallyLocked={messageBusy || sending}
        />
      </div>
      <ConnectionBanner status={connection} onRetry={reconnect} />
      {showGit && <GitPanel sessionId={session.id} git={session.git} onError={setError} />}
      <div className="thread-wrap">
        <Thread
          session={session}
          density={density}
          scrollRef={threadRef}
          onScroll={onThreadScroll}
          stickRef={stickToBottom}
          onLoadEarlier={onLoadEarlier}
          historyLoading={historyLoading}
          messageBusy={messageBusy}
          sending={sending}
          continuing={continueBusy}
          backgroundBusy={backgroundBusy}
          onRewindMessage={onRewindMessage}
          onEditMessage={onEditMessage}
          onForkMessage={onForkMessage}
        />
        {showJump && (
          <button type="button" className="jump-bottom" onClick={jumpToBottom} aria-label="回到底部">
            回到底部
          </button>
        )}
      </div>
      {session.pending && (
        <Approval pending={session.pending} onAnswer={onAnswer} busy={answering} />
      )}
      {(session.phase === "failed" || session.phase === "stopped") && !failureDismissed && (
        <Notice
          tone={session.phase === "failed" ? "error" : "warn"}
          className="failure-notice"
          onDismiss={() => setFailureDismissed(true)}
          action={{
            label: "继续上次",
            /* 与其他会话操作共用 busy：改名/置顶/导出/删除/发送/消息操作期间不能并发发送。 */
            busy: actions.busy !== "" || deleting || sending || messageBusy,
            onClick: () => void onContinueLast(),
          }}
        >
          {session.phase === "failed"
            ? (session.lastError ? `上一轮失败：${session.lastError}` : "上一轮失败，可以继续上次。")
            : "上一轮已停止，可以继续上次。"}
        </Notice>
      )}
      {error && (
        <Notice tone="error" className="dock-notice" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
      {messageNotice && (
        <Notice tone="info" className="dock-notice" onDismiss={() => setMessageNotice("")}>
          {messageNotice}
        </Notice>
      )}
      {draft.restored && (
        <Notice tone="info" className="draft-notice" onDismiss={draft.dismissRestored}>
          已恢复上次未发送的草稿
        </Notice>
      )}
      {session.discussion && (
        session.workflow?.skill === "discuss"
        || session.workflow?.skill === "dis-prl"
        || session.phase === "setup"
      ) && (
        <DiscussionPanel
          /* 阶段或开始时间变化时重挂载，让本地编辑表单重新读入服务端保存的参与者。 */
          key={session.id + ":" + session.discussion.phase + ":" + (session.discussion.startedAt ?? "")}
          session={session}
          providers={settings?.providers ?? []}
          onStart={onStartDiscussion}
          onError={setError}
        />
      )}
      <WorkflowDock
        key={session.id + ":" + (session.workflow?.startedAt ?? "")}
        session={session}
      />
      {/* 输入框上方的固定栈自上而下：工作流/子任务进度 → 当前改动 → 排队/其他。 */}
      {session.git !== false && (
        <DiffDock
          diff={diff}
          patch={diffLoading ? "" : patch}
          cwd={session.cwd}
          sessionId={session.id}
          loaded={diffLoaded}
          loading={diffLoading}
          onToggle={onDiffToggle}
        />
      )}
      <QueuePanel session={session} onChange={handleSessionChange} />
      <Composer
        onSubmit={onSend}
        value={prompt}
        setValue={setPrompt}
        placeholder="继续这个对话，可粘贴图片/文件"
        canSend={canSend}
        sendLabel={queueMode ? "排队发送" : "发送"}
        textareaRef={inputRef}
        attachments={attachments}
        chips={detailChips}
        active={queueMode}
        voiceDisabled={attachments.busy}
        attachDisabled={attachments.busy}
        onError={setError}
        onStop={active ? onStop : undefined}
        stopDisabled={stopping}
      />
    </section>
  );
}

function toneForPhase(phase: Phase): string {
  if (phase === "completed") return "ok";
  if (phase === "failed") return "bad";
  if (phase === "stopped") return "stop";
  if (phase === "running") return "run";
  if (phase === "needs_input" || phase === "setup") return "wait";
  return "queue";
}

/** 会话行的阶段标记：本轮完成显示绿色对勾，其余仍是状态圆点。 */
function PhaseMark({ phase }: { phase: Phase }) {
  if (phase === "completed") {
    return (
      <svg className="phase-check" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M2.4 6.4 4.9 8.9 9.6 3.3" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return <i className="dot" data-tone={toneForPhase(phase)} />;
}
