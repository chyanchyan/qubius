/**
 * 每个会话同一时刻只允许一个“清理”类操作：sweeper 归档删除、手动 DELETE、
 * 归档恢复。HTTP 写入接口看到锁会返回 409，避免整理期间用户的新消息被
 * 随后一起删掉。锁是进程内的；服务重启后自然清空。
 */
const busy = new Set<string>();

export function isSessionBusy(id: string): boolean {
  return busy.has(id);
}

/** 非阻塞加锁；已有操作持锁时返回 false。 */
export function tryLockSession(id: string): boolean {
  if (busy.has(id)) return false;
  busy.add(id);
  return true;
}

export function unlockSession(id: string): void {
  busy.delete(id);
}
