import type { SessionEvent } from "./store.js";

/** 返回 false 表示写缓冲已满，与 `stream.Writable#write` 的语义一致。 */
export type SseSink = (payload: SessionEvent) => boolean;

/**
 * 单条 SSE 连接的合并写队列。
 *
 * 慢连接（手机切后台、网络抖动）不会及时读走数据。写缓冲满后必须停止写，
 * 否则每个流式 delta 都会把完整会话 detail 叠进 Node 的写缓冲，长会话可以
 * 把堆撑到上限（qubius 主实例 502 的 OOM 事故）。这里在阻塞期间只保留每个
 * key 最新的构建器，drain 后再执行构建并补发最新状态，内存占用与事件量无关。
 */
export class SseQueue {
  private blocked = false;
  /** key 通常是会话 id；同一 key 只保留最后入队的状态。 */
  private readonly pending = new Map<string, () => SessionEvent | null>();

  constructor(private readonly sink: SseSink) {}

  /** 连接已经阻塞在背压上；心跳等旁路写入也应暂停。 */
  get isBlocked(): boolean {
    return this.blocked;
  }

  /** build 是惰性的：只有真正能写时才会被调用，阻塞期间不会反复序列化。 */
  enqueue(key: string, build: () => SessionEvent | null): void {
    this.pending.set(key, build);
    this.flush();
  }

  /** 对应响应流的 `drain` 事件。 */
  drain(): void {
    this.blocked = false;
    this.flush();
  }

  private flush(): void {
    if (this.blocked) return;
    for (const [key, build] of this.pending) {
      if (this.blocked) return;
      // 先出队：写入失败时数据已经进了缓冲，不需要再发一次。
      this.pending.delete(key);
      const payload = build();
      if (!payload) continue;
      try {
        if (!this.sink(payload)) this.blocked = true;
      } catch {
        // 写失败（连接已经断了）由调用方的 error/close 回调负责退订。
        this.blocked = true;
      }
    }
  }
}
