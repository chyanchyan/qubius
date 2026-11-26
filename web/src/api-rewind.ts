import { request, type ImageRef, type Session, type WorkflowSkill } from "./api";
import { buildRewindBody } from "./message-actions";

/**
 * 用户消息的回滚、编辑重发和分叉接口。
 *
 * 服务端在回滚/分叉时要收拾 SDK 文件检查点和 worktree，可能比普通读请求
 * 慢；沿用 stop/delete 的 90 秒长超时约定。
 */
const REWIND_TIMEOUT_MS = 90_000;

/** 带编辑重发时，服务端返回将要填入输入框的内容。 */
export interface RewindPrompt {
  text: string;
  images: ImageRef[];
}

export interface RewindResult {
  session: Session;
  prompt: RewindPrompt;
}

export interface RewindOptions {
  /** 编辑后的正文；带上时服务端先回滚再用它重新发送。 */
  prompt?: string;
  /** 原消息里的图片引用；服务端按 ref 复用已存图片，不重复上传。 */
  keepImages?: ImageRef[];
  /** 这次重发使用的工作流。 */
  workflow?: WorkflowSkill;
}

/**
 * 回滚到某条用户消息之前（删除这条及之后的记录）。
 *
 * - `files` 为 true 时同时把 agent 改过的文件恢复到这条消息之前；服务端
 *   不支持文件检查点时返回 409。
 * - 带 `options.prompt` 时服务端会先回滚，再用编辑后的内容重新发送。
 */
export function rewindSession(
  id: string,
  messageId: string,
  files?: boolean,
  options?: RewindOptions,
  signal?: AbortSignal,
): Promise<RewindResult> {
  const body = buildRewindBody(messageId, files, options);
  return request<RewindResult>(
    `/api/sessions/${encodeURIComponent(id)}/rewind`,
    { method: "POST", body: JSON.stringify(body) },
    signal,
    REWIND_TIMEOUT_MS,
  );
}

/** 从某条用户消息分叉出一个独立对话；父对话不变。 */
export function forkSession(
  id: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<{ session: Session }> {
  return request<{ session: Session }>(
    `/api/sessions/${encodeURIComponent(id)}/fork`,
    { method: "POST", body: JSON.stringify({ messageId }) },
    signal,
    REWIND_TIMEOUT_MS,
  );
}
