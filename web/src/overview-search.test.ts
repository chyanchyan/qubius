import assert from "node:assert/strict";
import test from "node:test";
import {
  applySessionRemoved,
  applySessionUpdate,
  matchesSessionQuery,
  sortSessions,
} from "./overview-search";
import type { Session } from "./api";

function session(id: string, title: string, summary = "", extra: Partial<Session> = {}): Session {
  return {
    id,
    projectId: "p",
    title,
    summary,
    providerId: "x",
    providerName: "X",
    model: "m",
    effort: "high",
    phase: "completed",
    git: true,
    cwd: "/tmp",
    isolated: false,
    subagentDone: 0,
    subagentTotal: 0,
    subagents: [],
    pending: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

test("title 或 summary 命中即匹配，空查询匹配全部", () => {
  const item = session("1", "修复登录", "顺便优化界面");
  assert.equal(matchesSessionQuery(item, ""), true);
  assert.equal(matchesSessionQuery(item, "登录"), true);
  assert.equal(matchesSessionQuery(item, "界面"), true);
  assert.equal(matchesSessionQuery(item, "不存在"), false);
});

test("搜索中字段命中转不命中时移除，正文命中的行保留", () => {
  const fieldHit = session("1", "登录问题");
  const contentHit = session("2", "普通标题", "界面优化");
  const current = [fieldHit, contentHit];

  const renamed = session("1", "无关标题");
  const updated = session("2", "普通标题改", "另一段摘要");
  assert.deepEqual(applySessionUpdate(current, renamed, "登录").map((item) => item.id), ["2"]);
  assert.deepEqual(applySessionUpdate(current, updated, "登录").map((item) => item.id), ["1", "2"]);
});

test("搜索中不命中的新会话不会插入，命中的会插入", () => {
  const current = [session("1", "登录问题")];
  assert.equal(applySessionUpdate(current, session("2", "部署问题"), "登录").length, 1);
  assert.equal(applySessionUpdate(current, session("2", "登录部署"), "登录").length, 2);
});

test("无搜索时更新/插入并保持置顶优先排序", () => {
  const pinned = session("1", "置顶", "", { pinned: true });
  const normal = session("2", "普通");
  const list = applySessionUpdate([normal], pinned, "");
  assert.deepEqual(list.map((item) => item.id), ["1", "2"]);

  const updated = session("2", "普通改");
  const after = applySessionUpdate(list, updated, "");
  assert.equal(after[1]?.title, "普通改");
});

test("删除只移除对应 id，其他行顺序不变", () => {
  const current = [session("1", "a"), session("2", "b")];
  assert.deepEqual(applySessionRemoved(current, "1").map((item) => item.id), ["2"]);
  assert.equal(applySessionRemoved(current, "missing"), current);
});

test("排序：置顶优先，其余按 createdAt 倒序", () => {
  const list = sortSessions([
    session("a", "a", "", { createdAt: "2026-01-01T00:00:00.000Z" }),
    session("b", "b", "", { createdAt: "2026-01-02T00:00:00.000Z" }),
    session("c", "c", "", { createdAt: "2026-01-03T00:00:00.000Z", pinned: true }),
  ]);
  assert.deepEqual(list.map((item) => item.id), ["c", "b", "a"]);
});
