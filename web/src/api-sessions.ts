import { request, type Effort, type QueueEntry, type Session } from "./api";

/**
 * 跨项目的会话接口。单项目列表仍在 api.ts 的 getSessions 里；这里提供
 * 总览页需要的「全部项目」查询和会话级的修改/排队撤回。
 */

export interface SessionPatch {
  title?: string;
  pinned?: boolean;
  providerId?: string;
  model?: string;
  effort?: Effort;
}

/** 全部项目的会话，服务端按 pinned 优先、createdAt 降序返回。 */
export function listAllSessions(q?: string, signal?: AbortSignal): Promise<{ sessions: Session[] }> {
  const query = q?.trim() ?? "";
  const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
  return request<{ sessions: Session[] }>(`/api/sessions${suffix}`, undefined, signal);
}

export function patchSession(id: string, patch: SessionPatch, signal?: AbortSignal): Promise<{ session: Session }> {
  return request<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }, signal);
}

/** 读取一条排队消息的完整正文（队列快照里的 text 会截断，编辑时再取）。 */
export function getQueuedPrompt(
  id: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<{ entry: QueueEntry }> {
  return request<{ entry: QueueEntry }>(
    `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(promptId)}`,
    undefined,
    signal,
  );
}

/** 改写一条排队消息的正文；图片和其它字段保持不变。 */
export function editQueuedPrompt(
  id: string,
  promptId: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ session: Session }> {
  return request<{ session: Session }>(
    `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(promptId)}`,
    { method: "PATCH", body: JSON.stringify({ text }) },
    signal,
  );
}

/** 「现在发送」：提前放行这条排队消息（正在跑的会折叠进当前轮）。 */
export function sendQueuedPromptNow(
  id: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<{ session: Session }> {
  return request<{ session: Session }>(
    `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(promptId)}/send`,
    { method: "POST", body: "{}" },
    signal,
  );
}

/** 删除一条排队消息：队列和对话记录一起移除。 */
export function cancelQueuedPrompt(id: string, promptId: string, signal?: AbortSignal): Promise<{ session: Session }> {
  return request<{ session: Session }>(
    `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(promptId)}`,
    { method: "DELETE" },
    signal,
  );
}
