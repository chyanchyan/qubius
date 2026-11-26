import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "./api";
import {
  ATTENTION_FAILED_WINDOW_MS,
  countAttention,
  countRunningAgents,
  mergeAttentionSessions,
  needsAttention,
  sumTokenSpeed,
  TOKEN_RATE_WINDOW_MS,
} from "./global-attention";

const NOW = Date.parse("2026-01-02T12:00:00.000Z");

function session(
  id: string,
  phase: Session["phase"],
  updatedAt: string,
): Session {
  return { id, phase, updatedAt } as unknown as Session;
}

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

test("needs_input 始终需要处理，即使时间很旧或无效", () => {
  assert.equal(needsAttention(session("a", "needs_input", at(-30 * 24 * 3600_000)), NOW), true);
  assert.equal(needsAttention(session("b", "needs_input", "not-a-date"), NOW), true);
});

test("failed 只在 24 小时窗口内提醒", () => {
  assert.equal(needsAttention(session("a", "failed", at(-1_000)), NOW), true);
  assert.equal(
    needsAttention(session("b", "failed", at(-ATTENTION_FAILED_WINDOW_MS + 1)), NOW),
    true,
  );
  assert.equal(
    needsAttention(session("c", "failed", at(-ATTENTION_FAILED_WINDOW_MS)), NOW),
    false,
  );
  assert.equal(needsAttention(session("d", "failed", at(-ATTENTION_FAILED_WINDOW_MS - 1)), NOW), false);
});

test("failed 的无效 updatedAt 按需要处理算，避免漏掉异常数据", () => {
  assert.equal(needsAttention(session("a", "failed", "garbage"), NOW), true);
});

test("其他阶段不计入待处理", () => {
  for (const phase of ["running", "queued", "completed", "stopped"] as const) {
    assert.equal(needsAttention(session(phase, phase, at(-1_000)), NOW), false, phase);
  }
});

test("countAttention 汇总 needs_input 与窗口内 failed", () => {
  const sessions = [
    session("a", "needs_input", at(-48 * 3600_000)),
    session("b", "failed", at(-60_000)),
    session("c", "failed", at(-25 * 3600_000)),
    session("d", "running", at(0)),
  ];
  assert.equal(countAttention(sessions, NOW), 2);
  assert.equal(countAttention([], NOW), 0);
});

test("countRunningAgents 汇总所有对话里正在运行的子 agent", () => {
  const withAgents = (statuses: Array<Session["subagents"][number]["status"]>) => ({
    subagents: statuses.map((status, index) => ({ taskId: String(index), description: "", status })),
  }) as unknown as Pick<Session, "subagents">;
  assert.equal(countRunningAgents([]), 0);
  assert.equal(countRunningAgents([
    withAgents(["running", "completed"]),
    withAgents(["running", "running", "failed", "stopped"]),
    withAgents(["completed"]),
  ]), 3);
});

test("countRunningAgents 把运行中的主 agent 也算进去", () => {
  const sessionState = (
    statuses: Array<Session["subagents"][number]["status"]>,
    mainAgentRunning: boolean,
  ) => ({
    mainAgentRunning,
    subagents: statuses.map((status, index) => ({ taskId: String(index), description: "", status })),
  }) as unknown as Pick<Session, "subagents" | "mainAgentRunning">;
  assert.equal(countRunningAgents([
    sessionState(["running"], true), // 主 + 1 子
    sessionState([], true), // 只有主 agent
    sessionState(["running", "completed"], false), // 主 agent 空闲，只有后台子 agent
    sessionState([], false),
  ]), 4);
  // 旧版服务端的帧没有 mainAgentRunning：维持只数子 agent 的行为。
  assert.equal(countRunningAgents([
    { subagents: [{ taskId: "0", description: "", status: "running" }] },
  ] as unknown as Array<Pick<Session, "subagents" | "mainAgentRunning">>), 1);
});

test("快照合并：删除墓碑过滤、旧快照不覆盖较新的本地项", () => {
  const current = new Map<string, Session>([
    ["stale", session("stale", "running", at(-1_000))],
    ["old", session("old", "running", at(-60_000))],
    ["removed", session("removed", "running", at(-1_000))],
  ]);
  const incoming = [
    session("stale", "failed", at(-60_000)),
    session("old", "failed", at(0)),
    session("removed", "running", at(0)),
    session("new", "needs_input", at(0)),
  ];
  const merged = mergeAttentionSessions(current, incoming, NOW, new Set(["removed"]), new Map());
  assert.equal(merged.has("removed"), false);
  assert.equal(merged.get("stale")?.phase, "running", "旧快照不能覆盖较新的 SSE 项");
  assert.equal(merged.get("old")?.phase, "failed", "较新的快照覆盖旧本地项");
  assert.equal(merged.get("new")?.phase, "needs_input");
});

test("快照合并：请求发出后 SSE 更新的项即使不在快照里也保留，其余移除", () => {
  const current = new Map<string, Session>([
    ["touched", session("touched", "needs_input", at(0))],
    ["gone", session("gone", "running", at(-1_000))],
  ]);
  const touchedAt = new Map([["touched", NOW + 1]]);
  const merged = mergeAttentionSessions(current, [], NOW, new Set(), touchedAt);
  assert.equal(merged.has("touched"), true);
  assert.equal(merged.has("gone"), false);
});

test("归档恢复：清掉删除墓碑后同 id 可以重新合并进来", () => {
  const removed = new Set(["restored"]);
  const restored = session("restored", "failed", at(-1_000));
  assert.equal(mergeAttentionSessions(new Map(), [restored], NOW, removed, new Map()).size, 0);
  removed.delete("restored");
  const merged = mergeAttentionSessions(new Map(), [restored], NOW, removed, new Map());
  assert.equal(merged.get("restored")?.id, "restored");
});

test("sumTokenSpeed 汇总各会话速度，并按窗口线性衰减到 0", () => {
  const speed = (tokensPerSecond: number | undefined, ageMs: number) => ({
    updatedAt: new Date(NOW - ageMs).toISOString(),
    tokensPerSecond,
  }) as unknown as Pick<Session, "updatedAt" | "tokensPerSecond">;

  assert.equal(sumTokenSpeed([], NOW), 0);
  // 刚更新过的两个会话直接相加。
  assert.equal(sumTokenSpeed([speed(30, 0), speed(12, 0)], NOW), 42);
  // 半个窗口前：线性衰减到一半。
  assert.equal(sumTokenSpeed([speed(40, TOKEN_RATE_WINDOW_MS / 2)], NOW), 20);
  // 超过窗口视为停止输出。
  assert.equal(sumTokenSpeed([speed(40, TOKEN_RATE_WINDOW_MS)], NOW), 0);
  // 没有速度、非法值或无效时间都不计入。
  assert.equal(sumTokenSpeed([
    speed(undefined, 0),
    speed(Number.NaN, 0),
    speed(-3, 0),
    { updatedAt: "garbage", tokensPerSecond: 10 } as unknown as Pick<Session, "updatedAt" | "tokensPerSecond">,
  ], NOW), 0);
});
