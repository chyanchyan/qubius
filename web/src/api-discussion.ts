import { request, type DiscussionParticipant, type Session } from "./api";

/**
 * 多模型讨论接口。参与者由客户端表单收集，开始讨论时一次性提交并落库；
 * 讨论过程中的每一轮发言由服务端写入对话记录，通过 SSE 推回来。
 */
export function startDiscussion(
  id: string,
  participants: DiscussionParticipant[],
  signal?: AbortSignal,
): Promise<{ session: Session }> {
  return request<{ session: Session }>(
    `/api/sessions/${encodeURIComponent(id)}/discussion/start`,
    { method: "POST", body: JSON.stringify({ participants }) },
    signal,
  );
}
