import type { BatchMergeMode, BatchWatch, BatchWatchActions, BatchWatchStatus } from "./api-batch-watch";
import type { Session } from "./api";

export const WATCH_STATUS_LABEL: Record<BatchWatchStatus, string> = {
  waiting: "脚本监听中",
  paused: "已暂停（待处理）",
  launching: "正在采集改动",
  reviewing: "审核整合中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const MERGE_MODE_LABEL: Record<BatchMergeMode, string> = {
  none: "不合入主分支",
  merge: "Merge 合并",
  rebase: "Rebase 变基合并",
};

/** 收尾动作摘要标签，便于在任务卡片里一眼看清配置。 */
export function summarizeActions(actions: BatchWatchActions): string {
  const parts: string[] = [];
  if (actions.commit) parts.push("提交");
  if (actions.mergeMode === "merge") parts.push(`合并→${actions.baseBranch || "main"}`);
  else if (actions.mergeMode === "rebase") parts.push(`Rebase→${actions.baseBranch || "main"}`);
  if (actions.push) parts.push("推送");
  if (actions.deploy) parts.push("部署");
  return parts.length > 0 ? parts.join(" · ") : "仅审核修订（不提交）";
}

/** 联动校验并修正复选框状态，保证勾选顺序合法。 */
export function toggleWatchAction(
  current: BatchWatchActions,
  patch: Partial<BatchWatchActions>,
): BatchWatchActions {
  const next: BatchWatchActions = { ...current, ...patch };
  // 合并/推送必须先提交。
  if ((patch.mergeMode && patch.mergeMode !== "none") || patch.push === true) {
    next.commit = true;
  }
  // 取消提交时，联动关闭合并、推送和部署。
  if (patch.commit === false) {
    next.mergeMode = "none";
    next.push = false;
    next.deploy = false;
  }
  // 勾选部署时，如果当前未合入，自动切到 merge 并勾选提交。
  if (patch.deploy === true && next.mergeMode === "none") {
    next.commit = true;
    next.mergeMode = "merge";
  }
  // 取消合入时，联动关闭部署。
  if (patch.mergeMode === "none") {
    next.deploy = false;
  }
  return next;
}

/** 默认预选：优先选当前项目下运行中/排队/等待确认的会话；都没有时返回空集合。 */
export function defaultWatchSessionIds(sessions: readonly Session[]): string[] {
  return sessions
    .filter((item) => item.phase === "running" || item.phase === "queued" || item.phase === "needs_input")
    .map((item) => item.id);
}

/** 统计仍在活跃（监听/暂停/审核中）的任务数，用于入口按钮徽章。 */
export function activeWatchCount(watches: readonly BatchWatch[]): number {
  return watches.filter((item) =>
    item.status === "waiting"
    || item.status === "paused"
    || item.status === "launching"
    || item.status === "reviewing",
  ).length;
}
