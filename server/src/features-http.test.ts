import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_LIMITS, type AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import { ScheduleRunner, ScheduleStore } from "./schedules.js";
import type { StoredSettings } from "./settings.js";
import { Store } from "./store.js";
import type { Effort } from "./types.js";

const exec = promisify(execFile);

const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 新建仓库的初始提交依赖 git 身份；测试里用环境变量提供，避免依赖本机配置。 */
async function withGitIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(GIT_IDENTITY)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface Harness {
  url: string;
  base: string;
  dataDir: string;
  store: Store;
  runtime: Runtime;
  settings: { current: StoredSettings };
  close: () => Promise<void>;
}

async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-features-http-"));
  const dataDir = path.join(base, "data");
  const projectPath = path.join(base, "project");
  const gitPath = path.join(base, "git-project");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(gitPath, { recursive: true });
  await exec("git", ["-C", gitPath, "init", "-q"]);
  await exec("git", ["-C", gitPath, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", gitPath, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(gitPath, "a.txt"), "hello\n");
  await exec("git", ["-C", gitPath, "add", "."]);
  await exec("git", ["-C", gitPath, "commit", "-qm", "init"]);

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [
      { id: "p1", name: "隔离", path: projectPath, permission: "acceptEdits", isolated: true },
      { id: "p2", name: "Git", path: gitPath, permission: "acceptEdits", isolated: false },
    ],
    ...overrides,
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [{
        id: "prov1",
        name: "测试接口",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "sk-integration-secret",
        models: ["model-x", "model-y"],
      }],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: config.maxConcurrent,
    fake: true,
    credential: () => ({ apiKey: "sk-integration-secret", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => ["sk-integration-secret"],
  });
  const scheduleStore = new ScheduleStore(dataDir);
  const scheduleRunner = new ScheduleRunner({
    store: scheduleStore,
    createSession: async () => ({ id: "scheduled-session" }),
  });
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
    schedules: scheduleStore,
    scheduleRunner,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    base,
    dataDir,
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

async function createSession(harness: Harness, projectId: string, prompt: string): Promise<string> {
  const { status, data } = await call<{ session: { id: string } }>(harness, "POST", `/api/projects/${projectId}/sessions`, {
    prompt,
    providerId: "prov1",
    model: "model-x",
    effort: "high",
  });
  assert.equal(status, 201);
  return data.session.id;
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() - start > timeout) throw new Error("等待状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("全局列表、改名置顶、搜索和非法输入", async () => {
  const harness = await startHarness();
  try {
    const id = await createSession(harness, "p1", "第一条");
    const list = await call<{ sessions: Array<{ id: string; queue?: unknown[] }> }>(harness, "GET", "/api/sessions");
    assert.equal(list.status, 200);
    assert.equal(list.data.sessions.length, 1);
    assert.deepEqual(list.data.sessions[0]?.queue, []);

    const patched = await call<{ session: { title: string; pinned: boolean } }>(harness, "PATCH", `/api/sessions/${id}`, {
      title: "新标题",
      pinned: true,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.session.title, "新标题");
    assert.equal(patched.data.session.pinned, true);

    const found = await call<{ sessions: Array<{ id: string }> }>(harness, "GET", "/api/sessions?q=%E6%96%B0%E6%A0%87%E9%A2%98");
    assert.deepEqual(found.data.sessions.map((item) => item.id), [id]);

    const invalid = await call(harness, "PATCH", `/api/sessions/${id}`, { pinned: "yes" });
    assert.equal(invalid.status, 400);
  } finally {
    await harness.close();
  }
});

test("新建会话的初始标题取自用户首条消息原文", async () => {
  const harness = await startHarness();
  try {
    const { status, data } = await call<{ session: { title: string } }>(
      harness,
      "POST",
      "/api/projects/p1/sessions",
      { prompt: "修一下登录超时\n顺便补测试", providerId: "prov1", model: "model-x", effort: "high" },
    );
    assert.equal(status, 201);
    assert.equal(data.session.title, "修一下登录超时");
  } finally {
    await harness.close();
  }
});

test("排队消息可见，撤回最后一条后不再停在排队；正在跑的会话不受影响", async () => {
  const harness = await startHarness();
  try {
    const running = await createSession(harness, "p1", "慢任务");
    const queued = await createSession(harness, "p1", "排队任务");
    const before = await call<{ session: { phase: string; queue: Array<{ id: string; text: string }> } }>(
      harness,
      "GET",
      `/api/sessions/${queued}`,
    );
    assert.equal(before.data.session.phase, "queued");
    assert.equal(before.data.session.queue.length, 1);
    const promptId = before.data.session.queue[0]?.id;
    assert.ok(promptId);

    const cancelled = await call<{ session: { phase: string; queue: unknown[] } }>(
      harness,
      "DELETE",
      `/api/sessions/${queued}/queue/${promptId}`,
      {},
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.session.phase, "stopped");
    assert.deepEqual(cancelled.data.session.queue, []);

    await waitFor(
      () => call<{ session: { phase: string } }>(harness, "GET", `/api/sessions/${running}`),
      (value) => value.data.session.phase !== "running",
    );
  } finally {
    await harness.close();
  }
});

test("排队消息支持查看、编辑、现在发送和删除", async () => {
  const harness = await startHarness();
  type QueueSnapshot = {
    session: { queue: Array<{ id: string; text: string; interjecting?: boolean }> };
  };
  const entryOf = (snapshot: QueueSnapshot, prefix: string) =>
    snapshot.session.queue.find((item) => item.text.startsWith(prefix));
  try {
    const id = await createSession(harness, "p1", "慢慢来");
    await waitFor(
      () => call<{ session: { phase: string } }>(harness, "GET", `/api/sessions/${id}`),
      (value) => value.data.session.phase === "running",
    );
    /* 排几条慢消息占住会话：每条假轮 1200ms，后面的测试消息排在它们之后，
       不会被轮末释放吃掉，断言不再依赖精确的墙钟窗口。 */
    for (let index = 0; index < 6; index += 1) {
      await call(harness, "POST", `/api/sessions/${id}/messages`, { prompt: "慢慢来" });
    }
    // 超过快照截断长度、带换行的正文：GET 必须返回完整内容，编辑不能丢字。
    const longText = `第一行\n${"长".repeat(300)}`;
    const first = await call<QueueSnapshot>(
      harness,
      "POST",
      `/api/sessions/${id}/messages`,
      { prompt: longText },
    );
    assert.equal(first.status, 200);
    const firstId = entryOf(first.data, "第一行")?.id;
    assert.ok(firstId);
    // 队列快照里的 text 只用于列表预览，会截断。
    assert.ok((entryOf(first.data, "第一行")?.text.length ?? 0) < longText.length);

    // 插话参数照常接受；折叠进当前轮由 SDK 决定，但快照里要标出「已放行」。
    const interjected = await call<QueueSnapshot>(
      harness,
      "POST",
      `/api/sessions/${id}/messages`,
      { prompt: "第二句话", interject: true },
    );
    assert.equal(interjected.status, 200);
    assert.equal(entryOf(interjected.data, "第一行")?.interjecting, undefined);
    assert.equal(entryOf(interjected.data, "第二句话")?.interjecting, true);

    // 再排一条用于「现在发送」，避开可能很快被取走的插话消息。
    const third = await call<QueueSnapshot>(
      harness,
      "POST",
      `/api/sessions/${id}/messages`,
      { prompt: "第三条排队" },
    );
    const thirdId = entryOf(third.data, "第三条排队")?.id;
    assert.ok(thirdId);

    // GET 返回完整正文，供编辑框回填。
    const detail = await call<{ entry: { text: string } }>(
      harness,
      "GET",
      `/api/sessions/${id}/queue/${firstId}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.data.entry.text, longText);

    const edited = await call<QueueSnapshot>(
      harness,
      "PATCH",
      `/api/sessions/${id}/queue/${firstId}`,
      { text: "改过的排队" },
    );
    assert.equal(edited.status, 200);
    assert.equal(entryOf(edited.data, "改过的排队")?.id, firstId);
    // 排队期间消息只存在于队列里，编辑不会提前写进对话记录。
    assert.ok(!harness.store.get(id)?.messages.some((item) => item.text === "改过的排队"));
    assert.ok(!harness.store.get(id)?.messages.some((item) => item.text === longText));

    const sentNow = await call<QueueSnapshot>(
      harness,
      "POST",
      `/api/sessions/${id}/queue/${thirdId}/send`,
    );
    assert.equal(sentNow.status, 200);

    // 删除只从队列移除；它本来就还没写进对话记录。
    const removed = await call<QueueSnapshot>(
      harness,
      "DELETE",
      `/api/sessions/${id}/queue/${firstId}`,
      {},
    );
    assert.equal(removed.status, 200);
    assert.ok(!removed.data.session.queue.some((item) => item.id === firstId));
    assert.ok(!harness.store.get(id)?.messages.some((item) => item.text === "改过的排队"));

    // 已经删掉/开始执行的消息不能再操作。
    const again = await call(harness, "DELETE", `/api/sessions/${id}/queue/${firstId}`, {});
    assert.equal(again.status, 404);
    const missing = await call(harness, "PATCH", `/api/sessions/${id}/queue/${firstId}`, { text: "x" });
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test("切换模型和 effort 后下一条消息继续执行而不是失败", async () => {
  const harness = await startHarness();
  try {
    const id = await createSession(harness, "p1", "第一轮");
    await waitFor(
      () => call<{ session: { phase: string } }>(harness, "GET", `/api/sessions/${id}`),
      (value) => value.data.session.phase !== "running" && value.data.session.phase !== "queued",
    );
    const patched = await call(harness, "PATCH", `/api/sessions/${id}`, {
      model: "model-y",
      effort: "low",
    });
    assert.equal(patched.status, 200);

    const sent = await call(harness, "POST", `/api/sessions/${id}/messages`, { prompt: "第二轮" });
    assert.equal(sent.status, 200);
    const final = await waitFor(
      () => call<{ session: { phase: string } }>(harness, "GET", `/api/sessions/${id}`),
      (value) => ["completed", "failed", "stopped"].includes(value.data.session.phase),
    );
    assert.equal(final.data.session.phase, "completed");
  } finally {
    await harness.close();
  }
});

test("用量接口返回总量和按接口分组", async () => {
  const harness = await startHarness();
  try {
    await createSession(harness, "p1", "统计");
    const usage = await call<{
      totals: { calls: number; input: number };
      byProvider: Array<{ providerId: string; providerName: string }>;
    }>(harness, "GET", "/api/usage");
    assert.equal(usage.status, 200);
    assert.equal(usage.data.totals.calls, 0);
    assert.equal(usage.data.byProvider[0]?.providerId, "prov1");
    assert.equal(usage.data.byProvider[0]?.providerName, "测试接口");
  } finally {
    await harness.close();
  }
});

test("定时任务可以创建、停用、立即运行和删除", async () => {
  const harness = await startHarness();
  try {
    const created = await call<{ schedule: { id: string; enabled: boolean } }>(harness, "POST", "/api/projects/p1/schedules", {
      prompt: "定时任务",
      providerId: "prov1",
      model: "model-x",
      effort: "high",
      intervalMinutes: 5,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.schedule.enabled, true);
    const id = created.data.schedule.id;

    const run = await call<{ ok: boolean; sessionId?: string }>(harness, "POST", `/api/projects/p1/schedules/${id}/run`, {});
    assert.equal(run.status, 200);
    assert.equal(run.data.sessionId, "scheduled-session");

    const disabled = await call<{ schedule: { enabled: boolean } }>(harness, "PATCH", `/api/projects/p1/schedules/${id}`, {
      enabled: false,
    });
    assert.equal(disabled.data.schedule.enabled, false);
    const runDisabled = await call(harness, "POST", `/api/projects/p1/schedules/${id}/run`, {});
    assert.equal(runDisabled.status, 400);

    const removed = await call(harness, "DELETE", `/api/projects/p1/schedules/${id}`, {});
    assert.equal(removed.status, 200);
    const list = await call<{ schedules: unknown[] }>(harness, "GET", "/api/projects/p1/schedules");
    assert.deepEqual(list.data.schedules, []);
  } finally {
    await harness.close();
  }
});

test("接口测试失败时不回显密钥", async () => {
  const harness = await startHarness();
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Incorrect API key provided: sk-integration-secret" }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as AddressInfo).port;
  try {
    harness.settings.current = {
      effort: "high",
      maxConcurrent: 4,
      providers: [{
        id: "prov1",
        name: "测试接口",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "sk-integration-secret",
        models: ["model-x"],
      }],
    };
    const result = await call<{ ok: boolean; detail: string }>(harness, "POST", "/api/settings/test", {
      providerId: "prov1",
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, false);
    assert.ok(!result.data.detail.includes("sk-integration-secret"));
    assert.ok(result.data.detail.includes("***"));
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await harness.close();
  }
});

test("PUT /api/settings 保存并发上限，非法值返回 400", async () => {
  const harness = await startHarness();
  try {
    const saved = await call<{ maxConcurrent: number }>(harness, "PUT", "/api/settings", {
      maxConcurrent: 6,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.maxConcurrent, 6);
    assert.equal(harness.settings.current.maxConcurrent, 6);

    const tooLarge = await call(harness, "PUT", "/api/settings", { maxConcurrent: 257 });
    assert.equal(tooLarge.status, 400);
    assert.match(String(tooLarge.data.error), /并发上限/);
    assert.equal(harness.settings.current.maxConcurrent, 6);
  } finally {
    await harness.close();
  }
});

test("PUT /api/settings 保存确认超时、限制和归档保留天数，非法值返回 400", async () => {
  const harness = await startHarness();
  try {
    const saved = await call<{
      approvalTimeoutMinutes: number;
      limits: { historyPage: number; transcriptMessages: number };
      archiveRetentionDays: number;
    }>(harness, "PUT", "/api/settings", {
      approvalTimeoutMinutes: 0,
      limits: { historyPage: 321, transcriptMessages: 6_000 },
      archiveRetentionDays: 7,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.approvalTimeoutMinutes, 0);
    assert.equal(saved.data.limits.historyPage, 321);
    assert.equal(saved.data.limits.transcriptMessages, 6_000);
    assert.equal(saved.data.archiveRetentionDays, 7);
    assert.equal(harness.settings.current.approvalTimeoutMinutes, 0);
    assert.equal(harness.settings.current.limits?.historyPage, 321);
    assert.equal(harness.settings.current.archiveRetentionDays, 7);

    const invalid = await call(harness, "PUT", "/api/settings", { approvalTimeoutMinutes: 1441 });
    assert.equal(invalid.status, 400);
    assert.match(String(invalid.data.error), /确认超时/);
    // 非法请求不能改掉已保存的值。
    assert.equal(harness.settings.current.approvalTimeoutMinutes, 0);
  } finally {
    await harness.close();
  }
});

test("requestBodyBytes 配置生效：超过上限的 JSON 请求返回 413", async () => {
  const harness = await startHarness({
    limits: { ...DEFAULT_LIMITS, requestBodyBytes: 512 },
  });
  try {
    const tooLarge = await call(harness, "PUT", "/api/projects/p1", {
      permission: "x".repeat(4_000),
    });
    assert.equal(tooLarge.status, 413);
    assert.match(String(tooLarge.data.error), /请求过大/);

    // 未超限的请求仍能通过请求体检查，进入正常校验分支。
    const small = await call(harness, "PUT", "/api/projects/p1", { permission: "acceptEdits" });
    assert.equal(small.status, 200);
  } finally {
    await harness.close();
  }
});

test("运行期添加 git 仓库：立即生效并写入 projects.yaml", async () => {
  const harness = await startHarness();
  try {
    const repo = path.join(harness.base, "runtime-repo");
    fs.mkdirSync(repo);
    await exec("git", ["-C", repo, "init", "-q"]);
    const created = await call<{ project: { id: string; git: boolean; available: boolean } }>(
      harness,
      "POST",
      "/api/projects",
      { id: "runtime", name: "运行时", path: repo },
    );
    assert.equal(created.status, 201);
    assert.equal(created.data.project.id, "runtime");
    assert.equal(created.data.project.git, true);
    assert.equal(created.data.project.available, true);

    const list = await call<{ projects: Array<{ id: string }> }>(harness, "GET", "/api/projects");
    assert.ok(list.data.projects.some((project) => project.id === "runtime"));

    const text = fs.readFileSync(path.join(harness.base, "projects.yaml"), "utf8");
    assert.match(text, /^  - id: 'runtime'$/m);
    assert.match(text, /^    path: '.*runtime-repo'$/m);
  } finally {
    await harness.close();
  }
});

test("运行期添加仓库会拒绝非 git 目录、缺失目录、重复 id 和非法 id", async () => {
  const harness = await startHarness();
  try {
    const notGit = await call(harness, "POST", "/api/projects", {
      id: "plain",
      name: "Plain",
      path: path.join(harness.base, "project"),
    });
    assert.equal(notGit.status, 400);
    assert.match(String(notGit.data.error), /不是 git 仓库/);

    const missing = await call(harness, "POST", "/api/projects", {
      id: "gone",
      name: "Gone",
      path: path.join(harness.base, "missing"),
    });
    assert.equal(missing.status, 400);

    const duplicate = await call(harness, "POST", "/api/projects", {
      id: "p2",
      name: "再次",
      path: path.join(harness.base, "git-project"),
    });
    assert.equal(duplicate.status, 409);

    const badId = await call(harness, "POST", "/api/projects", {
      id: "Bad Id",
      name: "X",
      path: path.join(harness.base, "git-project"),
    });
    assert.equal(badId.status, 400);
  } finally {
    await harness.close();
  }
});

test("新建仓库：在母目录下创建 git 仓库并加入项目列表", async () => {
  await withGitIdentity(async () => {
    const harness = await startHarness();
    try {
      const parent = path.join(harness.base, "new-repos");
      fs.mkdirSync(parent);
      const created = await call<{
        project: {
          id: string;
          name: string;
          path: string;
          git: boolean;
          available: boolean;
          removable: boolean;
        };
      }>(harness, "POST", "/api/projects/new", { name: "Demo Repo", parent });
      assert.equal(created.status, 201);
      const repoPath = path.join(parent, "Demo Repo");
      assert.equal(created.data.project.id, "demo-repo");
      assert.equal(created.data.project.name, "Demo Repo");
      assert.equal(created.data.project.path, repoPath);
      assert.equal(created.data.project.git, true);
      assert.equal(created.data.project.available, true);
      assert.equal(created.data.project.removable, true);

      const inside = await exec("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
      assert.equal(inside.stdout.trim(), "true");
      const log = await exec("git", ["-C", repoPath, "log", "--oneline"]);
      assert.equal(log.stdout.trim().split("\n").length, 1);

      const list = await call<{ projects: Array<{ id: string }> }>(harness, "GET", "/api/projects");
      assert.ok(list.data.projects.some((project) => project.id === "demo-repo"));

      const text = fs.readFileSync(path.join(harness.base, "projects.yaml"), "utf8");
      assert.match(text, /^  - id: 'demo-repo'$/m);
      assert.match(text, /^    path: '.*Demo Repo'$/m);
    } finally {
      await harness.close();
    }
  });
});

test("新建仓库：名称推不出 id 时生成兜底 id", async () => {
  await withGitIdentity(async () => {
    const harness = await startHarness();
    try {
      const parent = path.join(harness.base, "new-repos");
      fs.mkdirSync(parent);
      const created = await call<{ project: { id: string; name: string; path: string } }>(
        harness,
        "POST",
        "/api/projects/new",
        { name: "我的仓库", parent },
      );
      assert.equal(created.status, 201);
      assert.match(created.data.project.id, /^repo-[0-9a-f]{8}$/);
      assert.equal(created.data.project.name, "我的仓库");
      assert.equal(created.data.project.path, path.join(parent, "我的仓库"));
    } finally {
      await harness.close();
    }
  });
});

test("新建仓库会拒绝缺失母目录、已存在目录、非法名称和重复 id", async () => {
  await withGitIdentity(async () => {
    const harness = await startHarness();
    try {
      const missingParent = await call(harness, "POST", "/api/projects/new", {
        name: "demo",
        parent: path.join(harness.base, "missing-parent"),
      });
      assert.equal(missingParent.status, 400);
      assert.match(String(missingParent.data.error), /母目录不存在/);

      const parent = path.join(harness.base, "new-repos");
      fs.mkdirSync(parent);
      fs.mkdirSync(path.join(parent, "taken"));
      const exists = await call(harness, "POST", "/api/projects/new", { name: "taken", parent });
      assert.equal(exists.status, 409);
      assert.match(String(exists.data.error), /目录已存在/);

      const badName = await call(harness, "POST", "/api/projects/new", { name: "a/b", parent });
      assert.equal(badName.status, 400);

      const noName = await call(harness, "POST", "/api/projects/new", { name: "", parent });
      assert.equal(noName.status, 400);

      const noParent = await call(harness, "POST", "/api/projects/new", { name: "demo", parent: "" });
      assert.equal(noParent.status, 400);

      const badPermission = await call(harness, "POST", "/api/projects/new", {
        name: "demo",
        parent,
        permission: "root",
      });
      assert.equal(badPermission.status, 400);

      const duplicate = await call(harness, "POST", "/api/projects/new", { name: "p2", parent });
      assert.equal(duplicate.status, 409);
      assert.match(String(duplicate.data.error), /项目 id 已存在/);
      assert.equal(fs.existsSync(path.join(parent, "p2")), false);
    } finally {
      await harness.close();
    }
  });
});

test("从设置页删除运行期添加的仓库：立即生效并从 projects.yaml 移除", async () => {
  const harness = await startHarness();
  try {
    const repo = path.join(harness.base, "delete-repo");
    fs.mkdirSync(repo);
    await exec("git", ["-C", repo, "init", "-q"]);
    const created = await call<{ project: { id: string; removable: boolean } }>(
      harness,
      "POST",
      "/api/projects",
      { id: "removable", name: "可删", path: repo },
    );
    assert.equal(created.status, 201);
    assert.equal(created.data.project.removable, true);

    const listed = await call<{ projects: Array<{ id: string; removable: boolean }> }>(
      harness,
      "GET",
      "/api/projects",
    );
    assert.equal(listed.data.projects.find((project) => project.id === "removable")?.removable, true);
    assert.equal(listed.data.projects.find((project) => project.id === "p2")?.removable, false);

    const removed = await call(harness, "DELETE", "/api/projects/removable");
    assert.equal(removed.status, 200);
    const after = await call<{ projects: Array<{ id: string }> }>(harness, "GET", "/api/projects");
    assert.ok(!after.data.projects.some((project) => project.id === "removable"));
    const text = fs.readFileSync(path.join(harness.base, "projects.yaml"), "utf8");
    assert.doesNotMatch(text, /id: 'removable'/);

    const again = await call(harness, "DELETE", "/api/projects/removable");
    assert.equal(again.status, 404);
  } finally {
    await harness.close();
  }
});

test("设置页不能删除 config.yaml 项目和内置项目", async () => {
  const baseProjects: AppConfig["projects"] = [
    { id: "cfg", name: "配置", path: path.join(os.tmpdir(), "cfg-project"), permission: "acceptEdits", isolated: false },
  ];
  const harness = await startHarness({
    projects: [
      ...baseProjects,
      { id: "chat", name: "普通对话", path: path.join(os.tmpdir(), "chat-project"), permission: "acceptEdits", isolated: true, builtin: true },
    ],
    projectsBase: baseProjects,
  });
  try {
    const configured = await call(harness, "DELETE", "/api/projects/cfg");
    assert.equal(configured.status, 400);
    assert.match(String(configured.data.error), /config\.yaml/);

    const builtin = await call(harness, "DELETE", "/api/projects/chat");
    assert.equal(builtin.status, 400);
    assert.match(String(builtin.data.error), /内置项目不能删除/);
  } finally {
    await harness.close();
  }
});

test("合入状态接口返回基准分支和已合入的会话分支", async () => {
  const harness = await startHarness();
  try {
    const empty = await call<{ base: string | null; merged: string[]; untouched: string[] }>(
      harness,
      "GET",
      "/api/projects/p2/merge-status",
    );
    assert.equal(empty.status, 200);
    // 测试仓库的默认分支可能是 main 也可能是 master。
    const base = empty.data.base;
    assert.ok(base === "main" || base === "master");
    assert.deepEqual(empty.data.merged, []);
    assert.deepEqual(empty.data.untouched, []);

    // 新会话的分支从默认分支的 HEAD 建立，还没有自己的提交，因此已经算合入，
    // 同时也被标记为从未改过代码。
    const id = await createSession(harness, "p2", "做点事");
    const status = await call<{ base: string | null; merged: string[]; untouched: string[] }>(
      harness,
      "GET",
      "/api/projects/p2/merge-status",
    );
    assert.equal(status.data.base, base);
    assert.deepEqual(status.data.merged, [`qubius/${id}`]);
    assert.deepEqual(status.data.untouched, [`qubius/${id}`]);

    // 非 git 项目没有可比较的分支。
    const plain = await call<{ base: string | null; merged: string[]; untouched: string[] }>(
      harness,
      "GET",
      "/api/projects/p1/merge-status",
    );
    assert.equal(plain.data.base, null);
    assert.deepEqual(plain.data.merged, []);
    assert.deepEqual(plain.data.untouched, []);

    const missing = await call(harness, "GET", "/api/projects/nope/merge-status");
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test("Git 路由查看状态、提交，并在没有 origin 时拒绝推送", async () => {
  const harness = await startHarness();
  try {
    const id = await createSession(harness, "p2", "改文件");
    const waited = await waitFor(
      () => call<{ session: { phase: string; cwd: string } }>(harness, "GET", `/api/sessions/${id}`),
      (value) => value.data.session.phase !== "running" && value.data.session.phase !== "queued",
    );
    const cwd = waited.data.session.cwd;
    fs.appendFileSync(path.join(cwd, "a.txt"), "changed\n");

    const status = await call<{ branch: string; clean: boolean; dirty: string[] }>(harness, "GET", `/api/sessions/${id}/git`);
    assert.equal(status.status, 200);
    assert.match(status.data.branch, /^qubius\//);
    assert.equal(status.data.clean, false);
    assert.deepEqual(status.data.dirty, ["a.txt"]);

    const committed = await call<{ committed: boolean; pushed: boolean }>(harness, "POST", `/api/sessions/${id}/git`, {
      action: "commit",
      message: "测试提交",
    });
    assert.equal(committed.status, 200);
    assert.equal(committed.data.committed, true);
    assert.equal(committed.data.pushed, false);

    const push = await call<{ error: string }>(harness, "POST", `/api/sessions/${id}/git`, { action: "push" });
    assert.equal(push.status, 400);
    assert.match(push.data.error, /origin/);
  } finally {
    await harness.close();
  }
});
