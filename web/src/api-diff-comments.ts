import { request } from "./api";

/** 评论锚定在 diff 的哪一侧：旧文件（删除行）或新文件（新增/上下文行）。 */
export type DiffCommentSide = "old" | "new";

/** 一条 diff 行级评论；与服务端 `diff-comments.ts` 的存储结构一致。 */
export interface DiffComment {
  id: string;
  /** 文件名，和 `diff --git a/x b/x` 里的显示名一致。 */
  file: string;
  side: DiffCommentSide;
  /** 文件内行号（side 对应的 old/new 行号）。 */
  line: number;
  text: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 新建评论的请求体。 */
export interface DiffCommentInput {
  file: string;
  side: DiffCommentSide;
  line: number;
  text: string;
}

/** 更新评论：只改文字或解决状态。 */
export interface DiffCommentPatch {
  text?: string;
  resolved?: boolean;
}

function commentsPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/diff-comments`;
}

/** 读取会话的全部行级评论（包括已解决的）。 */
export function getDiffComments(
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ comments: DiffComment[] }> {
  return request<{ comments: DiffComment[] }>(commentsPath(sessionId), undefined, signal);
}

/** 在指定文件/侧/行上新建一条评论。 */
export function createDiffComment(
  sessionId: string,
  body: DiffCommentInput,
  signal?: AbortSignal,
): Promise<{ comment: DiffComment }> {
  return request<{ comment: DiffComment }>(
    commentsPath(sessionId),
    { method: "POST", body: JSON.stringify(body) },
    signal,
  );
}

/** 修改评论文字或标记为已解决/重新打开。 */
export function updateDiffComment(
  sessionId: string,
  commentId: string,
  body: DiffCommentPatch,
  signal?: AbortSignal,
): Promise<{ comment: DiffComment }> {
  return request<{ comment: DiffComment }>(
    `${commentsPath(sessionId)}/${encodeURIComponent(commentId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
    signal,
  );
}

/** 删除一条评论。 */
export function deleteDiffComment(
  sessionId: string,
  commentId: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `${commentsPath(sessionId)}/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
    signal,
  );
}

/** 清空会话的全部评论。 */
export function clearDiffComments(sessionId: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return request<{ ok: true }>(commentsPath(sessionId), { method: "DELETE" }, signal);
}
