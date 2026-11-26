import assert from "node:assert/strict";
import test from "node:test";
import { SseQueue } from "./sse.js";
import type { SessionEvent } from "./store.js";

function event(id: string, summary: string): SessionEvent {
  return { id, summary } as unknown as SessionEvent;
}

test("SseQueue：能写时立即发送，每个事件都送达", () => {
  const written: string[] = [];
  const queue = new SseQueue((payload) => {
    written.push(payload.summary ?? "");
    return true;
  });
  queue.enqueue("a", () => event("a", "1"));
  queue.enqueue("a", () => event("a", "2"));
  queue.enqueue("b", () => event("b", "3"));
  assert.deepEqual(written, ["1", "2", "3"]);
  assert.equal(queue.isBlocked, false);
});

test("SseQueue：背压后不写也不构建，drain 时只补最新一条", () => {
  let accept = false;
  let builds = 0;
  const written: string[] = [];
  const queue = new SseQueue((payload) => {
    written.push(payload.summary ?? "");
    return accept;
  });

  queue.enqueue("s", () => { builds += 1; return event("s", "first"); });
  // 第一次写就吃满缓冲：事件已进缓冲，不需要重发。
  assert.deepEqual(written, ["first"]);
  assert.equal(queue.isBlocked, true);

  // 阻塞期间事件只合并，不构建、不写。
  queue.enqueue("s", () => { builds += 1; return event("s", "stale"); });
  queue.enqueue("s", () => { builds += 1; return event("s", "latest"); });
  assert.deepEqual(written, ["first"]);
  assert.equal(builds, 1);

  accept = true;
  queue.drain();
  assert.deepEqual(written, ["first", "latest"]);
  assert.equal(builds, 2);
  assert.equal(queue.isBlocked, false);
});

test("SseQueue：阻塞时不同 key 各自保留最新状态", () => {
  let accept = false;
  const written: string[] = [];
  const queue = new SseQueue((payload) => {
    written.push(payload.summary ?? "");
    return accept;
  });
  queue.enqueue("a", () => event("a", "a1"));
  // 此时已阻塞；下面的事件只进 pending。
  queue.enqueue("b", () => event("b", "b1"));
  queue.enqueue("a", () => event("a", "a2"));

  accept = true;
  queue.drain();
  // a1 写入时已出队；阻塞后 b 先入队、a 的最新增量后入队，按插入顺序补发。
  assert.deepEqual(written, ["a1", "b1", "a2"]);
});

test("SseQueue：构建器返回 null 时不写", () => {
  const written: SessionEvent[] = [];
  const queue = new SseQueue((payload) => {
    written.push(payload);
    return true;
  });
  queue.enqueue("gone", () => null);
  assert.equal(written.length, 0);
  assert.equal(queue.isBlocked, false);
});

test("SseQueue：写入抛错按背压处理，不重复写", () => {
  let calls = 0;
  const queue = new SseQueue(() => {
    calls += 1;
    throw new Error("socket closed");
  });
  queue.enqueue("a", () => event("a", "1"));
  queue.enqueue("a", () => event("a", "2"));
  assert.equal(calls, 1);
  assert.equal(queue.isBlocked, true);
});
