import type { Session } from "./api";

/**
 * 归档确认里说明会从 SSD 删除什么。归档只保留对话记录、图片和 transcript：
 * worktree / 分支 / isolated 目录不会进归档，恢复时从当前 HEAD 重建。
 */
export function deleteDetail(session: Pick<Session, "git" | "isolated">): string {
  if (session.isolated) {
    return "会话记录、图片和这次对话自己的目录会从 SSD 删除，开启归档时只保留对话记录、图片和 transcript";
  }
  if (session.git) {
    return "会话记录、图片、git worktree 和分支会从 SSD 删除，开启归档时只保留对话记录、图片和 transcript";
  }
  return "会话记录和图片会从 SSD 删除";
}

/** 所有归档确认框统一追加的恢复说明：开启归档与未开启两种情况都说清楚。 */
export const ARCHIVE_RESTORE_NOTE =
  "服务端开启归档时，可从项目页的归档面板恢复对话上下文；未开启归档时会永久删除、无法恢复。";
