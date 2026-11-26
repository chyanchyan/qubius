import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, TokenRateMeter } from "./token-rate.js";

test("estimateTokens：CJK 按 1 字 1 token，其它按 4 字符 1 token，返回小数", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("ab"), 0.5);
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens("a你b好"), 2.5);
});

test("TokenRateMeter：窗口内累加增量，按窗口长度折算速度", () => {
  const meter = new TokenRateMeter();
  meter.note("你好世界", 1_000); // 4 tokens
  assert.equal(meter.rate(1_000), 2); // 4 / 2s
  meter.note("你好", 1_200); // 再 2 tokens
  assert.equal(meter.rate(1_200), 3);
});

test("TokenRateMeter：窗口滑出后自动归零", () => {
  const meter = new TokenRateMeter();
  meter.note("你好世界", 0);
  assert.equal(meter.rate(1_000), 2);
  // 窗口是 (now-2000, now]，恰好 2 秒前的桶已经滑出。
  assert.equal(meter.rate(2_000), 0);
});

test("TokenRateMeter：同一桶多次累加，跨桶按各自时间计算", () => {
  const meter = new TokenRateMeter();
  meter.note("abcd", 10);
  meter.note("efgh", 20);
  assert.equal(meter.rate(100), 1); // 2 tokens / 2s
  meter.note("ijkl", 1_100);
  assert.equal(meter.rate(1_100), 1.5);
  // 只保留窗口内的那一桶。
  assert.equal(meter.rate(2_100), 0.5);
});
