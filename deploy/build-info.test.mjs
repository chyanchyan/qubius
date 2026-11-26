// deploy/build-info.mjs：`npm run build` 必须刷新 server/dist/build.json，
// 否则 quickstart 重建后页面仍显示上一次部署的版本号。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildInfo, writeBuildInfo } from "./build-info.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function git(repo, args) {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-C", repo, ...args],
    { encoding: "utf8" },
  );
}

/** 建一个带 .gitignore 和一次提交的最小仓库，构建输入是干净的。 */
function fixture(t, { version = "1.2.3", commit = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-build-info-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "fake", version })}\n`);
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "server/dist/\n");
  if (!commit) return repo;
  git(repo, ["init", "-q"]);
  git(repo, ["add", ".gitignore", "package.json", "package-lock.json"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

test("写入版本号、HEAD、时间和 dirty，并且是原子写入", (t) => {
  const repo = fixture(t);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();

  const { info, target } = writeBuildInfo(repo, new Date("2026-01-02T03:04:05Z"));
  const written = JSON.parse(fs.readFileSync(target, "utf8"));

  assert.equal(written.version, "1.2.3");
  assert.equal(written.head, head);
  assert.equal(written.builtAt, "2026-01-02T03:04:05.000Z");
  assert.equal(written.dirty, false);
  assert.deepEqual(written, info);
  // 不留临时文件。
  assert.deepEqual(fs.readdirSync(path.join(repo, "server", "dist")), ["build.json"]);
});

test("已有的旧 build.json 会被覆盖：升级后版本号随之变化", (t) => {
  const repo = fixture(t);
  const target = path.join(repo, "server", "dist", "build.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"version":"0.9.9","head":"old"}\n');

  writeBuildInfo(repo);

  const written = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(written.version, "1.2.3");
  assert.notEqual(written.head, "old");
});

test("源码有未提交改动时标记 dirty", (t) => {
  const repo = fixture(t);
  fs.mkdirSync(path.join(repo, "server", "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "server", "src", "new.ts"), "export {};\n");

  assert.equal(buildInfo(repo).dirty, true);
});

test("不是 git 仓库时 head 为空、dirty 为 false", (t) => {
  const repo = fixture(t, { commit: false });

  const info = buildInfo(repo);
  assert.equal(info.head, "");
  assert.equal(info.dirty, false);
  assert.equal(info.version, "1.2.3");
});

test("package.json 缺失或版本非法时退回 0.0.0", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-build-info-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  assert.equal(buildInfo(repo).version, "0.0.0");

  fs.writeFileSync(path.join(repo, "package.json"), '{"version":"1.0.0 beta"}\n');
  assert.equal(buildInfo(repo).version, "0.0.0");
});

test("根目录 npm run build 会刷新 build.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  assert.match(pkg.scripts.build, /node deploy\/build-info\.mjs/);
});

test("命令行入口写入当前目录的 server/dist/build.json", (t) => {
  const repo = fixture(t);
  const script = path.join(here, "build-info.mjs");

  const result = spawnSync(process.execPath, [script, repo], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /version=1\.2\.3/);
  const written = JSON.parse(
    fs.readFileSync(path.join(repo, "server", "dist", "build.json"), "utf8"),
  );
  assert.equal(written.version, "1.2.3");
  assert.equal(written.dirty, false);
});
