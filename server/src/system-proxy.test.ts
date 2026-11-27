import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProxyUrl,
  parseRegistryOutput,
  proxyUrlFromServer,
  shouldBypassProxy,
  splitBypass,
  systemProxy,
} from "./system-proxy.js";

const REGISTRY_OUTPUT = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  "    ProxyEnable    REG_DWORD    0x1",
  "    ProxyServer    REG_SZ    localhost:15236",
  "    ProxyOverride    REG_SZ    <local>;*.internal.example.com",
  "",
].join("\r\n");

test("parseRegistryOutput 读取开关、地址和绕过列表", () => {
  const parsed = parseRegistryOutput(REGISTRY_OUTPUT);
  assert.deepEqual(parsed, {
    enabled: true,
    server: "localhost:15236",
    override: "<local>;*.internal.example.com",
  });
  assert.equal(parseRegistryOutput(REGISTRY_OUTPUT.replace("0x1", "0x0"))?.enabled, false);
  assert.equal(parseRegistryOutput(REGISTRY_OUTPUT.replace("0x1", "0"))?.enabled, false);
  // 没有 ProxyEnable 字段时视为没读到。
  assert.equal(parseRegistryOutput("    ProxyServer    REG_SZ    localhost:15236"), undefined);
});

test("proxyUrlFromServer 优先 https，其次 http，最后裸地址", () => {
  assert.equal(proxyUrlFromServer("localhost:15236"), "http://localhost:15236");
  assert.equal(
    proxyUrlFromServer("http=proxy.lan:8080;https=secure.lan:8443"),
    "http://secure.lan:8443",
  );
  assert.equal(proxyUrlFromServer("http=proxy.lan:8080"), "http://proxy.lan:8080");
  // 协议大小写不敏感。
  assert.equal(proxyUrlFromServer("HTTPS=secure.lan:8443"), "http://secure.lan:8443");
  assert.equal(proxyUrlFromServer(""), undefined);
  assert.equal(proxyUrlFromServer(" ; ; "), undefined);
});

test("normalizeProxyUrl 补全协议并拒绝非 HTTP(S)", () => {
  assert.equal(normalizeProxyUrl("localhost:15236"), "http://localhost:15236");
  assert.equal(normalizeProxyUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizeProxyUrl("  "), undefined);
  assert.equal(normalizeProxyUrl("socks5://127.0.0.1:1080"), undefined);
});

test("systemProxy 优先读环境变量，不依赖注册表", () => {
  let registryReads = 0;
  const readRegistry = () => {
    registryReads += 1;
    return { enabled: true, server: "registry.lan:9000", override: "" };
  };
  const fromEnv = systemProxy({
    env: { HTTPS_PROXY: "http://env.lan:8080", QUBIUS_PROXY: "http://special.lan:7070" },
    platform: "win32",
    readRegistry,
  });
  assert.equal(fromEnv?.url, "http://special.lan:7070");
  assert.equal(registryReads, 0);

  // 大写 HTTPS_PROXY 优先于小写。
  assert.equal(
    systemProxy({ env: { HTTPS_PROXY: "http://upper.lan:8080", https_proxy: "http://lower.lan:8080" } })?.url,
    "http://upper.lan:8080",
  );
});

test("systemProxy 在 Windows 读取注册表，未启用时返回 undefined", () => {
  const enabled = systemProxy({
    env: {},
    platform: "win32",
    readRegistry: () => ({ enabled: true, server: "localhost:15236", override: "<local>" }),
  });
  assert.deepEqual(enabled, { url: "http://localhost:15236", bypass: ["<local>"] });

  const disabled = systemProxy({
    env: {},
    platform: "win32",
    readRegistry: () => ({ enabled: false, server: "localhost:15236", override: "" }),
  });
  assert.equal(disabled, undefined);

  // 非 Windows 不读注册表。
  let registryReads = 0;
  const linux = systemProxy({
    env: {},
    platform: "linux",
    readRegistry: () => {
      registryReads += 1;
      return { enabled: true, server: "localhost:15236", override: "" };
    },
  });
  assert.equal(linux, undefined);
  assert.equal(registryReads, 0);
});

test("systemProxy 把 NO_PROXY 拆成绕过列表", () => {
  const proxy = systemProxy({
    env: { HTTPS_PROXY: "http://env.lan:8080", NO_PROXY: "a.example.com, b.local" },
    platform: "linux",
  });
  assert.deepEqual(proxy?.bypass, ["a.example.com", "b.local"]);
});

test("shouldBypassProxy 让回环和内网地址直连", () => {
  for (const target of [
    "http://127.0.0.1:3000/",
    "http://localhost:8787/",
    "http://[::1]:8787/",
    "http://192.168.1.20/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://printer.local/",
  ]) {
    assert.equal(shouldBypassProxy(target, []), true, target);
  }
  assert.equal(shouldBypassProxy("http://172.32.0.1/", []), false);
  assert.equal(shouldBypassProxy("https://api.example.com/", []), false);
  assert.equal(shouldBypassProxy("not a url", []), false);
});

test("ProxyOverride 支持通配和 <local>", () => {
  assert.equal(shouldBypassProxy("http://intranet/", ["<local>"]), true);
  assert.equal(shouldBypassProxy("http://intranet.example.com/", ["<local>"]), false);
  assert.equal(shouldBypassProxy("https://api.example.com/", ["*.example.com"]), true);
  // 通配不匹配裸域。
  assert.equal(shouldBypassProxy("https://example.com/", ["*.example.com"]), false);
  assert.equal(shouldBypassProxy("https://api.example.com/", ["api.example.com"]), true);
  assert.equal(shouldBypassProxy("https://other.example.com/", ["api.example.com"]), false);
  // 大小写不敏感。
  assert.equal(shouldBypassProxy("https://API.Example.com/", ["api.example.com"]), true);
});

test("splitBypass 支持分号、逗号和空白", () => {
  assert.deepEqual(splitBypass("a;b"), ["a", "b"]);
  assert.deepEqual(splitBypass("a,b  c"), ["a", "b", "c"]);
  assert.deepEqual(splitBypass(" a ; b ; "), ["a", "b"]);
  assert.deepEqual(splitBypass(""), []);
});
