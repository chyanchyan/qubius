import type { BackgroundTask, ImageRef, Session, Transcript, WorkflowSkill } from "./api";

/**
 * 用户消息操作（回滚 / 编辑重发 / 分叉）的纯逻辑；组件与单测共用。
 */

/** 会话仍在跑（含排队、等待确认）时，不允许回滚/分叉已提交的记录。 */
const ACTIVE_PHASES: ReadonlySet<Session["phase"]> = new Set<Session["phase"]>([
  "queued",
  "running",
  "needs_input",
]);

/**
 * 有正在运行的后台 shell 任务时，phase 仍是 completed，但服务端会拒绝
 * 回滚/分叉；页面据此隐藏消息操作菜单。
 */
export function hasRunningBackgroundTasks(
  tasks: ReadonlyArray<Pick<BackgroundTask, "status">> | undefined,
): boolean {
  return tasks?.some((task) => task.status === "running") === true;
}

export interface MessageActionState {
  /** Composer 发送、另一个消息操作或「继续上次」在途。 */
  busy?: boolean;
  /**
   * 有正在运行的后台 shell 任务。此时 phase 仍是 completed，但服务端会拒绝
   * 回滚/分叉（409），所以同样不提供菜单入口。
   */
  backgroundBusy?: boolean;
}

/**
 * 这条消息是否显示「⋯」操作菜单。
 *
 * 需要同时满足：会话空闲、没有运行中的后台任务、是用户消息、不是本地乐观
 * 发送中的条目、服务端标记了 rewindable。旧服务端不带 rewindable，一律不显示。
 */
export function canOfferMessageActions(
  session: Pick<Session, "phase">,
  item: Transcript,
  state: MessageActionState = {},
): boolean {
  if (state.busy || state.backgroundBusy) return false;
  if (ACTIVE_PHASES.has(session.phase)) return false;
  if (item.role !== "user") return false;
  if (item.status === "sending") return false;
  return item.rewindable === true;
}

/** 回滚确认框里「同时回滚代码改动」勾选项的可用状态和说明文案。 */
export function rewindCheckboxState(
  canRewindFiles: boolean | undefined,
): { disabled: boolean; description: string } {
  if (canRewindFiles === true) {
    return {
      disabled: false,
      description: "把 agent 改过的文件恢复到这条消息之前。",
    };
  }
  return {
    disabled: true,
    description: "当前无法回滚代码：对话进程已结束或这条消息没有文件检查点。",
  };
}

export interface RewindRequestBody {
  messageId: string;
  files?: boolean;
  prompt?: string;
  keepImages?: ImageRef[];
  workflow?: WorkflowSkill;
}

/**
 * 构造 POST /rewind 的请求体：只带真正有意义的可选字段。
 * 空 keepImages 不上送，避免服务端把“没有图片”误当成一次图片复用请求；
 * prompt 允许是空串（纯图片消息的编辑重发）。
 */
export function buildRewindBody(
  messageId: string,
  files?: boolean,
  options?: {
    prompt?: string;
    keepImages?: ImageRef[];
    workflow?: WorkflowSkill;
  },
): RewindRequestBody {
  const body: RewindRequestBody = { messageId };
  if (files !== undefined) body.files = files;
  if (options?.prompt !== undefined) body.prompt = options.prompt;
  if (options?.keepImages && options.keepImages.length > 0) body.keepImages = options.keepImages;
  if (options?.workflow) body.workflow = options.workflow;
  return body;
}

/**
 * 纯回滚成功后是否回填输入框：只有当前草稿为空时才用服务端返回的文本，
 * 不覆盖用户已经输入的内容。返回 null 表示保持原草稿。
 */
export function rewindComposerRefill(current: string, promptText: string): string | null {
  return current.trim() ? null : promptText;
}

/**
 * 编辑重发是否允许提交：纯文本消息不能为空；带原消息图片的消息允许只有图片
 * （服务端按 keepImages 复用图片）。
 */
export function canSubmitMessageEdit(text: string, imageCount: number): boolean {
  return text.trim().length > 0 || imageCount > 0;
}
