import type { BatchMergeMode, BatchWatch, BatchWatchActions, BatchWatchStatus } from "./api-batch-watch";
import type { Session } from "./api";

/** 与服务端 MAX_WATCH_SESSIONS 保持一致，表单侧提前拦住超限。 */
export const MAX_WATCH_SESSIONS = 20;

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

/**
 * 是否把这条监听任务作为列表里的「会话条目」展示。
 * 脚本监听/暂停/启动阶段还没有对应的整合审核会话，需要在列表里露出来；
 * 进入 reviewing 后整合审核会话本身已经是普通会话条目，避免重复。
 */
export function isWatchInBoard(watch: BatchWatch): boolean {
  return watch.status === "waiting" || watch.status === "paused" || watch.status === "launching";
}

/** 只有还没开始审核整合（脚本监听中或暂停）的任务才能增减被监听的会话。 */
export function watchCanEditTargets(watch: BatchWatch): boolean {
  return watch.status === "waiting" || watch.status === "paused";
}

/** 列表行标题：优先用来源会话的当前标题，方便和普通会话条目放在一起识别。 */
export function watchTitle(watch: BatchWatch): string {
  const count = watch.targetViews.length;
  const first = watch.targetViews[0]?.currentTitle?.trim();
  if (count === 0) return "监听任务";
  if (count === 1) return first ? `监听 · ${first}` : "监听 · 1 个会话";
  return first ? `监听 · ${first} 等 ${count} 个会话` : `监听 · ${count} 个会话`;
}

/** 就绪会话数（被跳过或已完成），列表右侧进度和徽章共用。 */
export function watchReadyCount(watch: BatchWatch): number {
  return watch.targetViews.filter((target) => target.ready).length;
}
