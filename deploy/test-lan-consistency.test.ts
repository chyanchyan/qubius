import assert from "node:assert/strict";
import type os from "node:os";
import test from "node:test";
import {
  classifyIPv4 as classifyServer,
  isLanIPv4 as isLanServer,
  lanAddress as lanAddressServer,
} from "../server/src/lan-address.js";
import {
  classifyIPv4 as classifyDeploy,
  isLanIPv4 as isLanDeploy,
  lanAddress as lanAddressDeploy,
} from "./deploy-lib.mjs";

/**
 * 局域网地址规则在 `server/src/lan-address.ts` 和 `deploy/deploy-lib.mjs`
 * 各有一份（部署任务在 npm ci 之前运行，不能依赖 TypeScript 服务端代码）。
 * 这里用同一组边界地址和伪造网卡逐项对比两个实现，防止两者悄悄漂移。
 *
 * 注意：除了对比两侧结果，也断言分类的期望值，否则两边一起改错时
 * 单纯的一致性对比仍然会通过。
 */

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function interfacesOf(
  entries: Array<[name: string, address: string, internal?: boolean]>,
): Interfaces {
  const out: Interfaces = {};
  for (const [name, address, internal = false] of entries) {
    out[name] = [{
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal,
      cidr: null,
    }];
  }
  return out;
}

const quiet = () => {};

// [地址, 期望分类]。覆盖每个网段的起点、终点和紧邻的边界。
const ADDRESSES: Array<[string, string]> = [
  ["0.0.0.0", "unspecified"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.255", "loopback"],
  ["10.0.0.0", "private"],
  ["10.255.255.255", "private"],
  ["172.15.255.255", "public"],
  ["172.16.0.0", "private"],
  ["172.31.255.255", "private"],
  ["172.32.0.0", "public"],
  ["192.167.255.255", "public"],
  ["192.168.0.0", "private"],
  ["192.168.255.255", "private"],
  ["192.169.0.0", "public"],
  ["100.63.255.255", "public"],
  ["100.64.0.0", "shared"],
  ["100.127.255.255", "shared"],
  ["100.128.0.0", "public"],
  ["169.254.0.0", "link-local"],
  ["169.254.255.255", "link-local"],
  ["169.255.0.0", "public"],
  ["192.0.2.1", "reserved"],
  ["198.18.0.0", "reserved"],
  ["198.19.255.255", "reserved"],
  ["198.51.100.1", "reserved"],
  ["203.0.113.1", "reserved"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "reserved"],
  ["8.8.8.8", "public"],
  ["1.1.1.1", "public"],
  // 非法：前导零、越界、段数不对、非数字。
  ["010.0.0.1", "invalid"],
  ["01.2.3.4", "invalid"],
  ["256.1.1.1", "invalid"],
  ["1.2.3.256", "invalid"],
  ["1.2.3", "invalid"],
  ["1.2.3.4.5", "invalid"],
  ["not-an-ip", "invalid"],
  ["", "invalid"],
];

const LAN_CATEGORIES = new Set(["private", "shared", "link-local"]);

test("classifyIPv4 与 isLanIPv4 在服务端和 deploy-lib 中逐项一致", () => {
  for (const [address, expected] of ADDRESSES) {
    const serverCategory = classifyServer(address);
    const deployCategory = classifyDeploy(address);
    assert.equal(deployCategory, serverCategory, `分类不一致：${JSON.stringify(address)}`);
    assert.equal(serverCategory, expected, `分类期望值不符：${JSON.stringify(address)}`);

    const expectedLan = LAN_CATEGORIES.has(expected);
    assert.equal(isLanServer(address), isLanDeploy(address), `isLanIPv4 不一致：${JSON.stringify(address)}`);
    assert.equal(isLanServer(address), expectedLan, `isLanIPv4 期望值不符：${JSON.stringify(address)}`);
  }
});

test("自动选择局域网地址时两侧结果一致（私有 > CGNAT > 链路本地）", () => {
  const mixed = interfacesOf([
    ["eth0", "8.8.8.8"],
    ["eth1", "169.254.10.20"],
    ["eth2", "100.64.3.4"],
    ["eth3", "10.20.30.40"],
    ["lo", "127.0.0.1", true],
    ["docker0", "10.1.1.1"],
  ]);
  assert.equal(
    lanAddressDeploy({ env: {}, interfaces: mixed, warn: quiet }),
    lanAddressServer({ env: {}, interfaces: mixed, warn: quiet }),
  );
  assert.equal(lanAddressServer({ env: {}, interfaces: mixed, warn: quiet }), "10.20.30.40");

  // 网卡顺序反过来也应选出同一个地址（优先级表中 private 最高）。
  const reordered = interfacesOf([
    ["docker0", "10.1.1.1"],
    ["lo", "127.0.0.1", true],
    ["eth3", "10.20.30.40"],
    ["eth2", "100.64.3.4"],
    ["eth1", "169.254.10.20"],
    ["eth0", "8.8.8.8"],
  ]);
  assert.equal(
    lanAddressDeploy({ env: {}, interfaces: reordered, warn: quiet }),
    lanAddressServer({ env: {}, interfaces: reordered, warn: quiet }),
  );
  assert.equal(lanAddressServer({ env: {}, interfaces: reordered, warn: quiet }), "10.20.30.40");
});

test("自动选择时同优先级取首个地址，两侧顺序敏感行为一致", () => {
  // 多个 private 地址时两边都按遍历顺序取第一个 private。
  const privateOnly = interfacesOf([
    ["eth0", "192.168.1.10"],
    ["eth1", "10.0.0.5"],
  ]);
  assert.equal(
    lanAddressDeploy({ env: {}, interfaces: privateOnly, warn: quiet }),
    lanAddressServer({ env: {}, interfaces: privateOnly, warn: quiet }),
  );
  assert.equal(lanAddressServer({ env: {}, interfaces: privateOnly, warn: quiet }), "192.168.1.10");

  const cgnatOverLinkLocal = interfacesOf([
    ["eth0", "169.254.10.20"],
    ["eth1", "100.64.3.4"],
  ]);
  assert.equal(
    lanAddressDeploy({ env: {}, interfaces: cgnatOverLinkLocal, warn: quiet }),
    lanAddressServer({ env: {}, interfaces: cgnatOverLinkLocal, warn: quiet }),
  );
  assert.equal(lanAddressServer({ env: {}, interfaces: cgnatOverLinkLocal, warn: quiet }), "100.64.3.4");
});

test("显式 LAN_PROXY_HOST / QUBIUS_LAN_HOST 两侧行为一致", () => {
  for (const env of [
    { LAN_PROXY_HOST: "10.0.0.9" },
    { QUBIUS_LAN_HOST: "192.168.1.5" },
    { LAN_PROXY_HOST: "10.0.0.9", QUBIUS_LAN_HOST: "192.168.1.5" },
    { LAN_PROXY_HOST: "8.8.8.8" }, // 公网：允许但告警
    { LAN_PROXY_HOST: "0.0.0.0" },
  ]) {
    const deploy = lanAddressDeploy({ env, interfaces: interfacesOf([]), warn: quiet });
    const server = lanAddressServer({ env, interfaces: interfacesOf([]), warn: quiet });
    assert.equal(deploy, server, `显式地址结果不一致：${JSON.stringify(env)}`);
  }

  // 非法显式地址两侧都应拒绝。
  for (const bad of ["bad host", "999.1.1.1", "1.2.3", "010.0.0.1"]) {
    assert.throws(
      () => lanAddressDeploy({ env: { LAN_PROXY_HOST: bad }, interfaces: interfacesOf([]), warn: quiet }),
      /不是合法的 IP 或主机名/,
      `deploy-lib 未拒绝：${bad}`,
    );
    assert.throws(
      () => lanAddressServer({ env: { LAN_PROXY_HOST: bad }, interfaces: interfacesOf([]), warn: quiet }),
      /不是合法的 IP 或主机名/,
      `server 未拒绝：${bad}`,
    );
  }
});

test("没有可用局域网地址时两侧都报错", () => {
  const publicOnly = interfacesOf([
    ["eth0", "8.8.8.8"],
    ["lo", "127.0.0.1", true],
  ]);
  assert.throws(
    () => lanAddressDeploy({ env: {}, interfaces: publicOnly, warn: quiet }),
    /找不到/,
  );
  assert.throws(
    () => lanAddressServer({ env: {}, interfaces: publicOnly, warn: quiet }),
    /找不到/,
  );
});
