import assert from "node:assert/strict";
import test from "node:test";
import { subagentElapsedMs, subagentMetrics, subagentStats, subagentTokenTotal } from "./subagent-meta";

const base = {
  status: "running" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
  runStartedAt: "2026-01-01T00:00:00.000Z",
  endedAt: undefined,
  durationMs: undefined,
  usageAt: undefined,
};

test("token 总量只接受正数", () => {
  assert.equal(subagentTokenTotal({ tokens: 0 }), undefined);
  assert.equal(subagentTokenTotal({ tokens: -3 }), undefined);
  assert.equal(subagentTokenTotal({ tokens: Number.NaN }), undefined);
  assert.equal(subagentTokenTotal({ tokens: 1234.6 }), 1235);
});

test("运行中按上次用量报告续算执行时长", () => {
  const now = Date.parse("2026-01-01T00:00:40.000Z");
  const agent = { ...base, durationMs: 30_000, usageAt: "2026-01-01T00:00:35.000Z" };
  assert.equal(subagentElapsedMs(agent, now), 35_000);
});

test("落定后直接用 SDK 报告的执行时长，不再按墙钟续算", () => {
  const agent = {
    ...base,
    status: "completed" as const,
    endedAt: "2026-01-01T01:00:00.000Z",
    durationMs: 12_000,
    usageAt: "2026-01-01T00:00:12.000Z",
  };
  assert.equal(subagentElapsedMs(agent, Date.parse("2026-01-01T02:00:00.000Z")), 12_000);
});

test("没有用量数据时退回当前轮墙钟；续跑用 runStartedAt 而不是首次开始时间", () => {
  const now = Date.parse("2026-01-01T00:10:30.000Z");
  const agent = {
    ...base,
    startedAt: "2026-01-01T00:00:00.000Z",
    runStartedAt: "2026-01-01T00:10:00.000Z",
  };
  assert.equal(subagentElapsedMs(agent, now), 30_000);
  assert.equal(subagentElapsedMs({ ...agent, status: "completed" as const, endedAt: "2026-01-01T00:10:20.000Z" }, now), 20_000);
});

test("折叠行指标按 token 和用时拼接，缺数据时省略", () => {
  const now = Date.parse("2026-01-01T00:01:40.000Z");
  const agent = {
    ...base,
    tokens: 12_300,
    durationMs: 90_000,
    usageAt: "2026-01-01T00:01:30.000Z",
  };
  assert.equal(subagentMetrics(agent, now), "12.3k tok · 1:40");
  assert.equal(subagentMetrics({ ...base, status: "completed" as const, endedAt: base.startedAt }, now), "");
});

test("展开明细包含工具次数、用时、token 和轮次", () => {
  const now = Date.parse("2026-01-01T00:01:40.000Z");
  const stats = subagentStats({
    taskId: "t1",
    description: "单元",
    status: "running",
    startedAt: base.startedAt,
    runStartedAt: base.startedAt,
    tokens: 1200,
    toolUses: 7,
    durationMs: 90_000,
    usageAt: "2026-01-01T00:01:30.000Z",
    runs: 2,
  }, now);
  assert.deepEqual(stats, ["工具 7 次", "运行 1:40", "1.2k tok", "第 2 轮"]);
});
