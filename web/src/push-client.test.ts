import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationServerKeyMatches,
  assertPushSupported,
  base64UrlToUint8Array,
  pickNotificationWindow,
  resolveNotificationTarget,
} from "./push-client";

/**
 * 纯逻辑测试：不依赖 navigator / Notification / PushManager，
 * 只验证 base64url 解码和“不支持”时的错误文案。
 */

test("base64url 解码标准字符", () => {
  assert.deepEqual([...base64UrlToUint8Array("AQID")], [1, 2, 3]);
});

test("base64url 解码 URL-safe 字符 - 和 _", () => {
  // "a-b_" 等价于标准 base64 的 "a+b/"。
  assert.deepEqual([...base64UrlToUint8Array("a-b_")], [0x6b, 0xe6, 0xff]);
});

test("base64url 容忍缺失的 = 补齐", () => {
  assert.deepEqual([...base64UrlToUint8Array("AQ")], [1]);
  assert.deepEqual([...base64UrlToUint8Array("AQ==")], [1]);
  assert.deepEqual([...base64UrlToUint8Array("AQI")], [1, 2]);
  assert.deepEqual([...base64UrlToUint8Array("AQI=")], [1, 2]);
});

test("base64url 还原真实的 P-256 公钥长度和内容", () => {
  const raw = Buffer.from([0x04, ...Array.from({ length: 64 }, (_, index) => index)]);
  const encoded = raw.toString("base64url");

  const decoded = base64UrlToUint8Array(encoded);
  assert.equal(decoded.length, 65);
  assert.deepEqual(decoded, new Uint8Array(raw));
});

test("非法字符和空字符串给出中文错误", () => {
  assert.throws(() => base64UrlToUint8Array(""), /推送公钥格式无效/);
  assert.throws(() => base64UrlToUint8Array("a*b?"), /推送公钥格式无效/);
});

test("不支持的环境抛出可读中文错误", () => {
  assert.throws(() => assertPushSupported(false), /不支持推送通知/);
  assert.doesNotThrow(() => assertPushSupported(true));
});

const ORIGIN = "https://dev.example";

test("通知目标：同一 session 的窗口被选中并 focus", () => {
  const target = resolveNotificationTarget("/sessions/b", ORIGIN);
  assert.equal(target.href, `${ORIGIN}/sessions/b`);
  assert.deepEqual(pickNotificationWindow([`${ORIGIN}/sessions/b`], target), { index: 0, navigate: false });
});

test("通知目标：不同 session 不会误 focus", () => {
  const target = resolveNotificationTarget("/sessions/b", ORIGIN);
  assert.equal(pickNotificationWindow([`${ORIGIN}/sessions/a`], target), null);
});

test("通知目标：pathname 相同但 query 不同时需要先 navigate", () => {
  const target = resolveNotificationTarget("/sessions/b?x=1", ORIGIN);
  assert.deepEqual(pickNotificationWindow([`${ORIGIN}/sessions/b`], target), { index: 0, navigate: true });
});

test("通知目标：跨域目标回退根路径，跨域窗口不参与匹配", () => {
  const target = resolveNotificationTarget("https://evil.example/sessions/a", ORIGIN);
  assert.equal(target.href, `${ORIGIN}/`);
  assert.equal(target.pathname, "/");
  assert.equal(pickNotificationWindow(["https://evil.example/"], target), null);
});

test("通知目标：畸形 URL、空值和协议相对地址回退根路径", () => {
  for (const raw of [undefined, null, "", "http://[::1", "http://%", "//evil.example/x"]) {
    const target = resolveNotificationTarget(raw, ORIGIN);
    assert.equal(target.href, `${ORIGIN}/`);
    assert.equal(target.origin, ORIGIN);
    assert.equal(target.pathname, "/");
  }
});

test("VAPID 公钥比较：一致返回 true，不一致或缺失返回 false", () => {
  const expected = base64UrlToUint8Array("AQID");
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2, 3]), expected), true);
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2, 3]).buffer, expected), true);
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2, 4]), expected), false);
  assert.equal(applicationServerKeyMatches(new Uint8Array([1, 2]), expected), false);
  assert.equal(applicationServerKeyMatches(null, expected), false);
});
