import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claim,
  clear,
  cleanup,
  forceReclaim,
  normalizeOpsRoot,
  opsDaemonEnv,
  opsJobEnv,
  status,
  writeOpsMeta,
} from "./opslock.js";
import type { OpsLockResult } from "./types.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-ops-root-"));
}

function fakeProc(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-ops-proc-"));
}

function addProc(procRoot: string, pid: number, vars: Record<string, string>, dead = false): void {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  let buffer = Buffer.alloc(0);
  for (const [key, value] of Object.entries(vars)) {
    buffer = Buffer.concat([buffer, Buffer.from(`${key}=${value}\0`)]);
  }
  fs.writeFileSync(path.join(dir, "environ"), buffer);
  if (dead) fs.writeFileSync(path.join(dir, "dead"), "");
}

function withFake(procRoot: string): { env: NodeJS.ProcessEnv } {
  return { env: { OPS_LOCK_PROC_ROOT: procRoot } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("等待条件超时");
}

async function stop(child: ChildProcess): Promise<void> {
  // 已经退出（或者被别的进程杀掉、signalCode 已设置）时不能再等下一次 exit。
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

function spawnSleeper(env: Record<string, string>): ChildProcess {
  const child = spawn("sleep", ["30"], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  return child;
}

test("全新 root：claim 写 pending，status 可见", () => {
  const root = tempRoot();
  const result = claim({ root, kind: "deploy", jobId: "job-1", token: "tok-1" });
  assert.equal(result.ok, true);
  assert.equal(result.state, "pending");
  assert.equal(result.code, "ok");

  const info = status(root);
  assert.equal(info.ok, true);
  assert.equal(info.metaState, "pending");
  assert.equal(info.metaJobId, "job-1");
  assert.equal(info.lockFree, true);
  assert.deepEqual(info.remainingPids, []);
});

test("pending 宽限期内再次 claim 返回 busy", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "a", token: "ta" }).ok, true);
  const busy = claim({ root, kind: "deploy", jobId: "b", token: "tb" });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "busy");
  assert.equal(busy.exitCode, 3);
});

test("pending 超过宽限期可回收", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "a", token: "ta" }).ok, true);
  const again = claim({ root, kind: "deploy", jobId: "b", token: "tb", graceSeconds: 0 });
  assert.equal(again.ok, true);
  assert.equal(again.state, "pending");
});

test("meta 损坏时锁内自动初始化", () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "ops.meta"), "{not json");
  const result = claim({ root, kind: "deploy", jobId: "j", token: "t" });
  assert.equal(result.ok, true);
  const info = status(root);
  assert.equal(info.metaState, "pending");
});

test("status 短时缓存：命中期间不重新取，写操作后失效", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "t" }).ok, true);
  assert.equal(status(root, { cacheMs: 60_000 }).metaState, "pending");

  // 外部进程直接改 meta：缓存期内仍返回旧值（避免每次轮询都 spawn）。
  fs.writeFileSync(
    path.join(root, "ops.meta"),
    '{"version":1,"state":"running","kind":"deploy","jobId":"j","token":"t","pid":1,"root":"' +
      root +
      '","claimedAt":1,"updatedAt":1}\n',
  );
  assert.equal(status(root, { cacheMs: 60_000 }).metaState, "pending");

  // 经过本模块的写操作会让缓存失效，下一次 status 读到的就是 running。
  writeOpsMeta(root, { state: "running", kind: "deploy", jobId: "j", token: "t" });
  assert.equal(status(root, { cacheMs: 60_000 }).metaState, "running");
  writeOpsMeta(root, { state: "success", kind: "deploy", jobId: "j", token: "t" });
  assert.equal(status(root, { cacheMs: 60_000 }).metaState, "success");
});

test("meta 在 / lock 无：重建锁文件后可 claim", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "t" }).ok, true);
  fs.rmSync(path.join(root, "ops.lock"));
  const result = claim({ root, kind: "deploy", jobId: "j2", token: "t2", graceSeconds: 0 });
  assert.equal(result.ok, true);
});

test("running meta 但无残留：视为陈旧并可回收", () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, "ops.meta"),
    '{"version":1,"state":"running","kind":"deploy","jobId":"old","token":"old","pid":1,"root":"' +
      root +
      '","claimedAt":1,"updatedAt":1}\n',
  );
  const result = claim({ root, kind: "deploy", jobId: "new", token: "new" });
  assert.equal(result.ok, true);
});

test("存活残留阻塞 claim，并区分 residual / remainingPids", () => {
  const root = tempRoot();
  const proc = fakeProc();
  addProc(proc, 991001, { QUBIUS_OPS_ROOT: root, QUBIUS_OPS_TOKEN: "other", QUBIUS_OPS_JOB: "other-job" });
  const result = claim({ root, kind: "deploy", jobId: "j", token: "t", env: withFake(proc).env });
  assert.equal(result.ok, false);
  assert.equal(result.code, "residual");
  assert.equal(result.kind, "unknown"); // meta 缺失 -> unknown
  assert.deepEqual(result.remainingPids, [991001]);
  assert.equal(result.exitCode, 4);
});

test("residual 即使有 meta 也标 kind=unknown（残留不带任务 kind）", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "t" }).ok, true);
  const proc = fakeProc();
  addProc(proc, 991002, { QUBIUS_OPS_ROOT: root, QUBIUS_OPS_TOKEN: "x" });
  const result = claim({ root, kind: "deploy", jobId: "j2", token: "t2", env: withFake(proc).env });
  assert.equal(result.code, "residual");
  assert.equal(result.kind, "unknown");
});

test("daemon 只有 ROOT、没有 TOKEN/JOB 不算残留", () => {
  const root = tempRoot();
  const proc = fakeProc();
  addProc(proc, 991003, { QUBIUS_OPS_ROOT: root });
  const result = claim({ root, kind: "deploy", jobId: "j", token: "t", env: withFake(proc).env });
  assert.equal(result.ok, true);
});

test("QUBIUS_OPS_SERVER=1 的 server 进程被排除", () => {
  const root = tempRoot();
  const proc = fakeProc();
  addProc(proc, 991004, {
    QUBIUS_OPS_ROOT: root,
    QUBIUS_OPS_TOKEN: "t",
    QUBIUS_OPS_SERVER: "1",
  });
  const result = claim({ root, kind: "deploy", jobId: "j", token: "t", env: withFake(proc).env });
  assert.equal(result.ok, true);
});

test("ROOT symlink 与不同写法规范化后一致", () => {
  const real = tempRoot();
  const link = path.join(path.dirname(real), `link-${path.basename(real)}`);
  fs.symlinkSync(real, link);
  assert.equal(normalizeOpsRoot(link), real);
  const proc = fakeProc();
  addProc(proc, 991005, { QUBIUS_OPS_ROOT: real, QUBIUS_OPS_TOKEN: "x" });
  // 用 symlink 写法 claim，也必须识别 real ROOT 下的残留。
  const result = claim({ root: link, kind: "deploy", jobId: "j", token: "t", env: withFake(proc).env });
  assert.equal(result.code, "residual");
  assert.deepEqual(result.remainingPids, [991005]);
});

test("跨 configDir 双向并发不互相 409", () => {
  const rootA = tempRoot();
  const rootB = tempRoot();
  const a = claim({ root: rootA, kind: "deploy", jobId: "a", token: "ta" });
  const b = claim({ root: rootB, kind: "deploy", jobId: "b", token: "tb" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test("运行中改 configDir：旧残留只阻塞旧 ROOT", () => {
  const oldRoot = tempRoot();
  const newRoot = tempRoot();
  const proc = fakeProc();
  addProc(proc, 991006, { QUBIUS_OPS_ROOT: oldRoot, QUBIUS_OPS_TOKEN: "old" });
  const moved = claim({ root: newRoot, kind: "deploy", jobId: "new", token: "new", env: withFake(proc).env });
  assert.equal(moved.ok, true);
  const old = status(oldRoot, withFake(proc));
  assert.deepEqual(old.remainingPids, [991006]);
});

test("死 pid 不阻塞", () => {
  const root = tempRoot();
  const proc = fakeProc();
  addProc(proc, 991007, { QUBIUS_OPS_ROOT: root, QUBIUS_OPS_TOKEN: "x" }, true);
  const result = claim({ root, kind: "deploy", jobId: "j", token: "t", env: withFake(proc).env });
  assert.equal(result.ok, true);
});

test("clear：token 匹配清除，不匹配拒绝", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "right" }).ok, true);
  const wrong = clear(root, "wrong");
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "token-mismatch");
  assert.equal(wrong.exitCode, 5);
  const ok = clear(root, "right");
  assert.equal(ok.ok, true);
  assert.equal(status(root).metaState, "missing");
});

test("force-reclaim：短语必须是 RECLAIM，成功写 edge.json 审计", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "t" }).ok, true);
  const oldPhrase = forceReclaim(root, "force-reclaim");
  assert.equal(oldPhrase.ok, false);
  assert.equal(oldPhrase.code, "phrase-mismatch");
  assert.equal(oldPhrase.exitCode, 5);

  const ok = forceReclaim(root, "RECLAIM", { timeoutSeconds: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.forceReclaimed, true);
  assert.deepEqual(ok.remainingPids, []);
  assert.equal(status(root).metaState, "missing");

  const audit = JSON.parse(fs.readFileSync(path.join(root, "edge.json"), "utf8")) as {
    forceReclaims: Array<Record<string, unknown>>;
  };
  assert.equal(audit.forceReclaims.length, 1);
  const entry = audit.forceReclaims[0]!;
  assert.equal(entry.root, root);
  assert.equal(entry.token, "t");
  assert.equal(entry.jobId, "j");
  assert.deepEqual(entry.remainingPids, []);
  assert.equal(entry.phrase, "RECLAIM");
  assert.equal(typeof entry.at, "string");
});

test("force-reclaim：残留清理失败时 exit 4，不清 meta、不写审计", () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "t" }).ok, true);
  const proc = fakeProc();
  // token/job 与 meta 一致，但 fake 进程永远不会死。
  addProc(proc, 991008, { QUBIUS_OPS_ROOT: root, QUBIUS_OPS_TOKEN: "t", QUBIUS_OPS_JOB: "j" });
  const result = forceReclaim(root, "RECLAIM", { env: withFake(proc).env, timeoutSeconds: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "residual");
  assert.equal(result.exitCode, 4);
  assert.deepEqual(result.remainingPids, [991008]);
  assert.equal(result.forceReclaimed, undefined);
  assert.equal(status(root, withFake(proc)).metaState, "pending");
  assert.equal(fs.existsSync(path.join(root, "edge.json")), false);
});

test("force-reclaim：真实残留被清理后才成功", async () => {
  const root = tempRoot();
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "t" }).ok, true);
  const child = spawnSleeper({ QUBIUS_OPS_ROOT: root, QUBIUS_OPS_TOKEN: "t", QUBIUS_OPS_JOB: "j" });
  try {
    const result = forceReclaim(root, "RECLAIM", { timeoutSeconds: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.forceReclaimed, true);
    assert.ok((result.cleanedPids ?? []).includes(child.pid!));
    assert.deepEqual(result.remainingPids, []);
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 4000);
  } finally {
    await stop(child);
  }
});

test("活跃 job 持锁时 claim 返回 busy，remainingPids 含持有者", async () => {
  const root = tempRoot();
  // 先写一条 pending meta，模拟 job claim 后持锁运行。
  assert.equal(claim({ root, kind: "deploy", jobId: "j", token: "t" }).ok, true);
  const lock = path.join(root, "ops.lock");
  fs.mkdirSync(root, { recursive: true });
  const ready = path.join(root, "holder.ready");
  const holder = spawn(
    "bash",
    ["-c", 'exec 7<>"$0"; flock -n 7 || exit 9; : > "$1"; sleep 30', lock, ready],
    {
      env: {
        ...process.env,
        QUBIUS_OPS_ROOT: root,
        QUBIUS_OPS_TOKEN: "holder-token",
        QUBIUS_OPS_JOB: "holder-job",
      },
      stdio: "ignore",
    },
  );
  try {
    await waitFor(() => fs.existsSync(ready));
    const result = claim({ root, kind: "apply", jobId: "j2", token: "t2" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "busy");
    assert.equal(result.exitCode, 3);
    // busy 的 kind/jobId 来自 meta 里的持有者，而不是当前请求。
    assert.equal(result.kind, "deploy");
    assert.equal(result.jobId, "j");
    assert.ok((result.remainingPids ?? []).includes(holder.pid!));
    assert.equal(status(root).lockFree, false);
  } finally {
    await stop(holder);
  }
});

test("writeOpsMeta：running/success 原子写、保留 extras、不碰锁", () => {
  const root = tempRoot();
  const metaFile = path.join(root, "ops.meta");
  fs.writeFileSync(
    metaFile,
    JSON.stringify({
      version: 1,
      state: "pending",
      kind: "deploy",
      jobId: "old",
      token: "old",
      root,
      custom: "keep",
      claimedAt: 111,
    }) + "\n",
    { mode: 0o600 },
  );

  const running = writeOpsMeta(root, {
    state: "running",
    kind: "apply",
    jobId: "job-1",
    token: "tok",
    pid: process.pid,
    pgid: 4242,
  });
  assert.equal(running.ok, true);
  assert.equal(running.state, "running");
  assert.equal(running.startedAt, 111);
  const first = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  assert.equal(first.state, "running");
  assert.equal(first.kind, "apply");
  assert.equal(first.jobId, "job-1");
  assert.equal(first.token, "tok");
  assert.equal(first.custom, "keep");
  assert.equal(first.claimedAt, 111);
  assert.equal(first.startedAt, 111);
  assert.equal(first.finishedAt, undefined);
  assert.equal(first.pid, process.pid);
  assert.equal(first.pgid, 4242);
  assert.equal(first.root, normalizeOpsRoot(root));
  assert.equal(fs.statSync(metaFile).mode & 0o777, 0o600);
  // mark 不自取锁，也不创建锁文件（调用方负责持有）。
  assert.equal(fs.existsSync(path.join(root, "ops.lock")), false);
  assert.equal(status(root).metaState, "running");

  const done = writeOpsMeta(root, { state: "success", kind: "apply", jobId: "job-1", token: "tok" });
  assert.equal(done.ok, true);
  assert.equal(done.state, "success");
  assert.equal(typeof done.finishedAt, "number");
  const second = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  assert.equal(second.state, "success");
  assert.equal(second.startedAt, 111);
  assert.equal(typeof second.finishedAt, "number");
  assert.equal(second.token, "tok");
  assert.equal(second.custom, "keep");
  assert.equal(status(root).metaState, "success");

  const bad = writeOpsMeta(root, { state: "bogus" as never, kind: "x", jobId: "j", token: "t" });
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 2);
});

test("opsJobEnv 删除继承的 SERVER 标记，job 子进程仍会被扫描清理", async () => {
  const root = tempRoot();
  const env = opsJobEnv(root, "job-token", "job-1", {
    ...process.env,
    QUBIUS_OPS_SERVER: "1",
    QUBIUS_OPS_ROOT: "/stale/root",
    QUBIUS_OPS_TOKEN: "stale-token",
  });
  assert.equal(env.QUBIUS_OPS_SERVER, undefined);
  assert.equal(env.QUBIUS_OPS_ROOT, normalizeOpsRoot(root));
  assert.equal(env.QUBIUS_OPS_TOKEN, "job-token");
  assert.equal(env.QUBIUS_OPS_JOB, "job-1");

  const child = spawn("sleep", ["30"], { env, stdio: "ignore" });
  try {
    const result = cleanup(root, { token: "job-token", timeoutSeconds: 1 });
    assert.equal(result.ok, true);
    assert.ok((result.cleanedPids ?? []).includes(child.pid!));
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 4000);
  } finally {
    await stop(child);
  }
});

test("opsDaemonEnv 不保留继承的 SERVER，除非显式设置", () => {
  const cleaned = opsDaemonEnv({
    QUBIUS_OPS_SERVER: "1",
    QUBIUS_OPS_TOKEN: "x",
    QUBIUS_OPS_JOB: "y",
    QUBIUS_OPS_ROOT: "/z",
  });
  assert.equal(cleaned.QUBIUS_OPS_SERVER, undefined);
  assert.equal(cleaned.QUBIUS_OPS_TOKEN, undefined);
  assert.equal(cleaned.QUBIUS_OPS_JOB, undefined);
  assert.equal(cleaned.QUBIUS_OPS_ROOT, undefined);

  const explicit = opsDaemonEnv({ QUBIUS_OPS_SERVER: "1", QUBIUS_OPS_TOKEN: "x" }, { server: true });
  assert.equal(explicit.QUBIUS_OPS_SERVER, "1");
  assert.equal(explicit.QUBIUS_OPS_TOKEN, undefined);
});

test("cleanup：TERM/KILL 真实标记进程，不动无 token 的 daemon", async () => {
  const root = tempRoot();
  const daemon = spawnSleeper({ QUBIUS_OPS_ROOT: root });
  let marked: ChildProcess | undefined;
  try {
    // daemon 只有 ROOT：claim 不应被它阻塞。
    const claimed = claim({ root, kind: "deploy", jobId: "j", token: "job-token" });
    assert.equal(claimed.ok, true);
    assert.equal(daemon.exitCode, null);

    // claim 之后再拉起带标记的 job 进程，避免它先被当成残留阻塞 claim。
    const markedProc = spawnSleeper({
      QUBIUS_OPS_ROOT: root,
      QUBIUS_OPS_TOKEN: "job-token",
      QUBIUS_OPS_JOB: "job-1",
    });
    marked = markedProc;
    const result = cleanup(root, { token: "job-token", timeoutSeconds: 1 });
    assert.equal(result.ok, true);
    assert.ok((result.cleanedPids ?? []).includes(markedProc.pid!));
    assert.equal(result.remainingPids?.includes(markedProc.pid!), false);

    await waitFor(() => markedProc.exitCode !== null || markedProc.signalCode !== null, 4000);
    // daemon 仍在运行（没有 token，不会被 cleanup 选中）。
    assert.equal(daemon.exitCode, null);
  } finally {
    if (marked) await stop(marked);
    await stop(daemon);
  }
});

test("cleanup 支持按 job-id 过滤", async () => {
  const root = tempRoot();
  const keep = spawnSleeper({ QUBIUS_OPS_ROOT: root, QUBIUS_OPS_TOKEN: "x", QUBIUS_OPS_JOB: "keep" });
  const drop = spawnSleeper({ QUBIUS_OPS_ROOT: root, QUBIUS_OPS_TOKEN: "x", QUBIUS_OPS_JOB: "drop" });
  try {
    await waitFor(() => keep.pid !== undefined && drop.pid !== undefined);
    const result = cleanup(root, { jobIds: ["drop"], timeoutSeconds: 1 });
    assert.equal(result.ok, true);
    assert.ok((result.cleanedPids ?? []).includes(drop.pid!));
    assert.equal((result.cleanedPids ?? []).includes(keep.pid!), false);
    await waitFor(() => drop.exitCode !== null || drop.signalCode !== null, 4000);
    assert.equal(keep.exitCode, null);
  } finally {
    await stop(keep);
    await stop(drop);
  }
});
