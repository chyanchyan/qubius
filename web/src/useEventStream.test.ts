import assert from "node:assert/strict";
import test from "node:test";
import { nextStreamStatus } from "./useEventStream";

test("连接打开后进入 live", () => {
  assert.equal(nextStreamStatus("connecting", "open"), "live");
  assert.equal(nextStreamStatus("reconnecting", "open"), "live");
});

test("连接出错进入重连中，离线后重复错误保持离线", () => {
  assert.equal(nextStreamStatus("connecting", "error"), "reconnecting");
  assert.equal(nextStreamStatus("live", "error"), "reconnecting");
  assert.equal(nextStreamStatus("reconnecting", "error"), "reconnecting");
  assert.equal(nextStreamStatus("offline", "error"), "offline");
});

test("超时或浏览器放弃重连后离线，手动重连回到 connecting", () => {
  assert.equal(nextStreamStatus("reconnecting", "fatal"), "offline");
  assert.equal(nextStreamStatus("connecting", "fatal"), "offline");
  assert.equal(nextStreamStatus("live", "fatal"), "offline");
  assert.equal(nextStreamStatus("offline", "retry"), "connecting");
  assert.equal(nextStreamStatus("live", "start"), "connecting");
});
