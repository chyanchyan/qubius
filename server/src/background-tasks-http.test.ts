import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_LIMITS, type AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import type { Runtime, TaskOutput } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store, type CreateSessionInput } from "./store.js";

interface RuntimeCalls {
  taskOutput: Array<[string, string]>;
  backgroundTask: Array<[string, string]>;
  stopTask: Array<[string, string]>;
}

interface Harness {
  url: string;
  store: Store;
  calls: RuntimeCalls;
  taskOutputResult: TaskOutput;
  taskOutputError?: unknown;
  backgroundTaskResult: boolean;
  backgroundTaskError?: unknown;
  stopTaskError?: unknown;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-background-tasks-http-"));
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
    limits: { ...DEFAULT_LIMITS },
  };
  const store = new Store(dataDir);
  const calls: RuntimeCalls = { taskOutput: [], backgroundTask: [], stopTask: [] };
  const state: Harness = {
    url: "",
    store,
    calls,
    // 每个测试可覆写的 runtime 行为。
    taskOutputResult: { output: "", totalBytes: 0, truncated: false },
    backgroundTaskResult: true,
    close: async () => undefined,
  };
  // 只实现本组路由用到的 Runtime 方法；其余方法不会走到。
  const runtime = {
    queueSnapshot: () => [],
    taskOutput: async (id: string, taskId: string) => {
      calls.taskOutput.push([id, taskId]);
      if (state.taskOutputError !== undefined) throw state.taskOutputError;
      return state.taskOutputResult;
    },
    backgroundTask: async (id: string, toolUseId: string) => {
      calls.backgroundTask.push([id, toolUseId]);
      if (state.backgroundTaskError !== undefined) throw state.backgroundTaskError;
      return state.backgroundTaskResult;
    },
    stopTask: async (id: string, taskId: string) => {
      calls.stopTask.push([id, taskId]);
      if (state.stopTaskError !== undefined) throw state.stopTaskError;
    },
  } as unknown as Runtime;
  const settings = { current: { effort: "high", providers: [], maxConcurrent: 4 } as StoredSettings };
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush().catch(() => undefined);
    fs.rmSync(base, { recursive: true, force: true });
  };
  return state;
}

function createSession(harness: Harness): string {
  const id = randomUUID();
  const input: CreateSessionInput = {
    id,
    projectId: "p1",
    projectPath: "/tmp/project",
    title: "后台任务会话",
    providerId: "prov1",
    providerName: "测试接口",
    model: "model-x",
    effort: "high",
    cwd: "/tmp/project",
    git: false,
    prompt: "跑一个长任务",
  };
  harness.store.create(input);
  return id;
}

async function call<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${harness.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : {} as T;
  return { status: response.status, data };
}

test("GET task output：返回 camelCase 字段并透传 id/taskId", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    harness.taskOutputResult = { output: "下载中 42%", totalBytes: 42, truncated: true };
    const { status, data } = await call<{ output: string; totalBytes: number; truncated: boolean }>(
      harness,
      "GET",
      `/api/sessions/${id}/tasks/task-1/output`,
    );
    assert.equal(status, 200);
    assert.deepEqual(data, { output: "下载中 42%", totalBytes: 42, truncated: true });
    assert.deepEqual(harness.calls.taskOutput, [[id, "task-1"]]);
  } finally {
    await harness.close();
  }
});

test("GET task output：会话不存在 404，非法 id 400", async () => {
  const harness = await startHarness();
  try {
    const missing = await call(harness, "GET", `/api/sessions/${randomUUID()}/tasks/task-1/output`);
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, "找不到对话");

    const invalid = await call(harness, "GET", "/api/sessions/not-a-uuid/tasks/task-1/output");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, "对话 id 无效");
    assert.deepEqual(harness.calls.taskOutput, []);
  } finally {
    await harness.close();
  }
});

test("GET task output：runtime 抛错转 409 并透传消息", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    harness.taskOutputError = new Error("对话当前没有运行中的进程");
    const { status, data } = await call(harness, "GET", `/api/sessions/${id}/tasks/task-2/output`);
    assert.equal(status, 409);
    assert.equal(data.error, "对话当前没有运行中的进程");
    assert.deepEqual(harness.calls.taskOutput, [[id, "task-2"]]);
  } finally {
    await harness.close();
  }
});

test("POST background：正常转发并返回 backgrounded", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    harness.backgroundTaskResult = true;
    const first = await call<{ ok: boolean; backgrounded: boolean }>(
      harness,
      "POST",
      `/api/sessions/${id}/tasks/background`,
      { toolUseId: "  toolu-1  " },
    );
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { ok: true, backgrounded: true });

    harness.backgroundTaskResult = false;
    const second = await call<{ ok: boolean; backgrounded: boolean }>(
      harness,
      "POST",
      `/api/sessions/${id}/tasks/background`,
      { toolUseId: "toolu-2" },
    );
    assert.equal(second.status, 200);
    assert.deepEqual(second.data, { ok: true, backgrounded: false });
    // toolUseId 会 trim 后再传给 runtime。
    assert.deepEqual(harness.calls.backgroundTask, [[id, "toolu-1"], [id, "toolu-2"]]);
  } finally {
    await harness.close();
  }
});

test("POST background：body 非法或缺少 toolUseId 一律 400，不调用 runtime", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    const cases: Array<{ body: unknown; message: string }> = [
      { body: [], message: "请求不是 JSON 对象" },
      { body: {}, message: "缺少 toolUseId" },
      { body: { toolUseId: "   " }, message: "缺少 toolUseId" },
      { body: { toolUseId: 42 }, message: "缺少 toolUseId" },
      { body: { toolUseId: "a".repeat(201) }, message: "toolUseId 过长" },
    ];
    for (const item of cases) {
      const { status, data } = await call(harness, "POST", `/api/sessions/${id}/tasks/background`, item.body);
      assert.equal(status, 400, item.message);
      assert.equal(data.error, item.message);
    }
    assert.deepEqual(harness.calls.backgroundTask, []);
  } finally {
    await harness.close();
  }
});

test("POST background：runtime 抛错转 409", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    harness.backgroundTaskError = new Error("对话当前没有运行中的进程");
    const { status, data } = await call(harness, "POST", `/api/sessions/${id}/tasks/background`, {
      toolUseId: "toolu-1",
    });
    assert.equal(status, 409);
    assert.equal(data.error, "对话当前没有运行中的进程");
  } finally {
    await harness.close();
  }
});

test("POST stop：正常转发返回 ok，runtime 抛错转 409", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    const ok = await call<{ ok: boolean }>(harness, "POST", `/api/sessions/${id}/tasks/task-9/stop`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { ok: true });
    assert.deepEqual(harness.calls.stopTask, [[id, "task-9"]]);

    harness.stopTaskError = new Error("找不到任务");
    const failed = await call(harness, "POST", `/api/sessions/${id}/tasks/task-10/stop`);
    assert.equal(failed.status, 409);
    assert.equal(failed.data.error, "找不到任务");
  } finally {
    await harness.close();
  }
});

test("方法不匹配与超长任务 id", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    const backgroundGet = await call(harness, "GET", `/api/sessions/${id}/tasks/background`);
    assert.equal(backgroundGet.status, 404);

    const outputPost = await call(harness, "POST", `/api/sessions/${id}/tasks/task-1/output`, {});
    assert.equal(outputPost.status, 404);

    const stopGet = await call(harness, "GET", `/api/sessions/${id}/tasks/task-1/stop`);
    assert.equal(stopGet.status, 404);

    const tooLong = await call(harness, "GET", `/api/sessions/${id}/tasks/${"a".repeat(201)}/output`);
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.data.error, "任务 id 过长");

    const stopTooLong = await call(harness, "POST", `/api/sessions/${id}/tasks/${"a".repeat(201)}/stop`);
    assert.equal(stopTooLong.status, 400);
    assert.equal(stopTooLong.data.error, "任务 id 过长");

    // 方法不匹配优先于 taskId 长度校验：先 404，不因超长变 400。
    const overlongWrongMethod = await call(
      harness,
      "POST",
      `/api/sessions/${id}/tasks/${"a".repeat(201)}/output`,
      {},
    );
    assert.equal(overlongWrongMethod.status, 404);

    assert.deepEqual(harness.calls.backgroundTask, []);
    assert.deepEqual(harness.calls.taskOutput, []);
    assert.deepEqual(harness.calls.stopTask, []);
  } finally {
    await harness.close();
  }
});

test("/tasks 下未识别形态统一 JSON 404，不落到静态回退，也不调用 runtime", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    const paths: Array<[string, string]> = [
      ["GET", `/api/sessions/${id}/tasks`],
      ["POST", `/api/sessions/${id}/tasks`],
      ["GET", `/api/sessions/${id}/tasks/`],
      ["GET", `/api/sessions/${id}/tasks/task-1/foo`],
      ["POST", `/api/sessions/${id}/tasks/task-1/foo`],
      ["GET", `/api/sessions/${id}/tasks/task-1/output/extra`],
      ["GET", `/api/sessions/${id}/tasks/%62ogus`],
    ];
    for (const [method, pathname] of paths) {
      const { status, data } = await call(harness, method, pathname);
      assert.equal(status, 404, `${method} ${pathname}`);
      assert.equal(data.error, "没有这个接口", `${method} ${pathname}`);
    }
    assert.deepEqual(harness.calls.backgroundTask, []);
    assert.deepEqual(harness.calls.taskOutput, []);
    assert.deepEqual(harness.calls.stopTask, []);
  } finally {
    await harness.close();
  }
});

test("非法百分号编码与编码过的 session id 都返回 400", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    const badTask = await call(harness, "GET", `/api/sessions/${id}/tasks/%ZZ/output`);
    assert.equal(badTask.status, 400);
    assert.equal(badTask.data.error, "任务 id 编码无效");

    // session id 与现有路由一致，不解码；百分号编码的合法 UUID 也按非法 id 处理。
    const encodedId = `%${id.charCodeAt(0).toString(16).padStart(2, "0")}${id.slice(1)}`;
    const badSession = await call(harness, "GET", `/api/sessions/${encodedId}/tasks/task-1/output`);
    assert.equal(badSession.status, 400);
    assert.equal(badSession.data.error, "对话 id 无效");

    assert.deepEqual(harness.calls.taskOutput, []);
  } finally {
    await harness.close();
  }
});

test("runtime 以非 Error 值 reject 时仍返回 409 和兜底文案", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    harness.taskOutputError = "boom";
    const { status, data } = await call(harness, "GET", `/api/sessions/${id}/tasks/task-1/output`);
    assert.equal(status, 409);
    assert.equal(data.error, "读取后台任务输出失败");

    harness.taskOutputError = undefined;
    harness.stopTaskError = 123;
    const stop = await call(harness, "POST", `/api/sessions/${id}/tasks/task-1/stop`);
    assert.equal(stop.status, 409);
    assert.equal(stop.data.error, "停止后台任务失败");

    harness.backgroundTaskError = null;
    const background = await call(harness, "POST", `/api/sessions/${id}/tasks/background`, {
      toolUseId: "toolu-1",
    });
    // null 也是 reject 值；用 !== undefined 判定后同样走兜底文案。
    assert.equal(background.status, 409);
    assert.equal(background.data.error, "转后台失败");
  } finally {
    await harness.close();
  }
});

test("百分号编码的 taskId 会安全解码后转发", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    const { status } = await call(harness, "GET", `/api/sessions/${id}/tasks/task%2F1/output`);
    assert.equal(status, 200);
    assert.deepEqual(harness.calls.taskOutput, [[id, "task/1"]]);
  } finally {
    await harness.close();
  }
});
