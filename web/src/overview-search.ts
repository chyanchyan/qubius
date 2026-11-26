import type { Session } from "./api";

/**
 * 总览页在“搜索态”下合并单条会话更新的纯逻辑。
 *
 * 关键约束：SSE 帧和大多数本地响应只带 title/summary，不带 messages；
 * 服务端搜索还会匹配消息正文。因此不能用新帧的 title/summary 直接否定
 * 一条已经在结果里的内容命中，只有“旧行字段本来命中、新行字段不再命中”
 * 才从搜索结果里移除。
 */

/** 服务端已按 pinned 优先排好；本地改动后重新排序，保持同一约定。 */
export function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => {
    const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pin !== 0) return pin;
    if (a.createdAt < b.createdAt) return 1;
    if (a.createdAt > b.createdAt) return -1;
    return 0;
  });
}

/** 只判断 title/summary 是否命中；不含 messages（SSE 摘要没有正文）。 */
export function matchesSessionQuery(session: Session, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (session.title ?? "").toLowerCase().includes(needle)
    || (session.summary ?? "").toLowerCase().includes(needle);
}

/**
 * 把单条更新放进当前列表：
 * - 未搜索：替换/插入并保持排序。
 * - 搜索中且是新会话：只有 title/summary 命中才插入。
 * - 搜索中且已有会话：旧行字段命中、新行字段不再命中时移除；
 *   旧行本来就只是正文命中时保留（SSE 帧无法判断正文）。
 */
export function applySessionUpdate(current: Session[], next: Session, query: string): Session[] {
  const searching = query.trim().length > 0;
  const index = current.findIndex((item) => item.id === next.id);
  if (index === -1) {
    if (searching && !matchesSessionQuery(next, query)) return current;
    return sortSessions([...current, next]);
  }

  const existing = current[index]!;
  if (searching && !matchesSessionQuery(next, query) && matchesSessionQuery(existing, query)) {
    return current.filter((item) => item.id !== next.id);
  }

  const updated = current.slice();
  updated[index] = next;
  /* 排序只看 pinned 和 createdAt；这两项没变时原位替换即可，避免每个 token 重排。 */
  if (existing.pinned === next.pinned && existing.createdAt === next.createdAt) return updated;
  return sortSessions(updated);
}

export function applySessionRemoved(current: Session[], id: string): Session[] {
  return current.some((item) => item.id === id)
    ? current.filter((item) => item.id !== id)
    : current;
}
