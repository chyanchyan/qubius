import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, formatThinkingDuration } from "./thinking";

test("estimateTokens：CJK 约 1 字 1 token，英文约 4 字符 1 token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("先看结构"), 4);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("ab"), 1); // 至少显示 1，不出现 0 tokens
});

test("formatThinkingDuration：不足 1 秒、秒、分钟", () => {
  assert.equal(formatThinkingDuration(undefined), "");
  assert.equal(formatThinkingDuration(-1), "");
  assert.equal(formatThinkingDuration(0), "<1s");
  assert.equal(formatThinkingDuration(999), "<1s");
  assert.equal(formatThinkingDuration(1000), "1s");
  assert.equal(formatThinkingDuration(1499), "1s");
  assert.equal(formatThinkingDuration(1500), "2s");
  assert.equal(formatThinkingDuration(65_000), "1m05s");
});
