import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BatchWatchError,
  BatchWatchManager,
  BatchWatchStore,
  buildIntegrationPrompt,
  evaluateWatchTargets,
  normalizeBatchActions,
  type BatchWatchCreateSessionInput,
} from "./batch-watch.js";
import type { AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store } from "./store.js";
import type { Effort, Phase } from "./types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-batch-watch-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await sleep(10);
  }
}

function createFakeSession(store: Store, id: string, projectId: string, title: string) {
  return store.create({
    id,
    projectId,
    projectPath: "/tmp/proj",
    title,
    providerId: "prov1",
    providerName: "测试接口",
    model: "model-a",
    effort: "high",
    cwd: `/tmp/proj/wt-${id}`,
    branch: `qubius/${id}`,
    git: true,
    prompt: `开发 ${title}`,
  });
}

function finishSession(store: Store, id: string, subtype: "success" | "error_during_execution" = "success") {
  store.apply(id, {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: subtype === "success" ? "已完成改动" : "执行出错",
  });
}

/** 为 updateTargets 相关用例搭建最小可用的管理器环境。 */
function createUpdateHarness() {
  const dir = tempDir();
  const store = new Store(dir);
  const watchStore = new BatchWatchStore(dir);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    maxConcurrent: 4,
    configDir: dir,
    role: "primary",
    projects: [{ id: "p1", name: "测试项目", path: dir, permission: "acceptEdits", isolated: false }],
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [{
        id: "prov1",
        name: "接口一",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "sk-test",
        models: ["model-review"],
      }],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const runtime = new Runtime(store, {
    maxConcurrent: 4,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  const launched: BatchWatchCreateSessionInput[] = [];
  const makeManager = (reviewId = "99999999-9999-9999-9999-999999999999") =>
    new BatchWatchManager({
      config,
      store,
      runtime,
      settings,
      watchStore,
      collectSnapshot: async (_s, target) => ({
        sessionId: target.sessionId,
        title: target.title,
        branch: target.branch,
        cwd: `/tmp/wt/${target.sessionId}`,
        git: true,
        phase: "completed",
        statusShort: "",
        diffStat: "",
        commitsAhead: "",
        lastAssistantSummary: "",
      }),
      createReviewSession: async (input) => {
        launched.push(input);
        return { id: reviewId };
      },
    });
  return { dir, store, watchStore, launched, makeManager };
}

function createWatch(manager: BatchWatchManager, sessionIds: string[]) {
  return manager.create({
    projectId: "p1",
    sessionIds,
    providerId: "prov1",
    providerName: "接口一",
    model: "model-review",
    effort: "high",
    actions: { commit: true, mergeMode: "merge", push: false, deploy: false },
  });
}

test("normalizeBatchActions 校验收尾动作组合规则", () => {
  assert.deepEqual(
    normalizeBatchActions({ commit: false, mergeMode: "none", push: false, deploy: false }),
    { commit: false, mergeMode: "none", push: false, deploy: false },
  );
  assert.deepEqual(
    normalizeBatchActions({ commit: true, mergeMode: "rebase", push: true, deploy: true, baseBranch: "main" }),
    { commit: true, mergeMode: "rebase", push: true, deploy: true, baseBranch: "main" },
  );
  assert.throws(
    () => normalizeBatchActions({ commit: false, mergeMode: "merge", push: false, deploy: false }),
    /同时勾选「提交」/,
  );
  assert.throws(
    () => normalizeBatchActions({ commit: false, mergeMode: "none", push: true, deploy: false }),
    /同时勾选「提交」/,
  );
  assert.throws(
    () => normalizeBatchActions({ commit: true, mergeMode: "none", push: false, deploy: true }),
    /必须先合入主分支/,
  );
  assert.throws(
    () => normalizeBatchActions({ commit: true, mergeMode: "merge", push: false, deploy: false, baseBranch: "main;rm -rf" }),
    /非法字符/,
  );
});

test("evaluateWatchTargets 正确区分等待、暂停与就绪", () => {
  const targets = [
    { sessionId: "s1", title: "会话一" },
    { sessionId: "s2", title: "会话二" },
  ];
  const map = new Map<string, { phase: Phase; title: string; lastError?: string }>([
    ["s1", { phase: "running", title: "会话一" }],
    ["s2", { phase: "completed", title: "会话二" }],
  ]);
  const lookup = (id: string) => map.get(id);

  assert.equal(evaluateWatchTargets(targets, lookup).decision, "waiting");

  map.set("s1", { phase: "needs_input", title: "会话一" });
  const paused = evaluateWatchTargets(targets, lookup);
  assert.equal(paused.decision, "paused");
  assert.deepEqual(paused.pausedSessionIds, ["s1"]);
  assert.match(paused.pauseReason || "", /等待确认/);

  map.set("s1", { phase: "completed", title: "会话一" });
  assert.equal(evaluateWatchTargets(targets, lookup).decision, "ready");

  // 全部跳过时不允许空跑整合
  const allSkipped = targets.map((t) => ({ ...t, skipped: true }));
  assert.equal(evaluateWatchTargets(allSkipped, lookup).decision, "no_active_targets");
});

test("buildIntegrationPrompt 包含来源会话与所有所选收尾动作", () => {
  const text = buildIntegrationPrompt({
    projectName: "qubius",
    projectPath: "/home/q/qubius",
    git: true,
    actions: { commit: true, mergeMode: "rebase", push: true, deploy: true, baseBranch: "main" },
    snapshots: [{
      sessionId: "s1",
      title: "修复遮挡",
      branch: "qubius/s1",
      cwd: "/tmp/wt/s1",
      git: true,
      phase: "completed",
      statusShort: " M web/src/ChipSelect.css",
      diffStat: "1 file changed",
      commitsAhead: "",
      lastAssistantSummary: "已改为 100dvh",
    }],
    extraPrompt: "跑完 web 和 server 测试",
  });
  assert.match(text, /修复遮挡/);
  assert.match(text, /变基合并（rebase）/);
  assert.match(text, /推送/);
  assert.match(text, /部署/);
  assert.match(text, /跑完 web 和 server 测试/);
});

test("BatchWatchManager 脚本监听会话：等待不触发模型，全部完成后自动创建指定模型审核会话", async () => {
  const dir = tempDir();
  const store = new Store(dir);
  const watchStore = new BatchWatchStore(dir);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    maxConcurrent: 4,
    configDir: dir,
    role: "primary",
    projects: [{ id: "p1", name: "测试项目", path: dir, permission: "acceptEdits", isolated: false }],
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [{
        id: "prov1",
        name: "接口一",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "sk-test",
        models: ["model-a", "model-review"],
      }],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const runtime = new Runtime(store, {
    maxConcurrent: 4,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });

  createFakeSession(store, "11111111-1111-1111-1111-111111111111", "p1", "功能 A");
  createFakeSession(store, "22222222-2222-2222-2222-222222222222", "p1", "功能 B");

  const launched: BatchWatchCreateSessionInput[] = [];
  const reviewId = "99999999-9999-9999-9999-999999999999";
  const manager = new BatchWatchManager({
    config,
    store,
    runtime,
    settings,
    watchStore,
    collectSnapshot: async (_s, target) => ({
      sessionId: target.sessionId,
      title: target.title,
      branch: target.branch,
      cwd: `/tmp/wt/${target.sessionId}`,
      git: true,
      phase: "completed",
      statusShort: " M a.ts",
      diffStat: "1 file changed",
      commitsAhead: "",
      lastAssistantSummary: "完成",
    }),
    createReviewSession: async (input) => {
      launched.push(input);
      createFakeSession(store, reviewId, "p1", input.title);
      return { id: reviewId };
    },
  });
  manager.start();

  try {
    const watch = manager.create({
      projectId: "p1",
      sessionIds: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
      providerId: "prov1",
      providerName: "接口一",
      model: "model-review",
      effort: "xhigh",
      actions: { commit: true, mergeMode: "merge", push: false, deploy: false, baseBranch: "main" },
    });
    assert.equal(watch.status, "waiting");
    assert.equal(launched.length, 0);

    // 第一个完成时仍在等待，不触发审核模型
    finishSession(store, "11111111-1111-1111-1111-111111111111", "success");
    await sleep(30);
    assert.equal(launched.length, 0);
    assert.equal(watchStore.get(watch.id)?.status, "waiting");

    // 第二个完成后，立即自动启动指定模型的整合审核会话
    finishSession(store, "22222222-2222-2222-2222-222222222222", "success");
    await waitFor(() => launched.length === 1);
    assert.equal(launched[0]!.model, "model-review");
    assert.equal(launched[0]!.effort, "xhigh");
    assert.match(launched[0]!.prompt, /功能 A/);
    assert.match(launched[0]!.prompt, /功能 B/);
    assert.equal(watchStore.get(watch.id)?.status, "reviewing");
    assert.equal(watchStore.get(watch.id)?.reviewSessionId, reviewId);

    // 审核会话完成后，监听任务同步标记 completed
    finishSession(store, reviewId, "success");
    await waitFor(() => watchStore.get(watch.id)?.status === "completed");
  } finally {
    manager.stop();
  }
});

test("BatchWatchManager 遇到失败会话时暂停，允许用户跳过异常会话后继续整合", async () => {
  const dir = tempDir();
  const store = new Store(dir);
  const watchStore = new BatchWatchStore(dir);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    maxConcurrent: 4,
    configDir: dir,
    role: "primary",
    projects: [{ id: "p1", name: "测试项目", path: dir, permission: "acceptEdits", isolated: false }],
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [{
        id: "prov1",
        name: "接口一",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "sk-test",
        models: ["model-review"],
      }],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const runtime = new Runtime(store, {
    maxConcurrent: 4,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });

  createFakeSession(store, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "p1", "正常会话");
  createFakeSession(store, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "p1", "出错会话");

  const launched: BatchWatchCreateSessionInput[] = [];
  const manager = new BatchWatchManager({
    config,
    store,
    runtime,
    settings,
    watchStore,
    collectSnapshot: async (_s, target) => ({
      sessionId: target.sessionId,
      title: target.title,
      branch: target.branch,
      cwd: `/tmp/wt/${target.sessionId}`,
      git: true,
      phase: "completed",
      statusShort: "",
      diffStat: "",
      commitsAhead: "abc1234 feat",
      lastAssistantSummary: "",
    }),
    createReviewSession: async (input) => {
      launched.push(input);
      return { id: "cccccccc-cccc-cccc-cccc-cccccccccccc" };
    },
  });
  manager.start();

  try {
    const watch = manager.create({
      projectId: "p1",
      sessionIds: [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      ],
      providerId: "prov1",
      providerName: "接口一",
      model: "model-review",
      effort: "high",
      actions: { commit: true, mergeMode: "merge", push: false, deploy: false },
    });

    finishSession(store, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "success");
    finishSession(store, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "error_during_execution");

    await waitFor(() => watchStore.get(watch.id)?.status === "paused");
    const paused = watchStore.get(watch.id)!;
    assert.deepEqual(paused.pausedSessionIds, ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]);
    assert.equal(launched.length, 0);

    // 用户选择「跳过异常会话继续」
    const resumed = await manager.resume(watch.id, { skipBlockers: true });
    assert.equal(resumed.status, "reviewing");
    assert.equal(launched.length, 1);
    assert.match(launched[0]!.prompt, /正常会话/);
    assert.doesNotMatch(launched[0]!.prompt, /出错会话/);
  } finally {
    manager.stop();
  }
});

test("updateTargets 在等待中增减监听会话并保留标题快照", async () => {
  const h = createUpdateHarness();
  const idA = "11111111-1111-1111-1111-111111111111";
  const idB = "22222222-2222-2222-2222-222222222222";
  const idC = "33333333-3333-3333-3333-333333333333";
  createFakeSession(h.store, idA, "p1", "会话 A");
  createFakeSession(h.store, idB, "p1", "会话 B");
  createFakeSession(h.store, idC, "p1", "会话 C");
  const manager = h.makeManager();

  try {
    const watch = createWatch(manager, [idA, idB]);
    assert.equal(watch.status, "waiting");
    assert.equal(watch.targets.length, 2);

    // 新增 C、移除 B：仍处于等待中，标题取各自快照。
    const updated = await manager.updateTargets(watch.id, [idA, idC]);
    assert.equal(updated.status, "waiting");
    assert.deepEqual(updated.targets.map((t) => t.sessionId), [idA, idC]);
    assert.deepEqual(updated.targets.map((t) => t.title), ["会话 A", "会话 C"]);
    assert.equal(updated.targetViews.length, 2);

    // 只保留 C：可继续缩减目标集合。
    const shrunk = await manager.updateTargets(watch.id, [idC]);
    assert.equal(shrunk.status, "waiting");
    assert.deepEqual(shrunk.targets.map((t) => t.sessionId), [idC]);
    assert.equal(shrunk.targetViews.length, 1);
  } finally {
    manager.stop();
  }
});

test("updateTargets 删除造成阻塞的会话后重新回到 waiting", async () => {
  const h = createUpdateHarness();
  const idRunning = "44444444-4444-4444-4444-444444444444";
  const idFailing = "55555555-5555-5555-5555-555555555555";
  createFakeSession(h.store, idRunning, "p1", "运行中会话");
  createFakeSession(h.store, idFailing, "p1", "失败会话");
  finishSession(h.store, idFailing, "error_during_execution");
  const manager = h.makeManager();

  try {
    const watch = createWatch(manager, [idRunning, idFailing]);
    await waitFor(() => h.watchStore.get(watch.id)?.status === "paused");
    assert.deepEqual(h.watchStore.get(watch.id)?.pausedSessionIds, [idFailing]);
    assert.equal(h.launched.length, 0);

    // 删除造成阻塞的失败会话后，剩余 running 会话让任务回到等待。
    const updated = await manager.updateTargets(watch.id, [idRunning]);
    assert.equal(updated.status, "waiting");
    assert.equal(updated.pauseReason, undefined);
    assert.equal(updated.pausedSessionIds, undefined);
    assert.deepEqual(updated.targets.map((t) => t.sessionId), [idRunning]);
  } finally {
    manager.stop();
  }
});

test("updateTargets 在审核开始后返回 409", async () => {
  const h = createUpdateHarness();
  const idA = "66666666-6666-6666-6666-666666666666";
  const idB = "77777777-7777-7777-7777-777777777777";
  createFakeSession(h.store, idA, "p1", "会话 A");
  createFakeSession(h.store, idB, "p1", "会话 B");
  const manager = h.makeManager();
  manager.start();

  try {
    const watch = createWatch(manager, [idA, idB]);
    finishSession(h.store, idA, "success");
    finishSession(h.store, idB, "success");
    await waitFor(() => h.watchStore.get(watch.id)?.status === "reviewing");

    await assert.rejects(
      () => manager.updateTargets(watch.id, [idA]),
      (error: unknown) => error instanceof BatchWatchError
        && error.status === 409
        && /只有等待中或已暂停/.test(error.message),
    );
  } finally {
    manager.stop();
  }
});

test("updateTargets 拒绝空会话列表与不属于项目的会话", async () => {
  const h = createUpdateHarness();
  const idA = "88888888-8888-8888-8888-888888888888";
  const idOther = "99999999-9999-9999-9999-999999999999";
  createFakeSession(h.store, idA, "p1", "会话 A");
  createFakeSession(h.store, idOther, "p2", "别项目会话");
  const manager = h.makeManager();

  try {
    const watch = createWatch(manager, [idA]);

    await assert.rejects(
      () => manager.updateTargets(watch.id, ["  ", ""]),
      (error: unknown) => error instanceof BatchWatchError
        && error.status === 400
        && /至少选择一个要监听的会话/.test(error.message),
    );

    await assert.rejects(
      () => manager.updateTargets(watch.id, [idOther]),
      (error: unknown) => error instanceof BatchWatchError
        && error.status === 400
        && /不存在或不属于该项目/.test(error.message),
    );

    await assert.rejects(
      () => manager.updateTargets("00000000-0000-0000-0000-000000000000", [idA]),
      (error: unknown) => error instanceof BatchWatchError && error.status === 404,
    );
  } finally {
    manager.stop();
  }
});

test("HTTP 路由支持创建、查询、取消和删除批量监听任务", async () => {
  const dir = tempDir();
  const dataDir = path.join(dir, "data");
  const projDir = path.join(dir, "proj");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 2,
    configDir: dir,
    role: "primary",
    projects: [{ id: "p1", name: "项目一", path: projDir, permission: "acceptEdits", isolated: true }],
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [{
        id: "prov1",
        name: "接口一",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "sk-test",
        models: ["model-review"],
      }],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 2,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  const watchStore = new BatchWatchStore(dataDir);
  const batchWatches = new BatchWatchManager({
    config,
    store,
    runtime,
    settings,
    watchStore,
    createReviewSession: async () => ({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd" }),
  });
  batchWatches.start();

  createFakeSession(store, "11111111-1111-1111-1111-111111111111", "p1", "任务一");
  createFakeSession(store, "22222222-2222-2222-2222-222222222222", "p1", "任务二");

  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(dir, "no-web"),
    settings,
    permissions: { current: {} },
    repoRoot: dir,
    batchWatches,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const req = (method: string, reqPath: string, body?: unknown) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = method !== "GET"
      ? { "Content-Type": "application/json" }
      : {};
    if (payload !== undefined) headers["Content-Length"] = Buffer.byteLength(payload);
    const r = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: reqPath,
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data || "{}") }));
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });

  try {
    const created = await req("POST", "/api/projects/p1/batch-watches", {
      sessionIds: ["11111111-1111-1111-1111-111111111111"],
      providerId: "prov1",
      model: "model-review",
      effort: "high",
      actions: { commit: true, mergeMode: "merge", push: false, deploy: false },
    });
    assert.equal(created.status, 201);
    const watch = created.json.watch as { id: string; status: string };
    assert.equal(watch.status, "waiting");

    const listed = await req("GET", "/api/projects/p1/batch-watches");
    assert.equal(listed.status, 200);
    assert.equal((listed.json.watches as unknown[]).length, 1);

    // PATCH 增减被监听的会话：新增「任务二」，仍处于等待中。
    const patched = await req("PATCH", `/api/projects/p1/batch-watches/${watch.id}`, {
      sessionIds: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    });
    assert.equal(patched.status, 200);
    const patchedWatch = patched.json.watch as {
      status: string;
      targets: Array<{ sessionId: string; title: string }>;
    };
    assert.equal(patchedWatch.status, "waiting");
    assert.equal(patchedWatch.targets.length, 2);
    assert.deepEqual(patchedWatch.targets.map((t) => t.title), ["任务一", "任务二"]);

    // 空列表与非法 body 均返回 400。
    const emptyPatch = await req("PATCH", `/api/projects/p1/batch-watches/${watch.id}`, { sessionIds: [] });
    assert.equal(emptyPatch.status, 400);
    const invalidPatch = await req("PATCH", `/api/projects/p1/batch-watches/${watch.id}`, { sessionIds: "not-array" });
    assert.equal(invalidPatch.status, 400);

    const cancelled = await req("POST", `/api/projects/p1/batch-watches/${watch.id}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal((cancelled.json.watch as { status: string }).status, "cancelled");

    const deleted = await req("DELETE", `/api/projects/p1/batch-watches/${watch.id}`);
    assert.equal(deleted.status, 200);
  } finally {
    batchWatches.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
