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
import type { RoleAgent } from "./role-agent.js";
import type { StoredSettings } from "./settings.js";
import { Store, type CreateSessionInput } from "./store.js";
import type { RoleTeam } from "./types.js";

interface Harness {
  url: string;
  store: Store;
  runtime: Runtime;
  projectPath: string;
  close: () => Promise<void>;
}

async function startHarness(options: { roleAgent?: RoleAgent } = {}): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-role-http-"));
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const projectPath = path.join(base, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 2,
    configDir: base,
    role: "primary",
    projects: [{
      id: "p1",
      name: "项目",
      path: projectPath,
      permission: "default",
      isolated: true,
    }],
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
    ...(options.roleAgent ? { roleAgent: options.roleAgent } : {}),
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
    runtime,
    projectPath,
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

const team: RoleTeam = {
  orchestrator: { providerId: "prov1", providerName: "测试接口", model: "m1", effort: "high" },
  executor: { providerId: "prov1", providerName: "测试接口", model: "m1", effort: "high" },
  subReviewer: { providerId: "prov1", providerName: "测试接口", model: "m2", effort: "low" },
  integrationReviewer: { providerId: "prov1", providerName: "测试接口", model: "m1", effort: "high" },
};

function createRoleSession(store: Store, projectPath: string): string {
  const id = randomUUID();
  const input: CreateSessionInput = {
    id,
    projectId: "p1",
    projectPath,
    title: "角色团队",
    providerId: "prov1",
    providerName: "测试接口",
    model: "m1",
    effort: "high",
    cwd: projectPath,
    git: false,
    prompt: "实现一个改动",
    workflow: "prl-role",
  };
  store.create(input);
  store.prepareRoleRun(id);
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

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("角色团队接口：创建会话进入配置阶段", async () => {
  const harness = await startHarness();
  try {
    const response = await post(`${harness.url}/api/projects/p1/sessions`, {
      prompt: "实现一个改动",
      providerId: "prov1",
      model: "m1",
      workflow: "prl-role",
    });
    assert.equal(response.status, 201);
    const body = await response.json() as {
      session: { id: string; phase: string; workflow?: { skill: string }; roleRun?: { phase: string; units: unknown[] } };
    };
    assert.equal(body.session.phase, "setup");
    assert.equal(body.session.workflow?.skill, "prl-role");
    assert.equal(body.session.roleRun?.phase, "setup");
    assert.deepEqual(body.session.roleRun?.units, []);
  } finally {
    await harness.close();
  }
});

test("角色团队接口：发消息后重新进入配置阶段，不自动开始", async () => {
  const harness = await startHarness();
  try {
    const id = createRoleSession(harness.store, harness.projectPath);
    const response = await post(`${harness.url}/api/sessions/${id}/messages`, {
      prompt: "再实现一处",
      workflow: "prl-role",
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      session: { phase: string; roleRun?: { phase: string; team?: unknown }; messages: Array<{ text: string; role: string }> };
    };
    assert.equal(body.session.roleRun?.phase, "setup");
    assert.equal(body.session.phase, "setup");
    assert.equal(body.session.messages.at(-1)?.text, "再实现一处");
    // 没有自动开始：store 里仍是 setup，运行时没有角色任务。
    assert.equal(harness.store.require(id).roleRun?.phase, "setup");
  } finally {
    await harness.close();
  }
});

test("角色团队接口：start 校验团队配置，成功后进入 running", async () => {
  const harness = await startHarness();
  try {
    const id = createRoleSession(harness.store, harness.projectPath);

    const bad = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team: {} });
    assert.equal(bad.status, 400);

    const invalidModel = await post(`${harness.url}/api/sessions/${id}/role-run/start`, {
      team: {
        ...team,
        executor: { ...team.executor, model: "missing" },
      },
    });
    assert.equal(invalidModel.status, 400);

    const started = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(started.status, 200);
    const body = await started.json() as {
      session: { roleRun?: { phase: string; round: number; team?: unknown }; workflow?: { skill: string } };
    };
    assert.equal(body.session.roleRun?.phase, "running");
    assert.equal(body.session.roleRun?.round, 1);
    assert.equal(body.session.workflow?.skill, "prl-role");

    await waitUntil(() => harness.store.require(id).roleRun?.phase === "completed");
    const session = harness.store.require(id);
    assert.equal(session.roleRun?.agreed, true);
    assert.deepEqual(session.roleRun?.units.map((item) => item.phase), ["passed", "passed"]);
    assert.equal(session.lastResult, "success");
  } finally {
    await harness.close();
  }
});

test("角色团队接口：未知子路径返回 404", async () => {
  const harness = await startHarness();
  try {
    const id = createRoleSession(harness.store, harness.projectPath);
    const response = await post(`${harness.url}/api/sessions/${id}/role-run/other`, {});
    assert.equal(response.status, 404);
  } finally {
    await harness.close();
  }
});

function createPlainSession(store: Store, projectPath: string): string {
  const id = randomUUID();
  store.create({
    id,
    projectId: "p1",
    projectPath,
    title: "普通对话",
    providerId: "prov1",
    providerName: "测试接口",
    model: "m1",
    effort: "high",
    cwd: projectPath,
    git: false,
    prompt: "普通消息",
  });
  return id;
}

/** 执行者一直挂起，直到 run 被停止；用来稳定观察「进行中」状态。 */
const blockingRoleAgent: RoleAgent = async (request) => {
  if (request.role === "orchestrator") return { text: '["单元一"]', tools: [] };
  if (request.role === "executor") {
    await new Promise<void>((_, reject) => {
      if (request.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  return { text: "结论：PASS", tools: [] };
};

test("角色团队接口：重复 start 返回 409", async () => {
  const harness = await startHarness({ roleAgent: blockingRoleAgent });
  try {
    const id = createRoleSession(harness.store, harness.projectPath);
    const first = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(first.status, 200);
    const second = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(second.status, 409);
  } finally {
    await harness.close();
  }
});

test("角色团队接口：非 prl-role 会话 start 返回 409", async () => {
  const harness = await startHarness();
  try {
    const id = createPlainSession(harness.store, harness.projectPath);
    const response = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(response.status, 409);
  } finally {
    await harness.close();
  }
});

test("角色团队接口：会话还有排队消息时发新消息返回 409，不重置进度", async () => {
  const harness = await startHarness();
  try {
    const id = createRoleSession(harness.store, harness.projectPath);
    // 从上一次已结束的运行（非 setup）构造排队状态。
    harness.store.beginRoleRun(id, team, 3);
    harness.store.setRoleUnits(id, ["单元一"]);
    harness.store.settleRoleRun(id, { result: "success", agreed: true });
    harness.store.markQueued(id);

    const response = await post(`${harness.url}/api/sessions/${id}/messages`, {
      prompt: "再实现一处",
      workflow: "prl-role",
    });
    assert.equal(response.status, 409);
    // 没有把已结束的进度重置成新的 setup。
    const session = harness.store.require(id);
    assert.equal(session.roleRun?.phase, "completed");
    assert.equal(session.roleRun?.agreed, true);
    assert.deepEqual(session.roleRun?.units.map((item) => item.title), ["单元一"]);
    assert.equal(session.messages.filter((item) => item.role === "user").length, 1);
  } finally {
    await harness.close();
  }
});

test("角色团队接口：运行中发送普通消息返回 409", async () => {
  const harness = await startHarness({ roleAgent: blockingRoleAgent });
  try {
    const id = createRoleSession(harness.store, harness.projectPath);
    const started = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(started.status, 200);

    const response = await post(`${harness.url}/api/sessions/${id}/messages`, {
      prompt: "顺便再改一处",
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? "", /角色团队正在运行/);
  } finally {
    await harness.close();
  }
});

async function getSession(harness: Harness, id: string) {
  const response = await fetch(`${harness.url}/api/sessions/${id}`);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    session: {
      phase: string;
      workflow?: { skill: string };
      roleRun?: { phase: string };
      messages?: Array<{ id: string; role: string; text: string; rewindable?: boolean }>;
    };
  };
  return body.session;
}

test("角色团队接口：普通轮次结束后空闲 query 仍在时也能开始", async () => {
  const harness = await startHarness();
  try {
    const id = createPlainSession(harness.store, harness.projectPath);
    const sent = await post(`${harness.url}/api/sessions/${id}/messages`, { prompt: "先做点普通事" });
    assert.equal(sent.status, 200);
    await waitUntil(() => (
      harness.store.require(id).phase === "completed" && harness.runtime.isActive(id)
    ));

    const prepared = await post(`${harness.url}/api/sessions/${id}/messages`, {
      prompt: "改用角色团队",
      workflow: "prl-role",
    });
    assert.equal(prepared.status, 200);
    assert.equal(harness.store.require(id).roleRun?.phase, "setup");

    const started = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(started.status, 200);
    await waitUntil(() => harness.store.require(id).roleRun?.phase === "completed");
    assert.equal(harness.store.require(id).lastResult, "success");
  } finally {
    await harness.close();
  }
});

test("角色团队接口：回滚编辑重发 prl-role 进入配置阶段而不是普通 run", async () => {
  const harness = await startHarness();
  try {
    const created = await post(`${harness.url}/api/projects/p1/sessions`, {
      prompt: "第一条",
      providerId: "prov1",
      model: "m1",
      effort: "high",
    });
    assert.equal(created.status, 201);
    const { session: createdSession } = await created.json() as { session: { id: string } };
    const id = createdSession.id;
    await waitUntil(() => {
      const session = harness.store.require(id);
      return session.phase === "completed"
        && session.messages.some((item) => item.role === "user" && item.forkPoint);
    });

    const before = await getSession(harness, id);
    const first = before.messages?.find((item) => item.role === "user");
    assert.ok(first);
    assert.equal(first.rewindable, true);

    const rewind = await post(`${harness.url}/api/sessions/${id}/rewind`, {
      messageId: first.id,
      prompt: "改成角色团队",
      workflow: "prl-role",
    });
    assert.equal(rewind.status, 200);
    const body = await rewind.json() as {
      session: { phase: string; workflow?: { skill: string }; roleRun?: { phase: string }; messages: Array<{ role: string; text: string }> };
    };
    assert.equal(body.session.workflow?.skill, "prl-role");
    assert.equal(body.session.roleRun?.phase, "setup");
    assert.equal(body.session.phase, "setup");
    assert.equal(body.session.messages.at(-1)?.text, "改成角色团队");
    // 没有起普通 SDK run：运行时里没有角色任务，也没有 plan 提示回复。
    assert.equal(harness.runtime.isRoleRunning(id), false);
    assert.ok(!body.session.messages.some((item) => item.role === "assistant" && /plan/.test(item.text)));

    const started = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(started.status, 200);
    await waitUntil(() => harness.store.require(id).roleRun?.phase === "completed");
  } finally {
    await harness.close();
  }
});

test("角色团队接口：roleRun 已完成但已切到其它模式时 start 返回 409", async () => {
  const harness = await startHarness();
  try {
    const id = createRoleSession(harness.store, harness.projectPath);
    harness.store.beginRoleRun(id, team, 3);
    harness.store.settleRoleRun(id, { result: "success", agreed: true });
    // 用户切到 ser：已完成的 roleRun 还在，但当前轮已不是 prl-role。
    harness.store.previewWorkflow(id, "ser", "改用 ser");
    assert.equal(harness.store.require(id).workflow?.skill, "ser");
    assert.equal(harness.store.require(id).roleRun?.phase, "completed");

    const response = await post(`${harness.url}/api/sessions/${id}/role-run/start`, { team });
    assert.equal(response.status, 409);
  } finally {
    await harness.close();
  }
});

test("角色团队接口：存在运行中的后台任务时发 prl-role 消息返回 409 且不进入 setup", async () => {
  const harness = await startHarness();
  try {
    const id = createRoleSession(harness.store, harness.projectPath);
    harness.store.beginRoleRun(id, team, 3);
    harness.store.settleRoleRun(id, { result: "success", agreed: true });
    harness.store.apply(id, {
      type: "system",
      subtype: "task_started",
      uuid: "bg-http-1",
      task_id: "shell-http-1",
      task_type: "local_bash",
      description: "后台构建",
      timestamp: new Date().toISOString(),
    });
    const response = await post(`${harness.url}/api/sessions/${id}/messages`, {
      prompt: "再做个改动",
      workflow: "prl-role",
    });
    assert.equal(response.status, 409);
    assert.equal(harness.store.require(id).roleRun?.phase, "completed");
  } finally {
    await harness.close();
  }
});

