import type { QueueEntry, Session } from "./api";

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

/**
 * 这条消息会不会进入排队（而不是立即交给 agent）。
 *
 * 与服务端 submit 的规则保持一致：本轮进行中/等确认，或已经有没被取走的
 * 消息时默认排队；插话（Ctrl+Enter / 长按发送）总是立即放行。排队消息在
 * agent 真正取走前只显示在排队面板里，不做记录区的乐观渲染。
 */
export function willQueue(
  session: Pick<Session, "phase" | "queue">,
  interject: boolean,
): boolean {
  if (interject) return false;
  return session.phase === "queued"
    || session.phase === "running"
    || session.phase === "needs_input"
    || (session.queue?.length ?? 0) > 0;
}
