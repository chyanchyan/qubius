import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import type { SdkMessage } from "./status.js";
import { Store } from "./store.js";
import type { Effort, ImageRef, TranscriptItem } from "./types.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("rewind-test"),
]);

interface Harness {
  url: string;
  base: string;
  dataDir: string;
  projectPath: string;
  gitPath: string;
  store: Store;
  runtime: Runtime;
  settings: { current: StoredSettings };
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-rewind-http-"));
  const dataDir = path.join(base, "data");
  const projectPath = path.join(base, "isolated-project");
  const gitPath = path.join(base, "git-project");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(gitPath, { recursive: true });
  execFileSync("git", ["-C", gitPath, "init", "-q"]);
  execFileSync("git", ["-C", gitPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", gitPath, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(gitPath, "a.txt"), "hello\n");
  execFileSync("git", ["-C", gitPath, "add", "."]);
  execFileSync("git", ["-C", gitPath, "commit", "-qm", "init"]);

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 4,
    configDir: base,
    role: "primary",
    projects: [
      { id: "p1", name: "隔离", path: projectPath, permission: "acceptEdits", isolated: true },
      { id: "p2", name: "Git", path: gitPath, permission: "acceptEdits", isolated: false },
    ],
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [{
        id: "prov1",
        name: "测试接口",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "sk-rewind-secret",
        models: ["model-x"],
      }],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: config.maxConcurrent,
    fake: true,
    credential: () => ({ apiKey: "sk-rewind-secret", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => ["sk-rewind-secret"],
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
    base,
    dataDir,
    projectPath,
    gitPath,
    store,
    runtime,
    settings,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

interface CallResult<T> {
  status: number;
  data: T;
}

async function call<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<CallResult<T>> {
  const response = await fetch(`${harness.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : {} as T;
  return { status: response.status, data };
}

interface SessionView {
  id: string;
  phase: string;
  cwd: string;
  branch?: string;
  canRewindFiles?: boolean;
  messages?: TranscriptItem[];
  workflow?: { skill: string };
  backgroundTasks?: Array<{ status: string }>;
}

async function createSession(
  harness: Harness,
  projectId: string,
  prompt: string,
  images?: Array<Record<string, unknown>>,
): Promise<SessionView> {
  const { status, data } = await call<{ session: SessionView }>(
    harness,
    "POST",
    `/api/projects/${projectId}/sessions`,
    { prompt, providerId: "prov1", model: "model-x", effort: "high", ...(images ? { images } : {}) },
  );
  assert.equal(status, 201);
  return data.session;
}

function pngPayload(): Record<string, unknown> {
  return { mediaType: "image/png", data: PNG.toString("base64"), name: "shot.png" };
}

async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeout = 4000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - start > timeout) throw new Error("等待状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function getSession(harness: Harness, id: string): Promise<SessionView> {
  const { status, data } = await call<{ session: SessionView }>(harness, "GET", `/api/sessions/${id}`);
  assert.equal(status, 200);
  return data.session;
}

async function waitSettled(harness: Harness, id: string): Promise<SessionView> {
  return waitFor(
    () => getSession(harness, id),
    (session) => ["completed", "failed", "stopped"].includes(session.phase)
      && (session as { queue?: unknown[] }).queue?.length === 0,
  );
}

function userMessages(session: SessionView): TranscriptItem[] {
  return (session.messages ?? []).filter((item) => item.role === "user");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("GET 标记可回滚消息；回滚第二条只保留第一轮", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "第一条");
    const id = created.id;
    await waitSettled(harness, id);
    const sent = await call(harness, "POST", `/api/sessions/${id}/messages`, { prompt: "第二条" });
    assert.equal(sent.status, 200);
    const settled = await waitSettled(harness, id);

    const users = userMessages(settled);
    assert.deepEqual(users.map((item) => item.text), ["第一条", "第二条"]);
    for (const item of users) assert.equal(item.rewindable, true);
    for (const item of settled.messages ?? []) {
      if (item.role !== "user") assert.notEqual(item.rewindable, true);
    }
    assert.equal(typeof settled.canRewindFiles, "boolean");

    const rewind = await call<{ session: SessionView; prompt: { text: string; images: ImageRef[] } }>(
      harness,
      "POST",
      `/api/sessions/${id}/rewind`,
      { messageId: users[1]?.id },
    );
    assert.equal(rewind.status, 200);
    assert.equal(rewind.data.prompt.text, "第二条");
    assert.equal(rewind.data.session.phase, "completed");
    assert.deepEqual(userMessages(rewind.data.session).map((item) => item.text), ["第一条"]);
    assert.equal(userMessages(rewind.data.session)[0]?.rewindable, true);
  } finally {
    await harness.close();
  }
});

test("回滚到第一条走全新会话，之后仍能继续发消息", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "起点");
    const id = created.id;
    await waitSettled(harness, id);
    const settled = await getSession(harness, id);
    const first = userMessages(settled)[0];
    assert.ok(first);

    const rewind = await call<{ session: SessionView; prompt: { text: string } }>(
      harness,
      "POST",
      `/api/sessions/${id}/rewind`,
      { messageId: first.id },
    );
    assert.equal(rewind.status, 200);
    assert.equal(rewind.data.prompt.text, "起点");
    assert.equal(rewind.data.session.phase, "completed");
    assert.deepEqual(userMessages(rewind.data.session), []);

    const sent = await call(harness, "POST", `/api/sessions/${id}/messages`, { prompt: "继续" });
    assert.equal(sent.status, 200);
    const again = await waitSettled(harness, id);
    assert.deepEqual(userMessages(again).map((item) => item.text), ["继续"]);
  } finally {
    await harness.close();
  }
});

test("编辑重发保留原消息图片并切换工作流", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "带图的消息", [pngPayload()]);
    const id = created.id;
    const settled = await waitSettled(harness, id);
    const first = userMessages(settled)[0];
    assert.ok(first);
    const image = first.images?.[0];
    assert.ok(image);

    const rewind = await call<{ session: SessionView; prompt: { text: string; images: ImageRef[] } }>(
      harness,
      "POST",
      `/api/sessions/${id}/rewind`,
      {
        messageId: first.id,
        // 和普通发消息一样，落库/下发前去掉首尾空白。
        prompt: "  新内容  ",
        keepImages: [image],
        workflow: "plan",
      },
    );
    assert.equal(rewind.status, 200);
    assert.equal(rewind.data.prompt.text, "带图的消息");
    assert.deepEqual(rewind.data.prompt.images.map((item) => item.id), [image.id]);
    assert.equal(rewind.data.session.workflow?.skill, "plan");
    const users = userMessages(rewind.data.session);
    assert.equal(users.length, 1);
    assert.equal(users[0]?.text, "新内容");
    assert.deepEqual(users[0]?.images?.map((item) => item.id), [image.id]);
    // 复制/复用后的图片文件仍可读取。
    const file = path.join(harness.dataDir, "images", id, `${image.id}.png`);
    assert.ok(fs.existsSync(file));
  } finally {
    await harness.close();
  }
});

test("纯图片消息用空文本重发", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "", [pngPayload()]);
    const id = created.id;
    const settled = await waitSettled(harness, id);
    const first = userMessages(settled)[0];
    assert.ok(first);
    const image = first.images?.[0];
    assert.ok(image);

    const rewind = await call<{ session: SessionView; prompt: { text: string } }>(
      harness,
      "POST",
      `/api/sessions/${id}/rewind`,
      { messageId: first.id, prompt: "", keepImages: [image] },
    );
    assert.equal(rewind.status, 200);
    const users = userMessages(rewind.data.session);
    assert.equal(users.length, 1);
    assert.equal(users[0]?.text, "");
    assert.equal(users[0]?.images?.length, 1);

    // 空文本 + 没有图片的重发必须被拒绝。
    const invalid = await call(harness, "POST", `/api/sessions/${id}/rewind`, {
      messageId: users[0]?.id,
      prompt: "   ",
    });
    assert.equal(invalid.status, 400);
  } finally {
    await harness.close();
  }
});

test("运行中、assistant、旧消息和已结束进程的回滚都被拒绝", async () => {
  const harness = await startHarness();
  try {
    // 运行中：慢 prompt 还没落定时立即回滚。
    const running = await createSession(harness, "p2", "慢任务");
    const runningUser = userMessages(running)[0];
    assert.ok(runningUser);
    const whileRunning = await call(harness, "POST", `/api/sessions/${running.id}/rewind`, {
      messageId: runningUser.id,
    });
    assert.equal(whileRunning.status, 409);
    assert.match(String(whileRunning.data.error), /进行中/);
    await waitSettled(harness, running.id);

    // assistant 消息不能作为回滚目标。
    const settled = await getSession(harness, running.id);
    const assistant = (settled.messages ?? []).find((item) => item.role === "assistant");
    assert.ok(assistant);
    const assistantTarget = await call(harness, "POST", `/api/sessions/${running.id}/rewind`, {
      messageId: assistant.id,
    });
    assert.equal(assistantTarget.status, 409);
    assert.match(String(assistantTarget.data.error), /用户消息/);
    const assistantFork = await call(harness, "POST", `/api/sessions/${running.id}/fork`, {
      messageId: assistant.id,
    });
    assert.equal(assistantFork.status, 409);
    assert.match(String(assistantFork.data.error), /用户消息/);

    // 旧消息没有 SDK 标记。
    const oldId = randomUUID();
    harness.store.createBranch({
      id: oldId,
      projectId: "p2",
      projectPath: harness.gitPath,
      title: "旧会话",
      providerId: "prov1",
      providerName: "测试接口",
      model: "model-x",
      effort: "high",
      cwd: harness.gitPath,
      git: false,
      messages: [{ id: "old-user", role: "user", text: "旧消息" }],
      claudeSessionId: randomUUID(),
      summary: "旧会话",
    });
    const old = await call(harness, "POST", `/api/sessions/${oldId}/rewind`, { messageId: "old-user" });
    assert.equal(old.status, 409);
    assert.match(String(old.data.error), /旧消息/);
    const oldFork = await call(harness, "POST", `/api/sessions/${oldId}/fork`, { messageId: "old-user" });
    assert.equal(oldFork.status, 409);
    assert.match(String(oldFork.data.error), /旧消息/);

    // 只有 sdkUuid、还没被 agent 取走（没有 forkPoint）的消息同样拒绝分叉。
    const halfId = randomUUID();
    harness.store.createBranch({
      id: halfId,
      projectId: "p2",
      projectPath: harness.gitPath,
      title: "未回显",
      providerId: "prov1",
      providerName: "测试接口",
      model: "model-x",
      effort: "high",
      cwd: harness.gitPath,
      git: false,
      messages: [{ id: "half-user", role: "user", text: "未回显", sdkUuid: randomUUID() }],
      claudeSessionId: randomUUID(),
      summary: "未回显",
    });
    const halfFork = await call(harness, "POST", `/api/sessions/${halfId}/fork`, { messageId: "half-user" });
    assert.equal(halfFork.status, 409);
    assert.match(String(halfFork.data.error), /尚未被 agent 取走/);

    // 进程停止后请求文件回滚。
    const filesSession = await createSession(harness, "p2", "文件回滚");
    await waitSettled(harness, filesSession.id);
    await harness.runtime.stop(filesSession.id);
    const filesUser = userMessages(await getSession(harness, filesSession.id))[0];
    assert.ok(filesUser);
    const stopped = await call(harness, "POST", `/api/sessions/${filesSession.id}/rewind`, {
      messageId: filesUser.id,
      files: true,
    });
    assert.equal(stopped.status, 409);
    assert.match(String(stopped.data.error), /文件检查点/);
  } finally {
    await harness.close();
  }
});

test("进程活跃时 files=true 的文件回滚成功", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "回滚文件");
    const id = created.id;
    const settled = await waitSettled(harness, id);
    assert.equal(settled.canRewindFiles, true);
    const first = userMessages(settled)[0];
    assert.ok(first);

    const rewind = await call<{ session: SessionView }>(harness, "POST", `/api/sessions/${id}/rewind`, {
      messageId: first.id,
      files: true,
    });
    assert.equal(rewind.status, 200);
    assert.equal(rewind.data.session.phase, "completed");
    assert.equal(typeof rewind.data.session.canRewindFiles, "boolean");
  } finally {
    await harness.close();
  }
});

test("分叉出新会话：独立 worktree/分支、目标消息前缀、父会话不变", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "父会话第一条");
    const id = created.id;
    await waitSettled(harness, id);
    await call(harness, "POST", `/api/sessions/${id}/messages`, { prompt: "父会话第二条" });
    const parent = await waitSettled(harness, id);
    const users = userMessages(parent);
    assert.equal(users.length, 2);
    const target = users[1];
    assert.ok(target);
    // 父会话的未提交改动不应进入分叉的 worktree。
    fs.writeFileSync(path.join(parent.cwd, "uncommitted.txt"), "dirty\n");

    const fork = await call<{ session: SessionView }>(harness, "POST", `/api/sessions/${id}/fork`, {
      messageId: target.id,
    });
    assert.equal(fork.status, 201);
    const branchSession = fork.data.session;
    assert.notEqual(branchSession.id, id);
    assert.equal(branchSession.phase, "completed");
    assert.equal(branchSession.branch, `qubius/${branchSession.id}`);
    assert.equal(
      branchSession.cwd,
      path.join(harness.dataDir, "worktrees", "p2", branchSession.id),
    );
    assert.deepEqual(userMessages(branchSession).map((item) => item.text), ["父会话第一条", "父会话第二条"]);
    assert.equal(fs.existsSync(path.join(branchSession.cwd, "uncommitted.txt")), false);
    // 新 worktree 的分支 tip 等于父分支 tip。
    assert.equal(git(branchSession.cwd, "rev-parse", "HEAD"), git(parent.cwd, "rev-parse", "HEAD"));

    const parentAfter = await getSession(harness, id);
    assert.deepEqual(userMessages(parentAfter).map((item) => item.text), ["父会话第一条", "父会话第二条"]);
  } finally {
    await harness.close();
  }
});

test("keepImages 不属于目标消息或文件缺失时返回 400", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "图片消息", [pngPayload()]);
    const id = created.id;
    const settled = await waitSettled(harness, id);
    const first = userMessages(settled)[0];
    assert.ok(first);
    const image = first.images?.[0];
    assert.ok(image);

    // 引用别的图片（不存在于目标消息）。
    const foreign = await call(harness, "POST", `/api/sessions/${id}/rewind`, {
      messageId: first.id,
      prompt: "编辑",
      keepImages: [{ id: randomUUID(), mediaType: "image/png" }],
    });
    assert.equal(foreign.status, 400);
    assert.match(String(foreign.data.error), /图片已不存在/);

    // 目标引用正确但磁盘文件被删。
    const file = path.join(harness.dataDir, "images", id, `${image.id}.png`);
    fs.rmSync(file, { force: true });
    const missing = await call(harness, "POST", `/api/sessions/${id}/rewind`, {
      messageId: first.id,
      prompt: "编辑",
      keepImages: [image],
    });
    assert.equal(missing.status, 400);
    assert.match(String(missing.data.error), /图片已不存在/);
    // 图片读取发生在任何破坏性操作之前：失败时会话必须原样保留。
    const unchanged = await getSession(harness, id);
    assert.deepEqual(userMessages(unchanged).map((item) => item.text), ["图片消息"]);
    assert.equal(userMessages(unchanged)[0]?.rewindable, true);
  } finally {
    await harness.close();
  }
});

test("非 git 隔离项目分叉会新建独立子目录", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p1", "隔离项目第一条");
    const id = created.id;
    await waitSettled(harness, id);
    await call(harness, "POST", `/api/sessions/${id}/messages`, { prompt: "隔离项目第二条" });
    const parent = await waitSettled(harness, id);
    const target = userMessages(parent)[1];
    assert.ok(target);

    const fork = await call<{ session: SessionView }>(harness, "POST", `/api/sessions/${id}/fork`, {
      messageId: target.id,
    });
    assert.equal(fork.status, 201);
    const child = fork.data.session;
    assert.notEqual(child.id, id);
    assert.equal(child.branch, undefined);
    assert.equal(child.cwd, path.join(harness.projectPath, child.id));
    assert.ok(fs.statSync(child.cwd).isDirectory());
    assert.deepEqual(userMessages(child).map((item) => item.text), ["隔离项目第一条", "隔离项目第二条"]);
  } finally {
    await harness.close();
  }
});

test("后台任务运行时回滚和分叉都返回 409", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "后台任务");
    const id = created.id;
    const settled = await waitSettled(harness, id);
    const first = userMessages(settled)[0];
    assert.ok(first);

    harness.store.apply(id, {
      type: "system",
      subtype: "task_started",
      uuid: randomUUID(),
      task_id: randomUUID(),
      task_type: "local_bash",
      description: "后台下载",
    } as unknown as SdkMessage);
    const running = await getSession(harness, id);
    assert.equal(running.backgroundTasks?.some((task) => task.status === "running"), true);

    const rewind = await call(harness, "POST", `/api/sessions/${id}/rewind`, { messageId: first.id });
    assert.equal(rewind.status, 409);
    assert.match(String(rewind.data.error), /进行中/);
    const fork = await call(harness, "POST", `/api/sessions/${id}/fork`, { messageId: first.id });
    assert.equal(fork.status, 409);
    assert.match(String(fork.data.error), /进行中/);
  } finally {
    await harness.close();
  }
});

test("rewind/fork 的方法与未知形态", async () => {
  const harness = await startHarness();
  try {
    const created = await createSession(harness, "p2", "方法测试");
    await waitSettled(harness, created.id);
    const wrongMethod = await call(harness, "GET", `/api/sessions/${created.id}/rewind`);
    assert.equal(wrongMethod.status, 405);
    const wrongFork = await call(harness, "GET", `/api/sessions/${created.id}/fork`);
    assert.equal(wrongFork.status, 405);
    const unknown = await call(harness, "POST", `/api/sessions/${created.id}/rewind/extra`, {});
    assert.equal(unknown.status, 404);
    const badBody = await call(harness, "POST", `/api/sessions/${created.id}/rewind`, { messageId: "" });
    assert.equal(badBody.status, 400);
  } finally {
    await harness.close();
  }
});
