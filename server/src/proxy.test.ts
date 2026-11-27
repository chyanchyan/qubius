import assert from "node:assert/strict";
import test from "node:test";
import { matchesProxyDomain, proxyUrlForTarget, resolveProxy, targetMatchesProxyDomains } from "./proxy.js";

test("白名单支持精确域名、*. 通配和全匹配", () => {
  assert.equal(matchesProxyDomain("api.deepseek.com", ["api.deepseek.com"]), true);
  assert.equal(matchesProxyDomain("API.DeepSeek.com.", ["api.deepseek.com"]), true);
  assert.equal(matchesProxyDomain("other.deepseek.com", ["api.deepseek.com"]), false);

  assert.equal(matchesProxyDomain("api.anthropic.com", ["*.anthropic.com"]), true);
  assert.equal(matchesProxyDomain("a.b.anthropic.com", ["*.anthropic.com"]), true);
  // *.example.com 同时匹配主域名。
  assert.equal(matchesProxyDomain("anthropic.com", ["*.anthropic.com"]), true);
  assert.equal(matchesProxyDomain("notanthropic.com", ["*.anthropic.com"]), false);

  assert.equal(matchesProxyDomain("anything.example", ["*"]), true);
  assert.equal(matchesProxyDomain("anything.example", []), false);
});

test("只有白名单里的 http(s) 目标才返回代理地址", () => {
  const settings = { domains: ["api.deepseek.com"], url: "127.0.0.1:7899" };
  const resolved = resolveProxy(settings);
  assert.deepEqual(resolved, { url: "http://127.0.0.1:7899", bypass: [] });

  const target = "https://api.deepseek.com/anthropic";
  assert.equal(proxyUrlForTarget(target, settings, resolved), "http://127.0.0.1:7899");
  // 没在白名单里：直连。
  assert.equal(
    proxyUrlForTarget("https://api.anthropic.com/v1/messages", settings, resolved),
    undefined,
  );
  // 非 http(s) 目标不代理。
  assert.equal(proxyUrlForTarget("ftp://api.deepseek.com/file", settings, resolved), undefined);
  // 无法解析的目标不代理。
  assert.equal(proxyUrlForTarget("not a url", settings, resolved), undefined);
});

test("回环和内网目标即使写进白名单也直连", () => {
  const settings = { domains: ["127.0.0.1", "192.168.1.10", "localhost"], url: "http://127.0.0.1:7899" };
  const resolved = resolveProxy(settings);
  for (const target of [
    "http://127.0.0.1:8787/api/health",
    "http://192.168.1.10:8080/",
    "http://localhost:3000/",
  ]) {
    assert.equal(proxyUrlForTarget(target, settings, resolved), undefined, target);
    assert.equal(targetMatchesProxyDomains(target, settings), true, target);
  }
});

test("没有配置地址时回退到系统代理（环境变量）", () => {
  const original = { ...process.env };
  try {
    process.env.HTTPS_PROXY = "http://system.lan:3128";
    delete process.env.QUBIUS_PROXY;
    const resolved = resolveProxy({ domains: ["api.deepseek.com"] });
    assert.equal(resolved?.url, "http://system.lan:3128");
  } finally {
    process.env = original;
  }
});
