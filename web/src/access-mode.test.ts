import assert from "node:assert/strict";
import test from "node:test";
import {
  accessModeForHost,
  accessModeTooltip,
  otherEnabledEntries,
  type AccessEntries,
} from "./access-mode";

test("回环地址和 localhost 算本机访问", () => {
  assert.equal(accessModeForHost("localhost"), "local");
  assert.equal(accessModeForHost("LOCALHOST."), "local");
  assert.equal(accessModeForHost("qubius.localhost"), "local");
  assert.equal(accessModeForHost("127.0.0.1"), "local");
  assert.equal(accessModeForHost("127.8.9.10"), "local");
  assert.equal(accessModeForHost("0.0.0.0"), "local");
  assert.equal(accessModeForHost("::1"), "local");
  assert.equal(accessModeForHost("[::1]"), "local");
});

test("私网 IPv4 和链路本地/CGNAT 地址算局域网访问", () => {
  assert.equal(accessModeForHost("192.168.1.10"), "lan");
  assert.equal(accessModeForHost("10.0.0.5"), "lan");
  assert.equal(accessModeForHost("172.16.3.2"), "lan");
  assert.equal(accessModeForHost("172.31.255.254"), "lan");
  assert.equal(accessModeForHost("169.254.10.2"), "lan");
  assert.equal(accessModeForHost("100.64.0.7"), "lan");
  assert.equal(accessModeForHost("100.127.0.7"), "lan");
});

test("公网 IPv4 算公网访问", () => {
  assert.equal(accessModeForHost("8.8.8.8"), "public");
  assert.equal(accessModeForHost("172.15.0.1"), "public");
  assert.equal(accessModeForHost("172.32.0.1"), "public");
  assert.equal(accessModeForHost("100.63.0.1"), "public");
  assert.equal(accessModeForHost("100.128.0.1"), "public");
});

test("内网域名、单标签主机名和私网 IPv6 算局域网访问", () => {
  assert.equal(accessModeForHost("qubius.local"), "lan");
  assert.equal(accessModeForHost("qubius.lan"), "lan");
  assert.equal(accessModeForHost("box.home.arpa"), "lan");
  assert.equal(accessModeForHost("build.internal"), "lan");
  assert.equal(accessModeForHost("qubius"), "lan");
  assert.equal(accessModeForHost("fd12:3456:789a::1"), "lan");
  assert.equal(accessModeForHost("fe80::1"), "lan");
  assert.equal(accessModeForHost("::ffff:192.168.1.5"), "lan");
});

test("公网域名和公网 IPv6 算公网访问", () => {
  assert.equal(accessModeForHost("code.example.com"), "public");
  assert.equal(accessModeForHost("qubius-abc.ts.example.org"), "public");
  assert.equal(accessModeForHost("2606:4700:4700::1111"), "public");
});

test("主机名缺失或无法解析时按公网处理，不冒充本机", () => {
  assert.equal(accessModeForHost(""), "public");
  assert.equal(accessModeForHost(undefined), "public");
  assert.equal(accessModeForHost(null), "public");
  assert.equal(accessModeForHost("999.1.1.1"), "public");
});

test("已启用入口标记跳过当前入口本身", () => {
  const none: AccessEntries = { lan: false, public: false };
  const all: AccessEntries = { lan: true, public: true };
  assert.deepEqual(otherEnabledEntries("local", none), []);
  assert.deepEqual(otherEnabledEntries("local", all), ["lan", "public"]);
  assert.deepEqual(otherEnabledEntries("lan", all), ["public"]);
  assert.deepEqual(otherEnabledEntries("public", all), ["lan"]);
  assert.deepEqual(otherEnabledEntries("lan", { lan: true, public: false }), []);
});

test("悬停说明只在有其他已启用入口时追加列表", () => {
  assert.equal(
    accessModeTooltip("local", { lan: false, public: false }),
    "本机访问：页面通过本机地址打开",
  );
  assert.equal(
    accessModeTooltip("local", { lan: true, public: false }),
    "本机访问：页面通过本机地址打开 · 其他已启用入口：局域网",
  );
  assert.equal(
    accessModeTooltip("lan", { lan: true, public: true }),
    "局域网访问：页面通过局域网地址打开 · 其他已启用入口：公网",
  );
});
