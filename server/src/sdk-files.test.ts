import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSdkDirIndex,
  listSdkSessionFilesForIds,
  relocateSdkSession,
  removeSdkSessionFilesForIds,
  removeSdkSessionFilesForIdsFromIndex,
  sdkProjectSlug,
  sessionSdkIds,
  SESSION_ID_RE,
} from "./sdk-files.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSdk(configDir: string, slug: string, id: string): void {
  const project = path.join(configDir, "projects", slug);
  fs.mkdirSync(path.join(project, id, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), `{"id":"${id}"}\n`);
  fs.writeFileSync(path.join(project, id, "subagents", "agent-a.jsonl"), "{}\n");
  const env = path.join(configDir, "session-env", id);
  fs.mkdirSync(env, { recursive: true });
  fs.writeFileSync(path.join(env, "env.json"), "{}");
}

test("sdkProjectSlug 按 SDK 规则替换非字母数字，超长时抛错", () => {
  assert.equal(sdkProjectSlug("/tmp/a b/c_d"), "-tmp-a-b-c-d");
  assert.equal(sdkProjectSlug("/home/user/project"), "-home-user-project");
  assert.equal(sdkProjectSlug("/" + "a".repeat(199)).length, 200);
  assert.throws(() => sdkProjectSlug("/" + "a".repeat(200)), /项目路径过长/);
});

test("sessionSdkIds 去重并过滤假运行 id", () => {
  const id = randomUUID();
  const fork = randomUUID();
  const claude = randomUUID();
  assert.deepEqual(sessionSdkIds({ id, claudeSessionId: claude, forkedSdkIds: [id, fork, fork] }), [
    id,
    claude,
    fork,
  ]);
  assert.deepEqual(sessionSdkIds({ id, claudeSessionId: `fake-${id}`, forkedSdkIds: ["fake-x"] }), [id]);
  assert.equal(SESSION_ID_RE.test(id), true);
});

test("按多个 id 聚合扫描与删除 SDK 文件", async () => {
  const configDir = tempDir("rc-sdk-files-");
  try {
    const id1 = randomUUID();
    const id2 = randomUUID();
    const fake = "fake-not-a-uuid";
    writeSdk(configDir, "slug-a", id1);
    writeSdk(configDir, "slug-b", id2);

    const index = await buildSdkDirIndex(configDir);
    const files = await listSdkSessionFilesForIds([id1, id2, id1, fake], index);
    const rels = files.map((file) => file.rel).sort();
    assert.ok(rels.includes(`projects/slug-a/${id1}.jsonl`));
    assert.ok(rels.includes(`projects/slug-b/${id2}.jsonl`));
    assert.equal(rels.filter((rel) => rel.endsWith(`${id1}.jsonl`)).length, 1);

    const removed = await removeSdkSessionFilesForIdsFromIndex([id1, id2], index);
    assert.ok(removed.length >= 4);
    assert.equal(fs.existsSync(path.join(configDir, "projects", "slug-a", `${id1}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(configDir, "projects", "slug-b", `${id2}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(configDir, "session-env", id1)), false);
    assert.equal(fs.existsSync(path.join(configDir, "session-env", id2)), false);

    // 同步版本同样支持多 id。
    writeSdk(configDir, "slug-a", id1);
    writeSdk(configDir, "slug-b", id2);
    removeSdkSessionFilesForIds([id1, id2], configDir);
    assert.equal(fs.existsSync(path.join(configDir, "projects", "slug-a", `${id1}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(configDir, "projects", "slug-b", `${id2}.jsonl`)), false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("relocateSdkSession 移动 transcript 和详情目录，保留 session-env，且幂等", async () => {
  const base = tempDir("rc-sdk-relocate-");
  const configDir = path.join(base, "claude");
  const sourceDir = path.join(base, "source cwd");
  const targetDir = path.join(base, "target cwd");
  try {
    const id = randomUUID();
    const sourceSlug = sdkProjectSlug(sourceDir);
    writeSdk(configDir, sourceSlug, id);
    const sourceTranscript = path.join(configDir, "projects", sourceSlug, `${id}.jsonl`);
    const sourceDetail = path.join(configDir, "projects", sourceSlug, id);

    assert.equal(await relocateSdkSession(id, targetDir, configDir), true);
    const targetSlug = sdkProjectSlug(targetDir);
    const targetTranscript = path.join(configDir, "projects", targetSlug, `${id}.jsonl`);
    assert.ok(fs.existsSync(targetTranscript));
    assert.ok(fs.existsSync(path.join(configDir, "projects", targetSlug, id, "subagents", "agent-a.jsonl")));
    assert.equal(fs.existsSync(sourceTranscript), false);
    assert.equal(fs.existsSync(sourceDetail), false);
    // session-env 与路径无关，保持不动。
    assert.ok(fs.existsSync(path.join(configDir, "session-env", id, "env.json")));

    // 已经在目标位置：直接返回 true。
    assert.equal(await relocateSdkSession(id, targetDir, configDir), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("relocateSdkSession 找不到 transcript 时抛错，非法 id 也拒绝", async () => {
  const configDir = tempDir("rc-sdk-relocate-missing-");
  try {
    await assert.rejects(
      () => relocateSdkSession(randomUUID(), "/tmp/nowhere", configDir),
      /找不到 SDK 会话 transcript/,
    );
    await assert.rejects(() => relocateSdkSession("../x", "/tmp/nowhere", configDir), /id 无效/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
