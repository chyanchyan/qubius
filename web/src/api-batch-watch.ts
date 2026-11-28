import { request, type Effort, type Phase } from "./api";

export type BatchMergeMode = "none" | "merge" | "rebase";

export type BatchWatchStatus =
  | "waiting"
  | "paused"
  | "launching"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export interface BatchWatchActions {
  commit: boolean;
  mergeMode: BatchMergeMode;
  push: boolean;
  deploy: boolean;
  baseBranch?: string;
}

export interface BatchWatchTargetView {
  sessionId: string;
  title: string;
  branch?: string;
  skipped?: boolean;
  phase: Phase | "missing";
  currentTitle: string;
  cwd?: string;
  lastError?: string;
  ready: boolean;
  blocker?: string;
}

export interface BatchWatch {
  id: string;
  projectId: string;
  providerId: string;
  providerName: string;
  model: string;
  effort: Effort;
  actions: BatchWatchActions;
  extraPrompt?: string;
  status: BatchWatchStatus;
  pauseReason?: string;
  pausedSessionIds?: string[];
  reviewSessionId?: string;
  reviewPhase?: Phase | "missing";
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  targetViews: BatchWatchTargetView[];
}

export interface CreateBatchWatchInput {
  sessionIds: string[];
  providerId: string;
  model: string;
  effort: Effort;
  actions: BatchWatchActions;
  extraPrompt?: string;
}

export function getBatchWatches(
  projectId: string,
  signal?: AbortSignal,
): Promise<{ watches: BatchWatch[] }> {
  return request<{ watches: BatchWatch[] }>(`/api/projects/${projectId}/batch-watches`, undefined, signal);
}

export function createBatchWatch(
  projectId: string,
  body: CreateBatchWatchInput,
  signal?: AbortSignal,
): Promise<{ watch: BatchWatch }> {
  return request<{ watch: BatchWatch }>(
    `/api/projects/${projectId}/batch-watches`,
    { method: "POST", body: JSON.stringify(body) },
    signal,
  );
}

/** 修改等待/暂停中的监听任务被监听的会话集合。 */
export function updateBatchWatchTargets(
  projectId: string,
  watchId: string,
  sessionIds: readonly string[],
  signal?: AbortSignal,
): Promise<{ watch: BatchWatch }> {
  return request<{ watch: BatchWatch }>(
    `/api/projects/${projectId}/batch-watches/${watchId}`,
    { method: "PATCH", body: JSON.stringify({ sessionIds }) },
    signal,
  );
}

export function resumeBatchWatch(
  projectId: string,
  watchId: string,
  options: { skipBlockers?: boolean; skipSessionId?: string } = {},
  signal?: AbortSignal,
): Promise<{ watch: BatchWatch }> {
  return request<{ watch: BatchWatch }>(
    `/api/projects/${projectId}/batch-watches/${watchId}/resume`,
    { method: "POST", body: JSON.stringify(options) },
    signal,
  );
}

export function cancelBatchWatch(
  projectId: string,
  watchId: string,
  signal?: AbortSignal,
): Promise<{ watch: BatchWatch }> {
  return request<{ watch: BatchWatch }>(
    `/api/projects/${projectId}/batch-watches/${watchId}/cancel`,
    { method: "POST", body: "{}" },
    signal,
  );
}

export function deleteBatchWatch(
  projectId: string,
  watchId: string,
  signal?: AbortSignal,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/projects/${projectId}/batch-watches/${watchId}`,
    { method: "DELETE" },
    signal,
  );
}
