import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "./config.js";
import {
  addDiffComment,
  clearDiffComments,
  diffCommentsFilePath,
  handleDiffCommentRoutes,
  listDiffComments,
  MAX_DIFF_COMMENTS,
  removeDiffComment,
  removeDiffComments,
  updateDiffComment,
  type DiffComment,
} from "./diff-comments.js";
import type { FeatureContext, FeatureResult } from "./feature-routes.js";
import { tryLockSession, unlockSession } from "./session-lock.js";
import type { Runtime } from "./runtime.js";
import type { StoredSettings } from "./settings.js";
import type { Store } from "./store.js";
import type { SessionCore } from "./types.js";

interface TempData {
  dataDir: string;
  cleanup: () => void;
}

function makeTempData(): TempData {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-diff-comments-"));
  return {
    dataDir: path.join(root, "data"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

interface InvokeOptions {
  dataDir: string;
  sessionId: string;
  pathname: string;
  method: string;
  body?: unknown;
  sessionExists?: boolean;
}

/** 伪造 FeatureContext：只实现路由用到的 store.get / readJson / config.dataDir。 */
async function invoke(options: InvokeOptions): Promise<FeatureResult | null> {
  const session = { id: options.sessionId } as SessionCore;
  const ctx = {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL(`http://127.0.0.1${options.pathname}`),
    method: options.method,
    config: { dataDir: options.dataDir } as AppConfig,
    store: {
      get: (id: string) =>
        options.sessionExists === false || id !== options.sessionId ? undefined : session,
    } as unknown as Store,
    runtime: {} as Runtime,
    settings: { current: {} as StoredSettings },
    readJson: async () => options.body,
    sendJson: () => undefined,
  } satisfies FeatureContext;
  return handleDiffCommentRoutes(ctx);
}

function commentsDir(dataDir: string): string {
  return path.join(dataDir, "diff-comments");
}

function commentsFile(dataDir: string, sessionId: string): string {
  return path.join(commentsDir(dataDir), `${sessionId}.json`);
}

function seedComments(dataDir: string, sessionId: string, comments: unknown[]): void {
  fs.mkdirSync(commentsDir(dataDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(commentsFile(dataDir, sessionId), JSON.stringify(comments));
}

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: randomUUID(),
    file: "src/a.ts",
    side: "new",
    line: 1,
    text: "评论",
    resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function bodyOf(result: FeatureResult | null): Record<string, unknown> {
  assert.ok(result, "路由应该匹配并返回结果");
  assert.equal(typeof result.body, "object");
  return result.body as Record<string, unknown>;
}

test("CRUD：新增、查询、修改、删除单条和清空", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  const base = `/api/sessions/${sessionId}/diff-comments`;
  try {
    const empty = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "GET" });
    assert.equal(empty?.status, 200);
    assert.deepEqual(bodyOf(empty).comments, []);

    const created = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: base,
      method: "POST",
      body: { file: "  src/a.ts  ", side: "new", line: 12, text: "  第一行评论  " },
    });
    assert.equal(created?.status, 201);
    const comment = bodyOf(created).comment as DiffComment;
    assert.equal(comment.file, "src/a.ts");
    assert.equal(comment.text, "第一行评论");
    assert.equal(comment.side, "new");
    assert.equal(comment.line, 12);
    assert.equal(comment.resolved, false);
    assert.match(comment.id, /^[0-9a-f-]{36}$/i);
    assert.ok(comment.createdAt);
    assert.equal(comment.createdAt, comment.updatedAt);

    const listed = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "GET" });
    assert.equal(listed?.status, 200);
    assert.equal((bodyOf(listed).comments as DiffComment[]).length, 1);

    const patched = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${comment.id}`,
      method: "PATCH",
      body: { text: "改过的评论", resolved: true, file: "ignored.ts", line: 99 },
    });
    assert.equal(patched?.status, 200);
    const updated = bodyOf(patched).comment as DiffComment;
    assert.equal(updated.text, "改过的评论");
    assert.equal(updated.resolved, true);
    // 未知字段忽略：file/line 不变。
    assert.equal(updated.file, "src/a.ts");
    assert.equal(updated.line, 12);

    // 未知字段的 PATCH 不改任何内容，也不报错。
    const noop = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${comment.id}`,
      method: "PATCH",
      body: { unknown: 1 },
    });
    assert.equal(noop?.status, 200);
    assert.equal((bodyOf(noop).comment as DiffComment).text, "改过的评论");

    const removed = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${comment.id}`,
      method: "DELETE",
    });
    assert.equal(removed?.status, 200);
    assert.deepEqual(removed?.body, { ok: true });

    const missing = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${comment.id}`,
      method: "DELETE",
    });
    assert.equal(missing?.status, 404);

    await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: base,
      method: "POST",
      body: { file: "b.ts", side: "old", line: 3, text: "第二条" },
    });
    await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: base,
      method: "POST",
      body: { file: "c.ts", side: "new", line: 7, text: "第三条" },
    });
    const cleared = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "DELETE" });
    assert.equal(cleared?.status, 200);
    assert.deepEqual(cleared?.body, { ok: true });
    assert.deepEqual(await listDiffComments(temp.dataDir, sessionId), []);
  } finally {
    temp.cleanup();
  }
});

test("列表按 file、line、createdAt 排序", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  try {
    seedComments(temp.dataDir, sessionId, [
      makeComment({ file: "b.ts", line: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
      makeComment({ file: "a.ts", line: 20, createdAt: "2026-01-01T00:00:00.000Z" }),
      makeComment({ file: "a.ts", line: 5, createdAt: "2026-01-01T00:00:03.000Z" }),
      makeComment({ file: "a.ts", line: 5, createdAt: "2026-01-01T00:00:01.000Z" }),
      makeComment({ file: "a.ts", line: 5, createdAt: "2026-01-01T00:00:02.000Z" }),
    ]);
    const comments = await listDiffComments(temp.dataDir, sessionId);
    assert.deepEqual(
      comments.map((comment) => [comment.file, comment.line, comment.createdAt]),
      [
        ["a.ts", 5, "2026-01-01T00:00:01.000Z"],
        ["a.ts", 5, "2026-01-01T00:00:02.000Z"],
        ["a.ts", 5, "2026-01-01T00:00:03.000Z"],
        ["a.ts", 20, "2026-01-01T00:00:00.000Z"],
        ["b.ts", 1, "2026-01-01T00:00:00.000Z"],
      ],
    );
  } finally {
    temp.cleanup();
  }
});

test("校验失败返回 400，且不会写入任何评论", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  const base = `/api/sessions/${sessionId}/diff-comments`;
  const valid = { file: "src/a.ts", side: "new", line: 1, text: "正文" };
  try {
    const cases: unknown[] = [
      { ...valid, text: "   " },
      { ...valid, text: "x".repeat(2001) },
      { ...valid, text: 123 },
      { ...valid, side: "middle" },
      { ...valid, side: undefined },
      { ...valid, line: 0 },
      { ...valid, line: -1 },
      { ...valid, line: 1.5 },
      { ...valid, line: 1_000_001 },
      { ...valid, line: "3" },
      { ...valid, file: "" },
      { ...valid, file: "x".repeat(501) },
      { ...valid, file: "a\nb.ts" },
      { ...valid, file: 42 },
      [],
      null,
    ];
    for (const body of cases) {
      const result = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "POST", body });
      assert.equal(result?.status, 400, `应拒绝：${JSON.stringify(body)}`);
    }
    assert.deepEqual(await listDiffComments(temp.dataDir, sessionId), []);

    // PATCH 的 resolved 必须是 boolean。
    const created = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "POST", body: valid });
    const id = (bodyOf(created).comment as DiffComment).id;
    const bad = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${id}`,
      method: "PATCH",
      body: { resolved: "yes" },
    });
    assert.equal(bad?.status, 400);
    const badText = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${id}`,
      method: "PATCH",
      body: { text: "" },
    });
    assert.equal(badText?.status, 400);
  } finally {
    temp.cleanup();
  }
});

test("每个会话最多 200 条评论", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  const base = `/api/sessions/${sessionId}/diff-comments`;
  try {
    const seeded = Array.from({ length: MAX_DIFF_COMMENTS - 1 }, (_, index) =>
      makeComment({ id: randomUUID(), line: index + 1 }),
    );
    seedComments(temp.dataDir, sessionId, seeded);

    const last = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: base,
      method: "POST",
      body: { file: "src/a.ts", side: "new", line: 500, text: "第 200 条" },
    });
    assert.equal(last?.status, 201);
    assert.equal((await listDiffComments(temp.dataDir, sessionId)).length, MAX_DIFF_COMMENTS);

    const overflow = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: base,
      method: "POST",
      body: { file: "src/a.ts", side: "new", line: 501, text: "第 201 条" },
    });
    assert.equal(overflow?.status, 400);
    assert.equal((await listDiffComments(temp.dataDir, sessionId)).length, MAX_DIFF_COMMENTS);
  } finally {
    temp.cleanup();
  }
});

test("会话不存在或 id 形状非法返回 404", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  try {
    const missing = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `/api/sessions/${sessionId}/diff-comments`,
      method: "GET",
      sessionExists: false,
    });
    assert.equal(missing?.status, 404);
    assert.deepEqual(missing?.body, { error: "找不到对话" });

    const badShape = await invoke({
      dataDir: temp.dataDir,
      sessionId: "../../etc/passwd",
      pathname: "/api/sessions/..%2F..%2Fetc%2Fpasswd/diff-comments",
      method: "GET",
    });
    assert.equal(badShape?.status, 404);
    assert.deepEqual(badShape?.body, { error: "找不到对话" });
  } finally {
    temp.cleanup();
  }
});

test("不支持的请求方法返回 405，路径不匹配返回 null", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  const base = `/api/sessions/${sessionId}/diff-comments`;
  try {
    const collectionPut = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "PUT" });
    assert.equal(collectionPut?.status, 405);
    assert.deepEqual(collectionPut?.body, { error: "不支持的方法" });

    const itemPost = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${randomUUID()}`,
      method: "POST",
    });
    assert.equal(itemPost?.status, 405);
    assert.deepEqual(itemPost?.body, { error: "不支持的方法" });

    for (const pathname of [
      "/api/sessions",
      `/api/sessions/${sessionId}/diff`,
      `${base}-extra`,
      `${base}/${randomUUID()}/extra`,
    ]) {
      const result = await invoke({ dataDir: temp.dataDir, sessionId, pathname, method: "GET" });
      assert.equal(result, null, `不应匹配：${pathname}`);
    }
  } finally {
    temp.cleanup();
  }
});

test("并发添加不会丢数据", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  try {
    const additions = Array.from({ length: 40 }, (_, index) =>
      addDiffComment(temp.dataDir, sessionId, {
        file: `src/file-${index % 5}.ts`,
        side: index % 2 === 0 ? "new" : "old",
        line: index + 1,
        text: `并发评论 ${index}`,
      }),
    );
    const created = await Promise.all(additions);
    assert.equal(new Set(created.map((comment) => comment.id)).size, 40);

    const comments = await listDiffComments(temp.dataDir, sessionId);
    assert.equal(comments.length, 40);
    assert.equal(new Set(comments.map((comment) => comment.id)).size, 40);
  } finally {
    temp.cleanup();
  }
});

test("损坏的 JSON 视为空数组，且仍可继续写入", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  const base = `/api/sessions/${sessionId}/diff-comments`;
  try {
    fs.mkdirSync(commentsDir(temp.dataDir), { recursive: true, mode: 0o700 });
    fs.writeFileSync(commentsFile(temp.dataDir, sessionId), "{不是合法 JSON");

    const listed = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "GET" });
    assert.equal(listed?.status, 200);
    assert.deepEqual(bodyOf(listed).comments, []);

    // 合法 JSON 但不是数组，同样视为空。
    fs.writeFileSync(commentsFile(temp.dataDir, sessionId), JSON.stringify({ comments: [] }));
    assert.deepEqual(await listDiffComments(temp.dataDir, sessionId), []);

    const created = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: base,
      method: "POST",
      body: { file: "src/a.ts", side: "new", line: 1, text: "恢复后的评论" },
    });
    assert.equal(created?.status, 201);
    assert.equal((await listDiffComments(temp.dataDir, sessionId)).length, 1);

    // 数组里混入坏条目时只丢弃坏条目。
    seedComments(temp.dataDir, sessionId, [
      makeComment({ id: "not-a-uuid" }),
      { ...makeComment(), side: "sideways" },
      makeComment({ line: 0 }),
      makeComment({ text: "" }),
      makeComment({ id: randomUUID(), file: "ok.ts" }),
    ]);
    const filtered = await listDiffComments(temp.dataDir, sessionId);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.file, "ok.ts");
  } finally {
    temp.cleanup();
  }
});

test("存储层：删除单条和清空", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  try {
    const a = await addDiffComment(temp.dataDir, sessionId, {
      file: "a.ts",
      side: "new",
      line: 1,
      text: "A",
    });
    const b = await addDiffComment(temp.dataDir, sessionId, {
      file: "b.ts",
      side: "old",
      line: 2,
      text: "B",
    });
    assert.equal(await removeDiffComment(temp.dataDir, sessionId, a.id), true);
    assert.equal(await removeDiffComment(temp.dataDir, sessionId, a.id), false);
    assert.deepEqual(
      (await listDiffComments(temp.dataDir, sessionId)).map((comment) => comment.id),
      [b.id],
    );

    const updated = await updateDiffComment(temp.dataDir, sessionId, b.id, { resolved: true });
    assert.equal(updated?.resolved, true);
    assert.equal(await updateDiffComment(temp.dataDir, sessionId, randomUUID(), { resolved: true }), undefined);

    await clearDiffComments(temp.dataDir, sessionId);
    assert.deepEqual(await listDiffComments(temp.dataDir, sessionId), []);
    assert.equal(await removeDiffComment(temp.dataDir, sessionId, b.id), false);
  } finally {
    temp.cleanup();
  }
});

test("存储层：removeDiffComments 直接删除文件，ENOENT 也安全", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  try {
    const target = diffCommentsFilePath(temp.dataDir, sessionId);
    assert.equal(target, commentsFile(temp.dataDir, sessionId));
    await addDiffComment(temp.dataDir, sessionId, {
      file: "a.ts",
      side: "new",
      line: 1,
      text: "A",
    });
    assert.ok(fs.existsSync(target));

    await removeDiffComments(temp.dataDir, sessionId);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(await listDiffComments(temp.dataDir, sessionId), []);

    // 文件已不存在时再删一次不应抛错。
    await removeDiffComments(temp.dataDir, sessionId);
    assert.equal(fs.existsSync(target), false);
  } finally {
    temp.cleanup();
  }
});

test("会话 busy（归档/清理中）时拒绝写评论，读取仍可用", async () => {
  const temp = makeTempData();
  const sessionId = randomUUID();
  const base = `/api/sessions/${sessionId}/diff-comments`;
  assert.equal(tryLockSession(sessionId), true);
  try {
    const collection = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "POST", body: {
      file: "a.ts",
      side: "new",
      line: 1,
      text: "A",
    } });
    assert.equal(collection?.status, 409);
    assert.deepEqual(collection?.body, { error: "对话正在归档或清理，请稍后再试" });

    const patch = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${randomUUID()}`,
      method: "PATCH",
      body: { resolved: true },
    });
    assert.equal(patch?.status, 409);

    const removeOne = await invoke({
      dataDir: temp.dataDir,
      sessionId,
      pathname: `${base}/${randomUUID()}`,
      method: "DELETE",
    });
    assert.equal(removeOne?.status, 409);

    const clear = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "DELETE" });
    assert.equal(clear?.status, 409);
    assert.deepEqual(clear?.body, { error: "对话正在归档或清理，请稍后再试" });

    // GET 不写文件，仍可读取（此时会得到空列表）。
    const list = await invoke({ dataDir: temp.dataDir, sessionId, pathname: base, method: "GET" });
    assert.equal(list?.status, 200);
  } finally {
    unlockSession(sessionId);
    temp.cleanup();
  }
});
