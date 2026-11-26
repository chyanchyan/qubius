import { request } from "./api";

export interface GitStatus {
  branch: string;
  clean: boolean;
  dirty: string[];
}

export interface GitPushResult {
  branch: string;
  committed: boolean;
  pushed: boolean;
  output: string;
}

/** 项目里已合入基准分支的会话分支，用于列表里的分支标签和批量归档过滤。 */
export interface MergeStatus {
  /** 基准分支短名（main / master / origin/main…）；项目不是 git 或找不到时为 null。 */
  base: string | null;
  /** 已经合入 base 的会话分支名。 */
  merged: string[];
  /** 创建后从未提交过代码的会话分支名：分支没有带来任何改动。 */
  untouched: string[];
}

export function getMergeStatus(projectId: string, signal?: AbortSignal): Promise<MergeStatus> {
  return request(`/api/projects/${projectId}/merge-status`, undefined, signal);
}

export type GitAction = "commit" | "commit-push" | "push";

export interface GitActionBody {
  action: GitAction;
  message?: string;
}

// push 可能要等远端握手和传输，比普通请求宽松。
const GIT_ACTION_TIMEOUT_MS = 120_000;

export function getGitStatus(id: string, signal?: AbortSignal): Promise<GitStatus> {
  return request(`/api/sessions/${id}/git`, undefined, signal);
}

export function runGitAction(id: string, body: GitActionBody, signal?: AbortSignal): Promise<GitPushResult> {
  return request(
    `/api/sessions/${id}/git`,
    { method: "POST", body: JSON.stringify(body) },
    signal,
    GIT_ACTION_TIMEOUT_MS,
  );
}
