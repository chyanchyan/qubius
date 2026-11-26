import assert from "node:assert/strict";
import test from "node:test";
import {
  FONT_PERCENT_KEY,
  FONT_PERCENT_MAX,
  FONT_PERCENT_MIN,
  FONT_PERCENT_STEP,
  fontPercentToScale,
  normalizeFontPercent,
  readStoredFontPercent,
  stepFontPercent,
} from "./text-scale";

test("字号百分比常量：范围拓宽到 60-300，步进 10", () => {
  assert.equal(FONT_PERCENT_MIN, 60);
  assert.equal(FONT_PERCENT_MAX, 300);
  assert.equal(FONT_PERCENT_STEP, 10);
  assert.equal(FONT_PERCENT_KEY, "qubius:font-percent");
});

test("合法值保留或四舍五入到步进整数倍", () => {
  assert.equal(normalizeFontPercent(100), 100);
  assert.equal(normalizeFontPercent(110), 110);
  assert.equal(normalizeFontPercent("120"), 120);
  assert.equal(normalizeFontPercent(124), 120);
  assert.equal(normalizeFontPercent(125), 130);
  assert.equal(normalizeFontPercent(66), 70);
});

test("低于下限或高于上限被 clamp", () => {
  assert.equal(normalizeFontPercent(0), FONT_PERCENT_MIN);
  assert.equal(normalizeFontPercent(-50), FONT_PERCENT_MIN);
  assert.equal(normalizeFontPercent(59), FONT_PERCENT_MIN);
  assert.equal(normalizeFontPercent(9999), FONT_PERCENT_MAX);
  assert.equal(normalizeFontPercent("500"), FONT_PERCENT_MAX);
});

test("非数字、NaN、Infinity、null、undefined、空串都回退到 100", () => {
  assert.equal(normalizeFontPercent(Number.NaN), 100);
  assert.equal(normalizeFontPercent(Number.POSITIVE_INFINITY), 100);
  assert.equal(normalizeFontPercent(Number.NEGATIVE_INFINITY), 100);
  assert.equal(normalizeFontPercent(null), 100);
  assert.equal(normalizeFontPercent(undefined), 100);
  assert.equal(normalizeFontPercent(""), 100);
  assert.equal(normalizeFontPercent("   "), 100);
  assert.equal(normalizeFontPercent("not-a-number"), 100);
  assert.equal(normalizeFontPercent({}), 100);
});

test("步进到边界后不再越界", () => {
  assert.equal(stepFontPercent(100, 1), 110);
  assert.equal(stepFontPercent(100, -1), 90);
  assert.equal(stepFontPercent(FONT_PERCENT_MAX, 1), FONT_PERCENT_MAX);
  assert.equal(stepFontPercent(FONT_PERCENT_MAX - 5, 1), FONT_PERCENT_MAX);
  assert.equal(stepFontPercent(FONT_PERCENT_MIN, -1), FONT_PERCENT_MIN);
  assert.equal(stepFontPercent(FONT_PERCENT_MIN + 5, -1), FONT_PERCENT_MIN);
  // 非法当前值先 normalize 成 100 再步进。
  assert.equal(stepFontPercent(Number.NaN, 1), 110);
});

test("readStoredFontPercent：正常读取、null 和异常分别处理", () => {
  const stored = {
    getItem: (key: string) => (key === FONT_PERCENT_KEY ? "140" : null),
  };
  assert.equal(readStoredFontPercent(stored), 140);

  const empty = { getItem: () => null };
  assert.equal(readStoredFontPercent(empty), 100);

  const broken = {
    getItem: () => {
      throw new Error("storage blocked");
    },
  };
  assert.equal(readStoredFontPercent(broken), 100);

  // 脏值同样回退到 100。
  assert.equal(readStoredFontPercent({ getItem: () => "oops" }), 100);
});

test("fontPercentToScale 返回百分比对应的小数比例", () => {
  assert.equal(fontPercentToScale(60), 0.6);
  assert.equal(fontPercentToScale(100), 1);
  assert.equal(fontPercentToScale(300), 3);
});
