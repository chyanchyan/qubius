import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitAndPush,
  createWorktree,
  dirtySessionBranches,
  gitStatus,
  isGitRepo,
  mergedSessionBranches,
  redactGitCredentials,
  removeWorktree,
} from "./worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function setupRepo(): { base: string; remote: string; work: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-git-"));
  const remote = path.join(base, "remote.git");
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  execFileSync("git", ["init", "--bare", remote], { encoding: "utf8" });
  execFileSync("git", ["init", "-b", "main", work], { encoding: "utf8" });
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(work, "a.txt"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "init");
  git(work, "remote", "add", "origin", remote);
  return { base, remote, work };
}

test("mergedSessionBranches 只报告已合入 main 的会话分支", async () => {
  const { base, work } = setupRepo();
  try {
    const pendingBranch = `remote-coder/${randomUUID()}`;
    const mergedBranch = `qubius/${randomUUID()}`;

    git(work, "checkout", "-q", "-b", pendingBranch, "main");
    fs.writeFileSync(path.join(work, "pending.txt"), "pending\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "pending");

    git(work, "checkout", "-q", "-b", mergedBranch, "main");
    fs.writeFileSync(path.join(work, "merged.txt"), "merged\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "merged");
    git(work, "checkout", "-q", "main");
    git(work, "merge", "-q", "--ff-only", mergedBranch);

    const status = await mergedSessionBranches(work);
    assert.equal(status.base, "main");
    assert.deepEqual(status.merged, [mergedBranch]);
    // 两个分支都提交过代码，不算「从未改动」。
    assert.deepEqual(status.untouched, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("mergedSessionBranches 没有 main 时退回 master，非仓库返回 null", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-git-merge-"));
  const work = path.join(base, "work");
  const plain = path.join(base, "plain");
  fs.mkdirSync(work);
  fs.mkdirSync(plain);
  try {
    execFileSync("git", ["init", "-q", "-b", "master", work], { encoding: "utf8" });
    git(work, "config", "user.name", "Test");
    git(work, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(work, "a.txt"), "a\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "init");
    const branch = `qubius/${randomUUID()}`;
    git(work, "checkout", "-q", "-b", branch);

    const status = await mergedSessionBranches(work);
    assert.equal(status.base, "master");
    assert.deepEqual(status.merged, [branch]);
    // 分支创建后没有提交：已合入但从未改动，界面按蓝灯显示并参与全部归档。
    assert.deepEqual(status.untouched, [branch]);

    assert.deepEqual(await mergedSessionBranches(plain), { base: null, merged: [], untouched: [] });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("dirtySessionBranches 报告有未提交改动的会话分支", async () => {
  const { base, work } = setupRepo();
  try {
    const branch = `qubius/${randomUUID()}`;
    git(work, "checkout", "-q", "-b", branch);
    assert.deepEqual(await dirtySessionBranches([{ branch, cwd: work }]), []);

    fs.writeFileSync(path.join(work, "a.txt"), "changed\n");
    assert.deepEqual(await dirtySessionBranches([{ branch, cwd: work }]), [branch]);

    // 未跟踪文件也算改动。
    git(work, "checkout", "--", "a.txt");
    fs.writeFileSync(path.join(work, "new.txt"), "new\n");
    assert.deepEqual(await dirtySessionBranches([{ branch, cwd: work }]), [branch]);

    // 目录已经不存在时按没有改动处理，不影响其它会话。
    assert.deepEqual(
      await dirtySessionBranches([
        { branch: `qubius/${randomUUID()}`, cwd: path.join(base, "missing") },
        { branch, cwd: work },
      ]),
      [branch],
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function remoteBranchSha(remote: string, branch: string): string {  return execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${branch}`], {
    encoding: "utf8",
  }).trim();
}

test("commitAndPush 提交并推送 qubius 会话分支", async () => {
  const { base, remote, work } = setupRepo();
  try {
    const branch = `qubius/${randomUUID()}`;
    git(work, "checkout", "-b", branch);
    fs.writeFileSync(path.join(work, "a.txt"), "two\n");

    const result = await commitAndPush(work, { message: "update a", push: true });

    assert.equal(result.branch, branch);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.match(result.output, /update a/);
    assert.match(remoteBranchSha(remote, branch), /^[0-9a-f]{40}$/);

    const status = await gitStatus(work);
    assert.equal(status.branch, branch);
    assert.equal(status.clean, true);
    assert.deepEqual(status.dirty, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("gitStatus 列出改动文件，文件名里的 -> 原样保留", async () => {
  const { base, work } = setupRepo();
  try {
    git(work, "checkout", "-b", `qubius/${randomUUID()}`);
    fs.writeFileSync(path.join(work, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(work, "new file.txt"), "new\n");
    fs.writeFileSync(path.join(work, "arrow -> name.txt"), "arrow\n");

    const status = await gitStatus(work);

    assert.equal(status.clean, false);
    assert.deepEqual(status.dirty.sort(), ["a.txt", "arrow -> name.txt", "new file.txt"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("unborn branch 也能读取当前分支", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rc-git-"));
  try {
    const work = path.join(base, "work");
    fs.mkdirSync(work);
    execFileSync("git", ["init", "-b", "main", work], { encoding: "utf8" });
    git(work, "config", "user.name", "Test");
    git(work, "config", "user.email", "test@example.com");
    const branch = `qubius/${randomUUID()}`;
    git(work, "checkout", "-b", branch);

    const status = await gitStatus(work);

    assert.equal(status.branch, branch);
    assert.equal(status.clean, true);
    assert.deepEqual(status.dirty, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("isGitRepo 在 TTL 内复用探测结果，不重复 spawn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-git-cache-"));
  let calls = 0;
  let now = 1_000;
  const probe = async () => {
    calls += 1;
    return true;
  };
  try {
    assert.equal(await isGitRepo(dir, { probe, now: () => now }), true);
    assert.equal(await isGitRepo(dir, { probe, now: () => now }), true);
    assert.equal(calls, 1, "TTL 内应复用缓存，不再 spawn");

    now += 31_000;
    assert.equal(await isGitRepo(dir, { probe, now: () => now }), true);
    assert.equal(calls, 2, "TTL 过期后应重新探测");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("目录在 TTL 内消失时 isGitRepo 立即失效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-git-cache-gone-"));
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return true;
  };
  const now = () => 5_000;
  try {
    assert.equal(await isGitRepo(dir, { probe, now }), true);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(await isGitRepo(dir, { probe, now }), false);
    assert.equal(calls, 1, "路径消失不应再 spawn git");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("凭证脱敏", () => {
  assert.equal(
    redactGitCredentials("fatal: unable to access 'https://user:secret@example.com/r.git/'"),
    "fatal: unable to access 'https://***@example.com/r.git/'",
  );
  assert.equal(
    redactGitCredentials("https://x-access-token:ghp_abc123@github.com/x.git"),
    "https://***@github.com/x.git",
  );
  assert.equal(
    redactGitCredentials("x-access-token:ghp_abc123"),
    "x-access-token:***",
  );
});

test("非会话分支被拒绝", async () => {
  const { base, work } = setupRepo();
  try {
    fs.writeFileSync(path.join(work, "a.txt"), "changed\n");
    await assert.rejects(
      commitAndPush(work, { message: "main change", push: false }),
      /只允许操作会话分支/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("旧的 remote-coder/ 与 qoder/ 分支仍可提交推送", async () => {
  for (const prefix of ["remote-coder/", "qoder/"]) {
    const { base, remote, work } = setupRepo();
    try {
      const branch = `${prefix}${randomUUID()}`;
      git(work, "checkout", "-b", branch);
      fs.writeFileSync(path.join(work, "a.txt"), "legacy\n");

      const result = await commitAndPush(work, { message: "legacy commit", push: true });

      assert.equal(result.branch, branch);
      assert.equal(result.committed, true);
      assert.equal(result.pushed, true);
      assert.match(remoteBranchSha(remote, branch), /^[0-9a-f]{40}$/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test("没有改动时要求提交会报错", async () => {
  const { base, work } = setupRepo();
  try {
    git(work, "checkout", "-b", `qubius/${randomUUID()}`);
    await assert.rejects(
      commitAndPush(work, { message: "nothing", push: false }),
      /没有可提交的改动/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("只推送时允许没有改动", async () => {
  const { base, remote, work } = setupRepo();
  try {
    const branch = `qubius/${randomUUID()}`;
    git(work, "checkout", "-b", branch);
    fs.writeFileSync(path.join(work, "a.txt"), "pushed\n");
    await commitAndPush(work, { message: "first", push: true });

    const result = await commitAndPush(work, { message: "", push: true });

    assert.equal(result.branch, branch);
    assert.equal(result.committed, false);
    assert.equal(result.pushed, true);
    assert.match(remoteBranchSha(remote, branch), /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("提交成功但推送失败时提示已提交", async () => {
  const { base, work } = setupRepo();
  try {
    git(work, "checkout", "-b", `qubius/${randomUUID()}`);
    git(work, "remote", "set-url", "origin", path.join(base, "missing.git"));
    fs.writeFileSync(path.join(work, "a.txt"), "changed\n");

    await assert.rejects(
      commitAndPush(work, { message: "will commit", push: true }),
      /已提交但推送失败/,
    );
    assert.equal(git(work, "log", "-1", "--format=%s"), "will commit");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("没有 origin 时推送被拒绝", async () => {
  const { base, work } = setupRepo();
  try {
    git(work, "checkout", "-b", `qubius/${randomUUID()}`);
    git(work, "remote", "remove", "origin");
    await assert.rejects(
      commitAndPush(work, { message: "", push: true }),
      /这个仓库没有 origin 远端/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("createWorktree 只接受会话分支作为 startPoint，无效时回退 HEAD", async () => {
  const { base, work } = setupRepo();
  const dataDir = path.join(base, "data");
  try {
    const startId = randomUUID();
    const startBranch = `qubius/${startId}`;
    git(work, "checkout", "-q", "-b", startBranch, "main");
    fs.writeFileSync(path.join(work, "start.txt"), "from start point\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "start point");
    const startTip = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "main");
    const headTip = git(work, "rev-parse", "HEAD");
    assert.notEqual(startTip, headTip);

    const validId = randomUUID();
    const valid = await createWorktree({
      projectPath: work,
      projectId: "p1",
      sessionId: validId,
      dataDir,
      startPoint: startBranch,
    });
    try {
      assert.equal(git(valid.cwd, "rev-parse", "HEAD"), startTip);
      assert.ok(fs.existsSync(path.join(valid.cwd, "start.txt")));
    } finally {
      await removeWorktree(work, valid.cwd, valid.branch);
    }

    // 非会话分支：即使能解析成 commit 也回退 HEAD。
    const nonSessionId = randomUUID();
    const nonSession = await createWorktree({
      projectPath: work,
      projectId: "p1",
      sessionId: nonSessionId,
      dataDir,
      startPoint: "main",
    });
    try {
      assert.equal(git(nonSession.cwd, "rev-parse", "HEAD"), headTip);
    } finally {
      await removeWorktree(work, nonSession.cwd, nonSession.branch);
    }

    // 会话前缀但不存在：同样回退 HEAD。
    const missingId = randomUUID();
    const missing = await createWorktree({
      projectPath: work,
      projectId: "p1",
      sessionId: missingId,
      dataDir,
      startPoint: `qubius/${randomUUID()}`,
    });
    try {
      assert.equal(git(missing.cwd, "rev-parse", "HEAD"), headTip);
    } finally {
      await removeWorktree(work, missing.cwd, missing.branch);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("worktree 注册项丢失但目录还在时仍能删除并清理分支", async () => {
  const { base, work } = setupRepo();
  const dataDir = path.join(base, "data");
  try {
    const id = randomUUID();
    const created = await createWorktree({
      projectPath: work,
      projectId: "p1",
      sessionId: id,
      dataDir,
    });
    // 复现 Windows 上「git 先删注册项、再删目录失败」留下的状态：
    // 注册项没了、目录还在，再调 git 只会得到 is not a working tree（exit 128）。
    fs.rmSync(path.join(work, ".git", "worktrees", path.basename(created.cwd)), {
      recursive: true,
      force: true,
    });
    fs.writeFileSync(path.join(created.cwd, "leftover.txt"), "still here\n");
    assert.throws(() => git(work, "worktree", "remove", "--force", created.cwd));

    await removeWorktree(work, created.cwd, created.branch, { sessionId: id });
    assert.equal(fs.existsSync(created.cwd), false);
    assert.equal(git(work, "branch", "--list", created.branch), "");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("非会话 worktree 路径删除失败时不会递归误删目录", async () => {
  const { base, work } = setupRepo();
  try {
    const victim = path.join(base, "victim");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "keep.txt"), "keep");
    await assert.rejects(removeWorktree(work, victim));
    assert.ok(fs.existsSync(path.join(victim, "keep.txt")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
