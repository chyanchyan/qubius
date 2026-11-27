import type { LimitsConfig } from "./config.js";
import type { PermissionLevel } from "./permissions.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORTS)[number];

/**
 * 接口配置的协议类型：anthropic 是兼容 Anthropic Messages 的地址，
 * gemini 走服务内置的 Gemini 适配层。老设置文件没有这个字段，按 anthropic 处理。
 */
export const PROVIDER_KINDS = ["anthropic", "gemini"] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/** setup：多模型讨论已经创建，正在等用户配置参与模型。 */
export type Phase = "queued" | "running" | "completed" | "failed" | "needs_input" | "stopped" | "setup";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export type BackgroundTaskStatus = SubagentStatus;

/**
 * SDK 的后台 shell 任务（Bash 的 run_in_background / Ctrl+B 转到后台）。
 * 与子 agent 分开存：它们是命令而不是 agent，不参与工作流和并发计数。
 */
export interface BackgroundTask {
  taskId: string;
  runId?: string;
  /** 触发任务的 tool_use id，用于把“转到后台”关联回工具行。 */
  toolUseId?: string;
  /** SDK 的 task_type；当前只跟踪 local_bash。 */
  taskType: string;
  /** 命令或任务描述，查看进度时直接展示。 */
  description: string;
  status: BackgroundTaskStatus;
  /** 是否已经转入后台；前台注册、尚未转后台时为 false。 */
  isBackgrounded: boolean;
  startedAt: string;
  endedAt?: string;
  /** 结束时 SDK 给出的摘要。 */
  summary?: string;
}

export type TranscriptRole = "user" | "assistant" | "tool";

/** 工具结果状态：结果返回后才有值。 */
export type ToolStatus = "ok" | "error";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** 图片保存在 dataDir 下，对话记录里只留引用。 */
export interface ImageRef {
  id: string;
  mediaType: ImageMediaType;
  name?: string;
}

/** 一次模型调用的 token 用量。 */
export interface TokenUsage {
  /** 非缓存输入 token（API 的 input_tokens）。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** cache_read_input_tokens。 */
  cacheRead: number;
  /** cache_creation_input_tokens。 */
  cacheWrite: number;
}

/** 一条已经提交、尚未被 agent 取走的排队消息。 */
export interface QueueEntry {
  id: string;
  text: string;
  images: number;
  createdAt: string;
  /** 已经点过「现在发送」：正在插入当前轮，等 agent 取走；不再占用排队顺序。 */
  interjecting?: boolean;
}

/** 汇总的 token 用量。 */
export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TranscriptItem {
  id: string;
  role: TranscriptRole;
  text: string;
  toolName?: string;
  toolUseId?: string;
  /** 工具结果状态（成功/失败）；只对 tool 条目、结果已返回时存在。 */
  toolStatus?: ToolStatus;
  /** 工具调用到结果返回、或思考块从开始到结束的耗时（毫秒）。 */
  durationMs?: number;
  /** 工具结果正文（可能截断）；只对 tool 条目、结果已返回时存在。 */
  result?: string;
  images?: ImageRef[];
  /** 这一条还在增长，完整消息到达后会被替换。 */
  partial?: boolean;
  /** 服务端内部标记：由流式增量创建、尚未被完整消息接管；不发给前端。 */
  streaming?: boolean;
  kind?: "thinking";
  /** 这条内容产生的时间，ISO 8601 字符串。 */
  at?: string;
  /** 产生这条 assistant 正文的那次模型调用消耗的 token。 */
  usage?: TokenUsage;
  /**
   * 产生这条 assistant 正文的那一轮实际使用的模型（本轮启动时绑定的会话模型）。
   * 用于在每条回答开头标出模型；切换模型只影响下一轮，所以必须按轮记录，
   * 不能读取当前会话配置。旧消息没有。
   */
  model?: string;
  /** 发送这条用户消息时随 SDKUserMessage 发出的 uuid；旧消息没有。 */
  sdkUuid?: string;
  /**
   * 服务端内部标记：这条用户消息还在排队、没被 agent 取走。排队期间它固定
   * 排在记录末尾，当前轮后续的输出插到它前面，避免消息卡在发送位置；
   * agent 取走时清除。不发给前端。
   */
  queued?: boolean;
  /**
   * 回滚/分叉用的截断点：这条消息被 agent 取走前，SDK transcript 最后一条
   * 主线程 chain 条目 uuid；没有更早上下文时是 ROOT_FORK_POINT。旧消息没有。
   */
  forkPoint?: string;
  /** 只下发前端：这条用户消息是否支持回滚/分叉（服务端 strip() 计算）。 */
  rewindable?: boolean;
  /** 多模型讨论里的发言者显示名；普通对话没有。 */
  speaker?: string;
  /** 多模型讨论发言的阶段和轮次；普通对话没有。 */
  discussion?: DiscussionMessageMeta;
  /** prl-role 发言的角色、轮次和单元；普通对话没有。 */
  roleRun?: RoleMessageMeta;
}

export type WorkflowSkill = "prl" | "ser" | "plan" | "discuss" | "dis-prl" | "prl-role";

export type DiscussionKind = "decompose" | "answer" | "review" | "rebuttal" | "final";

export interface DiscussionMessageMeta {
  /** 从 1 开始；同一轮里所有模型共享一个轮次号。 */
  round: number;
  kind: DiscussionKind;
  /** 并行讨论里的子任务；集成讨论和拆分阶段没有。 */
  subtask?: { index: number; title: string };
  /** 这是所有子讨论结束后的集成讨论。 */
  integration?: boolean;
}

/** 参与讨论的一个模型。可以重复选同一个模型，靠 name 区分身份。 */
export interface DiscussionParticipant {
  /** 展示名；用户可编辑，默认取模型名。 */
  name: string;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
}

export type DiscussionPhase = "setup" | "running" | "completed" | "failed" | "stopped";

/** 讨论的组织方式：flat 是原流程，parallel 是拆分后子讨论并行、最后集成。 */
export type DiscussionStrategy = "flat" | "parallel";

/** 并行讨论里的一个子任务；每个子任务各自跑一遍原讨论流程。 */
export interface DiscussionSubtaskState {
  /** 从 1 开始，和消息里的 subtask.index 对应。 */
  index: number;
  title: string;
  phase: "running" | "completed" | "failed" | "stopped";
  /** 这个子任务自己的轮次（从 1 开始）。 */
  round: number;
  /** 这个子任务里正在等待回复的参与者下标。 */
  activeIndex?: number;
  activeKind?: DiscussionKind;
  /** 子讨论结束时是否所有审阅者都表示一致。 */
  agreed?: boolean;
  /** 子讨论失败时的原因。 */
  error?: string;
}

/** 当前会话的多模型讨论状态；普通对话没有这个字段。 */
export interface DiscussionState {
  phase: DiscussionPhase;
  participants: DiscussionParticipant[];
  /** 当前轮次（从 1 开始）；还没开始或已完成时保留最后一轮。 */
  round: number;
  /** 讨论的组织方式；旧数据或普通 discuss 缺省为 flat。 */
  strategy?: DiscussionStrategy;
  /** 并行讨论拆分出的子任务；拆分完成前缺省。 */
  subtasks?: DiscussionSubtaskState[];
  /** 子讨论结束后正在做集成讨论。 */
  integrating?: boolean;
  /** 正在等待回复的参与者下标；不在发言时缺省。 */
  activeIndex?: number;
  /** 正在等待回复的阶段，用来显示“审阅中/答辩中”。 */
  activeKind?: DiscussionKind;
  /** 最后一轮结束后所有审阅者是否都表示一致。 */
  agreed?: boolean;
  /** 失败或停止的原因。 */
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

/**
 * prl-role 角色团队的四个角色。
 *
 * 编排模型负责拆分，执行模型负责每个单元的开发，子审核模型负责每个单元的
 * 评审，集成审核模型负责全部单元结束后的整体审核。
 */
export type RoleKind =
  | "orchestrator"
  | "executor"
  | "sub-reviewer"
  | "integration-reviewer";

/** 一个角色选用的接口、模型和思考强度。 */
export interface RoleBinding {
  providerId: string;
  /** 保存时的接口名，接口被删除后仍能显示；启动时会重新校验。 */
  providerName: string;
  model: string;
  effort: Effort;
}

/** prl-role 的四角色团队；四个角色都必须有值。 */
export interface RoleTeam {
  orchestrator: RoleBinding;
  executor: RoleBinding;
  subReviewer: RoleBinding;
  integrationReviewer: RoleBinding;
}

export type RoleRunPhase = "setup" | "running" | "completed" | "failed" | "stopped";

export type RoleUnitPhase = "pending" | "running" | "passed" | "needs_attention" | "stopped";

/** 一个工作单元的开发-评审进度。 */
export interface RoleUnitState {
  /** 从 1 开始。 */
  index: number;
  title: string;
  phase: RoleUnitPhase;
  /** 当前轮次（从 1 开始）。 */
  round: number;
  /** 最近一次评审结论；还没评审时缺省。 */
  verdict?: "pass" | "changes" | "unknown";
  /** 最近一次评审原文（截断），修复轮会交给执行模型。 */
  issues?: string;
  /** 执行者最近一轮的自述摘要（截断）。 */
  executorSummary?: string;
}

/** 当前会话的 prl-role 运行状态；普通对话没有这个字段。 */
export interface RoleRunState {
  phase: RoleRunPhase;
  /** 开始运行后保存的团队配置；setup 阶段可能缺省。 */
  team?: RoleTeam;
  units: RoleUnitState[];
  /** 当前单元轮次（从 1 开始）；还没开始时为 0。 */
  round: number;
  maxRounds: number;
  /** 正在调用的角色；阶段之间缺省。 */
  activeRole?: RoleKind;
  /** 正在处理的单元下标（从 1 开始）。 */
  activeUnit?: number;
  /** 正在执行的角色最近调用的工具名。 */
  activeTool?: string;
  /** 所有单元结束后正在做集成审核。 */
  integrating?: boolean;
  /** 集成审核是否通过。 */
  agreed?: boolean;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

/** 一条 prl-role 发言的归属：角色、轮次、单元或集成阶段。 */
export interface RoleMessageMeta {
  kind: RoleKind;
  round: number;
  unit?: { index: number; title: string };
  integrating?: boolean;
  /** 本次调用实际使用的接口，用于用量统计按真实角色归账；旧数据缺省时回退会话接口。 */
  providerId?: string;
  providerName?: string;
  model?: string;
}

/** 一轮 prl/ser/plan/discuss 工作流；由发送区选择或消息末尾 token 触发。 */
export interface WorkflowRun {
  skill: WorkflowSkill;
  startedAt: string;
  /** 本轮落定（成功/失败/停止）的时间；仍在跑时缺省。 */
  endedAt?: string;
}

export interface Subagent {
  taskId: string;
  runId?: string;
  description: string;
  status: SubagentStatus;
  summary?: string;
  lastToolName?: string;
  /** 最近一次活动所属的工作流（用 startedAt 标识）。 */
  workflowAt?: string;
  /** 累计执行次数：首次为 1，每次新 run_id 再 +1。 */
  runs?: number;
  /** 首次开始运行的时间；续跑不会重置，用来算单元总用时。 */
  startedAt?: string;
  /** 最近一轮开始运行的时间；每次续跑重置，用来给行内计时。 */
  runStartedAt?: string;
  /** 最近一次结束的时间；再次续跑时清空。 */
  endedAt?: string;
  /** SDK 报告的累计 token 用量；旧会话或还没收到进度时缺失。 */
  tokens?: number;
  /** SDK 报告的累计工具调用次数。 */
  toolUses?: number;
  /** SDK 报告的执行时长（毫秒，不含暂停）；运行中会随时间继续增长。 */
  durationMs?: number;
  /** 最近一次用量报告的到达时间；运行中据此把 durationMs 续到当前时刻。 */
  usageAt?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingRequest {
  requestId: string;
  kind: "permission" | "question";
  toolName: string;
  /** 单行摘要（空白折叠、最多 2000 字符），供列表和紧凑展示。 */
  inputPreview: string;
  /** 完整输入文本：Bash 为 command 原文，其它工具为格式化 JSON。 */
  inputText: string;
  /** inputText 是否因过大被截断。 */
  inputTruncated: boolean;
  /** 是否必须展开完整输入后才能允许（含换行、超长或被截断）。 */
  requiresExpand: boolean;
  blockedPath?: string;
  questions?: PendingQuestion[];
  /** 服务端自动拒绝这次确认的时间；不自动拒绝或旧会话没有这个字段。 */
  expiresAt?: string;
}

export interface SessionCore {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  /**
   * 标题还是占位词，等首个成功轮次结束后由 agent 总结替换。
   * 用户手动改名或生成完成后清除；旧会话没有这个字段，保持原标题。
   */
  titlePending?: boolean;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  cwd: string;
  branch?: string;
  git: boolean;
  claudeSessionId?: string;
  summary: string;
  lastResult?: "success" | "error" | "stopped";
  lastError?: string;
  phase: Phase;
  turnActive: boolean;
  /**
   * SDK 的 session_state_changed 状态。进程级信号，不跨重启保留：
   * idle/running/requires_action，缺少表示 SDK 还没上报或已失联。
   */
  agentState?: "idle" | "running" | "requires_action";
  queued: boolean;
  subagents: Subagent[];
  /** SDK 后台 shell 任务；旧会话/旧数据没有这个字段。 */
  backgroundTasks?: BackgroundTask[];
  /** 当前这一轮的 prl/ser/plan/discuss 工作流；普通对话为 undefined。 */
  workflow?: WorkflowRun;
  /** 多模型讨论的参与者和进度；普通对话为 undefined。 */
  discussion?: DiscussionState;
  /** prl-role 角色团队的运行状态；普通对话为 undefined。 */
  roleRun?: RoleRunState;
  messages: TranscriptItem[];
  pending: PendingRequest | null;
  seen: string[];
  /** 用户置顶的会话排在列表最前面；旧会话没有这个字段。 */
  pinned?: boolean;
  /** 最近一轮开始运行的时间（beginTurn）；从未运行过则缺失。 */
  runStartedAt?: string;
  /** 最近一轮结束运行的时间（会话落定为完成/失败/停止）；运行中或从未运行则缺失。 */
  runEndedAt?: string;
  /** 主线程最后一条 chain 条目 uuid（user/assistant/compact_boundary）。 */
  lastSdkUuid?: string;
  /** 下一次运行必须新建 SDK 会话（回滚到最开始），用 claudeSessionId 作为新 id，不 resume。 */
  newSdkSession?: boolean;
  /** 由回滚/分叉产生、需要一并清理/归档的额外 SDK session id。 */
  forkedSdkIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  git: boolean;
  available: boolean;
  permission: PermissionLevel;
  /** 服务端内置项目（普通对话），不需要写进 config.yaml。 */
  builtin: boolean;
  /** 非 git 项目里每个对话使用独立子目录。 */
  isolated: boolean;
  /** 是否可以在设置页从项目文件里删除（内置或 config.yaml 项目为 false）。 */
  removable: boolean;
}

export interface PublicProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** 保存的密钥明文：设置页需要能通过「显示明文」查看原文。 */
  apiKey: string;
  hasApiKey: boolean;
  models: string[];
}

export interface PublicSettings {
  providers: PublicProvider[];
  effort: Effort;
  /**
   * 同时进行的对话数上限；超出的对话排队，修改后立即生效。
   * 顶栏「运行中 / 上限」也用这个值作为 agent 上限。
   */
  maxConcurrent: number;
  /** 等待确认（提问/授权）超时，单位分钟；0 表示不自动拒绝。 */
  approvalTimeoutMinutes: number;
  /** 会话裁剪与请求体/历史分页上限。 */
  limits: LimitsConfig;
  /** 会话在本机保留多少天后归档；只有配置了归档目录时生效。 */
  archiveRetentionDays: number;
  /** 设置页保存的 prl-role 默认四角色团队；没有配置时缺省。 */
  roleTeam?: RoleTeam;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  phase: Phase;
  summary: string;
  lastError?: string;
  branch?: string;
  git: boolean;
  cwd: string;
  /** 这个对话用的是项目下的独立目录（删除对话时一并清理）。 */
  isolated: boolean;
  subagentDone: number;
  subagentTotal: number;
  subagents: Subagent[];
  /** SDK 后台 shell 任务；服务端始终下发数组（没有任务时为 []）。 */
  backgroundTasks?: BackgroundTask[];
  /**
   * 主 agent 是否正在运行。等待确认、排队时不计数；只有后台子 agent 在跑、
   * 主 agent 已空闲时也不计数。顶栏的全局 agent 计数用它加上运行中的子 agent。
   */
  mainAgentRunning: boolean;
  /** 当前这一轮的 prl/ser/plan/discuss 工作流；普通对话为 undefined。 */
  workflow?: WorkflowRun;
  /** 多模型讨论的参与者和进度；普通对话为 undefined。 */
  discussion?: DiscussionState;
  /** prl-role 角色团队的运行状态；普通对话为 undefined。 */
  roleRun?: RoleRunState;
  pending: PendingRequest | null;
  /** 已提交但还没被 agent 取走的消息；由 HTTP/SSE 层按运行时队列补齐。 */
  queue?: QueueEntry[];
  pinned?: boolean;
  /**
   * 当前输出速度（tokens/s，按流式增量估算，取最近 2 秒的平均值）。
   * 所有 agent 的增量都计入；没有输出时省略。顶栏用它显示全局实时速度。
   */
  tokensPerSecond?: number;
  /** 最近一轮开始运行的时间；旧会话或从未运行过则缺失。 */
  runStartedAt?: string;
  /** 最近一轮结束运行的时间；运行中或从未运行则缺失。 */
  runEndedAt?: string;
  createdAt: string;
  updatedAt: string;
  messages?: TranscriptItem[];
  /** 详情 SSE：当前完整 transcript 的条数；只有详情连接会带。 */
  messageCount?: number;
  /** 本帧 messages 的起始下标；只有本帧带 messages 时才出现。 */
  messagesFrom?: number;
  /** 当前是否有可用的文件检查点（由 HTTP 层填充；这里只加类型）。 */
  canRewindFiles?: boolean;
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}
