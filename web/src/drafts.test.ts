import assert from "node:assert/strict";
import test from "node:test";
import {
  createDraftStore,
  hasDraftContent,
  parseDraft,
  projectDraftKey,
  serializeDraft,
  sessionDraftKey,
  type Draft,
  type DraftStorage,
} from "./drafts";

function fakeStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

const draft: Draft = {
  text: "写一个测试",
  texts: [{ name: "a.ts", content: "export {}", bytes: 9 }],
  savedAt: 1_700_000_000_000,
};

test("草稿键按项目和会话区分", () => {
  assert.equal(projectDraftKey("chat"), "qcoder:draft:project:chat");
  assert.equal(sessionDraftKey("abc"), "qcoder:draft:session:abc");
});

test("序列化后可以还原文本和文本附件", () => {
  assert.deepEqual(parseDraft(serializeDraft(draft)), draft);
});

test("损坏、版本不符或字段缺失的草稿返回 null", () => {
  assert.equal(parseDraft("not-json"), null);
  assert.equal(parseDraft("{}"), null);
  assert.equal(parseDraft(JSON.stringify({ ...draft, v: 99 })), null);
  assert.equal(parseDraft(JSON.stringify({ ...draft, text: 1 })), null);
  assert.equal(parseDraft(JSON.stringify({ ...draft, texts: "x" })), null);
  assert.equal(parseDraft(null), null);
});

test("脏文本附件逐条丢弃，不影响其余内容", () => {
  const raw = JSON.stringify({
    v: 1,
    text: "保留",
    savedAt: 1,
    texts: [
      { name: "ok.txt", content: "ok", bytes: 2 },
      { name: "bad.txt", content: 3, bytes: 2 },
      { name: "bad-bytes.txt", content: "x", bytes: Number.NaN },
      null,
    ],
  });
  assert.deepEqual(parseDraft(raw)?.texts, [{ name: "ok.txt", content: "ok", bytes: 2 }]);
});

test("存取和清除使用同一份存储；空草稿视为清除", () => {
  const storage = fakeStorage();
  const store = createDraftStore(storage);
  const key = sessionDraftKey("s1");
  assert.equal(store.save(key, draft), true);
  assert.deepEqual(store.load(key), draft);
  assert.equal(hasDraftContent({ text: "  ", texts: [] }), false);
  assert.equal(store.save(key, { text: "  ", texts: [], savedAt: 2 }), true);
  assert.equal(storage.data.has(key), false);
  store.save(key, draft);
  store.clear(key);
  assert.equal(store.load(key), null);
});

test("损坏的已存草稿会被清理，避免每次进入页面都反复解析失败", () => {
  const storage = fakeStorage();
  const key = projectDraftKey("p1");
  storage.data.set(key, "{oops");
  const store = createDraftStore(storage);
  assert.equal(store.load(key), null);
  assert.equal(storage.data.has(key), false);
});

test("存储抛错时保存失败但不抛出", () => {
  const store = createDraftStore({
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("blocked"); },
  });
  assert.equal(store.load("k"), null);
  assert.equal(store.save("k", draft), false);
  store.clear("k");
});
