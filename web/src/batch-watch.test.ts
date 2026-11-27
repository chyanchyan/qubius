import assert from "node:assert/strict";
import test from "node:test";
import {
  activeWatchCount,
  defaultWatchSessionIds,
  summarizeActions,
  toggleWatchAction,
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
