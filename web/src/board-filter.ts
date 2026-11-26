import type { Session } from "./api";
import type { PendingSession } from "./pending-session";

/**
 * 项目页列表行的关键词过滤。
 *
 * 列表行要么是真实会话，要么是发送后还在创建的占位行。过滤只按用户能看到的
 * 标题、摘要和分支名匹配，大小写不敏感；排队中、等待确认和运行中的会话始终
 * 显示，避免用户搜索时把需要处理或马上要跑的行藏起来。
 */

/** 列表行：真实会话，或发送后还在创建的本地占位行。 */
export type BoardEntry =
  | { kind: "session"; session: Session }
  | { kind: "pending"; pending: PendingSession };

function needleOf(query: string): string {
  return query.trim().toLowerCase();
}

function includesText(value: string | undefined, needle: string): boolean {
  return typeof value === "string" && value.toLowerCase().includes(needle);
}

/** 行本身的标题/摘要/分支是否匹配关键词；空关键词视为匹配。 */
export function boardEntryMatches(entry: BoardEntry, query: string): boolean {
  const needle = needleOf(query);
  if (!needle) return true;
  if (entry.kind === "pending") return false;
  const { session } = entry;
  return includesText(session.title, needle)
    || includesText(session.summary, needle)
    || includesText(session.branch, needle);
}

/**
 * 即使不匹配也必须保留的行：创建中的占位行、排队中、等待确认、正在运行的会话。
 * 搜索时它们不会消失，但会在提示里单独计数。
 *
 * needs_input 可能没有 pending（例如等待用户输入而不是工具确认），只按 phase
 * 判断也能保留；queued 还没开始跑，但已经在队列里，同样不能藏起来。
 */
export function isBoardEntryAlwaysVisible(entry: BoardEntry): boolean {
  if (entry.kind === "pending") return true;
  const { session } = entry;
  return Boolean(session.pending)
    || session.phase === "queued"
    || session.phase === "running"
    || session.phase === "needs_input";
}

/**
 * 按关键词过滤列表行。
 *
 * 空查询返回原列表的副本；创建中、排队中、等待确认和运行中的行始终保留，
 * 其余行按标题、摘要、分支名做大小写不敏感的子串匹配。
 */
export function filterBoardEntries(
  entries: readonly BoardEntry[],
  query: string,
): BoardEntry[] {
  const needle = needleOf(query);
  if (!needle) return [...entries];
  return entries.filter((entry) => (
    isBoardEntryAlwaysVisible(entry) || boardEntryMatches(entry, needle)
  ));
}
