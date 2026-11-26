import type { ArchivedSession } from "./api";

/**
 * 归档列表的关键词过滤。归档列表只有元数据，不加载 transcript，所以匹配
 * 标题、摘要、接口名和模型名；大小写不敏感，空 query 返回原列表的副本。
 */
export function filterArchivedSessions(
  sessions: readonly ArchivedSession[],
  query: string,
): ArchivedSession[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sessions];
  return sessions.filter((item) => (
    [item.title, item.summary, item.providerName, item.model]
      .some((text) => typeof text === "string" && text.toLowerCase().includes(needle))
  ));
}

/**
 * 冷备已完成、本机副本还在的归档条目。面板用「待清理」样式展示，并且只
 * 提供「重试清理」（恢复会被服务端拒绝）。
 * 旧服务端不返回 local 字段，这时按本机还有副本处理：pendingDelete 本来就
 * 只会在那种状态下出现。
 */
export function isPendingCleanup(
  item: Pick<ArchivedSession, "pendingDelete" | "local">,
): boolean {
  return item.pendingDelete === true && item.local !== false;
}
