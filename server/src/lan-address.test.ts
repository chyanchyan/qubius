import assert from "node:assert/strict";
import type os from "node:os";
import test from "node:test";
import { classifyIPv4, isLanIPv4, lanAddress, tryLanAddress } from "./lan-address.js";

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function interfacesOf(entries: Array<[string, string, { internal?: boolean }?]>): Interfaces {
  const out: Interfaces = {};
  for (const [name, address, extra = {}] of entries) {
    out[name] = [{
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: extra.internal === true,
      cidr: null,
    }];
  }
  return out;
}

const quiet = () => {};

test("classifyIPv4 与服务端/lan-proxy 使用同一套分段", () => {
  assert.equal(classifyIPv4("10.0.0.1"), "private");
  assert.equal(classifyIPv4("172.16.0.1"), "private");
  assert.equal(classifyIPv4("172.31.255.255"), "private");
  assert.equal(classifyIPv4("172.32.0.0"), "public");
  assert.equal(classifyIPv4("192.168.1.5"), "private");
  assert.equal(classifyIPv4("100.64.0.1"), "shared");
  assert.equal(classifyIPv4("100.127.255.255"), "shared");
  assert.equal(classifyIPv4("100.128.0.0"), "public");
  assert.equal(classifyIPv4("169.254.1.1"), "link-local");
  assert.equal(classifyIPv4("127.0.0.1"), "loopback");
  assert.equal(classifyIPv4("0.0.0.0"), "unspecified");
  assert.equal(classifyIPv4("224.0.0.1"), "multicast");
  assert.equal(classifyIPv4("240.0.0.1"), "reserved");
  assert.equal(classifyIPv4("192.0.2.1"), "reserved");
  assert.equal(classifyIPv4("203.0.113.1"), "reserved");
  assert.equal(classifyIPv4("8.8.8.8"), "public");
  assert.equal(classifyIPv4("bad"), "invalid");
  assert.equal(isLanIPv4("10.1.1.1"), true);
  assert.equal(isLanIPv4("100.64.1.1"), true);
  assert.equal(isLanIPv4("169.254.1.1"), true);
  assert.equal(isLanIPv4("8.8.8.8"), false);
  assert.equal(isLanIPv4("127.0.0.1"), false);
});

test("显式 LAN_PROXY_HOST 优先于 QUBIUS_LAN_HOST", () => {
  const env = { LAN_PROXY_HOST: "10.0.0.9", QUBIUS_LAN_HOST: "192.168.1.5" };
  assert.equal(lanAddress({ env, interfaces: interfacesOf([["eth0", "172.20.0.2"]]), warn: quiet }), "10.0.0.9");
  assert.equal(lanAddress({ env: { QUBIUS_LAN_HOST: "192.168.1.5" }, interfaces: interfacesOf([]), warn: quiet }), "192.168.1.5");
});

test("自动选择按 private > CGNAT > link-local，并跳过公网/回环/docker", () => {
  const mixed = interfacesOf([
    ["eth0", "8.8.8.8"],
    ["eth1", "169.254.10.20"],
    ["eth2", "100.64.3.4"],
    ["eth3", "10.20.30.40"],
    ["lo", "127.0.0.1", { internal: true }],
    ["docker0", "10.1.1.1"],
  ]);
  assert.equal(lanAddress({ env: {}, interfaces: mixed, warn: quiet }), "10.20.30.40");

  const cgnatOverLinkLocal = interfacesOf([
    ["eth0", "169.254.10.20"],
    ["eth1", "100.64.3.4"],
  ]);
  assert.equal(lanAddress({ env: {}, interfaces: cgnatOverLinkLocal, warn: quiet }), "100.64.3.4");

  const publicOnly = interfacesOf([["eth0", "8.8.8.8"]]);
  assert.equal(tryLanAddress({ env: {}, interfaces: publicOnly, warn: quiet }), undefined);
  assert.throws(() => lanAddress({ env: {}, interfaces: publicOnly, warn: quiet }), /找不到/);
});

test("显式公网地址允许但告警，并说明明文 Basic 风险", () => {
  const warnings: string[] = [];
  assert.equal(
    lanAddress({
      env: { LAN_PROXY_HOST: "8.8.8.8" },
      interfaces: interfacesOf([]),
      warn: (text) => warnings.push(text),
    }),
    "8.8.8.8",
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /公网地址/);
  assert.match(warnings[0]!, /Basic/);
});

test("显式 0.0.0.0 / :: / 回环会告警但允许", () => {
  const warnings: string[] = [];
  const warn = (text: string) => warnings.push(text);
  assert.equal(tryLanAddress({ env: { LAN_PROXY_HOST: "0.0.0.0" }, interfaces: interfacesOf([]), warn }), "0.0.0.0");
  assert.equal(tryLanAddress({ env: { LAN_PROXY_HOST: "::" }, interfaces: interfacesOf([]), warn }), "::");
  assert.equal(tryLanAddress({ env: { LAN_PROXY_HOST: "127.0.0.1" }, interfaces: interfacesOf([]), warn }), "127.0.0.1");
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((text) => /通配|所有 IPv6/.test(text)));
  assert.ok(warnings.some((text) => /不是私有/.test(text)));
});

test("显式非法值报错，合法主机名/IPv6 放行", () => {
  for (const bad of ["bad host", "999.1.1.1", "1.2.3", "010.0.0.1"]) {
    assert.throws(
      () => lanAddress({ env: { LAN_PROXY_HOST: bad }, interfaces: interfacesOf([]), warn: quiet }),
      /不是合法的 IP 或主机名/,
      bad,
    );
  }
  assert.equal(lanAddress({ env: { LAN_PROXY_HOST: "lan.local" }, interfaces: interfacesOf([]), warn: quiet }), "lan.local");
  assert.equal(lanAddress({ env: { LAN_PROXY_HOST: "fd00::1" }, interfaces: interfacesOf([]), warn: quiet }), "fd00::1");
});
