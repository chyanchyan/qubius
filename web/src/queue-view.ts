import type { QueueEntry } from "./api";

/**
 * 排队消息在列表里的一行预览：取正文第一行；纯图片/空正文给出占位文案。
 * 完整正文只在编辑时按需拉取，避免每帧快照都带着长文本。
 */
export function queueEntryPreview(entry: Pick<QueueEntry, "text" | "images">): string {
  const first = entry.text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (first) return first;
  return entry.images > 0 ? "（图片）" : "（空消息）";
}

/** 排队面板标题；折叠后仍能看到条数。 */
export function queueSummary(count: number): string {
  return count > 0 ? `排队 ${count} 条` : "没有排队消息";
}
