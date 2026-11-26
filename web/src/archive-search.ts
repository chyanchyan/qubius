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
