import { ROOT_FORK_POINT } from "./session-rewind.js";
import type {
  BackgroundTask,
  Phase,
  SessionCore,
  Subagent,
  SubagentStatus,
  TokenUsage,
  TranscriptItem,
  WorkflowRun,
  WorkflowSkill,
} from "./types.js";

/** SDK 下发的原始用量，字段为 snake_case，且可能缺失或类型异常。 */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** task_progress / task_notification 报告的子任务累计用量。 */
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

export interface SdkMessage {
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  /** 消息产生时间（assistant / result 消息都可能带）。 */
  timestamp?: string;
  /** result 消息的整体用量。 */
  usage?: RawUsage;
  task_id?: string;
  task_type?: string;
  run_id?: string;
  /** 触发任务的 tool_use id，用于把“转到后台”关联回工具行。 */
  tool_use_id?: string;
  description?: string;
  summary?: string;
  status?: string;
  /** task_started：任务是否已在后台注册（false 表示前台阻塞执行）。 */
  is_backgrounded?: boolean;
  /** task_notification：任务输出文件的路径。 */
  output_file?: string;
  ambient?: boolean;
  /** background_tasks_changed：当前存活后台任务的 REPLACE 快照。 */
  tasks?: Array<{
    task_id: string;
    run_id?: string;
    task_type: string;
    description?: string;
    parent_task_id?: string;
    ambient?: boolean;
  }>;
  /** system/session_state_changed 的会话状态：idle / running / requires_action。 */
  state?: string;
  result?: string;
  errors?: string[];
  is_error?: boolean;
  error?: {
    message?: string;
    status?: number;
  };
  parent_tool_use_id?: string | null;
  agent_id?: string;
  event?: {
    type?: string;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  };
  last_tool_name?: string;
  message?: {
    role?: string;
    content?: unknown;
    /** assistant 消息的用量。 */
    usage?: RawUsage;
  };
  patch?: {
    status?: string;
    description?: string;
    /** 任务结束时间（epoch 毫秒）；当前结构只用于透传，不参与落定。 */
    end_time?: number;
    /** 暂停累计时长（毫秒）。 */
    total_paused_ms?: number;
    error?: string;
    /** 任务是否已转入后台（Ctrl+B / 前台工具调用转后台）。 */
    is_backgrounded?: boolean;
  };
}

const SUBAGENT_TASKS = new Set(["local_agent", "subagent"]);

/** 消息末尾允许跟随的标点/引号/括号。 */
const WORKFLOW_TAIL = /[。.!！?？,，;；、：:）)】」』'"”’\s]+$/u;
/** 末尾的独立 token：前面不能紧邻拉丁字母/数字/下划线（避免 parser、user 这类词内子串）。 */
const WORKFLOW_TAIL_TOKEN = /(?:^|[^A-Za-z0-9_])(dis-prl|prl-role|prl|ser|plan|discuss)$/i;
/** 消息开头的斜杠命令 /prl、/ser、/plan、/discuss、/dis-prl、/prl-role。 */
const WORKFLOW_SLASH_COMMAND = /^\/(dis-prl|prl-role|prl|ser|plan|discuss)(?=$|[^A-Za-z0-9_])/i;

/**
 * 识别消息里的 prl/ser/plan/discuss/dis-prl/prl-role 工作流。
 *
 * 支持末尾独立 token（可带标点、大小写不敏感、中文紧邻也可以，例如「实现prl」）
 * 和消息开头的 `/prl` 斜杠命令；同时出现多个时取位置最靠后的那个。
 * dis-prl 和 prl-role 必须排在 prl 前面，否则前缀会抢先匹配。
 */
export function detectWorkflowSkill(text: string): WorkflowSkill | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tail = trimmed.replace(WORKFLOW_TAIL, "");
  let lastIndex = -1;
  let skill: WorkflowSkill | null = null;
  const slash = WORKFLOW_SLASH_COMMAND.exec(trimmed);
  if (slash) {
    lastIndex = 0;
    skill = slash[1].toLowerCase() as WorkflowSkill;
  }
  const match = WORKFLOW_TAIL_TOKEN.exec(tail);
  if (match) {
    // 用 token 实际开始的位置比较，保证「最后一个生效」。
    const index = match.index + match[0].length - match[1].length;
    const candidate = match[1].toLowerCase() as WorkflowSkill;
    // plan 和英文单词重合，避免把 "the plan" / "review the plan" 误判成工作流；
    // "做这个 plan"、中文紧邻、标点紧邻仍然识别。
    if (candidate !== "plan" || !latinWordBefore(tail, index)) {
      if (index >= lastIndex) {
        lastIndex = index;
        skill = candidate;
      }
    }
  }
  return skill;
}

/** token 前面紧邻的（跳过空白后）是不是一个拉丁单词；用于排除 "the plan"。 */
function latinWordBefore(text: string, index: number): boolean {
  const prefix = text.slice(0, index).trimEnd();
  return /[A-Za-z0-9_]$/.test(prefix);
}

/** 新建会话时的工作流：显式选择优先，其次看正文末尾 token。 */
export function nextWorkflow(
  skill: WorkflowSkill | undefined,
  text: string,
  now: string,
): WorkflowRun | undefined {
  const chosen = skill ?? detectWorkflowSkill(text);
  return chosen ? { skill: chosen, startedAt: now } : undefined;
}

/** 单条消息正文上限；流式增量在写入时就会截断，避免内存随连接时长无限增长。 */
export const MAX_MESSAGE_TEXT = 200_000;

/** 每个会话保留的消息条数上限。 */
export const MAX_TRANSCRIPT_MESSAGES = 5_000;

/** 每个会话消息序列化后的总字节上限（按 UTF-8 计）。 */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export interface TranscriptLimits {
  transcriptBytes: number;
  transcriptMessages: number;
  messageText: number;
}

/** 默认上限；生产启动时由 index.ts 用配置覆盖。 */
export const DEFAULT_TRANSCRIPT_LIMITS: TranscriptLimits = {
  transcriptBytes: MAX_TRANSCRIPT_BYTES,
  transcriptMessages: MAX_TRANSCRIPT_MESSAGES,
  messageText: MAX_MESSAGE_TEXT,
};

let limits: TranscriptLimits = { ...DEFAULT_TRANSCRIPT_LIMITS };

/**
 * 注入当前生效的上限。不传的字段回到默认值，方便测试在结束后恢复默认行为。
 * 只接受 transcript 的三项；必须在加载会话之前调用，加载/恢复过程也会用新上限。
 */
export function configureLimits(next?: Partial<TranscriptLimits>): void {
  limits = {
    transcriptBytes: next?.transcriptBytes ?? DEFAULT_TRANSCRIPT_LIMITS.transcriptBytes,
    transcriptMessages: next?.transcriptMessages ?? DEFAULT_TRANSCRIPT_LIMITS.transcriptMessages,
    messageText: next?.messageText ?? DEFAULT_TRANSCRIPT_LIMITS.messageText,
  };
}

/** 当前生效的上限（只读快照，测试和观测用）。 */
export function currentLimits(): TranscriptLimits {
  return { ...limits };
}

/** 持久化的 seen 数组上限，与旧格式保持一致。 */
const MAX_SEEN_IDS = 2_000;

/**
 * 截断过长的消息正文，保留开头内容并在末尾加一条说明。
 * 不压缩空白，避免破坏代码/日志等原始排版。
 */
export function capMessageText(text: string, max = limits.messageText): string {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  const note = `\n\n…[内容过长，已截断；原 ${text.length} 字符]`;
  let cut = max - note.length;
  if (cut < 1) return text.slice(0, max);
  // 不要从代理对中间切开。
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}${note}`;
}

/**
 * 每条消息序列化后的字节数按对象缓存。消息对象在本模块内是不可变替换的
 *（流式增量也会先复制再改），所以对象一旦创建，其序列化结果就不会再变；
 * 被替换后旧对象自然从 WeakMap 里消失，不会造成额外的失效处理。
 */
const itemByteSizes = new WeakMap<TranscriptItem, number>();

/** 已经完成裁剪、且处于上限内的数组：重复调用直接复用，不再全量扫描。 */
const compactedArrays = new WeakMap<TranscriptItem[], number>();

function itemBytes(item: TranscriptItem): number {
  const cached = itemByteSizes.get(item);
  if (cached !== undefined) return cached;
  const size = Buffer.byteLength(JSON.stringify(item), "utf8");
  itemByteSizes.set(item, size);
  return size;
}

/**
 * 执行消息条数与总字节上限。
 *
 * 策略：先丢弃最旧的非 user 消息，尽量保留用户输入与最近的内容；
 * 如果非 user 消息已经删空仍超限（用户消息本身太多或太长），再从最旧开始
 * 丢弃包括 user 在内的消息，保证硬上限，避免持久化文件无限增长。
 * 返回原数组表示没有任何改动，方便调用方避免无谓的对象分配。
 *
 * 字节数按 TranscriptItem 对象缓存：重复调用或同一条消息在不同批次里出现时
 * 不会再次 JSON.stringify 全量正文，只在真正超限时才进入删除循环。
 */
export function limitTranscript(messages: TranscriptItem[]): TranscriptItem[] {
  if (messages.length === 0) return messages;
  // 这个数组已经裁剪过且在上限内，内容不可变，直接复用。
  if (compactedArrays.get(messages) === messages.length) return messages;

  let changed = false;
  let capped: TranscriptItem[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    const text = capMessageText(item.text);
    if (text === item.text) continue;
    changed = true;
    // 替换文本后是新对象，按新对象单独计算字节数。
    if (!capped) capped = messages.slice();
    capped[index] = { ...item, text };
  }
  const items = capped ?? messages;

  let bytes = 0;
  const sizes = new Array<number>(items.length);
  for (let index = 0; index < items.length; index += 1) {
    const size = itemBytes(items[index]);
    sizes[index] = size;
    bytes += size;
  }
  let count = items.length;

  if (count <= limits.transcriptMessages && bytes <= limits.transcriptBytes) {
    const result = changed ? items : messages;
    compactedArrays.set(result, result.length);
    return result;
  }

  const dropped = new Set<number>();
  let index = 0;
  while ((count > limits.transcriptMessages || bytes > limits.transcriptBytes) && index < items.length) {
    if (items[index].role !== "user") {
      dropped.add(index);
      count -= 1;
      bytes -= sizes[index];
    }
    index += 1;
  }
  if (count > limits.transcriptMessages || bytes > limits.transcriptBytes) {
    index = 0;
    while ((count > limits.transcriptMessages || bytes > limits.transcriptBytes) && index < items.length) {
      if (!dropped.has(index)) {
        dropped.add(index);
        count -= 1;
        bytes -= sizes[index];
      }
      index += 1;
    }
  }
  if (dropped.size === 0) {
    compactedArrays.set(items, items.length);
    return items;
  }
  const result = items.filter((_, itemIndex) => !dropped.has(itemIndex));
  compactedArrays.set(result, result.length);
  return result;
}

/** 排队 / 进行中 / 等待确认：会话仍在推进，还没落定为完成、失败或停止。 */
export function isActivePhase(phase: Phase): boolean {
  return phase === "queued" || phase === "running" || phase === "needs_input";
}

/**
 * SDK 侧是否还在跑。
 *
 * streaming input 模式下每个 turn 结束时都会发一条 result，后台子 agent 的通知
 * 又会唤醒主 agent 继续下一轮；这些内部轮次不经过 beginTurn，所以只看 turnActive
 * 会把“主 agent 还在工作”误判成已结束。session_state_changed 才是权威信号：
 * idle 只在 held-back result flush、后台 agent 循环退出后才发。
 */
export function isAgentActive(agentState: SessionCore["agentState"]): boolean {
  return agentState === "running" || agentState === "requires_action";
}

/**
 * 主 agent 是否在运行，供顶栏的全局负载计数使用。
 *
 * 只认主轮/SDK 侧的活跃信号：等待确认（pending → needs_input）和仅有后台子
 * agent 在跑（主轮已结束、SDK 空闲）时主 agent 不算在运行。
 */
export function mainAgentRunning(
  state: Pick<SessionCore, "phase" | "turnActive" | "agentState">,
): boolean {
  return state.phase === "running" && (state.turnActive || isAgentActive(state.agentState));
}

/**
 * 注意：backgroundTasks（后台 shell 任务）刻意不参与 phase 计算。
 * 后台下载/长命令在跑时不应该让会话一直显示“进行中”；mainAgentRunning 同理。
 */
export function derivePhase(state: Pick<
  SessionCore,
  "pending" | "queued" | "turnActive" | "lastResult" | "subagents" | "agentState" | "discussion" | "roleRun"
>): Phase {
  if (state.pending) return "needs_input";
  const runningAgent = state.subagents.some((item) => item.status === "running");
  if (state.turnActive || isAgentActive(state.agentState) || runningAgent) return "running";
  // 讨论已经创建但还没配置参与模型：这不是排队，也不是完成。
  if (state.discussion?.phase === "setup") return "setup";
  // 角色团队已经创建但还没选好四角色：同样停在配置阶段。
  if (state.roleRun?.phase === "setup") return "setup";
  if (state.queued) return "queued";
  const subFailed = state.subagents.some((item) => item.status === "failed");
  if (state.lastResult === "error" || subFailed) return "failed";
  if (state.lastResult === "stopped") return "stopped";
  if (state.lastResult === "success") return "completed";
  return "queued";
}

export function applySdkMessage(prev: SessionCore, message: SdkMessage, seenLookup?: Set<string>): SessionCore {
  // seen 仍按数组持久化；传入 Set 时用 Set 做 O(1) 去重查询，并在追加时同步裁剪。
  const lookup = seenLookup ?? new Set(prev.seen);
  if (message.uuid && lookup.has(message.uuid)) return prev;
  // 上一条还没被 agent 取走的排队消息在末尾：本次应用产生的内容要放到它前面，
  // 否则排队消息会被后续输出甩在中间，看起来像插在发送位置。
  const hadQueuedTail = isQueuedUser(prev.messages[prev.messages.length - 1]);
  let seen = prev.seen;
  if (message.uuid) {
    seen = [...prev.seen, message.uuid];
    const overflow = seen.length - MAX_SEEN_IDS;
    if (overflow > 0) {
      for (let index = 0; index < overflow; index += 1) lookup.delete(seen[index]);
      seen = seen.slice(overflow);
    }
    lookup.add(message.uuid);
  }
  // 写时复制：只有对应分支真的会改消息/子 agent 时才复制一次数组，
  // 其余情况与 prev 共享（共享的数组保证不会被就地修改）。
  const isSubagentScoped = Boolean(message.parent_tool_use_id || message.agent_id);
  // user 消息里只有 tool_result 有用：纯文本是 SDK 回显，用户消息已由本地追加。
  const toolResults = message.type === "user" ? toolResultBlocks(message) : [];
  // result 始终可能改写/追回主对话；stream_event / assistant / 带结果的 user 只处理主对话事件。
  const touchesMessages = message.type === "result"
    || (!isSubagentScoped && (
      message.type === "stream_event"
      || message.type === "assistant"
      || (message.type === "user" && toolResults.length > 0)
    ));
  // 命中的是后台 shell 任务而不是子 agent：task_started 靠 task_type 判定，
  // task_updated / task_notification 没有 task_type，只能看 taskId 是否已被跟踪。
  const isShellTaskEvent = isBackgroundShellTask(message)
    || hasBackgroundTask(prev, message.task_id);
  const touchesSubagents = message.type === "system" && (
    message.subtype === "task_started"
    || message.subtype === "task_progress"
    || message.subtype === "task_notification"
    || message.subtype === "task_updated"
  ) && !isShellTaskEvent;
  // shell 任务只在开始和已跟踪任务的更新/通知时归并；background_tasks_changed
  // 是快照，总是可能新增条目。
  const touchesBackgroundTasks = message.type === "system" && (
    message.subtype === "background_tasks_changed"
    || (message.subtype === "task_started" && isBackgroundShellTask(message))
    || ((message.subtype === "task_updated" || message.subtype === "task_notification")
      && hasBackgroundTask(prev, message.task_id))
  );
  const state: SessionCore = {
    ...prev,
    subagents: touchesSubagents ? prev.subagents.slice() : prev.subagents,
    backgroundTasks: touchesBackgroundTasks
      ? [...(prev.backgroundTasks ?? [])]
      : prev.backgroundTasks,
    messages: touchesMessages ? prev.messages.slice() : prev.messages,
    seen,
    updatedAt: new Date().toISOString(),
  };

  if (message.type === "system" && message.subtype === "init" && message.session_id) {
    state.claudeSessionId = message.session_id;
    // 回滚到最开始等场景要求下一次运行新建 SDK 会话：init 说明新会话已经从空
    // 上下文启动，清掉标记，并让旧的 chain 指针失效（新会话没有更早上下文）。
    if (state.newSdkSession) {
      state.newSdkSession = undefined;
      state.lastSdkUuid = undefined;
    }
  }

  // 主线程 user 回显（真实 prompt，不是 tool_result）说明这条消息已进入 SDK
  // transcript。用回显前的 lastSdkUuid 作为它的回滚截断点；随后 lastSdkUuid
  // 才推进到这条消息本身。必须在 onConsume 之外做：streaming input 可能在上
  // 一轮 chain 条目回显前就取走下一条 prompt。
  if (
    message.type === "user"
    && message.uuid
    && !isSubagentScoped
    && toolResults.length === 0
  ) {
    const forkPoint = prev.lastSdkUuid ?? ROOT_FORK_POINT;
    // 这条 user 消息不触发 messages 写时复制，需要时先复制再替换条目。
    let messages: TranscriptItem[] | undefined;
    for (let index = 0; index < state.messages.length; index += 1) {
      const item = state.messages[index];
      if (item.role !== "user" || item.sdkUuid !== message.uuid || item.forkPoint !== undefined) {
        continue;
      }
      if (!messages) messages = state.messages.slice();
      messages[index] = { ...item, forkPoint };
    }
    if (messages) state.messages = messages;
  }

  // 记录主线程 chain 的最后一条 uuid，供后续 prompt 计算回滚/分叉截断点。
  // 子 agent 的条目属于 sidechain，不能混进主线程指针。
  if (
    (message.type === "assistant" || message.type === "user")
    && message.uuid
    && !isSubagentScoped
  ) {
    state.lastSdkUuid = message.uuid;
  } else if (message.type === "system" && message.subtype === "compact_boundary" && message.uuid) {
    state.lastSdkUuid = message.uuid;
  }

  if (message.type === "system" && message.subtype === "api_error") {
    const detail = apiErrorText(message);
    state.lastError = clip(detail, 500);
    state.summary = clip(detail, 160);
  }

  if (message.type === "system" && message.subtype === "session_state_changed") {
    noteSessionState(state, message);
  } else if (message.type === "system" && message.subtype === "task_started") {
    if (isBackgroundShellTask(message)) noteBackgroundTaskStart(state, message);
    else noteSubagentStart(state, message);
  } else if (message.type === "system" && message.subtype === "task_progress") {
    noteSubagentProgress(state, message);
  } else if (message.type === "system" && message.subtype === "task_notification") {
    if (hasBackgroundTask(state, message.task_id)) noteBackgroundTaskNotification(state, message);
    else noteSubagentNotification(state, message);
  } else if (message.type === "system" && message.subtype === "task_updated") {
    if (hasBackgroundTask(state, message.task_id)) noteBackgroundTaskPatch(state, message);
    else noteSubagentPatch(state, message);
  } else if (message.type === "system" && message.subtype === "background_tasks_changed") {
    noteBackgroundTasksChanged(state, message);
  } else if (message.type === "stream_event") {
    noteStream(state, message);
  } else if (message.type === "assistant") {
    noteAssistant(state, message);
  } else if (message.type === "user") {
    if (!isSubagentScoped) noteToolResults(state, toolResults, message);
  } else if (message.type === "result") {
    noteResult(state, message);
  }

  // 只有消息条数变化时才做全量上限检查：流式增量已逐条截断，避免每个 delta 都扫描整段对话。
  if (state.messages.length !== prev.messages.length || state.messages.length > limits.transcriptMessages) {
    state.messages = limitTranscript(state.messages);
  }
  // 排队消息固定排在记录末尾，本轮新增的正文/工具/结果都要在它们之前。
  if (hadQueuedTail) state.messages = hoistQueuedMessages(state.messages);
  state.phase = derivePhase(state);
  // 本轮已经落定（成功/失败/停止）：补上工作流结束时间。
  if (
    state.workflow
    && !state.workflow.endedAt
    && state.phase !== "queued"
    && state.phase !== "running"
    && state.phase !== "needs_input"
    && state.phase !== "setup"
  ) {
    state.workflow = { ...state.workflow, endedAt: state.updatedAt };
  }
  return state;
}

function isSubagentTask(message: SdkMessage): boolean {
  if (message.ambient) return false;
  // local_bash 是 shell 任务（命令），由 backgroundTasks 单独跟踪，不能当子 agent。
  if (message.task_type === "local_bash") return false;
  if (!message.task_type) return true;
  return SUBAGENT_TASKS.has(message.task_type);
}

/** 只跟踪非 ambient 的 local_bash shell 任务；其它 task_type 不进 backgroundTasks。 */
function isBackgroundShellTask(message: SdkMessage): boolean {
  return message.task_type === "local_bash" && !message.ambient;
}

/** taskId 是否已经是一个被跟踪的后台 shell 任务。 */
function hasBackgroundTask(
  state: Pick<SessionCore, "backgroundTasks">,
  taskId: string | undefined,
): boolean {
  if (!taskId) return false;
  return (state.backgroundTasks ?? []).some((item) => item.taskId === taskId);
}

function backgroundTaskIndex(state: SessionCore, taskId: string): number {
  return (state.backgroundTasks ?? []).findIndex((item) => item.taskId === taskId);
}

/** run_id 的相对顺序：SDK 约定按普通字符串比较排序，小的表示更早的 run。 */
type RunOrder = "newer" | "same" | "older" | "unknown";

/**
 * 比较 incoming 与 existing 的 run_id。
 * 任一侧缺失时无法判定（返回 unknown）；此时按“同 run 合并”处理，
 * 绝不当成续跑，避免迟到帧把已落定的任务重置。
 */
function compareRunIds(
  incoming: string | undefined,
  existing: string | undefined,
): RunOrder {
  if (!incoming || !existing) return "unknown";
  if (incoming === existing) return "same";
  return incoming < existing ? "older" : "newer";
}

/** 优先用 SDK 消息时间，缺失或非法时退回本次落库时间。 */
function messageTime(message: SdkMessage, fallback: string): string {
  if (typeof message.timestamp === "string" && Number.isFinite(Date.parse(message.timestamp))) {
    return message.timestamp;
  }
  return fallback;
}

/** skill 约定的子任务标签，例如 `[wf:prl:1/4:dev]`。 */
const SUBAGENT_TAG_RE = /^\[wf:(?:prl|ser|plan):(?:\d{1,3}\/\d{1,3}|final):(?:dev|review)\]/;

/**
 * 子任务的 description 会在 task_progress 和续跑时被 SDK 改写成当前活动
 * （例如 “Reviewing ...”）。带工作流标签的原始说明要保留，否则进度条
 * 无法再按单元归组，开发/评审会变成两个独立子任务。
 */
function nextSubagentDescription(existing: string, incoming: string | undefined): string {
  if (!incoming) return existing;
  if (SUBAGENT_TAG_RE.test(existing) && !SUBAGENT_TAG_RE.test(incoming)) return existing;
  return incoming;
}

/**
 * 记录 SDK 的权威会话状态。
 *
 * 不能把 result 当成“这轮结束”：后台子 agent 的通知会让主 agent 继续跑，
 * 但那条内部轮次不经过 beginTurn，此时 turnActive 已经是 false。
 * session_state_changed 带 idle/running/requires_action，idle 才是真正收尾。
 * 未知值直接忽略，避免脏数据把会话卡在运行态或提前放出运行态。
 *
 * idle 同时兜底清掉 turnActive：用户趁 agent 干活时补的消息会被 SDK 提前
 * 拉走、折进正在跑的这一轮，之后不会再为它补一条 result；只等 result 收尾
 * 的话 turnActive 会一直是 true，会话就永远停在“进行中”。
 */
function noteSessionState(state: SessionCore, message: SdkMessage): void {
  if (message.state === "idle" || message.state === "running" || message.state === "requires_action") {
    state.agentState = message.state;
    if (message.state === "idle") state.turnActive = false;
  }
}

function noteSubagentStart(state: SessionCore, message: SdkMessage): void {
  if (!message.task_id || !isSubagentTask(message)) return;
  const index = state.subagents.findIndex((item) => item.taskId === message.task_id);
  if (index >= 0) {
    const existing = state.subagents[index];
    if (message.run_id && existing.runId === message.run_id) return;
    // 同一个 taskId 换了新的 run_id 说明被续跑了一次；沿用旧 run_id 不重复计数。
    const reran = Boolean(message.run_id) && existing.runId !== message.run_id;
    // 数组在 applySdkMessage 里已按写时复制换成本次事件私有；条目仍可能与 prev 共享。
    state.subagents[index] = {
      ...existing,
      runId: message.run_id ?? existing.runId,
      description: nextSubagentDescription(existing.description, message.description),
      status: "running",
      summary: undefined,
      // 续跑保留首次开始时间，只清掉上一轮的结束时间。
      startedAt: existing.startedAt ?? messageTime(message, state.updatedAt),
      // 行内计时只看当前这一轮；首次开始时两者相同。
      runStartedAt: messageTime(message, state.updatedAt),
      endedAt: undefined,
      ...(reran ? { runs: (existing.runs ?? 1) + 1 } : {}),
      ...(state.workflow ? { workflowAt: state.workflow.startedAt } : {}),
    };
    return;
  }
  const subagent: Subagent = {
    taskId: message.task_id,
    runId: message.run_id,
    description: message.description || "子任务",
    status: "running",
    runs: 1,
    startedAt: messageTime(message, state.updatedAt),
    runStartedAt: messageTime(message, state.updatedAt),
  };
  if (state.workflow) subagent.workflowAt = state.workflow.startedAt;
  state.subagents.push(subagent);
}

/**
 * task_progress / task_notification 的累计用量。字段缺失或异常时逐项忽略，
 * 不因为一个脏字段丢掉其它有效值。
 */
function noteSubagentUsage(target: Subagent, usage: RawUsage | undefined, at: string): void {
  if (!usage) return;
  const tokens = countValue(usage.total_tokens);
  const toolUses = countValue(usage.tool_uses);
  const durationMs = countValue(usage.duration_ms);
  if (tokens === undefined && toolUses === undefined && durationMs === undefined) return;
  if (tokens !== undefined) target.tokens = tokens;
  if (toolUses !== undefined) target.toolUses = toolUses;
  if (durationMs !== undefined) target.durationMs = durationMs;
  target.usageAt = at;
}

/** 非负整数才采用；小数取整，负数/NaN/Infinity 视为无效。 */
function countValue(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function noteSubagentProgress(state: SessionCore, message: SdkMessage): void {
  if (message.ambient || !message.task_id) return;
  const index = state.subagents.findIndex((item) => item.taskId === message.task_id);
  if (index < 0) return;
  const existing = state.subagents[index];
  if (message.run_id && existing.runId && message.run_id < existing.runId) return;
  const next = { ...existing };
  if (message.description) next.description = nextSubagentDescription(existing.description, message.description);
  if (message.summary) next.summary = clip(message.summary, 240);
  if (message.last_tool_name) next.lastToolName = message.last_tool_name;
  noteSubagentUsage(next, message.usage, messageTime(message, state.updatedAt));
  state.subagents[index] = next;
}

function noteSubagentNotification(state: SessionCore, message: SdkMessage): void {
  if (message.ambient || !message.task_id) return;
  const index = state.subagents.findIndex((item) => item.taskId === message.task_id);
  if (index < 0) return;
  const existing = state.subagents[index];
  if (message.run_id && existing.runId && message.run_id !== existing.runId) return;
  const status = notificationStatus(message.status);
  const at = messageTime(message, state.updatedAt);
  const next: Subagent = {
    ...existing,
    status,
    summary: message.summary ? clip(message.summary, 240) : existing.summary,
    endedAt: at,
  };
  // 落定时的用量是最完整的快照，覆盖最后一次进度里的数字。
  noteSubagentUsage(next, message.usage, at);
  state.subagents[index] = next;
}

function noteSubagentPatch(state: SessionCore, message: SdkMessage): void {
  if (!message.task_id || !message.patch) return;
  const index = state.subagents.findIndex((item) => item.taskId === message.task_id);
  if (index < 0) return;
  const existing = state.subagents[index];
  if (message.run_id && existing.runId && message.run_id !== existing.runId) return;
  const next = { ...existing };
  if (message.patch.description) next.description = nextSubagentDescription(existing.description, message.patch.description);
  if (message.patch.status) {
    next.status = patchStatus(message.patch.status);
    // 续跑回到 running 时清空结束时间，重新计时。
    next.endedAt = next.status === "running" ? undefined : messageTime(message, state.updatedAt);
  }
  if (message.patch.error) next.summary = clip(message.patch.error, 240);
  state.subagents[index] = next;
}

/**
 * 新建或续跑一个后台 shell 任务。
 *
 * 同一 run 的 task_started（包括背景快照先到、task_started 后到）只补缺失字段，
 * 不重置状态/时间/摘要；incoming run_id 较大才是续跑（状态回到 running，首次
 * 开始时间保留）；较小的迟到旧 run 直接忽略。
 */
function noteBackgroundTaskStart(state: SessionCore, message: SdkMessage): void {
  if (!message.task_id || !isBackgroundShellTask(message)) return;
  const tasks = state.backgroundTasks ?? [];
  const index = backgroundTaskIndex(state, message.task_id);
  if (index >= 0) {
    const existing = tasks[index];
    const order = compareRunIds(message.run_id, existing.runId);
    if (order === "older") return;
    if (order === "newer") {
      tasks[index] = {
        ...existing,
        runId: message.run_id,
        toolUseId: message.tool_use_id ?? existing.toolUseId,
        description: message.description || existing.description || "",
        status: "running",
        isBackgrounded: message.is_backgrounded !== false,
        // 续跑保留首次开始时间，清掉上一轮的结束时间与摘要。
        startedAt: existing.startedAt,
        endedAt: undefined,
        summary: undefined,
      };
      return;
    }
    // 同 run（或无法判定）：只补缺失字段，绝不重置已经收到的状态。
    tasks[index] = {
      ...existing,
      runId: existing.runId ?? message.run_id,
      toolUseId: existing.toolUseId ?? message.tool_use_id,
      description: existing.description || message.description || "",
      ...(typeof existing.isBackgrounded !== "boolean"
        ? { isBackgrounded: message.is_backgrounded !== false }
        : {}),
    };
    return;
  }
  tasks.push({
    taskId: message.task_id,
    runId: message.run_id,
    toolUseId: message.tool_use_id,
    taskType: message.task_type ?? "local_bash",
    // 没有真实说明时存空字符串，UI 自行兜底；不要占位，否则真实说明永远补不进来。
    description: message.description || "",
    status: "running",
    // 缺省视为已转入后台；只有 SDK 明确给出 false 才是前台阻塞执行。
    isBackgrounded: message.is_backgrounded !== false,
    startedAt: messageTime(message, state.updatedAt),
  });
}

/** 合并 task_updated 的增量 patch：状态、说明、是否转后台、错误摘要。 */
function noteBackgroundTaskPatch(state: SessionCore, message: SdkMessage): void {
  if (!message.task_id || !message.patch) return;
  const index = backgroundTaskIndex(state, message.task_id);
  if (index < 0) return;
  const tasks = state.backgroundTasks ?? [];
  const existing = tasks[index];
  // 只有更早 run 的迟到帧才忽略；较新的 run 允许改写（但正常会有 task_started 先行）。
  const order = compareRunIds(message.run_id, existing.runId);
  if (order === "older") return;
  const next: BackgroundTask = { ...existing };
  if (order === "newer" && message.run_id) next.runId = message.run_id;
  if (message.patch.description) next.description = message.patch.description;
  if (message.patch.is_backgrounded !== undefined) {
    next.isBackgrounded = message.patch.is_backgrounded;
  }
  if (message.patch.status) {
    const status = patchStatus(message.patch.status);
    // 同一 run 已经落定：迟到的 running patch 不能把它改回进行中（也不清 endedAt）。
    const terminal = existing.status !== "running";
    const resurrect = status === "running" && terminal && order !== "newer";
    if (!resurrect) {
      next.status = status;
      // 回到 running（例如续跑/恢复）时清空结束时间；结束状态补上。
      next.endedAt = status === "running" ? undefined : messageTime(message, state.updatedAt);
    }
  }
  if (message.patch.error) next.summary = clip(message.patch.error, 240);
  tasks[index] = next;
}

/** task_notification 是 shell 任务最终状态的权威落定。 */
function noteBackgroundTaskNotification(state: SessionCore, message: SdkMessage): void {
  if (!message.task_id) return;
  const index = backgroundTaskIndex(state, message.task_id);
  if (index < 0) return;
  const tasks = state.backgroundTasks ?? [];
  const existing = tasks[index];
  // 更早 run 的迟到通知会覆盖当前 run，必须忽略。
  const order = compareRunIds(message.run_id, existing.runId);
  if (order === "older") return;
  tasks[index] = {
    ...existing,
    runId: order === "newer"
      ? message.run_id
      : (existing.runId ?? message.run_id),
    status: notificationStatus(message.status),
    summary: message.summary ? clip(message.summary, 240) : existing.summary,
    endedAt: messageTime(message, state.updatedAt),
  };
}

/**
 * background_tasks_changed 是“当前存活后台任务”的 REPLACE 快照。
 * 这里只对快照里的 local_bash 任务做 upsert（视为 running）；不在快照里的历史
 * 条目保留，最终状态仍由 task_notification 落定，避免漏掉收尾帧后丢历史。
 * 快照里的子 agent 不动 subagents（由 task_* 边界帧维护）。
 *
 * 注意快照与 task_notification 的相对顺序是未定义的：一个刚结束（已收到终态
 * notification）的任务仍可能出现在随后一次成员变更快照里。因此同一 run 已经
 * 处于终态时不能被快照“复活”回 running，只有真的续跑（run_id 变大）才重置。
 *
 * SDK 说明这个“存活集合”是进程级的、重启时不发快照；CLI 进程级重启后内存里
 * 残留的 running 条目如何清理属于 runtime 的职责，不在本模块处理。
 */
function noteBackgroundTasksChanged(state: SessionCore, message: SdkMessage): void {
  const snapshot = message.tasks;
  if (!Array.isArray(snapshot)) return;
  const tasks = state.backgroundTasks ?? [];
  const startedAt = messageTime(message, state.updatedAt);
  for (const item of snapshot) {
    if (!item || typeof item.task_id !== "string" || !item.task_id) continue;
    if (item.task_type !== "local_bash" || item.ambient) continue;
    const index = tasks.findIndex((task) => task.taskId === item.task_id);
    if (index >= 0) {
      const existing = tasks[index];
      const order = compareRunIds(item.run_id, existing.runId);
      // 更早 run 的迟到快照整条跳过：连说明/后台标记也不能应用。
      if (order === "older") continue;
      const newer = order === "newer";
      const terminal = existing.status === "completed"
        || existing.status === "failed"
        || existing.status === "stopped";
      // 同一 run 已经落定：迟到的快照不能把它改回 running（否则会永久卡住）。
      if (terminal && !newer) continue;
      tasks[index] = {
        ...existing,
        runId: newer ? item.run_id : (existing.runId ?? item.run_id),
        // 不拿快照里的静态说明覆盖运行中已经更新的动态说明；缺失时才补。
        description: existing.description || item.description || "",
        status: "running",
        // 出现在“存活后台任务”快照里，说明当前已在后台。
        isBackgrounded: true,
        // 续跑沿用首次开始时间，并清掉上一轮的结束时间与摘要。
        startedAt: existing.startedAt,
        endedAt: undefined,
        ...(newer ? { summary: undefined } : {}),
      };
      continue;
    }
    tasks.push({
      taskId: item.task_id,
      runId: item.run_id,
      taskType: item.task_type,
      // 没有真实说明时存空字符串，UI 自行兜底；不要占位。
      description: item.description || "",
      status: "running",
      // 出现在“存活后台任务”快照里，说明已经在后台运行。
      isBackgrounded: true,
      startedAt,
    });
  }
}

function noteStream(state: SessionCore, message: SdkMessage): void {
  if (message.parent_tool_use_id || message.agent_id) return;
  const event = message.event;
  if (!event) return;
  if (event.type === "content_block_stop") {
    // 思考块结束时立刻落定，避免它被后续块挤在中间后一直显示“进行中”。
    finishThinking(state);
    return;
  }
  if (event.type === "content_block_start") {
    finishThinking(state);
    if (event.content_block?.type === "tool_use") {
      state.messages.push({
        id: event.content_block.id || message.uuid || randomId(),
        role: "tool",
        toolName: event.content_block.name || "工具",
        toolUseId: event.content_block.id,
        text: "",
        partial: true,
        streaming: true,
      });
    }
    return;
  }
  if (event.type !== "content_block_delta" || !event.delta) return;
  if (event.delta.type === "text_delta" && event.delta.text) {
    // 文本块开始即说明前面的思考块已经结束。
    finishThinking(state);
    const index = tailPartialIndex(state, "text");
    let current: TranscriptItem;
    if (index >= 0) {
      // 只替换这一条消息对象，prev 里的同一条保持不变。
      current = { ...state.messages[index] };
      state.messages[index] = current;
    } else {
      current = pushPartial(state, "text");
    }
    current.text = capMessageText(current.text + event.delta.text);
    state.summary = clip(current.text, 160);
    return;
  }
  if (event.delta.type === "thinking_delta" && event.delta.thinking) {
    // 用户可能在思考中途排队发消息；片段会插到末尾，但当前思考块还没结束，
    // 仍要接着往同一条记录里累积，否则一个思考块会被拆成多条。
    const index = openThinkingIndex(state);
    let current: TranscriptItem;
    if (index >= 0) {
      current = { ...state.messages[index] };
      state.messages[index] = current;
    } else {
      current = pushPartial(state, "thinking");
    }
    current.text = capMessageText(current.text + event.delta.thinking);
    return;
  }
  if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
    const index = tailPartialIndex(state, "tool");
    if (index >= 0) {
      const tool = { ...state.messages[index] };
      // 工具输入可能是多行正文，保留原始排版，不要折叠空白。
      tool.text = capMessageText(`${tool.text}${event.delta.partial_json}`, 8000);
      state.messages[index] = tool;
    }
  }
}

/** 只接受可解析的时间字符串，并归一化为 ISO 8601；无效值返回 undefined。 */
function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

/** 条目的产生时间：优先用消息时间，无效或缺失时用当前时间。 */
function itemTimestamp(value: unknown): string {
  return validTimestamp(value) ?? new Date().toISOString();
}

/** 单个 token 字段：缺失/非数字/负数一律按 0。 */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 把 SDK 的 snake_case 用量转成公开结构；全为 0 视为没有用量。 */
function parseUsage(raw: RawUsage | undefined): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = tokenCount(raw.input_tokens);
  const output = tokenCount(raw.output_tokens);
  const cacheRead = tokenCount(raw.cache_read_input_tokens);
  const cacheWrite = tokenCount(raw.cache_creation_input_tokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function noteAssistant(state: SessionCore, message: SdkMessage): void {
  if (message.parent_tool_use_id || message.agent_id) return;
  const blocks = contentBlocks(message.message?.content);
  // 这条完整消息新建的每种条目都记录产生时间；用量只属于 assistant 正文。
  const at = itemTimestamp(message.timestamp);
  const usage = parseUsage(message.message?.usage);
  // 本轮流式产生、还没被完整消息接管的思考片段。用 streaming 标记而不是扫末尾，
  // 这样用户在思考中途排队发的消息（插在片段之间）也不会把思考切丢。
  const streaming = state.messages.filter((item) => item.streaming && item.kind === "thinking");
  const streamingSet = new Set(streaming);
  // 文本和工具块的完整内容会在下面重新写入；思考片段先摘出来，配对后再按消息里的
  // 块顺序放回去，避免它被夹在工具/文本片段之间时残留或产生同 id 的重复条目。
  state.messages = state.messages.filter((item) =>
    !streamingSet.has(item) && !(item.streaming && item.kind !== "thinking"));
  // 写时复制：这些片段仍与 prev.messages 共享，下面的配对会改写正文/标记，先复制一份。
  const ownedStreaming = streaming.map((item) => ({ ...item }));
  const thoughts = blocks.flatMap((block, index) => {
    if (block.type !== "thinking" || typeof block.thinking !== "string") return [];
    return block.thinking ? [{ index, text: block.thinking }] : [];
  });
  const used = new Set<TranscriptItem>();
  const matched = new Map<number, TranscriptItem>();
  for (const thought of thoughts) {
    const item = takeThinking(thought.text, ownedStreaming, used);
    if (item) matched.set(thought.index, item);
  }
  // 完整消息没带上的流式思考（供应商只下发流式内容）：保留正文，放在本条消息之前。
  for (const item of ownedStreaming) {
    if (used.has(item)) continue;
    item.partial = undefined;
    item.streaming = undefined;
    state.messages.push(item);
  }
  const texts: string[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "thinking") {
      // 空正文（包括 redacted_thinking）没有可展示的内容，直接跳过。
      const item = matched.get(index);
      if (item) {
        state.messages.push(item);
      } else if (typeof block.thinking === "string" && block.thinking) {
        state.messages.push({
          id: message.uuid ? `${message.uuid}:thinking:${index}` : randomId(),
          role: "assistant",
          kind: "thinking",
          text: capMessageText(block.thinking),
          at,
        });
      }
      continue;
    }
    if (block.type === "text" && block.text) texts.push(block.text);
    if (block.type === "tool_use") {
      state.messages.push({
        id: block.id || randomId(),
        role: "tool",
        toolName: block.name || "tool",
        toolUseId: block.id,
        // 工具输入可能是多行正文，保留换行和空白。
        text: capMessageText(previewInput(block.input), 8000),
        at,
      });
    }
  }
  const text = capMessageText(texts.join("\n").trim());
  if (!text) return;
  const item: TranscriptItem = { id: message.uuid || randomId(), role: "assistant", text, at };
  if (usage) item.usage = usage;
  state.messages.push(item);
  state.summary = clip(text, 160);
}

/**
 * 找到仍在增长的思考片段。用户排队发的消息可能插在片段后面，但它不结束当前
 * 思考块，所以继续往前找；遇到已完成的其它内容才停止。返回下标便于写时复制。
 */
function openThinkingIndex(state: SessionCore): number {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const item = state.messages[index];
    if (item.streaming && item.kind === "thinking") {
      return item.partial ? index : -1;
    }
    if (item.partial || item.streaming || item.role === "user") continue;
    break;
  }
  return -1;
}

/**
 * 完整消息里的思考块优先配对内容一致的流式片段；内容有出入时按顺序复用
 * 本轮流式片段。归属只认 streaming 标记，已落定的思考不会被跨消息合并。
 */
function takeThinking(
  thinking: string,
  candidates: TranscriptItem[],
  used: Set<TranscriptItem>,
): TranscriptItem | undefined {
  const complete = thinking.trim();
  if (!complete) return undefined;
  for (const item of candidates) {
    if (used.has(item) || item.text.trim() !== complete) continue;
    item.partial = undefined;
    item.streaming = undefined;
    used.add(item);
    return item;
  }
  for (const item of candidates) {
    if (used.has(item)) continue;
    item.text = capMessageText(thinking);
    item.partial = undefined;
    item.streaming = undefined;
    used.add(item);
    return item;
  }
  return undefined;
}

function finishThinking(state: SessionCore): void {
  const index = openThinkingIndex(state);
  if (index < 0) return;
  const item = state.messages[index];
  // 客户端要显示「思考了 N 秒」；流式片段创建时记了 at，这里补结束时差。
  // 历史上没有 at 的条目（例如恢复的旧记录）直接省略，不写 0。
  const startedAt = validTimestamp(item.at);
  const durationMs = startedAt === undefined
    ? undefined
    : Math.max(0, Math.round(Date.now() - Date.parse(startedAt)));
  state.messages[index] = {
    ...item,
    partial: undefined,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function noteResult(state: SessionCore, message: SdkMessage): void {
  state.turnActive = false;
  state.queued = false;
  // 一轮结束：残留的流式片段不再显示“进行中”，也不能被下一轮当成自己的片段。
  // 只复制真正需要改动的条目，prev 里的同一对象保持不变。
  if (state.messages.some((item) => item.partial || item.streaming)) {
    state.messages = state.messages.map((item) =>
      item.partial || item.streaming ? { ...item, partial: undefined, streaming: undefined } : item);
  }
  if (message.session_id) state.claudeSessionId = message.session_id;
  const failed = message.subtype !== "success" || message.is_error === true;
  if (failed) {
    state.lastResult = "error";
    const detail = message.errors?.filter(Boolean).join("\n") || message.result || message.subtype || "本轮失败";
    state.lastError = clip(detail, 500);
    state.summary = clip(detail, 160);
    return;
  }
  state.lastResult = "success";
  state.lastError = undefined;
  if (message.result) {
    const result = capMessageText(message.result);
    state.summary = clip(result, 160);
    // 末尾可能是还没取走的排队消息，真实的上一条内容在它们前面。
    let lastIndex = state.messages.length - 1;
    while (lastIndex >= 0 && isQueuedUser(state.messages[lastIndex])) lastIndex -= 1;
    const last = lastIndex >= 0 ? state.messages[lastIndex] : undefined;
    if (!last || last.role !== "assistant" || last.text !== result) {
      const item: TranscriptItem = {
        id: message.uuid || randomId(),
        role: "assistant",
        text: result,
        at: itemTimestamp(message.timestamp),
      };
      const usage = parseUsage(message.usage);
      if (usage) item.usage = usage;
      state.messages.push(item);
    }
  }
}

interface ToolResultBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** 取出 user 消息里的 tool_result 块；纯文本回显一律忽略。 */
function toolResultBlocks(message: SdkMessage): ToolResultBlock[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((item): item is ToolResultBlock =>
    Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "tool_result");
}

/**
 * 工具结果正文：字符串原样保留；数组拼接其中的 text 块；
 * 其它形式（图片等）退回 JSON 字符串，避免丢失内容。
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    if (texts.length > 0) return texts.join("\n");
  }
  return previewInput(content);
}

/**
 * 把 tool_result 回填到对应的工具条目：状态、正文、耗时，并清掉“进行中”标记。
 * 数组已在 applySdkMessage 里按写时复制换成私有副本，这里只替换命中的条目对象。
 */
function noteToolResults(
  state: SessionCore,
  blocks: ToolResultBlock[],
  message: SdkMessage,
): void {
  if (blocks.length === 0) return;
  const endedAt = validTimestamp(message.timestamp) ?? state.updatedAt;
  const endedAtMs = Date.parse(endedAt);
  for (const block of blocks) {
    const id = block.tool_use_id;
    if (typeof id !== "string" || !id) continue;
    // 从后往前找：同一 tool_use_id 重复出现时以最近一次调用为准。
    let index = -1;
    for (let cursor = state.messages.length - 1; cursor >= 0; cursor -= 1) {
      const item = state.messages[cursor];
      if (item.role === "tool" && item.toolUseId === id) {
        index = cursor;
        break;
      }
    }
    if (index < 0) continue;
    const existing = state.messages[index];
    const startedAt = validTimestamp(existing.at);
    let durationMs: number | undefined;
    if (startedAt !== undefined && Number.isFinite(endedAtMs)) {
      durationMs = Math.max(0, Math.round(endedAtMs - Date.parse(startedAt)));
    }
    state.messages[index] = {
      ...existing,
      toolStatus: block.is_error === true || message.is_error === true ? "error" : "ok",
      result: capMessageText(toolResultText(block.content), 4000),
      // 时间不可用时省略耗时，而不是写一个 0。
      ...(durationMs !== undefined ? { durationMs } : {}),
      partial: undefined,
      streaming: undefined,
    };
  }
}

function apiErrorText(message: SdkMessage): string {
  const raw = message.error?.message?.trim() || "";
  const embedded = raw.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const inner = embedded?.[1]?.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  return inner || raw || "接口请求失败";
}

function notificationStatus(status: string | undefined): SubagentStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

function patchStatus(status: string): SubagentStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "killed") return "stopped";
  // paused 只是暂时挂起，任务还活着，对 UI 仍算进行中。
  if (status === "pending" || status === "running" || status === "paused") return "running";
  return "stopped";
}

/** 还没被 agent 取走的排队用户消息：它们固定排在记录末尾。 */
function isQueuedUser(item: TranscriptItem | undefined): boolean {
  return Boolean(item && item.role === "user" && item.queued === true);
}

/**
 * 把排队用户消息挪回记录末尾。顺序本来就对时返回原数组，避免每个流式增量
 * 都复制一次整段记录。
 */
function hoistQueuedMessages(messages: TranscriptItem[]): TranscriptItem[] {
  let firstQueued = -1;
  let needsMove = false;
  for (let index = 0; index < messages.length; index += 1) {
    if (isQueuedUser(messages[index])) {
      if (firstQueued < 0) firstQueued = index;
    } else if (firstQueued >= 0) {
      needsMove = true;
      break;
    }
  }
  if (!needsMove) return messages;
  const queued: TranscriptItem[] = [];
  const rest: TranscriptItem[] = [];
  for (const item of messages) {
    (isQueuedUser(item) ? queued : rest).push(item);
  }
  return [...rest, ...queued];
}

function pushPartial(state: SessionCore, kind: "text" | "thinking"): TranscriptItem {
  const item: TranscriptItem = {
    id: randomId(),
    role: "assistant",
    text: "",
    partial: true,
    streaming: true,
    kind: kind === "thinking" ? "thinking" : undefined,
    // 流式片段也可能因失败/停止残留，先记下它的产生时间。
    at: new Date().toISOString(),
  };
  state.messages.push(item);
  return item;
}

function tailPartialIndex(state: SessionCore, kind: "text" | "thinking" | "tool"): number {
  // 末尾的排队用户消息不参与“最后一条正在增长的内容”：跳过它们往前找，
  // 否则每来一个增量都会误建一条新的片段。
  let index = state.messages.length - 1;
  while (index >= 0 && isQueuedUser(state.messages[index])) index -= 1;
  if (index < 0) return -1;
  const last = state.messages[index];
  if (!last.partial) return -1;
  if (kind === "tool") return last.role === "tool" ? index : -1;
  if (kind === "thinking") return last.kind === "thinking" ? index : -1;
  return last.role === "assistant" && last.kind !== "thinking" ? index : -1;
}

function contentBlocks(content: unknown): Array<{
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
}> {
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item && typeof item === "object") as Array<{
    type?: string;
    text?: string;
    thinking?: string;
    name?: string;
    id?: string;
    input?: unknown;
  }>;
}

/**
 * 一条完整 assistant 消息里模型真正生成的输出：正文、思考和工具输入。
 *
 * 主线程的输出速度用流式增量统计；子 agent 没有流式增量，只能等完整消息
 * 到达后按整块内容估算，所以这里把三类输出拼在一起交给速度计。
 */
export function assistantOutputText(message: SdkMessage): string {
  const parts: string[] = [];
  for (const block of contentBlocks(message.message?.content)) {
    if (block.type === "text") {
      if (block.text) parts.push(block.text);
    } else if (block.type === "thinking") {
      if (block.thinking) parts.push(block.thinking);
    } else if (block.type === "tool_use") {
      parts.push(previewInput(block.input));
    }
  }
  return parts.join("");
}

function previewInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * 仅测试/模拟用的轻量追加：消息形态与真实路径（store.addUserMessage）保持一致，
 * 同样带 at；但不处理图片、sdkUuid 和排队/工作流等会话状态。
 */
export function appendUserMessage(state: SessionCore, text: string): SessionCore {
  const now = new Date().toISOString();
  const item: TranscriptItem = {
    id: randomId(),
    role: "user",
    text: capMessageText(text),
    at: now,
  };
  return {
    ...state,
    messages: limitTranscript([...state.messages, item]),
    summary: clip(text, 160),
    updatedAt: now,
  };
}

export function subagentCounts(subagents: Subagent[]): { done: number; total: number } {
  const visible = subagents;
  const done = visible.filter((item) => item.status === "completed").length;
  return { done, total: visible.length };
}
