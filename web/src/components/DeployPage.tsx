import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { PERMISSIONS, PERMISSION_LABEL, writeApiToken } from "../api";
import {
  applyDeploy,
  deployBusyKind,
  deployResidualPids,
  getConfigToken,
  getDeployState,
  getDeployStatus,
  getGithubVersion,
  isDataDirChangeError,
  isDeployBusyError,
  isDeployResidualError,
  resetAuthToken as resetAuthTokenApi,
  resetLanPassword as resetLanPasswordApi,
  saveGithubRepo,
  updateDeploy,
  type DeployForm,
  type DeployJob,
  type DeployOneTimeInfo,
  type DeployPermission,
  type DeployProject,
  type DeployState,
  type GithubVersionState,
} from "../api-deploy";
import {
  DEFAULT_PUBLIC_HOST,
  DEFAULT_PUBLIC_HOST_SECONDARY,
  HOST_RE,
  prepareWizardForm,
  type DeployPhase,
  type WizardMode,
} from "../deploy-wizard";
import { pathIsAbsolute } from "../deploy-path";
import { Dialog, Notice, useDialogs } from "../ui";
import { DeployWizard } from "./DeployWizard";
import { EdgePanel } from "./EdgePanel";
import { Hint } from "./FieldHint";
import { PushSettings } from "./PushSettings";
import "./DeployPage.css";

/* 浏览器 fetch 失败时往往只给出英文 TypeError（Chrome: Failed to fetch，
   Safari: Load failed），统一换成中文后再展示。 */
const NETWORK_ERROR_PATTERN = /failed to fetch|load failed|networkerror|network error|fetch failed|internet connection appears to be offline/i;

function readableError(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback;
  const message = reason.message.trim();
  if (!message) return fallback;
  if (NETWORK_ERROR_PATTERN.test(message)) return "网络连接失败，请检查网络后重试。";
  return message;
}

const ROLE_LABEL: Record<DeployState["role"], string> = {
  primary: "主实例",
  secondary: "副实例",
};

const JOB_STATE_LABEL: Record<DeployJob["state"], string> = {
  running: "运行中",
  success: "成功",
  failed: "失败",
};

const GITHUB_STATUS_LABEL: Record<GithubVersionState["status"], string> = {
  same: "与当前一致",
  behind: "落后于当前",
  ahead: "比当前新",
  unknown: "无法对照",
};

/** GitHub 拉取失败时优先显示原因，成功时显示与当前版本的关系。 */
function githubVersionLabel(info: GithubVersionState | null): string {
  if (!info) return "检查中…";
  if (info.error) return info.error;
  return GITHUB_STATUS_LABEL[info.status];
}

function githubVersionStatus(info: GithubVersionState | null): "same" | "different" | "unknown" {
  if (!info || info.error) return "unknown";
  if (info.status === "same") return "same";
  if (info.status === "unknown") return "unknown";
  return "different";
}

/** 一次部署从提交到结束的本地阶段；与服务端 job.state 区分开。 */
type Phase = DeployPhase;

/** 用户选择完整表单后，本标签页内不再自动弹回向导。 */
const WIZARD_SKIP_KEY = "qubius.deploy.skip-wizard";

const POLL_INTERVAL_MS = 2000;
/** 服务端按新配置重启时，持续尝试读取任务状态的时长。 */
const RESTART_WAIT_MS = 90_000;
/** 当前端口不会被新配置继续监听时，连续失败这么多次（约 8 秒）就提示新地址。 */
const RELOCATE_FAILURES = 4;
const RELOAD_DELAY_MS = 1500;

function cloneForm(form: DeployForm): DeployForm {
  return {
    ...form,
    projects: form.projects.map((project) => ({
      ...project,
      // 兼容还没有 isolated 字段的旧服务端；提交时始终带上布尔值。
      isolated: project.isolated === true,
    })),
  };
}

function blankProject(): DeployProject {
  return { id: "", name: "", path: "", permission: "acceptEdits", isolated: false };
}

function withScheme(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** 旧服务端可能没有 state.port：退回页面 origin 的端口做近似判断。 */
function currentOriginPort(): number {
  if (window.location.port) return Number(window.location.port);
  return window.location.protocol === "https:" ? 443 : 80;
}

/** 本次配置里会继续监听的端口。 */
function enabledPortsOf(form: DeployForm | null): number[] {
  const ports: number[] = [];
  if (form?.startPrimary) ports.push(form.primaryPort);
  if (form?.startSecondary) ports.push(form.secondaryPort);
  return ports;
}

/** 启用的实例没填公网域名时用默认值；未启用的实例保持原样。 */
function effectivePublicHosts(form: DeployForm): { publicHost: string; publicHostSecondary: string } {
  return {
    publicHost: form.startPrimary
      ? (form.publicHost.trim() || DEFAULT_PUBLIC_HOST)
      : form.publicHost.trim(),
    publicHostSecondary: form.startSecondary
      ? (form.publicHostSecondary.trim() || DEFAULT_PUBLIC_HOST_SECONDARY)
      : form.publicHostSecondary.trim(),
  };
}

/** 本机入口已经由 127.0.0.1 的链接覆盖，不再重复展示 https://localhost。 */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function endpointsFor(form: DeployForm): { label: string; url: string }[] {
  const hosts = effectivePublicHosts(form);
  const links: { label: string; url: string }[] = [];
  if (form.startPrimary) {
    links.push({ label: "本机主实例", url: `http://127.0.0.1:${form.primaryPort}` });
    if (!isLoopbackHost(hosts.publicHost)) {
      links.push({ label: "主实例公网地址", url: withScheme(hosts.publicHost) });
    }
  }
  if (form.startSecondary) {
    links.push({ label: "本机副实例", url: `http://127.0.0.1:${form.secondaryPort}` });
    if (!isLoopbackHost(hosts.publicHostSecondary)) {
      links.push({ label: "副实例公网地址", url: withScheme(hosts.publicHostSecondary) });
    }
  }
  return links;
}

/* 与服务端 validateDeployForm 对齐的基本校验；更细的目录存在性检查交给服务端。
   公网域名默认值和 HOST_RE 与部署向导共用 ../deploy-wizard.ts。 */
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;

/** 表单里可定位的区块；校验失败时滚过去并聚焦第一个输入。 */
type DeploySection = "scope" | "primary" | "secondary" | "repo" | "general" | "projects";

const SECTION_ID: Record<DeploySection, string> = {
  scope: "deploy-section-scope",
  primary: "deploy-section-primary",
  secondary: "deploy-section-secondary",
  repo: "deploy-section-repo",
  general: "deploy-section-general",
  projects: "deploy-section-projects",
};

interface ValidationFailure {
  message: string;
  section: DeploySection;
}

function invalid(message: string, section: DeploySection): ValidationFailure {
  return { message, section };
}

function validate(form: DeployForm): ValidationFailure | null {
  if (!form.startPrimary && !form.startSecondary) return invalid("请至少启动一个实例。", "scope");

  const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;
  if (!validPort(form.primaryPort)) return invalid("主实例端口必须是 1–65535 的整数。", "primary");
  if (!validPort(form.secondaryPort)) return invalid("副实例端口必须是 1–65535 的整数。", "secondary");
  if (form.startPrimary && form.startSecondary && form.primaryPort === form.secondaryPort) {
    return invalid("主实例和副实例的端口不能相同。", "scope");
  }

  const hosts = effectivePublicHosts(form);
  if (form.startPrimary && !HOST_RE.test(hosts.publicHost)) {
    return invalid("主实例公网域名只能包含小写字母、数字、点和连字符。", "primary");
  }
  if (form.startSecondary && !HOST_RE.test(hosts.publicHostSecondary)) {
    return invalid("副实例公网域名只能包含小写字母、数字、点和连字符。", "secondary");
  }
  if (form.startPrimary && form.startSecondary && hosts.publicHost === hosts.publicHostSecondary) {
    return invalid("主实例和副实例不能使用同一个公网域名。", "scope");
  }

  if (!pathIsAbsolute(form.configDir)) return invalid("配置目录必须是绝对路径。", "general");
  if (!pathIsAbsolute(form.primaryDir)) return invalid("主实例 checkout 路径必须是绝对路径。", "primary");
  if (!pathIsAbsolute(form.secondaryDir)) return invalid("副实例 checkout 路径必须是绝对路径。", "secondary");
  if (!pathIsAbsolute(form.dataPrimary)) return invalid("主实例数据目录必须是绝对路径。", "primary");
  if (!pathIsAbsolute(form.dataSecondary)) return invalid("副实例数据目录必须是绝对路径。", "secondary");
  if (form.archiveDir.trim() && !pathIsAbsolute(form.archiveDir)) {
    return invalid("归档目录必须是绝对路径，或留空。", "general");
  }

  // 副实例与主实例共用同一个仓库，界面只保留一个地址。
  if ((form.startPrimary || form.startSecondary) && !/^https?:\/\//.test(form.primaryRepoUrl.trim())) {
    return invalid("仓库 URL 必须以 http:// 或 https:// 开头。", "repo");
  }
  if (!form.primaryRef.trim()) return invalid("同步分支不能为空。", "secondary");
  if (!REF_RE.test(form.primaryRef.trim())) {
    return invalid("同步分支只能包含字母、数字、点、下划线、斜杠和连字符。", "secondary");
  }

  if (!Number.isInteger(form.archiveRetentionDays) || form.archiveRetentionDays < 1 || form.archiveRetentionDays > 3650) {
    return invalid("列表保留天数必须在 1 到 3650 之间；到期后会话归档到冷存储并永久保留。", "general");
  }

  const ids = new Set<string>();
  for (const project of form.projects) {
    const id = project.id.trim();
    if (!PROJECT_ID_RE.test(id)) return invalid("额外项目的 id 只能用小写字母、数字和连字符。", "projects");
    if (id === "qubius" || id === "co-qubius") {
      return invalid(`额外项目的 id 不能是 ${id}：会和自动加入的对端项目冲突。`, "projects");
    }
    if (ids.has(id)) return invalid(`额外项目的 id 重复：${id}`, "projects");
    ids.add(id);
    if (!project.name.trim()) return invalid(`额外项目 ${id} 的名称不能为空。`, "projects");
    if (!project.path.trim()) return invalid(`额外项目 ${id} 的路径不能为空。`, "projects");
    if (!pathIsAbsolute(project.path)) {
      return invalid(`额外项目 ${id} 的路径必须是绝对路径。`, "projects");
    }
  }
  return null;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.6" />
      <path d="M10.8 5.2V3.6A1.6 1.6 0 0 0 9.2 2H3.6A1.6 1.6 0 0 0 2 3.6v5.6a1.6 1.6 0 0 0 1.6 1.6h1.6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5 6.4 12 13 4.8" />
    </svg>
  );
}

function CopyButton({ value, label = "" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    if (!(await copyToClipboard(value))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      className="icon-btn"
      title={copied ? "已复制" : "复制"}
      aria-label={copied ? "已复制" : `复制${label}`}
      onClick={onCopy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

interface ResetSecret {
  title: string;
  value: string;
  urls?: string[];
  hint: string;
}

function SecretDialog({ secret, onDismiss }: { secret: ResetSecret; onDismiss: () => void }) {
  return (
    <Dialog
      open
      wide
      showActions={false}
      title={secret.title}
      description={secret.hint}
      onConfirm={() => {}}
      onClose={onDismiss}
    >
      {secret.urls && secret.urls.length > 0 && (
        <dl className="deploy-once-list">
          {secret.urls.map((url) => (
            <div key={url}>
              <dt>访问地址</dt>
              <dd>
                <code className="mono">{url}</code>
                <CopyButton value={url} label="访问地址" />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="deploy-once-token">
        <code className="mono">{secret.value}</code>
        <CopyButton value={secret.value} label={secret.title} />
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onDismiss}>关闭</button>
      </div>
    </Dialog>
  );
}

function TextField({ label, value, placeholder, className, type = "text", disabled, hint, action, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
  type?: "text" | "password";
  disabled?: boolean;
  hint?: string;
  action?: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <label className={className ? `field ${className}` : "field"}>
      <span className="field-label">{label}{hint && <Hint text={hint} />}</span>
      <span className={action ? "field-control" : undefined}>
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        {action}
      </span>
    </label>
  );
}

function NumberField({ label, value, min, hint, onChange }: {
  label: string;
  value: number;
  min?: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <Hint text={hint} />}</span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(event) => onChange(event.target.value === "" ? 0 : Number(event.target.value))}
      />
    </label>
  );
}

const ONE_TIME_STORAGE_KEY = "qubius.deploy.one-time";

/** 一次性凭据跨部署后的自动刷新保留；关闭时清除。 */
function readOneTimeInfo(): DeployOneTimeInfo | null {
  try {
    const raw = window.sessionStorage.getItem(ONE_TIME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeployOneTimeInfo;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function storeOneTimeInfo(info: DeployOneTimeInfo): void {
  try {
    window.sessionStorage.setItem(ONE_TIME_STORAGE_KEY, JSON.stringify(info));
  } catch {
    // 隐私模式/存储禁用时只保留当前页面状态。
  }
}

function clearOneTimeInfo(): void {
  try {
    window.sessionStorage.removeItem(ONE_TIME_STORAGE_KEY);
  } catch {
    // 忽略。
  }
}

/** 局域网是 HTTP，navigator.clipboard 在非安全上下文不可用时回退到 execCommand。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走回退方案。
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function OneTimeCredentials({
  info,
  onDismiss,
}: {
  info: DeployOneTimeInfo;
  onDismiss: () => void;
}) {
  const token = info.authToken;
  return (
    <Dialog
      open
      wide
      showActions={false}
      title="部署凭据（只显示这一次）"
      description={(
        <>
          部署完成后生效。密码和访问令牌不会再次弹出；关闭后如需找回，请查看配置目录的
          <span className="mono"> lan-proxy.credentials</span>，以及 env 文件或数据目录的
          <span className="mono"> auth-token</span>。
        </>
      )}
      onConfirm={() => {}}
      onClose={onDismiss}
    >
      {info.lan && (
        <dl className="deploy-once-list">
          {info.lan.urls.map((url) => (
            <div key={url}>
              <dt>访问地址</dt>
              <dd>
                <code className="mono">{url}</code>
                <CopyButton value={url} label="访问地址" />
              </dd>
            </div>
          ))}
          <div>
            <dt>用户名</dt>
            <dd>
              <code className="mono">{info.lan.user}</code>
              <CopyButton value={info.lan.user} label="用户名" />
            </dd>
          </div>
          <div>
            <dt>登录密码</dt>
            <dd>
              <code className="mono">{info.lan.password}</code>
              <CopyButton value={info.lan.password} label="登录密码" />
            </dd>
          </div>
        </dl>
      )}
      {token && (
        <div className="deploy-once-token">
          <span>API 访问令牌</span>
          <code className="mono">{token}</code>
          <CopyButton value={token} label="API 访问令牌" />
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onDismiss}>我已保存，关闭</button>
      </div>
    </Dialog>
  );
}

export function DeployPage() {
  const dialogs = useDialogs();
  const [deployState, setDeployState] = useState<DeployState | null>(null);
  /** GitHub 镜像版本与当前版本对照；拉取失败也保留对象，显示失败原因。 */
  const [githubVersion, setGithubVersion] = useState<GithubVersionState | null>(null);
  /** 部署页可直接保存的 GitHub 镜像地址（owner/repo；空串自动识别）。 */
  const [githubRepoInput, setGithubRepoInput] = useState("");
  const [savingGithubRepo, setSavingGithubRepo] = useState(false);
  const [githubRepoError, setGithubRepoError] = useState("");
  const [githubRepoNotice, setGithubRepoNotice] = useState("");
  const [form, setForm] = useState<DeployForm | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<DeployJob | null>(null);
  const [formError, setFormError] = useState("");
  const [reloading, setReloading] = useState(false);
  /** 部署后服务端口与当前页面端口不同：旧地址已无服务，不能自动刷新。 */
  const [portChanged, setPortChanged] = useState(false);
  /** 本次提交（或加载时正在运行）的表单，用于展示新地址链接。 */
  const [submittedForm, setSubmittedForm] = useState<DeployForm | null>(null);
  /** 首次运行（还没有配置文件）时进入分步向导；之后仍可用完整表单。 */
  const [showWizard, setShowWizard] = useState(false);
  /** 向导文案按入口区分：首次部署，或已有配置时从向导重新部署。 */
  const [wizardMode, setWizardMode] = useState<WizardMode>("setup");
  /** 重新部署成功后再点「重新配置」时换 key，强制向导回到第一步。 */
  const [wizardKey, setWizardKey] = useState(0);
  /** 轮询回调里判断是否向导模式，避免成功后自动刷新丢掉「下一步」提示。 */
  const wizardRef = useRef(false);
  useEffect(() => {
    wizardRef.current = showWizard;
  }, [showWizard]);

  /** 校验失败时按 section 找到 fieldset，滚动并聚焦。 */
  const sectionRefs = useRef<Partial<Record<DeploySection, HTMLElement | null>>>({});

  const mounted = useRef(true);
  const pollTimer = useRef(0);
  /** 轮询循环是否还在进行；页面重新可见时据此决定要不要立刻补一次。 */
  const pollActive = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const submitAbort = useRef<AbortController | null>(null);
  const reloadTimer = useRef(0);
  /** 0 表示当前不在「等待服务恢复」窗口内。 */
  const restartDeadline = useRef(0);
  /** 本次提交（或加载时正在运行）的任务 id；用来忽略 configDir 里的旧任务。 */
  const activeJobId = useRef("");
  /** 当前服务进程实际监听的端口（来自 DeployState.port）。 */
  const servicePort = useRef(0);
  /** 本次配置会继续监听的端口，用来判断当前页面重启后是否还可用。 */
  const submittedPorts = useRef<number[]>([]);
  /** 轮询连续失败次数，用于「当前端口将不再监听」时提前收尾。 */
  const pollFailures = useRef(0);

  /** 重置密码/令牌后的一次性展示；不落盘，关闭即清除。 */
  const [resetSecret, setResetSecret] = useState<ResetSecret | null>(null);
  /** 正在重置的类型，用来禁用对应按钮并显示进度。 */
  const [resetting, setResetting] = useState<"lan" | "token" | null>(null);

  /** 部署响应里的一次性凭据；跨自动刷新保留，关闭后清除。 */
  const [oneTime, setOneTime] = useState<DeployOneTimeInfo | null>(() => readOneTimeInfo());
  /** 供轮询回调读取，避免一次性凭据还没保存完就自动刷新。 */
  const oneTimeRef = useRef<DeployOneTimeInfo | null>(oneTime);
  function dismissOneTime() {
    clearOneTimeInfo();
    oneTimeRef.current = null;
    setOneTime(null);
  }

  /** 部署页直接显示当前令牌；登录框之外不用再去数据目录翻 auth-token。 */
  const [revealedToken, setRevealedToken] = useState("");
  const [tokenError, setTokenError] = useState("");
  async function onRevealToken() {
    setTokenError("");
    try {
      const result = await getConfigToken();
      setRevealedToken(result.token);
    } catch (reason) {
      setTokenError(readableError(reason, "读取访问令牌失败"));
    }
  }

  function setPhaseSafe(next: Phase) {
    setPhase(next);
  }

  function stopPolling() {
    pollActive.current = false;
    window.clearTimeout(pollTimer.current);
    pollTimer.current = 0;
    pollAbort.current?.abort();
    pollAbort.current = null;
  }

  function schedulePoll(delay = POLL_INTERVAL_MS) {
    pollActive.current = true;
    window.clearTimeout(pollTimer.current);
    pollTimer.current = window.setTimeout(pollStatus, delay);
  }

  function pollStatus() {
    if (!mounted.current) return;
    if (document.visibilityState === "hidden") {
      // 后台不发状态请求，但仍保留轮询；回到前台时 onVisibility 会立刻补一次。
      schedulePoll();
      return;
    }
    const controller = new AbortController();
    pollAbort.current = controller;
    getDeployStatus(controller.signal)
      .then((data) => {
        if (!mounted.current || controller.signal.aborted) return;
        // 能收到响应说明当前端口还活着，重置连续失败计数。
        pollFailures.current = 0;
        const next = data.job;
        const expected = activeJobId.current;
        if (next && expected && next.jobId !== expected) {
          // configDir 里可能是上一次任务的旧状态：忽略它，继续等本次任务出现。
          const now = Date.now();
          if (restartDeadline.current === 0) restartDeadline.current = now + RESTART_WAIT_MS;
          if (now >= restartDeadline.current) {
            setPhaseSafe("unknown");
            stopPolling();
            return;
          }
          schedulePoll();
          return;
        }
        if (!next && expected) {
          // 本次任务的状态文件可能还没写入：在等待窗口内继续轮询，别过早判定失败。
          const now = Date.now();
          if (restartDeadline.current === 0) restartDeadline.current = now + RESTART_WAIT_MS;
          if (now >= restartDeadline.current) {
            setPhaseSafe("unknown");
            stopPolling();
            return;
          }
          schedulePoll();
          return;
        }
        // 能读到本次任务的状态说明服务已经恢复；重置重启等待窗口。
        restartDeadline.current = 0;
        if (!next) {
          // 服务恢复了，但任务状态已丢失（多半是重启后内存里的任务被清空）。
          setJob(null);
          setPhaseSafe("unknown");
          stopPolling();
          return;
        }
        // 409 之后第一次读到任务时认领它，避免后续读到别的任务。
        if (!expected) activeJobId.current = next.jobId;
        setJob(next);
        if (next.state === "success") {
          // 当前服务端口仍在新配置里才允许 reload；否则旧 origin 已无服务。
          const samePort = submittedPorts.current.includes(servicePort.current);
          setPhaseSafe("success");
          stopPolling();
          setPortChanged(!samePort);
          // 向导模式或还有一次性凭据未保存时不自动刷新：先让用户复制密码/令牌。
          const autoReload = samePort && !wizardRef.current && !oneTimeRef.current;
          setReloading(autoReload);
          if (autoReload) {
            reloadTimer.current = window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
          }
          return;
        }
        if (next.state === "failed") {
          setPhaseSafe("failed");
          stopPolling();
          return;
        }
        setPhaseSafe("running");
        schedulePoll();
      })
      .catch(() => {
        if (!mounted.current || controller.signal.aborted) return;
        pollFailures.current += 1;
        // 当前端口不在新配置里：重启后本页面一定连不上，无需等满 90 秒。
        if (
          !submittedPorts.current.includes(servicePort.current) &&
          pollFailures.current >= RELOCATE_FAILURES
        ) {
          setPhaseSafe("relocated");
          stopPolling();
          return;
        }
        const now = Date.now();
        if (restartDeadline.current === 0) restartDeadline.current = now + RESTART_WAIT_MS;
        if (now >= restartDeadline.current) {
          setPhaseSafe("unknown");
          stopPolling();
          return;
        }
        // 部署会重启服务，轮询失败是预期现象：继续等待恢复。
        setPhaseSafe("restarting");
        schedulePoll();
      });
  }

  function onVisibility() {
    // 回到前台且轮询仍在进行：取消排队中的后台计时器，立刻补一次状态。
    if (document.visibilityState !== "visible" || !pollActive.current) return;
    window.clearTimeout(pollTimer.current);
    pollAbort.current?.abort();
    pollStatus();
  }

  useEffect(() => {
    mounted.current = true;
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      stopPolling();
      window.clearTimeout(reloadTimer.current);
      submitAbort.current?.abort();
    };
    // stopPolling/onVisibility 只操作 refs，引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* GitHub 对照是额外的外网请求，和部署状态分开加载：失败不影响整页。 */
  useEffect(() => {
    let cancelled = false;
    setGithubVersion(null);
    getGithubVersion()
      .then((info) => {
        if (!cancelled) setGithubVersion(info);
      })
      .catch(() => {
        if (cancelled) return;
        setGithubVersion({
          status: "unknown",
          checkedAt: new Date().toISOString(),
          error: "无法获取 GitHub 版本",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    setLoaded(false);
    getDeployState(controller.signal)
      .then((data) => {
        if (!mounted.current || controller.signal.aborted) return;
        setDeployState(data);
        setGithubRepoInput(data.githubRepo ?? "");
        setGithubRepoError("");
        setGithubRepoNotice("");
        // 首次部署默认使用当前运行的 checkout，并尽量从 origin 补上仓库地址。
        setForm(
          data.setupRequired
            ? prepareWizardForm(
              {
                repoDir: data.repoDir,
                role: data.role,
                detectedRepoUrl: data.detectedRepoUrl,
                browserHost: window.location.hostname,
              },
              cloneForm(data.form),
            )
            : cloneForm(data.form),
        );
        // 用户主动切到完整表单后，本标签页内不再自动弹回向导。
        setShowWizard(
          data.setupRequired && window.sessionStorage.getItem(WIZARD_SKIP_KEY) !== "1",
        );
        setLoaded(true);
        servicePort.current = data.port > 0 ? data.port : currentOriginPort();
        if (data.job) {
          setJob(data.job);
          activeJobId.current = data.job.jobId;
          if (data.job.state === "running") {
            submittedPorts.current = enabledPortsOf(data.form);
            setSubmittedForm(cloneForm(data.form));
            pollFailures.current = 0;
            setPhaseSafe("running");
            schedulePoll();
          } else if (data.job.state === "failed") {
            setPhaseSafe("failed");
          }
          // success 是服务端持久化的历史结果：只作提示，保持 idle，不锁死表单。
        }
      })
      .catch((reason: unknown) => {
        if (!mounted.current || controller.signal.aborted) return;
        setLoaded(true);
        setLoadError(readableError(reason, "读取部署配置失败"));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  /** 滚到校验失败的区块，并聚焦该区块第一个可输入的控件。 */
  function focusSection(section: DeploySection) {
    const target = sectionRefs.current[section];
    if (!target) return;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    const control = target.querySelector<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    (control ?? target).focus({ preventScroll: true });
  }

  function update(patch: Partial<DeployForm>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setFormError("");
  }

  /** 服务端重置局域网密码：立即写盘；响应后重启局域网入口，并在弹窗里说明。 */
  async function resetLanPassword() {
    if (resetting) return;
    setResetting("lan");
    setFormError("");
    try {
      const result = await resetLanPasswordApi(form?.lanAuthUser);
      update({
        lanEnabled: true,
        lanAuthUser: result.lan.user,
        lanAuthPassword: "",
        lanAuthPasswordSet: true,
      });
      setResetSecret({
        title: "新的局域网登录密码",
        value: result.lan.password,
        urls: result.lan.urls,
        hint: `${result.lan.restartNote} 关闭后不再自动显示；密码保存在配置目录的 lan-proxy.credentials。`,
      });
    } catch (reason) {
      setFormError(readableError(reason, "重置局域网密码失败"));
    } finally {
      setResetting(null);
    }
  }

  /** 服务端重置 API 令牌：立即生效（旧令牌 60 秒宽限），无需重启服务。 */
  async function resetAuthToken() {
    if (resetting) return;
    setResetting("token");
    setFormError("");
    try {
      const result = await resetAuthTokenApi();
      // 先更新浏览器令牌，避免重置后页面自己的请求收到 401。
      writeApiToken(result.token);
      update({ authMode: "custom", authToken: "", authTokenSet: true });
      setResetSecret({
        title: "新的 API 访问令牌",
        value: result.token,
        hint: `${result.note} 关闭后不再自动显示；需要时可在「当前环境」查看当前令牌。`,
      });
    } catch (reason) {
      setFormError(readableError(reason, "重置访问令牌失败"));
    } finally {
      setResetting(null);
    }
  }

  /**
   * 打开部署向导。setup 用于首次部署（还没有配置文件），redeploy 用于已有配置时
   * 从第一步重新确认；两种入口都从当前表单值预填，不丢用户已改过的内容。
   */
  function openWizard(mode: WizardMode) {
    window.sessionStorage.removeItem(WIZARD_SKIP_KEY);
    setWizardMode(mode);
    if (mode === "redeploy") {
      // 上一次部署成功后页面停在「部署完成」，要清掉才能回到向导第一步；
      // 失败状态保留，向导里的失败提示和日志仍然有用。
      window.clearTimeout(reloadTimer.current);
      setReloading(false);
      setPortChanged(false);
      setFormError("");
      if (phase === "success") {
        setPhaseSafe("idle");
        setSubmittedForm(null);
      }
    }
    setShowWizard(true);
  }

  /** 重新部署成功后「重新配置」：清掉结束状态，重新挂载向导并回到第一步。 */
  function restartWizard() {
    setPhaseSafe("idle");
    setSubmittedForm(null);
    setPortChanged(false);
    setReloading(false);
    setWizardKey((value) => value + 1);
  }

  function toggleSecondary(checked: boolean) {
    setForm((current) => {
      if (!current) return current;
      // 副实例关闭时 clonePeer 没有意义，顺手复位，避免提交脏状态。
      return { ...current, startSecondary: checked, clonePeer: checked ? current.clonePeer : false };
    });
    setFormError("");
  }

  function updateProject(index: number, patch: Partial<DeployProject>) {
    setForm((current) => {
      if (!current) return current;
      return {
        ...current,
        projects: current.projects.map((project, item) => (item === index ? { ...project, ...patch } : project)),
      };
    });
    setFormError("");
  }

  /* bypassPermissions 会跳过所有确认，切换前先二次确认；其他级别立即生效。 */
  async function selectPermission(index: number, permission: DeployPermission) {
    if (permission === "bypassPermissions") {
      const confirmed = await dialogs.confirm({
        title: "启用全部允许？",
        message: "全部允许会跳过所有确认，agent 可以在运行服务的用户权限下执行任意命令。确定切换到 bypassPermissions？",
        confirmLabel: "启用",
        danger: true,
      });
      if (!confirmed) return;
    }
    updateProject(index, { permission });
  }

  function addProject() {
    setForm((current) => (current ? { ...current, projects: [...current.projects, blankProject()] } : current));
    setFormError("");
  }

  function removeProject(index: number) {
    setForm((current) => {
      if (!current) return current;
      return { ...current, projects: current.projects.filter((_, item) => item !== index) };
    });
    setFormError("");
  }

  /** 部署入口共用：清掉上一轮状态、记录本次表单并进入「提交中」。 */
  function startDeployTracking(nextForm: DeployForm): AbortController {
    setFormError("");
    setJob(null);
    setReloading(false);
    setPortChanged(false);
    setSubmittedForm(cloneForm(nextForm));
    submittedPorts.current = enabledPortsOf(nextForm);
    pollFailures.current = 0;
    window.clearTimeout(reloadTimer.current);
    restartDeadline.current = 0;
    setPhaseSafe("submitting");
    const controller = new AbortController();
    submitAbort.current = controller;
    activeJobId.current = "";
    return controller;
  }

  /** 服务端已接受部署：保存一次性凭据并开始轮询任务状态。 */
  function acceptDeploy(result: { jobId: string; oneTime?: DeployOneTimeInfo }): void {
    if (result.oneTime) {
      oneTimeRef.current = result.oneTime;
      storeOneTimeInfo(result.oneTime);
      setOneTime(result.oneTime);
    }
    activeJobId.current = result.jobId;
    setPhaseSafe("running");
    schedulePoll();
  }

  /** 提交失败的统一收尾：residual/busy 有各自的状态流转，其它回到 idle 并提示。 */
  function handleDeployError(reason: unknown): void {
    if (!mounted.current) return;
    if (isDeployResidualError(reason)) {
      // 部署锁空闲但有残留进程：不能当作普通失败，也不能去轮询不存在的任务。
      const pids = deployResidualPids(reason);
      setPhaseSafe("idle");
      setFormError(
        `部署锁有残留进程${pids.length > 0 ? `（${pids.join(", ")}）` : ""}，请到公网入口面板回收。`,
      );
      return;
    }
    if (isDeployBusyError(reason)) {
      const kind = deployBusyKind(reason);
      if (!kind || kind === "deploy") {
        // 旧服务端没有 kind，或确实是部署任务：展示并轮询它，不要停在 idle。
        activeJobId.current = "";
        restartDeadline.current = 0;
        setPhaseSafe("running");
        schedulePoll();
        return;
      }
      // 锁被公网入口任务占用：deploy status 里可能是旧的成功任务，
      // 不能认领它并触发自动 reload；保持 idle 让用户稍后重试。
      setPhaseSafe("idle");
      setFormError("公网入口任务在运行，请稍后再部署。");
      return;
    }
    setPhaseSafe("idle");
    setFormError(readableError(reason, "提交部署失败"));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (
      !form ||
      phase === "submitting" ||
      phase === "running" ||
      phase === "restarting" ||
      phase === "relocated" ||
      reloading
    ) return;

    const failure = validate(form);
    if (failure) {
      setFormError(failure.message);
      // 等错误提示渲染后再滚动，避免布局变化把目标区块顶走。
      window.requestAnimationFrame(() => focusSection(failure.section));
      return;
    }

    const controller = startDeployTracking(form);
    try {
      // 两个实例共用同一个仓库：副实例地址始终跟随界面上唯一的仓库输入。
      const hosts = effectivePublicHosts(form);
      const payload: DeployForm = {
        ...form,
        publicHost: hosts.publicHost,
        publicHostSecondary: hosts.publicHostSecondary,
        secondaryRepoUrl: form.primaryRepoUrl,
      };
      let result;
      try {
        result = await applyDeploy(payload, controller.signal);
      } catch (reason) {
        if (!isDataDirChangeError(reason) || controller.signal.aborted) throw reason;
        // 数据目录变化且旧目录有会话：二次确认后再带 confirm 重试。
        const confirmed = await dialogs.confirm({
          title: "切换数据目录？",
          message: `${reason.message}\n\n仍要切换数据目录并重新部署吗？旧目录会原样保留，不会被删除。`,
          confirmLabel: "仍要切换",
          danger: true,
        });
        if (!confirmed) throw reason;
        result = await applyDeploy({ ...payload, confirmDataDirChange: true }, controller.signal);
      }
      if (!mounted.current || controller.signal.aborted) return;
      acceptDeploy(result);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      handleDeployError(reason);
    } finally {
      if (submitAbort.current === controller) submitAbort.current = null;
    }
  }

  /**
   * 一键更新：不提交表单，服务端按当前已保存的配置重新部署，并在构建前从
   * GitHub 远端拉取最新代码。更新前的确认只提示影响，不再逐项确认配置。
   */
  async function onUpdateDeploy() {
    if (
      !form ||
      !deployState ||
      phase === "submitting" ||
      phase === "running" ||
      phase === "restarting" ||
      phase === "relocated" ||
      reloading
    ) return;

    const version = githubVersion && !githubVersion.error && githubVersion.version
      ? githubVersion.status === "ahead"
        ? `GitHub 上是 v${githubVersion.version}。`
        : githubVersion.status === "same"
          ? "GitHub 版本号与当前一致，但可能还有未发版的提交。"
          : ""
      : "";
    const confirmed = await dialogs.confirm({
      title: "拉取最新代码并更新部署？",
      message:
        `${version}将从 GitHub 远端（没有时用配置的 GitHub 仓库或 origin）快进拉取当前分支，`
        + "按当前已保存的配置重新构建并重启服务。"
        + "有进行中的会话、工作区有未提交改动或与远端分叉时会中止更新（不会打断会话）。",
      confirmLabel: "更新并部署",
    });
    if (!confirmed) return;

    // 服务端用的是已保存配置；跟踪状态也用同一份，避免把表单里未保存的
    // 端口/域名当成部署结果，导致错误的“端口已变化”提示和访问地址。
    const controller = startDeployTracking(deployState.form);
    try {
      const result = await updateDeploy(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      acceptDeploy(result);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      handleDeployError(reason);
    } finally {
      if (submitAbort.current === controller) submitAbort.current = null;
    }
  }

  /** 保存 GitHub 镜像地址；只改 env 里的一个键，保存后立刻重新检查版本。 */
  async function onSaveGithubRepo() {
    if (savingGithubRepo) return;
    setSavingGithubRepo(true);
    setGithubRepoError("");
    setGithubRepoNotice("");
    try {
      const result = await saveGithubRepo(githubRepoInput.trim());
      if (!mounted.current) return;
      setGithubRepoInput(result.repo);
      setDeployState((current) => (current ? { ...current, githubRepo: result.repo } : current));
      setGithubRepoNotice(result.repo ? "已保存，并重新检查了 GitHub 版本。" : "已清除，改为自动从远端识别。");
      try {
        const info = await getGithubVersion();
        if (mounted.current) setGithubVersion(info);
      } catch {
        // 版本对照失败不影响保存结果，保留原来的展示。
      }
    } catch (reason) {
      if (!mounted.current) return;
      setGithubRepoError(readableError(reason, "保存 GitHub 仓库失败"));
    } finally {
      if (mounted.current) setSavingGithubRepo(false);
    }
  }

  if (!loaded) {
    return (
      <section className="page">
        <h1 tabIndex={-1}>部署</h1>
        {oneTime && <OneTimeCredentials info={oneTime} onDismiss={dismissOneTime} />}
        <p className="muted">正在读取部署配置…</p>
      </section>
    );
  }

  if (!deployState || !form) {
    return (
      <section className="page">
        <h1 tabIndex={-1}>部署</h1>
        {/* 开启访问令牌后刷新可能先拿到 401；凭据仍要能看见。 */}
        {oneTime && <OneTimeCredentials info={oneTime} onDismiss={dismissOneTime} />}
        <Notice
          tone="error"
          action={{ label: "重试", onClick: () => setReloadKey((value) => value + 1) }}
        >
          {loadError || "读取部署配置失败"}
        </Notice>
      </section>
    );
  }

  const primaryInstance = deployState.instances.find((instance) => instance.role === "primary");
  const secondaryInstance = deployState.instances.find((instance) => instance.role === "secondary");
  const busy = phase === "submitting" || phase === "running" || phase === "restarting";
  const links = endpointsFor(submittedForm ?? form);
  const isWindows = deployState.platform === "win32";
  // Windows 与 Linux 的默认目录习惯不同，占位符跟着平台走。
  const placeholders = {
    primaryDir: isWindows ? String.raw`C:\src\qubius` : "/srv/qubius",
    secondaryDir: isWindows ? String.raw`C:\src\co-qubius` : "/srv/co-qubius",
    dataPrimary: isWindows ? String.raw`C:\src\qubius\.qubius\data` : "<checkout>/.qubius/data",
    dataSecondary: isWindows ? String.raw`C:\src\co-qubius\.qubius\data` : "<副 checkout>/.qubius/data",
    publicHost: isWindows ? "仅本机使用可填 localhost" : "例如 code.example.com",
    publicHostSecondary: isWindows ? "仅本机使用可填 localhost" : "例如 code-bak.example.com",
    nodeBin: isWindows ? String.raw`C:\Program Files\nodejs\node.exe` : "留空时从 PATH / nvm 查找",
  };

  if (showWizard) {
    return (
      <>
        {resetSecret && (
          <SecretDialog secret={resetSecret} onDismiss={() => setResetSecret(null)} />
        )}
      <DeployWizard
        key={wizardKey}
        state={deployState}
        mode={wizardMode}
        form={form}
        phase={phase}
        job={job}
        formError={formError}
        status={renderStatus()}
        moved={portChanged}
        onUpdate={update}
        onSubmit={onSubmit}
        onSwitchToAdvanced={() => {
          // 只有首次部署需要记住「本标签页别再自动弹回向导」；
          // 重新部署本来就不会自动进入向导。
          if (deployState.setupRequired) window.sessionStorage.setItem(WIZARD_SKIP_KEY, "1");
          setShowWizard(false);
        }}
        onRestart={restartWizard}
      />
      </>
    );
  }

  function statusTitle(): string {
    switch (phase) {
      case "submitting": return "正在提交部署…";
      case "running": return "正在部署";
      case "restarting": return "服务正在重启";
      case "success": return "部署成功";
      case "failed": return "部署失败";
      case "unknown": return "部署状态未知";
      case "relocated": return "部署已提交";
      default: return job ? "上次部署结果" : "部署";
    }
  }

  function renderStatus() {
    if (phase === "idle" && !job) {
      return oneTime ? <OneTimeCredentials info={oneTime} onDismiss={dismissOneTime} /> : null;
    }
    // 服务端会保留上一次成功记录；加载到它时只提示，不进入忙碌状态。
    const historicalSuccess = phase === "idle" && job?.state === "success";
    return (
      <>
        {oneTime && <OneTimeCredentials info={oneTime} onDismiss={dismissOneTime} />}
      <section
        className="deploy-status"
        data-state={phase}
        role={phase === "failed" ? "alert" : "status"}
        aria-live={phase === "failed" ? "assertive" : "polite"}
      >
        <div className="deploy-status-head">
          <strong>{statusTitle()}</strong>
          {job && (
            <span className="deploy-badge" data-on={job.state === "success"}>
              {JOB_STATE_LABEL[job.state]}
            </span>
          )}
        </div>
        {job?.step && <p className="deploy-step mono">{job.step}</p>}
        {job?.message && <p className={phase === "failed" ? "error" : "deploy-message"}>{job.message}</p>}
        {phase === "restarting" && <p className="deploy-message">服务正在重启，等待恢复…</p>}
        {phase === "success" && (
          <p className="note">
            {reloading
              ? "部署成功，页面将在 1.5 秒后自动刷新。"
              : portChanged
                ? "部署成功，服务已在新端口启动，请使用下面的地址访问。"
                : "部署成功。"}
          </p>
        )}
        {historicalSuccess && (
          <p className="note">上次部署已成功；修改配置后可以再次提交。</p>
        )}
        {phase === "failed" && (
          <p className="deploy-message">可以修改上面的配置后再次点击「保存并部署」。</p>
        )}
        {phase === "unknown" && (
          <p className="deploy-message">暂时读不到部署任务状态，请稍后刷新页面确认。可以用下面的地址访问：</p>
        )}
        {phase === "relocated" && (
          <p className="deploy-message">
            部署已提交，服务将不再监听当前端口，请用以下地址访问：
          </p>
        )}
        {(phase === "success" || phase === "unknown" || phase === "relocated" || historicalSuccess) &&
          links.length > 0 && (
          <ul className="deploy-links">
            {links.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noreferrer">
                  {link.label}：{link.url}
                </a>
              </li>
            ))}
          </ul>
        )}
        {job?.logTail && (
          <pre className="deploy-log" aria-label="部署日志">{job.logTail}</pre>
        )}
      </section>
      </>
    );
  }

  return (
    <section className="page">
      <h1 tabIndex={-1}>部署</h1>
      {resetSecret && (
        <SecretDialog secret={resetSecret} onDismiss={() => setResetSecret(null)} />
      )}
      <p className="lead">
        填写实例和目录信息后保存，服务端会自动生成配置、构建并重启。标注「留空自动」的项可以交给服务端推导；每个字段旁的问号可以查看详细说明。
      </p>

      {!deployState.setupRequired && (
        <div className="deploy-redeploy">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || reloading || phase === "relocated"}
            onClick={onUpdateDeploy}
          >
            {githubVersion?.status === "ahead" && githubVersion.version
              ? `更新到 v${githubVersion.version} 并部署`
              : "从 GitHub 更新并部署"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || reloading || phase === "relocated"}
            onClick={() => openWizard("redeploy")}
          >
            重新部署…
          </button>
          <p className="deploy-inline-hint">
            「更新」从 GitHub 远端拉取最新代码（依次尝试 github 远端、下面配置的 GitHub 仓库、origin），
            按当前已保存的配置重新构建并重启，不用逐项确认；「重新部署」从向导第一步开始，可以修改任意配置后再提交。
          </p>
        </div>
      )}

      {!deployState.setupRequired && (
        <div className="deploy-github-repo">
          <TextField
            label="GitHub 仓库"
            value={githubRepoInput}
            placeholder="owner/repo 或 https://github.com/owner/repo"
            hint="用于 GitHub 版本对照；一键更新在本地没有 github 远端时会从这个地址拉取。留空自动从 remote 识别。"
            disabled={savingGithubRepo}
            action={(
              <button
                type="button"
                className="btn"
                disabled={savingGithubRepo || busy}
                onClick={onSaveGithubRepo}
              >
                {savingGithubRepo ? "保存中…" : "保存"}
              </button>
            )}
            onChange={(value) => {
              setGithubRepoInput(value);
              setGithubRepoError("");
              setGithubRepoNotice("");
            }}
          />
          {githubRepoError && (
            <Notice tone="error" onDismiss={() => setGithubRepoError("")}>{githubRepoError}</Notice>
          )}
          {githubRepoNotice && <p className="deploy-inline-hint">{githubRepoNotice}</p>}
        </div>
      )}

      {deployState.setupRequired && (
        <div className="deploy-setup" role="status">
          <span>当前实例还没有配置文件，填写并部署后会自动构建并重启。</span>
          <button type="button" className="text-btn" onClick={() => openWizard("setup")}>
            返回部署向导
          </button>
        </div>
      )}

      {isWindows && (
        <div className="deploy-setup deploy-setup-note" role="status">
          {"点「保存并部署」会在新终端窗口中执行（"}
          <span className="mono">deploy/deploy-job.mjs</span>
          {"）：先检查端口，被占用时会询问是否停止占用进程；部署完成后服务在该窗口前台运行（页面切换时会短暂断开），关闭窗口或按 Ctrl+C 即停止。不需要 bash 或 systemd。实例日志在数据目录的 "}
          <span className="mono">qubius.log</span>
          {"，部署日志在配置目录的 "}
          <span className="mono">deploy.log</span>
          {"，同时也会打到窗口里。开机自启请用「任务计划程序」自行登记。"}
        </div>
      )}

      <section className="deploy-section" aria-labelledby="deploy-env-title">
        <h2 id="deploy-env-title">当前环境</h2>
        <dl className="deploy-info">
          <div>
            <dt>当前角色</dt>
            <dd>{ROLE_LABEL[deployState.role]}</dd>
          </div>
          <div>
            <dt>Node 版本</dt>
            <dd>{deployState.nodeVersion || "—"}</dd>
          </div>
          <div>
            <dt>当前版本</dt>
            <dd className="mono">{githubVersion?.current ? `v${githubVersion.current}` : "—"}</dd>
          </div>
          <div>
            <dt>GitHub 版本</dt>
            <dd
              title={
                githubVersion?.repo
                  ? `${githubVersion.repo} · 检查于 ${new Date(githubVersion.checkedAt).toLocaleString("zh-CN")}`
                  : undefined
              }
            >
              <span className="mono">{githubVersion?.version ? `v${githubVersion.version}` : "—"}</span>
              {" · "}
              <span className="deploy-version-note" data-status={githubVersionStatus(githubVersion)}>
                {githubVersionLabel(githubVersion)}
              </span>
            </dd>
          </div>
          <div>
            <dt>仓库目录</dt>
            <dd className="mono">{deployState.repoDir}</dd>
          </div>
          <div>
            <dt>配置文件</dt>
            <dd className="mono">{deployState.configFile}</dd>
          </div>
          <div>
            <dt>env 文件</dt>
            <dd className="mono">{deployState.envFile}</dd>
          </div>
          {deployState.current && (
            <>
              <div>
                <dt>数据目录</dt>
                <dd className="mono">{deployState.current.dataDir}</dd>
              </div>
              <div>
                <dt>allowedHosts</dt>
                <dd className="mono">{deployState.current.allowedHosts.join("、")}</dd>
              </div>
              <div>
                <dt>访问令牌</dt>
                <dd>
                  {deployState.current.authEnabled
                    ? `已启用（${
                      deployState.current.authTokenSource === "env"
                        ? "env 文件"
                        : deployState.current.authTokenSource === "config"
                          ? "config.yaml"
                          : "自动生成文件"
                    }）`
                    : "未启用"}
                </dd>
              </div>
              <div>
                <dt>归档</dt>
                <dd className="mono">
                  {deployState.current.archive
                    ? `${deployState.current.archive.dir}（保留 ${deployState.current.archive.retentionDays} 天）`
                    : "未启用"}
                </dd>
              </div>
              <div>
                <dt>命令行页</dt>
                <dd>{deployState.current.terminal ? "开启" : "关闭"}</dd>
              </div>
              {deployState.current.lan && (
                <div>
                  <dt>局域网入口</dt>
                  <dd>
                    {deployState.current.lan.enabled
                      ? `已启用（${deployState.current.lan.user}${
                        deployState.current.lan.passwordSet ? "，密码已设置" : "，密码未设置"
                      }）`
                      : "未启用"}
                  </dd>
                </div>
              )}
            </>
          )}
        </dl>

        {deployState.current?.authEnabled && (
          <div className="deploy-token">
            <button type="button" className="btn" onClick={onRevealToken}>
              显示当前访问令牌
            </button>
            {revealedToken && (
              <>
                <code className="mono deploy-token-value" onClick={(event) => {
                  const selection = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(event.currentTarget);
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                }}>
                  {revealedToken}
                </code>
                <CopyButton value={revealedToken} label="当前访问令牌" />
              </>
            )}
            {deployState.current.authTokenFile && (
              <span className="muted">令牌文件：<span className="mono">{deployState.current.authTokenFile}</span></span>
            )}
            {tokenError && <span className="error" role="alert">{tokenError}</span>}
          </div>
        )}

        <div className="deploy-cards">
          <article className="deploy-card">
            <div className="deploy-card-head">
              <strong>主实例</strong>
              <span className="deploy-badge" data-on={Boolean(primaryInstance?.running)}>
                {primaryInstance?.running ? "运行中" : "未运行"}
              </span>
            </div>
            {primaryInstance ? (
              <dl className="deploy-card-info">
                <div>
                  <dt>端口</dt>
                  <dd className="mono">{primaryInstance.port}</dd>
                </div>
                <div>
                  <dt>Checkout</dt>
                  <dd className="mono">{primaryInstance.repoDir}</dd>
                </div>
                <div>
                  <dt>数据目录</dt>
                  <dd className="mono">{primaryInstance.dataDir}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd className="mono">{primaryInstance.version ? `v${primaryInstance.version}` : "—"}</dd>
                </div>
                <div>
                  <dt>HEAD</dt>
                  <dd className="mono" title={primaryInstance.head || undefined}>
                    {primaryInstance.head ? primaryInstance.head.slice(0, 7) : "—"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted">服务端未报告该实例。</p>
            )}
          </article>

          <article className="deploy-card">
            <div className="deploy-card-head">
              <strong>副实例</strong>
              <span className="deploy-badge" data-on={Boolean(secondaryInstance?.running)}>
                {secondaryInstance?.running ? "运行中" : "未运行"}
              </span>
            </div>
            {secondaryInstance ? (
              <dl className="deploy-card-info">
                <div>
                  <dt>端口</dt>
                  <dd className="mono">{secondaryInstance.port}</dd>
                </div>
                <div>
                  <dt>Checkout</dt>
                  <dd className="mono">{secondaryInstance.repoDir}</dd>
                </div>
                <div>
                  <dt>数据目录</dt>
                  <dd className="mono">{secondaryInstance.dataDir}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd className="mono">{secondaryInstance.version ? `v${secondaryInstance.version}` : "—"}</dd>
                </div>
                <div>
                  <dt>HEAD</dt>
                  <dd className="mono" title={secondaryInstance.head || undefined}>
                    {secondaryInstance.head ? secondaryInstance.head.slice(0, 7) : "—"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted">服务端未报告该实例。</p>
            )}
          </article>
        </div>
      </section>

      {renderStatus()}

      <form className="deploy-form stack" onSubmit={onSubmit} noValidate>
        <fieldset
          id={SECTION_ID.scope}
          ref={(element) => { sectionRefs.current.scope = element; }}
          className="deploy-section"
          tabIndex={-1}
        >
          <legend>实例范围</legend>
          <div className="deploy-checks">
            <label className="field field-check">
              <input
                type="checkbox"
                checked={form.startPrimary}
                onChange={(event) => update({ startPrimary: event.target.checked })}
              />
              启动主实例
              <Hint text="运行主实例 qubius；至少需要启用一个实例。" />
            </label>
            <label className="field field-check">
              <input
                type="checkbox"
                checked={form.startSecondary}
                onChange={(event) => toggleSecondary(event.target.checked)}
              />
              启动副实例
              <Hint text="同时运行副实例 co-qubius；需要另一份 checkout。" />
            </label>
            <label className="field field-check" data-disabled={!form.startSecondary}>
              <input
                type="checkbox"
                disabled={!form.startSecondary}
                checked={form.clonePeer}
                onChange={(event) => update({ clonePeer: event.target.checked })}
              />
              缺少副实例 checkout 时自动克隆
              <Hint text="副实例 checkout 不存在时，部署任务会按仓库地址自动克隆。" />
            </label>
          </div>
          {!form.startSecondary && <p className="deploy-inline-hint">勾选「启动副实例」后，自动克隆选项才会生效。</p>}
        </fieldset>

        <fieldset
          id={SECTION_ID.primary}
          ref={(element) => { sectionRefs.current.primary = element; }}
          className="deploy-section"
          tabIndex={-1}
        >
          <legend>主实例</legend>
          <div className="deploy-grid deploy-grid-instance">
            <TextField
              label="Checkout 路径"
              value={form.primaryDir}
              placeholder={placeholders.primaryDir}
              hint="qubius checkout 目录，必须包含 deploy/ 脚本和 package.json；默认当前仓库。"
              onChange={(value) => update({ primaryDir: value })}
            />
            <TextField
              label="数据目录"
              value={form.dataPrimary}
              placeholder={placeholders.dataPrimary}
              hint="会话、worktree、密钥和日志；默认 <checkout>/.qubius/data，重新部署一般不要改。"
              onChange={(value) => update({ dataPrimary: value })}
            />
            <NumberField
              label="端口"
              min={1}
              hint="只监听 127.0.0.1；默认 8787。主副实例不能相同。"
              value={form.primaryPort}
              onChange={(value) => update({ primaryPort: value })}
            />
            <TextField
              label="公网域名"
              value={form.publicHost}
              placeholder={placeholders.publicHost}
              hint="浏览器实际访问的域名，会写进 allowedHosts；仅本机使用可填 localhost。"
              onChange={(value) => update({ publicHost: value })}
            />
          </div>
        </fieldset>

        <fieldset
          id={SECTION_ID.secondary}
          ref={(element) => { sectionRefs.current.secondary = element; }}
          className="deploy-section"
          tabIndex={-1}
        >
          <legend>副实例</legend>
          <div className="deploy-grid deploy-grid-instance">
            <TextField
              label="Checkout 路径"
              value={form.secondaryDir}
              placeholder={placeholders.secondaryDir}
              hint="副实例 co-qubius 的 checkout；默认 ~/co-qubius，必须是另一份仓库。"
              onChange={(value) => update({ secondaryDir: value })}
            />
            <TextField
              label="数据目录"
              value={form.dataSecondary}
              placeholder={placeholders.dataSecondary}
              hint="副实例的会话和数据；默认 <副 checkout>/.qubius/data，不能和主实例相同。"
              onChange={(value) => update({ dataSecondary: value })}
            />
            <NumberField
              label="端口"
              min={1}
              hint="副实例只监听 127.0.0.1；默认 8788，不能和主实例相同。"
              value={form.secondaryPort}
              onChange={(value) => update({ secondaryPort: value })}
            />
            <TextField
              label="公网域名"
              value={form.publicHostSecondary}
              placeholder={placeholders.publicHostSecondary}
              hint="副实例的访问域名；会写进它的 allowedHosts。仅本机可填 localhost。"
              onChange={(value) => update({ publicHostSecondary: value })}
            />
            <div className="field deploy-readonly deploy-span-2">
              <span className="field-label">
                主实例 checkout（同步用）
                <Hint text="副实例的同步/回滚会把结果推回主实例 checkout 的 origin。" />
              </span>
              <span className="mono deploy-readonly-value">{form.primaryDir || "—"}</span>
            </div>
            <TextField
              className="deploy-span-2"
              label="同步分支"
              value={form.primaryRef}
              placeholder="例如 main"
              hint="副实例同步主实例时使用的 git 分支，默认 main。"
              onChange={(value) => update({ primaryRef: value })}
            />
          </div>
        </fieldset>

        <fieldset
          id={SECTION_ID.repo}
          ref={(element) => { sectionRefs.current.repo = element; }}
          className="deploy-section"
          tabIndex={-1}
        >
          <legend>仓库</legend>
          <div className="deploy-grid">
            <TextField
              label="qubius 仓库，用于自己开发迭代自己"
              value={form.primaryRepoUrl}
              placeholder="http://git.example.com/example/qubius.git"
              hint="qubius 自己的仓库地址，用于部署前拉取和自动克隆；单实例本机使用可保持默认。"
              onChange={(value) => update({ primaryRepoUrl: value })}
            />
          </div>
          <div className="deploy-checks">
            <label className="field field-check">
              <input
                type="checkbox"
                checked={form.pullLatest}
                onChange={(event) => update({ pullLatest: event.target.checked })}
              />
              部署前从远端拉取最新代码
              <Hint text="构建前从各 checkout 的 origin 快进拉取当前分支；有未提交改动或分叉时中止部署。" />
            </label>
          </div>
          <p className="deploy-inline-hint">
            副实例与主实例共用这个仓库，只是另一份 checkout。勾选后，部署任务会在构建前对每个启用的
            checkout 从 <span className="mono">origin</span> 拉取当前分支并快进合并；工作区有未提交改动、
            与远端分叉或拉取失败时会中止部署，不会覆盖本地内容。
          </p>
        </fieldset>

        <fieldset
          id={SECTION_ID.general}
          ref={(element) => { sectionRefs.current.general = element; }}
          className="deploy-section"
          tabIndex={-1}
        >
          <legend>通用</legend>
          <div className="deploy-grid">
            <div className="field deploy-readonly">
              <span className="field-label">
                配置目录
                <Hint text="由服务端启动时的 QUBIUS_CONFIG_DIR 决定，运行中不能修改；默认 .qubius/。" />
              </span>
              <span className="mono deploy-readonly-value">{form.configDir || "—"}</span>
            </div>
            <TextField
              label="LAN 监听地址（留空自动）"
              value={form.lanHost}
              placeholder="留空时自动选择"
              hint="局域网入口绑定的 IPv4；留空自动选择第一个非回环地址。"
              onChange={(value) => update({ lanHost: value })}
            />
            <TextField
              label="Node 路径（留空自动）"
              value={form.nodeBin}
              placeholder={placeholders.nodeBin}
              hint="Node.js 22+ 可执行文件；留空从 PATH 和 ~/.nvm 查找。"
              onChange={(value) => update({ nodeBin: value })}
            />
            <TextField
              className="deploy-span-2"
              label="额外允许的访问域名（逗号分隔，可选）"
              value={form.allowedHostsExtra}
              placeholder="例如 qa.example.com, [2001:db8::1]"
              hint="额外的 Host 白名单（逗号分隔），和公网域名一起合并；局域网经 lan-proxy 不需要填。"
              onChange={(value) => update({ allowedHostsExtra: value })}
            />
            <div className="field">
              <span className="field-label">
                访问令牌
                <Hint text="关闭不校验令牌；自动生成会写入数据目录 auth-token；自定义可指定 16-512 个字符。重置会切换到自定义模式。" />
              </span>
              <span className="field-control">
                <select
                  value={form.authMode}
                  onChange={(event) => update({ authMode: event.target.value as DeployForm["authMode"] })}
                >
                  <option value="off">关闭</option>
                  <option value="auto">自动生成</option>
                  <option value="custom">自定义</option>
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={resetting !== null}
                  onClick={resetAuthToken}
                >
                  {resetting === "token" ? "重置中…" : "重置令牌"}
                </button>
              </span>
            </div>
            {form.authMode === "custom" && (
              <TextField
                type="password"
                label="自定义访问令牌"
                value={form.authToken}
                placeholder={form.authTokenSet ? "已设置，留空保持不变" : "16 到 512 个字符"}
                hint="至少 16 个字符；留空沿用已保存的值。需要新令牌时点上面的「重置令牌」。"
                onChange={(value) => update({ authToken: value })}
              />
            )}
            <NumberField
              label="并发上限"
              min={1}
              hint="同时进行的对话数初始值（1-256）；设置页保存的值优先。"
              value={form.maxConcurrent}
              onChange={(value) => update({ maxConcurrent: value })}
            />
            <NumberField
              label="确认超时（分钟，0 不自动拒绝）"
              min={0}
              hint="等待提问/授权多久自动拒绝（0-1440）；0 表示一直等待，不显示倒计时。"
              value={form.approvalTimeoutMinutes}
              onChange={(value) => update({ approvalTimeoutMinutes: value })}
            />
            <label className="field field-check">
              <input
                type="checkbox"
                checked={form.terminal}
                onChange={(event) => update({ terminal: event.target.checked })}
              />
              启用浏览器命令行页
              <Hint text="打开后是运行服务用户的完整 shell；不需要时关闭。" />
            </label>
            <label className="field field-check">
              <input
                type="checkbox"
                checked={form.lanEnabled}
                onChange={(event) => update({ lanEnabled: event.target.checked })}
              />
              启用局域网入口（Basic 认证）
              <Hint text="启用后启动 lan-proxy；部署成功会一次性显示访问地址、用户名、密码和 API 令牌。" />
            </label>
            <TextField
              label="局域网用户名"
              value={form.lanAuthUser}
              placeholder="qubius"
              disabled={!form.lanEnabled}
              hint="Basic 认证用户名；不能包含冒号和空白。"
              onChange={(value) => update({ lanAuthUser: value })}
            />
            <TextField
              type="password"
              label="局域网登录密码"
              value={form.lanAuthPassword}
              placeholder={form.lanAuthPasswordSet ? "已设置，留空保持不变" : "留空自动生成"}
              disabled={!form.lanEnabled}
              hint="至少 8 位；留空自动生成或沿用。重置后保存并部署生效。"
              action={(
                <button
                  type="button"
                  className="btn"
                  disabled={!form.lanEnabled || resetting !== null}
                  onClick={resetLanPassword}
                >
                  {resetting === "lan" ? "重置中…" : "重置密码"}
                </button>
              )}
              onChange={(value) => update({ lanAuthPassword: value })}
            />
            <p className="deploy-inline-hint deploy-span-2">
              启用后部署任务会写入配置目录的 <span className="mono">lan-proxy.credentials</span>（0600），
              并在部署响应里一次性显示局域网访问地址、用户名、登录密码和 API 访问令牌。
              关闭本页后不再显示；忘记时可在配置目录查看凭据文件。
            </p>
            <details className="field deploy-span-2 deploy-advanced">
              <summary>高级限制（一般不用改）</summary>
              <div className="deploy-grid">
                <NumberField
                  label="单会话总字节"
                  min={65536}
                  hint="单个会话序列化后的最大字节数，默认 8MB；范围 64KB-64MB。"
                  value={form.limits.transcriptBytes}
                  onChange={(value) => update({ limits: { ...form.limits, transcriptBytes: value } })}
                />
                <NumberField
                  label="单会话消息条数"
                  min={50}
                  hint="单个会话保留的消息条数，默认 5000；范围 50-20000。"
                  value={form.limits.transcriptMessages}
                  onChange={(value) => update({ limits: { ...form.limits, transcriptMessages: value } })}
                />
                <NumberField
                  label="单条消息字符数"
                  min={1024}
                  hint="单条消息正文的最大字符数，默认 200000；范围 1024-1048576。"
                  value={form.limits.messageText}
                  onChange={(value) => update({ limits: { ...form.limits, messageText: value } })}
                />
                <NumberField
                  label="请求体字节数"
                  min={1048576}
                  hint="单次 JSON 请求体的最大字节数，默认 28MB；范围 1MB-64MB。"
                  value={form.limits.requestBodyBytes}
                  onChange={(value) => update({ limits: { ...form.limits, requestBodyBytes: value } })}
                />
                <NumberField
                  label="历史分页条数"
                  min={50}
                  hint="首帧/翻页一次返回的历史消息条数，默认 200；范围 50-2000。"
                  value={form.limits.historyPage}
                  onChange={(value) => update({ limits: { ...form.limits, historyPage: value } })}
                />
              </div>
            </details>
            <TextField
              label="归档目录（留空不归档）"
              value={form.archiveDir}
              placeholder="留空表示不归档"
              hint="会话超过保留天数后先归档到这里再从本机删除；留空不归档、不自动清理。"
              onChange={(value) => update({ archiveDir: value })}
            />
            <NumberField
              label="列表保留天数（到期归档到冷存储）"
              min={1}
              hint="会话在本机保留的天数，默认 30；范围 1-3650。"
              value={form.archiveRetentionDays}
              onChange={(value) => update({ archiveRetentionDays: value })}
            />
          </div>
          <p className="deploy-inline-hint">
            配置目录由服务端启动时的 QUBIUS_CONFIG_DIR 决定，运行中不能修改。
            默认目录是当前 checkout 内的 <span className="mono">.qubius/</span>（配置、env、数据和日志），
            已加入 <span className="mono">.gitignore</span>；需要换目录时先停止服务，再用
            <span className="mono"> npm run quickstart</span> 重新启动并选择。
            访问令牌选「自动生成」时会写入数据目录的 <span className="mono">auth-token</span>，
            部署页会显示实际生效的令牌。
          </p>
        </fieldset>

        <fieldset
          id={SECTION_ID.projects}
          ref={(element) => { sectionRefs.current.projects = element; }}
          className="deploy-section"
          tabIndex={-1}
        >
          <legend>额外项目</legend>
          <p className="deploy-inline-hint">这些目录会出现在项目列表里；内置的「普通对话」入口不需要填写。</p>
          {deployState.projectsError && (
            <p className="error" role="alert">
              项目配置文件无法读取：{deployState.projectsError}。请先修复配置目录（{deployState.configDir}）
              里的项目文件；也可以保持项目列表为空并保存部署，服务会备份并清除该文件后继续。
              当前列表不代表文件里的真实内容。
            </p>
          )}
          {!deployState.projectsError && form.projects.length === 0 && (
            <p className="muted">还没有额外项目。</p>
          )}
          <div className="deploy-projects">
            {form.projects.map((project, index) => (
              <div className="deploy-project" key={index}>
                <TextField
                  label={`项目 ${index + 1} id`}
                  value={project.id}
                  placeholder="例如 sample"
                  hint="小写字母、数字和连字符；用于 worktree 路径和 URL。"
                  onChange={(value) => updateProject(index, { id: value })}
                />
                <TextField
                  label="名称"
                  value={project.name}
                  placeholder="显示名称"
                  hint="项目列表里显示的名称。"
                  onChange={(value) => updateProject(index, { name: value })}
                />
                <TextField
                  label="路径"
                  value={project.path}
                  placeholder="绝对路径"
                  hint="项目主检出的绝对路径；agent 只能在这个白名单目录里工作。"
                  onChange={(value) => updateProject(index, { path: value })}
                />
                <div className="field">
                  <span className="field-label">
                    权限
                    <Hint text="default 改动/命令需确认；acceptEdits 工作区内自动放行；plan 只规划；auto 模型判断；bypassPermissions 全部放行（不建议）。" />
                  </span>
                  <select
                    value={project.permission}
                    onChange={(event) => {
                      const permission = event.target.value as DeployPermission;
                      if (permission === project.permission) return;
                      if (permission === "bypassPermissions") {
                        /* 弹窗期间受控 select 不会重渲染，先手动回到原值；取消时保持不动。 */
                        event.target.value = project.permission;
                      }
                      void selectPermission(index, permission);
                    }}
                  >
                    {PERMISSIONS.map((permission) => (
                      <option key={permission} value={permission}>{PERMISSION_LABEL[permission]}</option>
                    ))}
                  </select>
                  {project.permission === "bypassPermissions" && (
                    <p className="deploy-inline-hint deploy-permission-warning">
                      全部允许：agent 会跳过确认，在运行服务的用户权限下执行任意命令，请仅在受控环境使用。
                    </p>
                  )}
                </div>
                <label className="field field-check">
                  <input
                    type="checkbox"
                    checked={project.isolated}
                    onChange={(event) => updateProject(index, { isolated: event.target.checked })}
                  />
                  独立目录
                  <Hint text="只对非 git 目录生效：每个对话使用独立子目录，可并行。" />
                </label>
                <button
                  type="button"
                  className="btn deploy-project-remove"
                  onClick={() => removeProject(index)}
                  aria-label={`删除项目 ${index + 1}`}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <div className="deploy-actions">
            <button type="button" className="btn" onClick={addProject}>添加项目</button>
          </div>
        </fieldset>

        {/* sticky 提交栏：长表单中途也能看到校验/提交错误并直接提交。 */}
        <div className="deploy-submit">
          {formError && (
            <Notice tone="error" onDismiss={() => setFormError("")}>{formError}</Notice>
          )}
          <div className="deploy-submit-row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || reloading || phase === "relocated"}
            >
              {phase === "submitting"
                ? "正在提交…"
                : phase === "running" || phase === "restarting"
                  ? "部署进行中…"
                  : phase === "relocated"
                    ? "部署已提交"
                    : form.pullLatest
                      ? "拉取最新代码并部署"
                      : "保存并部署"}
            </button>
            {form.pullLatest && (
              <p className="deploy-inline-hint">
                会先从各 checkout 已配置的 <span className="mono">origin</span> 快进拉取当前分支；
                工作区有改动或无法快进时中止部署。
              </p>
            )}
          </div>
        </div>
      </form>

      {/* 公网入口依赖 edgectl 和 shell ops lock，Windows 部署不支持。 */}
      {!isWindows && <EdgePanel configDir={deployState.configDir} />}

      <PushSettings />
    </section>
  );
}
