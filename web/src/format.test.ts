import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFORT_DESCRIPTION,
  effortLabel,
  effortOptionLabel,
  formatClockTime,
  formatCompactTokens,
  formatCountdown,
  formatElapsed,
  formatIntervalMinutes,
  formatMessageFullTime,
  formatMessageTime,
  formatRelativeTime,
  formatUsageLabel,
  formatUsageTitle,
  groupDigits,
  hasTokenUsage,
  inputTokenTotal,
  safeTokenCount,
} from "./format";
import type { TokenUsage } from "./api";

test("紧凑 token：小于 1000 原样", () => {
  assert.equal(formatCompactTokens(0), "0");
  assert.equal(formatCompactTokens(1), "1");
  assert.equal(formatCompactTokens(999), "999");
});

test("紧凑 token：千位和百万位保留 1 位小数并去掉多余的 .0", () => {
  assert.equal(formatCompactTokens(1000), "1k");
  assert.equal(formatCompactTokens(1234), "1.2k");
  assert.equal(formatCompactTokens(13600), "13.6k");
  assert.equal(formatCompactTokens(1234567), "1.2M");
});

test("紧凑 token：999,999 舍入后进位到 1M 而不是 1000k", () => {
  assert.equal(formatCompactTokens(999_999), "1M");
  assert.equal(formatCompactTokens(1_000_000), "1M");
});

test("时间格式化为本地时区的 MM-DD HH:MM", () => {
  const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  assert.equal(formatMessageTime(iso), "01-02 03:04");
  assert.equal(formatMessageFullTime(iso), "2026-01-02 03:04:05");
});

test("运行时长：不足 1 小时 m:ss，超过 1 小时 h:mm:ss", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(999), "0:00");
  assert.equal(formatElapsed(1_000), "0:01");
  assert.equal(formatElapsed(61_000), "1:01");
  assert.equal(formatElapsed(3_599_000), "59:59");
  assert.equal(formatElapsed(3_600_000), "1:00:00");
  assert.equal(formatElapsed(7_865_000), "2:11:05");
  assert.equal(formatElapsed(-5), "0:00");
  assert.equal(formatElapsed(Number.NaN), "0:00");
});

test("结束时间：当天只显示时分，其他日期带月日", () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  assert.equal(formatClockTime(at, new Date(2026, 0, 2, 9, 0)), "03:04");
  assert.equal(formatClockTime(at, new Date(2026, 0, 3, 9, 0)), "01-02 03:04");
  assert.equal(formatClockTime(undefined), "");
  assert.equal(formatClockTime("not-a-date"), "");
});

test("无效或缺失的 at 返回空字符串", () => {
  assert.equal(formatMessageTime(undefined), "");
  assert.equal(formatMessageTime(""), "");
  assert.equal(formatMessageTime("not-a-date"), "");
  assert.equal(formatMessageFullTime(undefined), "");
  assert.equal(formatMessageFullTime("not-a-date"), "");
});

test("token 明细 title 包含各分项数字", () => {
  const usage = { input: 13586, output: 191, cacheRead: 2000, cacheWrite: 0 };
  const title = formatUsageTitle(usage);
  assert.match(title, /输入总量 15,586 tokens/);
  assert.match(title, /非缓存 13,586/);
  assert.match(title, /缓存读取 2,000/);
  assert.match(title, /缓存写入 0/);
  assert.match(title, /输出 191 tokens/);
});

test("脏 usage（缺失或非有限数字）不产生 NaN", () => {
  const dirty = {
    input: undefined,
    output: Number.NaN,
    cacheRead: Number.POSITIVE_INFINITY,
    cacheWrite: undefined,
  } as unknown as TokenUsage;
  assert.equal(safeTokenCount(dirty.input), 0);
  assert.equal(inputTokenTotal(dirty), 0);
  assert.equal(hasTokenUsage(dirty), false);
  assert.equal(hasTokenUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), true);
  assert.equal(formatUsageLabel(dirty), "↑0 ↓0");
  const title = formatUsageTitle(dirty);
  assert.doesNotMatch(title, /NaN|Infinity/);
  assert.match(title, /输入总量 0 tokens/);
  assert.match(title, /非缓存 0/);
});

test("输入总量包含缓存读写，可见标签使用紧凑格式", () => {
  const usage = { input: 13586, output: 191, cacheRead: 2000, cacheWrite: 0 };
  assert.equal(inputTokenTotal(usage), 15586);
  assert.equal(formatUsageLabel(usage), "↑15.6k ↓191");
  assert.equal(groupDigits(15586), "15,586");
});

test("相对时间覆盖刚刚、分钟、小时、天和回退格式", () => {
  const now = new Date(2026, 0, 10, 12, 0, 0).getTime();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  assert.equal(formatRelativeTime(at(0), now), "刚刚");
  assert.equal(formatRelativeTime(at(1), now), "1 分钟前");
  assert.equal(formatRelativeTime(at(59), now), "59 分钟前");
  assert.equal(formatRelativeTime(at(60), now), "1 小时前");
  assert.equal(formatRelativeTime(at(60 * 23), now), "23 小时前");
  assert.equal(formatRelativeTime(at(60 * 24), now), "1 天前");
  assert.equal(formatRelativeTime(at(60 * 24 * 6), now), "6 天前");
  assert.equal(formatRelativeTime(at(60 * 24 * 7), now), formatMessageTime(at(60 * 24 * 7)));
  assert.equal(formatRelativeTime(undefined, now), "");
});

test("未来时间用于下次运行提示", () => {
  const now = new Date(2026, 0, 10, 12, 0, 0).getTime();
  const at = (minutesAhead: number) => new Date(now + minutesAhead * 60_000).toISOString();
  assert.equal(formatRelativeTime(at(0.2), now), "即将");
  assert.equal(formatRelativeTime(at(5), now), "5 分钟后");
  assert.equal(formatRelativeTime(at(1500), now), "1 天后");
});

test("确认倒计时按 m:ss 或 h:mm:ss 展示，不出现负数", () => {
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-500), "0:00");
  assert.equal(formatCountdown(1), "0:01");
  assert.equal(formatCountdown(59_400), "1:00");
  assert.equal(formatCountdown(600_000), "10:00");
  assert.equal(formatCountdown(3_661_000), "1:01:01");
});

test("间隔按周、天、小时、分钟展示", () => {
  assert.equal(formatIntervalMinutes(5), "每 5 分钟");
  assert.equal(formatIntervalMinutes(90), "每 90 分钟");
  assert.equal(formatIntervalMinutes(60), "每小时");
  assert.equal(formatIntervalMinutes(360), "每 6 小时");
  assert.equal(formatIntervalMinutes(1440), "每天");
  assert.equal(formatIntervalMinutes(2880), "每 2 天");
  assert.equal(formatIntervalMinutes(10080), "每周");
  assert.equal(formatIntervalMinutes(0), "");
  assert.equal(formatIntervalMinutes(Number.NaN), "");
});

test("effort 使用中文标签并保留原始值", () => {
  assert.equal(effortLabel("high"), "高");
  assert.equal(effortLabel("unknown"), "unknown");
  assert.equal(effortOptionLabel("xhigh"), "很高 (xhigh)");
  assert.ok(EFFORT_DESCRIPTION.max.length > 0);
});
