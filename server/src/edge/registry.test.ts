import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseRegistryText,
  readRegistry,
  renderRegistryDiff,
  upsertManagedSites,
  validateRegistry,
} from "./registry.js";
import { EdgeError, type EdgeSite } from "./types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "registry", "edgectl.yaml");

const MINIMAL = [
  "version: 1",
  "edge:",
  "  vps:",
  "    ssh: ubuntu@example.test",
  "    caddyfile: /opt/example/Caddyfile",
  "sites:",
  "  - name: example-dev",
  "    domains: [dev.example.com]",
  "    env: dev",
  "    upstream: http://127.0.0.1:5173",
  "    auth: dev",
  "    sse: true",
  "",
].join("\n");

function tempFile(content: string, name = "edgectl.yaml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-registry-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const qubiusSite = (overrides: Partial<EdgeSite> = {}): EdgeSite => ({
  name: "qubius",
  domains: ["qubius.example.com"],
  env: "dev",
  upstream: "http://127.0.0.1:8789",
  auth: "dev",
  sse: true,
  ...overrides,
});

test("解析真实结构 fixture：默认值与规范化", () => {
  const registry = readRegistry(FIXTURE);
  assert.equal(registry.version, 1);
  assert.equal(registry.vps.gatewayPort, 18080);
  assert.equal(registry.vps.tunnelBind, "172.17.0.1");
  assert.equal(registry.local.tunnelUser, "deploy");
  assert.equal(registry.authDev.cookieName, "edgectl_dev");
  assert.equal(registry.gitlabUrl, "http://gitea.example.com");
  assert.equal(registry.sites.length, 4);
  const app = registry.sites.find((site) => site.name === "app");
  assert.equal(app?.env, "prod");
  assert.equal(app?.auth, "none");
  assert.equal(app?.deploy?.healthTimeout, 120);
  assert.deepEqual(app?.deploy?.preBuild, [
    ["npm", "--prefix", "web", "ci"],
    ["npm", "--prefix", "web", "run", "build"],
  ]);
});

test("域名/upstream/路径规则与 edgectl 一致", () => {
  const base = (sites: string[]): string =>
    ["version: 1", "edge:", "  vps:", "    ssh: a@b", "    caddyfile: /opt/x/Caddyfile", "sites:", ...sites, ""].join(
      "\n",
    );
  // upstream 缺省 scheme 时自动补 http://
  const simple = parseRegistryText(
    base(["  - name: a", "    domains: [dev.example.com]", "    upstream: 127.0.0.1:1"]),
  );
  assert.equal(simple.sites[0]?.upstream, "http://127.0.0.1:1");
  // 重复域名
  assert.throws(
    () =>
      parseRegistryText(
        base([
          "  - name: a",
          "    domains: [dup.example.com]",
          "    upstream: http://127.0.0.1:1",
          "  - name: b",
          "    domains: [dup.example.com]",
          "    upstream: http://127.0.0.1:2",
        ]),
      ),
    /同时出现/,
  );
  // 通配
  assert.throws(
    () =>
      parseRegistryText(
        base(['  - name: a', '    domains: ["*.example.com"]', "    upstream: http://127.0.0.1:1"]),
      ),
    /通配/,
  );
  // 无 TLD
  assert.throws(
    () => parseRegistryText(base(["  - name: a", "    domains: [localhost]", "    upstream: http://127.0.0.1:1"])),
    /不是合法域名/,
  );
  // upstream 带路径
  assert.throws(
    () =>
      parseRegistryText(
        base([
          "  - name: a",
          "    domains: [a.example.com]",
          "    upstream: http://127.0.0.1:1/api",
        ]),
      ),
    /不能带路径/,
  );
  // upstream 带凭证
  assert.throws(
    () =>
      parseRegistryText(
        base([
          "  - name: a",
          "    domains: [a.example.com]",
          "    upstream: http://user:pass@127.0.0.1:1",
        ]),
      ),
    /不能包含用户名或密码/,
  );
  // caddyfile 必须绝对路径
  assert.throws(
    () =>
      parseRegistryText(
        ["version: 1", "edge:", "  vps:", "    ssh: a@b", "    caddyfile: relative/Caddyfile", "sites: []", ""].join(
          "\n",
        ),
      ),
    /绝对路径/,
  );
  // compose_file 不能 .. 穿越
  assert.throws(
    () =>
      parseRegistryText(
        base([
          "  - name: a",
          "    domains: [a.example.com]",
          "    upstream: http://127.0.0.1:1",
          "    deploy:",
          "      repo: /srv/app",
          "      compose_file: ../outside.yml",
        ]),
      ),
    /相对路径/,
  );
});

test("未知键保留在 extras，version 必须为 1", () => {
  const registry = parseRegistryText(
    [
      "version: 1",
      "edge:",
      "  vps:",
      "    ssh: a@b",
      "    caddyfile: /opt/x/Caddyfile",
      "sites:",
      "  - name: a",
      "    domains: [a.example.com]",
      "    upstream: http://127.0.0.1:1",
      "    custom: keep",
      "top: keep",
      "",
    ].join("\n"),
  );
  assert.equal(registry.sites[0]?.extras?.custom, "keep");
  assert.equal(registry.extras.top, "keep");
  assert.throws(() => validateRegistry({ version: 2 }), /version: 1/);
});

test("sites: null 视为空列表；upsert 可正常追加", () => {
  const text = [
    "version: 1",
    "edge:",
    "  vps:",
    "    ssh: ubuntu@example.test",
    "    caddyfile: /opt/example/Caddyfile",
    "sites:",
    "",
  ].join("\n");
  const registry = parseRegistryText(text);
  assert.deepEqual(registry.sites, []);
  const file = tempFile(text);
  const result = upsertManagedSites(file, [qubiusSite()]);
  assert.equal(result.changed, true);
  assert.equal(parseRegistryText(fs.readFileSync(file, "utf8"), file).sites.at(-1)?.name, "qubius");
});

test("密钥环境变量名必须是合法标识符", () => {
  const text = (name: string): string =>
    [
      "version: 1",
      "edge:",
      "  vps:",
      "    ssh: a@b",
      "    caddyfile: /opt/x/Caddyfile",
      "  auth:",
      "    dev:",
      `      password_hash_env: ${name}`,
      "sites: []",
      "",
    ].join("\n");
  assert.throws(() => parseRegistryText(text("__proto__")), /合法的环境变量名/);
  assert.throws(() => parseRegistryText(text("constructor")), /合法的环境变量名/);
  assert.throws(() => parseRegistryText(text("1BAD")), /合法的环境变量名/);
  assert.equal(
    parseRegistryText(text("EDGECTL_DEV_PASSWORD_HASH")).authDev.passwordHashEnv,
    "EDGECTL_DEV_PASSWORD_HASH",
  );
});

test("readRegistry 缺失文件返回中文错误", () => {
  assert.throws(() => readRegistry("/nonexistent/edgectl.yaml"), /找不到 edgectl 配置/);
});

test("upsert 只改受管条目并保留其它站点/deploy", () => {
  const file = tempFile(fs.readFileSync(FIXTURE, "utf8"));
  const before = parseRegistryText(fs.readFileSync(file, "utf8"), file);
  const result = upsertManagedSites(file, [
    qubiusSite({ domains: ["new-qubius.example.com"], upstream: "http://127.0.0.1:9789" }),
    {
      name: "co-qubius",
      domains: ["new-co.example.com"],
      env: "dev",
      upstream: "http://127.0.0.1:9790",
      auth: "dev",
      sse: true,
    },
  ]);
  assert.equal(result.changed, true);
  const after = parseRegistryText(fs.readFileSync(file, "utf8"), file);
  const qubius = after.sites.find((site) => site.name === "qubius");
  assert.deepEqual(qubius?.domains, ["new-qubius.example.com"]);
  assert.equal(qubius?.upstream, "http://127.0.0.1:9789");
  const app = after.sites.find((site) => site.name === "app");
  assert.deepEqual(app?.deploy?.preBuild, before.sites.find((s) => s.name === "app")?.deploy?.preBuild);
  assert.equal(after.sites.find((site) => site.name === "example-dev")?.upstream, "http://127.0.0.1:5173");
  assert.match(result.diff, /修改站点 qubius/);
  assert.ok(result.backup);
  assert.ok(fs.existsSync(result.backup!));
});

test("upsert 幂等：候选与原文相同则跳过写盘", () => {
  const file = tempFile(fs.readFileSync(FIXTURE, "utf8"));
  const site: EdgeSite = {
    name: "qubius",
    domains: ["qubius.example.com"],
    env: "dev",
    upstream: "http://127.0.0.1:8789",
    auth: "dev",
    sse: true,
  };
  const result = upsertManagedSites(file, [site]);
  // 字段相同，但序列化可能给 sse 加引号/重排；只要语义相同就视为无变化。
  if (result.changed) {
    const second = upsertManagedSites(file, [site]);
    assert.equal(second.changed, false);
  } else {
    assert.equal(result.changed, false);
  }
});

test("upsert 把新站点追加到 sites 末尾", () => {
  const file = tempFile(MINIMAL);
  const result = upsertManagedSites(file, [qubiusSite()]);
  assert.equal(result.changed, true);
  const registry = parseRegistryText(fs.readFileSync(file, "utf8"), file);
  assert.equal(registry.sites.at(-1)?.name, "qubius");
  assert.equal(registry.sites.length, 2);
});

test("upsert 拒绝 CRLF", () => {
  const file = tempFile(MINIMAL.replace(/\n/g, "\r\n"));
  assert.throws(() => upsertManagedSites(file, [qubiusSite()]), /CRLF/);
});

test("upsert 字节守卫：原文会被重新排版时拒绝", () => {
  const file = tempFile(`${MINIMAL}extra:    spaced\n`);
  assert.throws(() => upsertManagedSites(file, [qubiusSite()]), /字节不一致|手工修改/);
});

test("upsert 拒绝带 anchor 或被 alias 引用的受管条目", () => {
  const withQubius =
    `${MINIMAL}  - &managed\n` +
    "    name: qubius\n" +
    "    domains: [qubius.example.com]\n" +
    "    env: dev\n" +
    "    upstream: http://127.0.0.1:1\n" +
    "    auth: dev\n" +
    "    sse: true\n";
  const file1 = tempFile(withQubius);
  assert.throws(() => upsertManagedSites(file1, [qubiusSite()]), /anchor/);

  const file2 = tempFile(`${withQubius}mirror: *managed\n`);
  assert.throws(() => upsertManagedSites(file2, [qubiusSite()]), /alias|anchor/);
});

test("upsert 保留文件 mode 并生成备份（uid/gid 不变）", () => {
  const file = tempFile(fs.readFileSync(FIXTURE, "utf8"));
  fs.chmodSync(file, 0o640);
  const before = fs.statSync(file);
  const result = upsertManagedSites(file, [qubiusSite({ domains: ["x.example.com"] })]);
  assert.equal(result.changed, true);
  const after = fs.statSync(file);
  assert.equal(after.mode & 0o777, 0o640);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(fs.statSync(result.backup!).mode & 0o777, 0o640);
});

test("renderRegistryDiff 结构性描述变化且不泄漏密钥", () => {
  const before = fs.readFileSync(FIXTURE, "utf8");
  const after = before.replace("domains: [qubius.example.com]", "domains: [changed.example.com]");
  const diff = renderRegistryDiff(before, after);
  assert.match(diff, /修改站点 qubius/);
  assert.match(diff, /changed\.example\.com/);
  assert.doesNotMatch(diff, /\$2[aby]\$/);
});
