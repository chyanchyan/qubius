import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AppConfig } from "./config.js";
import { computePrimaryComparison, readSecondaryStatus } from "./secondary.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", message);
}

function sandbox(t: TestContext): { root: string; primary: string; secondary: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-secondary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  const secondary = path.join(root, "secondary");
  makeRepo(primary);
  commit(primary, { "src/a.ts": "one\n" }, "初始提交");
  execFileSync("git", ["clone", "-q", primary, secondary], { env: GIT_ENV });
  return { root, primary, secondary };
}

test("两边的 HEAD 相同时报告已是最新", (t) => {
  const { primary, secondary } = sandbox(t);
  const result = computePrimaryComparison(primary, "main", secondary);
  assert.equal(result.relation, "up-to-date");
  assert.equal(result.behind, 0);
  assert.equal(result.ref, "main");
  assert.equal(result.subject, "初始提交");
  assert.equal(result.head?.length, 8);
});

test("主实例有新提交时统计领先数量和改动规模", (t) => {
  const { primary, secondary } = sandbox(t);
  commit(primary, { "src/a.ts": "one\ntwo\n" }, "第二次提交");
  commit(primary, { "package-lock.json": "{}\n" }, "第三次提交");

  const result = computePrimaryComparison(primary, "main", secondary);
  assert.equal(result.relation, "behind");
  assert.equal(result.behind, 2);
  assert.equal(result.subject, "第三次提交");
  assert.equal(result.depsChanged, true);
  assert.equal(result.files, 2);
  assert.equal(result.insertions, 2);
  assert.equal(result.deletions, 0);
  assert.equal(result.dirty, false);
  assert.deepEqual(result.commits?.map((commit) => commit.subject), ["第三次提交", "第二次提交"]);
  assert.ok(result.committedAt);
});

test("主实例有未提交改动时标记 dirty，但不影响领先数量", (t) => {
  const { primary, secondary } = sandbox(t);
  commit(primary, { "src/a.ts": "one\ntwo\n" }, "第二次提交");
  fs.writeFileSync(path.join(primary, "src/a.ts"), "one\ntwo\n未提交\n");

  const result = computePrimaryComparison(primary, "main", secondary);
  assert.equal(result.relation, "behind");
  assert.equal(result.behind, 1);
  assert.equal(result.dirty, true);
});

test("状态接口带上分支、工作区、运行版本和回滚目标标题", (t) => {
  const { root, primary, secondary } = sandbox(t);
  const base = git(secondary, "rev-parse", "HEAD");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "secondary.json"),
    JSON.stringify({ state: "success", action: "sync", previousHead: base, message: "已经是最新" }),
  );
  const config = {
    role: "secondary",
    dataDir,
    secondary: { primaryRepo: primary, primaryRef: "main", script: "", restart: "" },
  } as unknown as AppConfig;

  const status = readSecondaryStatus(config, secondary, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(status?.branch, "main");
  assert.equal(status?.dirty, false);
  assert.equal(status?.runningHead, "01234567");
  assert.equal(status?.previousSubject, "初始提交");
  assert.equal(status?.primary?.relation, "up-to-date");
});

test("副实例不在 main 或有未跟踪文件时能提前发现", (t) => {
  const { root, primary, secondary } = sandbox(t);
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config = {
    role: "secondary",
    dataDir,
    secondary: { primaryRepo: primary, primaryRef: "main", script: "", restart: "" },
  } as unknown as AppConfig;

  git(secondary, "checkout", "-q", "-b", "dev");
  // secondary.sh 用 `git status --porcelain` 判断工作区，未跟踪文件也算脏。
  fs.writeFileSync(path.join(secondary, "untracked.txt"), "x\n");

  const status = readSecondaryStatus(config, secondary);
  assert.equal(status?.branch, "dev");
  assert.equal(status?.dirty, true);
});

test("两边都有独立提交时报告分叉和各自数量", (t) => {
  const { primary, secondary } = sandbox(t);
  commit(primary, { "src/primary.ts": "p\n" }, "主实例提交");
  commit(secondary, { "src/secondary.ts": "s\n" }, "副实例提交");
  // 让副实例拿到主实例的提交对象，但不动自己的 HEAD。
  git(secondary, "fetch", "-q", primary, "main");

  const result = computePrimaryComparison(primary, "main", secondary);
  assert.equal(result.relation, "diverged");
  assert.equal(result.behind, 1);
  assert.equal(result.ahead, 1);
});

test("主实例仓库或分支不存在时给出原因而不是抛错", (t) => {
  const { root, primary, secondary } = sandbox(t);

  const missingRepo = computePrimaryComparison(path.join(root, "nope"), "main", secondary);
  assert.equal(missingRepo.relation, "unknown");
  assert.match(missingRepo.reason ?? "", /找不到主实例仓库/);

  const missingRef = computePrimaryComparison(primary, "release", secondary);
  assert.equal(missingRef.relation, "unknown");
  assert.match(missingRef.reason ?? "", /没有分支 release/);
});
