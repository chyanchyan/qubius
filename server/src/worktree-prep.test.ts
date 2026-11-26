import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectConfig, WorktreeConfig } from "./config.js";
import {
  normalizeRelativeWorktreePath,
  normalizeWorktreeConfig,
  prepareWorktree,
} from "./worktree-prep.js";

// 测试不依赖本机 git 全局配置；prepareWorktree 内部的 git 查询继承 process.env。
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qubius-worktree-prep-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  return dir;
}

function commitAll(dir: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

function makeWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qubius-worktree-"));
}

function project(repo: string, worktree?: Partial<WorktreeConfig>): ProjectConfig {
  const config: WorktreeConfig = {
    setupTimeoutSeconds: 30,
    sharedDirectories: [],
    include: [],
    ...worktree,
  };
  return {
    id: "app",
    name: "App",
    path: repo,
    permission: "acceptEdits",
    isolated: false,
    worktree: config,
  };
}

test("include 复制 gitignored 文件和目录，并自动创建目标父目录", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\nsecrets/\nconfig/local.yaml\n");
  fs.writeFileSync(path.join(repo, "README.md"), "readme\n");
  fs.writeFileSync(path.join(repo, ".env"), "TOKEN=1\n");
  fs.mkdirSync(path.join(repo, "secrets", "nested"), { recursive: true });
  fs.writeFileSync(path.join(repo, "secrets", "nested", "key.txt"), "key\n");
  fs.mkdirSync(path.join(repo, "config"));
  fs.writeFileSync(path.join(repo, "config", "local.yaml"), "local: true\n");
  commitAll(repo);

  const worktree = makeWorktree();
  const result = await prepareWorktree({
    project: project(repo, { include: [".env", "secrets", "config/local.yaml"] }),
    worktreePath: worktree,
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(fs.readFileSync(path.join(worktree, ".env"), "utf8"), "TOKEN=1\n");
  assert.equal(fs.readFileSync(path.join(worktree, "secrets", "nested", "key.txt"), "utf8"), "key\n");
  assert.equal(fs.readFileSync(path.join(worktree, "config", "local.yaml"), "utf8"), "local: true\n");
});

test("tracked 文件跳过并产生 warning", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
  fs.writeFileSync(path.join(repo, "app.log"), "tracked log\n");
  git(repo, "add", "-f", "app.log");
  commitAll(repo);

  const worktree = makeWorktree();
  const result = await prepareWorktree({
    project: project(repo, { include: ["app.log"] }),
    worktreePath: worktree,
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /app\.log/);
  assert.match(result.warnings[0] ?? "", /已被 git 跟踪/);
  assert.equal(fs.existsSync(path.join(worktree, "app.log")), false);
});

test(".worktreeinclude 忽略空行和注释，跳过不存在、逃逸和未忽略的路径", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(repo, ".env"), "TOKEN=2\n");
  commitAll(repo);
  // 提交之后再创建，保持未跟踪且没有被忽略。
  fs.writeFileSync(path.join(repo, "plain.txt"), "plain\n");
  fs.writeFileSync(
    path.join(repo, ".worktreeinclude"),
    ["# 说明注释", "", "  .env  ", "missing.txt", "../escape", "plain.txt", ""].join("\n"),
  );

  const worktree = makeWorktree();
  const result = await prepareWorktree({ project: project(repo), worktreePath: worktree });

  assert.equal(fs.readFileSync(path.join(worktree, ".env"), "utf8"), "TOKEN=2\n");
  assert.equal(result.warnings.some((warning) => warning.includes("说明注释")), false);
  assert.equal(result.warnings.some((warning) => warning.includes("missing.txt")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("../escape")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("plain.txt") && warning.includes("gitignore")), true);
  assert.equal(fs.existsSync(path.join(worktree, "plain.txt")), false);
});

test("sharedDirectories 为 gitignored 目录建立符号链接，目标已存在时跳过", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.cache/\n");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  commitAll(repo);

  const worktree = makeWorktree();
  const result = await prepareWorktree({
    project: project(repo, { sharedDirectories: ["node_modules"] }),
    worktreePath: worktree,
  });

  assert.deepEqual(result.warnings, []);
  const link = path.join(worktree, "node_modules");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(
    fs.readFileSync(path.join(link, "pkg", "index.js"), "utf8"),
    "module.exports = 1;\n",
  );
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(repo, "node_modules")));

  const occupied = makeWorktree();
  fs.mkdirSync(path.join(occupied, "node_modules"));
  const skipped = await prepareWorktree({
    project: project(repo, { sharedDirectories: ["node_modules"] }),
    worktreePath: occupied,
  });
  assert.equal(skipped.warnings.length, 1);
  assert.match(skipped.warnings[0] ?? "", /worktree 目标已存在/);
  assert.equal(fs.lstatSync(path.join(occupied, "node_modules")).isSymbolicLink(), false);
});

test("sharedDirectories 要求源目录存在、是目录且被 gitignore", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored-dir/\n");
  fs.mkdirSync(path.join(repo, "ignored-dir"));
  fs.mkdirSync(path.join(repo, "not-ignored"));
  fs.writeFileSync(path.join(repo, "file.txt"), "file\n");
  commitAll(repo);

  const worktree = makeWorktree();
  const result = await prepareWorktree({
    project: project(repo, { sharedDirectories: ["missing", "file.txt", "not-ignored"] }),
    worktreePath: worktree,
  });

  assert.equal(result.warnings.length, 3);
  assert.equal(result.warnings.some((warning) => warning.includes("源目录不存在")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("不是目录")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("没有被 .gitignore 忽略")), true);
  assert.equal(fs.existsSync(path.join(worktree, "not-ignored")), false);
});

test("setup 在 worktree 中执行；失败时错误包含命令、退出码和输出尾部", async () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "readme\n");
  commitAll(repo);

  const worktree = makeWorktree();
  const success = await prepareWorktree({
    project: project(repo, {
      setup: "node -e \"require('fs').writeFileSync('setup-ran.txt','ok')\"",
      setupTimeoutSeconds: 30,
    }),
    worktreePath: worktree,
  });
  assert.deepEqual(success.warnings, []);
  assert.equal(fs.readFileSync(path.join(worktree, "setup-ran.txt"), "utf8"), "ok");

  const failing = makeWorktree();
  await assert.rejects(
    prepareWorktree({
      project: project(repo, {
        setup: "node -e \"console.error('boom'); process.exit(3)\"",
        setupTimeoutSeconds: 30,
      }),
      worktreePath: failing,
    }),
    (error: Error) => {
      assert.match(error.message, /worktree setup 命令失败/);
      assert.match(error.message, /node -e/);
      assert.match(error.message, /退出码 3/);
      assert.match(error.message, /boom/);
      return true;
    },
  );
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGone(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`进程 ${pid} 在超时后仍在运行`);
}

test("setup 超时会结束整棵进程树，不留下孙进程", { skip: process.platform === "win32" ? "POSIX 进程组断言" : false }, async () => {
  const repo = initRepo();
  const worktree = makeWorktree();
  // setup 脚本再派生一个长睡眠孙进程，把两个 pid 写进 worktree。
  // 只杀 shell / 直接子进程时，孙进程会继续存活。
  fs.writeFileSync(
    path.join(worktree, "spawn-child.js"),
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
      'fs.writeFileSync("setup.pids.json", JSON.stringify({ parent: process.pid, child: child.pid }));',
      "setTimeout(() => {}, 60000);",
      "",
    ].join("\n"),
  );
  let pids: { parent: number; child: number } | undefined;
  try {
    const started = Date.now();
    await assert.rejects(
      prepareWorktree({
        project: project(repo, { setup: "node spawn-child.js", setupTimeoutSeconds: 1 }),
        worktreePath: worktree,
      }),
      /超时（1 秒）/,
    );
    assert.ok(Date.now() - started < 5_000, "超时应在 1 秒左右结束");
    pids = JSON.parse(fs.readFileSync(path.join(worktree, "setup.pids.json"), "utf8")) as {
      parent: number;
      child: number;
    };
    // 孙进程和 setup 的直接子进程都必须在 reject 前/后真正退出。
    await waitForProcessGone(pids.child);
    await waitForProcessGone(pids.parent);
  } finally {
    for (const pid of pids ? [pids.parent, pids.child] : []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }
  }
});

test(".worktreeinclude 是目录时降级为 warning", async () => {
  const repo = initRepo();
  fs.mkdirSync(path.join(repo, ".worktreeinclude"));
  const worktree = makeWorktree();
  const result = await prepareWorktree({ project: project(repo), worktreePath: worktree });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /目录/);
});

test("worktree 配置校验和相对路径规范化", () => {
  assert.equal(normalizeRelativeWorktreePath(".env", "x"), ".env");
  assert.equal(normalizeRelativeWorktreePath("./config/local.yaml", "x"), "config/local.yaml");
  assert.equal(normalizeRelativeWorktreePath("config\\local.yaml", "x"), "config/local.yaml");
  for (const invalid of ["/etc/passwd", "../.env", "a/../../b", "C:\\env", "C:env", "\\\\server\\share", "", "."]) {
    assert.throws(() => normalizeRelativeWorktreePath(invalid, "x"), /x/);
  }

  assert.deepEqual(normalizeWorktreeConfig(undefined, "w"), undefined);
  assert.deepEqual(normalizeWorktreeConfig({}, "w"), {
    setup: undefined,
    setupTimeoutSeconds: 300,
    sharedDirectories: [],
    include: [],
  });
  assert.throws(() => normalizeWorktreeConfig([], "w"), /w 必须是映射/);
  assert.throws(() => normalizeWorktreeConfig({ setup: "" }, "w"), /w\.setup 不能为空/);
  assert.throws(() => normalizeWorktreeConfig({ setupTimeoutSeconds: 3601 }, "w"), /w\.setupTimeoutSeconds/);
  assert.throws(() => normalizeWorktreeConfig({ include: ["/abs"] }, "w"), /w\.include\[0\] 必须是仓库内的相对路径/);
});
