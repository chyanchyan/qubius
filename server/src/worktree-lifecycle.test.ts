import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig, WorktreeConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import { Store } from "./store.js";
import type { Effort, SessionCore } from "./types.js";
import { createWorktree } from "./worktree.js";

interface Harness {
  url: string;
  base: string;
  dataDir: string;
  projectPath: string;
  store: Store;
  runtime: Runtime;
  close: () => Promise<void>;
}

const SETUP_MARKER = "prepared.txt";
/** 跨平台可用的 setup：在 worktree 里写一个标记文件。 */
const WRITE_MARKER = `node -e "require('fs').writeFileSync('${SETUP_MARKER}','prepared')"`;

async function startHarness(options: { worktree?: WorktreeConfig } = {}): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-worktree-lifecycle-"));
  const dataDir = path.join(base, "data");
  const projectPath = path.join(base, "project");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync("git", ["-C", projectPath, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", projectPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", projectPath, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(projectPath, ".gitignore"), ".env\n.cache/\n");
  fs.writeFileSync(path.join(projectPath, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(projectPath, "tracked.txt"), "tracked\n");
  fs.mkdirSync(path.join(projectPath, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, ".cache", "keep.txt"), "cache\n");
  execFileSync("git", ["-C", projectPath, "add", "."]);
  execFileSync("git", ["-C", projectPath, "commit", "-qm", "init"]);

  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 4,
    configDir: base,
    role: "primary",
    projects: [{
      id: "p1",
      name: "Git",
      path: projectPath,
      permission: "acceptEdits",
      isolated: false,
      ...(options.worktree ? { worktree: options.worktree } : {}),
    }],
  };
  const settings = {
    current: {
      effort: "high" as Effort,
      providers: [{
        id: "prov1",
        name: "测试接口",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "sk-test",
        models: ["model-x"],
      }],
      maxConcurrent: 4,
    } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: config.maxConcurrent,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => ["sk-test"],
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
    store,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * 直接写会话 JSON 而不是走 HTTP 创建：父会话不需要执行 worktree 准备，
 * 这里只验证分叉出的新 worktree 是否会重跑准备步骤。
 */
async function createSettledGitParent(harness: Harness): Promise<{ id: string; cwd: string }> {
  const id = randomUUID();
  const created = await createWorktree({
    projectPath: harness.projectPath,
    projectId: "p1",
    sessionId: id,
    dataDir: harness.dataDir,
  });
  const now = new Date().toISOString();
  const session: SessionCore = {
    id,
    projectId: "p1",
    projectPath: harness.projectPath,
    title: "父会话",
    providerId: "prov1",
    providerName: "测试接口",
    model: "model-x",
    effort: "high",
    cwd: created.cwd,
    branch: created.branch,
    git: true,
    summary: "摘要",
    phase: "completed",
    lastResult: "success",
    turnActive: false,
    queued: false,
    subagents: [],
    messages: [{
      id: "m1",
      role: "user",
      text: "第一条",
      sdkUuid: "sdk-1",
      forkPoint: "fork-1",
    }],
    pending: null,
    seen: [],
    createdAt: now,
    updatedAt: now,
  };
  const dir = path.join(harness.dataDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(session));
  assert.ok(harness.store.loadFromDisk(id));
  return { id, cwd: created.cwd };
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("分叉 git 会话时新 worktree 会重跑 include/共享目录/setup", async () => {
  const harness = await startHarness({
    worktree: {
      include: [".env"],
      sharedDirectories: [".cache"],
      setup: WRITE_MARKER,
      setupTimeoutSeconds: 30,
    },
  });
  try {
    const parent = await createSettledGitParent(harness);
    const fork = await postJson(`${harness.url}/api/sessions/${parent.id}/fork`, {
      messageId: "m1",
    });
    assert.equal(fork.status, 201, JSON.stringify(fork.body));
    const childCwd: string = fork.body.session.cwd;
    assert.notEqual(childCwd, parent.cwd);

    // include：gitignored 的 .env 被复制到新 worktree。
    assert.equal(fs.readFileSync(path.join(childCwd, ".env"), "utf8"), "SECRET=1\n");
    // 共享目录：以符号链接（Windows 是 junction）指向项目里的 .cache。
    const linked = fs.lstatSync(path.join(childCwd, ".cache"));
    assert.ok(linked.isSymbolicLink());
    assert.ok(fs.existsSync(path.join(childCwd, ".cache", "keep.txt")));
    // setup：在 new worktree 中执行过。
    assert.equal(fs.readFileSync(path.join(childCwd, SETUP_MARKER), "utf8"), "prepared");
  } finally {
    await harness.close();
  }
});

test("分叉时 worktree 准备失败会清理新 worktree 并返回错误", async () => {
  const harness = await startHarness({
    worktree: {
      setup: "exit 1",
      setupTimeoutSeconds: 30,
      sharedDirectories: [],
      include: [],
    },
  });
  try {
    const parent = await createSettledGitParent(harness);
    const fork = await postJson(`${harness.url}/api/sessions/${parent.id}/fork`, {
      messageId: "m1",
    });
    assert.equal(fork.status, 500, JSON.stringify(fork.body));
    assert.match(String(fork.body.error), /worktree setup 命令失败/);
    // 只留下父会话自己的 worktree，分叉的半成品目录被清理。
    const worktrees = path.join(harness.dataDir, "worktrees", "p1");
    assert.deepEqual(fs.readdirSync(worktrees), [parent.id]);
  } finally {
    await harness.close();
  }
});
