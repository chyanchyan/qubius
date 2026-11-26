import type { OutgoingImage, Session, Transcript } from "./api";

/**
 * 发送消息的本地乐观渲染。
 *
 * 网络往返和 SSE 回显都要时间，等它们回来再画会让刚发出的内容“消失一拍”。
 * 这里先在本地记录末尾放一条带 `status: "sending"` 的临时用户消息，POST
 * 返回后由真实条目整体替换；失败则删掉临时条目并恢复输入区。
 */

/** 乐观条目的 id 前缀独立于服务端 UUID，不会与真实消息冲突。 */
const LOCAL_ID_PREFIX = "local-";

function localId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${LOCAL_ID_PREFIX}${uuid}`;
  return `${LOCAL_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isOptimistic(item: Transcript): boolean {
  return item.status === "sending";
}

/** 构造一条发送中的用户消息；图片用本地 data URL 预览。 */
export function optimisticUserMessage(
  text: string,
  images: OutgoingImage[] = [],
  now: string = new Date().toISOString(),
): Transcript {
  const item: Transcript = {
    id: localId(),
    role: "user",
    text,
    at: now,
    status: "sending",
  };
  if (images.length > 0) item.pendingImages = images.map((image) => ({ ...image }));
  return item;
}

/** 把乐观消息接到本地记录末尾（已有同 id 时不重复追加）。 */
export function appendOptimistic(session: Session, item: Transcript): Session {
  const messages = session.messages ?? [];
  if (messages.some((message) => message.id === item.id)) return session;
  return { ...session, messages: [...messages, item] };
}

/** 移除一条乐观消息；不存在时原样返回，避免无意义的重新渲染。 */
export function dropOptimistic(session: Session, id: string): Session {
  const messages = session.messages;
  if (!messages?.some((message) => message.id === id)) return session;
  return { ...session, messages: messages.filter((message) => message.id !== id) };
}

/**
 * 一次发送期间需要记住的信息：临时条目，以及服务端在发送前的消息总数。
 * `baseCount` 用来判断新帧里是否已经包含这条消息（服务端总数涨了即已落库）。
 */
export interface OptimisticSend {
  item: Transcript;
  baseCount: number;
}

export function beginOptimisticSend(
  session: Session,
  text: string,
  images: OutgoingImage[] = [],
): OptimisticSend {
  return {
    item: optimisticUserMessage(text, images),
    baseCount: session.messageCount ?? session.messages?.length ?? 0,
  };
}

/**
 * 把服务端数据与在途的乐观消息对齐。
 *
 * - 服务端消息总数已经超过发送前（说明这条已经落库）：删掉本地临时条目，
 *   以服务端条目为准。
 * - 还没超过（帧比 POST 旧）：重新把临时条目接回末尾，避免它被旧帧冲掉。
 */
export function reconcileOptimistic(
  session: Session,
  pending: OptimisticSend | null,
): Session {
  if (!pending) return session;
  const count = session.messageCount ?? session.messages?.length ?? 0;
  return count > pending.baseCount
    ? dropOptimistic(session, pending.item.id)
    : appendOptimistic(session, pending.item);
}
