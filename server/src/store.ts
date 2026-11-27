import fs from "node:fs";
import path from "node:path";
import { removeSessionImages } from "./images.js";
import {
  applySdkMessage,
  assistantOutputText,
  capMessageText,
  clip,
  detectWorkflowSkill,
  derivePhase,
  isActivePhase,
  isAgentActive,
  limitTranscript,
  mainAgentRunning,
  nextWorkflow,
  randomId,
  subagentCounts,
  type SdkMessage,
} from "./status.js";
import { MAX_ROLE_ROUNDS } from "./prl-role.js";
import {
  isEffort,
  type BackgroundTask,
  type DiscussionKind,
  type DiscussionParticipant,
  type DiscussionState,
  type DiscussionStrategy,
  type DiscussionSubtaskState,
  type Effort,
  type ImageRef,
  type PendingRequest,
  type RoleKind,
  type RoleRunPhase,
  type RoleRunState,
  type RoleTeam,
  type RoleUnitPhase,
  type RoleUnitState,
  type SessionCore,
  type SessionSummary,
  type TokenUsage,
  type TranscriptItem,
  type WorkflowRun,
  type WorkflowSkill,
} from "./types.js";
import { TokenRateMeter } from "./token-rate.js";
import {
  summarizeMessagesByProvider,
  usageReport as buildUsageReport,
  type ProviderUsageBucket,
  type UsageProviderInput,
  type UsageReport,
  type UsageSessionInput,
} from "./usage.js";

export interface CreateSessionInput {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  /** 标题只是占位词，等首个成功轮次结束后自动总结；用户显式给标题时不传。 */
  titlePending?: boolean;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  cwd: string;
  branch?: string;
  git: boolean;
  prompt: string;
  images?: ImageRef[];
  /** 首条用户消息随 SDKUserMessage 发出的 uuid；用于回滚/分叉。 */
  sdkUuid?: string;
  /** 聊天输入区显式选择的工作流；缺省时由 prompt 末尾的 token 推导。 */
  workflow?: WorkflowSkill;
}

/** 分叉出新会话的输入；messages 是截断后的前缀，调用方已完成 uuid 重映射。 */
export interface CreateBranchInput {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  /** 父会话的标题还没生成时，分叉会话继续等下一个成功轮次总结。 */
  titlePending?: boolean;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  cwd: string;
  branch?: string;
  git: boolean;
  messages: TranscriptItem[];
  /** forkSession 返回的新 SDK session id。 */
  claudeSessionId: string;
  lastSdkUuid?: string;
  summary: string;
}

/** 回滚后提交的精确状态；messages 由调用方完成 uuid 重映射。 */
export interface ApplyRewindInput {
  messages: TranscriptItem[];
  /**
   * 新 SDK session id；undefined 表示清空。
   * newSdkSession 为 true 时必须同时提供新的 claudeSessionId（且不能是旧会话 id），
   * 否则 applyRewind 抛错，避免被 SDK 当成已有会话续接。
   */
  claudeSessionId?: string;
  /** 全新 SDK 会话（回滚到最开始）。 */
  newSdkSession?: boolean;
  /** 追加到 forkedSdkIds（去重）。 */
  forkedSdkId?: string;
  lastSdkUuid?: string;
  summary?: string;
  /** 掉落消息的起始时间；据此过滤 subagents/backgroundTasks，缺失时全部丢弃。 */
  cutAt?: string;
}

export type SessionEvent = SessionSummary & {
  removed?: boolean;
  /**
   * 这个会话已经结束的轮次数。轮次以 result/失败/停止落定为界，后台子 agent
   * 收尾不算新的一轮；推送据此只在“本轮结束”时通知，而不是子 agent 跑完时。
   */
  turnEnd?: number;
  /** 最近一轮的结果，配合 turnEnd 判断完成还是失败。 */
  lastResult?: SessionCore["lastResult"];
};

/**
 * 详情 SSE 的一帧素材：元数据不带 messages，消息只给 from 起的尾部片段。
 * 调用方（HTTP 层）按连接记住上次发送的位置，避免每个流式增量都复制整段对话。
 */
export interface DetailSlice {
  summary: SessionSummary;
  /** 从 from 起的条目，已去掉服务端内部字段（streaming）。 */
  messages: TranscriptItem[];
  /** 当前完整 messages 的长度。 */
  messageCount: number;
}

type Listener = (session: SessionEvent) => void;

/** 防抖窗口：流式增量只改内存，安静后合并落盘。 */
const PERSIST_DEBOUNCE_MS = 1_000;
/** 流式输出期间防抖会被不断重置；最多等这么久必须强制落盘一次。 */
const PERSIST_MAX_WAIT_MS = 5_000;

/**
 * 搜索时需要的小写正文按消息对象缓存。消息对象不可变替换，替换后旧对象
 * 自动从 WeakMap 消失；标题/摘要每次现算，不受影响。
 */
const loweredText = new WeakMap<TranscriptItem, string>();

function toLowerText(item: TranscriptItem): string {
  const cached = loweredText.get(item);
  if (cached !== undefined) return cached;
  const lower = item.text.toLowerCase();
  loweredText.set(item, lower);
  return lower;
}

export class Store {
  private sessions = new Map<string, SessionCore>();
  private listeners = new Set<Listener>();
  /**
   * 待落盘会话：id -> 首次/最近一次 commit 时间。截止时间取
   * min(last + debounce, first + maxWait)，保证流式期间也会定期落盘。
   */
  private pending = new Map<string, { first: number; last: number }>();
  /** 整个 Store 共用一个调度定时器，只 arm 到当前最早的截止时间。 */
  private scheduler: NodeJS.Timeout | undefined;
  /** 会话用量汇总缓存：key 用 updatedAt + 条数反映消息 usage 变化，按实际接口拆分保存。 */
  private usageCache = new Map<string, { key: string; byProvider: ProviderUsageBucket[] }>();
  /** 各会话的实时输出速度计；只在内存里，进程重启后从零开始。 */
  private tokenRates = new Map<string, TokenRateMeter>();
  /**
   * 子 agent 最近一次输出块的到达时间：会话 -> taskId -> 毫秒时间戳。
   * 子 agent 没有流式增量，整块内容到达时要按距上一块的时间均摊速度。
   */
  private subagentOutputAt = new Map<string, Map<string, number>>();
  /** 收到过子 agent 流式增量的会话：此时以增量为准，完整消息不再重复计数。 */
  private subagentStreams = new Set<string>();
  /** 最近一次落盘失败的会话，供 flush() 重试/上报。 */
  private failures = new Map<string, Error>();
  private emitTimers = new Map<string, NodeJS.Timeout>();
  private lastEmitAt = new Map<string, number>();
  /**
   * 每个会话已结束的轮次数，随事件广播给推送服务。只存在内存里：进程重启
   * 后从头计，推送服务也随之重置，不会把恢复出来的旧状态当成新结束的一轮。
   */
  private turnEnds = new Map<string, number>();
  /** 每个会话在途的异步写入；同一会话同一时刻最多一个。 */
  private writes = new Map<string, Promise<void>>();
  /** 等待写入的最新快照（在途写完成后再落盘，自动合并中间状态）。 */
  private dirty = new Set<string>();
  /** seen 数组的 Set 缓存，避免每次事件都做 includes 线性查找。 */
  private seenSets = new Map<string, Set<string>>();
  /**
   * 已经由 agent 消费、但本轮 result 还没到的会话。SDK 的 streaming input 会
   * 在上一轮还没结束时就把下一条 prompt 拉走；这时不能立刻切换工作流，否则会
   * 覆盖当前轮，并在当前轮 result 到来时把新工作流误标成已结束。
   */
  private awaitingResult = new Set<string>();
  /** 已消费 prompt 的工作流选择，按 FIFO 等下一轮 result 后再生效。 */
  private deferredWorkflows = new Map<string, Array<WorkflowSkill | undefined>>();
  /** flush() 的等待者：没有在途/待写快照时统一唤醒。 */
  private flushWaiters = new Set<() => void>();
  private writeSeq = 0;

  constructor(private dataDir: string) {
    this.load();
  }

  private dir(): string {
    return path.join(this.dataDir, "sessions");
  }

  private load(): void {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return;
    // 旧版本可能留下 0755 的目录；尽力收紧（失败不阻塞加载）。
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // 忽略。
    }
    for (const name of fs.readdirSync(dir)) {
      // 进程崩溃可能留下未 rename 的临时文件，启动时清掉。
      if (name.endsWith(".tmp")) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          // 清理失败不影响加载。
        }
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      // 会话里可能含敏感上下文；旧版本留下的文件也顺手收紧权限（尽力而为）。
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // 权限修复失败不阻塞加载，但要让运维知道文件可能仍然全局可读。
        console.warn(`[store] 无法收紧会话文件权限 ${name}`);
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SessionCore;
        const recovered = recover(parsed);
        this.sessions.set(parsed.id, recovered);
        this.seenSets.set(parsed.id, new Set(recovered.seen));
        if (
          recovered.phase !== parsed.phase
          || recovered.lastResult !== parsed.lastResult
          || recovered.lastError !== parsed.lastError
          || recovered.summary !== parsed.summary
          || recovered.messages.length !== (parsed.messages?.length ?? 0)
          || recovered.pinned !== parsed.pinned
          || recovered.runEndedAt !== parsed.runEndedAt
          || recovered.lastSdkUuid !== parsed.lastSdkUuid
          || recovered.newSdkSession !== parsed.newSdkSession
          || forkedSdkIdsNeedPersist(parsed.forkedSdkIds, recovered.forkedSdkIds)
          || backgroundTasksNeedPersist(parsed.backgroundTasks, recovered.backgroundTasks)
        ) {
          // 启动读取保持同步；修复后的快照走异步持久化，不阻塞启动。
          this.persistSoon(recovered);
        }
      } catch {
        // 坏掉的会话文件留在磁盘上，不影响其他会话。只提示文件名，不打印内容。
        console.warn(`[store] 跳过损坏的会话文件 ${name}`);
      }
    }
  }

  /**
   * 按当前项目配置重新对齐会话里记录的绝对路径。
   *
   * 会话的 projectPath 是创建时的快照；项目改名/搬移后（典型的是 qoder →
   * qubius、或换了一台机器），旧会话还指着已经不存在的目录，下一轮 Claude
   * Code 启动时会因为 `--project-config-root` 不可用直接退出。这里按 projectId
   * 把 projectPath 换成配置里的当前路径；非 git 会话的 cwd 由项目目录派生，
   * 一并平移到新路径。配置里已移除的项目不动（会话仍可查看，目录恢复后继续可用）。
   *
   * @returns 修正的会话数
   */
  reconcileProjects(projects: ReadonlyArray<{ id: string; path: string }>): number {
    const paths = new Map(projects.map((project) => [project.id, project.path]));
    let changed = 0;
    for (const session of [...this.sessions.values()]) {
      const nextPath = paths.get(session.projectId);
      if (!nextPath || nextPath === session.projectPath) continue;
      this.commit({
        ...session,
        projectPath: nextPath,
        cwd: remapProjectCwd(session, nextPath),
      });
      changed += 1;
    }
    return changed;
  }

  list(projectId?: string): SessionSummary[] {
    return this.sortedForList()
      .filter((session) => !projectId || session.projectId === projectId)
      .map((session) => this.summaryOf(session, false));
  }

  /** 所有项目的会话：置顶优先，其余按创建时间倒序。 */
  listAll(): SessionEvent[] {
    return this.sortedForList().map((session) => this.summaryOf(session, false));
  }

  /** 进行中（排队/运行/等确认）的会话数；重启服务会中断它们。 */
  activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (isActivePhase(session.phase)) count += 1;
    }
    return count;
  }

  /**
   * 跨项目搜索会话：大小写不敏感的子串匹配标题、摘要和对话正文。
   * 空 query（或纯空白）等价 listAll。
   */
  search(query: string): SessionEvent[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.listAll();
    return this.sortedForList()
      .filter((session) =>
        (session.title ?? "").toLowerCase().includes(needle)
        || (session.summary ?? "").toLowerCase().includes(needle)
        || session.messages.some((item) =>
          (item.role === "user" || item.role === "assistant" || item.role === "tool")
          && typeof item.text === "string"
          && toLowerText(item).includes(needle)))
      .map((session) => this.summaryOf(session, false));
  }

  /** 置顶在前，其余 createdAt 降序（相同时间保持插入顺序）。 */
  private sortedForList(): SessionCore[] {
    return [...this.sessions.values()].sort((a, b) => {
      const pinnedA = a.pinned === true ? 1 : 0;
      const pinnedB = b.pinned === true ? 1 : 0;
      if (pinnedA !== pinnedB) return pinnedB - pinnedA;
      if (a.createdAt === b.createdAt) return 0;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }

  get(id: string): SessionCore | undefined {
    return this.sessions.get(id);
  }

  /** 内存中会话数量（健康日志用）。 */
  count(): number {
    return this.sessions.size;
  }

  /**
   * 从磁盘重新载入一个会话（归档恢复后使用）。
   * 已存在时直接返回内存中的版本；文件不存在或损坏时返回 undefined / 抛错。
   */
  loadFromDisk(id: string): SessionCore | undefined {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const file = path.join(this.dir(), `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SessionCore;
    if (!parsed || parsed.id !== id) throw new Error("会话文件内容与 id 不一致");
    const recovered = recover(parsed);
    // 归档恢复的会话可能复用了已删除会话的 id，清掉可能残留的用量缓存。
    this.usageCache.delete(recovered.id);
    this.sessions.set(recovered.id, recovered);
    this.seenSets.set(recovered.id, new Set(recovered.seen));
    this.emit(recovered);
    return recovered;
  }

  require(id: string): SessionCore {
    const session = this.sessions.get(id);
    if (!session) throw new Error("找不到对话");
    return session;
  }

  summary(id: string, detail = false): SessionSummary {
    return this.summaryOf(this.require(id), detail);
  }

  /**
   * 详情连接用的元数据摘要：消息体由调用方另行分页，但 roleRun 保留全文，
   * 避免客户端用裁剪后的帧整体覆盖已有进度。
   */
  detailSummary(id: string): SessionSummary {
    const session = this.require(id);
    const summary = this.summaryOf(session, false);
    if (session.roleRun) summary.roleRun = session.roleRun;
    return summary;
  }

  /**
   * 会话摘要；额外带上内存中的实时输出速度。速度只用于顶栏显示，
   * 不落盘、不参与归档与恢复，取整后省略 0 值。
   */
  private summaryOf(session: SessionCore, detail: boolean): SessionSummary {
    const summary = toSummary(session, detail);
    const tokensPerSecond = Math.round(this.tokenRates.get(session.id)?.rate() ?? 0);
    if (tokensPerSecond > 0) summary.tokensPerSecond = tokensPerSecond;
    return summary;
  }

  /**
   * 详情 SSE 的增量素材：只复制 from 之后的尾部，不再为每个增量重建整段 transcript。
   * from 会被夹到 [0, messageCount]；可选 end（排他上界）用于历史分页，
   * 只复制 [start, end) 这一段，不复制整个尾部。
   * 会话不存在时返回 undefined。
   */
  detailSlice(id: string, from: number, end?: number): DetailSlice | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const size = session.messages.length;
    const start = Math.max(0, Math.min(Number.isFinite(from) ? Math.trunc(from) : 0, size));
    const stop = end === undefined
      ? size
      : Math.max(start, Math.min(Number.isFinite(end) ? Math.trunc(end) : size, size));
    const summary = this.summaryOf(session, false);
    // 详情连接需要完整的 roleRun 文本，列表/board 才做裁剪。
    if (session.roleRun) summary.roleRun = session.roleRun;
    return {
      summary,
      messages: session.messages.slice(start, stop).map(strip),
      messageCount: size,
    };
  }

  /**
   * 汇总全部会话的 token 用量与成本。
   * 每个会话的 token 汇总按（updatedAt + 消息条数）缓存：供应商价格每次现算，
   * 所以改价格/增删接口后成本仍然正确；消息被流式增量替换时 updatedAt 会变，
   * 缓存自然失效。缓存里的对象只作为只读来源，报告里返回的是独立副本。
   */
  usageReport(providers: UsageProviderInput[]): UsageReport {
    const inputs: UsageSessionInput[] = [];
    const live = new Set<string>();
    for (const session of this.sessions.values()) {
      live.add(session.id);
      const key = `${session.updatedAt}|${session.messages.length}|${session.providerId}|${session.providerName}`;
      const cached = this.usageCache.get(session.id);
      let byProvider: ProviderUsageBucket[];
      if (cached && cached.key === key) {
        byProvider = cached.byProvider;
      } else {
        byProvider = summarizeMessagesByProvider(
          session.messages,
          session.providerId,
          session.providerName,
        );
        this.usageCache.set(session.id, { key, byProvider });
      }
      inputs.push({
        id: session.id,
        title: session.title,
        projectId: session.projectId,
        providerId: session.providerId,
        providerName: session.providerName,
        byProvider,
      });
    }
    const report = buildUsageReport(inputs, providers);
    // 会话删除后清掉对应缓存；这里也兜底清理已经不在内存里的旧 id。
    for (const id of this.usageCache.keys()) {
      if (!live.has(id)) this.usageCache.delete(id);
    }
    return report;
  }

  /** 改标题/置顶；空标题或非布尔 pinned 直接报错，不改动会话。 */
  updateMeta(id: string, patch: { title?: string; pinned?: boolean }): SessionCore {
    const current = this.require(id);
    const next: SessionCore = { ...current, updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string") throw new Error("标题不能为空");
      const title = patch.title.trim();
      if (!title) throw new Error("标题不能为空");
      if (title.length > 80) throw new Error("标题最多 80 字");
      next.title = title;
      // 用户显式改名后，后台总结不能再把标题覆盖回去。
      delete next.titlePending;
    }
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== "boolean") throw new Error("pinned 必须是布尔值");
      next.pinned = patch.pinned;
    }
    return this.commit(next);
  }

  /**
   * 写入 agent 总结出的标题。只在会话仍处于「标题待生成」时生效：
   * 用户已经手动改名、标题已生成过或会话已删除时返回 undefined，
   * 后台总结不会覆盖用户的选择。
   */
  setGeneratedTitle(id: string, title: string): SessionCore | undefined {
    const current = this.sessions.get(id);
    if (!current || current.titlePending !== true) return undefined;
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle.length > 80) return undefined;
    const next: SessionCore = { ...current, title: nextTitle, updatedAt: new Date().toISOString() };
    delete next.titlePending;
    return this.commit(next);
  }

  /**
   * 改运行配置（服务商/模型/effort）。运行中的会话也允许改：runtime 会在
   * 当前这一轮结束后关闭旧 query，下一轮用新配置和 resume 上下文重新开始。
   */
  updateRunConfig(
    id: string,
    patch: { providerId: string; providerName: string; model: string; effort: Effort },
  ): SessionCore {
    const current = this.require(id);
    const providerId = requireNonEmpty(patch.providerId, "服务商 ID 不能为空");
    const providerName = requireNonEmpty(patch.providerName, "服务商名称不能为空");
    const model = requireNonEmpty(patch.model, "模型不能为空");
    if (!isEffort(patch.effort)) throw new Error("无效的 effort");
    return this.commit({
      ...current,
      providerId,
      providerName,
      model,
      effort: patch.effort,
      updatedAt: new Date().toISOString(),
    });
  }

  create(input: CreateSessionInput): SessionCore {
    const now = new Date().toISOString();
    const first: TranscriptItem = {
      id: randomId(),
      role: "user",
      text: capMessageText(input.prompt),
      at: now,
    };
    if (input.images && input.images.length > 0) first.images = input.images;
    if (input.sdkUuid) first.sdkUuid = input.sdkUuid;
    const workflow = nextWorkflow(input.workflow, input.prompt, now);
    const session: SessionCore = {
      id: input.id,
      projectId: input.projectId,
      projectPath: input.projectPath,
      title: input.title,
      ...(input.titlePending ? { titlePending: true } : {}),
      providerId: input.providerId,
      providerName: input.providerName,
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      branch: input.branch,
      git: input.git,
      summary: summarizeInput(input.prompt, input.images),
      phase: "queued",
      turnActive: false,
      queued: true,
      subagents: [],
      ...(workflow ? { workflow } : {}),
      messages: [first],
      pending: null,
      seen: [],
      createdAt: now,
      updatedAt: now,
    };
    // 同 id 若曾存在（异常重建），旧用量缓存不能带进新会话。
    this.usageCache.delete(session.id);
    this.sessions.set(session.id, session);
    this.seenSets.set(session.id, new Set());
    // 新会话是关键状态：立即落盘，避免崩溃后留下无文件的 worktree/图片。
    this.markDirty(session.id);
    this.emit(session);
    return session;
  }

  addUserMessage(
    id: string,
    text: string,
    images: ImageRef[] = [],
    sdkUuid?: string,
    options: { queued?: boolean } = {},
  ): SessionCore {
    const current = this.require(id);
    const now = new Date().toISOString();
    const message: TranscriptItem = {
      id: randomId(),
      role: "user",
      text: capMessageText(text),
      at: now,
    };
    if (images.length > 0) message.images = images;
    if (sdkUuid) message.sdkUuid = sdkUuid;
    // 排队消息固定排在记录末尾；会立即执行的消息（插话）插到它们前面，
    // 不能接到队列后面，否则先发的那条排队消息反而排到了它后面。
    let messages: TranscriptItem[];
    if (options.queued) {
      message.queued = true;
      messages = [...current.messages, message];
    } else {
      let index = current.messages.length;
      while (index > 0 && isQueuedUser(current.messages[index - 1])) index -= 1;
      messages = index === current.messages.length
        ? [...current.messages, message]
        : [...current.messages.slice(0, index), message, ...current.messages.slice(index)];
    }
    // 工作流不在这里切换：消息可能还在排队。由 runtime 在 prompt 真正被 agent
    // 消费时调用 setWorkflow；同一条 query run 里则等上一轮 result 后再生效。
    return this.commit({
      ...current,
      messages: limitTranscript(messages),
      summary: summarizeInput(text, images),
      updatedAt: now,
    });
  }

  /**
   * agent 取走一条排队消息：清掉“排队中”标记，之后这一轮的新输出才会排到它
   * 后面。找不到（例如旧消息或已经清过）时什么都不做。
   */
  clearQueuedMessage(id: string, messageId: string): void {
    const current = this.sessions.get(id);
    if (!current) return;
    const index = current.messages.findIndex(
      (item) => item.id === messageId && item.queued === true,
    );
    if (index < 0) return;
    const messages = current.messages.slice();
    messages[index] = { ...messages[index]!, queued: undefined };
    this.commit({ ...current, messages });
  }

  /**
   * 停止会话后队列里的消息不会再执行：清掉所有“排队中”标记，避免后续输出
   * 一直插在它们前面。消息本身留在记录里（用户确实发过）。
   */
  clearQueuedMessages(id: string): void {
    const current = this.sessions.get(id);
    if (!current || !current.messages.some((item) => item.queued === true)) return;
    const messages = current.messages.map((item) =>
      item.queued === true ? { ...item, queued: undefined } : item);
    this.commit({ ...current, messages });
  }

  /**
   * 改写一条还没被 agent 取走的用户消息（排队消息编辑）。
   * 用 sdkUuid 定位；图片、时间等其它字段保持不变。找不到时静默忽略。
   */
  editUserMessage(id: string, sdkUuid: string, text: string): SessionCore {
    const current = this.require(id);
    const index = current.messages.findIndex((item) => item.role === "user" && item.sdkUuid === sdkUuid);
    if (index < 0) return current;
    const capped = capMessageText(text);
    const target = current.messages[index]!;
    if (target.text === capped) return current;
    const messages = current.messages.slice();
    messages[index] = { ...target, text: capped };
    // 列表摘要取自最后一条用户消息；改到最后一条时同步刷新，避免列表预览
    // 和详情页正文不一致。
    const isLastUser = !current.messages.slice(index + 1).some((item) => item.role === "user");
    return this.commit({
      ...current,
      messages,
      ...(isLastUser ? { summary: summarizeInput(capped, target.images) } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 删除一条还没被 agent 取走的用户消息（排队消息删除）。用 sdkUuid 定位，
   * 找不到时静默忽略。删的是最后一条用户消息时从剩余记录重算摘要，避免
   * 列表继续展示已经删掉的文案。
   */
  removeUserMessage(id: string, sdkUuid: string): SessionCore {
    const current = this.require(id);
    const index = current.messages.findIndex((item) => item.role === "user" && item.sdkUuid === sdkUuid);
    if (index < 0) return current;
    const messages = current.messages.filter((_, itemIndex) => itemIndex !== index);
    const removedLastUser = !current.messages.slice(index + 1).some((item) => item.role === "user");
    const lastUser = messages.filter((item) => item.role === "user").pop();
    return this.commit({
      ...current,
      messages,
      ...(removedLastUser
        ? { summary: lastUser ? summarizeInput(lastUser.text, lastUser.images) : "" }
        : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 提交回滚后的精确状态（调用方已完成 transcript 截断与 uuid 重映射）。
   *
   * 这条路径不走普通的轮次落定：排队/确认/运行中/工作流状态全部收敛，
   * 子 agent 和后台任务只保留回滚点之前开始的（cutAt 缺失时一个不留），
   * seen 去重历史保留，避免回滚后的重放被判重。phase 由 commit() 推导。
   */
  applyRewind(id: string, options: ApplyRewindInput): SessionCore {
    const current = this.require(id);
    // 回滚到最开始必须给出新的 SDK 会话 id：拿 session.id 顶替通常正好是旧
    // transcript 的 id，SDK 会把它当成已有会话续接，回滚等于没做。
    if (options.newSdkSession && !options.claudeSessionId) {
      throw new Error("回滚到最开始必须提供新的 SDK 会话 id");
    }
    const now = new Date().toISOString();
    const keepStarted = (startedAt: string | undefined): boolean =>
      startedBeforeCut(startedAt, options.cutAt);
    const subagents = current.subagents.filter((item) => keepStarted(item.startedAt));
    const backgroundTasks = (current.backgroundTasks ?? []).filter((item) => keepStarted(item.startedAt));
    const next: SessionCore = {
      ...current,
      pending: null,
      queued: false,
      turnActive: false,
      agentState: undefined,
      workflow: undefined,
      lastResult: "success",
      lastError: undefined,
      summary: options.summary ?? "已回滚，可以继续",
      // 回滚不是一次真实运行：旧起点/终点都作废，列表不再据此计算用时。
      runStartedAt: undefined,
      runEndedAt: undefined,
      updatedAt: now,
      messages: options.messages,
      subagents,
      backgroundTasks,
    };
    if (options.claudeSessionId) next.claudeSessionId = options.claudeSessionId;
    else delete next.claudeSessionId;
    if (options.newSdkSession) next.newSdkSession = true;
    else delete next.newSdkSession;
    const forked = [...(current.forkedSdkIds ?? [])];
    const appendForked = (sdkId: string | undefined): void => {
      if (sdkId && !forked.includes(sdkId)) forked.push(sdkId);
    };
    appendForked(options.forkedSdkId);
    // 旧 SDK 会话回滚后不再被引用。记进 forkedSdkIds 后，即使 HTTP 层立即删除
    // 旧 transcript 失败，后续 DELETE/归档/retention 仍能通过 sessionSdkIds 兜底清理。
    if (current.claudeSessionId && current.claudeSessionId !== options.claudeSessionId) {
      appendForked(current.claudeSessionId);
    }
    if (forked.length > 0) next.forkedSdkIds = forked;
    else if (current.forkedSdkIds) next.forkedSdkIds = current.forkedSdkIds;
    if (options.lastSdkUuid) next.lastSdkUuid = options.lastSdkUuid;
    else delete next.lastSdkUuid;
    // 回滚后没有配置入口的 setup 角色团队不该留着；已完成的保留展示。
    if (next.roleRun?.phase === "setup") delete next.roleRun;
    // 回滚后旧的延迟工作流选择不会再开始，直接丢弃。
    this.awaitingResult.delete(id);
    this.deferredWorkflows.delete(id);
    // 不让 commit 的运行时补丁把刚清掉的 runStartedAt/runEndedAt 又填回去。
    return this.commit(next, { skipRunTimeFixup: true });
  }

  /**
   * 新建一个由分叉产生的会话：保留到目标消息为止的前缀，父会话不变。
   *
   * 新会话不排队、本轮视为已完成，等用户继续发送；消息/指针由调用方从 SDK
   * fork 结果重映射后传入。像 create() 一样立即落盘并广播，清掉可能残留的
   * 用量缓存。
   */
  createBranch(input: CreateBranchInput): SessionCore {
    const now = new Date().toISOString();
    const session: SessionCore = {
      id: input.id,
      projectId: input.projectId,
      projectPath: input.projectPath,
      title: input.title,
      ...(input.titlePending ? { titlePending: true } : {}),
      providerId: input.providerId,
      providerName: input.providerName,
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      branch: input.branch,
      git: input.git,
      summary: input.summary,
      claudeSessionId: input.claudeSessionId,
      phase: "completed",
      turnActive: false,
      queued: false,
      lastResult: "success",
      subagents: [],
      backgroundTasks: [],
      messages: input.messages,
      pending: null,
      seen: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.lastSdkUuid) session.lastSdkUuid = input.lastSdkUuid;
    this.usageCache.delete(session.id);
    this.sessions.set(session.id, session);
    this.seenSets.set(session.id, new Set());
    this.markDirty(session.id);
    this.emit(session);
    return session;
  }

  /**
   * 让 discuss 会话进入「等待配置参与模型」状态。
   *
   * 新建会话或用户在讨论模式下又发了一条消息时调用；不会启动模型调用。
   * 参与模型列表保留上一次的配置，用户可以直接再次开始讨论。
   */
  prepareDiscussion(
    id: string,
    participants?: DiscussionParticipant[],
    skill: WorkflowSkill = "discuss",
  ): SessionCore {
    const current = this.require(id);
    const now = new Date().toISOString();
    const list = participants ?? current.discussion?.participants ?? [];
    const next: SessionCore = {
      ...current,
      turnActive: false,
      queued: false,
      pending: null,
      runStartedAt: undefined,
      runEndedAt: undefined,
      workflow: { skill, startedAt: now },
      discussion: {
        phase: "setup",
        participants: list,
        round: 0,
        strategy: discussionStrategy(skill),
        startedAt: now,
      },
      updatedAt: now,
    };
    // 切换到讨论模式时清掉角色团队状态，避免两个配置面板同时出现。
    delete next.roleRun;
    return this.commit(next);
  }

  /** 真正开始一场讨论：占用一轮运行状态，记录参与者并清空上一场的结论。 */
  beginDiscussion(
    id: string,
    participants: DiscussionParticipant[],
    skill: WorkflowSkill = "discuss",
  ): SessionCore {
    const current = this.require(id);
    const now = new Date().toISOString();
    return this.commit({
      ...current,
      turnActive: true,
      queued: false,
      pending: null,
      lastResult: undefined,
      lastError: undefined,
      runStartedAt: now,
      runEndedAt: undefined,
      workflow: { skill, startedAt: now },
      discussion: {
        phase: "running",
        participants,
        round: 0,
        strategy: discussionStrategy(skill),
        startedAt: now,
      },
      updatedAt: now,
    });
  }

  /** 拆分完成后登记子任务；之后每次发言只更新对应子任务的进度。 */
  setDiscussionSubtasks(id: string, titles: string[]): void {
    const current = this.sessions.get(id);
    if (!current?.discussion || current.discussion.phase !== "running") return;
    const subtasks: DiscussionSubtaskState[] = titles.map((title, index) => ({
      index: index + 1,
      title,
      phase: "running",
      round: 1,
    }));
    this.commit({
      ...current,
      discussion: { ...current.discussion, strategy: "parallel", subtasks },
      updatedAt: new Date().toISOString(),
    });
  }

  /** 落定一个子任务；讨论整体已经结束时忽略。 */
  settleDiscussionSubtask(
    id: string,
    index: number,
    patch: { phase: DiscussionSubtaskState["phase"]; agreed?: boolean; error?: string },
  ): void {
    const current = this.sessions.get(id);
    if (!current?.discussion || current.discussion.phase !== "running") return;
    if (!current.discussion.subtasks) return;
    const subtasks = current.discussion.subtasks.map((item) => {
      if (item.index !== index) return item;
      const next: DiscussionSubtaskState = { ...item, phase: patch.phase };
      delete next.activeIndex;
      delete next.activeKind;
      if (patch.agreed !== undefined) next.agreed = patch.agreed;
      if (patch.error) next.error = patch.error;
      return next;
    });
    this.commit({
      ...current,
      discussion: { ...current.discussion, subtasks },
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 更新「第几轮 / 谁正在发言」；讨论已经落定时忽略。
   * 传入 subtask 时只更新那个子任务的进度，并行时不会互相覆盖。
   */
  setDiscussionProgress(
    id: string,
    patch: {
      round: number;
      activeIndex?: number;
      activeKind?: DiscussionKind;
      subtask?: number;
      integrating?: boolean;
    },
  ): void {
    const current = this.sessions.get(id);
    if (!current?.discussion || current.discussion.phase !== "running") return;
    const discussion: DiscussionState = { ...current.discussion };
    if (patch.integrating === true) discussion.integrating = true;
    else if (patch.integrating === false) delete discussion.integrating;
    if (patch.subtask !== undefined) {
      if (!discussion.subtasks) return;
      const position = discussion.subtasks.findIndex((item) => item.index === patch.subtask);
      if (position < 0) return;
      const subtask: DiscussionSubtaskState = { ...discussion.subtasks[position]!, round: patch.round };
      if (patch.activeIndex === undefined) delete subtask.activeIndex;
      else subtask.activeIndex = patch.activeIndex;
      if (patch.activeKind === undefined) delete subtask.activeKind;
      else subtask.activeKind = patch.activeKind;
      const subtasks = discussion.subtasks.slice();
      subtasks[position] = subtask;
      discussion.subtasks = subtasks;
    } else {
      discussion.round = patch.round;
      if (patch.activeIndex === undefined) delete discussion.activeIndex;
      else discussion.activeIndex = patch.activeIndex;
      if (patch.activeKind === undefined) delete discussion.activeKind;
      else discussion.activeKind = patch.activeKind;
    }
    this.commit({ ...current, discussion, updatedAt: new Date().toISOString() });
  }

  /** 追加一条讨论发言；role 固定为 assistant，前端靠 speaker/discussion 标注身份。 */
  appendDiscussionMessage(
    id: string,
    input: {
      speaker: string;
      text: string;
      round: number;
      kind: DiscussionKind;
      subtask?: { index: number; title: string };
      integration?: boolean;
    },
  ): SessionCore {
    const current = this.require(id);
    const now = new Date().toISOString();
    const item: TranscriptItem = {
      id: randomId(),
      role: "assistant",
      text: capMessageText(input.text),
      at: now,
      speaker: input.speaker,
      discussion: {
        round: input.round,
        kind: input.kind,
        ...(input.subtask ? { subtask: input.subtask } : {}),
        ...(input.integration ? { integration: true } : {}),
      },
    };
    return this.commit({
      ...current,
      messages: limitTranscript([...current.messages, item]),
      updatedAt: now,
    });
  }

  /**
   * 结束一场讨论：写回成功/失败/停止、是否一致以及结论时间。
   * 幂等：讨论已经不在 running 时直接返回，不会覆盖用户停止时写入的状态。
   */
  settleDiscussion(
    id: string,
    input: { result: "success" | "error" | "stopped"; error?: string; agreed?: boolean },
  ): SessionCore | undefined {
    const current = this.sessions.get(id);
    if (!current?.discussion || current.discussion.phase !== "running") return current;
    const now = new Date().toISOString();
    const phase: DiscussionState["phase"] = input.result === "success"
      ? "completed"
      : input.result === "stopped" ? "stopped" : "failed";
    const discussion: DiscussionState = { ...current.discussion, phase, endedAt: now };
    delete discussion.activeIndex;
    delete discussion.activeKind;
    delete discussion.integrating;
    if (discussion.subtasks) {
      // 停止或失败时，还没结束的子任务也要一起落定，前端不会一直显示讨论中。
      discussion.subtasks = discussion.subtasks.map((item) => {
        if (item.phase !== "running") return item;
        const next: DiscussionSubtaskState = {
          ...item,
          phase: input.result === "success" ? "completed" : "stopped",
        };
        delete next.activeIndex;
        delete next.activeKind;
        if (input.result !== "success" && input.error) next.error = input.error;
        return next;
      });
    }
    if (input.agreed !== undefined) discussion.agreed = input.agreed;
    if (input.error) discussion.error = input.error;
    const workflow = current.workflow && !current.workflow.endedAt
      ? { ...current.workflow, endedAt: now }
      : current.workflow;
    return this.commit({
      ...current,
      turnActive: false,
      queued: false,
      pending: null,
      ...(workflow ? { workflow } : {}),
      discussion,
      lastResult: input.result,
      ...(input.result === "success"
        ? { lastError: undefined }
        : { lastError: input.error ?? (input.result === "stopped" ? "讨论已停止" : "讨论失败") }),
      updatedAt: now,
    });
  }

  /**
   * 让 prl-role 会话进入「等待配置四角色团队」状态。
   *
   * 新建会话或用户在角色模式下又发了一条消息时调用；不会启动模型调用。
   * 团队配置保留上一次的选择（或者调用方显式传入的），用户可以直接开始。
   */
  prepareRoleRun(id: string, team?: RoleTeam): SessionCore {
    const current = this.require(id);
    const now = new Date().toISOString();
    const resolved = team ?? current.roleRun?.team;
    const next: SessionCore = {
      ...current,
      turnActive: false,
      queued: false,
      pending: null,
      runStartedAt: undefined,
      runEndedAt: undefined,
      lastResult: undefined,
      lastError: undefined,
      workflow: { skill: "prl-role", startedAt: now },
      roleRun: {
        phase: "setup",
        ...(resolved ? { team: resolved } : {}),
        units: [],
        round: 0,
        maxRounds: MAX_ROLE_ROUNDS,
        startedAt: now,
      },
      updatedAt: now,
    };
    // 切换到角色团队模式时清掉讨论状态，避免两个配置面板同时出现。
    delete next.discussion;
    return this.commit(next);
  }

  /** 真正开始角色团队：占用一轮运行状态，记录团队配置并清空上一场的结果。 */
  beginRoleRun(id: string, team: RoleTeam, maxRounds: number): SessionCore {
    const current = this.require(id);
    const now = new Date().toISOString();
    return this.commit({
      ...current,
      turnActive: true,
      queued: false,
      pending: null,
      lastResult: undefined,
      lastError: undefined,
      runStartedAt: now,
      runEndedAt: undefined,
      workflow: { skill: "prl-role", startedAt: now },
      roleRun: {
        phase: "running",
        team,
        units: [],
        round: 1,
        maxRounds,
        startedAt: now,
      },
      updatedAt: now,
    });
  }

  /** 编排完成后登记工作单元；运行已经结束时忽略。 */
  setRoleUnits(id: string, titles: string[]): void {
    const current = this.sessions.get(id);
    if (!current?.roleRun || current.roleRun.phase !== "running") return;
    const units: RoleUnitState[] = titles.map((title, index) => ({
      index: index + 1,
      title,
      phase: "pending",
      round: 0,
    }));
    this.commit({
      ...current,
      roleRun: { ...current.roleRun, units },
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 更新「第几轮 / 谁在调用 / 正在处理哪个单元」；运行已经落定时忽略。
   * clearActive 用于阶段之间清空正在调用的角色和工具。
   */
  setRoleRunProgress(
    id: string,
    patch: {
      round?: number;
      activeRole?: RoleKind;
      activeUnit?: number;
      activeTool?: string;
      integrating?: boolean;
      clearActive?: boolean;
    },
  ): void {
    const current = this.sessions.get(id);
    if (!current?.roleRun || current.roleRun.phase !== "running") return;
    const roleRun: RoleRunState = { ...current.roleRun };
    if (patch.clearActive) {
      delete roleRun.activeRole;
      delete roleRun.activeUnit;
      delete roleRun.activeTool;
    }
    if (patch.round !== undefined) roleRun.round = patch.round;
    if (patch.activeRole !== undefined) roleRun.activeRole = patch.activeRole;
    if (patch.activeUnit !== undefined) roleRun.activeUnit = patch.activeUnit;
    if (patch.activeTool !== undefined) roleRun.activeTool = patch.activeTool;
    if (patch.integrating === true) roleRun.integrating = true;
    else if (patch.integrating === false) delete roleRun.integrating;
    this.commit({ ...current, roleRun, updatedAt: new Date().toISOString() });
  }

  /** 落定一个工作单元；运行已经结束时忽略。 */
  settleRoleUnit(
    id: string,
    index: number,
    patch: {
      phase: RoleUnitPhase;
      round?: number;
      verdict?: RoleUnitState["verdict"];
      issues?: string;
      executorSummary?: string;
    },
  ): void {
    const current = this.sessions.get(id);
    if (!current?.roleRun || current.roleRun.phase !== "running") return;
    const units = current.roleRun.units.map((item) => {
      if (item.index !== index) return item;
      const next: RoleUnitState = { ...item, phase: patch.phase };
      if (patch.round !== undefined) next.round = patch.round;
      if (patch.verdict !== undefined) next.verdict = patch.verdict;
      if (patch.issues !== undefined) next.issues = patch.issues;
      if (patch.executorSummary !== undefined) next.executorSummary = patch.executorSummary;
      return next;
    });
    this.commit({
      ...current,
      roleRun: { ...current.roleRun, units },
      updatedAt: new Date().toISOString(),
    });
  }

  /** 追加一条角色发言；role 固定为 assistant，前端靠 speaker/roleRun 标注身份。 */
  appendRoleMessage(
    id: string,
    input: {
      speaker: string;
      text: string;
      role: RoleKind;
      round: number;
      unit?: { index: number; title: string };
      integrating?: boolean;
      usage?: TokenUsage;
      providerId?: string;
      providerName?: string;
      model?: string;
    },
  ): SessionCore {
    const current = this.require(id);
    const now = new Date().toISOString();
    const item: TranscriptItem = {
      id: randomId(),
      role: "assistant",
      text: capMessageText(input.text),
      at: now,
      speaker: input.speaker,
      ...(input.usage ? { usage: input.usage } : {}),
      roleRun: {
        kind: input.role,
        round: input.round,
        ...(input.unit ? { unit: input.unit } : {}),
        ...(input.integrating ? { integrating: true } : {}),
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.providerName ? { providerName: input.providerName } : {}),
        ...(input.model ? { model: input.model } : {}),
      },
    };
    return this.commit({
      ...current,
      messages: limitTranscript([...current.messages, item]),
      updatedAt: now,
    });
  }

  /**
   * 结束角色团队运行：写回成功/失败/停止、集成审核结论以及结束时间。
   * 幂等：已经不在 running 时直接返回，不会覆盖用户停止时写入的状态。
   */
  settleRoleRun(
    id: string,
    input: { result: "success" | "error" | "stopped"; error?: string; agreed?: boolean },
  ): SessionCore | undefined {
    const current = this.sessions.get(id);
    if (!current?.roleRun || current.roleRun.phase !== "running") return current;
    const now = new Date().toISOString();
    const phase: RoleRunPhase = input.result === "success"
      ? "completed"
      : input.result === "stopped" ? "stopped" : "failed";
    const roleRun: RoleRunState = { ...current.roleRun, phase, endedAt: now };
    delete roleRun.activeRole;
    delete roleRun.activeUnit;
    delete roleRun.activeTool;
    delete roleRun.integrating;
    // 停止或失败时，还没结束的单元也要一起落定，前端不会一直显示运行中。
    roleRun.units = roleRun.units.map((item) => (
      item.phase === "running" ? { ...item, phase: "stopped" as const } : item
    ));
    if (input.agreed !== undefined) roleRun.agreed = input.agreed;
    if (input.error) roleRun.error = input.error;
    const workflow = current.workflow && !current.workflow.endedAt
      ? { ...current.workflow, endedAt: now }
      : current.workflow;
    const lastReply = [...current.messages].reverse()
      .find((item) => item.role === "assistant" && item.text.trim());
    const failureSummary = input.error ?? (input.result === "stopped" ? "角色团队已停止" : "角色团队运行失败");
    const summary = input.result === "success"
      ? (lastReply ? clip(lastReply.text, 160) : (input.agreed === false ? "运行完成 · 集成审核未通过" : "角色团队运行完成"))
      : failureSummary;
    return this.commit({
      ...current,
      turnActive: false,
      queued: false,
      pending: null,
      ...(workflow ? { workflow } : {}),
      roleRun,
      summary,
      lastResult: input.result,
      ...(input.result === "success"
        ? { lastError: undefined }
        : { lastError: failureSummary }),
      updatedAt: now,
    });
  }

  /**
   * 空闲会话里让本次发送的工作流立即对 UI 生效（POST 响应和 SSE 都会带上），
   * 不必等 agent 消费 prompt。忙时保持当前轮不变，交给 runtime 的 deferred 逻辑。
   */
  previewWorkflow(id: string, skill?: WorkflowSkill, text = ""): void {
    const current = this.sessions.get(id);
    if (!current) return;
    const idle = !current.turnActive
      && !isAgentActive(current.agentState)
      && !current.queued
      && !current.pending
      && !current.subagents.some((item) => item.status === "running");
    if (!idle) return;
    const resolved = skill ?? detectWorkflowSkill(text) ?? undefined;
    // 角色团队停在 setup 时 workflow 没有 endedAt，但用户改发普通消息要能清掉它，
    // 否则会一直被当成「还在跑」而提前返回。
    const abandonedRoleSetup = current.roleRun?.phase === "setup";
    // 没有新工作流时，只清掉已经落定的旧工作流；还在跑就保留。
    if (!resolved && !abandonedRoleSetup && current.workflow && !current.workflow.endedAt) return;

    const now = new Date().toISOString();
    const next: SessionCore = {
      ...current,
      // 只是给 UI 的提前反馈：消息还没被 agent 消费，先显示为排队，
      // 等 runtime 真正开始这一轮时再走 beginTurn/setWorkflow。
      queued: true,
      updatedAt: now,
    };
    if (resolved) next.workflow = { skill: resolved, startedAt: now };
    else delete next.workflow;
    // 角色团队还停在配置阶段时用户改发别的工作流：清掉永不开始的 roleRun，
    // 否则 derivePhase 会一直显示 setup。已完成的 roleRun 保留展示。
    if (resolved !== "prl-role" && next.roleRun?.phase === "setup") delete next.roleRun;
    next.phase = derivePhase(next);
    this.commit(next);
  }

  /**
   * 一条 prompt 真正被 agent 消费时切换当前轮的工作流。
   *
   * SDK 的 streaming input 可能在上一轮还没 result 时就把下一条 prompt 拉走；
   * 这时只把选择排队，等 apply() 处理完 result 后再切换，避免覆盖当前轮、
   * 也避免把新工作流误标成已结束。
   */
  setWorkflow(id: string, skill?: WorkflowSkill): void {
    if (!this.sessions.has(id)) return;
    if (this.awaitingResult.has(id)) {
      const list = this.deferredWorkflows.get(id) ?? [];
      list.push(skill);
      this.deferredWorkflows.set(id, list);
      return;
    }
    this.applyWorkflow(id, skill);
  }

  /**
   * 真正开始新一轮：复位 turn 状态并写入工作流（缺省表示普通对话）。
   * reopen 为 false 时只切换工作流选择，不动本轮状态（见 settleWorkflow）。
   */
  private applyWorkflow(id: string, skill?: WorkflowSkill, reopen = true): void {
    const current = this.sessions.get(id);
    if (!current) return;
    const now = new Date().toISOString();
    const next: SessionCore = reopen
      ? {
        ...current,
        turnActive: true,
        queued: false,
        lastResult: undefined,
        lastError: undefined,
        updatedAt: now,
      }
      : { ...current, updatedAt: now };
    // 还没落定的工作流不能被一条新 prompt 清掉或重启：子任务带着这一轮的
    // workflow.startedAt，清掉会让进度条消失、还在跑的子任务从视图里掉出去，
    // 换 startedAt 也会让已经跑出的进度归零。用户中途插话（不选工作流，
    // 或者沿用下拉里仍选着的 prl/ser/plan）时都会走到这里。
    // 只有显式换成别的工作流，或者当前工作流已经落定，才开新的一段。
    const running = current.workflow && !current.workflow.endedAt ? current.workflow : undefined;
    if (skill) {
      next.workflow = running?.skill === skill ? running : { skill, startedAt: now };
    } else if (running) {
      next.workflow = running;
    } else {
      delete next.workflow;
    }
    // 同 previewWorkflow：用户改走别的工作流时，丢弃停在 setup 的角色团队。
    // 这种 prl-role workflow 也从没真正开始过（没有 endedAt），一并清掉，
    // 否则前端发送区会一直停在 prl-role；已完成的 workflow 保留原有处理。
    if (skill !== "prl-role" && next.roleRun?.phase === "setup") {
      delete next.roleRun;
      if (skill === undefined && next.workflow?.skill === "prl-role" && !next.workflow.endedAt) {
        delete next.workflow;
      }
    }
    if (reopen) this.awaitingResult.add(id);
    this.commit(next);
  }

  /**
   * 本轮 result 已落定：把下一条已消费 prompt 的工作流补上。
   *
   * 这条 prompt 只是被 streaming input 提前拉走，并不一定会再开一轮：用户
   * 趁 agent 干活时补的一句话会被折进刚结束的这一轮，之后没有新的 result。
   * 所以这里只切工作流，不能复位 turnActive/lastResult，否则这一轮明明已经
   * 落定，会话却会一直停在运行中。
   */
  private settleWorkflow(id: string): void {
    this.awaitingResult.delete(id);
    const list = this.deferredWorkflows.get(id);
    if (!list || list.length === 0) return;
    const skill = list.shift();
    if (list.length === 0) this.deferredWorkflows.delete(id);
    if (!this.sessions.has(id)) return;
    this.applyWorkflow(id, skill, false);
  }

  /**
   * 真正新起一次 run 时清理上一轮残留的延迟工作流选择。
   * 注意不要放进 beginTurn：submit 在轮次进行中也会调用 beginTurn，
   * 那时 awaitingResult/deferred 正是“提前拉走”的保护状态，不能清。
   */
  resetDeferredWorkflows(id: string): void {
    this.awaitingResult.delete(id);
    this.deferredWorkflows.delete(id);
  }

  beginTurn(id: string): void {
    const current = this.require(id);
    const now = new Date().toISOString();
    // 运行中追加消息也会调用 beginTurn：本轮起点保持第一次的时间，不能每次追加都重置。
    const continuing = current.turnActive && current.runStartedAt !== undefined;
    this.commit({
      ...current,
      turnActive: true,
      queued: false,
      pending: null,
      lastError: undefined,
      runStartedAt: continuing ? current.runStartedAt : now,
      runEndedAt: continuing ? current.runEndedAt : undefined,
      updatedAt: now,
    });
  }

  markQueued(id: string): void {
    const current = this.require(id);
    if (current.turnActive) return;
    this.commit({
      ...current,
      queued: true,
      updatedAt: new Date().toISOString(),
    });
  }

  /** 排队消息被全部撤回后清掉排队状态；正在跑的轮次不处理。 */
  cancelQueued(id: string): void {
    const current = this.sessions.get(id);
    if (!current || current.turnActive) return;
    const next: SessionCore = {
      ...current,
      queued: false,
      updatedAt: new Date().toISOString(),
    };
    // 还没跑过任何一轮的会话被撤回后应显示“已停止”，而不是继续排队。
    if (next.lastResult === undefined) {
      next.lastResult = "stopped";
      next.lastError = "已停止";
    }
    // 撤回的是还没执行的排队消息：它挂上的工作流不会再开始，补结束时间。
    if (next.workflow && !next.workflow.endedAt) {
      next.workflow = { ...next.workflow, endedAt: next.updatedAt };
    }
    next.phase = derivePhase(next);
    this.commit(next);
  }

  /**
   * 应用一条 SDK 消息；返回是否真的生效（uuid 去重命中时返回 false）。
   * 调用方（runtime）据此判断 result 是不是重复投递的，避免重复放行排队消息。
   * runModel 是这一轮启动时绑定的模型，写进本轮 assistant 回答，供前端按轮展示；
   * 中途切换模型只影响下一轮，不能在这里读当前会话配置。
   */
  apply(id: string, message: SdkMessage, runModel?: string): boolean {
    const current = this.require(id);
    const next = applySdkMessage(current, message, this.seenSet(id), runModel);
    // 去重命中（next === current）时这条消息没有生效，不能再计一次速度。
    if (next !== current) this.noteOutputTokens(id, message);
    this.commit(next);
    // result 落定旧工作流的 endedAt 之后，再切到排队中的下一轮工作流。
    // 只有消息确实被应用（uuid 去重未命中）才推进 deferred，避免重放 result
    // 凭空切走一个选择。
    if (next !== current && message.type === "result") this.settleWorkflow(id);
    return next !== current;
  }

  /**
   * 顶栏的实时速度：主 agent 的流式增量（正文、思考、工具输入）按字符估算后
   * 记入当前会话的速度计。
   *
   * 子 agent 的输出不经过流式增量：SDK 只把它的正文/思考/工具输入作为完整
   * 消息下发（开启 forwardSubagentText 后连正文和思考一起转发）。等整块到达
   * 再按它生成的时间区间均摊，否则速度会在到达瞬间冲出几十倍。子 agent 的
   * 完整消息不进本地 transcript，但同样消耗输出 token，所以这里不看
   * parent_tool_use_id。若将来 CLI 也开始下发子 agent 增量，则以增量为准，
   * 不再重复统计完整消息。
   */
  private noteOutputTokens(id: string, message: SdkMessage): void {
    if (message.type === "stream_event") {
      const event = message.event;
      if (!event || event.type !== "content_block_delta" || !event.delta) return;
      const delta = event.delta;
      const text = delta.type === "text_delta"
        ? delta.text
        : delta.type === "thinking_delta"
          ? delta.thinking
          : delta.type === "input_json_delta"
            ? delta.partial_json
            : undefined;
      if (!text) return;
      this.meter(id).note(text);
      if (message.parent_tool_use_id || message.agent_id) this.subagentStreams.add(id);
      return;
    }
    if (message.type !== "assistant") return;
    // 主线程的完整消息与流式增量内容重复，只统计子 agent 的。
    const taskId = message.agent_id || message.parent_tool_use_id;
    if (!taskId || this.subagentStreams.has(id)) return;
    const text = assistantOutputText(message);
    if (!text) return;
    const now = Date.now();
    const runStartedAt = Date.parse(
      this.sessions.get(id)?.subagents.find((item) => item.taskId === taskId)?.runStartedAt ?? "",
    );
    let from = Number.isFinite(runStartedAt) ? runStartedAt : now;
    const last = this.subagentOutputAt.get(id)?.get(taskId);
    // 续跑时 runStartedAt 会重置，取两者中较晚的起点，避免把新一块摊到上一轮。
    if (typeof last === "number" && last > from) from = last;
    if (!(from <= now)) from = now;
    this.meter(id).noteSpan(text, from, now);
    let outputAt = this.subagentOutputAt.get(id);
    if (!outputAt) {
      outputAt = new Map();
      this.subagentOutputAt.set(id, outputAt);
    }
    outputAt.set(taskId, now);
  }

  private meter(id: string): TokenRateMeter {
    let meter = this.tokenRates.get(id);
    if (!meter) {
      meter = new TokenRateMeter();
      this.tokenRates.set(id, meter);
    }
    return meter;
  }

  private seenSet(id: string): Set<string> {
    let set = this.seenSets.get(id);
    if (!set) {
      set = new Set(this.sessions.get(id)?.seen ?? []);
      this.seenSets.set(id, set);
    }
    return set;
  }

  setPending(id: string, pending: PendingRequest): void {
    const current = this.require(id);
    this.commit({ ...current, pending, updatedAt: new Date().toISOString() });
  }

  clearPending(id: string): void {
    const current = this.sessions.get(id);
    if (!current?.pending) return;
    this.commit({ ...current, pending: null, updatedAt: new Date().toISOString() });
  }

  /**
   * query 进程结束时收敛后台 shell 任务：进程已经没了，仍在 running 的任务不可能继续。
   * 幂等：没有 running 任务时不 commit、不改 updatedAt；已有 endedAt/summary 保留。
   */
  stopBackgroundTasks(id: string, summary: string): void {
    const current = this.sessions.get(id);
    if (!current?.backgroundTasks?.length) return;
    const now = new Date().toISOString();
    let changed = false;
    const backgroundTasks = current.backgroundTasks.map((item) => {
      if (item.status !== "running") return item;
      changed = true;
      return {
        ...item,
        status: "stopped" as const,
        endedAt: item.endedAt ?? now,
        summary: item.summary || summary,
      };
    });
    if (!changed) return;
    this.commit({ ...current, backgroundTasks, updatedAt: now });
  }

  fail(id: string, reason: string): void {
    this.settle(id, reason, "error");
  }

  stop(id: string, reason: string): void {
    this.settle(id, reason, "stopped");
  }

  /**
   * 结束当前轮：真实错误写 error，用户主动停止写 stopped。
   * 两者都清空排队/确认状态、落定流式片段，并把仍在跑的子 agent 标成 stopped。
   */
  private settle(id: string, reason: string, result: "error" | "stopped"): void {
    const current = this.sessions.get(id);
    if (!current) return;
    // 只有当前轮已落定且没有待清理的排队/确认状态时才幂等返回；
    // 否则会吞掉停止后又被重新排队的会话，让它永久停在 queued。
    if (
      current.lastResult === result
      && current.lastError === reason
      && !current.turnActive
      && !current.queued
      && !current.pending
      && !isAgentActive(current.agentState)
      && !(current.workflow && !current.workflow.endedAt)
    ) return;
    const now = new Date().toISOString();
    // 本轮落定：工作流还在跑就补上结束时间。
    const workflow = current.workflow && !current.workflow.endedAt
      ? { ...current.workflow, endedAt: now }
      : current.workflow;
    // 讨论被停止/失败时，讨论状态也要一起落定，否则前端会一直显示讨论中。
    let discussion = current.discussion;
    if (discussion?.phase === "running") {
      discussion = {
        ...discussion,
        phase: result === "stopped" ? "stopped" : "failed",
        endedAt: now,
        error: reason,
      };
      delete discussion.activeIndex;
      delete discussion.activeKind;
      delete discussion.integrating;
      if (discussion.subtasks) {
        discussion.subtasks = discussion.subtasks.map((item) => {
          if (item.phase !== "running") return item;
          const next: DiscussionSubtaskState = { ...item, phase: "stopped" };
          delete next.activeIndex;
          delete next.activeKind;
          if (reason) next.error = reason;
          return next;
        });
      }
    }
    // 角色团队被停止/失败中断时，同样收成停止/失败，避免前端一直显示运行中。
    let roleRun = current.roleRun;
    if (roleRun?.phase === "running") {
      roleRun = {
        ...roleRun,
        phase: result === "stopped" ? "stopped" : "failed",
        endedAt: now,
        error: reason,
      };
      delete roleRun.activeRole;
      delete roleRun.activeUnit;
      delete roleRun.activeTool;
      delete roleRun.integrating;
      roleRun.units = roleRun.units.map((item) => (
        item.phase === "running" ? { ...item, phase: "stopped" as const } : item
      ));
    }
    // 被停止/失败中断的已消费 prompt 不会再开始，丢弃它们的工作流选择。
    this.awaitingResult.delete(id);
    this.deferredWorkflows.delete(id);
    const subagents = current.subagents.map((item) =>
      item.status === "running" ? { ...item, status: "stopped" as const, summary: item.summary } : item,
    );
    // 本轮被停止/失败：还在跑的后台 shell 任务也不会再有收尾帧，一并收敛成已停止，
    // 已有的摘要保留（失败原因等），并补结束时间避免前端用时继续累加。
    const backgroundTasks = current.backgroundTasks?.map((item) =>
      item.status === "running"
        ? { ...item, status: "stopped" as const, endedAt: item.endedAt ?? now, summary: item.summary }
        : item,
    );
    // 失败/停止时落定未完成的流式片段，避免下一轮把它们当成自己的片段继续累积。
    const messages = current.messages.some((item) => item.partial || item.streaming)
      ? current.messages.map((item) =>
        item.partial || item.streaming
          ? { ...item, partial: undefined, streaming: undefined }
          : item)
      : current.messages;
    this.commit({
      ...current,
      turnActive: false,
      // SDK 状态是进程级的，这一轮已经人工落定，不能再让它把 phase 撑成运行中。
      agentState: undefined,
      queued: false,
      pending: null,
      subagents,
      ...(backgroundTasks ? { backgroundTasks } : {}),
      messages,
      ...(workflow ? { workflow } : {}),
      ...(discussion ? { discussion } : {}),
      ...(roleRun ? { roleRun } : {}),
      lastResult: result,
      lastError: reason,
      summary: reason,
      updatedAt: now,
    });
  }

  remove(id: string): SessionCore | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.sessions.delete(id);
    this.pending.delete(id);
    this.usageCache.delete(id);
    this.tokenRates.delete(id);
    this.subagentOutputAt.delete(id);
    this.subagentStreams.delete(id);
    this.failures.delete(id);
    const emitTimer = this.emitTimers.get(id);
    if (emitTimer) clearTimeout(emitTimer);
    this.emitTimers.delete(id);
    this.lastEmitAt.delete(id);
    this.turnEnds.delete(id);
    this.dirty.delete(id);
    this.seenSets.delete(id);
    this.awaitingResult.delete(id);
    this.deferredWorkflows.delete(id);
    const file = path.join(this.dir(), `${id}.json`);
    // 删除后 sessions 里已没有该 id，在途写会在 rename 后自检并清掉文件。
    if (fs.existsSync(file)) fs.rmSync(file);
    removeSessionImages(this.dataDir, id);
    this.emitRemoved(id);
    return session;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 立即清空防抖计时器并等待所有在途/待写快照落盘。
   * 供 runtime 优雅退出时调用；返回后磁盘上已是当前内存中的最新状态
   *（调用之后新产生的变更不在本次契约内）。
   */
  async flush(): Promise<void> {
    for (const id of this.pending.keys()) this.dirty.add(id);
    this.pending.clear();
    if (this.scheduler) {
      clearTimeout(this.scheduler);
      this.scheduler = undefined;
    }
    for (const id of [...this.dirty]) this.drain(id);
    await this.waitForWrites();
    // 落盘失败的会话做一次有界重试；仍失败则让调用方看到。
    if (this.failures.size > 0) {
      for (const id of this.failures.keys()) this.dirty.add(id);
      this.failures.clear();
      for (const id of [...this.dirty]) this.drain(id);
      await this.waitForWrites();
    }
    const first = this.failures.values().next().value as Error | undefined;
    if (first) throw first;
  }

  private async waitForWrites(): Promise<void> {
    if (this.writes.size === 0 && this.dirty.size === 0) return;
    await new Promise<void>((resolve) => this.flushWaiters.add(resolve));
  }

  private commit(
    session: SessionCore,
    options?: { skipRunTimeFixup?: boolean },
  ): SessionCore {
    const phase = derivePhase(session);
    let next: SessionCore = { ...session, phase };
    // 写时复制保证“消息集合变化”必然更换 messages 数组引用（纯标量变化可共享），
    // 因此用数组引用就能可靠地让用量缓存失效，不依赖毫秒级的 updatedAt。
    const previous = this.sessions.get(next.id);
    if (
      !previous
      || previous.messages !== next.messages
      || previous.providerId !== next.providerId
      || previous.providerName !== next.providerName
    ) {
      this.usageCache.delete(next.id);
    }
    // 本轮结束以 turnActive 落定为界；此后子 agent 收尾只改 phase，不会再加计数。
    if (previous?.turnActive && !next.turnActive) {
      this.turnEnds.set(next.id, (this.turnEnds.get(next.id) ?? 0) + 1);
    }
    // 运行时长按 phase 离开活跃集合来计算：主轮结束但子 agent 还在收尾时仍算运行中，
    // 等子 agent 全部落定才记录结束时间。回滚路径显式跳过：它不是一次真实运行。
    if (
      !options?.skipRunTimeFixup
      && previous
      && isActivePhase(previous.phase)
      && !isActivePhase(next.phase)
      && !next.runEndedAt
    ) {
      next = { ...next, runEndedAt: next.updatedAt };
    }
    // 已经落定的会话重新跑起来（后台子 agent 的通知唤醒主 agent、或用户续跑）：
    // 旧的结束时间作废，否则列表会一直显示“结束”。
    if (
      !options?.skipRunTimeFixup
      && previous
      && !isActivePhase(previous.phase)
      && isActivePhase(next.phase)
    ) {
      next = { ...next, runEndedAt: undefined, runStartedAt: next.runStartedAt ?? next.updatedAt };
    }
    this.sessions.set(next.id, next);
    this.persistSoon(next);
    this.emitSoon(next.id);
    return next;
  }

  private emitSoon(id: string): void {
    const now = Date.now();
    const last = this.lastEmitAt.get(id) ?? 0;
    const wait = 50 - (now - last);
    if (wait <= 0) {
      this.lastEmitAt.set(id, now);
      const latest = this.sessions.get(id);
      if (latest) this.emit(latest);
      return;
    }
    if (this.emitTimers.has(id)) return;
    this.emitTimers.set(id, setTimeout(() => {
      this.emitTimers.delete(id);
      this.lastEmitAt.set(id, Date.now());
      const latest = this.sessions.get(id);
      if (latest) this.emit(latest);
    }, wait));
  }

  /**
   * 记录会话有新状态待落盘。每个会话只更新自己的截止时间，不再新建/重置
   * 各自的定时器；整个 Store 只保留一个 arm 到最早截止时间的调度器。
   */
  private persistSoon(session: SessionCore): void {
    const id = session.id;
    const now = Date.now();
    const entry = this.pending.get(id);
    if (entry) entry.last = now;
    else this.pending.set(id, { first: now, last: now });
    // 已有调度器时，它的目标不会晚于本次新截止时间（各会话的截止时间只增不减），
    // 所以无需重新 arm。
    if (!this.scheduler) this.armScheduler();
  }

  /** 某个待落盘会话的截止时间：防抖与 maxWait 取更早者。 */
  private deadline(entry: { first: number; last: number }): number {
    return Math.min(entry.last + PERSIST_DEBOUNCE_MS, entry.first + PERSIST_MAX_WAIT_MS);
  }

  /** 只 arm 一个 setTimeout 到当前最早的截止时间。 */
  private armScheduler(): void {
    if (this.scheduler) return;
    let next = Number.POSITIVE_INFINITY;
    for (const entry of this.pending.values()) {
      const at = this.deadline(entry);
      if (at < next) next = at;
    }
    if (!Number.isFinite(next)) return;
    const wait = Math.max(0, next - Date.now());
    this.scheduler = setTimeout(() => {
      this.scheduler = undefined;
      const now = Date.now();
      for (const [id, entry] of [...this.pending]) {
        if (this.deadline(entry) > now) continue;
        this.pending.delete(id);
        this.markDirty(id);
      }
      // 处理掉这一批后，为剩下的会话重新 arm。
      this.armScheduler();
    }, wait);
    // 落盘调度不应阻止进程退出；flush() 会显式清理并等待写入。
    this.scheduler.unref?.();
  }

  /** 标记为待写并尝试立刻排空；已有在途写时留给它结束后继续。 */
  private markDirty(id: string): void {
    this.dirty.add(id);
    this.drain(id);
  }

  private drain(id: string): void {
    if (!this.dirty.has(id)) return;
    // 同一会话只允许一个在途写；期间的新快照合并到写完后的下一轮。
    if (this.writes.has(id)) return;
    this.dirty.delete(id);
    const session = this.sessions.get(id);
    if (!session) {
      this.settleFlush();
      return;
    }
    // 开始写入这一份快照后，清掉它对应的待落盘记录，避免重复写同一快照。
    this.pending.delete(id);
    const task = this.persistAsync(session)
      .then(() => {
        this.failures.delete(id);
      })
      .catch((error) => {
        // 记住失败，flush() 会重试并上报；内存中的会话不受影响。
        this.failures.set(id, error instanceof Error ? error : new Error(String(error)));
        console.error(`[store] 保存对话失败 ${id}:`, error);
      })
      .finally(() => {
        this.writes.delete(id);
        if (this.dirty.has(id)) this.drain(id);
        else this.settleFlush();
      });
    this.writes.set(id, task);
  }

  private async persistAsync(session: SessionCore): Promise<void> {
    // streaming 是运行时内部标记，不写进会话文件；旧版本读取路径也不需要它。
    const snapshot = session.messages.some((item) => item.streaming)
      ? {
        ...session,
        messages: session.messages.map((item) =>
          item.streaming ? { ...item, streaming: undefined } : item),
      }
      : session;
    // 先让出一次事件循环，避免大 transcript 的同步 JSON.stringify 卡住
    // 正在处理的流式事件。快照对象在上面已经确定（消息对象不可变替换），
    // 后续内存变更不会被串进这次写入。
    await new Promise<void>((resolve) => setImmediate(resolve));
    const data = JSON.stringify(snapshot);
    const dir = this.dir();
    const file = path.join(dir, `${session.id}.json`);
    const tmp = `${file}.${process.pid}.${++this.writeSeq}.tmp`;
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
      // 写期间会话可能已被删除：不要用 rename 把它“复活”。
      if (!this.sessions.has(session.id)) {
        await fs.promises.rm(tmp, { force: true });
        return;
      }
      await fs.promises.rename(tmp, file);
      // remove() 可能恰好发生在 rename 进行时，补一次清理。
      if (!this.sessions.has(session.id)) {
        await fs.promises.rm(file, { force: true });
      }
    } catch (error) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private settleFlush(): void {
    if (this.writes.size > 0 || this.dirty.size > 0) return;
    if (this.flushWaiters.size === 0) return;
    for (const resolve of this.flushWaiters) resolve();
    this.flushWaiters.clear();
  }

  private emit(session: SessionCore): void {
    // 事件只带 summary：大对话的 messages 全量复制很贵，订阅方需要时再 summary(id, true)。
    const summary: SessionEvent = {
      ...this.summaryOf(session, false),
      turnEnd: this.turnEnds.get(session.id) ?? 0,
      lastResult: session.lastResult,
    };
    for (const listener of this.listeners) listener(summary);
  }

  private emitRemoved(id: string): void {
    const tombstone: SessionEvent = {
      id,
      projectId: "",
      title: "",
      providerId: "",
      providerName: "",
      model: "",
      effort: "high",
      phase: "failed",
      summary: "",
      git: false,
      cwd: "",
      isolated: false,
      subagentDone: 0,
      subagentTotal: 0,
      subagents: [],
      backgroundTasks: [],
      mainAgentRunning: false,
      pending: null,
      createdAt: "",
      updatedAt: "",
      removed: true,
    };
    for (const listener of this.listeners) listener(tombstone);
  }
}

/**
 * 真正中断当前轮的停止会在同一毫秒把 runEndedAt 和 updatedAt 一起落定；
 * updatedAt 比 runEndedAt 晚这么久，说明停止时这一轮早已结束（停的是空闲进程）。
 */
const COMPLETED_STOP_GAP_MS = 1_000;

/**
 * 项目目录改名/搬移后，把由它派生的 cwd 一起挪到新位置。
 * git 会话的 cwd 是 dataDir 下的 worktree，不随项目路径变化；非 git 会话
 * 只有「cwd == 项目目录」和「cwd == <项目目录>/<会话 id>」两种派生方式，
 * 其余 cwd（用户自选目录或损坏数据）保持原样，避免改错。
 */
function remapProjectCwd(session: SessionCore, nextProjectPath: string): string {
  const { cwd } = session;
  if (session.git) return cwd;
  if (cwd === session.projectPath) return nextProjectPath;
  const relative = path.relative(session.projectPath, cwd);
  if (relative !== session.id) return cwd;
  return path.join(nextProjectPath, relative);
}

function recover(session: SessionCore): SessionCore {
  const normalized: SessionCore = {
    ...session,
    projectPath: session.projectPath || session.cwd,
    providerId: session.providerId || "",
    providerName: session.providerName || "",
    // 加载时也套用截断/条数上限，防止旧文件或异常数据无限占用内存。
    // 损坏的会话文件可能缺字段；单条防御而不是整份丢弃。
    messages: limitTranscript(
      (Array.isArray(session.messages) ? session.messages : [])
        .filter((item) => Boolean(item) && typeof item === "object")
        .map((item) => ({
          ...item,
          partial: undefined,
          streaming: undefined,
          // 排队标记只属于上一个进程的运行时队列；重启后这些消息不会再被执行，
          // 留着会让后续输出一直插到它们前面。
          queued: undefined,
          text: typeof item.text === "string" ? item.text : "",
        })),
    ),
    subagents: Array.isArray(session.subagents) ? session.subagents : [],
    // 旧数据没有 backgroundTasks；running 的任务在重启后不可能还在跑，启动时收成 stopped。
    backgroundTasks: recoverBackgroundTasks(session.backgroundTasks, session.updatedAt || session.createdAt),
    seen: (Array.isArray(session.seen) ? session.seen : []).slice(-2_000),
    // 旧数据可能缺 pinned 或存了非布尔值；统一收敛成布尔，toSummary 再兜底。
    pinned: session.pinned === true,
  };
  // 回滚/分叉字段可能来自旧版本或手改损坏数据：逐项归一化，避免 sessionSdkIds
  // 迭代到非数组/非字符串，让 DELETE/归档/retention 直接 500。
  const forkedSdkIds = normalizeForkedSdkIds(session.forkedSdkIds);
  if (forkedSdkIds.length > 0) normalized.forkedSdkIds = forkedSdkIds;
  else delete normalized.forkedSdkIds;
  if (typeof session.lastSdkUuid === "string" && session.lastSdkUuid) {
    normalized.lastSdkUuid = session.lastSdkUuid;
  } else {
    delete normalized.lastSdkUuid;
  }
  if (session.newSdkSession === true) normalized.newSdkSession = true;
  else delete normalized.newSdkSession;
  // workflow 来自磁盘，可能是旧版本或损坏数据；字段不合法就整段丢弃。
  const workflow = validWorkflow(session.workflow);
  if (workflow) normalized.workflow = workflow;
  else delete normalized.workflow;
  // 讨论状态来自磁盘：字段不合法就整段丢弃；上次进程里没跑完的讨论收成已停止。
  const discussion = recoverDiscussion(session.discussion, normalized.updatedAt || normalized.createdAt);
  if (discussion) normalized.discussion = discussion;
  else delete normalized.discussion;
  // prl-role 状态同理：字段不合法就整段丢弃；上次进程里没跑完的运行收成已停止。
  const roleRun = recoverRoleRun(session.roleRun, normalized.updatedAt || normalized.createdAt);
  if (roleRun) normalized.roleRun = roleRun;
  else delete normalized.roleRun;
  // SDK 状态只属于上一个进程；重启后不能拿旧值继续把会话撑成运行中。
  delete normalized.agentState;
  const active = isActivePhase(normalized.phase)
    || normalized.turnActive
    || normalized.queued
    || normalized.pending
    || normalized.subagents.some((item) => item.status === "running");
  // 磁盘上的工作流可能停在推进中，但这一轮其实已经结束（旧版本没有 endedAt）。
  if (normalized.workflow && !normalized.workflow.endedAt && !active) {
    normalized.workflow = { ...normalized.workflow, endedAt: normalized.updatedAt };
  }
  if (!active) {
    const settled: SessionCore = { ...normalized, pending: null, turnActive: false, queued: false };
    // 旧版本在服务重启/关闭空闲 query 时，会把已经“本轮完成”的会话改写成“已停止”。
    // runEndedAt 明显早于 updatedAt 说明停止发生时这一轮早已结束，恢复成完成，
    // 否则会一直显示“已停止”并提示继续。
    if (
      settled.lastResult === "stopped"
      && settled.runEndedAt
      && Date.parse(settled.updatedAt) - Date.parse(settled.runEndedAt) > COMPLETED_STOP_GAP_MS
    ) {
      const lastReply = [...settled.messages].reverse()
        .find((item) => item.role === "assistant" && item.text.trim());
      const lastAt = [...settled.messages].reverse()
        .find((item) => typeof item.at === "string" && Number.isFinite(Date.parse(item.at)))?.at;
      settled.lastResult = "success";
      settled.lastError = undefined;
      settled.summary = lastReply ? clip(lastReply.text, 160) : "本轮完成";
      // 结束时间和工作流结束时间也被那次停止提前写死了，用最后一条消息的时间补回。
      if (lastAt) {
        if (settled.workflow && (!settled.workflow.endedAt || Date.parse(settled.workflow.endedAt) < Date.parse(lastAt))) {
          settled.workflow = { ...settled.workflow, endedAt: lastAt };
        }
        if (!settled.runEndedAt || Date.parse(settled.runEndedAt) < Date.parse(lastAt)) {
          settled.runEndedAt = lastAt;
        }
      }
    }
    settled.phase = derivePhase(settled);
    return withRunEnded(settled);
  }
  const subagents = normalized.subagents.map((item) => item.status === "running"
    ? { ...item, status: "stopped" as const, summary: item.summary || "服务已重启" }
    : item);
  const next: SessionCore = {
    ...normalized,
    subagents,
    pending: null,
    turnActive: false,
    queued: false,
    lastResult: "error",
    lastError: "服务已重启，发送下一条消息可继续",
  };
  next.phase = derivePhase(next);
  if (next.workflow && !next.workflow.endedAt) {
    next.workflow = { ...next.workflow, endedAt: new Date().toISOString() };
  }
  return withRunEnded(next);
}

/**
 * 归一化磁盘上的 forkedSdkIds：只接受非空字符串并去重。
 * 非数组（损坏/手改数据）整体置空，避免消费方直接迭代时抛错。
 */
function normalizeForkedSdkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item) continue;
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

/** recover 是否把损坏的 forkedSdkIds 收敛掉了（需要回写磁盘）。 */
function forkedSdkIdsNeedPersist(original: unknown, recovered: string[] | undefined): boolean {
  if (original === undefined) return recovered !== undefined;
  if (!Array.isArray(original)) return true;
  const ids = recovered ?? [];
  return original.length !== ids.length || original.some((item, index) => item !== ids[index]);
}

/**
 * 归一化磁盘上的后台 shell 任务：
 * - 旧数据没有这个字段时归一化为 []；
 * - 进程重启后 running 的任务不可能还在跑，一律收成 stopped 并补“服务已重启”。
 */
function recoverBackgroundTasks(value: unknown, fallbackTime: string): BackgroundTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: BackgroundTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const task = item as BackgroundTask;
    if (typeof task.taskId !== "string" || !task.taskId) continue;
    const next: BackgroundTask = {
      ...task,
      taskType: typeof task.taskType === "string" && task.taskType ? task.taskType : "local_bash",
      // 缺失说明存空字符串（UI 自行兜底），避免占位值挡住后续真实说明。
      description: typeof task.description === "string" ? task.description : "",
      isBackgrounded: task.isBackgrounded !== false,
      startedAt: typeof task.startedAt === "string" && task.startedAt ? task.startedAt : fallbackTime,
    };
    if (next.status === "running") {
      next.status = "stopped";
      // 进程已经不在，结束时间取磁盘上的会话更新时间（已结束任务保留原值）。
      next.endedAt = next.endedAt ?? fallbackTime;
      next.summary = next.summary || "服务已重启";
    }
    tasks.push(next);
  }
  return tasks;
}

/**
 * 恢复后的后台任务是否需要回写磁盘：数组缺失/长度变化、running 被收成 stopped，
 * 以及非 running 旧条目缺字段时补上的归一化结果，都要落盘一次。
 */
function backgroundTasksNeedPersist(original: unknown, recovered: BackgroundTask[] | undefined): boolean {
  if (!Array.isArray(original) || original.length !== (recovered?.length ?? 0)) return true;
  const tasks = recovered ?? [];
  return original.some((item, index) => {
    if (!item || typeof item !== "object") return true;
    const task = item as BackgroundTask;
    const next = tasks[index];
    if (!next) return true;
    return task.status === "running"
      || task.taskType !== next.taskType
      || task.description !== next.description
      || task.isBackgrounded !== next.isBackgrounded
      || task.startedAt !== next.startedAt;
  });
}

/**
 * 落定的会话如果没有记录结束时间（旧数据，或本次启动时把运行中的会话收成了失败），
 * 用最后一次更新时间补一个近似值；运行中的会话不补。
 */
function withRunEnded(session: SessionCore): SessionCore {
  if (session.runEndedAt || isActivePhase(session.phase) || !session.updatedAt) return session;
  return { ...session, runEndedAt: session.updatedAt };
}

/**
 * 归一化磁盘上的多模型讨论状态：逐项校验参与者和字段；上一次进程里还在跑的
 * 讨论不可能继续，收成「已停止」。
 */
function recoverDiscussion(value: unknown, fallbackTime: string): DiscussionState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  if (
    phase !== "setup"
    && phase !== "running"
    && phase !== "completed"
    && phase !== "failed"
    && phase !== "stopped"
  ) return undefined;
  const participants: DiscussionParticipant[] = [];
  if (Array.isArray(record.participants)) {
    for (const item of record.participants) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const participant = item as Record<string, unknown>;
      if (typeof participant.providerId !== "string" || !participant.providerId) continue;
      if (typeof participant.model !== "string" || !participant.model) continue;
      if (!isEffort(participant.effort)) continue;
      const name = typeof participant.name === "string" && participant.name.trim()
        ? participant.name.trim().slice(0, 40)
        : participant.model;
      participants.push({
        name,
        providerId: participant.providerId,
        providerName: typeof participant.providerName === "string" ? participant.providerName : "",
        model: participant.model,
        effort: participant.effort,
      });
    }
  }
  const round = typeof record.round === "number" && Number.isInteger(record.round) && record.round >= 0
    ? record.round
    : 0;
  const discussion: DiscussionState = { phase, participants, round };
  if (record.strategy === "flat" || record.strategy === "parallel") {
    discussion.strategy = record.strategy;
  }
  if (record.integrating === true) discussion.integrating = true;
  if (Array.isArray(record.subtasks)) {
    const subtasks: DiscussionSubtaskState[] = [];
    for (const item of record.subtasks) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const raw = item as Record<string, unknown>;
      if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 1) continue;
      if (typeof raw.title !== "string" || !raw.title.trim()) continue;
      if (
        raw.phase !== "running"
        && raw.phase !== "completed"
        && raw.phase !== "failed"
        && raw.phase !== "stopped"
      ) continue;
      const subtaskRound = typeof raw.round === "number" && Number.isInteger(raw.round) && raw.round >= 0
        ? raw.round
        : 0;
      const subtask: DiscussionSubtaskState = {
        index: raw.index,
        title: raw.title.trim(),
        phase: raw.phase,
        round: subtaskRound,
      };
      if (typeof raw.activeIndex === "number" && Number.isInteger(raw.activeIndex)) {
        subtask.activeIndex = raw.activeIndex;
      }
      if (typeof raw.activeKind === "string" && isDiscussionKind(raw.activeKind)) {
        subtask.activeKind = raw.activeKind;
      }
      if (raw.agreed === true || raw.agreed === false) subtask.agreed = raw.agreed;
      if (typeof raw.error === "string" && raw.error) subtask.error = raw.error;
      subtasks.push(subtask);
    }
    if (subtasks.length > 0) discussion.subtasks = subtasks;
  }
  if (typeof record.startedAt === "string" && record.startedAt) discussion.startedAt = record.startedAt;
  if (typeof record.endedAt === "string" && record.endedAt) discussion.endedAt = record.endedAt;
  if (record.agreed === true || record.agreed === false) discussion.agreed = record.agreed;
  if (typeof record.error === "string" && record.error) discussion.error = record.error;
  if (phase === "running") {
    discussion.phase = "stopped";
    discussion.endedAt = discussion.endedAt ?? fallbackTime;
    discussion.error = discussion.error ?? "服务已重启，讨论已中断";
    delete discussion.integrating;
    if (discussion.subtasks) {
      discussion.subtasks = discussion.subtasks.map((item) => {
        if (item.phase !== "running") return item;
        const next: DiscussionSubtaskState = { ...item, phase: "stopped" };
        delete next.activeIndex;
        delete next.activeKind;
        return next;
      });
    }
  }
  return discussion;
}

/** 工作流到讨论策略：只有 dis-prl 走拆分、并行子讨论再集成的分层流程。 */
function discussionStrategy(skill: WorkflowSkill): DiscussionStrategy {
  return skill === "dis-prl" ? "parallel" : "flat";
}

/** 磁盘上的角色团队绑定：逐字段校验，任何一项不合法都返回 undefined。 */
function recoverRoleTeam(value: unknown): RoleTeam | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const readBinding = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const binding = raw as Record<string, unknown>;
    if (typeof binding.providerId !== "string" || !binding.providerId) return undefined;
    if (typeof binding.model !== "string" || !binding.model) return undefined;
    if (!isEffort(binding.effort)) return undefined;
    return {
      providerId: binding.providerId,
      providerName: typeof binding.providerName === "string" ? binding.providerName : "",
      model: binding.model,
      effort: binding.effort,
    };
  };
  const orchestrator = readBinding(record.orchestrator);
  const executor = readBinding(record.executor);
  const subReviewer = readBinding(record.subReviewer);
  const integrationReviewer = readBinding(record.integrationReviewer);
  if (!orchestrator || !executor || !subReviewer || !integrationReviewer) return undefined;
  return { orchestrator, executor, subReviewer, integrationReviewer };
}

function isRoleKind(value: unknown): value is RoleKind {
  return value === "orchestrator"
    || value === "executor"
    || value === "sub-reviewer"
    || value === "integration-reviewer";
}

function isRoleUnitPhase(value: unknown): value is RoleUnitPhase {
  return value === "pending"
    || value === "running"
    || value === "passed"
    || value === "needs_attention"
    || value === "stopped";
}

/**
 * 归一化磁盘上的 prl-role 状态：逐项校验团队、单元和字段；上一次进程里还在跑
 * 的运行不可能继续，收成「已停止」。
 */
function recoverRoleRun(value: unknown, fallbackTime: string): RoleRunState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  if (
    phase !== "setup"
    && phase !== "running"
    && phase !== "completed"
    && phase !== "failed"
    && phase !== "stopped"
  ) return undefined;
  const units: RoleUnitState[] = [];
  if (Array.isArray(record.units)) {
    for (const item of record.units) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const raw = item as Record<string, unknown>;
      if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 1) continue;
      if (typeof raw.title !== "string" || !raw.title.trim()) continue;
      if (!isRoleUnitPhase(raw.phase)) continue;
      const round = typeof raw.round === "number" && Number.isInteger(raw.round) && raw.round >= 0
        ? raw.round
        : 0;
      const unit: RoleUnitState = {
        index: raw.index,
        title: raw.title.trim(),
        phase: raw.phase,
        round,
      };
      if (raw.verdict === "pass" || raw.verdict === "changes" || raw.verdict === "unknown") {
        unit.verdict = raw.verdict;
      }
      if (typeof raw.issues === "string" && raw.issues) unit.issues = raw.issues;
      if (typeof raw.executorSummary === "string" && raw.executorSummary) {
        unit.executorSummary = raw.executorSummary;
      }
      units.push(unit);
    }
  }
  const round = typeof record.round === "number" && Number.isInteger(record.round) && record.round >= 0
    ? record.round
    : 0;
  const maxRounds = typeof record.maxRounds === "number"
    && Number.isInteger(record.maxRounds)
    && record.maxRounds >= 1
    ? record.maxRounds
    : MAX_ROLE_ROUNDS;
  const roleRun: RoleRunState = { phase, units, round, maxRounds };
  const team = recoverRoleTeam(record.team);
  if (team) roleRun.team = team;
  if (isRoleKind(record.activeRole)) roleRun.activeRole = record.activeRole;
  if (typeof record.activeUnit === "number" && Number.isInteger(record.activeUnit) && record.activeUnit >= 1) {
    roleRun.activeUnit = record.activeUnit;
  }
  if (typeof record.activeTool === "string" && record.activeTool) roleRun.activeTool = record.activeTool;
  if (record.integrating === true) roleRun.integrating = true;
  if (record.agreed === true || record.agreed === false) roleRun.agreed = record.agreed;
  if (typeof record.startedAt === "string" && record.startedAt) roleRun.startedAt = record.startedAt;
  if (typeof record.endedAt === "string" && record.endedAt) roleRun.endedAt = record.endedAt;
  if (typeof record.error === "string" && record.error) roleRun.error = record.error;
  if (phase === "running") {
    roleRun.phase = "stopped";
    roleRun.endedAt = roleRun.endedAt ?? fallbackTime;
    roleRun.error = roleRun.error ?? "服务已重启，角色团队运行已中断";
    delete roleRun.activeRole;
    delete roleRun.activeUnit;
    delete roleRun.activeTool;
    delete roleRun.integrating;
    roleRun.units = roleRun.units.map((item) => (
      item.phase === "running" ? { ...item, phase: "stopped" as const } : item
    ));
  }
  return roleRun;
}

function isDiscussionKind(value: string): value is DiscussionKind {
  return value === "decompose"
    || value === "answer"
    || value === "review"
    || value === "rebuttal"
    || value === "final";
}

/** 磁盘上的 workflow 可能是旧版本/损坏数据；字段不合法就整段丢弃。 */
function validWorkflow(value: unknown): WorkflowRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.skill !== "prl"
    && record.skill !== "ser"
    && record.skill !== "plan"
    && record.skill !== "discuss"
    && record.skill !== "dis-prl"
    && record.skill !== "prl-role"
  ) {
    return undefined;
  }
  if (typeof record.startedAt !== "string" || !record.startedAt) return undefined;
  if (record.endedAt !== undefined && (typeof record.endedAt !== "string" || !record.endedAt)) return undefined;
  return {
    skill: record.skill,
    startedAt: record.startedAt,
    ...(typeof record.endedAt === "string" ? { endedAt: record.endedAt } : {}),
  };
}

export function toSummary(session: SessionCore, detail: boolean): SessionSummary {
  const counts = subagentCounts(session.subagents);
  const summary: SessionSummary = {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    providerId: session.providerId,
    providerName: session.providerName,
    model: session.model,
    effort: session.effort,
    phase: session.phase,
    summary: session.summary,
    lastError: session.lastError,
    branch: session.branch,
    git: session.git,
    cwd: session.cwd,
    // 非 git 会话的 cwd 落在项目目录之外，说明它用的是独立子目录。
    isolated: !session.git && session.cwd !== session.projectPath,
    subagentDone: counts.done,
    subagentTotal: counts.total,
    subagents: session.subagents,
    // 稳定暴露：没有后台任务时也给 []（而不是省略字段），前端不用做 undefined 分支。
    backgroundTasks: session.backgroundTasks ?? [],
    mainAgentRunning: mainAgentRunning(session),
    pending: session.pending,
    pinned: session.pinned === true,
    runStartedAt: session.runStartedAt,
    runEndedAt: session.runEndedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  if (session.workflow) summary.workflow = session.workflow;
  if (session.discussion) summary.discussion = session.discussion;
  if (session.roleRun) {
    // 列表/board 帧不需要完整的审核原文和自述；detail 帧才下发全文。
    summary.roleRun = detail ? session.roleRun : compactRoleRun(session.roleRun);
  }
  if (detail) summary.messages = session.messages.map(strip);
  return summary;
}

/** 列表帧用的 roleRun：把较长的单元文本裁到 200 字，避免 SSE 体积随运行增长。 */
function compactRoleRun(roleRun: RoleRunState): RoleRunState {
  return {
    ...roleRun,
    units: roleRun.units.map((item) => ({
      ...item,
      ...(item.issues !== undefined ? { issues: clip(item.issues, 200) } : {}),
      ...(item.executorSummary !== undefined ? { executorSummary: clip(item.executorSummary, 200) } : {}),
    })),
  };
}

function strip(item: TranscriptItem): TranscriptItem {
  return {
    id: item.id,
    role: item.role,
    text: item.text,
    toolName: item.toolName,
    toolUseId: item.toolUseId,
    images: item.images,
    partial: item.partial,
    kind: item.kind,
    at: item.at,
    usage: item.usage,
    model: item.model,
    speaker: item.speaker,
    discussion: item.discussion,
    roleRun: item.roleRun,
    // sdkUuid/forkPoint 是服务端内部指针，不下发；只告诉前端能否回滚/分叉。
    rewindable: Boolean(item.sdkUuid && item.forkPoint),
  };
}

/** 回滚过滤：只保留在切点之前就开始的子 agent/后台任务；没有切点时全部丢弃。 */
function startedBeforeCut(startedAt: string | undefined, cutAt: string | undefined): boolean {
  if (!cutAt || typeof startedAt !== "string" || !startedAt) return false;
  const started = Date.parse(startedAt);
  const cut = Date.parse(cutAt);
  if (!Number.isFinite(started) || !Number.isFinite(cut)) return startedAt < cutAt;
  return started < cut;
}

/** 还没被 agent 取走、固定在记录末尾的排队用户消息。 */
function isQueuedUser(item: TranscriptItem | undefined): boolean {
  return Boolean(item && item.role === "user" && item.queued === true);
}

function summarizeInput(text: string, images: ImageRef[] | undefined): string {
  const summary = clip(text, 160);
  if (summary) return summary;
  return images && images.length > 0 ? `[图片 ×${images.length}]` : "图片";
}

function requireNonEmpty(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}
