import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getSession, sendMessage } from "../api";
import {
  beginCreate,
  beginLoad,
  canApplyResponse,
  createPullRequest,
  finishCreate,
  finishLoad,
  getPullRequest,
  initialAsyncFlags,
  resetSessionFlags,
  type AsyncFlagState,
  type PullRequestCheck,
  type PullRequestStatus,
} from "../api-pull-request";
import "./PullRequestPanel.css";

/** 监视模式下页面可见时的轮询间隔。 */
const POLL_MS = 30_000;

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function stateLabel(state?: string): string {
  switch ((state ?? "").toLowerCase()) {
    case "open":
    case "opened":
      return "待合并";
    case "merged":
      return "已合并";
    case "closed":
      return "已关闭";
    case "locked":
      return "锁定";
    case "draft":
      return "草稿";
    default:
      return state || "未知状态";
  }
}

function mergeableLabel(value?: string): { text: string; tone: "ok" | "warn" | "muted" } | null {
  if (!value) return null;
  switch (value.toLowerCase()) {
    case "mergeable":
      return { text: "可合并", tone: "ok" };
    case "conflicting":
    case "cannot_be_merged":
      return { text: "有冲突", tone: "warn" };
    case "unknown":
      return { text: "合并状态未知", tone: "muted" };
    default:
      return { text: value, tone: "muted" };
  }
}

type CheckTone = "ok" | "warn" | "pending" | "muted";

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "error",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);
const PENDING_STATUSES = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);

function checkTone(check: PullRequestCheck): CheckTone {
  const status = (check.status ?? "").toLowerCase();
  const conclusion = (check.conclusion ?? "").toLowerCase();
  if (FAILED_CONCLUSIONS.has(conclusion) || status === "failure" || status === "error") return "warn";
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "ok";
  if (!conclusion || PENDING_STATUSES.has(status)) return "pending";
  return "muted";
}

function isFailedCheck(check: PullRequestCheck): boolean {
  return checkTone(check) === "warn";
}

function checkLabel(check: PullRequestCheck): string {
  const status = (check.status ?? "").toLowerCase();
  const conclusion = (check.conclusion ?? "").toLowerCase();
  if (FAILED_CONCLUSIONS.has(conclusion)) return "失败";
  if (conclusion === "success") return "通过";
  if (conclusion === "neutral" || conclusion === "skipped") return "完成";
  if (PENDING_STATUSES.has(status) || !conclusion) return "进行中";
  return conclusion || status || "未知";
}

/** 按 name 分组，同名检查保留全部状态并排序，避免 Map 覆盖漏报。 */
function checkGroups(checks: PullRequestCheck[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const check of checks) {
    const values = groups.get(check.name) ?? [];
    values.push(`${check.status}:${check.conclusion ?? ""}`);
    groups.set(check.name, values);
  }
  for (const values of groups.values()) values.sort();
  return groups;
}

function statusSignature(status: PullRequestStatus): string {
  return JSON.stringify({
    exists: status.exists,
    number: status.number ?? 0,
    state: status.state ?? "",
    mergeable: status.mergeable ?? "",
    // 检查项按 name 分组并排序：平台调整顺序不应触发“有更新”提示，
    // 同名检查也不会因为 Map 覆盖而漏掉变化。
    checks: [...checkGroups(status.checks).entries()]
      .map(([name, values]) => `${name}:${values.join("|")}`)
      .sort(),
  });
}

function describeChange(before: PullRequestStatus, next: PullRequestStatus): string {
  if (before.exists !== next.exists) {
    return next.exists ? "PR/MR 已出现" : "PR/MR 已不存在";
  }
  const parts: string[] = [];
  if (before.state !== next.state) parts.push(`状态变为${stateLabel(next.state)}`);
  if (before.mergeable !== next.mergeable) {
    parts.push(`合并状态变为${mergeableLabel(next.mergeable)?.text ?? "未知"}`);
  }
  // 按 name 分组比较，不依赖返回顺序；同名检查比较完整的状态数组。
  const previousGroups = checkGroups(before.checks);
  const currentGroups = checkGroups(next.checks);
  let changed = 0;
  for (const [name, values] of currentGroups) {
    const previous = previousGroups.get(name);
    if (!previous || previous.length !== values.length || previous.some((value, index) => value !== values[index])) {
      changed += 1;
    }
  }
  for (const name of previousGroups.keys()) {
    if (!currentGroups.has(name)) changed += 1;
  }
  if (changed > 0) parts.push(`${changed} 项检查状态变化`);
  return parts.length > 0 ? `PR/MR 更新：${parts.join("，")}` : "PR/MR 已更新";
}

/**
 * Git 面板下方的 PR/MR 区域：展示当前分支的 PR/MR 和检查，支持创建、
 * 手动刷新、页面可见时每 30 秒监视，以及把失败检查交给 agent 处理。
 */
export function PullRequestPanel({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<PullRequestStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [monitor, setMonitor] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);

  const mountedRef = useRef(true);
  const flagRef = useRef<AsyncFlagState>(initialAsyncFlags());
  const creatingRef = useRef(false);
  const statusRef = useRef<PullRequestStatus | null>(null);
  const signatureRef = useRef("");
  // 创建/交给 agent 的请求可能在切换会话后才返回；用当前 sessionId 丢弃旧结果。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 表单标题先用会话标题或分支名预填；用户已经输入时不要覆盖。
  useEffect(() => {
    let active = true;
    void getSession(sessionId)
      .then(({ session }) => {
        if (!active) return;
        const fallback = (session.title || "").trim() || session.branch || "";
        if (fallback) setTitle((current) => (current.trim() ? current : fallback));
      })
      .catch(() => {
        // 读不到会话标题时保留空标题，由用户自己填写。
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  const load = useCallback(async (silent = false): Promise<void> => {
    // 创建请求进行中不发起 GET：POST 返回的状态才是权威结果，创建前的
    // 旧 GET 也可能在创建后才返回，不能被应用（见 submit 的令牌推进）。
    if (creatingRef.current) return;
    const begin = beginLoad(flagRef.current, Boolean(statusRef.current));
    flagRef.current = begin.state;
    const seq = begin.token;
    // 捕获发起时的会话，响应回来时据此丢弃切换会话后的旧结果。
    const requestSession = sessionId;
    const guard = (): boolean => canApplyResponse({
      mounted: mountedRef.current,
      sessionMatches: sessionIdRef.current === requestSession,
      requestToken: seq,
      currentToken: flagRef.current.seq,
    });
    if (!silent) {
      setNotice("");
      if (begin.ownsRefreshing) setRefreshing(true);
      if (begin.ownsLoading) setLoading(true);
    }
    try {
      const next = await getPullRequest(sessionId);
      if (!guard()) return;
      const before = statusRef.current;
      const previousSignature = signatureRef.current;
      const nextSignature = statusSignature(next);
      setStatus(next);
      statusRef.current = next;
      setError("");
      // 不支持 PR/MR 的仓库没必要继续轮询。
      if (!next.supported) setMonitor(false);
      if (silent && before && previousSignature && previousSignature !== nextSignature) {
        setNotice(describeChange(before, next));
      }
      signatureRef.current = nextSignature;
    } catch (reason) {
      if (!guard()) return;
      setError(errorText(reason, "无法读取 PR/MR 状态"));
    } finally {
      if (mountedRef.current && sessionIdRef.current === requestSession) {
        // 标志清理和令牌解耦：即使这次响应已被创建或新请求作废，也要释放
        // 自己点亮的 loading/refreshing，否则按钮会永久停在“刷新中”。
        flagRef.current = finishLoad(flagRef.current, seq, begin.ownsRefreshing, begin.ownsLoading);
        setRefreshing(flagRef.current.refreshingOwner !== 0);
        setLoading(flagRef.current.loadingOwner !== 0);
      }
    }
  }, [sessionId]);

  // 切换会话时清掉上一份状态，重新读取；同时让上一会话的所有异步结果失效。
  useEffect(() => {
    // 令牌必须继续递增：S → T → S 时旧 S 的在途请求不能和新 S 的请求同号。
    flagRef.current = resetSessionFlags(flagRef.current);
    setRefreshing(false);
    creatingRef.current = false;
    setCreating(false);
    setAgentBusy(false);
    setStatus(null);
    statusRef.current = null;
    signatureRef.current = "";
    setError("");
    setNotice("");
    setMonitor(false);
    setTitle("");
    setBody("");
    setBase("");
    setLoading(true);
    void load(false);
  }, [sessionId, load]);

  // 监视：页面可见时每 30 秒刷新一次；切回页面立即补一次。
  useEffect(() => {
    if (!monitor) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load(true);
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [monitor, load]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (creatingRef.current) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("请填写标题");
      return;
    }
    const requestSession = sessionId;
    // 创建开始就推进令牌并接管加载态：创建前发起的 GET 即使更晚返回也会
    // 被丢弃；被它点亮的“刷新中”也立即复位，避免按钮永久禁用。
    // 创建期间 load 看到 creatingRef 也不再发起新 GET。
    const begin = beginCreate(flagRef.current);
    flagRef.current = begin.state;
    const seq = begin.token;
    creatingRef.current = true;
    setCreating(true);
    setRefreshing(false);
    setLoading(false);
    setError("");
    setNotice("");
    let finished = false;
    const canApply = (): boolean => canApplyResponse({
      mounted: mountedRef.current,
      sessionMatches: sessionIdRef.current === requestSession,
      requestToken: seq,
      currentToken: flagRef.current.seq,
    });
    try {
      const next = await createPullRequest(requestSession, {
        title: trimmedTitle,
        body,
        ...(base.trim() ? { base: base.trim() } : {}),
      });
      if (!canApply()) return;
      setStatus(next);
      statusRef.current = next;
      signatureRef.current = statusSignature(next);
      if (!next.supported) setMonitor(false);
      if (!next.error) {
        setNotice(next.exists ? "PR/MR 已创建" : "创建命令已完成，正在等待状态同步");
      }
      if (next.exists) {
        // 创建成功后清空表单，避免重复点击。
        setBody("");
      }
      finished = true;
    } catch (reason) {
      if (!canApply()) return;
      setError(errorText(reason, "创建 PR/MR 失败"));
      finished = true;
    } finally {
      if (finished) {
        // 创建结束后再推进一次令牌，保证任何夹在中间的旧 GET 都失效；
        // 同时清空遗留的刷新/加载标志。
        flagRef.current = finishCreate(flagRef.current);
        creatingRef.current = false;
        if (mountedRef.current) {
          setCreating(false);
          setRefreshing(false);
          setLoading(false);
        }
      }
    }
  }

  async function handOffToAgent(): Promise<void> {
    if (agentBusy) return;
    const current = statusRef.current;
    const failed = (current?.checks ?? []).filter(isFailedCheck);
    if (failed.length === 0) return;
    const requestSession = sessionId;
    const belongs = (): boolean => mountedRef.current && sessionIdRef.current === requestSession;
    setAgentBusy(true);
    setError("");
    try {
      const list = failed
        .map((check) => `- ${check.name}（${checkLabel(check)}${check.url ? `：${check.url}` : ""}）`)
        .join("\n");
      const target = `${current?.number ? ` #${current.number}` : ""}${current?.url ? `（${current.url}）` : ""}`;
      const prompt = [
        `PR/MR${target} 有 ${failed.length} 项检查失败：`,
        list,
        "请查看失败日志，定位并修复问题；修好后说明改了什么。",
      ].join("\n");
      await sendMessage(requestSession, prompt);
      if (belongs()) setNotice("已把失败检查发送给 agent");
    } catch (reason) {
      if (belongs()) setError(errorText(reason, "发送给 agent 失败"));
    } finally {
      if (belongs()) setAgentBusy(false);
    }
  }

  const merge = mergeableLabel(status?.mergeable);
  const failedChecks = status?.checks.filter(isFailedCheck) ?? [];
  const showMonitor = status?.supported !== false;
  // 创建成功但随后读取状态失败时，服务端仍会带 created + url；保留链接入口。
  const showCreatedLink = status?.exists === false && status.created === true && Boolean(status.url);

  return (
    <section className="pr-panel" aria-label="PR/MR">
      <div className="pr-head">
        <span className="pr-heading">PR / MR</span>
        <span className="pr-actions">
          <button
            type="button"
            disabled={loading || refreshing || creating}
            onClick={() => void load(false)}
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
          {showMonitor && (
            <button
              type="button"
              className={monitor ? "pr-monitor on" : "pr-monitor"}
              aria-pressed={monitor}
              onClick={() => setMonitor((value) => !value)}
            >
              {monitor ? "监视中" : "监视"}
            </button>
          )}
        </span>
      </div>

      {loading && !status && (
        <p className="pr-hint" role="status">正在读取 PR/MR 状态…</p>
      )}

      {!loading && status && !status.supported && (
        <p className="pr-hint">{status.error || "当前仓库不支持 PR/MR 功能"}</p>
      )}

      {status && status.supported && (
        <>
          {status.error && (
            <p className="pr-error" role="alert">{status.error}</p>
          )}

          {status.exists && (
            <div className="pr-summary">
              <div className="pr-title-row">
                {status.url ? (
                  <a className="pr-link" href={status.url} target="_blank" rel="noreferrer">
                    {status.number ? `#${status.number} ` : ""}
                    {status.title || "查看 PR/MR"}
                  </a>
                ) : (
                  <span className="pr-link">
                    {status.number ? `#${status.number} ` : ""}
                    {status.title || "PR/MR"}
                  </span>
                )}
                <div className="pr-badges">
                  <span className={`pr-badge pr-state-${(status.state ?? "unknown").toLowerCase()}`}>
                    {stateLabel(status.state)}
                  </span>
                  {merge && <span className={`pr-badge pr-merge-${merge.tone}`}>{merge.text}</span>}
                </div>
              </div>

              {status.checks.length > 0 ? (
                <ul className="pr-checks">
                  {status.checks.map((check, index) => {
                    const tone = checkTone(check);
                    return (
                      <li key={`${check.name}-${index}`} className={`pr-check ${tone}`}>
                        <span className="pr-check-dot" aria-hidden="true" />
                        {check.url ? (
                          <a className="pr-check-name" href={check.url} target="_blank" rel="noreferrer">
                            {check.name}
                          </a>
                        ) : (
                          <span className="pr-check-name">{check.name}</span>
                        )}
                        <span className="pr-check-state">{checkLabel(check)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="pr-hint">没有检查项</p>
              )}

              {failedChecks.length > 0 && (
                <button
                  type="button"
                  className="pr-agent"
                  disabled={agentBusy}
                  onClick={() => void handOffToAgent()}
                >
                  {agentBusy ? "发送中…" : "让 agent 处理失败检查"}
                </button>
              )}
            </div>
          )}

          {showCreatedLink && (
            <div className="pr-summary">
              <div className="pr-title-row">
                <a className="pr-link" href={status.url} target="_blank" rel="noreferrer">
                  {status.number ? `#${status.number} ` : ""}
                  {status.title || "查看 PR/MR"}
                </a>
              </div>
              <p className="pr-hint">PR/MR 已创建，但暂时读取不到最新状态，可稍后刷新。</p>
            </div>
          )}

          {!status.exists && !showCreatedLink && (
            <form className="pr-form" onSubmit={(event) => void submit(event)}>
              <label className="pr-field">
                <span>标题</span>
                <input
                  value={title}
                  maxLength={200}
                  disabled={creating}
                  placeholder="PR/MR 标题"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="pr-field">
                <span>正文</span>
                <textarea
                  value={body}
                  maxLength={20_000}
                  rows={3}
                  disabled={creating}
                  placeholder="说明这次改动"
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <label className="pr-field">
                <span>目标分支（可选）</span>
                <input
                  value={base}
                  disabled={creating}
                  placeholder="留空使用托管平台默认分支"
                  onChange={(event) => setBase(event.target.value)}
                />
              </label>
              <div className="pr-form-actions">
                <button type="submit" disabled={creating || !title.trim()}>
                  {creating ? "创建中…" : "创建 PR/MR"}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {error && <p className="pr-error" role="alert">{error}</p>}
      {notice && <p className="pr-notice" role="status">{notice}</p>}
    </section>
  );
}
