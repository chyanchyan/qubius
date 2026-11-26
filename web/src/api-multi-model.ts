import { request, type Effort } from "./api";

/**
 * 多模型并行对比的分组记录接口；类型与服务端 `multi-model-groups.ts` 一致。
 *
 * 分组由服务端持久化，因此换浏览器、换设备也能看到同一项目的对比记录。
 */

/** 分组里的一个会话快照；只保存对比需要的字段，不存会话正文。 */
export interface MultiModelGroupMember {
  id: string;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  title: string;
}

/** 同一 prompt 创建的一组会话。 */
export interface MultiModelGroup {
  id: string;
  projectId: string;
  createdAt: string;
  promptPreview: string;
  sessions: MultiModelGroupMember[];
}

/** 新建分组的请求体；id / createdAt 由服务端生成。 */
export interface MultiModelGroupInput {
  promptPreview?: string;
  sessions: MultiModelGroupMember[];
}

function groupsPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/multi-model-groups`;
}

/** 读取某个项目的对比记录（服务端已按“最新在前”返回）。 */
export function getMultiModelGroups(
  projectId: string,
  signal?: AbortSignal,
): Promise<{ groups: MultiModelGroup[] }> {
  return request<{ groups: MultiModelGroup[] }>(groupsPath(projectId), undefined, signal);
}

/** 保存一组对比记录；服务端校验会话并生成 id / createdAt。 */
export function createMultiModelGroup(
  projectId: string,
  body: MultiModelGroupInput,
  signal?: AbortSignal,
): Promise<{ group: MultiModelGroup }> {
  return request<{ group: MultiModelGroup }>(
    groupsPath(projectId),
    { method: "POST", body: JSON.stringify(body) },
    signal,
  );
}

/** 删除一组对比记录。 */
export function deleteMultiModelGroup(
  projectId: string,
  groupId: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `${groupsPath(projectId)}/${encodeURIComponent(groupId)}`,
    { method: "DELETE" },
    signal,
  );
}
