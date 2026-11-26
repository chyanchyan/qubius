import assert from "node:assert/strict";
import test from "node:test";
import type { Session, Transcript } from "./api";
import { buildExportMarkdown, resolveExportSession, runExport } from "./session-export";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function transcript(id: string): Transcript {
  return { id, role: "assistant", text: id };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    projectId: "demo",
    title: "示例对话",
    providerId: "provider",
    providerName: "Provider",
    model: "model",
    effort: "high",
    phase: "completed",
    summary: "",
    git: false,
    cwd: "/tmp/demo",
    isolated: false,
    subagentDone: 0,
    subagentTotal: 0,
    subagents: [],
    pending: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("本地只加载了部分历史时，导出前拉取完整会话", async () => {
  const local = session({
    messageCount: 10,
    historyStart: 8,
    messages: [transcript("m8"), transcript("m9")],
  });
  const full = session({
    messageCount: 10,
    historyStart: 0,
    messages: Array.from({ length: 10 }, (_, index) => transcript(`m${index}`)),
  });
  const calls: string[] = [];

  const resolved = await resolveExportSession(local, async (id) => {
    calls.push(id);
    return { session: full };
  });

  assert.deepEqual(calls, [SESSION_ID]);
  assert.equal(resolved.messages?.length, 10);
  assert.equal(resolved.messages?.[0]?.id, "m0");
});

test("本地已经完整加载时不额外请求", async () => {
  const local = session({
    messageCount: 2,
    messages: [transcript("m0"), transcript("m1")],
  });
  let called = false;

  const resolved = await resolveExportSession(local, async () => {
    called = true;
    return { session: local };
  });

  assert.equal(called, false);
  assert.equal(resolved, local);
});

test("没有 messageCount（旧数据）时按本地内容导出", async () => {
  const local = session({ messages: [transcript("m0")] });
  let called = false;

  const resolved = await resolveExportSession(local, async () => {
    called = true;
    return { session: local };
  });

  assert.equal(called, false);
  assert.equal(resolved, local);
});

test("导出内容包含拉取回来的更早历史", async () => {
  const local = session({
    messageCount: 10,
    historyStart: 8,
    messages: [
      { id: "m8", role: "user", text: "最近的问题" },
      { id: "m9", role: "assistant", text: "最近的回答" },
    ],
  });
  const full = session({
    messages: [
      { id: "m0", role: "user", text: "更早的问题" },
      ...Array.from({ length: 8 }, (_, index) => transcript(`m${index + 1}`)),
      { id: "m9", role: "assistant", text: "最近的回答" },
    ],
  });

  const exported = await buildExportMarkdown(local, async (id) => {
    assert.equal(id, SESSION_ID);
    return { session: full };
  });

  assert.equal(exported.title, "示例对话");
  assert.match(exported.markdown, /更早的问题/);
  assert.match(exported.markdown, /最近的回答/);
  // 先拉全量再导出：本地没有的第一条也出现在文件里。
  assert.ok(exported.markdown.indexOf("更早的问题") < exported.markdown.indexOf("最近的回答"));
});

test("拉取完整会话失败时错误向上抛，由按钮展示", async () => {
  const local = session({
    messageCount: 10,
    messages: [transcript("m9")],
  });
  const failure = new Error("网络失败");
  const loadFull = async (): Promise<{ session: Session }> => {
    throw failure;
  };

  await assert.rejects(resolveExportSession(local, loadFull), /网络失败/);
  await assert.rejects(buildExportMarkdown(local, loadFull), /网络失败/);

  // SessionTools 的导出按钮走 runExport：返回可展示文案而不是未处理的 rejection。
  assert.equal(await runExport(local, async () => { throw failure; }), "网络失败");
  assert.equal(await runExport(local, async () => undefined), undefined);
  assert.equal(await runExport(local, async () => { throw "boom"; }), "导出失败");
});
