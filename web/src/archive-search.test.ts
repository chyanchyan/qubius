import assert from "node:assert/strict";
import test from "node:test";
import { filterArchivedSessions, isPendingCleanup } from "./archive-search";
import type { ArchivedSession } from "./api";

function archived(id: string, extra: Partial<ArchivedSession> = {}): ArchivedSession {
  return {
    id,
    projectId: "p",
    title: id,
    summary: "",
    providerName: "Provider",
    model: "model",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: "2026-01-02T00:00:00.000Z",
    messageCount: 1,
    ...extra,
  };
}

test("归档搜索匹配标题、摘要、接口名和模型名，大小写不敏感", () => {
  const items = [
    archived("登录", { title: "登录接口", summary: "修复鉴权" }),
    archived("报表", { summary: "导出 CSV", providerName: "Claude", model: "Opus" }),
    archived("无关"),
  ];

  assert.deepEqual(filterArchivedSessions(items, "登录").map((item) => item.id), ["登录"]);
  assert.deepEqual(filterArchivedSessions(items, "csv").map((item) => item.id), ["报表"]);
  assert.deepEqual(filterArchivedSessions(items, "CLAUDE").map((item) => item.id), ["报表"]);
  assert.deepEqual(filterArchivedSessions(items, "opus").map((item) => item.id), ["报表"]);
  assert.deepEqual(filterArchivedSessions(items, "  ").map((item) => item.id), ["登录", "报表", "无关"]);
  assert.deepEqual(filterArchivedSessions(items, "没有这个词"), []);
});

test("空关键词返回副本，不修改原数组", () => {
  const items = [archived("a")];
  const result = filterArchivedSessions(items, "");
  assert.deepEqual(result.map((item) => item.id), ["a"]);
  assert.notEqual(result, items);
});

test("待清理判定：冷备完成且本机副本还在", () => {
  assert.equal(isPendingCleanup({ pendingDelete: true, local: true }), true);
  // 旧服务端没有 local：pendingDelete 只会出现在本机副本还在的时候。
  assert.equal(isPendingCleanup({ pendingDelete: true }), true);
  // 本机副本已经删掉：就是一条普通归档。
  assert.equal(isPendingCleanup({ pendingDelete: true, local: false }), false);
  // 定期快照：本机还在但没有删除意图，不该显示成待清理。
  assert.equal(isPendingCleanup({ local: true }), false);
  assert.equal(isPendingCleanup({}), false);
});
