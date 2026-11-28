import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "./atomic-file.js";
import type { AppConfig, ProjectConfig } from "./config.js";
import type { FeatureContext, FeatureResult } from "./feature-routes.js";
import { findProvider, type StoredSettings } from "./settings.js";
import { isActivePhase } from "./status.js";
import type { SessionEvent, Store } from "./store.js";
import { isEffort, type Effort, type Phase, type SessionSummary } from "./types.js";
import { isGitRepo, redactGitCredentials } from "./worktree.js";
import type { Runtime } from "./runtime.js";

const exec = promisify(execFile);

/**
 * 批量会话监听与整合（Batch Watch & Integrate）。
 *
 * 解决多会话并行开发后「等全部完成 → 统一审核修订 → 合并提交/推送/部署」的痛点：
 * - 等待阶段完全由服务端脚本监听 Store 事件（零 LLM token 消耗），不再开一个对话空转轮询；
 * - 任一被监听会话失败、已停止或进入等待确认时，暂停并标明原因，由用户决定跳过继续、重试或取消；
 * - 全部目标会话就绪后，自动创建一个指定接口/模型/effort 的整合会话，由模型统一审核修订各会话工作区/分支并按所选收尾动作（提交 / merge 或 rebase / 推送 / 部署）完成落地。
 *
 * 持久化到 `<dataDir>/batch-watches.json`（按项目过滤），进程重启后仍在等待中的任务会自动恢复监听。
 */

export const MAX_WATCH_SESSIONS = 20;
export const MAX_WATCHES_PER_PROJECT = 30;
export const MAX_EXTRA_PROMPT = 4_000;
export const MAX_BASE_BRANCH = 120;

export const MERGE_MODES = ["none", "merge", "rebase"] as const;
export type BatchMergeMode = (typeof MERGE_MODES)[number];

export const WATCH_STATUSES = [
  "waiting",
  "paused",
  "launching",
  "reviewing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type BatchWatchStatus = (typeof WATCH_STATUSES)[number];

export interface BatchWatchActions {
  /** 是否把各会话未提交改动及整合修订统一提交。 */
  commit: boolean;
  /** 合入主分支方式：none（不合入）、merge（--no-ff 合并）或 rebase（变基快进）。 */
  mergeMode: BatchMergeMode;
  /** 合入后是否推送远端。 */
  push: boolean;
  /** 是否在审核合并后执行部署。 */
  deploy: boolean;
  /** 目标基准分支名（缺省 main）。 */
  baseBranch?: string;
}

export interface BatchWatchTarget {
  sessionId: string;
  /** 创建监听时的标题快照，原会话被删除后仍能识别。 */
  title: string;
  /** 会话分支名快照。 */
  branch?: string;
  /** 被用户选择跳过的会话：不再阻塞启动，也不会交给整合模型。 */
  skipped?: boolean;
}

export interface BatchWatchTargetView extends BatchWatchTarget {
  /** 当前实时状态；原会话被删/归档时为 "missing"。 */
  phase: Phase | "missing";
  /** 当前实时标题（会话存在时优先使用最新标题）。 */
  currentTitle: string;
  /** 当前工作目录（用于提示整合模型检查）。 */
  cwd?: string;
  /** 最近一次错误（会话 failed 时）。 */
  lastError?: string;
  /** 是否已就绪（skipped 或 completed）。 */
  ready: boolean;
  /** 阻塞暂停的原因（failed / stopped / needs_input / missing）。 */
  blocker?: string;
}

export interface BatchWatchRecord {
  id: string;
  projectId: string;
  targets: BatchWatchTarget[];
  /** 最终审核修订会话使用的接口、模型与 effort。 */
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  actions: BatchWatchActions;
  /** 用户追加的审核/整合说明。 */
  extraPrompt?: string;
  status: BatchWatchStatus;
  /** 暂停原因说明（例如某会话失败/等待确认）。 */
  pauseReason?: string;
  /** 触发暂停的会话 id 列表。 */
  pausedSessionIds?: string[];
  /** 启动的整合审核会话 id。 */
  reviewSessionId?: string;
  /** 启动或执行失败时的错误信息。 */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface BatchWatchView extends BatchWatchRecord {
  targetViews: BatchWatchTargetView[];
  reviewPhase?: Phase | "missing";
}

export interface CreateBatchWatchInput {
  projectId: string;
  sessionIds: string[];
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  actions: BatchWatchActions;
  extraPrompt?: string;
}

export interface CollectedTargetSnapshot {
  sessionId: string;
  title: string;
  branch?: string;
  cwd: string;
  git: boolean;
  phase: Phase;
  statusShort: string;
  diffStat: string;
  commitsAhead: string;
  lastAssistantSummary: string;
}

export class BatchWatchError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "BatchWatchError";
  }
}

export function isBatchMergeMode(value: unknown): value is BatchMergeMode {
  return typeof value === "string" && (MERGE_MODES as readonly string[]).includes(value);
}

/** 校验并归一化收尾动作组合，避免出现「未合入却要推送/部署」这类矛盾配置。 */
export function normalizeBatchActions(raw: unknown): BatchWatchActions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BatchWatchError(400, "actions 必须是对象");
  }
  const record = raw as Record<string, unknown>;
  const commit = record.commit === true;
  const mergeMode = record.mergeMode;
  if (!isBatchMergeMode(mergeMode)) {
    throw new BatchWatchError(400, "mergeMode 必须是 none、merge 或 rebase");
  }
  const push = record.push === true;
  const deploy = record.deploy === true;
  const rawBase = typeof record.baseBranch === "string" ? record.baseBranch.trim() : "";
  if (rawBase.length > MAX_BASE_BRANCH) {
    throw new BatchWatchError(400, `目标分支名不能超过 ${MAX_BASE_BRANCH} 字`);
  }
  if (rawBase && !/^[a-zA-Z0-9._/-]+$/.test(rawBase)) {
    throw new BatchWatchError(400, "目标分支名包含非法字符");
  }
  if (mergeMode !== "none" && !commit) {
    throw new BatchWatchError(400, "启用合并或 rebase 时必须同时勾选「提交」");
  }
  if (push && !commit) {
    throw new BatchWatchError(400, "启用推送时必须同时勾选「提交」");
  }
  if (deploy && mergeMode === "none") {
    throw new BatchWatchError(400, "启用部署时必须先合入主分支（merge 或 rebase）");
  }
  return {
    commit,
    mergeMode,
    push,
    deploy,
    ...(rawBase ? { baseBranch: rawBase } : {}),
  };
}

/** 单条会话在监听状态下的阻塞原因；无阻塞返回 undefined。 */
export function targetBlocker(
  phase: Phase | "missing",
  title: string,
  lastError?: string,
): string | undefined {
  if (phase === "missing") return `会话「${title}」已被归档或删除`;
  if (phase === "needs_input") return `会话「${title}」正在等待确认`;
  if (phase === "failed") {
    return lastError ? `会话「${title}」执行失败：${lastError}` : `会话「${title}」执行失败`;
  }
  if (phase === "stopped") return `会话「${title}」已停止`;
  if (phase === "setup") return `会话「${title}」尚未开始（停留在配置阶段）`;
  return undefined;
}

export interface WatchEvaluation {
  /** 下一步应处于的状态：waiting / paused / ready（可立即启动审核会话）。 */
  decision: "waiting" | "paused" | "ready" | "no_active_targets";
  pauseReason?: string;
  pausedSessionIds: string[];
}

/**
 * 纯函数：根据被监听会话的实时状态，判断监听任务应当继续等待、暂停还是立即启动审核。
 *
 * 规则：
 * - 被用户标记 skipped 的会话不参与判断；
 * - 只要任一未跳过会话出现异常/阻塞（failed / stopped / needs_input / setup / missing），立刻暂停；
 * - 仍有未跳过会话处于 queued / running，继续等待（不消耗任何 token）；
 * - 所有未跳过会话都为 completed，返回 ready；
 * - 如果所有会话都被跳过，返回 no_active_targets（暂停并提示）。
 */
export function evaluateWatchTargets(
  targets: readonly BatchWatchTarget[],
  lookup: (sessionId: string) => Pick<SessionSummary, "phase" | "title" | "lastError"> | undefined,
): WatchEvaluation {
  const activeTargets = targets.filter((item) => !item.skipped);
  if (activeTargets.length === 0) {
    return {
      decision: "no_active_targets",
      pauseReason: "所有被监听会话都已跳过，没有可整合的会话",
      pausedSessionIds: [],
    };
  }

  const blockers: string[] = [];
  const pausedSessionIds: string[] = [];
  let anyRunning = false;

  for (const target of activeTargets) {
    const live = lookup(target.sessionId);
    const phase: Phase | "missing" = live ? live.phase : "missing";
    const title = live?.title || target.title;
    const blocker = targetBlocker(phase, title, live?.lastError);
    if (blocker) {
      blockers.push(blocker);
      pausedSessionIds.push(target.sessionId);
    } else if (phase === "queued" || phase === "running") {
      anyRunning = true;
    }
  }

  if (blockers.length > 0) {
    return {
      decision: "paused",
      pauseReason: blockers.join("；"),
      pausedSessionIds,
    };
  }
  if (anyRunning) {
    return { decision: "waiting", pausedSessionIds: [] };
  }
  return { decision: "ready", pausedSessionIds: [] };
}

/** 构造发给整合审核会话的 prompt：带上脚本采集好的各会话工作区状态与所选收尾动作。 */
export function buildIntegrationPrompt(input: {
  projectName: string;
  projectPath: string;
  git: boolean;
  actions: BatchWatchActions;
  snapshots: readonly CollectedTargetSnapshot[];
  extraPrompt?: string;
}): string {
  const baseBranch = input.actions.baseBranch || "main";
  const actionSteps: string[] = [];
  if (input.actions.commit) {
    actionSteps.push("- **提交**：先为每个仍有未提交改动的来源会话工作区/分支整理并提交改动，整合修订后同样提交，确保不遗留脏文件。");
  } else {
    actionSteps.push("- **不自动提交**：仅在当前整合工作区完成审核与修订，不要执行 git commit。");
  }
  if (input.actions.mergeMode === "merge") {
    actionSteps.push(`- **合并（merge）**：把全部修订通过的改动以 merge（--no-ff）方式合入 \`${baseBranch}\`，如有冲突请仔细解决并复查。`);
  } else if (input.actions.mergeMode === "rebase") {
    actionSteps.push(`- **变基合并（rebase）**：将改动 rebase 到最新 \`${baseBranch}\` 并 fast-forward 合入 \`${baseBranch}\`，如有冲突请逐条解决并复查。`);
  } else {
    actionSteps.push(`- **不合入 ${baseBranch}**：改动保留在整合分支或原分支，由用户后续决定合入。`);
  }
  if (input.actions.push) {
    actionSteps.push(`- **推送**：确认测试通过后推送到远端（若项目有发布脚本/版本号约定如 \`qubius-land.sh\` 与 \`CLAUDE.md\`，请严格遵守项目约定）。`);
  } else {
    actionSteps.push("- **不推送远端**：不要执行 git push。");
  }
  if (input.actions.deploy) {
    actionSteps.push("- **部署**：按项目部署流程完成构建、重启与健康检查验证（注意遵守项目约定，禁止在会话内重启托管本会话的 co-qubius 服务）。");
  } else {
    actionSteps.push("- **不部署**：不要触发构建部署或重启服务。");
  }

  const sections = input.snapshots.map((snap, index) => {
    const lines = [
      `### ${index + 1}. ${snap.title}`,
      `- 会话 ID：\`${snap.sessionId}\``,
      ...(snap.branch ? [`- 分支：\`${snap.branch}\``] : []),
      `- 工作目录：\`${snap.cwd}\``,
      `- 状态：${snap.phase}`,
    ];
    if (snap.commitsAhead) {
      lines.push(`- 相对 ${baseBranch} 的新增提交：\n\`\`\`\n${snap.commitsAhead}\n\`\`\``);
    }
    if (snap.statusShort) {
      lines.push(`- 工作区未提交改动：\n\`\`\`\n${snap.statusShort}\n\`\`\``);
    }
    if (snap.diffStat) {
      lines.push(`- Diff 统计：\n\`\`\`\n${snap.diffStat}\n\`\`\``);
    }
    if (!snap.commitsAhead && !snap.statusShort) {
      lines.push("- 代码改动：无新增提交且工作区干净（请确认该会话是否仅做调研/答复，或改动是否在其他位置）。");
    }
    if (snap.lastAssistantSummary) {
      lines.push(`- 会话末轮说明摘录：\n> ${snap.lastAssistantSummary.replace(/\n+/g, "\n> ")}`);
    }
    return lines.join("\n");
  });

  const parts = [
    `请对项目「${input.projectName}」（主目录 \`${input.projectPath}\`）以下 ${input.snapshots.length} 个已完成的并行会话执行统一审核、修订与整合：`,
    "",
    "## 来源会话清单（由系统脚本采集）",
    "",
    sections.join("\n\n"),
    "",
    "## 审核与修订要求",
    "1. 逐一检查上述会话的实际代码改动（包括未提交改动和分支提交），核对正确性、边界条件、代码风格与跨会话冲突/重复修改。",
    "2. 如有缺陷、遗漏或跨会话不兼容，直接修订并补充必要测试。",
    "3. 运行项目测试与构建检查，确保所有改动合并在一起后整体通过。",
    "",
    "## 本次指定的收尾动作",
    ...actionSteps,
  ];

  if (input.extraPrompt?.trim()) {
    parts.push("", "## 额外要求", input.extraPrompt.trim());
  }
  return parts.join("\n");
}

function watchesFile(dataDir: string): string {
  return path.join(dataDir, "batch-watches.json");
}

function readStoredWatch(raw: unknown): BatchWatchRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string"
    || typeof r.projectId !== "string"
    || !Array.isArray(r.targets)
    || typeof r.providerId !== "string"
    || typeof r.providerName !== "string"
    || typeof r.model !== "string"
    || !isEffort(r.effort)
    || typeof r.status !== "string"
    || !(WATCH_STATUSES as readonly string[]).includes(r.status)
    || typeof r.createdAt !== "string"
    || typeof r.updatedAt !== "string"
  ) {
    return null;
  }
  let actions: BatchWatchActions;
  try {
    actions = normalizeBatchActions(r.actions);
  } catch {
    return null;
  }
  const targets: BatchWatchTarget[] = [];
  for (const item of r.targets) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.sessionId !== "string" || typeof t.title !== "string") continue;
    targets.push({
      sessionId: t.sessionId,
      title: t.title,
      ...(typeof t.branch === "string" && t.branch ? { branch: t.branch } : {}),
      ...(t.skipped === true ? { skipped: true } : {}),
    });
  }
  if (targets.length === 0) return null;
  return {
    id: r.id,
    projectId: r.projectId,
    targets,
    providerId: r.providerId,
    providerName: r.providerName,
    model: r.model,
    effort: r.effort,
    actions,
    ...(typeof r.extraPrompt === "string" && r.extraPrompt ? { extraPrompt: r.extraPrompt } : {}),
    status: r.status as BatchWatchStatus,
    ...(typeof r.pauseReason === "string" ? { pauseReason: r.pauseReason } : {}),
    ...(Array.isArray(r.pausedSessionIds)
      ? { pausedSessionIds: r.pausedSessionIds.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(typeof r.reviewSessionId === "string" ? { reviewSessionId: r.reviewSessionId } : {}),
    ...(typeof r.lastError === "string" ? { lastError: r.lastError } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(typeof r.startedAt === "string" ? { startedAt: r.startedAt } : {}),
    ...(typeof r.finishedAt === "string" ? { finishedAt: r.finishedAt } : {}),
  };
}

/** 批量监听持久化存储：内存 Map + 原子写 JSON 文件，保持每项目最多 MAX_WATCHES_PER_PROJECT 条。 */
export class BatchWatchStore {
  private watches = new Map<string, BatchWatchRecord>();
  private readonly file: string;
  private readonly now: () => Date;

  constructor(private readonly dataDir: string, now: () => Date = () => new Date()) {
    this.file = watchesFile(dataDir);
    this.now = now;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      console.warn(`[batch-watch] 无法解析 ${this.file}，忽略旧记录`);
      return;
    }
    if (!Array.isArray(parsed)) return;
    let dirty = false;
    for (const item of parsed) {
      const record = readStoredWatch(item);
      if (!record) continue;
      // 进程在上一次 launching 途中重启：回退到 waiting，让管理器重新求值启动。
      if (record.status === "launching") {
        record.status = "waiting";
        record.updatedAt = this.now().toISOString();
        dirty = true;
      }
      this.watches.set(record.id, record);
    }
    if (dirty) this.persist();
  }

  private persist(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const all = [...this.watches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    writeFileAtomic(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  list(projectId?: string): BatchWatchRecord[] {
    return [...this.watches.values()]
      .filter((item) => !projectId || item.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => structuredClone(item));
  }

  get(id: string): BatchWatchRecord | undefined {
    const item = this.watches.get(id);
    return item ? structuredClone(item) : undefined;
  }

  create(record: Omit<BatchWatchRecord, "id" | "createdAt" | "updatedAt">): BatchWatchRecord {
    const at = this.now().toISOString();
    const created: BatchWatchRecord = {
      ...structuredClone(record),
      id: randomUUID(),
      createdAt: at,
      updatedAt: at,
    };
    this.watches.set(created.id, created);
    this.trimProject(created.projectId);
    this.persist();
    return structuredClone(created);
  }

  update(id: string, mutate: (current: BatchWatchRecord) => BatchWatchRecord): BatchWatchRecord {
    const current = this.watches.get(id);
    if (!current) throw new BatchWatchError(404, "找不到批量监听任务");
    const next = mutate(structuredClone(current));
    next.updatedAt = this.now().toISOString();
    this.watches.set(id, next);
    this.persist();
    return structuredClone(next);
  }

  remove(id: string): boolean {
    if (!this.watches.delete(id)) return false;
    this.persist();
    return true;
  }

  private trimProject(projectId: string): void {
    const list = [...this.watches.values()]
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (list.length <= MAX_WATCHES_PER_PROJECT) return;
    // 优先裁剪已终结的旧记录，避免把正在等待/审核的任务裁掉。
    const terminal = list.filter((item) =>
      item.status === "completed" || item.status === "failed" || item.status === "cancelled",
    );
    let excess = list.length - MAX_WATCHES_PER_PROJECT;
    for (let i = terminal.length - 1; i >= 0 && excess > 0; i -= 1) {
      this.watches.delete(terminal[i]!.id);
      excess -= 1;
    }
  }
}

const GIT_PROBE_TIMEOUT_MS = 10_000;
const GIT_PROBE_MAX_BUFFER = 512_000;

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      windowsHide: true,
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: GIT_PROBE_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return redactGitCredentials(stdout.trim());
  } catch {
    return "";
  }
}

/** 采集单个来源会话的 git 变更与末轮说明，不调用任何模型。 */
export async function collectTargetSnapshot(
  store: Store,
  target: BatchWatchTarget,
  baseBranch: string,
): Promise<CollectedTargetSnapshot | null> {
  const session = store.get(target.sessionId);
  if (!session) return null;
  let statusShort = "";
  let diffStat = "";
  let commitsAhead = "";
  if (session.git && fs.existsSync(session.cwd)) {
    const [status, stat, log] = await Promise.all([
      gitOutput(session.cwd, ["status", "--short"]),
      gitOutput(session.cwd, ["diff", "--stat", "HEAD"]),
      gitOutput(session.cwd, ["log", `${baseBranch}..HEAD`, "--oneline", "-n", "20"]),
    ]);
    statusShort = status.slice(0, 2_000);
    diffStat = stat.slice(0, 2_000);
    commitsAhead = log.slice(0, 2_000);
  }
  const lastAssistant = [...session.messages]
    .reverse()
    .find((item) => item.role === "assistant" && item.kind !== "thinking" && item.text.trim().length > 0);
  const lastAssistantSummary = lastAssistant ? lastAssistant.text.trim().slice(0, 600) : "";
  return {
    sessionId: session.id,
    title: session.title,
    ...(session.branch ? { branch: session.branch } : {}),
    cwd: session.cwd,
    git: session.git,
    phase: session.phase,
    statusShort,
    diffStat,
    commitsAhead,
    lastAssistantSummary,
  };
}

export interface BatchWatchCreateSessionInput {
  project: ProjectConfig;
  prompt: string;
  providerId: string;
  model: string;
  effort: Effort;
  title: string;
}

export interface BatchWatchManagerDeps {
  config: AppConfig;
  store: Store;
  runtime: Runtime;
  settings: { current: StoredSettings };
  watchStore: BatchWatchStore;
  /** 启动最终审核会话的工厂函数（通常接到 http.ts 的 createSession）。 */
  createReviewSession: (input: BatchWatchCreateSessionInput) => Promise<{ id: string }>;
  /** 可注入的快照采集函数（测试用，默认走真实 git 命令）。 */
  collectSnapshot?: (
    store: Store,
    target: BatchWatchTarget,
    baseBranch: string,
  ) => Promise<CollectedTargetSnapshot | null>;
}

/**
 * 脚本化监听管理器：
 * 订阅 Store 事件，零 LLM 轮询成本；所有目标会话完成即自动触发审核整合会话，
 * 任一目标异常/等待确认即暂停并记录原因等待用户介入。
 */
export class BatchWatchManager {
  private unsubscribe?: () => void;
  private launching = new Set<string>();
  private readonly collect: (
    store: Store,
    target: BatchWatchTarget,
    baseBranch: string,
  ) => Promise<CollectedTargetSnapshot | null>;

  constructor(private readonly deps: BatchWatchManagerDeps) {
    this.collect = deps.collectSnapshot ?? collectTargetSnapshot;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.store.subscribe((event) => {
      this.onSessionEvent(event);
    });
    // 启动后立即检查一次已有任务，避免服务重启期间目标会话已落定但无人唤醒。
    for (const watch of this.deps.watchStore.list()) {
      if (watch.status === "waiting" || watch.status === "reviewing") {
        void this.evaluate(watch.id);
      }
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private onSessionEvent(event: SessionEvent): void {
    for (const watch of this.deps.watchStore.list(event.projectId)) {
      if (watch.status === "waiting" && watch.targets.some((t) => t.sessionId === event.id)) {
        void this.evaluate(watch.id);
      } else if (watch.status === "reviewing" && watch.reviewSessionId === event.id) {
        this.syncReviewSession(watch, event);
      }
    }
  }

  private syncReviewSession(watch: BatchWatchRecord, event: SessionEvent): void {
    if (event.removed) {
      this.deps.watchStore.update(watch.id, (current) => ({
        ...current,
        status: "failed",
        lastError: "整合审核会话已被归档或删除",
        finishedAt: new Date().toISOString(),
      }));
      return;
    }
    if (event.phase === "completed") {
      this.deps.watchStore.update(watch.id, (current) => ({
        ...current,
        status: "completed",
        lastError: undefined,
        finishedAt: new Date().toISOString(),
      }));
    } else if (event.phase === "failed" || event.phase === "stopped") {
      this.deps.watchStore.update(watch.id, (current) => ({
        ...current,
        status: "failed",
        lastError: event.lastError || (event.phase === "stopped" ? "整合审核会话已停止" : "整合审核会话执行失败"),
        finishedAt: new Date().toISOString(),
      }));
    }
  }

  /** 带实时会话视图的查询结果。 */
  view(record: BatchWatchRecord): BatchWatchView {
    const targetViews: BatchWatchTargetView[] = record.targets.map((target) => {
      const live = this.deps.store.get(target.sessionId);
      const phase: Phase | "missing" = live ? live.phase : "missing";
      const currentTitle = live?.title || target.title;
      const blocker = target.skipped ? undefined : targetBlocker(phase, currentTitle, live?.lastError);
      return {
        ...target,
        phase,
        currentTitle,
        ...(live?.cwd ? { cwd: live.cwd } : {}),
        ...(live?.lastError ? { lastError: live.lastError } : {}),
        ready: Boolean(target.skipped) || phase === "completed",
        ...(blocker ? { blocker } : {}),
      };
    });
    let reviewPhase: Phase | "missing" | undefined;
    if (record.reviewSessionId) {
      const reviewSession = this.deps.store.get(record.reviewSessionId);
      reviewPhase = reviewSession ? reviewSession.phase : "missing";
    }
    return {
      ...record,
      targetViews,
      ...(reviewPhase ? { reviewPhase } : {}),
    };
  }

  listViews(projectId: string): BatchWatchView[] {
    return this.deps.watchStore.list(projectId).map((item) => this.view(item));
  }

  create(input: CreateBatchWatchInput): BatchWatchView {
    const project = this.deps.config.projects.find((item) => item.id === input.projectId);
    if (!project) throw new BatchWatchError(404, "找不到项目");

    const uniqueIds = [...new Set(input.sessionIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) throw new BatchWatchError(400, "至少选择一个要监听的会话");
    if (uniqueIds.length > MAX_WATCH_SESSIONS) {
      throw new BatchWatchError(400, `最多同时监听 ${MAX_WATCH_SESSIONS} 个会话`);
    }

    const targets: BatchWatchTarget[] = uniqueIds.map((sessionId) => {
      const session = this.deps.store.get(sessionId);
      if (!session || session.projectId !== project.id) {
        throw new BatchWatchError(400, `会话 ${sessionId} 不存在或不属于该项目`);
      }
      return {
        sessionId: session.id,
        title: session.title,
        ...(session.branch ? { branch: session.branch } : {}),
      };
    });

    const extraPrompt = input.extraPrompt?.trim();
    if (extraPrompt && extraPrompt.length > MAX_EXTRA_PROMPT) {
      throw new BatchWatchError(400, `额外要求不能超过 ${MAX_EXTRA_PROMPT} 字`);
    }

    const record = this.deps.watchStore.create({
      projectId: project.id,
      targets,
      providerId: input.providerId,
      providerName: input.providerName,
      model: input.model,
      effort: input.effort,
      actions: input.actions,
      ...(extraPrompt ? { extraPrompt } : {}),
      status: "waiting",
    });

    // 异步求值：如果所选会话此刻已全部完成，会立即进入审核整合；若有异常会立刻标 paused。
    void this.evaluate(record.id);
    return this.view(this.deps.watchStore.get(record.id) ?? record);
  }

  /**
   * 对指定任务重新求值。
   * - waiting：检查是否暂停或就绪；
   * - reviewing：检查审核会话是否已经落定（用于服务重启恢复）。
   */
  async evaluate(watchId: string): Promise<BatchWatchView | undefined> {
    const watch = this.deps.watchStore.get(watchId);
    if (!watch) return undefined;

    if (watch.status === "reviewing" && watch.reviewSessionId) {
      const reviewSession = this.deps.store.get(watch.reviewSessionId);
      if (!reviewSession) {
        const updated = this.deps.watchStore.update(watch.id, (current) => ({
          ...current,
          status: "failed",
          lastError: "整合审核会话已不存在",
          finishedAt: new Date().toISOString(),
        }));
        return this.view(updated);
      }
      if (!isActivePhase(reviewSession.phase)) {
        const updated = this.deps.watchStore.update(watch.id, (current) => ({
          ...current,
          status: reviewSession.phase === "completed" ? "completed" : "failed",
          lastError: reviewSession.phase === "completed"
            ? undefined
            : reviewSession.lastError || (reviewSession.phase === "stopped" ? "整合审核会话已停止" : "整合审核会话执行失败"),
          finishedAt: new Date().toISOString(),
        }));
        return this.view(updated);
      }
      return this.view(watch);
    }

    if (watch.status !== "waiting") return this.view(watch);

    const evaluation = evaluateWatchTargets(watch.targets, (id) => {
      const session = this.deps.store.get(id);
      return session
        ? { phase: session.phase, title: session.title, lastError: session.lastError }
        : undefined;
    });

    if (evaluation.decision === "waiting") {
      return this.view(watch);
    }

    if (evaluation.decision === "paused" || evaluation.decision === "no_active_targets") {
      const updated = this.deps.watchStore.update(watch.id, (current) => ({
        ...current,
        status: "paused",
        pauseReason: evaluation.pauseReason,
        pausedSessionIds: evaluation.pausedSessionIds,
      }));
      return this.view(updated);
    }

    // ready：启动最终审核整合会话（防止并发重入）。
    await this.launchReview(watch.id);
    const latest = this.deps.watchStore.get(watch.id);
    return latest ? this.view(latest) : undefined;
  }

  private async launchReview(watchId: string): Promise<void> {
    if (this.launching.has(watchId)) return;
    this.launching.add(watchId);
    try {
      const watch = this.deps.watchStore.get(watchId);
      if (!watch || watch.status !== "waiting") return;
      this.deps.watchStore.update(watchId, (current) => ({
        ...current,
        status: "launching",
        pauseReason: undefined,
        pausedSessionIds: undefined,
        lastError: undefined,
      }));

      const project = this.deps.config.projects.find((item) => item.id === watch.projectId);
      if (!project) throw new Error("所属项目已从配置移除");
      const git = await isGitRepo(project.path);
      const baseBranch = watch.actions.baseBranch || "main";
      const activeTargets = watch.targets.filter((item) => !item.skipped);
      const snapshots: CollectedTargetSnapshot[] = [];
      for (const target of activeTargets) {
        const snapshot = await this.collect(this.deps.store, target, baseBranch);
        if (snapshot) snapshots.push(snapshot);
      }
      if (snapshots.length === 0) {
        throw new Error("没有可用的来源会话可以整合");
      }

      const prompt = buildIntegrationPrompt({
        projectName: project.name,
        projectPath: project.path,
        git,
        actions: watch.actions,
        snapshots,
        extraPrompt: watch.extraPrompt,
      });

      const titleSummary = snapshots.length === 1
        ? snapshots[0]!.title
        : `${snapshots[0]!.title} 等 ${snapshots.length} 个会话`;
      const created = await this.deps.createReviewSession({
        project,
        prompt,
        providerId: watch.providerId,
        model: watch.model,
        effort: watch.effort,
        title: `整合审核 · ${titleSummary}`.slice(0, 80),
      });

      this.deps.watchStore.update(watchId, (current) => ({
        ...current,
        status: "reviewing",
        reviewSessionId: created.id,
        startedAt: new Date().toISOString(),
        lastError: undefined,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "启动整合审核会话失败";
      try {
        this.deps.watchStore.update(watchId, (current) => ({
          ...current,
          status: "failed",
          lastError: message,
          finishedAt: new Date().toISOString(),
        }));
      } catch {
        // 任务可能已被删除，忽略。
      }
    } finally {
      this.launching.delete(watchId);
    }
  }

  /**
   * 用户对暂停/失败任务执行恢复操作：
   * - skipBlockers: 把当前阻塞（failed/stopped/needs_input/missing）的会话标记为 skipped 并继续监听；
   * - retry: 保持目标不变，重新检查所有目标状态（适合用户已在原会话里确认/修复并重新跑通后）；
   * - skipSessionId: 单独跳过某一个目标会话并重新求值。
   */
  async resume(
    watchId: string,
    options: { skipBlockers?: boolean; skipSessionId?: string } = {},
  ): Promise<BatchWatchView> {
    const watch = this.deps.watchStore.get(watchId);
    if (!watch) throw new BatchWatchError(404, "找不到批量监听任务");
    if (watch.status !== "paused" && watch.status !== "failed") {
      throw new BatchWatchError(409, "只有暂停或失败的监听任务才能恢复");
    }

    const blockedSet = new Set(watch.pausedSessionIds ?? []);
    if (options.skipSessionId) blockedSet.add(options.skipSessionId);

    this.deps.watchStore.update(watchId, (current) => ({
      ...current,
      status: "waiting",
      pauseReason: undefined,
      pausedSessionIds: undefined,
      lastError: undefined,
      finishedAt: undefined,
      targets: current.targets.map((target) => {
        if (options.skipBlockers && blockedSet.has(target.sessionId)) {
          return { ...target, skipped: true };
        }
        if (options.skipSessionId && target.sessionId === options.skipSessionId) {
          return { ...target, skipped: true };
        }
        return target;
      }),
    }));

    const evaluated = await this.evaluate(watchId);
    if (!evaluated) throw new BatchWatchError(404, "找不到批量监听任务");
    return evaluated;
  }

  /**
   * 修改等待中或已暂停任务的监听会话集合：
   * - 已有的目标保留原始 title/branch/skipped 快照；
   * - 新加入的目标按当前 Store 中的会话补全快照；
   * - 更新后回到 waiting 并立即重新求值（可能重新进入 waiting/paused/reviewing）。
   */
  async updateTargets(watchId: string, sessionIds: string[]): Promise<BatchWatchView> {
    const watch = this.deps.watchStore.get(watchId);
    if (!watch) throw new BatchWatchError(404, "找不到批量监听任务");
    if (watch.status !== "waiting" && watch.status !== "paused") {
      throw new BatchWatchError(409, "只有等待中或已暂停的监听任务才能修改监听会话");
    }

    const uniqueIds = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) throw new BatchWatchError(400, "至少选择一个要监听的会话");
    if (uniqueIds.length > MAX_WATCH_SESSIONS) {
      throw new BatchWatchError(400, `最多同时监听 ${MAX_WATCH_SESSIONS} 个会话`);
    }

    const project = this.deps.config.projects.find((item) => item.id === watch.projectId);
    if (!project) throw new BatchWatchError(404, "找不到项目");

    const existing = new Map(watch.targets.map((target) => [target.sessionId, target]));
    const targets: BatchWatchTarget[] = uniqueIds.map((sessionId) => {
      // 已在任务里的目标保留原快照：来源会话即使已被归档/删除，
      // 也允许继续保留（或由用户在编辑器里取消勾选移除）。
      const previous = existing.get(sessionId);
      if (previous) return { ...previous };
      const session = this.deps.store.get(sessionId);
      if (!session || session.projectId !== project.id) {
        throw new BatchWatchError(400, `会话 ${sessionId} 不存在或不属于该项目`);
      }
      return {
        sessionId: session.id,
        title: session.title,
        ...(session.branch ? { branch: session.branch } : {}),
      };
    });

    this.deps.watchStore.update(watchId, (current) => ({
      ...current,
      targets,
      status: "waiting",
      pauseReason: undefined,
      pausedSessionIds: undefined,
      lastError: undefined,
      finishedAt: undefined,
    }));

    const evaluated = await this.evaluate(watchId);
    if (!evaluated) throw new BatchWatchError(404, "找不到批量监听任务");
    return evaluated;
  }

  cancel(watchId: string): BatchWatchView {
    const watch = this.deps.watchStore.get(watchId);
    if (!watch) throw new BatchWatchError(404, "找不到批量监听任务");
    if (watch.status === "completed" || watch.status === "cancelled") {
      return this.view(watch);
    }
    const updated = this.deps.watchStore.update(watchId, (current) => ({
      ...current,
      status: "cancelled",
      finishedAt: new Date().toISOString(),
    }));
    return this.view(updated);
  }

  remove(watchId: string): boolean {
    return this.deps.watchStore.remove(watchId);
  }
}

const PROJECT_WATCHES_RE = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,62})\/batch-watches$/;
const SINGLE_WATCH_RE =
  /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,62})\/batch-watches\/([0-9a-f-]{36})(\/(?:resume|cancel))?$/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BatchWatchError(400, "请求体必须是对象");
  }
  return value as Record<string, unknown>;
}

/**
 * 批量会话监听 HTTP 路由：
 * - GET    /api/projects/<projectId>/batch-watches
 * - POST   /api/projects/<projectId>/batch-watches
 * - POST   /api/projects/<projectId>/batch-watches/<id>/resume
 * - POST   /api/projects/<projectId>/batch-watches/<id>/cancel
 * - PATCH  /api/projects/<projectId>/batch-watches/<id>（增减被监听的会话）
 * - DELETE /api/projects/<projectId>/batch-watches/<id>
 */
export async function handleBatchWatchRoutes(ctx: FeatureContext): Promise<FeatureResult | null> {
  const listMatch = ctx.url.pathname.match(PROJECT_WATCHES_RE);
  const singleMatch = listMatch ? null : ctx.url.pathname.match(SINGLE_WATCH_RE);
  if (!listMatch && !singleMatch) return null;

  const manager = ctx.batchWatches;
  if (!manager) {
    return { status: 503, body: { error: "批量会话监听不可用" } };
  }

  const projectId = (listMatch?.[1] ?? singleMatch?.[1]) || "";
  const project = ctx.config.projects.find((item) => item.id === projectId);
  if (!project) return { status: 404, body: { error: "找不到项目" } };

  try {
    if (listMatch) {
      if (ctx.method === "GET") {
        return { status: 200, body: { watches: manager.listViews(project.id) } };
      }
      if (ctx.method === "POST") {
        const body = asRecord(await ctx.readJson(ctx.req));
        const rawIds = body.sessionIds;
        if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === "string")) {
          throw new BatchWatchError(400, "sessionIds 必须是字符串数组");
        }
        const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
        const provider = findProvider(ctx.settings.current, providerId);
        if (!provider) throw new BatchWatchError(400, "先选择一套审核模型的接口配置");
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!provider.models.includes(model)) throw new BatchWatchError(400, "审核模型不在这套配置里");
        const effort = body.effort === undefined ? ctx.settings.current.effort : body.effort;
        if (!isEffort(effort)) {
          throw new BatchWatchError(400, "effort 必须是 low、medium、high、xhigh 或 max");
        }
        const actions = normalizeBatchActions(body.actions);
        const extraPrompt = typeof body.extraPrompt === "string" ? body.extraPrompt : undefined;
        const watch = manager.create({
          projectId: project.id,
          sessionIds: rawIds,
          providerId: provider.id,
          providerName: provider.name,
          model,
          effort,
          actions,
          extraPrompt,
        });
        return { status: 201, body: { watch } };
      }
      return { status: 405, body: { error: "不支持的方法" } };
    }

    const watchId = (singleMatch![2] || "").toLowerCase();
    const action = singleMatch![3] || "";
    const existing = manager.listViews(project.id).find((item) => item.id === watchId);
    if (!existing) return { status: 404, body: { error: "找不到批量监听任务" } };

    if (!action && ctx.method === "PATCH") {
      const body = asRecord(await ctx.readJson(ctx.req));
      const rawIds = body.sessionIds;
      if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === "string")) {
        throw new BatchWatchError(400, "sessionIds 必须是字符串数组");
      }
      const watch = await manager.updateTargets(watchId, rawIds);
      return { status: 200, body: { watch } };
    }

    if (action === "/resume") {
      if (ctx.method !== "POST") return { status: 405, body: { error: "不支持的方法" } };
      const body = asRecord(await ctx.readJson(ctx.req));
      const skipBlockers = body.skipBlockers === true;
      const skipSessionId = typeof body.skipSessionId === "string" ? body.skipSessionId.trim() : undefined;
      const watch = await manager.resume(watchId, {
        skipBlockers,
        ...(skipSessionId ? { skipSessionId } : {}),
      });
      return { status: 200, body: { watch } };
    }

    if (action === "/cancel") {
      if (ctx.method !== "POST") return { status: 405, body: { error: "不支持的方法" } };
      const watch = manager.cancel(watchId);
      return { status: 200, body: { watch } };
    }

    if (ctx.method === "DELETE") {
      manager.remove(watchId);
      return { status: 200, body: { ok: true } };
    }

    return { status: 405, body: { error: "不支持的方法" } };
  } catch (error) {
    if (error instanceof BatchWatchError) {
      return { status: error.status, body: { error: error.message } };
    }
    throw error;
  }
}
