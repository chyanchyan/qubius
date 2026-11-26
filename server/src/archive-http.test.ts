import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArchiveStore } from "./archive.js";
import type { AppConfig } from "./config.js";
import { createAppServer } from "./http.js";
import { ArchiveSweeper } from "./retention.js";
import type { Runtime } from "./runtime.js";
import { tryLockSession, unlockSession } from "./session-lock.js";
import { Store } from "./store.js";
import type { Effort } from "./types.js";
import { createWorktree } from "./worktree.js";

const ID = "33333333-3333-4333-8333-333333333333";
const ID2 = "44444444-4444-4444-8444-444444444444";

interface Harness {
  url: string;
  base: string;
  dataDir: string;
  archiveDir: string;
  sdkDir: string;
  projectPath: string;
  store: Store;
  runtime: Runtime;
  archive: ArchiveStore;
  close: () => Promise<void>;
}

async function startHarness(options: { serveArchive?: boolean } = {}): Promise<Harness> {
  const serveArchive = options.serveArchive !== false;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-archive-http-"));
  const dataDir = path.join(base, "data");
  const archiveDir = path.join(base, "hdd");
  const sdkDir = path.join(base, "sdk");
  const projectPath = path.join(base, "project");
  for (const dir of [dataDir, archiveDir, sdkDir, projectPath]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [
      { id: "p1", name: "项目", path: projectPath, permission: "acceptEdits", isolated: false },
    ],
  };
  const store = new Store(dataDir);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const runtime = {
    stop: async () => {},
    isShuttingDown: () => false,
  } as unknown as Runtime;
  const sweeper = new ArchiveSweeper({ archive, store, runtime, retentionDays: 30 });
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings: { current: { providers: [], effort: "high" as Effort, maxConcurrent: 4 } },
    permissions: { current: {} },
    repoRoot: base,
    archive: serveArchive ? archive : undefined,
    sweeper: serveArchive ? sweeper : undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    base,
    dataDir,
    archiveDir,
    sdkDir,
    projectPath,
    store,
    runtime,
    archive,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function createSession(harness: Harness, id: string, prompt = "你好", projectId = "p1") {
  return harness.store.create({
    id,
    projectId,
    projectPath: harness.projectPath,
    title: "旧对话",
    providerId: "prov",
    providerName: "服务商",
    model: "model-x",
    effort: "high",
    cwd: harness.projectPath,
    git: false,
    prompt,
  });
}

function createSessionAt(
  harness: Harness,
  id: string,
  cwd: string,
  projectPath = harness.projectPath,
) {
  return harness.store.create({
    id,
    projectId: "p1",
    projectPath,
    title: "旧对话",
    providerId: "prov",
    providerName: "服务商",
    model: "model-x",
    effort: "high",
    cwd,
    git: false,
    prompt: "你好",
  });
}

function writeSdkTranscript(harness: Harness, id: string): string {
  const dir = path.join(harness.sdkDir, "projects", "-tmp-project");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, '{"type":"user"}\n');
  return file;
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

test("归档接口：列表、详情、恢复、删除和状态", async () => {
  const harness = await startHarness();
  try {
    const session = createSession(harness, ID);
    const transcript = writeSdkTranscript(harness, ID);
    await harness.archive.archive(session);
    // 定期快照：本机副本还在且没有删除意图时，归档列表不重复显示它。
    const hidden = await json(`${harness.url}/api/archive/sessions?projectId=p1`);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.sessions.length, 0);
    // 归档列表只显示已经不在 SSD 上的会话；这里模拟到期清理。
    harness.store.remove(ID);

    const list = await json(`${harness.url}/api/archive/sessions?projectId=p1`);
    assert.equal(list.status, 200);
    assert.equal(list.body.enabled, true);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(list.body.sessions[0]?.id, ID);

    const detail = await json(`${harness.url}/api/archive/sessions/${ID}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.messages[0]?.text, "你好");

    const status = await json(`${harness.url}/api/archive/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.archive.enabled, true);
    assert.equal(status.body.archive.instance, "main");
    assert.equal(status.body.archive.archived, 1);

    fs.rmSync(transcript, { force: true });
    const restored = await json(`${harness.url}/api/archive/sessions/${ID}/restore`, { method: "POST", body: "{}" });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.session.id, ID);
    assert.ok(harness.store.get(ID));
    assert.ok(fs.existsSync(transcript));

    const removed = await json(`${harness.url}/api/archive/sessions/${ID}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await harness.archive.list()).length, 0);
    const missing = await json(`${harness.url}/api/archive/sessions/${ID}`);
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test("手动删除会话前先冷备份，归档保留且可恢复", async () => {
  const harness = await startHarness();
  try {
    createSession(harness, ID2);
    const transcript = writeSdkTranscript(harness, ID2);

    const deleted = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(harness.store.get(ID2), undefined);
    assert.equal(fs.existsSync(transcript), false);

    const archives = await harness.archive.list();
    assert.equal(archives.length, 1);
    assert.equal(archives[0]?.id, ID2);

    const list = await json(`${harness.url}/api/archive/sessions?projectId=p1`);
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(list.body.sessions[0]?.id, ID2);

    const restored = await json(`${harness.url}/api/archive/sessions/${ID2}/restore`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.session.id, ID2);
    assert.ok(harness.store.get(ID2));
    assert.equal((await harness.archive.list()).length, 1);
  } finally {
    await harness.close();
  }
});

test("删除前重新冷备份，归档里是修改后的最新会话", async () => {
  const harness = await startHarness();
  try {
    createSession(harness, ID2);
    await harness.archive.archive(harness.store.get(ID2)!);
    assert.equal((await harness.archive.list()).length, 1);

    // 归档之后会话又有新内容：删除时应重新完整复制，而不是沿用旧归档。
    const live = harness.store.get(ID2)!;
    live.messages = [
      ...live.messages,
      { id: "new-message", role: "assistant", text: "归档之后的新内容" },
    ];
    live.updatedAt = new Date().toISOString();
    harness.store.updateMeta(ID2, { pinned: true });
    await harness.store.flush();

    const deleted = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);

    const detail = await json(`${harness.url}/api/archive/sessions/${ID2}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.messages.at(-1)?.text, "归档之后的新内容");
    assert.equal(detail.body.session.pinned, true);
  } finally {
    await harness.close();
  }
});

test("删除运行中会话时归档包含 stop 收尾期间的新消息", async () => {
  const harness = await startHarness();
  try {
    createSession(harness, ID2);
    // stop() 等待 SDK 收尾期间仍可能有最后一条消息提交到 Store（CoW 生成新对象）。
    harness.runtime.stop = async (id: string) => {
      harness.store.apply(id, {
        type: "assistant",
        uuid: "stop-message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "stop 收尾期间新增" }],
        },
      });
    };

    const deleted = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(harness.store.get(ID2), undefined);

    const detail = await json(`${harness.url}/api/archive/sessions/${ID2}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.messages.at(-1)?.text, "stop 收尾期间新增");
  } finally {
    await harness.close();
  }
});

test("旧归档 meta 损坏时隔离后重建，删除成功", async () => {
  const harness = await startHarness();
  try {
    createSession(harness, ID2);
    const transcript = writeSdkTranscript(harness, ID2);
    const sessionsDir = path.join(harness.archiveDir, "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const metaPath = path.join(sessionsDir, `${ID2}.meta.json`);
    fs.writeFileSync(metaPath, "不是 JSON");

    const deleted = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(harness.store.get(ID2), undefined);
    assert.equal(fs.existsSync(transcript), false);

    const list = await json(`${harness.url}/api/archive/sessions?projectId=p1`);
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    const detail = await json(`${harness.url}/api/archive/sessions/${ID2}`);
    assert.equal(detail.status, 200);

    const broken = fs
      .readdirSync(sessionsDir)
      .filter((name) => name.startsWith(`${ID2}.meta.json.broken-`));
    assert.equal(broken.length, 1);
    assert.equal(fs.readFileSync(path.join(sessionsDir, broken[0]!), "utf8"), "不是 JSON");
  } finally {
    await harness.close();
  }
});

test("归档目录不可写时 DELETE 失败且会话保留，权限恢复后重试成功", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const harness = await startHarness();
  try {
    createSession(harness, ID2);
    const transcript = writeSdkTranscript(harness, ID2);
    // chmod 父目录让状态预检和 archive() 都写入失败。
    fs.chmodSync(harness.archiveDir, 0o555);
    try {
      const failed = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
      assert.equal(failed.status, 500);
      assert.match(failed.body.error, /归档失败，会话仍在/);
      assert.match(failed.body.error, /归档目录不可写/);
      assert.ok(harness.store.get(ID2));
      assert.ok(fs.existsSync(transcript));
      // fail-closed：预检失败时连归档根目录都不应创建。
      assert.equal(fs.existsSync(path.join(harness.archiveDir, "main")), false);
    } finally {
      fs.chmodSync(harness.archiveDir, 0o755);
    }

    const retry = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(retry.status, 200);
    assert.equal(harness.store.get(ID2), undefined);
    assert.equal(fs.existsSync(transcript), false);
    assert.equal((await harness.archive.list()).length, 1);
  } finally {
    await harness.close();
  }
});

test("未配置归档时手动删除仍是真删", async () => {
  const harness = await startHarness({ serveArchive: false });
  try {
    createSession(harness, ID2);
    const transcript = writeSdkTranscript(harness, ID2);
    // 没有 ArchiveStore 时走默认 Claude 配置目录；测试里临时指向 harness 的 sdkDir。
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = harness.sdkDir;
    try {
      const deleted = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.equal(harness.store.get(ID2), undefined);
      assert.equal(fs.existsSync(transcript), false);
      assert.equal(fs.existsSync(path.join(harness.archiveDir, "main")), false);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  } finally {
    await harness.close();
  }
});

test("恢复同名会话返回 409，非法 id/方法返回 400/405", async () => {
  const harness = await startHarness();
  try {
    const session = createSession(harness, ID);
    writeSdkTranscript(harness, ID);
    await harness.archive.archive(session);

    const sameName = await json(`${harness.url}/api/archive/sessions/${ID}/restore`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(sameName.status, 409);

    const badId = await json(`${harness.url}/api/archive/sessions/not-a-uuid`);
    assert.equal(badId.status, 400);

    const bogus = await json(`${harness.url}/api/archive/sessions/${ID}/bogus`);
    assert.equal(bogus.status, 404);

    const wrongMethod = await json(`${harness.url}/api/archive/sessions/${ID}/restore`);
    assert.equal(wrongMethod.status, 405);

    const collectionPost = await json(`${harness.url}/api/archive/sessions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(collectionPost.status, 405);

    const sweepGet = await json(`${harness.url}/api/archive/sweep`);
    assert.equal(sweepGet.status, 405);
  } finally {
    await harness.close();
  }
});

test("未配置归档时状态/列表可读，其余接口返回 503", async () => {
  const harness = await startHarness({ serveArchive: false });
  try {
    const status = await json(`${harness.url}/api/archive/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.archive.enabled, false);

    const list = await json(`${harness.url}/api/archive/sessions?projectId=p1`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, { enabled: false, sessions: [] });

    const id = "55555555-5555-4555-8555-555555555555";
    const detail = await json(`${harness.url}/api/archive/sessions/${id}`);
    assert.equal(detail.status, 503);
    const restore = await json(`${harness.url}/api/archive/sessions/${id}/restore`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(restore.status, 503);
    const remove = await json(`${harness.url}/api/archive/sessions/${id}`, { method: "DELETE" });
    assert.equal(remove.status, 503);
    const sweep = await json(`${harness.url}/api/archive/sweep`, { method: "POST", body: "{}" });
    assert.equal(sweep.status, 503);
  } finally {
    await harness.close();
  }
});

test("手动整理返回 202，状态可以轮询到结束", async () => {
  const harness = await startHarness();
  try {
    const started = await json(`${harness.url}/api/archive/sweep`, { method: "POST", body: "{}" });
    assert.equal(started.status, 202);
    assert.equal(started.body.sweeping, true);
    let sweeping = true;
    for (let index = 0; index < 40 && sweeping; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const status = await json(`${harness.url}/api/archive/status`);
      sweeping = status.body.archive.sweeping;
    }
    assert.equal(sweeping, false);
  } finally {
    await harness.close();
  }
});

test("归档所属项目已不存在时拒绝恢复", async () => {
  const harness = await startHarness();
  try {
    const id = "66666666-6666-4666-8666-666666666666";
    const session = createSession(harness, id, "你好", "gone");
    await harness.archive.archive(session);
    harness.store.remove(id);
    const restored = await json(`${harness.url}/api/archive/sessions/${id}/restore`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(restored.status, 409);
    assert.match(restored.body.error, /项目/);
  } finally {
    await harness.close();
  }
});

test("transcript 删不掉时 DELETE 失败且会话保留，权限恢复后可以重试", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const harness = await startHarness();
  try {
    createSession(harness, ID2);
    const transcript = writeSdkTranscript(harness, ID2);
    const dir = path.dirname(transcript);
    fs.chmodSync(dir, 0o555);
    try {
      const failed = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
      assert.equal(failed.status, 500);
      assert.ok(harness.store.get(ID2));
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    const retry = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(retry.status, 200);
    assert.equal(harness.store.get(ID2), undefined);
    assert.equal(fs.existsSync(transcript), false);
  } finally {
    await harness.close();
  }
});

test("恢复不存在的归档返回 404，清理中的 restore/delete 返回 409", async () => {
  const harness = await startHarness();
  try {
    const missingId = "77777777-7777-4777-8777-777777777777";
    const missing = await json(`${harness.url}/api/archive/sessions/${missingId}/restore`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(missing.status, 404);

    const session = createSession(harness, ID);
    await harness.archive.archive(session);
    harness.store.remove(ID);
    assert.equal(tryLockSession(ID), true);
    try {
      const restore = await json(`${harness.url}/api/archive/sessions/${ID}/restore`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(restore.status, 409);
      const remove = await json(`${harness.url}/api/archive/sessions/${ID}`, { method: "DELETE" });
      assert.equal(remove.status, 409);
    } finally {
      unlockSession(ID);
    }
  } finally {
    await harness.close();
  }
});

test("会话被清理锁住时消息写入返回 409", async () => {
  const harness = await startHarness();
  try {
    createSession(harness, ID2);
    assert.equal(tryLockSession(ID2), true);
    try {
      const message = await json(`${harness.url}/api/sessions/${ID2}/messages`, {
        method: "POST",
        body: JSON.stringify({ prompt: "还在吗" }),
      });
      assert.equal(message.status, 409);
      const diff = await json(`${harness.url}/api/sessions/${ID2}/diff`);
      assert.equal(diff.status, 200);
    } finally {
      unlockSession(ID2);
    }
  } finally {
    await harness.close();
  }
});

test("恢复只使用当前配置推导的 cwd，不删除归档里的旧路径", async () => {
  const harness = await startHarness();
  try {
    const victim = path.join(harness.base, "victim");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "keep.txt"), "keep");
    const session = createSessionAt(harness, ID, victim);
    await harness.archive.archive(session);
    harness.store.remove(ID);

    const restored = await json(`${harness.url}/api/archive/sessions/${ID}/restore`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.session.cwd, harness.projectPath);
    assert.ok(fs.existsSync(path.join(victim, "keep.txt")));
  } finally {
    await harness.close();
  }
});

test("删除 isolated 会话会删掉它自己的目录", async () => {
  const harness = await startHarness();
  try {
    const cwd = path.join(harness.projectPath, ID2);
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, "work.txt"), "work");
    createSessionAt(harness, ID2, cwd);
    const deleted = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(fs.existsSync(cwd), false);
  } finally {
    await harness.close();
  }
});

test("冷备完成后清理失败：归档列表显示待清理，重试只补未完成步骤", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const harness = await startHarness();
  try {
    // 真实 git 仓库 + worktree，模拟 Windows 上「注册项已删、目录被占用」的清理失败。
    const git = (...args: string[]) => execFileSync("git", ["-C", harness.projectPath, ...args], {
      encoding: "utf8",
    });
    execFileSync("git", ["init", "-b", "main", harness.projectPath], { encoding: "utf8" });
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(harness.projectPath, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    const created = await createWorktree({
      projectPath: harness.projectPath,
      projectId: "p1",
      sessionId: ID2,
      dataDir: harness.dataDir,
    });
    harness.store.create({
      id: ID2,
      projectId: "p1",
      projectPath: harness.projectPath,
      title: "旧对话",
      providerId: "prov",
      providerName: "服务商",
      model: "model-x",
      effort: "high",
      cwd: created.cwd,
      branch: created.branch,
      git: true,
      prompt: "你好",
    });
    fs.writeFileSync(path.join(created.cwd, "work.txt"), "work\n");

    // 目录父级不可写：git 删掉注册项后无法再删目录，降级递归删除也会失败。
    const worktreesParent = path.dirname(created.cwd);
    fs.chmodSync(worktreesParent, 0o555);
    try {
      const failed = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
      assert.equal(failed.status, 500);
      assert.match(failed.body.error, /无法清理对话目录/);
      assert.ok(harness.store.get(ID2));
    } finally {
      fs.chmodSync(worktreesParent, 0o755);
    }

    // 冷备已完成并打上待清理标记；归档列表仍要显示它（以前会被一刀切隐藏）。
    const meta = await harness.archive.meta(ID2);
    assert.equal(meta?.pendingDelete, true);
    const archivedAt = meta!.archivedAt;
    const list = await json(`${harness.url}/api/archive/sessions?projectId=p1`);
    assert.equal(list.status, 200);
    const pending = list.body.sessions.find((item: { id: string }) => item.id === ID2);
    assert.ok(pending);
    assert.equal(pending.pendingDelete, true);
    assert.equal(pending.local, true);

    // 重试：跳过重复冷备，只补删目录和会话。
    const retry = await json(`${harness.url}/api/sessions/${ID2}`, { method: "DELETE" });
    assert.equal(retry.status, 200);
    assert.equal(harness.store.get(ID2), undefined);
    assert.equal(fs.existsSync(created.cwd), false);
    const after = await harness.archive.meta(ID2);
    assert.equal(after?.pendingDelete, undefined);
    assert.equal(after?.archivedAt, archivedAt);

    const list2 = await json(`${harness.url}/api/archive/sessions?projectId=p1`);
    assert.equal(list2.status, 200);
    const normal = list2.body.sessions.find((item: { id: string }) => item.id === ID2);
    assert.ok(normal);
    assert.equal(normal.local, false);
    assert.equal(normal.pendingDelete, undefined);
  } finally {
    await harness.close();
  }
});
