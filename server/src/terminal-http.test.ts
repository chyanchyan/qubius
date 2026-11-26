import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store } from "./store.js";
import { TerminalController } from "./terminal-http.js";
import {
  TerminalManager,
  type PtyExit,
  type PtyProcess,
  type TerminalServerMessage,
} from "./terminal.js";
import type { Effort } from "./types.js";

class FakePty implements PtyProcess {
  readonly pid = 1234;
  written: string[] = [];
  resized: [number, number][] = [];
  kills = 0;
  pauses = 0;
  resumes = 0;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExit) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: PtyExit) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }

  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.resumes += 1;
  }

  kill(): void {
    this.kills += 1;
  }

  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  exit(exitCode = 0): void {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }
}

interface Harness {
  port: number;
  ptys: FakePty[];
  /** 配置里可用的项目仓库目录。 */
  projectPath: string;
  close(): Promise<void>;
}

async function startHarness(options: {
  authToken?: string;
  maxSessions?: number;
  highWaterBytes?: number;
} = {}): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-terminal-http-"));
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const projectPath = path.join(base, "repo");
  fs.mkdirSync(projectPath, { recursive: true });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [
      { id: "repo", name: "仓库", path: projectPath, permission: "acceptEdits", isolated: false },
      // 目录不存在：创建命令行时应拒绝而不是把 PTY 启动失败成 500。
      { id: "gone", name: "已删除", path: path.join(base, "missing"), permission: "acceptEdits", isolated: false },
    ],
  };
  const settings = {
    current: {
      providers: [],
      effort: "high" as Effort,
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "", baseUrl: "" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  const ptys: FakePty[] = [];
  const manager = new TerminalManager({
    shell: "/bin/sh",
    cwd: "/tmp",
    ...(options.maxSessions ? { maxSessions: options.maxSessions } : {}),
    spawn: () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  const terminal = new TerminalController(manager, {
    createTimeoutMs: 60_000,
    keepAliveMs: 60_000,
    ...(options.highWaterBytes ? { highWaterBytes: options.highWaterBytes } : {}),
  });
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
    terminal,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    ptys,
    projectPath,
    async close() {
      terminal.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function request(
  port: number,
  method: string,
  pathname: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? "" : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.token ? { "X-Qubius-Token": options.token } : {}),
      ...(payload ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
    };
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          if (text) {
            try {
              json = JSON.parse(text) as Record<string, unknown>;
            } catch {
              json = { raw: text };
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface Stream {
  status: number;
  next(): Promise<TerminalServerMessage>;
  close(): void;
}

/** 按 SSE 帧读取命令行输出；帧格式是 `data: <json>\n\n`。 */
function openStream(port: number, id: string, token?: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/terminal/${id}/stream`,
        method: "GET",
        headers: token ? { "X-Qubius-Token": token } : {},
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`unexpected ${res.statusCode}`), {
            status: res.statusCode,
          }));
          return;
        }
        let buffer = "";
        const frames: TerminalServerMessage[] = [];
        const waiters: ((message: TerminalServerMessage) => void)[] = [];
        const flush = () => {
          for (;;) {
            const index = buffer.indexOf("\n\n");
            if (index < 0) return;
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data) continue;
            const message = JSON.parse(data) as TerminalServerMessage;
            const waiter = waiters.shift();
            if (waiter) waiter(message);
            else frames.push(message);
          }
        };
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          flush();
        });
        resolve({
          status: res.statusCode ?? 0,
          next() {
            const queued = frames.shift();
            if (queued) return Promise.resolve(queued);
            return new Promise<TerminalServerMessage>((resolveNext, rejectNext) => {
              const timer = setTimeout(() => rejectNext(new Error("等待输出超时")), 3_000);
              waiters.push((message) => {
                clearTimeout(timer);
                resolveNext(message);
              });
            });
          },
          close() {
            req.destroy();
            res.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function createTerminal(port: number, token?: string): Promise<string> {
  const created = await request(port, "POST", "/api/terminal", {
    token,
    body: { cols: 100, rows: 30 },
  });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal(typeof id, "string");
  return id as string;
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("等待条件超时"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

interface UnreadStream {
  req: http.ClientRequest;
  response: http.IncomingMessage;
  /** 主动断开客户端连接，模拟刷新/关页/断网。 */
  destroy(): void;
}

/** 打开 SSE 但立刻暂停读取客户端，让服务端发送缓冲堆积，触发背压。 */
function openUnreadStream(port: number, id: string, token?: string): Promise<UnreadStream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/terminal/${id}/stream`,
        method: "GET",
        headers: token ? { "X-Qubius-Token": token } : {},
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(Object.assign(new Error(`unexpected ${response.statusCode}`), {
            status: response.statusCode,
          }));
          return;
        }
        response.pause();
        resolve({
          req,
          response,
          destroy() {
            req.destroy();
            response.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * 灌大块输出直到 fake PTY 因发送缓冲过高被暂停。
 * 上限防止背压一直不触发时无限循环卡死（正常情况下几十轮内就会暂停）。
 */
const MAX_EMIT_ATTEMPTS = 4096;

async function emitUntilPaused(pty: FakePty): Promise<void> {
  const chunk = "x".repeat(64 * 1024);
  for (let sent = 0; pty.pauses === 0 && sent < MAX_EMIT_ATTEMPTS; sent += 1) {
    pty.emit(chunk);
    if (sent % 16 === 15) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pty.pauses, 1);
}

test("启用令牌后创建和订阅都必须带令牌", async (t) => {
  const harness = await startHarness({ authToken: "terminal-token-123456" });
  t.after(() => harness.close());

  const denied = await request(harness.port, "POST", "/api/terminal", { body: { cols: 80, rows: 24 } });
  assert.equal(denied.status, 401);

  const id = await createTerminal(harness.port, "terminal-token-123456");
  await assert.rejects(
    openStream(harness.port, id),
    (error: { status?: number }) => error.status === 401,
  );
  const stream = await openStream(harness.port, id, "terminal-token-123456");
  t.after(() => stream.close());
  const pty = harness.ptys[0];
  assert.ok(pty);
  pty.emit("prompt$ ");
  assert.deepEqual(await stream.next(), { type: "data", data: "prompt$ " });
});

test("创建后订阅前的输出不会丢，输入和尺寸能双向传递", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const created = await request(harness.port, "POST", "/api/terminal", {
    body: { cols: 100, rows: 30 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.shell, "/bin/sh");
  assert.equal(created.json.cwd, "/tmp");
  const id = created.json.id as string;

  const pty = harness.ptys[0];
  assert.ok(pty);
  // 浏览器还没打开 SSE 时先到达的提示符要缓存下来。
  pty.emit("prompt$ ");

  const stream = await openStream(harness.port, id);
  t.after(() => stream.close());
  assert.deepEqual(await stream.next(), { type: "data", data: "prompt$ " });

  const input = await request(harness.port, "POST", `/api/terminal/${id}/input`, {
    body: { data: "echo hi\n" },
  });
  assert.equal(input.status, 204);
  assert.deepEqual(pty.written, ["echo hi\n"]);

  const resize = await request(harness.port, "POST", `/api/terminal/${id}/resize`, {
    body: { cols: 132, rows: 43 },
  });
  assert.equal(resize.status, 204);
  assert.deepEqual(pty.resized, [[132, 43]]);

  pty.emit("hi\r\n");
  assert.deepEqual(await stream.next(), { type: "data", data: "hi\r\n" });
});

test("按项目 id 创建命令行时在项目仓库路径启动", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const created = await request(harness.port, "POST", "/api/terminal", {
    body: { cols: 100, rows: 30, project: "repo" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.cwd, harness.projectPath);
  assert.equal(harness.ptys.length, 1);
});

test("未知或不可用的项目不会创建命令行", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const unknown = await request(harness.port, "POST", "/api/terminal", {
    body: { cols: 80, rows: 24, project: "nope" },
  });
  assert.equal(unknown.status, 404);

  const unavailable = await request(harness.port, "POST", "/api/terminal", {
    body: { cols: 80, rows: 24, project: "gone" },
  });
  assert.equal(unavailable.status, 400);
  assert.match(String(unavailable.json.error), /项目目录不可用/);
  assert.equal(harness.ptys.length, 0);
});

test("提供控制器时实例信息里 terminal 为 true", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const instance = await request(harness.port, "GET", "/api/instance");
  assert.equal(instance.status, 200);
  assert.equal(instance.json.terminal, true);
});

test("PTY 退出后流收到 exit 并结束", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const id = await createTerminal(harness.port);
  const stream = await openStream(harness.port, id);
  t.after(() => stream.close());

  harness.ptys[0]?.exit(7);
  assert.deepEqual(await stream.next(), { type: "exit", exitCode: 7 });
});

test("DELETE 结束 PTY，未知 id 返回 404", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const id = await createTerminal(harness.port);
  const stream = await openStream(harness.port, id);
  t.after(() => stream.close());

  const removed = await request(harness.port, "DELETE", `/api/terminal/${id}`);
  assert.equal(removed.status, 204);
  assert.equal(harness.ptys[0]?.kills, 1);

  const again = await request(harness.port, "DELETE", `/api/terminal/${id}`);
  assert.equal(again.status, 404);
  const missing = await request(harness.port, "POST", "/api/terminal/00000000-0000-4000-8000-000000000000/input", {
    body: { data: "x" },
  });
  assert.equal(missing.status, 400);
});

test("关闭 SSE 后回收对应 PTY", async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const id = await createTerminal(harness.port);
  const stream = await openStream(harness.port, id);
  stream.close();
  await waitFor(() => (harness.ptys[0]?.kills ?? 0) === 1);
});

test("浏览器读得慢时暂停 PTY，缓冲排空后恢复", async (t) => {
  const harness = await startHarness({ highWaterBytes: 64 * 1024 });
  t.after(() => harness.close());
  const id = await createTerminal(harness.port);
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: harness.port, path: `/api/terminal/${id}/stream` }, resolve);
    req.on("error", reject);
    req.end();
  });
  t.after(() => response.destroy());
  // 客户端停止读取，服务端的发送缓冲只能越积越多。
  response.pause();
  const pty = harness.ptys[0];
  assert.ok(pty);
  const chunk = "x".repeat(64 * 1024);
  for (let sent = 0; pty.pauses === 0 && sent < 4096; sent += 1) {
    pty.emit(chunk);
    if (sent % 16 === 15) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pty.pauses, 1);
  assert.equal(pty.resumes, 0);

  response.resume();
  await waitFor(() => pty.resumes === 1);
});

test("背压暂停期间换流会恢复 PTY 并继续输出", async (t) => {
  const harness = await startHarness({ highWaterBytes: 64 * 1024 });
  t.after(() => harness.close());
  const id = await createTerminal(harness.port);
  const first = await openUnreadStream(harness.port, id);
  t.after(() => first.destroy());
  const pty = harness.ptys[0];
  assert.ok(pty);

  await emitUntilPaused(pty);
  assert.equal(pty.resumes, 0);

  // 同一个 id 打开新的流：旧流上等待的背压应释放，PTY 恢复读取。
  const second = await openStream(harness.port, id);
  t.after(() => second.close());
  await waitFor(() => pty.resumes === 1);
  // 换流只释放背压，不应结束会话。
  assert.equal(pty.kills, 0);

  // 新流可用：后续输出以 data 帧送达。
  pty.emit("after-switch\r\n");
  assert.deepEqual(await second.next(), { type: "data", data: "after-switch\r\n" });
});

test("背压暂停期间断开连接会恢复 PTY 并回收会话", async (t) => {
  const harness = await startHarness({ highWaterBytes: 64 * 1024 });
  t.after(() => harness.close());
  const id = await createTerminal(harness.port);
  const stream = await openUnreadStream(harness.port, id);
  t.after(() => stream.destroy());
  const pty = harness.ptys[0];
  assert.ok(pty);

  await emitUntilPaused(pty);
  const resumesBefore = pty.resumes;
  assert.equal(pty.kills, 0);

  // 客户端断开（刷新/关页/断网）：服务端 close 处理应释放背压并回收会话。
  stream.destroy();

  await waitFor(() => pty.resumes > resumesBefore && pty.kills === 1);

  // 会话已被回收：controller 里不再有该 entry，DELETE 应返回 404。
  const removed = await request(harness.port, "DELETE", `/api/terminal/${id}`, { body: {} });
  assert.equal(removed.status, 404);
});

test("超过并发上限时创建返回 503", async (t) => {
  const harness = await startHarness({ maxSessions: 1 });
  t.after(() => harness.close());
  await createTerminal(harness.port);
  const second = await request(harness.port, "POST", "/api/terminal", {
    body: { cols: 80, rows: 24 },
  });
  assert.equal(second.status, 503);
  assert.match(String(second.json.error), /最多 1 个/);
});

test("命令行关闭时接口返回 404，实例信息里 terminal 为 false", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-terminal-off-"));
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
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "", baseUrl: "" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings: { current: { providers: [], effort: "high" as Effort, maxConcurrent: 4 } },
    permissions: { current: {} },
    repoRoot: base,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await request(port, "POST", "/api/terminal", { body: { cols: 80, rows: 24 } });
    assert.equal(response.status, 404);
    const stream = await request(port, "GET", "/api/terminal/00000000-0000-4000-8000-000000000000/stream");
    assert.equal(stream.status, 404);
    const instance = await request(port, "GET", "/api/instance");
    assert.equal(instance.json.terminal, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown().catch(() => undefined);
    await store.flush().catch(() => undefined);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
