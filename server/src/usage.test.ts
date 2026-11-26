import assert from "node:assert/strict";
import test from "node:test";
import type { TokenUsage, TranscriptItem } from "./types.js";
import { computeCost, emptyTotals, summarizeMessages, usageReport } from "./usage.js";

function item(
  id: string,
  role: TranscriptItem["role"],
  usage?: TokenUsage,
): TranscriptItem {
  return { id, role, text: id, usage };
}

test("空消息没有用量", () => {
  assert.deepEqual(summarizeMessages([]), emptyTotals());
});

test("只累加带 usage 的 assistant 条目，calls 按条目计", () => {
  const messages = [
    item("u1", "user"),
    item("a1", "assistant", { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }),
    item("t1", "tool"),
    item("a2", "assistant"),
    item("a3", "assistant", { input: 5, output: 7, cacheRead: 3, cacheWrite: 2 }),
  ];
  assert.deepEqual(summarizeMessages(messages), {
    calls: 2,
    input: 15,
    output: 27,
    cacheRead: 3,
    cacheWrite: 2,
  });
});

test("负数和非有限 token 按 0 处理", () => {
  const messages = [
    item("a1", "assistant", {
      input: -10,
      output: Number.NaN,
      cacheRead: Number.POSITIVE_INFINITY,
      cacheWrite: 4,
    }),
  ];
  assert.deepEqual(summarizeMessages(messages), {
    calls: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 4,
  });
});

test("价格按每百万 token 换算，四类 token 分别计价", () => {
  const cost = computeCost(
    { calls: 1, input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 250_000 },
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  );
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 7.5);
  assert.equal(cost.cacheRead, 0.6);
  assert.equal(cost.cacheWrite, 0.9375);
  assert.ok(Math.abs(cost.total - 12.0375) < 1e-9);
});

test("没有价格时成本全为 0", () => {
  const totals = { calls: 3, input: 123, output: 456, cacheRead: 789, cacheWrite: 10 };
  assert.deepEqual(computeCost(totals), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  assert.equal(computeCost(totals, {}).total, 0);
});

test("usageReport 按接口和会话汇总，并列出没有用量的接口", () => {
  const report = usageReport(
    [
      {
        id: "s1",
        title: "会话一",
        projectId: "p1",
        providerId: "a",
        providerName: "接口 A",
        messages: [item("a1", "assistant", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })],
      },
      {
        id: "s2",
        title: "会话二",
        projectId: "p1",
        providerId: "b",
        providerName: "接口 B",
        messages: [item("b1", "assistant", { input: 500_000, output: 0, cacheRead: 500_000, cacheWrite: 0 })],
      },
      {
        id: "s3",
        title: "旧会话",
        projectId: "p2",
        providerId: "gone",
        providerName: "已删除的接口",
        messages: [item("g1", "assistant", { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 })],
      },
    ],
    [
      { id: "a", name: "接口 A", pricing: { input: 3, output: 15 } },
      { id: "b", name: "接口 B", pricing: { input: 1, cacheRead: 0.5 } },
      { id: "c", name: "接口 C" },
    ],
  );

  assert.deepEqual(report.totals, {
    calls: 3,
    input: 1_500_100,
    output: 1_000_000,
    cacheRead: 500_000,
    cacheWrite: 0,
  });
  // 接口 A：3 + 15；接口 B：0.5 + 0.25；没有价格的旧接口为 0。
  assert.ok(Math.abs(report.cost - 18.75) < 1e-9);
  assert.deepEqual(
    report.byProvider.map((group) => [group.providerId, group.providerName, group.totals.calls, group.cost]),
    [
      ["a", "接口 A", 1, 18],
      ["b", "接口 B", 1, 0.75],
      ["c", "接口 C", 0, 0],
      ["gone", "已删除的接口", 1, 0],
    ],
  );
  assert.deepEqual(
    report.bySession.map((session) => [session.id, session.title, session.totals.calls, session.cost]),
    [
      ["s1", "会话一", 1, 18],
      ["s2", "会话二", 1, 0.75],
      ["s3", "旧会话", 1, 0],
    ],
  );
});

test("没有消息或会话时报告为零", () => {
  const report = usageReport([], [{ id: "a", name: "接口 A", pricing: { input: 1 } }]);
  assert.deepEqual(report.totals, emptyTotals());
  assert.equal(report.cost, 0);
  assert.equal(report.byProvider.length, 1);
  assert.equal(report.bySession.length, 0);
});
