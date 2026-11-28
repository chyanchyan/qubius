import type { Session } from "./api";

/**
 * 项目页发送后、服务端创建完成前的本地占位行。
 *
 * git 项目每开一个对话都要 `git worktree add`，服务端创建请求常常要一两秒；
 * 这段时间列表如果什么都不显示，看起来像消息没发出去。这里先把一条
 * 「正在创建对话…」插进列表，POST 返回后再换成真实会话。
 */
export interface PendingSession {
  /** 本地临时 id，前缀 `local-`，不会与真实会话 UUID 冲突。 */
  id: string;
  projectId: string;
  title: string;
  /** 提交时刻（毫秒），用于排序。 */
  startedAt: number;
  /**
   * 插入占位行时列表里已有的会话 id。SSE 可能比 POST 响应先带回真实会话，
   * 只有“之后新出现”的同标题会话才算这一条，避免把旧会话误认成新对话。
   */
  knownIds: ReadonlySet<string>;
}

function localId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `local-${uuid}`;
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 只发图片、没有文字时的占位标题，与服务端 createSession 一致。 */
export const PROVISIONAL_TITLE = "新对话";

/**
 * 新建会话的初始标题，规则与服务端 session-title.ts 的 titleFromPrompt 一致：
 * 取首条用户消息的第一行，折叠空白；没有文字时退回占位词。两边必须逐字
 * 一致，matchesPending 靠标题把 SSE 先到的真实会话认回这条占位行。
 */
export function pendingTitle(prompt: string): string {
  const firstLine = prompt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const title = firstLine.replace(/\s+/g, " ").trim();
  return title || PROVISIONAL_TITLE;
}

export function beginPendingSession(options: {
  projectId: string;
  existingIds: Iterable<string>;
  /** 即将发给 createSession 的正文；占位行标题由它推导，与服务端一致。 */
  prompt: string;
  now?: number;
}): PendingSession {
  return {
    id: localId(),
    projectId: options.projectId,
    title: pendingTitle(options.prompt),
    startedAt: options.now ?? Date.now(),
    knownIds: new Set(options.existingIds),
  };
}

/** 服务端刚创建的会话是否就是这条占位行。 */
export function matchesPending(pending: PendingSession, session: Session): boolean {
  return session.projectId === pending.projectId
    && session.title === pending.title
    && !pending.knownIds.has(session.id);
}

/**
 * 去掉已经被真实会话替代的占位行；没有变化时返回原数组，避免无意义的重新渲染。
 */
export function dropMatchedPending(
  pending: readonly PendingSession[],
  sessions: readonly Session[],
): readonly PendingSession[] {
  if (pending.length === 0) return pending;
  const kept = pending.filter((item) => !sessions.some((session) => matchesPending(item, session)));
  return kept.length === pending.length ? pending : kept;
}
