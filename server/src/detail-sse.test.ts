import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_LIMITS, type AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import type { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store, type CreateSessionInput } from "./store.js";
import type { SessionCore, TranscriptItem } from "./types.js";

interface Harness {
  url: string;
  store: Store;
  webDist: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-detail-sse-"));
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [],
    // 小页长便于断言首帧分页；requestBodyBytes 用默认值。
    limits: { ...DEFAULT_LIMITS, historyPage: 2 },
  };
  const store = new Store(dataDir);
  const webDist = path.join(base, "web");
  // SSE 只用到 queueSnapshot；其余 Runtime 方法用不到。
  const runtime = { queueSnapshot: () => [] } as unknown as Runtime;
  const settings = { current: { effort: "high", providers: [], maxConcurrent: 4 } as StoredSettings };
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist,
    settings,
    permissions: { current: {} },
    repoRoot: base,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    webDist,
    close: async () => {
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      // 客户端可能还没来得及发 FIN；主动断开残留的长连接，避免 close 等待超时。
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closing;
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function createSession(harness: Harness, prompts: string[]): string {
  const id = randomUUID();
  const input: CreateSessionInput = {
    id,
    projectId: "p1",
    projectPath: "/tmp/project",
    title: "详情会话",
    providerId: "prov1",
    providerName: "测试接口",
    model: "model-x",
    effort: "high",
    cwd: "/tmp/project",
    git: false,
    prompt: prompts[0] || "",
  };
  harness.store.create(input);
  for (const prompt of prompts.slice(1)) harness.store.addUserMessage(id, prompt);
  return id;
}

interface SseFrame {
  event: string;
  data: Record<string, unknown> & {
    messages?: TranscriptItem[];
    messageCount?: number;
    messagesFrom?: number;
    reset?: boolean;
  };
}

interface SseStream {
  next: (timeout?: number) => Promise<SseFrame>;
  close: () => void;
}

async function openSse(url: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  let failure: unknown;
  let ended = false;

  const consume = () => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) return;
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith(":")) continue; // 心跳注释
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) {
        frames.push({ event, data: JSON.parse(data.join("\n")) as SseFrame["data"] });
      }
    }
  };

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        consume();
      }
    } catch (error) {
      failure = error;
    } finally {
      ended = true;
    }
  })();

  return {
    async next(timeout = 3000): Promise<SseFrame> {
      const deadline = Date.now() + timeout;
      for (;;) {
        const frame = frames.shift();
        if (frame) return frame;
        if (failure) throw failure;
        if (ended) throw new Error("SSE 连接提前结束");
        if (Date.now() > deadline) throw new Error("等待 SSE 帧超时");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close() {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    },
  };
}

/**
 * 直接改 Store 内部状态再广播，模拟 limitTranscript 的前端截断。
 * 公开 API 没有删除消息的入口，这里只用于构造“下标上的 id 已不在”的场景。
 */
function mutateSession(harness: Harness, id: string, mutate: (session: SessionCore) => SessionCore): void {
  const internal = harness.store as unknown as {
    sessions: Map<string, SessionCore>;
    emit: (session: SessionCore) => void;
  };
  const current = internal.sessions.get(id);
  assert.ok(current, "会话应存在");
  const next = mutate(current);
  internal.sessions.set(id, next);
  internal.emit(next);
}

test("详情连接先发全量快照，追加消息只发尾部，元数据帧不带 messages", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["第一条"]);
    const stream = await openSse(`${harness.url}/api/events?session=${id}`);
    try {
      const initial = await stream.next();
      assert.equal(initial.event, "session");
      assert.equal(initial.data.id, id);
      assert.equal(initial.data.title, "详情会话");
      assert.equal(initial.data.messageCount, 1);
      assert.equal(initial.data.messagesFrom, 0);
      // 首帧统一带 reset，客户端用它建立本地历史。
      assert.equal(initial.data.reset, true);
      assert.equal(initial.data.messages?.length, 1);
      assert.equal(initial.data.messages?.[0]?.text, "第一条");
      // 服务端内部标记不应下发。
      assert.equal(initial.data.messages?.[0]?.streaming, undefined);

      harness.store.addUserMessage(id, "第二条");
      const appended = await stream.next();
      assert.equal(appended.event, "session");
      assert.equal(appended.data.messageCount, 2);
      // 第一个变化的条目是新增的第二条（下标 1），客户端从该下标起追加。
      assert.equal(appended.data.messagesFrom, 1);
      assert.equal(appended.data.reset, undefined);
      assert.deepEqual(appended.data.messages?.map((item) => item.text), ["第二条"]);

      harness.store.updateMeta(id, { title: "改过的标题" });
      const metadata = await stream.next();
      assert.equal(metadata.data.title, "改过的标题");
      assert.equal(metadata.data.messageCount, 2);
      assert.equal(metadata.data.messagesFrom, undefined);
      assert.equal(metadata.data.messages, undefined);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("详情连接：同一条流式消息内容变化时从最后一条下标起重发", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["开始"]);
    const stream = await openSse(`${harness.url}/api/events?session=${id}`);
    try {
      const initial = await stream.next();
      assert.equal(initial.data.messagesFrom, 0);
      assert.equal(initial.data.messageCount, 1);

      // 模拟流式增量：id 不变，只追加正文。
      mutateSession(harness, id, (session) => {
        const messages = session.messages.slice();
        const last = messages[messages.length - 1];
        assert.ok(last);
        messages[messages.length - 1] = { ...last, text: `${last.text}，继续输出`, partial: true };
        return { ...session, messages };
      });
      const delta = await stream.next();
      assert.equal(delta.data.messageCount, 1);
      assert.equal(delta.data.messagesFrom, 0);
      assert.deepEqual(delta.data.messages?.map((item) => item.text), ["开始，继续输出"]);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("详情连接：首帧只发最近一页，前面被截断时带 reset 重发一页", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["一", "二", "三"]);
    const stream = await openSse(`${harness.url}/api/events?session=${id}`);
    try {
      const initial = await stream.next();
      assert.equal(initial.data.messageCount, 3);
      // historyPage=2：首帧从下标 1 开始，客户端据此设置 historyStart。
      assert.equal(initial.data.reset, true);
      assert.equal(initial.data.messagesFrom, 1);
      assert.deepEqual(initial.data.messages?.map((item) => item.text), ["二", "三"]);

      // 掉最前面一条：已发送下标上的 id 对不上，客户端不能拼接，改发一页并 reset。
      mutateSession(harness, id, (session) => ({ ...session, messages: session.messages.slice(1) }));
      const truncated = await stream.next();
      assert.equal(truncated.data.messageCount, 2);
      assert.equal(truncated.data.reset, true);
      assert.equal(truncated.data.messagesFrom, 0);
      assert.deepEqual(truncated.data.messages?.map((item) => item.text), ["二", "三"]);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("详情连接：追加消息按完整数组下标发增量，不带 reset", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["一", "二", "三", "四"]);
    const stream = await openSse(`${harness.url}/api/events?session=${id}`);
    try {
      const initial = await stream.next();
      assert.equal(initial.data.messagesFrom, 2);
      assert.deepEqual(initial.data.messages?.map((item) => item.text), ["三", "四"]);

      harness.store.addUserMessage(id, "五");
      const appended = await stream.next();
      assert.equal(appended.data.messageCount, 5);
      assert.equal(appended.data.reset, undefined);
      assert.equal(appended.data.messagesFrom, 4);
      assert.deepEqual(appended.data.messages?.map((item) => item.text), ["五"]);

      // 正常尾部替换：from=4 > sentStart=2，仍不带 reset。
      mutateSession(harness, id, (session) => {
        const messages = session.messages.slice();
        const last = messages[messages.length - 1];
        assert.ok(last);
        messages[messages.length - 1] = { ...last, text: "五（更新）", partial: true };
        return { ...session, messages };
      });
      const tailUpdate = await stream.next();
      assert.equal(tailUpdate.data.messageCount, 5);
      assert.equal(tailUpdate.data.reset, undefined);
      assert.equal(tailUpdate.data.messagesFrom, 4);
      assert.deepEqual(tailUpdate.data.messages?.map((item) => item.text), ["五（更新）"]);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("详情连接：丢下标 1 但长度不变时发 reset 页，而不是 messagesFrom=1 的增量", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["一", "二", "三", "四"]);
    const stream = await openSse(`${harness.url}/api/events?session=${id}`);
    try {
      const initial = await stream.next();
      // historyPage=2：客户端本地窗口从下标 2 开始。
      assert.equal(initial.data.messagesFrom, 2);
      assert.deepEqual(initial.data.messages?.map((item) => item.text), ["三", "四"]);

      // 模拟满上限后的裁剪：丢掉下标 1（非 user）再追加一条，长度保持 4，
      // messages[0] 的引用没变，首个变化点是下标 1——落在客户端窗口之前。
      mutateSession(harness, id, (session) => {
        const [first, , third, fourth] = session.messages;
        assert.ok(first && third && fourth);
        return {
          ...session,
          messages: [
            first,
            third,
            fourth,
            { id: "appended", role: "user", text: "新消息" },
          ],
        };
      });
      const next = await stream.next();
      assert.equal(next.data.messageCount, 4);
      // 不能发 messagesFrom=1（客户端 historyStart=2 会整帧丢弃，新消息永久不可见）。
      assert.notEqual(next.data.messagesFrom, 1);
      assert.equal(next.data.reset, true);
      assert.equal(next.data.messagesFrom, 2);
      assert.deepEqual(next.data.messages?.map((item) => item.text), ["四", "新消息"]);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("非尾部消息变化不会被尾部 user 消息掩盖", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["开头"]);
    // 构造 [user, 思考片段, 排队 user]：思考块还没结束，用户又排队发了一条。
    mutateSession(harness, id, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id: "thinking-1",
          role: "assistant",
          kind: "thinking",
          text: "思考中",
          partial: true,
          streaming: true,
        },
        { id: "queued-user", role: "user", text: "排队消息" },
      ],
    }));
    const stream = await openSse(`${harness.url}/api/events?session=${id}`);
    try {
      const initial = await stream.next();
      assert.equal(initial.data.messageCount, 3);
      assert.equal(initial.data.messagesFrom, 1);
      assert.deepEqual(initial.data.messages?.map((item) => item.text), ["思考中", "排队消息"]);

      // 思考片段继续增长（替换对象），尾部 user 消息完全没变。
      mutateSession(harness, id, (session) => {
        const messages = session.messages.slice();
        const thinking = messages[1];
        assert.ok(thinking);
        messages[1] = { ...thinking, text: "思考中，还在继续" };
        return { ...session, messages };
      });
      const delta = await stream.next();
      assert.equal(delta.data.messageCount, 3);
      // 变化点是下标 1 的思考片段，而不是尾部那条 user 消息；增量帧不带 reset。
      assert.equal(delta.data.reset, undefined);
      assert.equal(delta.data.messagesFrom, 1);
      assert.deepEqual(delta.data.messages?.map((item) => item.text), ["思考中，还在继续", "排队消息"]);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("0 条消息的会话：初次发空 messages，之后只发元数据", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["占位"]);
    mutateSession(harness, id, (session) => ({ ...session, messages: [] }));
    const stream = await openSse(`${harness.url}/api/events?session=${id}`);
    try {
      const initial = await stream.next();
      assert.equal(initial.data.messageCount, 0);
      assert.equal(initial.data.reset, true);
      assert.equal(initial.data.messagesFrom, 0);
      assert.deepEqual(initial.data.messages, []);

      harness.store.updateMeta(id, { title: "空会话改名" });
      const metadata = await stream.next();
      assert.equal(metadata.data.messageCount, 0);
      assert.equal(metadata.data.messagesFrom, undefined);
      assert.equal(metadata.data.messages, undefined);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("/api/health 在 web/dist 后构建出来时能重新探测到，并带内存用量", async () => {
  const harness = await startHarness();
  try {
    type Health = {
      webDist: boolean;
      memory: { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
    };
    const before = await (await fetch(`${harness.url}/api/health`)).json() as Health;
    assert.equal(before.webDist, false);
    for (const key of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"] as const) {
      assert.equal(typeof before.memory[key], "number");
      assert.ok(before.memory[key] >= 0);
    }
    assert.ok(before.memory.rss > 0);

    fs.mkdirSync(harness.webDist, { recursive: true });
    fs.writeFileSync(path.join(harness.webDist, "index.html"), "<!doctype html>");

    const after = await (await fetch(`${harness.url}/api/health`)).json() as Health;
    assert.equal(after.webDist, true);
  } finally {
    await harness.close();
  }
});

test("GET /api/sessions/:id/messages 按 before/limit 返回一页并夹取参数", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["一", "二", "三", "四", "五"]);
    const fetchPage = async (query: string): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${harness.url}/api/sessions/${id}/messages${query}`);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const texts = (body: Record<string, unknown>): unknown[] =>
      (body.messages as TranscriptItem[]).map((item) => item.text);

    // 默认 before=messageCount、limit=historyPage(2)。
    const tail = await fetchPage("");
    assert.equal(tail.status, 200);
    assert.equal(tail.body.start, 3);
    assert.equal(tail.body.messageCount, 5);
    assert.deepEqual(texts(tail.body), ["四", "五"]);

    const middle = await fetchPage("?before=4&limit=2");
    assert.equal(middle.status, 200);
    assert.equal(middle.body.start, 2);
    assert.deepEqual(texts(middle.body), ["三", "四"]);

    // before 等于总数（显式写出默认值）与省略时一致。
    const explicitTotal = await fetchPage("?before=5");
    assert.equal(explicitTotal.status, 200);
    assert.equal(explicitTotal.body.start, 3);
    assert.deepEqual(texts(explicitTotal.body), ["四", "五"]);

    // before 超过总数时夹到末尾；limit 超过 500 时按 500 处理。
    const oversized = await fetchPage("?before=999&limit=999");
    assert.equal(oversized.status, 200);
    assert.equal(oversized.body.start, 0);
    assert.deepEqual(texts(oversized.body), ["一", "二", "三", "四", "五"]);

    // before=0 返回空页，start 为 0。
    const empty = await fetchPage("?before=0");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.start, 0);
    assert.deepEqual(empty.body.messages, []);

    // limit 下限夹到 1，上限是 500。
    const one = await fetchPage("?before=3&limit=0");
    assert.equal(one.status, 200);
    assert.equal(one.body.start, 2);
    assert.deepEqual(texts(one.body), ["三"]);
  } finally {
    await harness.close();
  }
});

test("GET /api/sessions/:id/messages：非法参数 400、会话不存在 404，且不含 streaming", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["一", "二"]);
    mutateSession(harness, id, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        { id: "stream", role: "assistant", text: "流式中", streaming: true, partial: true },
      ],
    }));
    const page = await (await fetch(`${harness.url}/api/sessions/${id}/messages?before=3&limit=3`)).json() as {
      messages: TranscriptItem[];
    };
    assert.equal(page.messages.length, 3);
    assert.equal(page.messages[2]?.streaming, undefined);

    for (const query of ["?before=abc", "?before=-1", "?before=1.5", "?limit=x", "?limit=-2"]) {
      const response = await fetch(`${harness.url}/api/sessions/${id}/messages${query}`);
      assert.equal(response.status, 400, query);
    }

    const missing = await fetch(`${harness.url}/api/sessions/${randomUUID()}/messages`);
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test("Board 连接只发 summary，不带 messages 和 messageCount", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness, ["看板"]);
    const stream = await openSse(`${harness.url}/api/events`);
    try {
      harness.store.addUserMessage(id, "触发广播");
      const frame = await stream.next();
      assert.equal(frame.event, "session");
      assert.equal(frame.data.id, id);
      assert.equal(frame.data.messages, undefined);
      assert.equal(frame.data.messagesFrom, undefined);
      assert.equal(frame.data.messageCount, undefined);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});
