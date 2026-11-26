/**
 * 同一会话的 git 写操作共用一把进程内锁。
 *
 * GitPanel 的 commit/push 和创建 PR/MR 前的 push 都走这里，避免两个流程
 * 同时操作同一个工作区或分支。非阻塞：已有操作持锁时立刻报错，由调用方
 * 返回 409。锁是进程内的，服务重启后自然清空。
 */
const active = new Set<string>();

export class GitActionBusyError extends Error {
  constructor(message = "这个对话已有 git 操作在进行") {
    super(message);
    this.name = "GitActionBusyError";
  }
}

export function isGitActionActive(id: string): boolean {
  return active.has(id);
}

/**
 * 占用会话的 git 锁执行 fn；无论成功还是抛错都会在 finally 释放。
 * 已有操作持锁时抛 GitActionBusyError。
 */
export async function withGitAction<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (active.has(id)) throw new GitActionBusyError();
  active.add(id);
  try {
    return await fn();
  } finally {
    active.delete(id);
  }
}
