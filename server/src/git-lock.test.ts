import assert from "node:assert/strict";
import test from "node:test";
import { GitActionBusyError, isGitActionActive, withGitAction } from "./git-lock.js";

test("同一会话的 git 操作互斥，忙碌时抛 GitActionBusyError", async () => {
  let release!: () => void;
  const first = withGitAction("lock-busy", () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  try {
    assert.equal(isGitActionActive("lock-busy"), true);
    await assert.rejects(
      withGitAction("lock-busy", async () => "second"),
      GitActionBusyError,
    );
    assert.equal(isGitActionActive("lock-busy"), true);
  } finally {
    release();
    await first;
  }
  assert.equal(isGitActionActive("lock-busy"), false);
});

test("不同会话的 git 操作互不影响", async () => {
  let releaseA!: () => void;
  const a = withGitAction("lock-a", () => new Promise<void>((resolve) => {
    releaseA = resolve;
  }));
  try {
    const value = await withGitAction("lock-b", async () => "b");
    assert.equal(value, "b");
  } finally {
    releaseA();
    await a;
  }
});

test("fn 抛错时仍然释放锁，可以再次加锁", async () => {
  await assert.rejects(
    withGitAction("lock-throw", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(isGitActionActive("lock-throw"), false);
  const value = await withGitAction("lock-throw", async () => 42);
  assert.equal(value, 42);
  assert.equal(isGitActionActive("lock-throw"), false);
});

test("正常完成后释放锁", async () => {
  assert.equal(await withGitAction("lock-ok", async () => "done"), "done");
  assert.equal(isGitActionActive("lock-ok"), false);
});
