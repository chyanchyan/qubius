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

interface Harness {
  url: string;
  store: Store;
  sdkDir: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-subagent-http-"));
  const dataDir = path.join(base, "data");
  const sdkDir = path.join(base, "claude");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(sdkDir, "projects"), { recursive: true });
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
  const runtime = { queueSnapshot: () => [] } as unknown as Runtime;
  const settings = { current: { effort: "high", providers: [], maxConcurrent: 4 } as StoredSettings };
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
    sdkConfigDir: sdkDir,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    sdkDir,
    close: async () => {
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closing;
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function createSession(harness: Harness): string {
  const id = randomUUID();
  const input: CreateSessionInput = {
    id,
    projectId: "p1",
    projectPath: "/tmp/project",
    title: "子任务会话",
    providerId: "prov1",
    providerName: "测试接口",
    model: "model-x",
    effort: "high",
    cwd: "/tmp/project",
    git: false,
    prompt: "拆分任务",
  };
  harness.store.create(input);
  return id;
}

/** 按 SDK 的落盘规则写一份 sidechain transcript。 */
function writeTranscript(harness: Harness, sessionId: string, taskId: string): void {
  const dir = path.join(harness.sdkDir, "projects", "-tmp-project", sessionId, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "看入口" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } }],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "内容" }] },
    }),
  ];
  fs.writeFileSync(path.join(dir, `agent-${taskId}.jsonl`), lines.join("\n"));
}

async function call<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  pathname: string,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${harness.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : {} as T;
  return { status: response.status, data };
}

interface TranscriptBody {
  entries: Array<{ kind: string; text: string; toolName?: string; result?: string }>;
  truncated: boolean;
}

test("GET 子任务详情：返回归一化后的条目", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    writeTranscript(harness, id, "task-1");
    const { status, data } = await call<TranscriptBody>(
      harness,
      "GET",
      `/api/sessions/${id}/subagents/task-1`,
    );
    assert.equal(status, 200);
    assert.equal(data.truncated, false);
    assert.deepEqual(data.entries.map((item) => item.kind), ["prompt", "tool"]);
    assert.equal(data.entries[1]?.toolName, "Read");
    assert.equal(data.entries[1]?.result, "内容");
  } finally {
    await harness.close();
  }
});

test("GET 子任务详情：找不到记录、非法 id 和未知路径都返回 JSON 404", async () => {
  const harness = await startHarness();
  try {
    const id = createSession(harness);
    const missing = await call(harness, "GET", `/api/sessions/${id}/subagents/missing`);
    assert.equal(missing.status, 404);
    const traversal = await call(harness, "GET", `/api/sessions/${id}/subagents/..%2Fsecret`);
    assert.equal(traversal.status, 404);
    const extra = await call(harness, "GET", `/api/sessions/${id}/subagents/task-1/extra`);
    assert.equal(extra.status, 404);
    const post = await call(harness, "POST", `/api/sessions/${id}/subagents/task-1`);
    assert.equal(post.status, 404);
    const badSession = await call(harness, "GET", "/api/sessions/not-a-uuid/subagents/task-1");
    assert.equal(badSession.status, 400);
    const unknownSession = await call(
      harness,
      "GET",
      `/api/sessions/${randomUUID()}/subagents/task-1`,
    );
    assert.equal(unknownSession.status, 404);
  } finally {
    await harness.close();
  }
});

test("GET 子任务详情：只读本会话目录，不认领别的会话的 sidechain", async () => {
  const harness = await startHarness();
  try {
    const owner = createSession(harness);
    const other = createSession(harness);
    writeTranscript(harness, owner, "task-1");
    const { status } = await call(harness, "GET", `/api/sessions/${other}/subagents/task-1`);
    assert.equal(status, 404);
  } finally {
    await harness.close();
  }
});
