import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArchiveStore } from "./archive.js";
import { ArchiveSweeper } from "./retention.js";
import { sessionSdkIds } from "./sdk-files.js";
import type { Runtime } from "./runtime.js";
import { tryLockSession, unlockSession } from "./session-lock.js";
import { Store, toSummary } from "./store.js";
import type { SessionCore } from "./types.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
// 恢复会检查项目目录存在；给所有默认会话一个固定的临时项目根。
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rc-archive-project-"));

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSession(
  id: string,
  updatedAt = new Date().toISOString(),
  overrides: Partial<SessionCore> = {},
): SessionCore {
  return {
    id,
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    title: `标题 ${id.slice(0, 4)}`,
    providerId: "prov1",
    providerName: "服务商",
    model: "model-x",
    effort: "high",
    cwd: PROJECT_ROOT,
    git: false,
    summary: "摘要",
    phase: "completed",
    turnActive: false,
    queued: false,
    subagents: [],
    messages: [{ id: "m1", role: "user", text: "你好" }],
    pending: null,
    seen: [],
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

function writeSession(dataDir: string, session: SessionCore): void {
  const dir = path.join(dataDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session));
}

function setup() {
  const base = tempDir("rc-archive-");
  const dataDir = path.join(base, "data");
  const archiveDir = path.join(base, "hdd");
  const sdkDir = path.join(base, "sdk");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(sdkDir, { recursive: true });
  return { base, dataDir, archiveDir, sdkDir };
}

function writeSdkFiles(sdkDir: string, id: string): void {
  const project = path.join(sdkDir, "projects", "-tmp-project");
  fs.mkdirSync(path.join(project, id, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(project, id, "subagents", "agent-a.jsonl"), '{"type":"assistant"}\n');
  const env = path.join(sdkDir, "session-env", id);
  fs.mkdirSync(env, { recursive: true });
  fs.writeFileSync(path.join(env, "env.json"), "{}");
}

test("归档会保存会话、图片和 SDK transcript，并能完整恢复", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID);
  writeSession(dataDir, session);
  const imageDir = path.join(dataDir, "images", ID);
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeSdkFiles(sdkDir, ID);

  const root = path.join(archiveDir, "main");
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
    now: () => new Date("2026-02-01T00:00:00.000Z"),
  });
  const store = new Store(dataDir);
  const meta = await archive.archive(store.require(ID));

  assert.equal(meta.id, ID);
  assert.equal(meta.messageCount, 1);
  assert.ok(fs.existsSync(path.join(root, "sessions", `${ID}.json`)));
  assert.ok(fs.existsSync(path.join(root, "sessions", `${ID}.meta.json`)));
  assert.ok(fs.existsSync(path.join(root, "images", ID, "pic.png")));
  assert.ok(fs.existsSync(path.join(root, "sdk", "projects", "-tmp-project", `${ID}.jsonl`)));
  assert.ok(fs.existsSync(path.join(root, "sdk", "projects", "-tmp-project", ID, "subagents", "agent-a.jsonl")));
  assert.ok(fs.existsSync(path.join(root, "sdk", "session-env", ID, "env.json")));
  await archive.verify(ID);

  const list = await archive.list("p1");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.archivedAt, "2026-02-01T00:00:00.000Z");
  assert.equal((await archive.list("other")).length, 0);
  const detail = await archive.detail(ID);
  assert.equal(detail.session.messages?.[0]?.text, "你好");

  // 模拟 SSD 上的记录消失，再从归档恢复。
  fs.rmSync(path.join(dataDir, "sessions", `${ID}.json`), { force: true });
  fs.rmSync(imageDir, { recursive: true, force: true });
  fs.rmSync(path.join(sdkDir, "projects", "-tmp-project", `${ID}.jsonl`), { force: true });
  fs.rmSync(path.join(sdkDir, "projects", "-tmp-project", ID), { recursive: true, force: true });
  fs.rmSync(path.join(sdkDir, "session-env", ID), { recursive: true, force: true });

  const freshStore = new Store(dataDir);
  await archive.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    git: false,
  });
  const restored = freshStore.loadFromDisk(ID);
  assert.ok(restored);
  assert.equal(restored?.messages[0]?.text, "你好");
  // 恢复视为新活动，避免下一轮整理立刻又把它删掉。
  assert.equal(restored?.updatedAt, "2026-02-01T00:00:00.000Z");
  assert.ok(fs.existsSync(path.join(dataDir, "images", ID, "pic.png")));
  assert.ok(fs.existsSync(path.join(sdkDir, "projects", "-tmp-project", `${ID}.jsonl`)));
  assert.ok(fs.existsSync(path.join(sdkDir, "session-env", ID, "env.json")));
  // 恢复不是移走：归档副本仍然存在。
  assert.equal((await archive.list()).length, 1);

  assert.equal(await archive.remove(ID), true);
  assert.equal((await archive.list()).length, 0);
  assert.equal(fs.existsSync(path.join(root, "sessions", `${ID}.json`)), false);
  assert.equal(await archive.remove(ID), false);
});

test("实例名决定归档子目录，非法实例名和 id 会被拒绝", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const main = new ArchiveStore({ dir: archiveDir, instance: "main", dataDir, retentionDays: 30, sdkConfigDir: sdkDir });
  const bak = new ArchiveStore({ dir: archiveDir, instance: "bak", dataDir, retentionDays: 30, sdkConfigDir: sdkDir });
  assert.equal(main.root, path.join(archiveDir, "main"));
  assert.equal(bak.root, path.join(archiveDir, "bak"));
  assert.throws(
    () => new ArchiveStore({ dir: archiveDir, instance: "../x", dataDir, retentionDays: 30 }),
    /实例名/,
  );
  await assert.rejects(() => main.archive(makeSession("../x")), /id/);
});

test("超过保留期的会话先归档再删除，保留期内的不动", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const old = makeSession(ID, "2026-01-01T00:00:00.000Z");
  const fresh = makeSession(ID2, "2026-03-01T00:00:00.000Z");
  writeSession(dataDir, old);
  writeSession(dataDir, fresh);
  writeSdkFiles(sdkDir, ID);

  const store = new Store(dataDir);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const runtime = { stop: async () => {} } as unknown as Runtime;
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 30,
    now: () => new Date("2026-03-05T00:00:00.000Z"),
  });

  const result = await sweeper.run();
  assert.equal(result.failed.length, 0);
  assert.equal(result.archived, 1);
  assert.equal(result.removed, 1);
  assert.equal(store.get(ID), undefined);
  assert.ok(store.get(ID2));
  assert.equal(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)), false);
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID2}.json`)));
  assert.ok(fs.existsSync(path.join(archive.root, "sessions", `${ID}.json`)));
  assert.equal(fs.existsSync(path.join(sdkDir, "projects", "-tmp-project", `${ID}.jsonl`)), false);
  assert.ok(fs.existsSync(path.join(archive.root, "sdk", "projects", "-tmp-project", `${ID}.jsonl`)));

  // 过期会话仍可恢复。
  await archive.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    git: false,
  });
  assert.ok(store.loadFromDisk(ID));
});

test("定期清理删除本地副本后清掉 diff 评论文件，未到期会话的评论保留", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  writeSession(dataDir, makeSession(ID, "2026-01-01T00:00:00.000Z"));
  writeSession(dataDir, makeSession(ID2, "2026-03-04T00:00:00.000Z"));
  writeSdkFiles(sdkDir, ID);
  const commentsDir = path.join(dataDir, "diff-comments");
  fs.mkdirSync(commentsDir, { recursive: true });
  const removedComments = path.join(commentsDir, `${ID}.json`);
  const keptComments = path.join(commentsDir, `${ID2}.json`);
  fs.writeFileSync(removedComments, "[]\n");
  fs.writeFileSync(keptComments, "[]\n");

  const store = new Store(dataDir);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const runtime = { stop: async () => {} } as unknown as Runtime;
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 30,
    dataDir,
    now: () => new Date("2026-03-05T00:00:00.000Z"),
  });

  const result = await sweeper.run();
  assert.equal(result.failed.length, 0);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(removedComments), false);
  // 未到期、还在使用的会话评论不能删。
  assert.ok(fs.existsSync(keptComments));
});

test("到期前先做快照，到期后复用快照删除且不覆盖已归档的 transcript", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const updated = "2026-02-08T00:00:00.000Z";
  writeSession(dataDir, makeSession(ID, updated));
  writeSdkFiles(sdkDir, ID);

  const store = new Store(dataDir);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const runtime = { stop: async () => {} } as unknown as Runtime;
  let now = new Date("2026-03-05T00:00:00.000Z");
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 30,
    now: () => now,
  });

  const first = await sweeper.run();
  assert.equal(first.archived, 1);
  assert.equal(first.removed, 0);
  assert.ok(store.get(ID));
  const archivedTranscript = path.join(
    archive.root,
    "sdk",
    "projects",
    "-tmp-project",
    `${ID}.jsonl`,
  );
  assert.ok(fs.existsSync(archivedTranscript));

  // 模拟 Claude Code 的 30 天清理先删掉源 transcript；此时应复用旧快照。
  fs.rmSync(path.join(sdkDir, "projects", "-tmp-project", `${ID}.jsonl`), { force: true });
  now = new Date("2026-03-10T00:00:00.000Z");
  const second = await sweeper.run();
  assert.equal(second.archived, 0);
  assert.equal(second.removed, 1);
  assert.equal(store.get(ID), undefined);
  assert.ok(fs.existsSync(archivedTranscript));
});

test("归档目录不可写时保留 SSD 上的会话并报告失败", async () => {
  const { base, dataDir } = setup();
  const blocker = path.join(base, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  writeSession(dataDir, makeSession(ID, "2026-01-01T00:00:00.000Z"));
  const store = new Store(dataDir);
  const archive = new ArchiveStore({
    dir: path.join(blocker, "hdd"),
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: path.join(base, "sdk"),
  });
  const runtime = { stop: async () => {} } as unknown as Runtime;
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 30,
    now: () => new Date("2026-03-05T00:00:00.000Z"),
  });

  const result = await sweeper.run();
  assert.equal(result.removed, 0);
  assert.equal(result.failed.length, 1);
  assert.ok(store.get(ID));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)));
});

test("长保留期也会在 Claude 30 天清理前做快照", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  writeSession(dataDir, makeSession(ID, "2026-01-01T00:00:00.000Z"));
  writeSdkFiles(sdkDir, ID);
  const store = new Store(dataDir);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 3650,
    sdkConfigDir: sdkDir,
  });
  const runtime = { stop: async () => {} } as unknown as Runtime;
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 3650,
    now: () => new Date("2026-01-25T00:00:00.000Z"),
  });

  const result = await sweeper.run();
  assert.equal(result.archived, 1);
  assert.equal(result.removed, 0);
  assert.ok(store.get(ID));
  assert.ok(fs.existsSync(path.join(
    archive.root,
    "sdk",
    "projects",
    "-tmp-project",
    `${ID}.jsonl`,
  )));
});

test("源 transcript 被清理后重归档不会丢掉旧归档里的副本", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID);
  writeSession(dataDir, session);
  writeSdkFiles(sdkDir, ID);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  await archive.archive(session);
  const archivedTranscript = path.join(
    archive.root,
    "sdk",
    "projects",
    "-tmp-project",
    `${ID}.jsonl`,
  );
  assert.ok(fs.existsSync(archivedTranscript));

  // 模拟 Claude 自己的 30 天清理先删掉源 transcript。
  fs.rmSync(path.join(sdkDir, "projects", "-tmp-project", `${ID}.jsonl`), { force: true });
  const changed = makeSession(ID, "2026-02-02T00:00:00.000Z", {
    messages: [
      ...session.messages,
      { id: "m2", role: "assistant", text: "新回复" },
    ],
  });
  await archive.archive(changed);

  const meta = await archive.verify(ID);
  assert.ok(meta.files.some((file) => file.path.endsWith(`${ID}.jsonl`)));
  assert.ok(fs.existsSync(archivedTranscript));
  assert.equal((await archive.detail(ID)).session.messages?.[1]?.text, "新回复");
});

test("恢复隔离会话会重建自己的子目录", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const cwd = path.join(PROJECT_ROOT, ID);
  fs.rmSync(cwd, { recursive: true, force: true });
  try {
    const session = makeSession(ID, undefined, {
      projectPath: PROJECT_ROOT,
      cwd,
      git: false,
    });
    writeSession(dataDir, session);
    const store = new Store(dataDir);
    const archive = new ArchiveStore({
      dir: archiveDir,
      instance: "main",
      dataDir,
      retentionDays: 30,
      sdkConfigDir: sdkDir,
    });
    await archive.archive(session);
    store.remove(ID);
    await archive.restore(ID, {
      projectId: "p1",
      projectPath: PROJECT_ROOT,
      cwd,
      git: false,
    });
    assert.ok(store.loadFromDisk(ID));
    assert.ok(fs.existsSync(cwd));
    assert.ok(fs.statSync(cwd).isDirectory());
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("恢复 git 会话会重建 worktree", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const base = tempDir("rc-archive-git-");
  try {
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C", repo,
      "-c", "user.name=test",
      "-c", "user.email=test@example.com",
      "commit", "--allow-empty", "-q", "-m", "init",
    ]);
    const cwd = path.join(base, "worktrees", "p1", ID);
    const session = makeSession(ID, undefined, {
      projectPath: repo,
      cwd,
      git: true,
      branch: `qubius/${ID}`,
    });
    writeSession(dataDir, session);
    const store = new Store(dataDir);
    const archive = new ArchiveStore({
      dir: archiveDir,
      instance: "main",
      dataDir,
      retentionDays: 30,
      sdkConfigDir: sdkDir,
    });
    await archive.archive(session);
    store.remove(ID);
    await archive.restore(ID, {
      projectId: "p1",
      projectPath: repo,
      cwd,
      git: true,
      branch: `qubius/${ID}`,
    });
    assert.ok(store.loadFromDisk(ID));
    assert.ok(fs.existsSync(path.join(cwd, ".git")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("恢复 git 会话会重跑 worktree 准备（include/共享目录/setup）", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const base = tempDir("rc-archive-git-prep-");
  try {
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n.cache/\n");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
    fs.mkdirSync(path.join(repo, ".cache"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".cache", "keep.txt"), "cache\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);

    const cwd = path.join(base, "worktrees", "p1", ID);
    const session = makeSession(ID, undefined, {
      projectPath: repo,
      cwd,
      git: true,
      branch: `qubius/${ID}`,
    });
    writeSession(dataDir, session);
    const store = new Store(dataDir);
    const archive = new ArchiveStore({
      dir: archiveDir,
      instance: "main",
      dataDir,
      retentionDays: 30,
      sdkConfigDir: sdkDir,
      projects: [{
        id: "p1",
        name: "项目",
        path: repo,
        permission: "acceptEdits",
        isolated: false,
        worktree: {
          include: [".env"],
          sharedDirectories: [".cache"],
          setup: "node -e \"require('fs').writeFileSync('prepared.txt','prepared')\"",
          setupTimeoutSeconds: 30,
        },
      }],
    });
    await archive.archive(session);
    store.remove(ID);
    await archive.restore(ID, {
      projectId: "p1",
      projectPath: repo,
      cwd,
      git: true,
      branch: `qubius/${ID}`,
    });
    assert.ok(store.loadFromDisk(ID));
    assert.ok(fs.existsSync(path.join(cwd, ".git")));
    assert.equal(fs.readFileSync(path.join(cwd, ".env"), "utf8"), "SECRET=1\n");
    assert.ok(fs.lstatSync(path.join(cwd, ".cache")).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(cwd, "prepared.txt"), "utf8"), "prepared");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("会话被锁住时整理跳过，不删除源", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  writeSession(dataDir, makeSession(ID, "2026-01-01T00:00:00.000Z"));
  const store = new Store(dataDir);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const runtime = { stop: async () => {} } as unknown as Runtime;
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 30,
    now: () => new Date("2026-03-05T00:00:00.000Z"),
  });
  assert.equal(tryLockSession(ID), true);
  try {
    const result = await sweeper.run();
    assert.equal(result.removed, 0);
    assert.ok(store.get(ID));
    assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)));
  } finally {
    unlockSession(ID);
  }
});

class CountingArchiveStore extends ArchiveStore {
  verifies = 0;

  override async verify(id: string) {
    this.verifies += 1;
    return super.verify(id);
  }
}

test("长保留期快照窗口不会每小时全量校验", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  writeSession(dataDir, makeSession(ID, "2026-01-01T00:00:00.000Z"));
  writeSdkFiles(sdkDir, ID);
  const store = new Store(dataDir);
  const archive = new CountingArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 3650,
    sdkConfigDir: sdkDir,
  });
  const runtime = { stop: async () => {} } as unknown as Runtime;
  let now = new Date("2026-01-25T00:00:00.000Z");
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 3650,
    now: () => now,
  });

  const first = await sweeper.run();
  assert.equal(first.archived, 1);
  const verifiesAfterFirst = archive.verifies;
  // archive() 内部已逐文件校验，sweeper 不再紧接着全量 verify 一遍。
  assert.equal(verifiesAfterFirst, 0);

  now = new Date("2026-01-25T01:00:00.000Z");
  const second = await sweeper.run();
  assert.equal(second.archived, 0);
  assert.equal(second.skipped, 1);
  assert.equal(archive.verifies, verifiesAfterFirst);
});

test("归档 meta 损坏时拒绝重建并保留 SSD 源", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  writeSession(dataDir, makeSession(ID, "2026-01-01T00:00:00.000Z"));
  writeSdkFiles(sdkDir, ID);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  fs.mkdirSync(path.join(archive.root, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(archive.root, "sessions", `${ID}.meta.json`),
    "{broken",
  );
  const store = new Store(dataDir);
  const runtime = { stop: async () => {} } as unknown as Runtime;
  const sweeper = new ArchiveSweeper({
    archive,
    store,
    runtime,
    retentionDays: 30,
    now: () => new Date("2026-03-05T00:00:00.000Z"),
  });

  const result = await sweeper.run();
  assert.equal(result.removed, 0);
  assert.equal(result.failed.length, 1);
  assert.ok(store.get(ID));
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)));
});

test("归档 meta 的 files/sha256/size 保持旧格式", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID);
  writeSession(dataDir, session);
  const imageDir = path.join(dataDir, "images", ID);
  fs.mkdirSync(imageDir, { recursive: true });
  const imageData = Buffer.from("image-bytes");
  fs.writeFileSync(path.join(imageDir, "pic.png"), imageData);
  writeSdkFiles(sdkDir, ID);

  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const returned = await archive.archive(new Store(dataDir).require(ID));

  const raw = JSON.parse(
    fs.readFileSync(path.join(archive.root, "sessions", `${ID}.meta.json`), "utf8"),
  );
  assert.equal(raw.version, 1);
  assert.equal(raw.id, ID);
  assert.equal(raw.session, `sessions/${ID}.json`);
  assert.ok(Array.isArray(raw.files));

  const paths = raw.files.map((file: { path: string }) => file.path);
  assert.deepEqual(paths, [...paths].sort(), "meta.files 仍按路径排序");

  const image = raw.files.find((file: { path: string }) => file.path === `images/${ID}/pic.png`);
  assert.ok(image, "图片应写入 meta");
  assert.equal(image.size, imageData.length);
  assert.equal(image.sha256, createHash("sha256").update(imageData).digest("hex"));
  assert.equal(
    image.sha256,
    returned.files.find((file) => file.path === `images/${ID}/pic.png`)?.sha256,
  );

  for (const file of raw.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    const abs = path.join(archive.root, ...file.path.split("/"));
    assert.equal(file.size, fs.statSync(abs).size);
    assert.equal(file.sha256, createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
  }
  await archive.verify(ID);
});

test("归档复制失败时保留源文件且不写 meta", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID);
  writeSession(dataDir, session);
  const imageDir = path.join(dataDir, "images", ID);
  fs.mkdirSync(imageDir, { recursive: true });
  const imageFile = path.join(imageDir, "pic.png");
  fs.writeFileSync(imageFile, "secret");
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });

  // 源文件不可读 -> 流式复制失败；归档不得写 meta。
  fs.chmodSync(imageFile, 0o000);
  try {
    await assert.rejects(() => archive.archive(session));
  } finally {
    fs.chmodSync(imageFile, 0o600);
  }

  assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)));
  assert.ok(fs.existsSync(imageFile));
  assert.equal(
    fs.existsSync(path.join(archive.root, "sessions", `${ID}.meta.json`)),
    false,
  );
});

test("写坏目标文件时 sweeper 不删源、不覆盖旧 meta", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const old = makeSession(ID, "2026-01-01T00:00:00.000Z");
  writeSession(dataDir, old);
  const imageDir = path.join(dataDir, "images", ID);
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, "pic.png"), "original-image");
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  await archive.archive(old);
  const metaPath = path.join(archive.root, "sessions", `${ID}.meta.json`);
  const oldMeta = fs.readFileSync(metaPath, "utf8");

  // 内容变了 -> 触发重新归档。
  writeSession(dataDir, makeSession(ID, "2026-01-02T00:00:00.000Z"));

  // 注入等长的目标内容损坏：rename 成功后改掉一个字节。
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    await originalRename(from, to);
    if (String(to).endsWith("pic.png")) {
      const data = await fs.promises.readFile(to);
      if (data.length > 0) data[0] = data[0] ^ 0xff;
      await fs.promises.writeFile(to, data);
    }
  };
  try {
    const store = new Store(dataDir);
    const runtime = { stop: async () => {} } as unknown as Runtime;
    const sweeper = new ArchiveSweeper({
      archive,
      store,
      runtime,
      retentionDays: 30,
      now: () => new Date("2026-03-05T00:00:00.000Z"),
    });

    const result = await sweeper.run();
    assert.equal(result.removed, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]?.error ?? "", /归档校验失败/);
    // 源会话和源图片都保留，旧 meta 未被新内容覆盖。
    assert.ok(store.get(ID));
    assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)));
    assert.ok(fs.existsSync(path.join(imageDir, "pic.png")));
    assert.equal(fs.readFileSync(metaPath, "utf8"), oldMeta);
  } finally {
    fs.promises.rename = originalRename;
  }
});

test("会话 JSON 等长写坏时归档失败并保留源", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const old = makeSession(ID, "2026-01-01T00:00:00.000Z");
  writeSession(dataDir, old);
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  await archive.archive(old);
  const metaPath = path.join(archive.root, "sessions", `${ID}.meta.json`);
  const oldMeta = fs.readFileSync(metaPath, "utf8");

  // 内容变了 -> 触发重新归档。
  writeSession(dataDir, makeSession(ID, "2026-01-02T00:00:00.000Z"));

  // 注入会话 JSON 的等长损坏：writeAtomic rename 后改掉一个字节。
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    await originalRename(from, to);
    if (String(to).endsWith(path.join("sessions", `${ID}.json`))) {
      const data = await fs.promises.readFile(to);
      if (data.length > 0) data[0] = data[0] ^ 0xff;
      await fs.promises.writeFile(to, data);
    }
  };
  try {
    const store = new Store(dataDir);
    const runtime = { stop: async () => {} } as unknown as Runtime;
    const sweeper = new ArchiveSweeper({
      archive,
      store,
      runtime,
      retentionDays: 30,
      now: () => new Date("2026-03-05T00:00:00.000Z"),
    });

    const result = await sweeper.run();
    assert.equal(result.removed, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]?.error ?? "", /归档校验失败/);
    // 源会话保留，旧 meta 未被新内容覆盖。
    assert.ok(store.get(ID));
    assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)));
    assert.equal(fs.readFileSync(metaPath, "utf8"), oldMeta);
  } finally {
    fs.promises.rename = originalRename;
  }
});

test("旧归档文件在源被清理后损坏时，重归档失败并保留源", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID, "2026-01-01T00:00:00.000Z");
  writeSession(dataDir, session);
  const imageDir = path.join(dataDir, "images", ID);
  fs.mkdirSync(imageDir, { recursive: true });
  fs.writeFileSync(path.join(imageDir, "pic.png"), "original");
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  await archive.archive(session);

  // 归档里的图片损坏，同时源图片被 Claude 自身清理掉，只能复用旧归档。
  fs.appendFileSync(path.join(archive.root, "images", ID, "pic.png"), "corrupt");
  fs.rmSync(path.join(imageDir, "pic.png"), { force: true });

  const changed = makeSession(ID, "2026-02-01T00:00:00.000Z");
  await assert.rejects(() => archive.archive(changed), /归档校验失败/);

  // 源会话还在，旧 meta 没有被覆盖。
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", `${ID}.json`)));
  const meta = await archive.meta(ID);
  assert.equal(meta?.updatedAt, session.updatedAt);
});

test("status 只统计 meta 数量，不解析 meta 内容", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const sessionsDir = path.join(archive.root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  // 只有 meta、没有会话文件：list 不算可恢复，但 status 只数 meta。
  fs.writeFileSync(
    path.join(sessionsDir, `${ID}.meta.json`),
    JSON.stringify({ version: 1, id: ID, session: `sessions/${ID}.json`, files: [] }),
  );
  fs.writeFileSync(path.join(sessionsDir, "notes.txt"), "x");
  fs.writeFileSync(path.join(sessionsDir, "not-a-uuid.meta.json"), "{}");

  assert.equal((await archive.status()).archived, 1);
  assert.equal((await archive.list()).length, 0);
});

test("restore 只使用目标路径，不使用归档里的 cwd", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const victim = path.join(PROJECT_ROOT, `victim-${ID}`);
  const targetCwd = path.join(PROJECT_ROOT, ID);
  fs.rmSync(targetCwd, { recursive: true, force: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "keep.txt"), "keep");
  try {
    const session = makeSession(ID, undefined, {
      projectPath: PROJECT_ROOT,
      cwd: victim,
      git: false,
    });
    writeSession(dataDir, session);
    const store = new Store(dataDir);
    const archive = new ArchiveStore({
      dir: archiveDir,
      instance: "main",
      dataDir,
      retentionDays: 30,
      sdkConfigDir: sdkDir,
    });
    await archive.archive(session);
    store.remove(ID);
    await archive.restore(ID, {
      projectId: "p1",
      projectPath: PROJECT_ROOT,
      cwd: targetCwd,
      git: false,
    });
    const restored = store.loadFromDisk(ID);
    assert.ok(restored);
    assert.equal(restored?.cwd, targetCwd);
    assert.ok(fs.existsSync(path.join(victim, "keep.txt")));
    assert.ok(fs.existsSync(targetCwd));
  } finally {
    fs.rmSync(victim, { recursive: true, force: true });
    fs.rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("归档会收齐 claudeSessionId 与 id 不同的两份 transcript", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID, undefined, { claudeSessionId: ID2 });
  writeSession(dataDir, session);
  writeSdkFiles(sdkDir, ID);
  writeSdkFiles(sdkDir, ID2);

  const root = path.join(archiveDir, "main");
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const store = new Store(dataDir);
  const meta = await archive.archive(store.require(ID));
  assert.ok(meta.files.some((file) => file.path === `sdk/projects/-tmp-project/${ID}.jsonl`));
  assert.ok(meta.files.some((file) => file.path === `sdk/projects/-tmp-project/${ID2}.jsonl`));
  assert.ok(fs.existsSync(path.join(root, "sdk", "projects", "-tmp-project", `${ID2}.jsonl`)));
});

test("restore 保留 claudeSessionId 仅当 cwd 未变且归档里有对应 transcript", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID, undefined, { claudeSessionId: ID2 });
  writeSession(dataDir, session);
  writeSdkFiles(sdkDir, ID);
  writeSdkFiles(sdkDir, ID2);

  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
    now: () => new Date("2026-02-01T00:00:00.000Z"),
  });
  const store = new Store(dataDir);
  await archive.archive(store.require(ID));

  // cwd 不变、归档文件存在：保留 claudeSessionId。
  fs.rmSync(path.join(dataDir, "sessions", `${ID}.json`), { force: true });
  fs.rmSync(path.join(sdkDir, "projects", "-tmp-project"), { recursive: true, force: true });
  const sameCwd = new Store(dataDir);
  const restoredSame = await archive.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    git: false,
  });
  assert.equal(restoredSame.claudeSessionId, ID2);
  assert.ok(sameCwd);

  // cwd 变化：即使归档里有 transcript 也不能 resume。
  const changedCwd = await archive.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: path.join(PROJECT_ROOT, ID),
    git: false,
  });
  assert.equal(changedCwd.claudeSessionId, undefined);

  // 归档里没有 claudeSessionId 的 transcript：同样清空。
  const { dataDir: dataDir2, archiveDir: archiveDir2, sdkDir: sdkDir2 } = setup();
  const session2 = makeSession(ID, undefined, { claudeSessionId: ID2 });
  writeSession(dataDir2, session2);
  writeSdkFiles(sdkDir2, ID);
  const archive2 = new ArchiveStore({
    dir: archiveDir2,
    instance: "main",
    dataDir: dataDir2,
    retentionDays: 30,
    sdkConfigDir: sdkDir2,
  });
  const store2 = new Store(dataDir2);
  await archive2.archive(store2.require(ID));
  fs.rmSync(path.join(dataDir2, "sessions", `${ID}.json`), { force: true });
  const missing = await archive2.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    git: false,
  });
  assert.equal(missing.claudeSessionId, undefined);
});

test("永久删除归档会删掉 claudeSessionId 对应的归档文件", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID, undefined, { claudeSessionId: ID2 });
  writeSession(dataDir, session);
  writeSdkFiles(sdkDir, ID);
  writeSdkFiles(sdkDir, ID2);

  const root = path.join(archiveDir, "main");
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const store = new Store(dataDir);
  await archive.archive(store.require(ID));
  const forkFile = path.join(root, "sdk", "projects", "-tmp-project", `${ID2}.jsonl`);
  const mainFile = path.join(root, "sdk", "projects", "-tmp-project", `${ID}.jsonl`);
  assert.ok(fs.existsSync(forkFile));

  assert.equal(await archive.remove(ID), true);
  assert.equal(fs.existsSync(forkFile), false);
  assert.equal(fs.existsSync(mainFile), false);
  assert.equal(fs.existsSync(path.join(root, "sessions", `${ID}.meta.json`)), false);
  assert.equal(fs.existsSync(path.join(root, "sessions", `${ID}.json`)), false);
  assert.equal(fs.existsSync(path.join(root, "images", ID)), false);
});

test("forkedSdkIds 参与归档、恢复与永久删除", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const session = makeSession(ID, undefined, { claudeSessionId: ID, forkedSdkIds: [ID2] });
  writeSession(dataDir, session);
  writeSdkFiles(sdkDir, ID);
  writeSdkFiles(sdkDir, ID2);

  const root = path.join(archiveDir, "main");
  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const store = new Store(dataDir);
  const meta = await archive.archive(store.require(ID));
  assert.ok(meta.files.some((file) => file.path === `sdk/projects/-tmp-project/${ID2}.jsonl`));

  // 模拟 SSD 上的文件消失后从归档恢复，fork 出来的 transcript 也要回来。
  fs.rmSync(path.join(dataDir, "sessions", `${ID}.json`), { force: true });
  fs.rmSync(path.join(sdkDir, "projects", "-tmp-project"), { recursive: true, force: true });
  const restored = await archive.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    git: false,
  });
  assert.deepEqual(restored.forkedSdkIds, [ID2]);
  assert.ok(fs.existsSync(path.join(sdkDir, "projects", "-tmp-project", `${ID2}.jsonl`)));

  // 永久删除归档时两份 transcript 都要清掉。
  const forkFile = path.join(root, "sdk", "projects", "-tmp-project", `${ID2}.jsonl`);
  const mainFile = path.join(root, "sdk", "projects", "-tmp-project", `${ID}.jsonl`);
  assert.ok(fs.existsSync(forkFile));
  assert.equal(await archive.remove(ID), true);
  assert.equal(fs.existsSync(forkFile), false);
  assert.equal(fs.existsSync(mainFile), false);
  assert.equal(fs.existsSync(path.join(root, "sessions", `${ID}.meta.json`)), false);
});

test("restore 丢弃 SDK 上下文时清除消息指针和 lastSdkUuid；保留时不动", async () => {
  const { dataDir, archiveDir, sdkDir } = setup();
  const messages = [
    { id: "m1", role: "user" as const, text: "你好", sdkUuid: ID2, forkPoint: "root" },
    { id: "m2", role: "assistant" as const, text: "回复" },
  ];
  const session = makeSession(ID, undefined, {
    claudeSessionId: ID2,
    lastSdkUuid: ID2,
    newSdkSession: true,
    messages,
  });
  writeSession(dataDir, session);
  writeSdkFiles(sdkDir, ID);
  writeSdkFiles(sdkDir, ID2);

  const archive = new ArchiveStore({
    dir: archiveDir,
    instance: "main",
    dataDir,
    retentionDays: 30,
    sdkConfigDir: sdkDir,
  });
  const store = new Store(dataDir);
  await archive.archive(store.require(ID));

  // cwd 变化：SDK 上下文丢弃，所有指针必须失效。
  const changed = await archive.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: path.join(PROJECT_ROOT, ID),
    git: false,
  });
  assert.equal(changed.claudeSessionId, undefined);
  assert.equal(changed.lastSdkUuid, undefined);
  assert.equal(changed.newSdkSession, undefined);
  assert.equal(changed.messages[0]?.sdkUuid, undefined);
  assert.equal(changed.messages[0]?.forkPoint, undefined);
  // 被丢弃的 transcript 仍被会话跟踪，后续 DELETE/归档/retention 才清得到。
  assert.ok(sessionSdkIds(changed).includes(ID2));
  const changedSummary = toSummary(changed, true);
  assert.equal(changedSummary.messages?.[0]?.rewindable, false);

  // cwd 不变且归档里有 transcript：指针与恢复的上下文一致，保留。
  const kept = await archive.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    git: false,
  });
  assert.equal(kept.claudeSessionId, ID2);
  assert.equal(kept.lastSdkUuid, ID2);
  assert.equal(kept.newSdkSession, undefined);
  assert.equal(kept.messages[0]?.sdkUuid, ID2);
  assert.equal(kept.messages[0]?.forkPoint, "root");
  assert.equal(toSummary(kept, true).messages?.[0]?.rewindable, true);

  // 归档里没有 claudeSessionId 的 transcript：即使 cwd 相同也要清空。
  const { dataDir: dataDir2, archiveDir: archiveDir2, sdkDir: sdkDir2 } = setup();
  const session2 = makeSession(ID, undefined, {
    claudeSessionId: ID2,
    lastSdkUuid: ID2,
    newSdkSession: true,
    messages,
  });
  writeSession(dataDir2, session2);
  writeSdkFiles(sdkDir2, ID);
  const archive2 = new ArchiveStore({
    dir: archiveDir2,
    instance: "main",
    dataDir: dataDir2,
    retentionDays: 30,
    sdkConfigDir: sdkDir2,
  });
  const store2 = new Store(dataDir2);
  await archive2.archive(store2.require(ID));
  const missing = await archive2.restore(ID, {
    projectId: "p1",
    projectPath: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    git: false,
  });
  assert.equal(missing.claudeSessionId, undefined);
  assert.equal(missing.lastSdkUuid, undefined);
  assert.equal(missing.newSdkSession, undefined);
  assert.equal(missing.messages[0]?.sdkUuid, undefined);
  assert.equal(missing.messages[0]?.forkPoint, undefined);
  assert.equal(toSummary(missing, true).messages?.[0]?.rewindable, false);
});
