import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  needsInstall,
  parseEnvFile,
  redactUrl,
  renderConfigYaml,
  repoRootFromServerScript,
  samePath,
  stripAnsi,
  validateProjectsIndent,
} from "./deploy-lib.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-deploy-lib-"));
}

test("parseEnvFile 支持注释、引号、$HOME 与 %VAR%", () => {
  const env = { HOME: "/home/me", APPDATA: "C:\\Users\\me\\AppData\\Roaming" };
  const values = parseEnvFile([
    "# 注释",
    "QUBIUS_PRIMARY_PORT=9123",
    "export QUBIUS_SECONDARY_PORT='9124'",
    'QUBIUS_PUBLIC_HOST="code.example.com" # 行尾注释',
    "QUBIUS_PRIMARY_DIR=$HOME/qubius",
    "QUBIUS_SECONDARY_DIR=${HOME}/co-qubius",
    "QUBIUS_ARCHIVE_DIR=%APPDATA%\\archive",
    "EMPTY=",
    "",
  ].join("\r\n"), env);
  assert.equal(values.QUBIUS_PRIMARY_PORT, "9123");
  assert.equal(values.QUBIUS_SECONDARY_PORT, "9124");
  assert.equal(values.QUBIUS_PUBLIC_HOST, "code.example.com");
  assert.equal(values.QUBIUS_PRIMARY_DIR, "/home/me/qubius");
  assert.equal(values.QUBIUS_SECONDARY_DIR, "/home/me/co-qubius");
  assert.equal(values.QUBIUS_ARCHIVE_DIR, "C:\\Users\\me\\AppData\\Roaming\\archive");
  assert.equal(values.EMPTY, "");
});

test("renderConfigYaml 主实例可被 yaml 解析，projects 与 archive 正确", () => {
  const text = renderConfigYaml({
    role: "primary",
    dataDir: "C:\\Users\\me\\AppData\\Local\\qubius",
    port: 8787,
    publicHost: "code.example.com",
    maxConcurrent: 6,
    archiveDir: "D:\\archive\\qubius",
    archiveRetentionDays: 60,
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "C:\\Users\\me\\co-qubius",
    projectsText: [
      "  - id: 'demo'",
      "    name: '示例'",
      "    path: 'D:\\src\\demo'",
      "    permission: plan",
      "",
    ].join("\n"),
  });
  const doc = parseYaml(text);
  assert.equal(doc.role, "primary");
  assert.equal(doc.listen, "127.0.0.1:8787");
  assert.equal(doc.dataDir, "C:\\Users\\me\\AppData\\Local\\qubius");
  assert.deepEqual(doc.allowedHosts, ["127.0.0.1", "localhost", "[::1]", "code.example.com"]);
  assert.equal(doc.maxConcurrent, 6);
  assert.equal(doc.archive.dir, "D:\\archive\\qubius");
  assert.equal(doc.archive.retentionDays, 60);
  assert.equal(doc.archive.instance, "main");
  assert.deepEqual(doc.projects.map((item) => item.id), ["co-qubius", "demo"]);
  assert.equal(doc.projects[1].path, "D:\\src\\demo");
});

test("renderConfigYaml 副实例包含 secondary 块且没有 archive 时省略", () => {
  const text = renderConfigYaml({
    role: "secondary",
    dataDir: "/srv/co-data",
    port: 8788,
    publicHost: "code-bak.example.com",
    peerId: "qubius",
    peerName: "qubius",
    peerPath: "/srv/qubius",
    secondary: {
      primaryRepo: "/srv/qubius",
      primaryRef: "main",
      script: "/srv/co-qubius/deploy/secondary.sh",
      restart: "/srv/co-qubius/deploy/run.sh",
    },
  });
  const doc = parseYaml(text);
  assert.equal(doc.role, "secondary");
  assert.equal(doc.secondary.primaryRepo, "/srv/qubius");
  assert.equal(doc.secondary.primaryRef, "main");
  assert.equal(doc.secondary.script, "/srv/co-qubius/deploy/secondary.sh");
  assert.equal(doc.secondary.restart, "/srv/co-qubius/deploy/run.sh");
  assert.equal(doc.archive, undefined);
  assert.deepEqual(doc.projects.map((item) => item.id), ["qubius"]);
});

test("没有对端 checkout 时不写空 path，localhost 不重复", () => {
  const text = renderConfigYaml({
    role: "primary",
    dataDir: "/data",
    port: 8787,
    publicHost: "localhost",
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "",
  });
  const doc = parseYaml(text);
  // peerPath 为空时不能写 path: ''，否则 server 启动时会拒绝配置。
  assert.equal(doc.projects, undefined);
  assert.deepEqual(doc.allowedHosts, ["127.0.0.1", "localhost", "[::1]"]);
  // 没有对端但还有额外项目时要保留 projects: 键。
  const withExtra = parseYaml(renderConfigYaml({
    role: "primary",
    dataDir: "/data",
    port: 8787,
    publicHost: "code.example.com",
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "",
    projectsText: "  - id: 'demo'\n    name: '演示'\n    path: '/srv/demo'\n",
  }));
  assert.deepEqual(withExtra.projects.map((item) => item.id), ["demo"]);
});

test("renderConfigYaml 拒绝控制字符并保持单行", () => {
  const text = renderConfigYaml({
    role: "primary",
    dataDir: "D:\\data",
    port: 8787,
    publicHost: "code.example.com",
    peerId: "co-qubius",
    peerName: "co-qubius",
    peerPath: "D:\\peer",
  });
  assert.ok(!text.includes("\r"));
  const doc = parseYaml(text);
  assert.equal(doc.projects[0].path, "D:\\peer");
});

test("validateProjectsIndent 接受两空格/四空格，拒绝制表符和错误缩进", () => {
  assert.deepEqual(
    validateProjectsIndent("  - id: 'a'\n    name: 'a'\n\n    permission: plan\n"),
    { ok: true },
  );
  const tab = validateProjectsIndent("  - id: 'a'\n\tname: 'a'\n");
  assert.equal(tab.ok, false);
  assert.equal(tab.line, 2);
  const bad = validateProjectsIndent("  - id: 'a'\n   name: 'a'\n");
  assert.equal(bad.ok, false);
  assert.equal(bad.line, 2);
});

test("needsInstall 按 package-lock 哈希判断", () => {
  const repo = tmp();
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  assert.equal(needsInstall(repo), true);
  const nodeModules = path.join(repo, "node_modules");
  fs.mkdirSync(nodeModules);
  assert.equal(needsInstall(repo), true);
  const hash = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(repo, "package-lock.json")))
    .digest("hex");
  fs.writeFileSync(path.join(nodeModules, ".qubius-lock-hash"), `${hash}\n`);
  assert.equal(needsInstall(repo), false);
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n\n");
  assert.equal(needsInstall(repo), true);
});

test("repoRootFromServerScript 只接受生产 server 的入口", () => {
  const repo = path.join(os.tmpdir(), "qubius-repo");
  assert.equal(
    repoRootFromServerScript(path.join(repo, "server", "dist", "index.js")),
    path.resolve(repo),
  );
  // tsx 开发模式或无关进程不会被当成部署目标。
  assert.equal(repoRootFromServerScript(path.join(repo, "server", "src", "index.ts")), "");
  assert.equal(repoRootFromServerScript(""), "");
  // Windows 盘符大小写不敏感，POSIX 保持严格比较。
  assert.equal(samePath("C:\\Users\\A", "c:\\users\\a", "win32"), true);
  assert.equal(samePath(repo, repo, "linux"), true);
  assert.equal(samePath(repo, `${repo}-other`, "linux"), false);
});

test("stripAnsi 去掉 vite/npm 的颜色码", () => {
  assert.equal(
    stripAnsi("\u001b[36mvite\u001b[39m \u001b[32m✓ built\u001b[39m"),
    "vite ✓ built",
  );
  assert.equal(stripAnsi("plain"), "plain");
});

test("redactUrl 隐藏 URL 里的凭据", () => {
  assert.equal(
    redactUrl("clone http://user:pass@git.example.com/x.git"),
    "clone http://***@git.example.com/x.git",
  );
});
