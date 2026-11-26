import { useEffect, useRef, useState } from "react";
import {
  applyEdge,
  basename,
  edgeErrorCode,
  edgeErrorJobId,
  edgeErrorKind,
  edgeRemainingPids,
  getEdgeStatus,
  getEdgeView,
  isEdgeBackupName,
  localCommandHint,
  PLAN_TIMEOUT_MS,
  planEdge,
  reclaimEdge,
  restoreEdge,
  type EdgeJob,
  type EdgePlanView,
  type EdgeView,
} from "../api-edge";
import "./EdgePanel.css";

/* 和部署页保持一致：把浏览器 fetch 的英文 TypeError 换成中文提示。 */
const NETWORK_ERROR_PATTERN =
  /failed to fetch|load failed|networkerror|network error|fetch failed|internet connection appears to be offline/i;

function readableError(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback;
  const message = reason.message.trim();
  if (!message) return fallback;
  if (NETWORK_ERROR_PATTERN.test(message)) return "网络连接失败，请检查网络后重试。";
  return message;
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && (reason.name === "TimeoutError" || /请求超时/.test(reason.message));
}

const POLL_INTERVAL_MS = 2000;
/** 提交后等待任务出现在 status 里的窗口。 */
const JOB_WAIT_MS = 30_000;
/** 连续读不到 status 这么多次就认为状态未知。 */
const UNKNOWN_FAILURES = 3;

const PROVIDER_LABEL: Record<NonNullable<EdgeView["provider"]["resolved"]>, string> = {
  cli: "edgectl CLI",
  native: "服务端原生",
};

function providerLabel(resolved: EdgeView["provider"]["resolved"]): string {
  return resolved ? PROVIDER_LABEL[resolved] : "未确定";
}

const JOB_STATE_LABEL: Record<EdgeJob["state"], string> = {
  running: "运行中",
  success: "成功",
  failed: "失败",
};

const JOB_KIND_LABEL: Record<EdgeJob["kind"], string> = {
  plan: "生成计划",
  apply: "应用入口",
  restore: "恢复入口",
  reclaim: "强制回收",
};

function kindLabel(kind: string | undefined): string {
  if (kind === "plan" || kind === "apply" || kind === "restore" || kind === "reclaim") {
    return JOB_KIND_LABEL[kind];
  }
  // 未知 kind 不展示服务端原始英文，统一说「已有任务」。
  return "已有任务";
}

function busyText(kind: string | undefined): string {
  const label = kindLabel(kind);
  return label === "已有任务"
    ? "已有任务在运行，正在等待它结束。"
    : `已有${label}任务在运行，正在等待它结束。`;
}

function jobTitle(kind: string | undefined): string {
  const label = kindLabel(kind);
  return label === "已有任务" ? label : `${label}任务`;
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function disabledHint(view: EdgeView, configDir?: string): string {
  if (view.hint) return view.hint;
  const dir = (configDir ?? "").trim().replace(/\/+$/, "");
  const envFile = dir ? `${dir}/env` : "配置目录的 env 文件";
  return `未启用公网入口。在 ${envFile} 中配置 QUBIUS_EDGECTL_CONFIG 等服务端变量后重启服务。`;
}

export function EdgePanel({ configDir }: { configDir?: string }) {
  const [view, setView] = useState<EdgeView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [job, setJob] = useState<EdgeJob | null>(null);
  const [polling, setPolling] = useState(false);
  /** 读不到任务状态：允许展示恢复表单，不假装成功。 */
  const [statusUnknown, setStatusUnknown] = useState(false);
  /** 409 busy 的提示；任务轮询结束或用户重新操作时清除。 */
  const [busyNotice, setBusyNotice] = useState("");

  const [plan, setPlan] = useState<EdgePlanView | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState("");
  const [confirmExisting, setConfirmExisting] = useState(false);
  const [confirmDomain, setConfirmDomain] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");

  const [reclaimOpen, setReclaimOpen] = useState(false);
  const [reclaimPids, setReclaimPids] = useState<number[]>([]);
  /** 只使用服务端 residual 错误里明确给出的 jobId，不传前端猜测的旧任务。 */
  const [reclaimJobId, setReclaimJobId] = useState<string | undefined>(undefined);
  const [reclaimConfirm, setReclaimConfirm] = useState("");
  const [reclaiming, setReclaiming] = useState(false);
  const [reclaimError, setReclaimError] = useState("");

  const [backup, setBackup] = useState("");
  /** 当前远端 Caddyfile 的 sha；不是备份文件的 sha。 */
  const [remoteSha, setRemoteSha] = useState("");
  const [restoreDomain, setRestoreDomain] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  /** 哪些字段真正从失败详情自动填过；只在字段为空时置为 true。 */
  const [prefilled, setPrefilled] = useState<{ backup: boolean; remoteSha: boolean; domain: boolean }>({
    backup: false,
    remoteSha: false,
    domain: false,
  });

  const mounted = useRef(true);
  const pollTimer = useRef(0);
  /** 轮询循环是否还在进行；页面重新可见时据此决定要不要立刻补一次。 */
  const pollActive = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const expectedJobId = useRef("");
  const waitForAny = useRef(false);
  const waitDeadline = useRef(0);
  const pollFailures = useRef(0);

  function clearPollTimer() {
    window.clearTimeout(pollTimer.current);
    pollTimer.current = 0;
    pollAbort.current?.abort();
    pollAbort.current = null;
  }

  function stopPolling() {
    pollActive.current = false;
    clearPollTimer();
    if (mounted.current) setPolling(false);
  }

  function schedulePoll(delay = POLL_INTERVAL_MS) {
    pollActive.current = true;
    window.clearTimeout(pollTimer.current);
    pollTimer.current = window.setTimeout(pollStatus, delay);
  }

  function refreshView() {
    if (!mounted.current) return;
    getEdgeView()
      .then((data) => {
        if (!mounted.current) return;
        setView(data);
      })
      .catch(() => {
        // 后台刷新失败不打扰用户；当前视图继续可用。
      });
  }

  function handleJob(next: EdgeJob) {
    setJob(next);
    setStatusUnknown(false);
    if (next.state === "running") {
      waitDeadline.current = Date.now() + JOB_WAIT_MS;
      schedulePoll();
      return;
    }
    stopPolling();
    // 轮询结束：busy 提示已经过时，避免一直挂在页面上。
    setBusyNotice("");
    // 入口状态已经变化：旧计划不可再用。
    if (next.kind === "apply") {
      setPlan(null);
      setConfirmApply(false);
    }
    if (next.kind === "reclaim") {
      setReclaimOpen(false);
      setReclaimPids([]);
      setReclaimJobId(undefined);
      setReclaimConfirm("");
    }
    refreshView();
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
    getEdgeStatus(controller.signal)
      .then((data) => {
        if (!mounted.current || controller.signal.aborted) return;
        pollFailures.current = 0;
        const next = data.job;
        const expected = expectedJobId.current;

        if (next && expected && next.jobId !== expected) {
          // status 里可能是旧任务，也可能本次任务还没写入：在等待窗口内继续轮询。
          if (Date.now() < waitDeadline.current) {
            schedulePoll();
            return;
          }
          // 等不到本次任务：认领服务端当前任务，避免永远卡住。
          expectedJobId.current = next.jobId;
          handleJob(next);
          return;
        }

        if (!next) {
          if (expected) {
            if (Date.now() < waitDeadline.current) {
              schedulePoll();
              return;
            }
            setStatusUnknown(true);
            setBusyNotice("");
            stopPolling();
            return;
          }
          // busy 场景可能暂时读不到任务：短时间等它出现。
          if (waitForAny.current && Date.now() < waitDeadline.current) {
            schedulePoll();
            return;
          }
          const waitedForAny = waitForAny.current;
          stopPolling();
          if (waitedForAny) {
            setBusyNotice("");
            refreshView();
          }
          return;
        }

        expectedJobId.current = next.jobId;
        handleJob(next);
      })
      .catch(() => {
        if (!mounted.current || controller.signal.aborted) return;
        pollFailures.current += 1;
        if (pollFailures.current >= UNKNOWN_FAILURES) {
          setStatusUnknown(true);
          setBusyNotice("");
          stopPolling();
          return;
        }
        schedulePoll();
      });
  }

  function startPolling(jobId?: string, waitForAnyJob = false) {
    if (!mounted.current) return;
    clearPollTimer();
    expectedJobId.current = jobId ?? "";
    waitForAny.current = waitForAnyJob;
    waitDeadline.current = Date.now() + JOB_WAIT_MS;
    pollFailures.current = 0;
    setStatusUnknown(false);
    setPolling(true);
    schedulePoll(400);
  }

  /**
   * 409 busy：部署任务占用时不空等入口任务（status 里不会有它），直接提示并停止轮询；
   * 其它入口任务占用则轮询等它结束。
   */
  function handleBusyReason(reason: unknown) {
    const kind = edgeErrorKind(reason);
    // 服务端给出的 kind 最准确；只有缺失时才参考可能过期的 view.appBusy。
    const deployBusy = kind ? kind === "deploy" : view?.appBusy === "deploy";
    if (deployBusy) {
      setBusyNotice("部署任务正在进行，请等部署结束后再操作公网入口。");
      stopPolling();
      return;
    }
    setBusyNotice(busyText(kind));
    startPolling(undefined, true);
  }

  /** residual：展示服务端给出的残留进程与明确的 jobId，并打开强制回收表单。 */
  function openReclaimForm(reason: unknown) {
    setReclaimPids(edgeRemainingPids(reason));
    setReclaimJobId(edgeErrorJobId(reason));
    setReclaimConfirm("");
    setReclaimError("");
    setReclaimOpen(true);
    setBusyNotice("");
  }

  function onVisibility() {
    // 回到前台且轮询仍在进行：取消排队中的后台计时器，立刻补一次状态。
    if (document.visibilityState !== "visible" || !pollActive.current) return;
    clearPollTimer();
    pollStatus();
  }

  useEffect(() => {
    mounted.current = true;
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      clearPollTimer();
      actionAbort.current?.abort();
      actionAbort.current = null;
    };
    // clearPollTimer/onVisibility 只操作 refs，引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // 重新加载时先停掉旧轮询，避免两个轮询循环并行。
    stopPolling();
    setLoadError("");
    setLoaded(false);
    setPlan(null);
    setPlanError("");
    setApplyError("");
    setStatusUnknown(false);
    getEdgeView(controller.signal)
      .then((data) => {
        if (!mounted.current || controller.signal.aborted) return;
        setView(data);
        setBusyNotice("");
        // 失败详情会在 view 更新后由 effect 自动预填（只填空字段）。
        // 只接续未完成或失败的任务；历史成功任务不常驻显示。
        const last = data.lastJob;
        const currentJob = last && last.state !== "success" ? last : null;
        setJob(currentJob);
        setLoaded(true);
        if (currentJob?.state === "running") {
          startPolling(currentJob.jobId);
        } else if (data.appBusy === "edge") {
          startPolling(undefined, true);
        }
      })
      .catch((reason: unknown) => {
        if (!mounted.current || controller.signal.aborted) return;
        setLoaded(true);
        setLoadError(readableError(reason, "读取公网入口状态失败"));
      });
    return () => controller.abort();
    // startPolling 只操作 refs 和状态 setter。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  /* 失败详情变化时自动预填恢复表单的空字段：
     - 备份名优先 failure.backup，缺失时回退 failure.unknown，只填 basename；
     - 远端 sha 用 failure.remoteSha；
     - 域名为空时用第一个期望站点的第一个域名。
     只填空字段，背景刷新不会覆盖用户已经输入的内容。 */
  useEffect(() => {
    const failure = view?.lastFailure;
    if (!failure) return;
    const backupName = basename(failure.backup || failure.unknown || "");
    const firstDomain = view?.desired[0]?.domains[0] ?? "";
    const filled: Array<"backup" | "remoteSha" | "domain"> = [];
    if (backupName && !backup.trim()) {
      setBackup(backupName);
      filled.push("backup");
    }
    if (failure.remoteSha && !remoteSha.trim()) {
      setRemoteSha(failure.remoteSha);
      filled.push("remoteSha");
    }
    if (firstDomain && !restoreDomain.trim()) {
      setRestoreDomain(firstDomain);
      filled.push("domain");
    }
    if (filled.length > 0) {
      // 字段真的被自动填上了，之前因缺字段产生的错误提示已经过时。
      setRestoreError("");
      setPrefilled((current) => {
        const next = { ...current };
        for (const key of filled) next[key] = true;
        return next;
      });
    }
    // 故意只依赖 view：用户输入不触发重新预填，避免覆盖手工修改。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function onPlan() {
    if (!view || planning) return;
    setPlanning(true);
    setPlanError("");
    setBusyNotice("");
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const next = await planEdge(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setPlan(next);
      setConfirmExisting(false);
      setConfirmApply(false);
      setApplyError("");
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      const code = edgeErrorCode(reason);
      if (code === "busy") {
        setPlan(null);
        handleBusyReason(reason);
      } else if (code === "stale") {
        setPlan(null);
        setPlanError("计划已过期，请重新生成计划。");
      } else if (code === "residual") {
        openReclaimForm(reason);
        setPlanError("锁已空闲，但仍有残留进程；请先强制回收后再生成计划。");
      } else if (isTimeoutReason(reason)) {
        // 服务端 plan 预算可通过 QUBIUS_EDGE_PLAN_TIMEOUT_MS 调大，前端常量可能先超时。
        setPlanError(
          `生成计划请求超时（${PLAN_TIMEOUT_MS / 1000} 秒）。若服务端调大了 QUBIUS_EDGE_PLAN_TIMEOUT_MS，计划可能仍在生成，请稍后刷新查看结果。`,
        );
      } else {
        setPlanError(readableError(reason, "生成计划失败"));
      }
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
      if (mounted.current) setPlanning(false);
    }
  }

  async function onApply() {
    if (!plan || applying) return;
    if (plan.appliable === false) {
      setApplyError("当前计划不可应用，请重新生成计划。");
      return;
    }
    const domain = confirmDomain.trim();
    if (!domain) {
      setApplyError("请填写当前主实例的公网域名。");
      return;
    }
    if (!confirmApply) {
      setApplyError("请勾选确认后应用入口。");
      return;
    }
    if (plan.requiresConfirmExisting && !confirmExisting) {
      setApplyError("请确认替换已有的公网入口配置。");
      return;
    }

    setApplying(true);
    setApplyError("");
    setBusyNotice("");
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const result = await applyEdge({
        planHash: plan.planHash,
        confirmDomain: domain,
        // 只有服务端要求时才带，避免给旧服务端发送多余字段。
        confirmExisting: plan.requiresConfirmExisting ? confirmExisting : undefined,
      }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setStatusUnknown(false);
      startPolling(result.jobId);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      const code = edgeErrorCode(reason);
      if (code === "busy") {
        // 已有任务占用：展示 kind 并等待它结束（部署占用时不空等入口 status）。
        handleBusyReason(reason);
      } else if (code === "stale") {
        setPlan(null);
        setApplyError("计划已过期，请重新「生成计划」。");
      } else if (code === "residual") {
        openReclaimForm(reason);
        setApplyError("锁已空闲，但仍有残留进程；请先强制回收。");
      } else if (code === "conflict") {
        setApplyError(readableError(reason, "应用入口失败：域名或站点存在冲突。"));
      } else {
        setApplyError(readableError(reason, "应用入口失败"));
      }
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
      if (mounted.current) setApplying(false);
    }
  }

  async function onReclaim() {
    if (reclaiming || reclaimConfirm.trim() !== "RECLAIM") return;
    setReclaiming(true);
    setReclaimError("");
    setBusyNotice("");
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      await reclaimEdge({
        confirm: "RECLAIM",
        // 只传服务端 residual 错误里明确给出的 jobId；没有就不传，避免拿着旧任务误回收。
        jobId: reclaimJobId,
      }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setApplyError("");
      setReclaimError("");
      setPlan(null);
      setConfirmApply(false);
      // 202 已受理，立刻收起表单，不必等轮询终态。
      setReclaimOpen(false);
      setReclaimPids([]);
      setReclaimConfirm("");
      setReclaimJobId(undefined);
      startPolling(undefined, true);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      const code = edgeErrorCode(reason);
      if (code === "residual") {
        setReclaimPids(edgeRemainingPids(reason));
        setReclaimJobId(edgeErrorJobId(reason));
        setReclaimError(readableError(reason, "仍有残留进程，请稍后重试。"));
      } else if (code === "busy") {
        handleBusyReason(reason);
      } else {
        setReclaimError(readableError(reason, "强制回收失败"));
      }
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
      if (mounted.current) setReclaiming(false);
    }
  }

  async function onRestore() {
    if (restoring) return;
    const backupName = backup.trim();
    const remoteShaValue = remoteSha.trim();
    const domain = restoreDomain.trim();
    if (!backupName) {
      setRestoreError("请填写备份文件名。");
      return;
    }
    // 白名单校验：只允许 edge-backup-*.Caddyfile 或 edge-unknown-*.Caddyfile。
    if (!isEdgeBackupName(backupName)) {
      setRestoreError("备份文件名必须形如 edge-backup-<jobId>.Caddyfile 或 edge-unknown-<jobId>.Caddyfile。");
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(remoteShaValue)) {
      setRestoreError("当前远端 sha 必须是 64 位小写十六进制。");
      return;
    }
    if (!domain) {
      setRestoreError("请填写当前主实例的公网域名。");
      return;
    }

    setRestoring(true);
    setRestoreError("");
    setBusyNotice("");
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const result = await restoreEdge({ backup: backupName, remoteSha: remoteShaValue, confirmDomain: domain }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (!result.jobId) {
        // 契约要求 202 带 jobId；缺失时不静默轮询一个不存在的任务。
        setRestoreError("服务端未返回恢复任务 id，请刷新页面确认最终状态。");
        refreshView();
        return;
      }
      setStatusUnknown(false);
      setBackup("");
      setRemoteSha("");
      // 恢复会重写入口状态，既有计划已不可用。
      setPlan(null);
      setConfirmApply(false);
      startPolling(result.jobId);
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      const code = edgeErrorCode(reason);
      if (code === "busy") {
        handleBusyReason(reason);
      } else if (code === "stale") {
        setRestoreError("恢复请求已过期，请重新确认备份和域名。");
      } else if (code === "residual") {
        openReclaimForm(reason);
        setRestoreError("存在残留进程，请先强制回收后再恢复。");
      } else if (code === "conflict") {
        setRestoreError(readableError(reason, "恢复入口失败：域名或站点存在冲突。"));
      } else {
        setRestoreError(readableError(reason, "恢复入口失败"));
      }
    } finally {
      if (actionAbort.current === controller) actionAbort.current = null;
      if (mounted.current) setRestoring(false);
    }
  }

  const busy = planning || applying || reclaiming || restoring || polling;
  const restoreAvailable = Boolean(view?.lastFailure) || statusUnknown ||
    (job?.state === "failed" && (job.kind === "apply" || job.kind === "restore"));

  /** 按当前实际值和自动填入情况生成提示：手工填好的字段不再说“请补充”。 */
  function prefillNote(): string {
    const autoFilled: string[] = [];
    if (prefilled.backup && backup.trim()) autoFilled.push("备份文件名");
    if (prefilled.remoteSha && remoteSha.trim()) autoFilled.push("当前远端 sha");
    if (prefilled.domain && restoreDomain.trim()) autoFilled.push("公网域名");
    const autoNote = autoFilled.length > 0
      ? `已从失败详情自动填入${autoFilled.join("、")}（只填空字段，不会覆盖已输入内容）。`
      : "";
    const missing: string[] = [];
    if (!backup.trim()) missing.push("备份文件名");
    if (!remoteSha.trim()) missing.push("当前远端 sha");
    if (!restoreDomain.trim()) missing.push("公网域名");
    if (missing.length === 0) {
      return `${autoNote}字段已填写完整，核对后可直接提交；也可以手动修改。`;
    }
    if (autoFilled.length > 0) {
      return `${autoNote}还需要补充${missing.join("、")}。`;
    }
    return `请补充${missing.join("、")}；如果已有值不对，可以手动修改或按服务端提示走人工恢复。`;
  }

  function renderPlan() {
    if (!plan) return null;
    return (
      <div className="edge-plan">
        <div className="edge-plan-head">
          <strong>计划</strong>
          <span className="edge-badge" data-on={Boolean(plan.planHash)}>
            {PROVIDER_LABEL[plan.provider]}
          </span>
        </div>
        <dl className="edge-plan-info">
          <div>
            <dt>计划哈希</dt>
            <dd className="mono edge-hash">{plan.planHash}</dd>
          </div>
          <div>
            <dt>期望站点</dt>
            <dd>{plan.desired.map((site) => site.name).join("、") || "—"}</dd>
          </div>
        </dl>

        {plan.remoteUnavailable && (
          <p className="edge-warn" role="status">远端暂时不可用：{plan.remoteUnavailable}</p>
        )}
        {plan.warnings.length > 0 && (
          <ul className="edge-warnings">
            {plan.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        )}

        <div className="edge-diff-block">
          <h3>注册表差异</h3>
          <pre className="edge-diff" aria-label="注册表差异">{plan.registryDiff || "（无变化）"}</pre>
        </div>
        <div className="edge-diff-block">
          <h3>远端差异</h3>
          <pre className="edge-diff" aria-label="远端差异">{plan.remoteDiff || "（无变化）"}</pre>
        </div>

        {plan.requiresConfirmExisting && (
          <label className="field field-check">
            <input
              type="checkbox"
              checked={confirmExisting}
              onChange={(event) => setConfirmExisting(event.target.checked)}
            />
            我确认替换已有的公网入口配置
          </label>
        )}
        {plan.requiresForceReclaim && (
          <p className="edge-warn" role="status">该计划需要先强制回收残留进程。</p>
        )}
        {plan.appliable === false && (
          <p className="edge-warn" role="status">
            当前计划不可应用
            {plan.remoteUnavailable ? `：${plan.remoteUnavailable}` : "，请查看警告后重新生成计划。"}
          </p>
        )}

        <div className="edge-apply">
          <label className="field">
            当前主实例公网域名
            <input
              value={confirmDomain}
              placeholder="例如 code.example.com"
              autoComplete="off"
              onChange={(event) => {
                setConfirmDomain(event.target.value);
                setApplyError("");
              }}
            />
          </label>
          <label className="field field-check">
            <input
              type="checkbox"
              checked={confirmApply}
              onChange={(event) => {
                setConfirmApply(event.target.checked);
                setApplyError("");
              }}
            />
            我已确认以上差异，要应用公网入口
          </label>
          <div className="edge-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { void onApply(); }}
              disabled={busy || plan.requiresForceReclaim || plan.appliable === false}
            >
              {applying ? "正在提交…" : "应用入口"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="edge-panel" aria-labelledby="edge-title">
      <h2 id="edge-title">公网入口</h2>

      {!loaded && <p className="muted">正在读取公网入口状态…</p>}

      {loaded && loadError && (
        <div className="edge-block" role="alert">
          <p className="error">{loadError}</p>
          <p className="edge-muted">服务端可能尚未支持公网入口接口，不影响上面的部署功能。</p>
          <div className="edge-actions">
            <button type="button" className="btn" onClick={() => setReloadKey((value) => value + 1)}>
              重试
            </button>
          </div>
        </div>
      )}

      {loaded && !loadError && view && !view.enabled && (
        <p className="edge-hint">{disabledHint(view, configDir)}</p>
      )}

      {loaded && !loadError && view && view.enabled && (
        <>
          <div className="edge-overview">
            <article className="edge-card">
              <div className="edge-row">
                <span className="edge-label">执行方式</span>
                <strong>{providerLabel(view.provider.resolved)}</strong>
                <span className="edge-badge" data-on={view.provider.available}>
                  {view.provider.available ? "可用" : "不可用"}
                </span>
              </div>
              <p className="edge-muted">来源：{view.provider.source || "—"}</p>
              {!view.provider.available && view.provider.reason && (
                <p className="edge-warn" role="status">{view.provider.reason}</p>
              )}
            </article>

            <article className="edge-card">
              <div className="edge-row">
                <span className="edge-label">注册表</span>
                <strong className="mono">{basename(view.registry.name) || "—"}</strong>
                <span className="edge-badge" data-on={!view.registry.drift}>
                  {view.registry.drift ? "有漂移" : "一致"}
                </span>
              </div>
              {view.registry.sha && (
                <p className="edge-muted mono" title={view.registry.sha}>sha：{shortSha(view.registry.sha)}</p>
              )}
              {view.registry.error && <p className="edge-warn" role="status">{view.registry.error}</p>}
            </article>
          </div>

          <div className="edge-card">
            <span className="edge-label">期望站点</span>
            {view.desired.length === 0 ? (
              <p className="edge-muted">服务端没有返回期望站点。</p>
            ) : (
              <ul className="edge-sites">
                {view.desired.map((site) => (
                  <li key={`${site.name}-${site.env}`}>
                    <span className="edge-site-name">{site.name}</span>
                    <span className="edge-domains">
                      {site.domains.map((domain) => (
                        <code className="edge-domain" key={domain}>{domain}</code>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="edge-note">
            更新本地网关需要手动执行{" "}
            <code className="edge-command">{localCommandHint(view.registry)}</code>
            （页面不会执行，也不会展示完整路径）。
          </p>
          {view.hint && <p className="edge-note">{view.hint}</p>}

          {view.appBusy === "deploy" && (
            <p className="edge-note" role="status">部署任务正在进行，入口操作可能需要等待部署结束。</p>
          )}
          {busyNotice && <p className="edge-note" role="status">{busyNotice}</p>}

          {(job || statusUnknown) && (
            <div className="edge-status" data-state={statusUnknown ? "unknown" : job?.state} role={job?.state === "failed" ? "alert" : "status"}>
              <div className="edge-status-head">
                <strong>{job ? jobTitle(job.kind) : "入口任务状态未知"}</strong>
                {job && (
                  <span className="edge-badge" data-on={job.state === "success"}>
                    {JOB_STATE_LABEL[job.state]}
                  </span>
                )}
                {polling && <span className="edge-muted">正在等待任务完成…</span>}
              </div>
              {job?.step && <p className="mono edge-step">{job.step}</p>}
              {/* 外层 .edge-status 在失败时已是 role="alert"，这里不要再嵌套 live region。 */}
              {job?.message && <p className={job.state === "failed" ? "error" : "edge-message"}>{job.message}</p>}
              {job?.pid != null && <p className="edge-muted">PID：{job.pid}</p>}
              {job?.remainingPids && job.remainingPids.length > 0 && (
                <p className="edge-warn">剩余进程：{job.remainingPids.join(", ")}</p>
              )}
              {statusUnknown && (
                <p className="edge-message">暂时读不到任务状态，请稍后刷新确认；如果服务端保留了备份，可以从下面恢复。</p>
              )}
              {job?.logTail && <pre className="edge-log" aria-label="入口任务日志">{job.logTail}</pre>}
            </div>
          )}

          <div className="edge-actions">
            <button
              type="button"
              className="btn"
              onClick={() => { void onPlan(); }}
              disabled={!view.canPlan || busy}
            >
              {planning ? "正在生成计划…" : "生成计划"}
            </button>
            {!view.canPlan && view.planHint && <span className="edge-muted">{view.planHint}</span>}
          </div>
          {planError && <p className="error" role="alert">{planError}</p>}

          {renderPlan()}

          {applyError && <p className="error" role="alert">{applyError}</p>}

          {plan?.requiresForceReclaim && !reclaimOpen && !polling && (
            <div className="edge-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setReclaimPids([]);
                  setReclaimJobId(undefined);
                  setReclaimConfirm("");
                  setReclaimError("");
                  setReclaimOpen(true);
                }}
              >
                强制回收残留进程
              </button>
            </div>
          )}

          {reclaimOpen && (
            <fieldset className="edge-form-block">
              <legend>强制回收残留进程</legend>
              {reclaimPids.length > 0 && (
                <p className="edge-mono">剩余进程：{reclaimPids.join(", ")}</p>
              )}
              <p className="edge-muted">
                强制回收会结束占用入口锁的残留进程，需要输入 <code className="edge-command">RECLAIM</code> 确认。
              </p>
              <label className="field">
                确认短语
                <input
                  value={reclaimConfirm}
                  placeholder="RECLAIM"
                  autoComplete="off"
                  onChange={(event) => {
                    setReclaimConfirm(event.target.value);
                    setReclaimError("");
                  }}
                />
              </label>
              <div className="edge-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => { void onReclaim(); }}
                  disabled={busy || reclaimConfirm.trim() !== "RECLAIM"}
                >
                  {reclaiming ? "正在回收…" : "强制回收"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setReclaimOpen(false);
                    setReclaimJobId(undefined);
                  }}
                  disabled={reclaiming}
                >
                  取消
                </button>
              </div>
              {reclaimError && <p className="error" role="alert">{reclaimError}</p>}
            </fieldset>
          )}

          {restoreAvailable && (
            <fieldset className="edge-form-block">
              <legend>从备份恢复</legend>
              <p className="edge-muted">
                入口任务失败或状态未知时，可以用服务端保留的备份恢复。若备份不存在，服务端会返回错误；
                恢复任务再次失败时只展示服务端最终状态。
              </p>
              <p className="edge-muted">
                {prefillNote()}
                {view.lastFailure?.backupSha && (
                  <span className="mono"> 参考备份 sha：{shortSha(view.lastFailure.backupSha)}</span>
                )}
              </p>
              <div className="edge-form-grid">
                <label className="field">
                  备份文件名
                  <input
                    value={backup}
                    placeholder="edge-backup-<jobId>.Caddyfile"
                    autoComplete="off"
                    onChange={(event) => {
                      setBackup(event.target.value);
                      setRestoreError("");
                    }}
                  />
                </label>
                <label className="field">
                  当前远端 sha
                  <input
                    value={remoteSha}
                    placeholder="当前远端 Caddyfile 的 sha"
                    autoComplete="off"
                    onChange={(event) => {
                      setRemoteSha(event.target.value);
                      setRestoreError("");
                    }}
                  />
                </label>
                <label className="field">
                  当前主实例公网域名
                  <input
                    value={restoreDomain}
                    placeholder="例如 code.example.com"
                    autoComplete="off"
                    onChange={(event) => {
                      setRestoreDomain(event.target.value);
                      setRestoreError("");
                    }}
                  />
                </label>
              </div>
              <div className="edge-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => { void onRestore(); }}
                  disabled={busy}
                >
                  {restoring ? "正在恢复…" : "恢复入口"}
                </button>
              </div>
              {restoreError && <p className="error" role="alert">{restoreError}</p>}
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}
