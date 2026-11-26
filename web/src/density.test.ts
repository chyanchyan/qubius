import assert from "node:assert/strict";
import test from "node:test";
import { DENSITY_OPTIONS, parseDensity } from "./density";

test("parseDensity 认作 detail / brief", () => {
  assert.equal(parseDensity("detail"), "detail");
  assert.equal(parseDensity("brief"), "brief");
});

test("parseDensity 对其它取值回到精简", () => {
  for (const raw of ["compact", "", "Brief", "DETAIL", " detail", "brief ", "{}", "0"]) {
    assert.equal(parseDensity(raw), "compact");
  }
});

test("parseDensity 对 null（未保存过）回到精简", () => {
  assert.equal(parseDensity(null), "compact");
});

test("DENSITY_OPTIONS 按展开到折叠排列三档", () => {
  assert.deepEqual(DENSITY_OPTIONS.map((option) => option.value), ["detail", "brief", "compact"]);
});
