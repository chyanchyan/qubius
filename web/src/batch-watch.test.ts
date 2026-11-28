import assert from "node:assert/strict";
import test from "node:test";
import {
  activeWatchCount,
  defaultWatchSessionIds,
  isWatchInBoard,
  summarizeActions,
  toggleWatchAction,
  watchCanEditTargets,
  watchReadyCount,
  watchTitle,
} from "./batch-watch";
import type { BatchWatch } from "./api-batch-watch";
import type { Session } from "./api";

function makeSession(id: string, phase: Session["phase"]): Session {
  return {
    id,
    projectId: "p1",
    title: id,
    providerId: "prov",
    providerName: "Prov",
    model: "m1",
    effort: "high",
    cwd: "/tmp/p1",
    git: true,
    isolated: false,
    summary: "",
    phase,
    pending: null,
    subagentTotal: 0,
    subagentDone: 0,
    subagents: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeWatch(overrides: Partial<BatchWatch> = {}): BatchWatch {
  return {
    id: "watch-1",
    projectId: "p1",
    providerId: "prov",
    providerName: "Prov",
    model: "m1",
    effort: "high",
    actions: { commit: true, mergeMode: "merge", push: false, deploy: false },
    status: "waiting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    targetViews: [
      {
        sessionId: "s1",
        title: "会话一",
        currentTitle: "会话一",
        phase: "running",
        ready: false,
      },
      {
        sessionId: "s2",
        title: "会话二",
        currentTitle: "会话二",
        phase: "completed",
        ready: true,
      },
    ],
    ...overrides,
  };
}

test("监听任务的列表标题、就绪进度与可编辑状态", () => {
  const watch = makeWatch();
  assert.equal(watchTitle(watch), "监听 · 会话一 等 2 个会话");
  assert.equal(watchReadyCount(watch), 1);
  assert.equal(isWatchInBoard(watch), true);
  assert.equal(watchCanEditTargets(watch), true);

  const single = makeWatch({
    targetViews: [{
      sessionId: "s1",
      title: "会话一",
      currentTitle: "最新标题",
      phase: "running",
      ready: false,
    }],
  });
  assert.equal(watchTitle(single), "监听 · 最新标题");

  // 进入审核整合后不再作为列表条目，也不能再改监听会话。
  const reviewing = makeWatch({ status: "reviewing" });
  assert.equal(isWatchInBoard(reviewing), false);
  assert.equal(watchCanEditTargets(reviewing), false);

  // 暂停的任务仍在列表里，可以继续编辑。
  const paused = makeWatch({ status: "paused" });
  assert.equal(isWatchInBoard(paused), true);
  assert.equal(watchCanEditTargets(paused), true);

  // 启动整合审核就失败的任务没有审核会话代表，必须留在列表里让用户看到原因。
  const failed = makeWatch({ status: "failed" });
  assert.equal(isWatchInBoard(failed), true);
  assert.equal(watchCanEditTargets(failed), false);
  const failedReview = makeWatch({ status: "failed", reviewSessionId: "review-1" });
  assert.equal(isWatchInBoard(failedReview), false);
});

test("toggleWatchAction 保持动作组合的一致性", () => {
  const initial = { commit: false, mergeMode: "none" as const, push: false, deploy: false };
  const merged = toggleWatchAction(initial, { mergeMode: "rebase" });
  assert.deepEqual(merged, { commit: true, mergeMode: "rebase", push: false, deploy: false });

  const deployed = toggleWatchAction(initial, { deploy: true });
  assert.deepEqual(deployed, { commit: true, mergeMode: "merge", push: false, deploy: true });

  const noMerge = toggleWatchAction(deployed, { mergeMode: "none" });
  assert.deepEqual(noMerge, { commit: true, mergeMode: "none", push: false, deploy: false });

  const noCommit = toggleWatchAction({ commit: true, mergeMode: "merge", push: true, deploy: true }, { commit: false });
  assert.deepEqual(noCommit, { commit: false, mergeMode: "none", push: false, deploy: false });
});

test("summarizeActions 输出简洁可读的动作摘要", () => {
  assert.equal(
    summarizeActions({ commit: false, mergeMode: "none", push: false, deploy: false }),
    "仅审核修订（不提交）",
  );
  assert.equal(
    summarizeActions({ commit: true, mergeMode: "rebase", push: true, deploy: true, baseBranch: "main" }),
    "提交 · Rebase→main · 推送 · 部署",
  );
});

test("defaultWatchSessionIds 只预选活跃会话，activeWatchCount 统计进行中任务", () => {
  const ids = defaultWatchSessionIds([
    makeSession("s1", "running"),
    makeSession("s2", "completed"),
    makeSession("s3", "queued"),
    makeSession("s4", "needs_input"),
  ]);
  assert.deepEqual(ids, ["s1", "s3", "s4"]);

  const watches = [
    { status: "waiting" },
    { status: "paused" },
    { status: "completed" },
    { status: "reviewing" },
    { status: "cancelled" },
  ] as unknown as BatchWatch[];
  assert.equal(activeWatchCount(watches), 3);
});
