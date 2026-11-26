import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseRegistryText, readRegistry } from "./registry.js";
import {
  findConflictingSiteBlocks,
  MANAGED_END,
  MANAGED_START,
  redact,
  renderLocalCaddyfile,
  renderVpsBlock,
  renderVpsCaddyfile,
  secretValues,
  spliceManaged,
} from "./render.js";
import { loadEdgeSecrets } from "./secrets.js";
import { EdgeError } from "./types.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const REGISTRY = path.join(FIXTURES, "registry", "edgectl.yaml");
const GOLDEN = path.join(FIXTURES, "golden");
const CADDYFILES = path.join(FIXTURES, "caddyfiles");

function read(name: string): string {
  return fs.readFileSync(path.join(CADDYFILES, name), "utf8");
}

function fixture() {
  const registry = readRegistry(REGISTRY);
  const secrets = loadEdgeSecrets({ registry, env: {} });
  return { registry, secrets };
}

test("VPS 托管块与 edgectl render 逐字节一致", () => {
  const { registry, secrets } = fixture();
  const actual = renderVpsCaddyfile(registry, secrets);
  const golden = fs.readFileSync(path.join(GOLDEN, "vps.managed.Caddyfile"), "utf8");
  assert.equal(actual, golden);
});

test("本地网关 Caddyfile 与 edgectl render 逐字节一致", () => {
  const { registry } = fixture();
  const actual = renderLocalCaddyfile(registry);
  const golden = fs.readFileSync(path.join(GOLDEN, "local.Caddyfile"), "utf8");
  assert.equal(actual, golden);
});

test("没有站点时 VPS 块为空，完整文件退化为注释", () => {
  const registry = parseRegistryText(
    ["version: 1", "edge:", "  vps:", "    ssh: a@b", "    caddyfile: /opt/x/Caddyfile", "sites: []", ""].join(
      "\n",
    ),
  );
  assert.equal(renderVpsBlock(registry), "");
  assert.equal(renderVpsCaddyfile(registry), "# No sites configured.\n");
});

test("dev 站点缺少密钥时报中文错误", () => {
  const registry = readRegistry(REGISTRY);
  assert.throws(() => renderVpsBlock(registry), /缺少 dev 认证密钥/);
});

test("splice：无 marker 时追加到末尾", () => {
  const { registry, secrets } = fixture();
  const block = renderVpsBlock(registry, secrets);
  const existing = read("no-markers.txt");
  const out = spliceManaged(existing, block);
  assert.ok(out.startsWith("# a hand-written Caddyfile"));
  assert.match(out, /example\.org \{/);
  assert.ok(out.includes(MANAGED_START));
  assert.ok(out.includes(MANAGED_END));
  assert.ok(out.endsWith("\n"));
  assert.equal(out.match(/\n\n\n/g), null);
});

test("splice：替换托管块，保留 marker 外内容", () => {
  const { registry, secrets } = fixture();
  const block = renderVpsBlock(registry, secrets);
  const out = spliceManaged(read("with-markers.txt"), block);
  assert.ok(out.includes("# keep this comment"));
  assert.ok(out.includes("legacy.example.net"));
  assert.ok(out.includes("# footer stays"));
  assert.ok(out.includes("tail.example.org"));
  assert.ok(out.includes("qubius.example.com"));
  assert.ok(!out.includes("old.example.com"));
  assert.equal(out.indexOf(MANAGED_START) < out.indexOf(MANAGED_END), true);
});

test("splice：空块删除托管段", () => {
  const out = spliceManaged(read("with-markers.txt"), "");
  assert.ok(!out.includes(MANAGED_START));
  assert.ok(!out.includes(MANAGED_END));
  assert.ok(!out.includes("old.example.com"));
  assert.ok(out.includes("legacy.example.net"));
  assert.ok(out.includes("# footer stays"));
});

test("splice：空文件直接写入托管块（无前导空行）", () => {
  const { registry, secrets } = fixture();
  const block = renderVpsBlock(registry, secrets);
  const out = spliceManaged(read("empty.txt"), block);
  assert.equal(out.startsWith(MANAGED_START), true);
  assert.equal(out, block);
  assert.equal(spliceManaged(read("empty.txt"), ""), "");
});

test("splice：尾部多空行时保持紧凑，空块不变", () => {
  const { registry, secrets } = fixture();
  const existing = read("trailing-blank.txt");
  assert.equal(spliceManaged(existing, ""), existing);
  const out = spliceManaged(existing, renderVpsBlock(registry, secrets));
  assert.equal(out.match(/\n{3,}/), null);
  assert.ok(out.includes("example.org"));
  assert.ok(out.includes(MANAGED_END));
});

test("splice：CRLF 归一化为 LF", () => {
  const { registry, secrets } = fixture();
  const out = spliceManaged(read("crlf.txt"), renderVpsBlock(registry, secrets));
  assert.equal(out.includes("\r"), false);
  assert.ok(out.includes("legacy.example.net"));
  assert.ok(out.includes("qubius.example.com"));
});

test("splice：marker 不完整时报错", () => {
  assert.throws(() => spliceManaged(`${MANAGED_START}\nx {}\n`, "y {}\n"), EdgeError);
  assert.throws(() => spliceManaged(`x {}\n${MANAGED_END}\n`, "y {}\n"), EdgeError);
});

test("冲突检测：忽略托管块内部与嵌套指令", () => {
  const managed = read("with-markers.txt");
  assert.deepEqual(findConflictingSiteBlocks(managed, new Set(["old.example.com"])), []);
  assert.deepEqual(findConflictingSiteBlocks(read("nested.txt"), new Set(["qubius.example.com"])), []);
  assert.deepEqual(findConflictingSiteBlocks(read("comments.txt"), new Set(["qubius.example.com"])), []);
});

test("冲突检测：找到托管块之外的顶层站点", () => {
  const hits = findConflictingSiteBlocks(read("conflicting.txt"), new Set(["qubius.example.com"]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.[0], 2);
  assert.match(hits[0]?.[1] ?? "", /qubius\.example\.com/);
});

test("冲突检测：支持多域名/端口/协议/引号/大小写/尾点", () => {
  const existing = 'https://A.Example.com:443, "b.example.com" {\n}\n';
  const hits = findConflictingSiteBlocks(existing, new Set(["a.example.com", "b.example.com"]));
  assert.equal(hits.length, 1);
});

test("redact 替换所有非空密钥", () => {
  const { secrets } = fixture();
  const text = `hash=${secrets.passwordHash} cookie=${secrets.cookieSecret}`;
  const out = redact(text, secretValues(secrets));
  assert.equal(out.includes(secrets.passwordHash), false);
  assert.equal(out.includes(secrets.cookieSecret), false);
  assert.equal(out.match(/<redacted>/g)?.length, 2);
});
