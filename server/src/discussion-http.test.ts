import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_LIMITS, type AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store, type CreateSessionInput } from "./store.js";

interface Harness {
  url: string;
  store: Store;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-discussion-http-"));
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 2,
    configDir: base,
    role: "primary",
    projects: [],
    limits: { ...DEFAULT_LIMITS },
  };
  const store = new Store(dataDir);
  const settings = {
    current: {
      effort: "high",
      providers: [{
        id: "prov1",
        name: "测试接口",
        baseUrl: "http://localhost",
        apiKey: "test-key",
        models: ["m1", "m2"],
      }],
      maxConcurrent: 2,
    } satisfies StoredSettings,
  };
  const runtime = new Runtime(store, {
    maxConcurrent: 2,
    fake: true,
    credential: () => ({ apiKey: "test-key", baseUrl: "http://localhost" }),
    permission: () => "default",
    secrets: () => [],
  });
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
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    close: async () => {
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closing;
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function createDiscussionSession(store: Store, workflow: "discuss" | "dis-prl" = "discuss"): string {
  const id = randomUUID();
  const input: CreateSessionInput = {
    id,
    projectId: "p1",
    projectPath: "/tmp/project",
    title: "讨论会话",
    providerId: "prov1",
    providerName: "测试接口",
    model: "m1",
    effort: "high",
    cwd: "/tmp/project",
    git: false,
    prompt: "给出一个缓存方案",
    workflow,
  };
  store.create(input);
  store.prepareDiscussion(id, undefined, workflow);
  return id;
}

function waitUntil(condition: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error("等待条件超时"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const participants = [
  { name: "甲", providerId: "prov1", model: "m1", effort: "high" },
  { name: "乙", providerId: "prov1", model: "m2", effort: "low" },
];

test("讨论接口：校验参与者并启动一轮讨论", async () => {
  const harness = await startHarness();
  try {
    const id = createDiscussionSession(harness.store);
    const bad = await fetch(`${harness.url}/api/sessions/${id}/discussion/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participants: [] }),
    });
    assert.equal(bad.status, 400);

    const started = await fetch(`${harness.url}/api/sessions/${id}/discussion/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participants }),
    });
    assert.equal(started.status, 200);
    const body = await started.json() as { session: { discussion?: { phase: string; participants: unknown[] } } };
    assert.equal(body.session.discussion?.participants.length, 2);

    await waitUntil(() => harness.store.require(id).discussion?.phase === "completed");
    const session = harness.store.require(id);
    assert.equal(session.phase, "completed");
    assert.equal(session.discussion?.agreed, true);
    const final = [...session.messages].reverse().find((item) => item.discussion);
    assert.equal(final?.discussion?.kind, "final");
    assert.equal(final?.speaker, "甲");
  } finally {
    await harness.close();
  }
});

test("并行讨论接口：dis-prl 会话拆分后执行子讨论和集成", async () => {
  const harness = await startHarness();
  try {
    const id = createDiscussionSession(harness.store, "dis-prl");
    const started = await fetch(`${harness.url}/api/sessions/${id}/discussion/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participants }),
    });
    assert.equal(started.status, 200);
    await waitUntil(() => harness.store.require(id).discussion?.phase === "completed");
    const session = harness.store.require(id);
    assert.equal(session.workflow?.skill, "dis-prl");
    assert.equal(session.discussion?.strategy, "parallel");
    assert.deepEqual(session.discussion?.subtasks?.map((item) => item.phase), ["completed", "completed"]);
    const kinds = session.messages.filter((item) => item.discussion).map((item) => item.discussion?.kind);
    assert.equal(kinds[0], "decompose");
    assert.equal(kinds.filter((kind) => kind === "decompose").length, 1);
    assert.ok(kinds.includes("final"));
  } finally {
    await harness.close();
  }
});

test("讨论接口：不存在的接口/模型被拒绝", async () => {
  const harness = await startHarness();
  try {
    const id = createDiscussionSession(harness.store);
    const response = await fetch(`${harness.url}/api/sessions/${id}/discussion/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participants: [{ name: "甲", providerId: "prov1", model: "missing", effort: "high" }],
      }),
    });
    assert.equal(response.status, 400);
    const missing = await fetch(`${harness.url}/api/sessions/${id}/discussion/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        participants: [{ name: "甲", providerId: "nope", model: "m1", effort: "high" }],
      }),
    });
    assert.equal(missing.status, 400);
  } finally {
    await harness.close();
  }
});
