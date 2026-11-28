export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** setup：多模型讨论已创建，等用户配置参与模型。 */
export type Phase = "queued" | "running" | "completed" | "failed" | "stopped" | "needs_input" | "setup";

export const PERMISSIONS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
export type PermissionLevel = (typeof PERMISSIONS)[number];

export const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  default: "需要确认",
  acceptEdits: "接受编辑",
  plan: "只规划",
  auto: "自动判断",
  bypassPermissions: "全部允许",
};

export interface Project {
  id: string;
  name: string;
  path: string;
  git: boolean;
  available: boolean;
  permission: PermissionLevel;
  /** 服务端内置项目（普通对话），不需要在 config.yaml 里配置。 */
  builtin: boolean;
  /** 非 git 项目里每个对话使用独立子目录。 */
  isolated: boolean;
  /** 是否可以在「管理项目」里删除（内置项目或 config.yaml 项目为 false）。 */
  removable: boolean;
}

export type WorkflowSkill = "prl" | "ser" | "plan" | "discuss" | "dis-prl" | "prl-role";

/** 一轮 prl/ser/plan/discuss/dis-prl 工作流；由发送区选择或消息末尾 token 触发。 */
export interface WorkflowRun {
  skill: WorkflowSkill;
  startedAt: string;
  /** 本轮落定（成功/失败/停止）的时间；仍在跑时缺省。 */
  endedAt?: string;
}

export type DiscussionKind = "decompose" | "answer" | "review" | "rebuttal" | "final";

export interface DiscussionMessageMeta {
  /** 从 1 开始。 */
  round: number;
  kind: DiscussionKind;
  /** 并行讨论里的子任务；集成讨论和拆分阶段没有。 */
  subtask?: { index: number; title: string };
  /** 这是所有子讨论结束后的集成讨论。 */
  integration?: boolean;
}

/** 参与讨论的一个模型；允许重复选同一个模型，靠 name 区分身份。 */
export interface DiscussionParticipant {
  name: string;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
}

export type DiscussionPhase = "setup" | "running" | "completed" | "failed" | "stopped";

/** 讨论的组织方式：flat 是原流程，parallel 是拆分后子讨论并行、最后集成。 */
export type DiscussionStrategy = "flat" | "parallel";

/** 并行讨论里的一个子任务。 */
export interface DiscussionSubtaskState {
  index: number;
  title: string;
  phase: "running" | "completed" | "failed" | "stopped";
  round: number;
  activeIndex?: number;
  activeKind?: DiscussionKind;
  agreed?: boolean;
  error?: string;
}

/** 当前会话的多模型讨论状态。 */
export interface DiscussionState {
  phase: DiscussionPhase;
  participants: DiscussionParticipant[];
  round: number;
  strategy?: DiscussionStrategy;
  subtasks?: DiscussionSubtaskState[];
  /** 子讨论结束后正在做集成讨论。 */
  integrating?: boolean;
  /** 正在等待回复的参与者下标。 */
  activeIndex?: number;
  activeKind?: DiscussionKind;
  /** 最后一轮是否所有审阅者都表示一致。 */
  agreed?: boolean;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

/** prl-role 的四个角色。 */
export type RoleKind =
  | "orchestrator"
  | "executor"
  | "sub-reviewer"
  | "integration-reviewer";

export interface RoleBinding {
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
}

/** prl-role 的四角色团队。 */
export interface RoleTeam {
  orchestrator: RoleBinding;
  executor: RoleBinding;
  subReviewer: RoleBinding;
  integrationReviewer: RoleBinding;
}

export type RoleRunPhase = "setup" | "running" | "completed" | "failed" | "stopped";

export type RoleUnitPhase = "pending" | "running" | "passed" | "needs_attention" | "stopped";

export interface RoleUnitState {
  index: number;
  title: string;
  phase: RoleUnitPhase;
  round: number;
  verdict?: "pass" | "changes" | "unknown";
  issues?: string;
  executorSummary?: string;
}

/** 当前会话的 prl-role 运行状态。 */
export interface RoleRunState {
  phase: RoleRunPhase;
  team?: RoleTeam;
  units: RoleUnitState[];
  round: number;
  maxRounds: number;
  activeRole?: RoleKind;
  activeUnit?: number;
  activeTool?: string;
  integrating?: boolean;
  agreed?: boolean;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

/** 一条 prl-role 发言的归属。 */
export interface RoleMessageMeta {
  kind: RoleKind;
  round: number;
  unit?: { index: number; title: string };
  integrating?: boolean;
  providerId?: string;
  providerName?: string;
  model?: string;
}

export interface Subagent {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  summary?: string;
  lastToolName?: string;
  /** 最近一次活动所属的工作流（用 startedAt 标识）。 */
  workflowAt?: string;
  /** 累计执行次数：首次为 1，每次新 run_id 再 +1。 */
  runs?: number;
  /** 首次开始运行的时间；续跑不会重置。 */
  startedAt?: string;
  /** 最近一轮开始运行的时间；每次续跑重置，用来给行内计时。 */
  runStartedAt?: string;
  /** 最近一次结束的时间；再次续跑时清空。 */
  endedAt?: string;
  /** SDK 报告的累计 token 用量；旧会话或还没收到进度时缺失。 */
  tokens?: number;
  /** SDK 报告的累计工具调用次数。 */
  toolUses?: number;
  /** SDK 报告的执行时长（毫秒，不含暂停）；运行中由客户端续算到当前时刻。 */
  durationMs?: number;
  /** 最近一次用量报告的到达时间；运行中据此续算时长。 */
  usageAt?: string;
}

/** SDK 后台 shell 任务（Bash 的 run_in_background / 转到后台）。 */
export interface BackgroundTask {
  taskId: string;
  runId?: string;
  /** 触发任务的 tool_use id；用于把“转到后台”关联回工具行。 */
  toolUseId?: string;
  /** SDK 的 task_type；当前只跟踪 local_bash。 */
  taskType: string;
  /** 命令或任务描述。 */
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** 是否已经转入后台；前台注册、尚未转后台时为 false。 */
  isBackgrounded: boolean;
  startedAt: string;
  endedAt?: string;
  summary?: string;
}

/** 后台任务输出的尾部（服务端最多返回最后 8 KiB）。 */
export interface TaskOutput {
  output: string;
  totalBytes: number;
  /** output 是否只是更长输出的结尾片段。 */
  truncated: boolean;
}

/** 子任务详情里的一条记录：提示、正文、思考或工具调用。 */
export interface SubagentTranscriptEntry {
  id: string;
  kind: "prompt" | "text" | "thinking" | "tool";
  text: string;
  toolName?: string;
  result?: string;
  toolStatus?: "ok" | "error";
}

/** 子任务的 sidechain transcript（服务端只返回尾部最近一部分）。 */
export interface SubagentTranscript {
  entries: SubagentTranscriptEntry[];
  truncated: boolean;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface Pending {
  requestId: string;
  kind: "permission" | "question";
  toolName: string;
  /** 单行摘要（空白折叠、最多 2000 字符），供列表和紧凑展示。 */
  inputPreview: string;
  /** 完整输入文本；旧服务端没有这个字段时回退到 inputPreview。 */
  inputText?: string;
  /** inputText 是否被截断。 */
  inputTruncated?: boolean;
  /** 是否必须展开完整输入后才能允许。 */
  requiresExpand?: boolean;
  blockedPath?: string;
  questions?: PendingQuestion[];
  /** 服务端自动拒绝这次确认的时间；不自动拒绝或旧服务端/旧会话没有这个字段。 */
  expiresAt?: string;
}

/**
 * 可以「本对话记住」的工具（与服务端 runtime.canRemember 保持一致）：
 * 只收窄到文件写入类，命令和子 agent 每次都要确认。
 */
export const REMEMBERABLE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

export function canRememberTool(toolName: string): boolean {
  return REMEMBERABLE_TOOLS.has(toolName);
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageRef {
  id: string;
  mediaType: ImageMediaType;
  name?: string;
}

/** 发送时客户端先压缩，data 是不带前缀的 base64。 */
export interface OutgoingImage {
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

/** 一次模型调用消耗的 token 明细。 */
export interface TokenUsage {
  /** 非缓存输入 token。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** 缓存读取 token。 */
  cacheRead: number;
  /** 缓存写入 token。 */
  cacheWrite: number;
}

export interface Transcript {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  /** SDK 的 tool_use id；“转到后台”需要用它定位正在跑的前台命令。 */
  toolUseId?: string;
  /** 工具结果状态（成功/失败）；只对 tool 条目、结果已返回时存在。 */
  toolStatus?: "ok" | "error";
  /** 工具调用到结果返回的耗时（毫秒）。 */
  durationMs?: number;
  /** 工具结果正文（可能截断）；只对 tool 条目、结果已返回时存在。 */
  result?: string;
  images?: ImageRef[];
  /**
   * 这条用户消息是否支持回滚/编辑重发/分叉（服务端按进程存活和检查点计算）；
   * 旧服务端没有该字段，视为不支持。
   */
  rewindable?: boolean;
  /**
   * 只在本端乐观渲染时出现：消息已经先画进记录、还没有收到服务端确认。
   * 发送中显示「发送中…」；服务端返回真实条目（带正式 id）后该字段消失。
   */
  status?: "sending";
  /** 只在本端乐观渲染时出现：尚未上传的图片，直接用 data URL 预览。 */
  pendingImages?: OutgoingImage[];
  partial?: boolean;
  kind?: "thinking";
  /** 多模型讨论里的发言者显示名；普通对话省略。 */
  speaker?: string;
  /** 多模型讨论发言的阶段和轮次；普通对话省略。 */
  discussion?: DiscussionMessageMeta;
  /** prl-role 发言的角色、轮次和单元；普通对话省略。 */
  roleRun?: RoleMessageMeta;
  /** 这条内容产生的时间，ISO 8601 字符串。 */
  at?: string;
  /** 产生这条 assistant 正文的那次模型调用消耗的 token。 */
  usage?: TokenUsage;
  /** 产生这条 assistant 正文的那一轮实际使用的模型；旧消息没有。 */
  model?: string;
}

/** 一条已经提交、尚未被 agent 取走的排队消息。 */
export interface QueueEntry {
  id: string;
  text: string;
  images: number;
  createdAt: string;
  /** 已经点过「现在发送」：正在插入当前轮，等 agent 取走。 */
  interjecting?: boolean;
}

export interface Session {
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
  /** 这个对话用的是项目下的独立目录（删除时一并清理）。 */
  isolated: boolean;
  subagentDone: number;
  subagentTotal: number;
  subagents: Subagent[];
  /** SDK 后台 shell 任务；旧服务端或没有任务时省略。 */
  backgroundTasks?: BackgroundTask[];
  /** 主 agent 是否正在运行（等待确认、只有后台子 agent 在跑时为空闲）；旧版服务端没有该字段。 */
  mainAgentRunning?: boolean;
  /**
   * 当前输出速度（tokens/s，按流式增量估算的最近 2 秒平均值）；
   * 没有输出时省略。旧版服务端没有该字段。
   */
  tokensPerSecond?: number;
  /** 当前这一轮的 prl/ser/plan/discuss 工作流；普通对话为 undefined。 */
  workflow?: WorkflowRun;
  /** 多模型讨论的参与者和进度；普通对话为 undefined。 */
  discussion?: DiscussionState;
  /** prl-role 角色团队的运行状态；普通对话为 undefined。 */
  roleRun?: RoleRunState;
  /**
   * 当前是否能同时回滚代码改动（服务端按存活进程和检查点计算）；
   * 旧服务端/假运行没有该字段，视为不能。
   */
  canRewindFiles?: boolean;
  pending: Pending | null;
  /** 已提交但还没被 agent 取走的消息。 */
  queue?: QueueEntry[];
  pinned?: boolean;
  /** 最近一轮开始运行的时间；旧会话或从未运行过则缺失。 */
  runStartedAt?: string;
  /** 最近一轮结束运行的时间；运行中或从未运行则缺失。 */
  runEndedAt?: string;
  createdAt: string;
  updatedAt: string;
  messages?: Transcript[];
  /** 详情 SSE 帧里的消息总数（不含 messages）；Board 的 summary 帧不带。 */
  messageCount?: number;
  /** SSE 帧里的 messages 在完整记录中的起始下标；缺省按 0（全量）处理。 */
  messagesFrom?: number;
  /** 首帧 / 截断或下标不可对齐时服务端带 reset，客户端应整段替换本地消息。 */
  reset?: boolean;
  /** 本地 messages[0] 在完整记录里的下标；加载更早历史时向前推进。 */
  historyStart?: number;
  removed?: boolean;
}

/**
 * 把一帧 `/api/events?session=` 数据合并进本地会话。
 *
 * - `reset: true`：帧里的 messages 是从 `messagesFrom` 起的一页，整段替换本地
 *   消息；`historyStart` 记录这一页的起点（首帧即最近一页）。
 * - 帧里有 messages（增量）：`from = messagesFrom ?? 0`。帧内容是从 `from`
 *   到末尾的完整尾部。`from >= historyStart` 时按 `from - historyStart` 保留
 *   本地前段再追加；`from < historyStart` 时切掉帧里已在本地的前缀，用剩余
 *   尾部替换本地消息（变化点在未加载历史里，但尾部更新不能丢）。
 * - 帧里没有 messages：只更新元数据，本地消息保持不变。
 * - `removed: true` 返回 null，由调用方负责跳转/移除。
 *
 * 服务端保证每帧的元数据都是最新的；prev 为 null 时直接用帧内容建立会话。
 */
export function mergeSessionFrame(prev: Session | null, frame: Session): Session | null {
  if (frame.removed) return null;
  const { removed: _removed, messages, messagesFrom, reset, ...meta } = frame;
  const merged = { ...(prev ?? {}), ...meta } as Session;
  // 服务端用“没有 workflow（或为 undefined）”表示普通对话。可选字段在展开
  // 合并时会保留本地旧值，必须显式删掉，否则普通回合会继续显示上一轮工作流。
  if (!frame.workflow) delete merged.workflow;
  const historyStart = prev?.historyStart ?? 0;
  if (messages) {
    if (reset) {
      merged.messages = [...messages];
      merged.historyStart = messagesFrom ?? 0;
      return merged;
    }
    const from = messagesFrom ?? 0;
    if (from >= historyStart) {
      const offset = from - historyStart;
      const local = prev?.messages ?? [];
      if (offset > local.length) {
        // 不变量下不可达（帧起点落在本地末端之后会留空档）：接受帧内容并重置起点。
        merged.messages = [...messages];
        merged.historyStart = from;
      } else {
        const head = offset > 0 ? local.slice(0, offset) : [];
        merged.messages = [...head, ...messages];
        merged.historyStart = historyStart;
      }
    } else {
      // 变化落在未加载的历史里。帧仍是 [from, 末尾) 的完整尾部：
      // 去掉本地已有的前缀后，用它替换本地窗口，避免“计数新、内容旧”。
      const offset = historyStart - from;
      if (offset < messages.length) {
        merged.messages = messages.slice(offset);
        merged.historyStart = historyStart;
      } else {
        // 极端截断：帧尾部比本地窗口还短，只能接受帧内容并重置起点。
        merged.messages = [...messages];
        merged.historyStart = from;
      }
    }
  } else {
    if (prev?.messages) merged.messages = prev.messages;
    if (prev?.historyStart !== undefined) merged.historyStart = prev.historyStart;
  }
  return merged;
}

export interface ArchivedSession {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  providerName: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  messageCount: number;
  /** 冷备已完成、本机副本还没清理掉；面板显示为「待清理」并允许重试。 */
  pendingDelete?: boolean;
  /** 本机是否还有同名会话（归档列表接口返回）。 */
  local?: boolean;
}

export interface ArchiveStatus {
  enabled: boolean;
  /** 以下字段只在 enabled 时有意义。 */
  dir?: string;
  instance?: string;
  retentionDays?: number;
  writable?: boolean;
  archived?: number;
  sweeping?: boolean;
  lastSweepAt?: string;
  lastSweepError?: string;
}

/** anthropic：兼容 Anthropic Messages 的地址；gemini：走服务端内置适配层。 */
export type ProviderKind = "anthropic" | "gemini";

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** 已保存的密钥明文；旧服务端可能不返回，按空字符串处理。 */
  apiKey?: string;
  hasApiKey: boolean;
  models: string[];
}

/** 会话裁剪与请求体/历史分页上限；与服务端 LimitsConfig 保持一致。 */
export interface Limits {
  transcriptBytes: number;
  transcriptMessages: number;
  messageText: number;
  requestBodyBytes: number;
  historyPage: number;
}

export interface Settings {
  providers: Provider[];
  effort: Effort;
  /**
   * 同时进行的对话数上限；超出的对话排队，修改后立即生效。
   * 顶栏「运行中 / 上限」也用这个值作为 agent 上限。
   */
  maxConcurrent: number;
  /** 等待确认（提问/授权）超时，单位分钟；0 表示不自动拒绝。 */
  approvalTimeoutMinutes: number;
  /** 会话裁剪与请求体/历史分页上限。 */
  limits: Limits;
  /** 会话在本机保留多少天后归档；只有配置了归档目录时生效。 */
  archiveRetentionDays: number;
  /** 设置页保存的 prl-role 默认四角色团队；没有配置时缺省。 */
  roleTeam?: RoleTeam;
}

/** 与服务端 settings.ts 的 MAX_CONCURRENT_MIN / MAX_CONCURRENT_MAX / DEFAULT_MAX_CONCURRENT 保持一致。 */
export const MAX_CONCURRENT_MIN = 1;
export const MAX_CONCURRENT_MAX = 256;
export const DEFAULT_MAX_CONCURRENT = 4;

/** 与服务端 settings.ts / config.ts 的校验区间保持一致。 */
export const APPROVAL_TIMEOUT_MIN = 0;
export const APPROVAL_TIMEOUT_MAX = 1440;
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 0;

export const ARCHIVE_RETENTION_MIN = 1;
export const ARCHIVE_RETENTION_MAX = 3650;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;

export const DEFAULT_LIMITS: Limits = {
  transcriptBytes: 8 * 1024 * 1024,
  transcriptMessages: 5_000,
  messageText: 200_000,
  requestBodyBytes: 28_000_000,
  historyPage: 200,
};

/** 各上限的合法区间；与 config.ts 的 LIMIT_RULES 保持一致。 */
export const LIMIT_RANGES: Array<{ key: keyof Limits; min: number; max: number }> = [
  { key: "transcriptBytes", min: 64 * 1024, max: 64 * 1024 * 1024 },
  { key: "transcriptMessages", min: 50, max: 20_000 },
  { key: "messageText", min: 1024, max: 1024 * 1024 },
  { key: "requestBodyBytes", min: 1024 * 1024, max: 64 * 1024 * 1024 },
  { key: "historyPage", min: 50, max: 2_000 },
];

/** 设置页保存成功后广播；顶栏据此立即更新并发 / agent 上限，不必重新请求。 */
export const SETTINGS_SAVED_EVENT = "qubius:settings-saved";

/** 部署成功等入口配置变化后广播；顶栏据此重新读取已启用的访问入口。 */
export const INSTANCE_REFRESH_EVENT = "qubius:instance-refresh";

/** 把任意输入夹到并发上限的合法范围；非数字退回默认值。 */
export function clampMaxConcurrent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT;
  return Math.min(MAX_CONCURRENT_MAX, Math.max(MAX_CONCURRENT_MIN, Math.round(value)));
}

/**
 * 解析顶栏输入框里的并发上限：只接受 1..256 的十进制整数。
 * 空串、小数、正负号和超出范围的数字都返回 null，交给调用方提示。
 */
export function parseMaxConcurrentInput(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const limit = Number(text);
  return limit >= MAX_CONCURRENT_MIN && limit <= MAX_CONCURRENT_MAX ? limit : null;
}

export type SecondaryState = "idle" | "running" | "success" | "failed";
export type PrimaryRelation = "up-to-date" | "behind" | "diverged" | "unknown";

/** 副实例相对主实例同步分支的位置；旧服务端不会返回。 */
export interface PrimaryComparison {
  ref: string;
  head?: string;
  relation: PrimaryRelation;
  behind?: number;
  ahead?: number;
  subject?: string;
  committedAt?: string;
  files?: number;
  insertions?: number;
  deletions?: number;
  depsChanged?: boolean;
  /** 主实例有已跟踪文件的未提交改动；这些内容不会被同步。 */
  dirty?: boolean;
  /** 待同步的提交，最新在前（最多 5 个）。 */
  commits?: { sha: string; subject: string }[];
  reason?: string;
}

export interface SecondaryStatus {
  state: SecondaryState;
  action?: "sync" | "rollback";
  jobId?: string;
  currentHead?: string;
  previousHead?: string | null;
  from?: string | null;
  to?: string | null;
  message?: string;
  pid?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  logTail?: string;
  primary?: PrimaryComparison;
  /** 副实例当前分支；同步要求 main。 */
  branch?: string;
  /** 副实例工作区有未提交改动（含未跟踪文件），同步会失败。 */
  dirty?: boolean;
  /** 正在运行的服务所用构建的提交（短 sha）。 */
  runningHead?: string;
  /** 回滚目标的提交标题。 */
  previousSubject?: string;
}

export interface InstanceInfo {
  role: "primary" | "secondary";
  secondary: SecondaryStatus | null;
  /** 命令行页是否开启；旧服务端没有这个字段，按开启处理。 */
  terminal?: boolean;
  /** 进行中（排队/运行/等确认）的会话数；重启服务会中断它们。 */
  activeSessions?: number;
  /** 除本机外实例还启用了哪些入口；旧服务端没有这个字段。 */
  access?: { lan: boolean; public: boolean };
  /** 运行中构建的版本号（根 package.json 的 version）；旧服务端没有。 */
  version?: string;
}

export interface ProviderDraft {
  id?: string;
  name: string;
  kind?: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  models: string[];
}

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const PHASE_LABEL: Record<Phase, string> = {
  queued: "排队",
  running: "进行中",
  completed: "本轮完成",
  failed: "失败",
  stopped: "已停止",
  needs_input: "等待确认",
  setup: "待配置",
};

export const SUBAGENT_LABEL: Record<Subagent["status"], string> = {
  running: "进行中",
  completed: "完成",
  failed: "失败",
  stopped: "已停止",
};

/** 本地保存的 API 访问令牌（服务端启用 auth 时才需要）。 */
export const API_TOKEN_KEY = "qubius.apiToken";
/** 同令牌的 cookie 名；浏览器原生请求不便加头时靠它。 */
export const API_TOKEN_COOKIE = "qubius_token";
/** 任一请求收到 401 时在 window 上广播，App 据此弹出令牌输入框。 */
export const UNAUTHORIZED_EVENT = "qubius:unauthorized";

/* 没有 localStorage（node 测试、隐私模式写入失败）时退回内存，
   同一页面内的后续请求仍然能带上令牌。 */
let memoryApiToken = "";

/** 读取访问令牌：优先 localStorage，取不到时退回本页内存。 */
export function readApiToken(): string {
  try {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(API_TOKEN_KEY);
      if (stored !== null) return stored;
    }
  } catch {
    // 存储不可用（隐私模式等）时继续用内存值。
  }
  return memoryApiToken;
}

/**
 * 保存访问令牌：trim 后写入 localStorage、同名 cookie 和内存。
 * 空字符串表示清除；没有 document 时只更新内存。
 */
export function writeApiToken(token: string): void {
  const value = token.trim();
  memoryApiToken = value;
  try {
    if (typeof localStorage !== "undefined") {
      if (value) localStorage.setItem(API_TOKEN_KEY, value);
      else localStorage.removeItem(API_TOKEN_KEY);
    }
  } catch {
    // 存储失败不影响本页使用。
  }
  if (typeof document === "undefined") return;
  try {
    let cookie = `${API_TOKEN_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Strict`;
    if (typeof window !== "undefined" && window.location?.protocol === "https:") cookie += "; Secure";
    if (!value) cookie += "; Max-Age=0";
    document.cookie = cookie;
  } catch {
    // 令牌含孤立代理项时 encodeURIComponent 会抛 URIError；cookie 种不上，
    // 但请求头仍可用，内存/localStorage 已在上方更新，下次启动还会再试。
  }
}

/**
 * 浏览器重启后会话 cookie 可能已经丢失，而 EventSource 不能自定义请求头，
 * 只能靠 cookie；启动时用已保存的令牌重新种一次。没有令牌或没有 document
 * 时安全地什么都不做。
 */
export function ensureApiTokenCookie(): void {
  const token = readApiToken();
  if (token) writeApiToken(token);
}

const REQUEST_TIMEOUT_MS = 15_000;
// 大仓库的 diff、等待 agent 退出的 stop/delete 需要更长时间。
const LONG_TIMEOUT_MS = 90_000;
// 最多 4 张图片（base64 后约 27MB），慢网络上传需要更久。
const UPLOAD_TIMEOUT_MS = 180_000;

interface TimedSignal {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}

/**
 * 把调用方的 signal 和请求超时合并成一个 signal。优先使用
 * AbortSignal.timeout / AbortSignal.any，环境不支持时退回
 * AbortController + setTimeout。
 */
function timedSignal(ms: number, caller?: AbortSignal): TimedSignal {
  const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  if (hasTimeout) {
    const timeout = AbortSignal.timeout(ms);
    if (!caller) {
      return { signal: timeout, didTimeout: () => timeout.aborted, dispose: () => {} };
    }
    if (typeof AbortSignal.any === "function") {
      return {
        signal: AbortSignal.any([caller, timeout]),
        didTimeout: () => timeout.aborted,
        dispose: () => {},
      };
    }
    const controller = new AbortController();
    const onCaller = () => controller.abort(caller.reason);
    const onTimeout = () => controller.abort(timeout.reason);
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCaller, { once: true });
    if (timeout.aborted) controller.abort(timeout.reason);
    else timeout.addEventListener("abort", onTimeout, { once: true });
    return {
      signal: controller.signal,
      didTimeout: () => timeout.aborted,
      dispose: () => {
        caller.removeEventListener("abort", onCaller);
        timeout.removeEventListener("abort", onTimeout);
      },
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timeout", "TimeoutError"));
  }, ms);
  const onCaller = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCaller, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCaller);
    },
  };
}

function failureMessage(response: Response, data: unknown): string {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error) {
    return data.error;
  }
  return `请求失败（${response.status}）`;
}

/**
 * request 抛出的错误：保留原有 message 语义，同时附带响应里的结构化字段，
 * 调用方可以按 code 分流（例如 409 busy / stale / residual）。
 * remainingPids / jobId 是 residual 错误里的残留进程和任务标识，供前端展示或精确回收。
 */
export interface RequestError extends Error {
  status?: number;
  code?: string;
  kind?: string;
  jobId?: string;
  remainingPids?: number[];
  currentDataDir?: string;
  targetDataDir?: string;
  sessions?: number;
}

function requestError(message: string, response?: Response, data?: unknown): RequestError {
  const error = new Error(message) as RequestError;
  if (response) error.status = response.status;
  if (data && typeof data === "object") {
    const record = data as {
      code?: unknown;
      kind?: unknown;
      jobId?: unknown;
      remainingPids?: unknown;
      currentDataDir?: unknown;
      targetDataDir?: unknown;
      sessions?: unknown;
    };
    if (typeof record.code === "string" && record.code) error.code = record.code;
    if (typeof record.kind === "string" && record.kind) error.kind = record.kind;
    if (typeof record.jobId === "string" && record.jobId) error.jobId = record.jobId;
    if (typeof record.currentDataDir === "string") error.currentDataDir = record.currentDataDir;
    if (typeof record.targetDataDir === "string") error.targetDataDir = record.targetDataDir;
    if (typeof record.sessions === "number" && Number.isInteger(record.sessions)) {
      error.sessions = record.sessions;
    }
    if (Array.isArray(record.remainingPids)) {
      const pids = record.remainingPids.filter(
        (pid): pid is number => typeof pid === "number" && Number.isInteger(pid),
      );
      if (pids.length > 0) error.remainingPids = pids;
    }
  }
  return error;
}

export async function request<T>(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const caller = signal ?? init?.signal ?? undefined;
  const timed = timedSignal(timeoutMs, caller);
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const token = readApiToken();
    if (token) headers.set("X-Qubius-Token", token);
    const response = await fetch(url, { ...init, headers, signal: timed.signal });
    // 服务端启用令牌而本地没有/填错时广播一次；App 只保留一个输入框。
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const text = await response.text();
    let data = {} as T & { error?: string };

    if (text) {
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const jsonLike = contentType === "" || contentType.includes("json");
      if (jsonLike) {
        try {
          data = JSON.parse(text) as T & { error?: string };
        } catch {
          // 502/代理错误页之类不是 JSON：用状态码兜底，避免抛 JSON.parse 的原始文案。
          if (!response.ok) throw requestError(failureMessage(response, data), response);
          throw requestError("服务器返回了无法解析的响应", response);
        }
      } else if (response.ok) {
        throw requestError("服务器返回了无法解析的响应", response);
      }
    }

    if (!response.ok) throw requestError(failureMessage(response, data), response, data);
    return data;
  } catch (reason) {
    // 调用方主动取消优先于超时；两者都发生时不要把取消误报成超时。
    if (caller?.aborted) throw caller.reason ?? reason;
    if (timed.didTimeout()) {
      const method = (init?.method ?? "GET").toUpperCase();
      const hint = method === "GET" ? "" : "，服务端可能仍在处理，请刷新确认";
      const error = new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）${hint}`);
      error.name = "TimeoutError";
      throw error;
    }
    throw reason;
  } finally {
    timed.dispose();
  }
}

export function getProjects(signal?: AbortSignal): Promise<{ projects: Project[] }> {
  return request("/api/projects", undefined, signal);
}

export function saveProjectPermission(id: string, permission: PermissionLevel, signal?: AbortSignal): Promise<{ project: Project }> {
  return request(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify({ permission }) }, signal);
}

/** 运行期添加本机的 git 仓库；目录不存在时服务端会自动创建并初始化 git 仓库，写入额外项目文件后立即生效。 */
export function addProject(body: {
  id: string;
  name: string;
  path: string;
  permission?: PermissionLevel;
}, signal?: AbortSignal): Promise<{ project: Project }> {
  return request("/api/projects", { method: "POST", body: JSON.stringify(body) }, signal);
}

/** 在机器上新建 git 仓库并加入项目列表；服务端会创建目录、git init 并提交初始版本。 */
export function createRepo(body: {
  name: string;
  /** 母目录，不含仓库名；仓库建在 `<母目录>/<name>`。 */
  parent: string;
  permission?: PermissionLevel;
}, signal?: AbortSignal): Promise<{ project: Project }> {
  return request("/api/projects/new", { method: "POST", body: JSON.stringify(body) }, signal);
}

/** 从额外项目文件删除运行期添加的仓库；config.yaml 项目和内置项目会返回 400。 */
export function deleteProject(id: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request(`/api/projects/${id}`, { method: "DELETE" }, signal);
}

export function getSettings(signal?: AbortSignal): Promise<Settings> {
  return request("/api/settings", undefined, signal);
}

export function saveSettings(body: {
  providers: ProviderDraft[];
  effort: Effort;
  maxConcurrent?: number;
  approvalTimeoutMinutes?: number;
  limits?: Limits;
  archiveRetentionDays?: number;
  /** null 表示清除默认团队，弹窗退回会话当前模型。 */
  roleTeam?: RoleTeam | null;
}, signal?: AbortSignal): Promise<Settings> {
  return request("/api/settings", { method: "PUT", body: JSON.stringify(body) }, signal);
}

/**
 * 只改并发上限；服务端按补丁合并，接口配置和 effort 保持不变。
 * 顶栏的 agent 计数点开后直接走这里，不必先读整份设置再原样写回。
 */
export function saveMaxConcurrent(maxConcurrent: number, signal?: AbortSignal): Promise<Settings> {
  return request("/api/settings", { method: "PUT", body: JSON.stringify({ maxConcurrent }) }, signal);
}

export function getSessions(projectId: string, signal?: AbortSignal): Promise<{ sessions: Session[] }> {
  return request(`/api/projects/${projectId}/sessions`, undefined, signal);
}

export function createSession(projectId: string, body: {
  prompt: string;
  providerId: string;
  model: string;
  effort?: Effort;
  images?: OutgoingImage[];
  /** 这一轮使用的工作流；缺省或空串表示普通对话。 */
  workflow?: WorkflowSkill;
  /** 显式标题；多模型对比等批量创建时用来区分同一批会话。 */
  title?: string;
}, signal?: AbortSignal): Promise<{ session: Session }> {
  return request(`/api/projects/${projectId}/sessions`, { method: "POST", body: JSON.stringify(body) }, signal, UPLOAD_TIMEOUT_MS);
}

export function getSession(id: string, signal?: AbortSignal): Promise<{ session: Session }> {
  return request(`/api/sessions/${id}`, undefined, signal);
}

/** 一页更早的历史消息；start 是 messages[0] 在完整记录里的下标。 */
export interface SessionMessagesPage {
  start: number;
  messageCount: number;
  messages: Transcript[];
}

/** 按 before（排他上界）向前取一页历史，limit 由服务端默认/夹取。 */
export function getSessionMessages(
  id: string,
  before: number,
  limit?: number,
  signal?: AbortSignal,
): Promise<SessionMessagesPage> {
  const params = new URLSearchParams({ before: String(before) });
  if (limit !== undefined) params.set("limit", String(limit));
  return request(`/api/sessions/${id}/messages?${params}`, undefined, signal);
}

/**
 * 把一页更早的历史接到本地消息前面，并把 historyStart 前移。
 * 调用方需要先确认本地 historyStart 仍等于请求时的 before，避免与 reset 帧错位。
 */
export function prependHistoryPage(session: Session, page: SessionMessagesPage): Session {
  return {
    ...session,
    messages: [...page.messages, ...(session.messages ?? [])],
    historyStart: page.start,
    // 请求期间可能又追加了消息；页码里的总数只作为下限，避免计数回退。
    messageCount: Math.max(page.messageCount ?? 0, session.messageCount ?? 0),
  };
}

export function sendMessage(
  id: string,
  prompt: string,
  images?: OutgoingImage[],
  signal?: AbortSignal,
  workflow?: WorkflowSkill,
  /**
   * true = 插话：立即交给正在跑的 agent（Ctrl+Enter）；
   * 缺省 = 排队：当前轮结束后再执行。
   */
  interject?: boolean,
): Promise<{ session: Session }> {
  const body: { prompt: string; images?: OutgoingImage[]; workflow?: WorkflowSkill; interject?: boolean } = { prompt };
  if (images && images.length > 0) body.images = images;
  if (workflow) body.workflow = workflow;
  if (interject) body.interject = true;
  return request(`/api/sessions/${id}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  }, signal, UPLOAD_TIMEOUT_MS);
}

/** prl-role：提交四角色团队并开始运行。 */
export function startRoleRun(
  id: string,
  team: RoleTeam,
  signal?: AbortSignal,
): Promise<{ session: Session }> {
  return request(`/api/sessions/${id}/role-run/start`, {
    method: "POST",
    body: JSON.stringify({ team }),
  }, signal);
}

export function imageUrl(sessionId: string, image: ImageRef): string {
  return `/api/sessions/${sessionId}/images/${image.id}`;
}

export function answerSession(id: string, body: {
  requestId: string;
  behavior: "allow" | "deny";
  answers?: Record<string, string>;
  /** 本对话内记住这类工具，后续同类确认不再询问。 */
  remember?: boolean;
  /** 用户已展开完整输入后再允许；只有需要展开的确认才携带。 */
  approvedFull?: boolean;
}, signal?: AbortSignal): Promise<{ session: Session }> {
  return request(`/api/sessions/${id}/answer`, { method: "POST", body: JSON.stringify(body) }, signal);
}

export function stopSession(id: string, signal?: AbortSignal): Promise<{ session: Session }> {
  return request(`/api/sessions/${id}/stop`, { method: "POST", body: "{}" }, signal, LONG_TIMEOUT_MS);
}

export function deleteSession(id: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${id}`, { method: "DELETE" }, signal, LONG_TIMEOUT_MS);
}

/** 读取后台任务输出的尾部；服务端会截断到最近 8 KiB。 */
export function getTaskOutput(
  sessionId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskOutput> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/output`,
    undefined,
    signal,
  );
}

/** 读取子任务的 sidechain transcript；不能读到记录时返回 404。 */
export function getSubagentTranscript(
  sessionId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<SubagentTranscript> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(taskId)}`,
    undefined,
    signal,
  );
}

/** 把正在前台运行的命令转到后台；toolUseId 来自工具条目。 */
export function backgroundTask(
  sessionId: string,
  toolUseId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; backgrounded: boolean }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/tasks/background`, {
    method: "POST",
    body: JSON.stringify({ toolUseId }),
  }, signal);
}

/** 停止一个后台任务。 */
export function stopBackgroundTask(
  sessionId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`,
    { method: "POST", body: "{}" },
    signal,
  );
}

export function getDiff(id: string, signal?: AbortSignal): Promise<{ stat: string; patch: string }> {
  return request(`/api/sessions/${id}/diff`, undefined, signal, LONG_TIMEOUT_MS);
}

export function getArchivedSessions(projectId: string, signal?: AbortSignal): Promise<{
  enabled: boolean;
  sessions: ArchivedSession[];
}> {
  return request(`/api/archive/sessions?projectId=${encodeURIComponent(projectId)}`, undefined, signal);
}

export function getArchivedSession(id: string, signal?: AbortSignal): Promise<{
  session: Session;
  archivedAt: string;
}> {
  return request(`/api/archive/sessions/${id}`, undefined, signal);
}

export function getArchiveStatus(signal?: AbortSignal): Promise<{ archive: ArchiveStatus }> {
  return request("/api/archive/status", undefined, signal);
}

export function restoreArchivedSession(id: string, signal?: AbortSignal): Promise<{ session: Session }> {
  return request(`/api/archive/sessions/${id}/restore`, { method: "POST", body: "{}" }, signal, LONG_TIMEOUT_MS);
}

export function deleteArchivedSession(id: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request(`/api/archive/sessions/${id}`, { method: "DELETE" }, signal, LONG_TIMEOUT_MS);
}

export function startArchiveSweep(signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request("/api/archive/sweep", { method: "POST", body: "{}" }, signal);
}

export function getInstance(signal?: AbortSignal): Promise<InstanceInfo> {
  return request("/api/instance", undefined, signal);
}

export function startSecondarySync(signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request("/api/secondary/sync", { method: "POST", body: "{}" }, signal);
}

export function startSecondaryRollback(signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request("/api/secondary/rollback", { method: "POST", body: "{}" }, signal);
}

/** 服务端保存的 Web Push 状态。 */
export interface PushStatus {
  /** VAPID 公钥（base64url），pushManager.subscribe 用。 */
  publicKey: string;
  /** 已保存的订阅数量。 */
  count: number;
}

/** 浏览器 PushSubscription 序列化后的最小字段。 */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export function getPushStatus(signal?: AbortSignal): Promise<PushStatus> {
  return request("/api/push", undefined, signal);
}

export function subscribePush(body: PushSubscriptionPayload, signal?: AbortSignal): Promise<{ ok: true; count: number }> {
  return request("/api/push/subscriptions", { method: "POST", body: JSON.stringify(body) }, signal);
}

export function unsubscribePush(endpoint: string, signal?: AbortSignal): Promise<{ ok: true; count: number }> {
  return request("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) }, signal);
}

export function sendTestPush(signal?: AbortSignal): Promise<{ ok: true; sent: number; failed: number }> {
  return request("/api/push/test", { method: "POST", body: "{}" }, signal);
}
