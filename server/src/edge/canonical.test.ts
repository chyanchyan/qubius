import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical.js";
import { EdgeError } from "./types.js";

test("canonicalJson 按字典序排序键并保持数组顺序", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] }),
    '{"a":{"c":3,"d":2},"b":1,"list":[3,1,2]}',
  );
  assert.equal(canonicalJson({ z: "x", a: "y" }), '{"a":"y","z":"x"}');
});

test("canonicalJson 处理 undefined 与 -0", () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([undefined, 1]), "[null,1]");
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson(1.5), "1.5");
});

test("canonicalJson 拒绝非有限数字与不支持类型", () => {
  assert.throws(() => canonicalJson({ a: Number.NaN }), EdgeError);
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), EdgeError);
  assert.throws(() => canonicalJson({ fn: () => 1 }), EdgeError);
  assert.throws(() => canonicalJson(10n), EdgeError);
});

test("sha256Hex 与已知向量一致", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(Buffer.from("abc", "utf8")), sha256Hex("abc"));
  assert.equal(canonicalSha256({ a: 1, b: 2 }), canonicalSha256({ b: 2, a: 1 }));
  assert.notEqual(canonicalSha256([1, 2]), canonicalSha256([2, 1]));
});
