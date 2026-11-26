import {
  forkSession,
  getSessionMessages,
  query,
  type Options,
  type PermissionResult,
  type Query,
  type RewindFilesResult,
  type SDKUserMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID, type UUID } from "node:crypto";
import fs from "node:fs";
import {
  answerPrompt,
  decomposePrompt,
  discussionSystemPrompt,
  finalPrompt,
  integrationTopic,
  MAX_DISCUSSION_ROUNDS,
  parseAgreement,
  parseSubtasks,
  rebuttalPrompt,
  reviewPrompt,
  subtaskTopic,
  type DiscussionEntry,
  type Discussant,
} from "./discussion.js";
import { claudeConnection, claudeEnv } from "./endpoint.js";
import { decideTool, denyMessage, type PermissionLevel } from "./permissions.js";
import {
  cleanGeneratedTitle,
  titleInput,
  type TitleSummarizer,
} from "./session-title.js";
import { clip, detectWorkflowSkill, isActivePhase, isAgentActive, type SdkMessage } from "./status.js";
import type { Store } from "./store.js";
import type {
  DiscussionKind,
  DiscussionParticipant,
  DiscussionStrategy,
  Effort,
  ImageMediaType,
  ImageRef,
  PendingQuestion,
  PendingRequest,
  QueueEntry,
  SessionCore,
  WorkflowSkill,
} from "./types.js";

const APPEND_PROMPT = [
  "你在远程开发控制台中工作。",
  "把互不依赖的子任务拆给并行子 agent（Agent 工具）同时做。",
  "每个子 agent 用一句话 description 说明它负责的事。",
  "不要再开一个会改同一批文件的子 agent。",
  "下载、安装等耗时命令请用 Bash 的 run_in_background 启动，并保留进度输出（例如 curl -#、wget 默认进度），不要在 agent 侧反复轮询 BashOutput 汇报进度；客户端会直接显示实时进度。",
  "如果后续步骤依赖该命令，等它结束后检查输出和退出码再继续。",
].join("\n");

const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 10;

/**
 * 对话启动前检查目录是否还在。
 *
 * Claude Code 启动时要求 cwd 和 `--project-config-root` 都是当前用户能列出的
 * 目录，否则进程带着一句难懂的 stderr 直接退出（exit 1）。项目被改名/搬走、
 * worktree 被删这类情况在这里先给出能定位问题的错误。
 */
export function sessionDirProblem(
  session: Pick<SessionCore, "cwd" | "projectPath">,
): string | undefined {
  if (!canListDirectory(session.cwd)) {
    return `对话工作目录不存在或不可访问：${session.cwd}（可能已被删除；请新建对话）`;
  }
  if (session.projectPath !== session.cwd && !canListDirectory(session.projectPath)) {
    return `项目目录不存在或不可访问：${session.projectPath}（项目可能已改名或移走，请更新项目配置后重试）`;
  }
  return undefined;
}

function canListDirectory(dir: string): boolean {
  try {
    fs.opendirSync(dir).closeSync();
    return true;
  } catch {
    return false;
  }
}

const MAX_BUFFERED_PROMPTS = 20;
const MAX_WAITING_SESSIONS = 200;
/** stop/delete 等待 run 收尾的上限；SDK 卡死时不能永久悬挂。 */
const STOP_TIMEOUT_MS = 30_000;

export interface Approval {
  behavior: "allow" | "deny";
  answers?: Record<string, string>;
  /** 用户勾选「本对话记住」时，这个工具的后续确认直接放行。 */
  remember?: boolean;
}

/** 用户长时间不回应确认请求时自动拒绝，避免这一轮永远挂着。 */
class ApprovalTimeoutError extends Error {}

/** 讨论在两次模型调用之间被停止：和 SDK 抛出的 abort 一样按“已停止”落定。 */
class DiscussionStopped extends Error {}

/** 一条讨论发言的归属：某个子任务，或者最后的集成阶段。 */
interface DiscussionScope {
  subtask?: { index: number; title: string };
  integrating?: boolean;
}

/** 一个子讨论的结果；失败时没有结论，只带原因。 */
interface SubtaskResult {
  title: string;
  conclusion: string;
  agreed: boolean;
  failed?: string;
}

/**
 * 假运行模式下的讨论发言：不调用模型，按轮次产出可识别的文本，审阅一律
 * 表示一致。测试也可以注入自己的 Discussant 覆盖它。
 */
const fakeDiscussant: Discussant = async (request) => {
  if (request.kind === "decompose") {
    return `["子任务一","子任务二"]`;
  }
  if (request.kind === "review") {
    return `审阅意见：当前方案可以执行，没有发现阻塞性问题。\n\n裁定：一致`;
  }
  if (request.kind === "final") {
    return `最终结论：${request.participant.name} 整合讨论结果后给出最终答复。`;
  }
  if (request.kind === "rebuttal") {
    return `${request.participant.name} 采纳了审阅意见并修订了方案。`;
  }
  return `${request.participant.name} 的回答：针对讨论主题给出方案。`;
};

/** 讨论主题取会话里最后一条用户消息；只发图片时给一个占位说明。 */
function discussionTopic(session: SessionCore): string | undefined {
  const last = [...session.messages].reverse().find((item) => item.role === "user");
  if (!last) return undefined;
  return last.text.trim() || "（用户只发送了图片，请结合上下文讨论）";
}

export type SubmitCheck =
  | { ok: true }
  | { ok: false; status: number; error: string };

interface Waiter {
  requestId: string;
  resolve: (approval: Approval) => void;
  reject: (error: Error) => void;
}

/** 发给 SDK 的一条用户消息。图片用 base64，只在这一轮里用。 */
export interface RuntimePrompt {
  text: string;
  images: Array<{ mediaType: ImageMediaType; data: string }>;
  /** 已经存进会话目录、用于对话记录的图片引用；缺省时记录里不带图片。 */
  storedImages?: ImageRef[];
  /** 聊天输入区显式选择的工作流；会作为独立文本块提示 agent 调用对应 skill。 */
  workflow?: WorkflowSkill;
  /**
   * 随 SDKUserMessage 发给 SDK 的 uuid；它会成为 SDK transcript 里这条 user
   * 条目的 chain uuid，回滚/分叉依赖它。缺省时由 SDK 自行生成。
   */
  uuid?: string;
}

/** 显式选择工作流时给 agent 的额外指令；不写进用户消息正文/记录。 */
export function workflowInstruction(skill: WorkflowSkill): string {
  if (skill === "prl") {
    return "本消息选择了 prl 工作流（并行开发 + 一对一评审）。请先调用 prl skill，再执行下面的请求。";
  }
  if (skill === "ser") {
    return "本消息选择了 ser 工作流（串行开发 + 一对一评审）。请先调用 ser skill，再执行下面的请求。";
  }
  if (skill === "discuss") {
    return "本消息选择了 discuss 工作流（多模型讨论）。请先给出你的回答。";
  }
  if (skill === "dis-prl") {
    return "本消息选择了 dis-prl 工作流（拆分 + 并行子讨论 + 集成）。请先给出你的回答。";
  }
  return "本消息选择了 plan 工作流（开发计划 + 独立评审）。请先调用 plan skill；只做计划，不改代码。";
}

/** 排队中的消息额外带上提交时间和用于撤回的 id。 */
export type QueuedPrompt = RuntimePrompt & {
  id: string;
  createdAt: string;
  /** 写进对话记录后的条目 id；被 agent 取走时用它清掉排队标记。 */
  transcriptId?: string;
};

/** 一轮 query 启动时读到的运行配置；用于检测中途改了 provider/model/effort。 */
export interface RunConfig {
  providerId: string;
  model: string;
  effort: Effort;
  /** 技能开关的版本；变化后下一轮要重启 query 才能应用新的过滤列表。 */
  skillsVersion?: number;
}

/** 当前 run 的配置与 Store 里的会话配置是否已经不一致。 */
export function runConfigChanged(
  config: RunConfig,
  session: Pick<SessionCore, "providerId" | "model" | "effort">,
): boolean {
  return config.providerId !== session.providerId
    || config.model !== session.model
    || config.effort !== session.effort;
}

/** 下一次 query 启动方式：新会话（指定 id）或续接已有会话。 */
export type SdkStartMode = { kind: "new"; id: string } | { kind: "resume"; id: string };

/**
 * 根据会话状态决定用 sessionId 新建还是 resume 续接。
 *
 * - 回滚到最开始：必须新建（用 claudeSessionId 作为新 id），不能 resume；
 * - 从未跑过：用本地会话 id 新建（保留原有行为）；
 * - 其余：resume 已有 SDK 会话。
 */
export function sdkStartMode(
  session: Pick<SessionCore, "id" | "claudeSessionId" | "newSdkSession">,
): SdkStartMode {
  if (session.newSdkSession === true && session.claudeSessionId) {
    return { kind: "new", id: session.claudeSessionId };
  }
  if (!session.claudeSessionId) return { kind: "new", id: session.id };
  return { kind: "resume", id: session.claudeSessionId };
}

type UserContent = Exclude<SDKUserMessage["message"]["content"], string>;

/**
 * 排队项的内部包装。deferred 为 true 表示这条消息还没轮到发送：要等当前轮
 * 结束（result）后才交给 agent；false 表示已经放行，agent 取走时可能直接
 * 折叠进正在跑的轮次（插话）。快照不下发这个字段。
 */
type QueueItem = QueuedPrompt & { deferred: boolean };

/**
 * 内部排队队列；导出仅为测试 shouldRestart/releaseNext 行为。
 *
 * 两种放行方式：
 * - 插话 / 「现在发送」：立即把 deferred 置为 false，SDK 会在当前轮里取走；
 * - 排队（默认 Enter）：先留在 deferred，轮末由 runtime 调用 releaseNext()
 *   逐条放行，保证每条排队消息各自成为一轮。
 */
export class PromptQueue {
  private items: QueueItem[] = [];
  private waiters: Array<() => void> = [];
  closed = false;

  /**
   * shouldRestart 返回 true 时停止消费，让 start() 用新配置重启 query。
   * onConsume 在消息真正被 agent 取走时调用，用来把排队消息的工作流切到当前轮；
   * 第二个参数是解析后的 skill（显式字段或正文末尾 token）。
   */
  constructor(
    private readonly shouldRestart?: () => boolean,
    private readonly onConsume?: (item: QueuedPrompt, skill: WorkflowSkill | undefined) => void,
  ) {}

  get size(): number {
    return this.items.length;
  }

  push(item: QueuedPrompt, deferred = false): void {
    if (this.closed) return;
    this.items.push({ ...item, deferred });
    this.wake();
  }

  /**
   * 当前还没被 agent 取走的消息副本，供前端展示；含尚未放行的排队消息。
   * 额外带上内部 deferred 标记，runtime 据此告诉前端哪些已经「现在发送」过。
   */
  snapshot(): QueueItem[] {
    return this.items.slice();
  }

  /** 队列里是否有这条消息（可能已放行但 agent 还没取走）。 */
  has(id: string): boolean {
    return this.items.some((item) => item.id === id);
  }

  /**
   * 「现在发送」/ 插话：立刻放行这条消息，让 agent 在当前轮里取走。
   * 已经放行但还没被取走的也算成功；不在队列里（已被取走）返回 false。
   */
  promote(id: string): boolean {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return false;
    if (item.deferred) {
      item.deferred = false;
      this.wake();
    }
    return true;
  }

  /**
   * 当前轮结束后放行下一条排队消息。只放行一条：多条同时放行时 SDK 会把
   * 相邻消息合并进同一轮，逐条放行才能让每条排队消息各自跑一轮。
   */
  releaseNext(): boolean {
    const item = this.items.find((candidate) => candidate.deferred);
    if (!item) return false;
    item.deferred = false;
    this.wake();
    return true;
  }

  /** 改写尚未被取走的消息正文；已被取走返回 false。 */
  edit(id: string, text: string): boolean {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return false;
    item.text = text;
    return true;
  }

  /** 撤回指定消息；已经被 agent 取走的消息不在队列里，删不到。 */
  remove(id: string): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  drain(): QueuedPrompt[] {
    const left = this.items.splice(0);
    return left;
  }

  async *messages(): AsyncGenerator<SDKUserMessage> {
    // 关闭后仍会把已经放行的消息吐完（和原有行为一致）；deferred 的留给
    // drain() 重新入队或丢弃。
    while (!this.closed || this.items.some((item) => !item.deferred)) {
      const index = this.items.findIndex((item) => !item.deferred);
      if (index < 0) {
        if (this.closed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        continue;
      }
      // 配置在轮间被改过：不消费这条消息，交给 start() 的 finally 重新入队，
      // 由新配置的 run 接手。
      if (this.shouldRestart?.()) return;
      const [item] = this.items.splice(index, 1);
      if (!item) continue;
      // 显式选择优先；没有显式字段时再看正文末尾的 token。消费时解析，
      // 排队期间不能提前生效。
      const skill = item.workflow ?? detectWorkflowSkill(item.text) ?? undefined;
      this.onConsume?.(item, skill);
      const content = [
        ...(skill ? [{ type: "text" as const, text: workflowInstruction(skill) }] : []),
        ...item.images.map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
        })),
        ...(item.text ? [{ type: "text" as const, text: item.text }] : []),
      ] as UserContent;
      yield {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        // 原样带回调用方给的 uuid，SDK 会用它作为这条 user 条目的 chain uuid。
        ...(item.uuid ? { uuid: item.uuid as UUID } : {}),
      };
    }
  }

  private wake(): void {
    const pending = this.waiters.splice(0);
    for (const resolve of pending) resolve();
  }
}

export class Runtime {
  private active = new Set<string>();
  private waiting: string[] = [];
  private buffered = new Map<string, QueuedPrompt[]>();
  private queues = new Map<string, PromptQueue>();
  private aborters = new Map<string, AbortController>();
  /** 每个会话当前活跃的 SDK Query 句柄，用于后台任务的读输出/转后台/停止。 */
  private queries = new Map<string, Query>();
  /** 正在跑的多模型讨论；和 runs 一样用于 stop() 等待收尾。 */
  private discussions = new Map<string, Promise<void>>();
  /** 启动时已开启 enableFileCheckpointing 的会话；只有这些会话能回滚文件。 */
  private checkpointed = new Set<string>();
  private waiters = new Map<string, Waiter>();
  private releasing = new Set<string>();
  /** stop 超时后仍未收尾的僵尸 run；在新 run 启动前保持阻塞。 */
  private zombies = new Set<string>();
  /** 正在运行的 start() promise，stop()/shutdown() 需要等它真正收尾。 */
  private runs = new Map<string, Promise<void>>();
  /** 已请求停止、尚未完成收尾的会话；期间不再接受新的 prompt。 */
  private stopping = new Set<string>();
  /** 用户在「本对话记住」里放行的工具：sessionId -> toolName 集合。 */
  private remembered = new Map<string, Set<string>>();
  /** 每个会话当前 query 启动时用的配置，用于检测中途改动。 */
  private runConfigs = new Map<string, RunConfig>();
  /** 配置变了、需要让当前 query 收尾后重启的会话。 */
  private restarting = new Set<string>();
  /** 正在生成标题的会话；同一时刻只发起一次。 */
  private titleJobs = new Map<string, Promise<void>>();
  /** 标题生成的中止句柄；服务关闭时一起中止，避免子进程拖住退出。 */
  private titleAborts = new Map<string, AbortController>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly approvalTimeoutMs: number;
  /** 当前生效的并发对话上限；设置页保存后由 setMaxConcurrent 即时更新。 */
  private maxConcurrent: number;

  constructor(
    private store: Store,
    private deps: {
      maxConcurrent: number;
      fake: boolean;
      credential: (providerId: string) => { apiKey: string; baseUrl: string };
      permission: (projectId: string) => PermissionLevel;
      secrets: () => string[];
      /** 等待确认的超时时间，默认 10 分钟。 */
      approvalTimeoutMinutes?: number;
      /**
       * 技能开关：按项目返回应启用的 SDK 技能名；undefined 表示沿用 SDK 默认。
       * version 在开关变化时递增，用于让进行中的会话在下一轮重启 query。
       */
      skills?: {
        filter: (projectId: string) => string[] | undefined;
        version: () => number;
      };
      /**
       * 会话标题总结器：首个成功轮次结束后异步调用一次，把占位标题换成
       * agent 总结出的文案。缺省（假运行/测试）时不生成。
       */
      titleSummarizer?: TitleSummarizer;
      /** 多模型讨论的单次模型调用；缺省时使用假实现（测试/假运行）。 */
      discussant?: Discussant;
    },
  ) {
    const minutes = deps.approvalTimeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES;
    this.approvalTimeoutMs = minutes * 60_000;
    this.maxConcurrent = deps.maxConcurrent;
  }

  /**
   * 更新并发对话上限。提高时立即尝试启动排队中的对话；降低时不打断
   * 已在跑的对话，多出来的槽位在它们空闲回收后自然收敛。
   */
  setMaxConcurrent(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value === this.maxConcurrent) return;
    this.maxConcurrent = value;
    this.schedule();
  }

  /** 这个会话是否正在跑一场多模型讨论。 */
  isDiscussing(id: string): boolean {
    return this.discussions.has(id);
  }

  /**
   * 开始一场多模型讨论。同步完成校验并占住并发槽，返回后模型调用在后台逐个
   * 进行；进度通过 Store 的 SSE 帧推给前端。停止仍然走 stop()。
   */
  startDiscussion(
    id: string,
    participants: DiscussionParticipant[],
    strategy: DiscussionStrategy = "flat",
  ): void {
    if (this.shuttingDown) throw new Error("服务正在退出");
    if (this.zombies.has(id)) throw new Error("对话进程卡住，正在清理");
    if (this.stopping.has(id)) throw new Error("对话正在停止");
    const session = this.store.require(id);
    if (this.discussions.has(id) || this.active.has(id)) {
      throw new Error("对话正在运行，等这一轮结束再开始讨论");
    }
    if (participants.length === 0) throw new Error("请先添加参与讨论的模型");
    if (this.active.size >= this.maxConcurrent) throw new Error("并发已满，请稍后再开始讨论");
    const topic = discussionTopic(session);
    if (!topic) throw new Error("还没有可以讨论的用户消息");
    this.store.beginDiscussion(id, participants, strategy === "parallel" ? "dis-prl" : "discuss");
    const abort = new AbortController();
    this.aborters.set(id, abort);
    this.active.add(id);
    const run = this.runDiscussion(id, participants, topic, abort.signal, strategy).finally(() => {
      this.discussions.delete(id);
      this.active.delete(id);
      if (this.aborters.get(id) === abort) this.aborters.delete(id);
      if (this.runs.get(id) === run) this.runs.delete(id);
      this.schedule();
    });
    this.discussions.set(id, run);
    this.runs.set(id, run);
  }

  /**
   * 讨论入口：flat 走原来的主循环；parallel 先拆分，再让每个子任务各跑一遍
   * 原循环（互相并行），最后用同样的循环整合各子结论。
   */
  private async runDiscussion(
    id: string,
    participants: DiscussionParticipant[],
    topic: string,
    signal: AbortSignal,
    strategy: DiscussionStrategy,
  ): Promise<void> {
    try {
      if (strategy === "parallel") {
        await this.runParallelDiscussion(id, participants, topic, signal);
      } else {
        const { agreed } = await this.runFlatDiscussion(id, participants, topic, signal);
        this.store.settleDiscussion(id, { result: "success", agreed });
      }
    } catch (error) {
      if (signal.aborted || error instanceof DiscussionStopped) {
        this.store.settleDiscussion(id, { result: "stopped", error: "讨论已停止" });
      } else {
        const detail = clip(redact(errorText(error), this.deps.secrets()), 300);
        this.store.settleDiscussion(id, { result: "error", error: detail || "讨论失败" });
      }
    }
  }

  /**
   * 一次讨论发言：更新进度、调用模型、把发言写进对话记录。
   * scope 标记这条发言属于哪个子任务，或者是不是集成阶段。
   */
  private async speak(
    id: string,
    participant: DiscussionParticipant,
    index: number,
    kind: DiscussionKind,
    round: number,
    prompt: string,
    signal: AbortSignal,
    scope: DiscussionScope,
  ): Promise<string> {
    if (signal.aborted) throw new DiscussionStopped();
    this.store.setDiscussionProgress(id, {
      round,
      activeIndex: index,
      activeKind: kind,
      ...(scope.subtask ? { subtask: scope.subtask.index } : {}),
      ...(scope.integrating ? { integrating: true } : {}),
    });
    const discussant = this.deps.discussant ?? fakeDiscussant;
    const cwd = this.store.get(id)?.cwd ?? process.cwd();
    const raw = await discussant({
      participant,
      kind,
      round,
      systemPrompt: discussionSystemPrompt(participant),
      prompt,
      cwd,
      signal,
    });
    const text = raw.trim();
    if (signal.aborted) throw new DiscussionStopped();
    if (!text) throw new Error(`${participant.name} 没有返回内容`);
    this.store.appendDiscussionMessage(id, {
      speaker: participant.name,
      text,
      round,
      kind,
      ...(scope.subtask ? { subtask: scope.subtask } : {}),
      ...(scope.integrating ? { integration: true } : {}),
    });
    return text;
  }

  /**
   * 原来的讨论主循环：第一个模型回答 → 其余模型逐个审阅 → 不一致就由第一个
   * 模型答辩并再次复审，最多 MAX_DISCUSSION_ROUNDS 轮 → 第一个模型给最终结论。
   * 不负责落定整场讨论，方便被并行子任务复用。
   */
  private async runFlatDiscussion(
    id: string,
    participants: DiscussionParticipant[],
    topic: string,
    signal: AbortSignal,
    scope: DiscussionScope = {},
  ): Promise<{ agreed: boolean; conclusion: string }> {
    const entries: DiscussionEntry[] = [];
    const say = async (index: number, kind: DiscussionKind, round: number, prompt: string): Promise<string> => {
      const participant = participants[index]!;
      const text = await this.speak(id, participant, index, kind, round, prompt, signal, scope);
      entries.push({ participant, kind, round, text });
      return text;
    };
    let round = 1;
    await say(0, "answer", round, answerPrompt(topic));
    let agreed = await this.reviewRound(participants, topic, entries, round, say);
    while (!agreed && round < MAX_DISCUSSION_ROUNDS) {
      round += 1;
      await say(0, "rebuttal", round, rebuttalPrompt(topic, entries));
      agreed = await this.reviewRound(participants, topic, entries, round, say);
    }
    await say(0, "final", round, finalPrompt(topic, entries, agreed));
    return { agreed, conclusion: entries[entries.length - 1]?.text ?? "" };
  }

  /**
   * 分层讨论：第一个模型拆分 → 子任务并行跑原流程 → 所有模型对子结论做一次
   * 集成讨论。拆分不可靠时退回普通讨论，不额外消耗模型。
   */
  private async runParallelDiscussion(
    id: string,
    participants: DiscussionParticipant[],
    topic: string,
    signal: AbortSignal,
  ): Promise<void> {
    const lead = participants[0]!;
    const decomposed = await this.speak(id, lead, 0, "decompose", 1, decomposePrompt(topic), signal, {});
    const titles = parseSubtasks(decomposed);
    if (titles.length <= 1) {
      const { agreed } = await this.runFlatDiscussion(id, participants, topic, signal);
      this.store.settleDiscussion(id, { result: "success", agreed });
      return;
    }

    this.store.setDiscussionSubtasks(id, titles);
    const results = await Promise.all(titles.map(async (title, position): Promise<SubtaskResult> => {
      const subtask = { index: position + 1, title };
      try {
        const result = await this.runFlatDiscussion(
          id,
          participants,
          subtaskTopic(title, topic),
          signal,
          { subtask },
        );
        this.store.settleDiscussionSubtask(id, subtask.index, {
          phase: "completed",
          agreed: result.agreed,
        });
        return { title, conclusion: result.conclusion, agreed: result.agreed };
      } catch (error) {
        if (signal.aborted || error instanceof DiscussionStopped) throw error;
        const detail = clip(redact(errorText(error), this.deps.secrets()), 200) || "子讨论失败";
        this.store.settleDiscussionSubtask(id, subtask.index, { phase: "failed", error: detail });
        return { title, conclusion: "", failed: detail, agreed: false };
      }
    }));
    if (signal.aborted) throw new DiscussionStopped();
    if (results.every((item) => item.failed)) {
      throw new Error(results.find((item) => item.failed)?.failed ?? "所有子讨论都失败了");
    }

    const integration = await this.runFlatDiscussion(
      id,
      participants,
      integrationTopic(topic, results),
      signal,
      { integrating: true },
    );
    const agreed = integration.agreed && results.every((item) => !item.failed && item.agreed);
    this.store.settleDiscussion(id, { result: "success", agreed });
  }

  /** 让第 2..N 个参与者依次审阅；只有所有审阅都明确「一致」才算达成一致。 */
  private async reviewRound(
    participants: DiscussionParticipant[],
    topic: string,
    entries: DiscussionEntry[],
    round: number,
    say: (index: number, kind: DiscussionKind, round: number, prompt: string) => Promise<string>,
  ): Promise<boolean> {
    let agreed = true;
    for (let index = 1; index < participants.length; index += 1) {
      const text = await say(index, "review", round, reviewPrompt(topic, entries));
      if (!parseAgreement(text)) agreed = false;
    }
    return agreed;
  }

  /**
   * POST /messages 在写入用户消息之前先检查这里，避免超限的消息已经写进对话
   * 却永远排不到执行。返回结果为同步检查，和随后的 submit() 在同一轮事件循环里完成。
   */
  canSubmit(id: string): SubmitCheck {
    if (this.shuttingDown) return { ok: false, status: 503, error: "服务正在退出" };
    if (this.zombies.has(id)) return { ok: false, status: 409, error: "对话进程卡住，正在清理" };
    if (this.stopping.has(id)) return { ok: false, status: 409, error: "对话正在停止" };
    if (!this.store.get(id)) return { ok: false, status: 404, error: "找不到对话" };
    const live = this.queues.get(id);
    const pending = live && !live.closed
      ? live.size
      : (this.buffered.get(id)?.length ?? 0);
    if (pending >= MAX_BUFFERED_PROMPTS) {
      return { ok: false, status: 429, error: "这个对话排队的消息太多，请等它处理完再发" };
    }
    const known = this.active.has(id) || this.waiting.includes(id);
    if (!known && this.waiting.length >= MAX_WAITING_SESSIONS) {
      return { ok: false, status: 429, error: "排队中的对话太多，请稍后再发" };
    }
    return { ok: true };
  }

  /** 这个会话当前是否挂着一个活跃的 query run（可能处于两轮之间）。 */
  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** 是否运行在假模式（不启动真实 SDK 进程）；HTTP 层据此跳过 transcript 重映射。 */
  isFake(): boolean {
    return this.deps.fake;
  }

  /**
   * 这个会话当前是否有可用的文件检查点。
   * 真实模式要求 query 还在跑且启动时开启了 checkpointing；假模式只看进程活跃。
   */
  canRewindFiles(id: string): boolean {
    if (this.deps.fake) return this.active.has(id);
    return this.queries.has(id) && this.checkpointed.has(id);
  }

  /**
   * 回滚文件到某条用户消息发出时的检查点。
   * 假模式不碰真实文件，进程活跃时返回空改动；真实模式交给 SDK。
   */
  async rewindFiles(id: string, userMessageUuid: string, dryRun?: boolean): Promise<RewindFilesResult> {
    if (this.deps.fake) {
      if (!this.active.has(id)) throw new Error("对话当前没有运行中的进程");
      return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
    }
    const handle = this.queryHandle(id);
    return handle.rewindFiles(userMessageUuid, dryRun === undefined ? undefined : { dryRun });
  }

  /**
   * 在 SDK transcript 层分叉出一个新会话（复制到截断点，uuid 全部重映射）。
   * 假模式返回一个随机 id，不写文件。
   */
  async forkSdkSession(
    sourceSdkId: string,
    upToMessageId: string,
    cwd: string,
    title?: string,
  ): Promise<string> {
    if (this.deps.fake) return randomUUID();
    const result = await forkSession(sourceSdkId, {
      dir: cwd,
      upToMessageId,
      ...(title ? { title } : {}),
    });
    return result.sessionId;
  }

  /**
   * 读取 SDK transcript；假模式没有真实文件，返回空数组。
   * 真实模式下找不到（空结果）必须抛错：调用方要把"没有 transcript"和"合法的
   * 空 transcript"区分开，否则会误把本地所有指针清空。
   */
  async sdkSessionMessages(sdkId: string, cwd: string): Promise<SessionMessage[]> {
    if (this.deps.fake) return [];
    const messages = await getSessionMessages(sdkId, { dir: cwd });
    if (messages.length === 0) throw new Error("找不到 SDK 会话 transcript");
    return messages;
  }

  /**
   * 读取后台任务当前输出。SDK 0.3.329 运行时提供 getTaskOutput，但类型声明里
   * 没有列出，这里做局部断言后调用；响应里的字段仍是 snake_case。
   */
  async taskOutput(id: string, taskId: string): Promise<TaskOutput> {
    const trimmed = requireTaskId(taskId);
    const handle = this.queryHandle(id);
    const getTaskOutput = (handle as QueryWithTaskOutput).getTaskOutput;
    if (typeof getTaskOutput !== "function") {
      throw new Error("当前 SDK 不支持读取后台任务输出");
    }
    const raw = await getTaskOutput.call(handle, trimmed);
    return normalizeTaskOutput(raw);
  }

  /** 把前台任务转到后台运行；返回 SDK 是否确实转了一个任务。 */
  async backgroundTask(id: string, toolUseId: string): Promise<boolean> {
    const trimmed = requireTaskId(toolUseId);
    const handle = this.queryHandle(id);
    const started = await handle.backgroundTasks(trimmed);
    return started === true;
  }

  /** 停止一个后台任务；SDK 会随后发出 status 为 stopped 的 task_notification。 */
  async stopTask(id: string, taskId: string): Promise<void> {
    const trimmed = requireTaskId(taskId);
    const handle = this.queryHandle(id);
    await handle.stopTask(trimmed);
  }

  private queryHandle(id: string): Query {
    const handle = this.queries.get(id);
    if (!handle) throw new Error("对话当前没有运行中的进程");
    return handle;
  }

  /**
   * 提交一条用户消息。
   *
   * 默认「排队」：如果当前轮正在跑、等待确认，或者已有没被取走的消息，
   * 这条先留在 deferred 里，等轮末由 releaseNext() 逐条放行。interject
   * 为 true（Ctrl+Enter / 「现在发送」）时立即放行，SDK 会在当前轮里取走。
   */
  submit(id: string, prompt: RuntimePrompt, options: { interject?: boolean } = {}): void {
    if (this.shuttingDown || this.stopping.has(id)) return;
    const queued: QueuedPrompt = {
      ...prompt,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const live = this.queues.get(id);
    if (live && !live.closed) {
      const session = this.store.get(id);
      if (!session) return;
      const config = this.runConfigs.get(id);
      const agentIdle = !session.turnActive
        && !isAgentActive(session.agentState)
        && !session.pending;
      // 配置重启要等子 agent 也跑完：关掉旧 query 会把它们一起杀掉。
      const configIdle = agentIdle && !session.subagents.some((item) => item.status === "running");
      if (config && configIdle && runConfigChanged(config, session)) {
        // 配置已经改过，但旧 query 仍是旧配置：关闭它，这条消息排到 buffered，
        // 等旧 run 收尾后由 schedule() 用新配置另起一轮。
        // 登记 releasing 是 schedule() 阻止旧 run 收尾前再起一轮的唯一守卫，
        // 否则连续提交或别的 run 收尾时 schedule 会先起新 run，被旧 finally 清掉。
        this.restarting.add(id);
        this.releasing.add(id);
        live.close();
        this.recordPrompt(id, queued, true);
        const bucket = this.buffered.get(id) ?? [];
        bucket.push(queued);
        this.buffered.set(id, bucket);
        if (!this.waiting.includes(id)) this.waiting.push(id);
        this.store.markQueued(id);
        return;
      }
      if (!session.pending) this.store.beginTurn(id);
      // 空闲且没有积压时立即放行（和以前一样）；否则先排队。
      // 只看「当前轮是否真的在跑」：残留的 running 子任务不会有 result 来
      // 放行，若把它算作忙，排队消息会永远挂住并占着并发槽。
      const defer = options.interject !== true && (!agentIdle || live.size > 0);
      this.recordPrompt(id, queued, defer);
      live.push(queued, defer);
      return;
    }
    if (!this.store.get(id)) return;
    this.recordPrompt(id, queued, true);
    const bucket = this.buffered.get(id) ?? [];
    bucket.push(queued);
    this.buffered.set(id, bucket);
    if (!this.waiting.includes(id)) this.waiting.push(id);
    this.store.markQueued(id);
    this.schedule();
  }

  /**
   * 把一条 prompt 写进对话记录。排队中的消息带 queued 标记，固定显示在记录
   * 末尾，当前轮后续的输出插到它前面，不会被插在发送位置。
   *
   * 新建会话的首条消息已经由 store.create 记录、回滚重发也先写好了记录：
   * 用 uuid 去重，重复调用不会再多出一条。
   */
  private recordPrompt(id: string, prompt: QueuedPrompt, queued: boolean): void {
    const session = this.store.get(id);
    if (!session) return;
    // 新建会话的首条消息、回滚重发都已经先写好了记录：找到原条目就行。
    const existing = prompt.uuid
      ? session.messages.find((item) => item.role === "user" && item.sdkUuid === prompt.uuid)
      : undefined;
    if (existing) {
      prompt.transcriptId = existing.id;
      return;
    }
    const before = new Set(session.messages.map((item) => item.id));
    const updated = this.store.addUserMessage(
      id,
      prompt.text,
      prompt.storedImages ?? [],
      prompt.uuid,
      { queued },
    );
    const message = updated.messages.find((item) => item.role === "user" && !before.has(item.id));
    if (message) prompt.transcriptId = message.id;
  }

  /** 这个对话还没被 agent 取走的消息，按提交顺序返回。 */
  queueSnapshot(id: string): QueueEntry[] {
    const live = this.queues.get(id);
    const items: Array<{ item: QueuedPrompt; interjecting: boolean }> = [
      ...(live ? live.snapshot().map((item) => ({ item, interjecting: !item.deferred })) : []),
      // 还没启动的会话只能按提交顺序排队，没有「插话」可言。
      ...(this.buffered.get(id) ?? []).map((item) => ({ item, interjecting: false })),
    ];
    return items.map(({ item, interjecting }) => ({
      id: item.id,
      text: clip(item.text, 200),
      images: item.images.length,
      createdAt: item.createdAt,
      ...(interjecting ? { interjecting: true } : {}),
    }));
  }

  /** 读取一条还没被取走的排队消息（含完整正文）；不存在时返回 undefined。 */
  promptEntry(id: string, promptId: string): QueuedPrompt | undefined {
    const live = this.queues.get(id);
    const fromLive = live?.snapshot().find((item) => item.id === promptId);
    if (fromLive) return fromLive;
    return (this.buffered.get(id) ?? []).find((item) => item.id === promptId);
  }

  /** 改写一条排队消息的正文；已经被 agent 取走时返回 false。 */
  editPrompt(id: string, promptId: string, text: string): boolean {
    const live = this.queues.get(id);
    if (live && live.edit(promptId, text)) return true;
    const item = (this.buffered.get(id) ?? []).find((candidate) => candidate.id === promptId);
    if (!item) return false;
    item.text = text;
    return true;
  }

  /**
   * 「现在发送」：把排队消息提前放行。正在跑的会折叠进当前轮（和插话一样）；
   * 还没启动的会话把它挪到最前面，并发槽空出来时先跑它。
   */
  promotePrompt(id: string, promptId: string): boolean {
    const live = this.queues.get(id);
    if (live && !live.closed) {
      if (live.has(promptId)) return live.promote(promptId);
      const bucket = this.buffered.get(id);
      if (!bucket) return false;
      const index = bucket.findIndex((item) => item.id === promptId);
      if (index < 0) return false;
      if (index > 0) bucket.unshift(...bucket.splice(index, 1));
      if (!this.waiting.includes(id)) this.waiting.push(id);
      this.schedule();
      return true;
    }
    const bucket = this.buffered.get(id);
    if (!bucket) return false;
    const index = bucket.findIndex((item) => item.id === promptId);
    if (index < 0) return false;
    if (index > 0) bucket.unshift(...bucket.splice(index, 1));
    if (!this.waiting.includes(id)) this.waiting.push(id);
    this.schedule();
    return true;
  }

  /** 撤回一条排队消息；正在被 agent 取走的消息不在队列里，撤回不了。 */
  cancelPrompt(id: string, promptId: string): boolean {
    const live = this.queues.get(id);
    if (live && live.remove(promptId)) return true;
    const bucket = this.buffered.get(id);
    if (!bucket) return false;
    const index = bucket.findIndex((item) => item.id === promptId);
    if (index < 0) return false;
    bucket.splice(index, 1);
    if (bucket.length === 0) {
      this.buffered.delete(id);
      // 无条件清掉等待项：此时 live 队列可能已关闭但仍留在 Map 里，
      // 而 buffered 与 live 的消息不会同时存在，不能拿 queues.has(id) 判断。
      this.waiting = this.waiting.filter((item) => item !== id);
    }
    // 队列已经清空：同步清掉 Store 的排队标记，否则会话会一直显示“排队”。
    // cancelQueued 自己会守 turnActive，不会误清正在跑的轮次。
    if (this.queueSnapshot(id).length === 0) {
      const session = this.store.get(id);
      if (session && !session.turnActive) this.store.cancelQueued(id);
    }
    return true;
  }

  answer(id: string, requestId: string, approval: Approval): void {
    const session = this.store.require(id);
    if (!session.pending || session.pending.requestId !== requestId) {
      throw new Error("没有等待中的确认");
    }
    const waiter = this.waiters.get(id);
    if (!waiter || waiter.requestId !== requestId) throw new Error("没有等待中的确认");
    this.waiters.delete(id);
    this.store.clearPending(id);
    waiter.resolve(approval);
  }

  /**
   * 停止一个会话：清理排队状态并中止这一轮，然后等待它的 start() 真正收尾。
   * 删除会话必须先 await 它，否则 worktree 会被正在退出的进程继续使用。
   */
  async stop(id: string): Promise<void> {
    this.stopping.add(id);
    this.waiting = this.waiting.filter((item) => item !== id);
    this.buffered.delete(id);
    this.releasing.add(id);
    this.aborters.get(id)?.abort();
    this.queues.get(id)?.close();
    this.rejectWaiter(id, new Error("已停止"));
    this.markStopped(id);
    // 队列里的消息随停止一起作废；清掉排队标记，否则后续输出会一直插到
    // 这些不会执行的消息前面。
    this.store.clearQueuedMessages(id);
    let timedOut = false;
    try {
      const run = this.runs.get(id);
      if (run) {
        // SDK 卡死时不能让 DELETE/stop 永久悬挂。
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            console.error(`[runtime] 停止 ${id} 超时（30 秒），继续清理`);
            resolve();
          }, STOP_TIMEOUT_MS);
        });
        try {
          await Promise.race([
            run.catch((error) => {
              console.error(`[runtime] 停止 ${id} 时 run 失败:`, error);
            }),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (timedOut) {
          // 僵尸 run 可能永不结束：释放并发槽，但登记 zombie + 保留 releasing，
          // 防止它在自己的 finally 之前被再次启动。僵尸的 finally 会清除两者。
          this.zombies.add(id);
          if (this.runs.get(id) === run) this.runs.delete(id);
          this.active.delete(id);
          this.aborters.delete(id);
          this.queues.delete(id);
        }
      }
    } finally {
      // start() 的 finally 通常会做这些清理；没有在跑的会话（只在队列里）由这里兜底。
      // 有 zombie 时保留 releasing，等僵尸 run 自己收尾。
      if (!this.active.has(id) && !this.zombies.has(id)) {
        this.releasing.delete(id);
        this.aborters.delete(id);
        this.queues.delete(id);
      }
      this.stopping.delete(id);
    }
  }

  /**
   * 只给仍在推进的会话记“已停止”。
   *
   * SDK 的一轮结束后 query 仍开着等待下一条消息，此时用户再点停止（或服务
   * 关闭/释放并发槽）只是关掉空闲进程；这一轮其实已经成功落定，不能把
   * “本轮完成”改写成“已停止”，否则会提示继续、列表也显示成停止。
   */
  private markStopped(id: string): void {
    const session = this.store.get(id);
    if (session && isActivePhase(session.phase)) this.store.stop(id, "已停止");
  }

  /** 删除会话时清掉它记住的放行，避免同 id 复用后继承旧授权。 */
  forgetApprovals(id: string): void {
    clearRemembered(this.remembered, id);
  }

  /** 收到退出信号后立即停止接收新工作，具体清理由 shutdown() 完成。 */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** 进程退出前的收尾：中止全部会话、关闭队列、拒绝等待者，然后落盘。 */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.waiting = [];
    this.buffered.clear();
    this.remembered.clear();
    for (const queue of this.queues.values()) queue.close();
    for (const abort of this.aborters.values()) abort.abort();
    // 标题总结也有一支独立的 SDK 子进程；不中止会拖住进程退出。
    for (const abort of this.titleAborts.values()) abort.abort();
    for (const id of [...this.waiters.keys()]) this.rejectWaiter(id, new Error("服务正在退出"));
    // 等所有在跑的 start() 收尾（它们会按 abort 状态调用 store.stop 或 store.fail 结束进行中的轮次）。
    await Promise.allSettled([...this.runs.values(), ...this.titleJobs.values()]);
    // flush() 由并行的 store 改动提供；尚未合并时跳过，保证这里仍可独立编译。
    const store = this.store as Store & { flush?: () => Promise<void> };
    if (typeof store.flush === "function") await store.flush();
  }

  private schedule(): void {
    if (this.shuttingDown) return;
    this.releaseIdle();
    const queued = this.waiting;
    this.waiting = [];
    for (const id of queued) {
      if (this.active.size >= this.maxConcurrent) {
        this.waiting.push(id);
        continue;
      }
      if (!this.store.get(id) || this.stopping.has(id)) {
        this.buffered.delete(id);
        continue;
      }
      // 上一轮还在收尾的会话不能立刻再起一轮，否则新队列会被旧 finally 清掉；
      // 等它的 finally 再调用一次 schedule()。
      if (this.releasing.has(id)) {
        this.waiting.push(id);
        continue;
      }
      // 缓冲已空时不要启动一次空 run 占住并发槽。
      if ((this.buffered.get(id)?.length ?? 0) === 0) continue;
      this.startRun(id);
    }
  }

  private startRun(id: string): void {
    const run = this.start(id);
    this.runs.set(id, run);
    void run.then(
      () => {
        if (this.runs.get(id) === run) this.runs.delete(id);
      },
      (error) => {
        console.error(`[runtime] 对话 ${id} 的 run 异常结束:`, error);
        if (this.runs.get(id) === run) this.runs.delete(id);
      },
    );
  }

  private async start(id: string): Promise<void> {
    const starting = this.store.get(id);
    if (!starting) {
      this.buffered.delete(id);
      return;
    }
    // 项目目录被改名/删掉后 SDK 进程起不来。在消费队列前落定这一轮：runSdk 里
    // 抛出会把没被消费的消息重新排队，形成无间隔的无限重试。fake 模式不启动
    // 进程，不需要目录存在。
    const dirProblem = this.deps.fake ? undefined : sessionDirProblem(starting);
    if (dirProblem) {
      this.buffered.delete(id);
      this.store.fail(id, dirProblem);
      return;
    }
    this.active.add(id);
    // 真正新起一次 run：丢弃上一轮 run 里已被消费、但没等到 result 的延迟工作流选择。
    this.store.resetDeferredWorkflows(id);
    // 记下这一轮 query 启动时的配置；轮间配置变化时用它判断是否需要重启。
    this.runConfigs.set(id, {
      providerId: starting.providerId,
      model: starting.model,
      effort: starting.effort,
      ...(this.deps.skills ? { skillsVersion: this.deps.skills.version() } : {}),
    });
    const queue = new PromptQueue(() => {
      // 已经被标记为待重启就必须重启：即使用户又把配置改回原值，
      // 旧 generator 也不能继续消费，否则 releasing 会一直挡着 buffered 消息。
      if (this.restarting.has(id)) return true;
      const current = this.store.get(id);
      const config = this.runConfigs.get(id);
      if (!current || !config) return false;
      const skillsChanged = this.deps.skills !== undefined
        && config.skillsVersion !== this.deps.skills.version();
      if (!runConfigChanged(config, current) && !skillsChanged) return false;
      this.restarting.add(id);
      return true;
    }, (item, skill) => {
      // 消息真正开始执行时才切换当前轮的工作流；排队期间不能提前生效。
      // 回滚截断点由 applySdkMessage 在 user 回显时记录（真实/fake 走同一路径）。
      if (this.store.get(id)) {
        // agent 已经取走：去掉排队标记，后面的输出才会排到这条消息之后。
        if (item.transcriptId) this.store.clearQueuedMessage(id, item.transcriptId);
        this.store.setWorkflow(id, skill);
      }
    });
    this.queues.set(id, queue);
    const buffered = this.buffered.get(id) ?? [];
    this.buffered.delete(id);
    // 第一条立即开跑；同一批里后面提交的按排队处理，逐轮放行，避免被 SDK
    // 合并进同一轮。
    buffered.forEach((prompt, index) => queue.push(prompt, index > 0));
    const abort = new AbortController();
    this.aborters.set(id, abort);
    try {
      if (!this.store.require(id).pending) this.store.beginTurn(id);
      if (this.deps.fake) await this.runFake(id, queue, abort.signal);
      else await this.runSdk(id, queue, abort.signal);
      const session = this.store.get(id);
      if (abort.signal.aborted) this.markStopped(id);
      else if (session && (session.turnActive || isAgentActive(session.agentState)) && !this.releasing.has(id)) {
        // 因配置变化而重启时，结果消息可能还没落定；用 stop 收尾避免永久 running。
        if (this.restarting.has(id)) this.store.stop(id, "已切换配置，请继续");
        else this.store.fail(id, "对话进程已结束");
      }
    } catch (error) {
      // 配置切换/释放并发槽时会主动关闭 query，这里通常只是正常的关闭错误；
      // 仍记录原始错误，避免重启失败被静默吞掉。
      if (this.restarting.has(id)) {
        console.error(`[runtime] 配置切换重启 ${id} 时 query 结束:`, error);
      }
      if (abort.signal.aborted || this.releasing.has(id)) this.markStopped(id);
      else this.store.fail(id, clip(redact(errorText(error), this.deps.secrets()), 500));
    } finally {
      // query 进程结束（releaseIdle/配置切换/异常/用户停止）时后台 shell 也随之死亡，
      // 不能把 store 里的任务永远留在 running。用户 stop 已先收敛过，这里幂等。
      this.store.stopBackgroundTasks(id, "对话进程已结束");
      this.restarting.delete(id);
      this.runConfigs.delete(id);
      const leftover = queue.drain();
      this.active.delete(id);
      this.queues.delete(id);
      this.aborters.delete(id);
      this.releasing.delete(id);
      this.zombies.delete(id);
      queue.close();
      this.rejectWaiter(id, new Error("对话进程已结束"));
      if (leftover.length > 0 && !abort.signal.aborted) {
        // 重启前剩下的消息在前，重启后新提交的消息在后，保持提交顺序。
        this.buffered.set(id, [...leftover, ...(this.buffered.get(id) ?? [])]);
        if (!this.waiting.includes(id)) this.waiting.push(id);
        // 因并发槽已满暂时起不来时，会话应显示“排队”而不是已停止。
        if (this.store.get(id)) this.store.markQueued(id);
      }
      this.schedule();
    }
  }

  private async runSdk(id: string, queue: PromptQueue, signal: AbortSignal): Promise<void> {
    const session = this.store.require(id);
    const permission = this.deps.permission(session.projectId);
    const { apiKey, baseUrl } = this.deps.credential(session.providerId);
    const connection = claudeConnection(baseUrl, session.model);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let stderrTail = "";
    const options: Options = {
      cwd: session.cwd,
      model: connection.model,
      effort: session.effort,
      permissionMode: permission,
      ...(permission === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      agentProgressSummaries: true,
      persistSession: true,
      includePartialMessages: true,
      // 子 agent 的正文和思考默认不下发（只有工具调用/结果），CLI 也不会给它们
      // 流式增量；开启后按完整消息转发，服务端才能把子 agent 的输出计入顶栏速度。
      forwardSubagentText: true,
      // CLI 默认不回显 stdin 的 user 消息，必须显式开启：回滚/分叉的 forkPoint
      // 依赖回显里的 uuid 和回显前的 chain 指针（见 status.applySdkMessage）。
      extraArgs: { "replay-user-messages": null },
      // 开启文件检查点，Query.rewindFiles 才能恢复文件。
      enableFileCheckpointing: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: APPEND_PROMPT,
      },
      abortController,
      env: claudeEnv(process.env, apiKey, connection),
      stderr: (data) => {
        stderrTail = `${stderrTail}${data}`.slice(-2000);
      },
      canUseTool: async (toolName, input, toolOptions) => this.allowTool(id, toolName, input, toolOptions),
    };
    // worktree 和 isolated 会话的 cwd 都在项目目录之外；项目级 .claude/MCP 仍从主目录读。
    if (session.projectPath !== session.cwd) {
      options.projectConfigRoot = session.projectPath;
    }
    // 有技能被停用时显式传入启用列表；没有停用项时不设置，保留 SDK 自己的默认行为。
    if (this.deps.skills) {
      const enabled = this.deps.skills.filter(session.projectId);
      if (enabled !== undefined) options.skills = enabled;
    }
    // 回滚到最开始要新建 SDK 会话；其余沿用 sessionId/resume 的既有语义。
    const mode = sdkStartMode(session);
    if (mode.kind === "new") options.sessionId = mode.id;
    else options.resume = mode.id;
    let stream: Query | undefined;
    try {
      stream = query({ prompt: queue.messages(), options });
      // 保留句柄供后台任务控制请求使用；run 结束后再清理。
      this.queries.set(id, stream);
      this.checkpointed.add(id);
      for await (const message of stream) {
        if (this.releasing.has(id)) break;
        const applied = this.store.apply(id, message as SdkMessage);
        const finished = applied && (message as SdkMessage).type === "result";
        // 首个成功轮次结束时给会话生成标题；放在放行排队消息之前，
        // 避免 beginTurn 把这一轮的成功状态带进下一轮。
        if (finished) this.maybeSummarizeTitle(id);
        // 一轮结束：放行下一条排队消息。SDK 正等在这里读下一条输入，
        // wake 之后它会另起一轮，而不是和上一条合并。result 已把会话落定成
        // 完成/失败，这里马上把新一轮标成进行中，避免队列积压时闪一下“已完成”。
        // 重复投递的 result（uuid 去重命中）不能再放行一次。
        if (
          finished
          && queue.releaseNext()
          && this.store.get(id)
        ) {
          this.store.beginTurn(id);
        }
        this.releaseIdle();
      }
    } catch (error) {
      const detail = errorText(error);
      if (!detail && stderrTail) throw new Error(redact(stderrTail, apiKey));
      throw error;
    } finally {
      // 只有当前 Map 里仍是本轮句柄时才删除，避免清了重启后新 run 的句柄。
      if (stream && this.queries.get(id) === stream) this.queries.delete(id);
      // checkpointing 随本轮 query 一起失效：进程没了就恢复不了文件。
      this.checkpointed.delete(id);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 首个成功轮次结束后，把会话标题从占位词换成 agent 总结出的文案。
   *
   * 只发起一次后台任务，不阻塞 agent 循环；生成失败不改变会话状态，
   * titlePending 仍在，下一次成功轮次会再试。用户在这期间手动改名时，
   * setGeneratedTitle 会因为 titlePending 已清除而忽略总结结果。
   */
  private maybeSummarizeTitle(id: string): void {
    const summarize = this.deps.titleSummarizer;
    if (!summarize || this.shuttingDown || this.titleJobs.has(id)) return;
    const session = this.store.get(id);
    if (!session || session.titlePending !== true || session.lastResult !== "success") return;
    const input = titleInput(session);
    if (!input) return;
    const abort = new AbortController();
    this.titleAborts.set(id, abort);
    // 用 then 延后到下一微任务再跑，保证先把 job 放进 map，再执行可能同步
    // 抛错的总结函数；否则 finally 可能先于 set 清掉登记项。
    const job = Promise.resolve().then(async () => {
      try {
        const raw = await summarize({ ...input, signal: abort.signal });
        const title = raw ? cleanGeneratedTitle(raw) : undefined;
        if (title && !abort.signal.aborted) this.store.setGeneratedTitle(id, title);
      } catch (error) {
        if (!abort.signal.aborted) {
          console.warn(
            `[runtime] 对话 ${id} 生成标题失败:`,
            redact(errorText(error), this.deps.secrets()),
          );
        }
      } finally {
        if (this.titleAborts.get(id) === abort) this.titleAborts.delete(id);
        this.titleJobs.delete(id);
      }
    });
    this.titleJobs.set(id, job);
  }

  private async allowTool(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    toolOptions: { signal: AbortSignal; blockedPath?: string },
  ): Promise<PermissionResult> {
    const session = this.store.require(id);
    const permission = this.deps.permission(session.projectId);
    const decision = decideTool({
      toolName,
      input,
      cwd: session.cwd,
      blockedPath: toolOptions.blockedPath,
      permission,
    });
    if (decision === "allow") return { behavior: "allow" };
    if (decision === "deny") return { behavior: "deny", message: denyMessage(permission) };
    // 用户之前勾选过「本对话记住」：同一工具的确认直接放行。
    // AskUserQuestion 永不拦截，提问必须由用户回答。
    if (isRemembered(this.remembered.get(id), toolName)) return { behavior: "allow" };
    const requestId = randomUUID();
    const pending: PendingRequest = {
      requestId,
      kind: toolName === "AskUserQuestion" ? "question" : "permission",
      toolName,
      inputPreview: clip(safeJson(input), 2000),
      blockedPath: toolOptions.blockedPath,
      questions: toolName === "AskUserQuestion" ? parseQuestions(input) : undefined,
      expiresAt: pendingExpiresAt(Date.now(), this.approvalTimeoutMs),
    };
    try {
      const approval = await this.waitApproval(id, pending, toolOptions.signal);
      if (approval.behavior === "deny") return { behavior: "deny", message: "用户拒绝了这次操作" };
      if (approval.remember === true && toolName !== "AskUserQuestion") {
        const tools = this.remembered.get(id) ?? new Set<string>();
        tools.add(toolName);
        this.remembered.set(id, tools);
      }
      if (toolName === "AskUserQuestion") {
        return { behavior: "allow", updatedInput: { ...input, answers: approval.answers ?? {} } };
      }
      return { behavior: "allow" };
    } catch (error) {
      if (error instanceof ApprovalTimeoutError) {
        return { behavior: "deny", message: "确认超时，已自动拒绝这次操作" };
      }
      return { behavior: "deny", message: "已停止" };
    }
  }

  private waitApproval(id: string, pending: PendingRequest, signal: AbortSignal): Promise<Approval> {
    this.rejectWaiter(id, new Error("被新的确认请求替换"));
    this.store.setPending(id, pending);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        finish();
      };
      const onAbort = () => {
        this.waiters.delete(id);
        this.store.clearPending(id);
        settle(() => reject(new Error("已停止")));
      };
      // 用户长时间不回应时自动拒绝，清掉 pending，避免整轮永远挂着。
      const timer = setTimeout(() => {
        if (this.waiters.get(id)?.requestId !== pending.requestId) return;
        this.waiters.delete(id);
        this.store.clearPending(id);
        settle(() => reject(new ApprovalTimeoutError("确认超时")));
      }, this.approvalTimeoutMs);
      timer.unref();
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(id, {
        requestId: pending.requestId,
        resolve: (approval) => settle(() => resolve(approval)),
        reject: (error) => {
          this.store.clearPending(id);
          settle(() => reject(error));
        },
      });
    });
  }

  private rejectWaiter(id: string, error: Error): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.reject(error);
  }

  private releaseIdle(): void {
    if (this.waiting.length === 0) return;
    if (this.active.size < this.maxConcurrent) return;
    for (const id of this.active) {
      if (this.releasing.has(id)) continue;
      const session = this.store.get(id);
      const queue = this.queues.get(id);
      if (!session || !queue || queue.closed) continue;
      if (session.turnActive || isAgentActive(session.agentState) || session.pending || queue.size > 0) continue;
      if (session.subagents.some((item) => item.status === "running")) continue;
      // 后台下载还在跑：释放会关掉 query 进程并杀掉它，客户端就没得看了。
      if (session.backgroundTasks?.some((item) => item.status === "running")) continue;
      this.releasing.add(id);
      queue.close();
      return;
    }
  }

  private async runFake(id: string, queue: PromptQueue, signal: AbortSignal): Promise<void> {
    for await (const message of queue.messages()) {
      if (signal.aborted || this.releasing.has(id)) return;
      const content = message.message.content;
      // 先把 user 回显写进 transcript，让回滚截断点在 applySdkMessage 里落定。
      // 真实的 init 通常先于 user 回显，这里假 init 由 playFake 稍后发出；顺序
      // 只影响展示，对 forkPoint 无影响（取的都是回显前的 lastSdkUuid）。
      if (message.uuid) {
        this.store.apply(id, {
          type: "user",
          uuid: message.uuid,
          parent_tool_use_id: null,
          message: { role: "user", content },
        });
      }
      const text = typeof content === "string"
        ? content
        : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      const workflow = /请先调用 (prl|ser|plan) skill/.exec(text)?.[1] as WorkflowSkill | undefined;
      if (workflow) await this.playFakeWorkflow(id, workflow, signal);
      else await this.playFake(id, text, signal);
      // 假运行里的 playFake/playFakeWorkflow 已经发出 result，视为一轮结束。
      // 被停止时 playFake 会提前返回且没有 result，不能在这里复活会话。
      if (!signal.aborted && !this.releasing.has(id)) this.maybeSummarizeTitle(id);
      if (
        !signal.aborted
        && !this.releasing.has(id)
        && queue.releaseNext()
        && this.store.get(id)
      ) {
        this.store.beginTurn(id);
      }
      this.releaseIdle();
    }
  }

  /**
   * prl/ser/plan 的假运行：发出带 `[wf:...]` 标签的子任务事件，
   * 让底部进度条在没接模型时也能看到多单元、开发/评审和轮次。
   */
  private async playFakeWorkflow(id: string, skill: WorkflowSkill, signal: AbortSignal): Promise<void> {
    this.store.apply(id, {
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: `fake-${id}`,
    });
    if (skill === "prl") {
      await this.fakeParallelUnits(id, skill, ["登录接口", "会话存储"], signal);
    } else if (skill === "ser") {
      for (const [index, name] of ["登录接口", "会话存储"].entries()) {
        if (signal.aborted) return;
        await this.fakeUnitPair(id, skill, index + 1, 2, name, signal);
      }
    } else {
      await this.fakeUnitPair(id, skill, 1, 1, "开发计划", signal);
    }
    if (signal.aborted) return;
    this.store.apply(id, {
      type: "result",
      subtype: "success",
      uuid: randomUUID(),
      result: `${skill} 工作流完成。这是本地假运行，没有调用模型。`,
      is_error: false,
    });
  }

  private async fakeParallelUnits(
    id: string,
    skill: WorkflowSkill,
    names: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const total = names.length;
    const devs = names.map((name, index) => ({
      name,
      taskId: this.fakeTaskStart(id, skill, index + 1, total, "dev", name),
    }));
    this.fakeAssistant(id, "先并行推进各单元，再统一评审。");
    await delay(160, signal);
    if (signal.aborted) return;
    for (const dev of devs) this.fakeTaskProgress(id, dev.taskId, `正在处理${dev.name}`, "Edit");
    await delay(160, signal);
    if (signal.aborted) return;
    for (const dev of devs) this.fakeTaskDone(id, dev.taskId, `${dev.name} 开发完成`);
    const reviews = names.map((name, index) => ({
      name,
      taskId: this.fakeTaskStart(id, skill, index + 1, total, "review", name),
    }));
    await delay(160, signal);
    if (signal.aborted) return;
    for (const review of reviews) this.fakeTaskProgress(id, review.taskId, `评审${review.name}`, "Read");
    await delay(160, signal);
    if (signal.aborted) return;
    for (const review of reviews) this.fakeTaskDone(id, review.taskId, `${review.name} 评审通过`);
  }

  private async fakeUnitPair(
    id: string,
    skill: WorkflowSkill,
    unit: number,
    total: number,
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    const dev = this.fakeTaskStart(id, skill, unit, total, "dev", name);
    this.fakeAssistant(id, `开始处理单元 ${unit}：${name}`);
    await delay(120, signal);
    if (signal.aborted) return;
    // plan 只读；不要显示 Edit，避免和“只做计划、不改代码”矛盾。
    this.fakeTaskProgress(id, dev, `正在处理${name}`, skill === "plan" ? "Read" : "Edit");
    await delay(120, signal);
    if (signal.aborted) return;
    this.fakeTaskDone(id, dev, `${name} 开发完成`);
    const review = this.fakeTaskStart(id, skill, unit, total, "review", name);
    await delay(120, signal);
    if (signal.aborted) return;
    this.fakeTaskProgress(id, review, `评审${name}`, "Read");
    await delay(120, signal);
    if (signal.aborted) return;
    this.fakeTaskDone(id, review, `${name} 评审通过`);
  }

  private fakeTaskStart(
    id: string,
    skill: WorkflowSkill,
    unit: number,
    total: number,
    role: "dev" | "review",
    name: string,
  ): string {
    const taskId = randomUUID();
    this.store.apply(id, {
      type: "system",
      subtype: "task_started",
      uuid: randomUUID(),
      task_id: taskId,
      task_type: "local_agent",
      description: `[wf:${skill}:${unit}/${total}:${role}] ${name}`,
    });
    return taskId;
  }

  private fakeTaskProgress(id: string, taskId: string, summary: string, tool: string): void {
    this.store.apply(id, {
      type: "system",
      subtype: "task_progress",
      uuid: randomUUID(),
      task_id: taskId,
      summary,
      last_tool_name: tool,
    });
  }

  private fakeTaskDone(id: string, taskId: string, summary: string): void {
    this.store.apply(id, {
      type: "system",
      subtype: "task_notification",
      uuid: randomUUID(),
      task_id: taskId,
      status: "completed",
      summary,
    });
  }

  private fakeAssistant(id: string, text: string): void {
    this.store.apply(id, {
      type: "assistant",
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  }

  private async playFake(id: string, text: string, signal: AbortSignal): Promise<void> {
    const fail = text.includes("失败");
    const slow = text.includes("慢");
    const taskId = randomUUID();
    this.store.apply(id, {
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: `fake-${id}`,
    });
    this.store.apply(id, {
      type: "system",
      subtype: "task_started",
      uuid: randomUUID(),
      task_id: taskId,
      task_type: "local_agent",
      description: fail ? "尝试一个会失败的修改" : "查看项目结构",
    });
    this.store.apply(id, {
      type: "assistant",
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: fail ? "这个方向走不通。" : "先看结构，再改一处独立的部分。" }],
      },
    });
    if (slow) await delay(1200, signal);
    if (signal.aborted) return;
    this.store.apply(id, {
      type: "system",
      subtype: "task_progress",
      uuid: randomUUID(),
      task_id: taskId,
      summary: fail ? "编译没有通过" : "已经定位到入口",
      last_tool_name: "Read",
    });
    this.store.apply(id, {
      type: "system",
      subtype: "task_notification",
      uuid: randomUUID(),
      task_id: taskId,
      status: fail ? "failed" : "completed",
      summary: fail ? "子任务失败" : "子任务完成",
    });
    this.store.apply(id, fail
      ? {
        type: "result",
        subtype: "error_during_execution",
        uuid: randomUUID(),
        errors: ["子任务失败后本轮结束"],
      }
      : {
        type: "result",
        subtype: "success",
        uuid: randomUUID(),
        result: "本轮完成。这是本地假运行，没有调用模型。",
        is_error: false,
      });
  }
}

/** 读取后台任务输出的结果；字段已从 SDK 的 snake_case 归一化。 */
export interface TaskOutput {
  output: string;
  totalBytes: number;
  truncated: boolean;
}

/** 运行时存在、但 0.3.329 类型声明未列出的控制方法。 */
type QueryWithTaskOutput = Query & {
  getTaskOutput?: (taskId: string) => Promise<unknown>;
};

/** 校验并去掉任务 id 两端的空白；空值时抛出明确错误。 */
function requireTaskId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("缺少任务 id");
  return trimmed;
}

/** 把 SDK 的 getTaskOutput 响应归一化成稳定形状，缺失/非法字段按保守默认值处理。 */
export function normalizeTaskOutput(raw: unknown): TaskOutput {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const output = typeof record.output === "string" ? record.output : "";
  const bytes = record.total_bytes;
  const totalBytes = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  return {
    output,
    totalBytes,
    truncated: record.truncated === true,
  };
}

function parseQuestions(input: Record<string, unknown>): PendingQuestion[] {
  if (!Array.isArray(input.questions)) return [];
  const questions: PendingQuestion[] = [];
  for (const item of input.questions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question : "";
    if (!question) continue;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const row = option as Record<string, unknown>;
        if (typeof row.label !== "string" || !row.label) return [];
        return [{ label: row.label, description: typeof row.description === "string" ? row.description : undefined }];
      })
      : [];
    questions.push({
      question,
      header: typeof record.header === "string" ? record.header : undefined,
      options,
      multiSelect: Boolean(record.multiSelect),
    });
  }
  return questions;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 这个工具是否已经被「本对话记住」放行。
 * AskUserQuestion 永远不算记住：提问必须由用户回答。
 */
export function isRemembered(remembered: Set<string> | undefined, toolName: string): boolean {
  if (toolName === "AskUserQuestion") return false;
  return remembered?.has(toolName) ?? false;
}

/** 删除某个会话记住的放行；返回是否确实清掉了记录。 */
export function clearRemembered(remembered: Map<string, Set<string>>, id: string): boolean {
  return remembered.delete(id);
}

export function redact(text: string, secret: string | readonly string[]): string {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((item) => item.trim().length >= 8);
  let redacted = text;
  for (const item of secrets) {
    if (!redacted.includes(item)) continue;
    redacted = redacted.split(item).join("[redacted]");
  }
  return redacted;
}

/** 本次确认会在什么时候被服务端自动拒绝；前端据此显示倒计时。 */
export function pendingExpiresAt(now: number, timeoutMs: number): string {
  return new Date(now + timeoutMs).toISOString();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
