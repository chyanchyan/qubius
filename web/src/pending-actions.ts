/**
 * 列表/总览里「正在回答某个会话」的在途集合。
 *
 * 按会话 id 分别记录，会话之间互不影响：回答 A 不会让 B 的按钮变灰。
 * 同一个 id 只保留一份，重复添加返回 null，用来挡住同一会话的连点。
 * 所有操作都返回新的 Set，不修改传入的集合，方便直接交给 React state。
 */

/** 某个会话是否有在途回答。 */
export function hasPending(pending: ReadonlySet<string>, id: string): boolean {
  return pending.has(id);
}

/** 把 id 加入在途集合；已存在时返回 null，调用方据此跳过重复请求。 */
export function addPending(pending: ReadonlySet<string>, id: string): Set<string> | null {
  if (pending.has(id)) return null;
  const next = new Set(pending);
  next.add(id);
  return next;
}

/** 从在途集合移除 id；只影响这一个会话。 */
export function removePending(pending: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(pending);
  next.delete(id);
  return next;
}
