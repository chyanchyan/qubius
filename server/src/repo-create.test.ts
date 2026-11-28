import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGitRepo, projectIdFromName, RepoCreateError, resolveNewRepoPath } from "./repo-create.js";

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rc-repo-create-"));
}

const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 临时设置/恢复指定环境变量；同一文件里的测试默认串行执行。 */
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

test("projectIdFromName 把名称压成合法 id，推不出时返回 null", () => {
  assert.equal(projectIdFromName("Demo Repo"), "demo-repo");
  assert.equal(projectIdFromName("  --My_Repo-- "), "my-repo");
  assert.equal(projectIdFromName("Café"), "cafe");
  assert.equal(projectIdFromName("我的仓库"), null);
  const long = projectIdFromName("a".repeat(80));
  assert.ok(long && long.length <= 63 && /^[a-z0-9][a-z0-9-]{0,62}$/.test(long));
});

test("resolveNewRepoPath 校验名称、母目录和目标目录", () => {
  const base = tempBase();
  assert.equal(resolveNewRepoPath(base, " demo "), path.join(base, "demo"));

  for (const name of ["", "  ", ".", "..", "a/b", "a\\b", "a\u0000b"]) {
    assert.throws(() => resolveNewRepoPath(base, name), RepoCreateError);
  }

  assert.throws(
    () => resolveNewRepoPath(path.join(base, "missing"), "demo"),
    /母目录不存在/,
  );

  fs.mkdirSync(path.join(base, "demo"));
  assert.throws(() => resolveNewRepoPath(base, "demo"), /目录已存在/);

  const file = path.join(base, "plain.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => resolveNewRepoPath(file, "demo"), /母目录不存在/);

  fs.writeFileSync(path.join(base, "taken"), "x");
  assert.throws(() => resolveNewRepoPath(base, "taken"), /目录已存在/);
});

test("createGitRepo 创建 main 分支的 git 仓库并提交初始版本，可直接建 worktree", async () => {
  const base = tempBase();
  const target = path.join(base, "demo");
  await withEnv(IDENTITY, () => createGitRepo(target));

  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.equal(git(target, "rev-parse", "--is-inside-work-tree"), "true");
  assert.equal(git(target, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(target, "log", "--oneline").split("\n").length, 1);

  // 新仓库必须能建会话 worktree，否则项目加进来也不能用。
  const worktree = path.join(base, "worktree");
  git(target, "worktree", "add", "-b", "qubius/demo-session", worktree, "HEAD");
  assert.equal(fs.statSync(worktree).isDirectory(), true);
});

test("createGitRepo 可递归创建缺失的上级目录", async () => {
  const base = tempBase();
  const target = path.join(base, "a", "b", "demo");
  await withEnv(IDENTITY, () => createGitRepo(target, { createParents: true }));
  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.equal(git(target, "rev-parse", "--is-inside-work-tree"), "true");
  assert.equal(git(target, "log", "--oneline").split("\n").length, 1);
});

test("createGitRepo 在初始化提交失败时删掉刚建的目录", async () => {
  const base = tempBase();
  const target = path.join(base, "broken");
  const isolated = {
    ...IDENTITY,
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    GIT_CONFIG_GLOBAL: path.join(base, "no-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await assert.rejects(
    withEnv(isolated, () => createGitRepo(target)),
    (error: unknown) => error instanceof RepoCreateError && /创建 git 仓库失败/.test(error.message),
  );
  assert.equal(fs.existsSync(target), false);
});

test("createGitRepo 递归创建后初始化失败时连新建的上级空目录一起清理", async () => {
  const base = tempBase();
  const target = path.join(base, "a", "b", "broken");
  const isolated = {
    ...IDENTITY,
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    GIT_CONFIG_GLOBAL: path.join(base, "no-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  await assert.rejects(
    withEnv(isolated, () => createGitRepo(target, { createParents: true })),
    (error: unknown) => error instanceof RepoCreateError && /创建 git 仓库失败/.test(error.message),
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(base, "a")), false);
  // 原有目录不能被回收。
  assert.equal(fs.statSync(base).isDirectory(), true);
});

test("createGitRepo 目标已存在但不是目录时返回明确错误", async () => {
  const base = tempBase();
  const target = path.join(base, "plain.txt");
  fs.writeFileSync(target, "x");
  await assert.rejects(
    () => createGitRepo(target, { createParents: true }),
    (error: unknown) => error instanceof RepoCreateError
      && error.status === 409
      && /路径已存在但不是目录/.test(error.message),
  );
  assert.equal(fs.readFileSync(target, "utf8"), "x");
});
