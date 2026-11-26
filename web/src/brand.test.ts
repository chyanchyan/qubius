import assert from "node:assert/strict";
import test from "node:test";
import { instanceBrand } from "./brand";

test("主实例使用 Qubius", () => {
  assert.equal(instanceBrand("primary"), "Qubius");
});

test("副实例使用 co-Qubius", () => {
  assert.equal(instanceBrand("secondary"), "co-Qubius");
});

test("角色未知时退回 Qubius", () => {
  assert.equal(instanceBrand(null), "Qubius");
});
