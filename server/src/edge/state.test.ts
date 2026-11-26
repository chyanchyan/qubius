import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendEdgeLog, epochSecondsToIso, readEdgeLogTail } from "./state.js";
import {
  edgeLogFile,
  edgeStateFile,
  opsMetaTimes,
  readEdgeJob,
  readEdgeJobWithLog,
  readEdgeState,
  updateEdgeState,
  writeEdgeJob,
  writeEdgeState,
  type EdgeJob,
} from "./state.js";
import type { EdgeSecrets } from "./types.js";

const HASH = "$2a$14$FakeSaltValue123456789FakeHashValue1234567890ABCDEFGH";
const COOKIE = "fedcba9876543210fedcba9876543210";
const SECRETS: EdgeSecrets = {
  passwordHash: HASH,
  cookieSecret: COOKIE,
  secretsSha: "x",
  passwordHashSource: "envfile",
  cookieSecretSource: "envfile",
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-state-"));
}

function job(overrides: Partial<EdgeJob> = {}): EdgeJob {
  return {
    jobId: "job-1",
    state: "running",
    kind: "apply",
    step: "validate",
    message: "执行中",
    pid: 1234,
    startedAt: "2026-01-02T03:04:05.000Z",
    finishedAt: null,
    ...overrides,
  };
}

test("edge.json 0600 原子写，读回同一作业", () => {
  const dir = tempDir();
  writeEdgeJob(dir, job());
  const file = edgeStateFile(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readEdgeJob(dir), job());
});

test("writeEdgeJob 脱敏 message/step/logTail", () => {
  const dir = tempDir();
  writeEdgeJob(
    dir,
    job({
      step: `step ${COOKIE}`,
      message: `failed https://user:pw@host ${HASH}`,
      logTail: `tail ${COOKIE}`,
    }),
    SECRETS,
  );
  const stored = readEdgeJob(dir);
  assert.ok(stored);
  assert.ok(!stored!.message.includes(HASH));
  assert.ok(!stored!.message.includes("user:pw"));
  assert.ok(!stored!.step.includes(COOKIE));
  assert.ok(!stored!.logTail!.includes(COOKIE));
  assert.ok(stored!.message.includes("<redacted>"));
});

test("读改写保留 forceReclaims 等其它顶层键", () => {
  const dir = tempDir();
  writeEdgeState(dir, { forceReclaims: [{ root: "/x", at: "t" }], provider: "cli" });
  writeEdgeJob(dir, job({ state: "success", finishedAt: "2026-01-02T03:05:00.000Z" }));
  const state = readEdgeState(dir);
  assert.ok(state);
  assert.deepEqual(state!.forceReclaims, [{ root: "/x", at: "t" }]);
  assert.equal(state!.provider, "cli");
  assert.equal((state!.job as EdgeJob).state, "success");

  updateEdgeState(dir, (value) => {
    value.extra = "kept";
    return value;
  });
  assert.equal(readEdgeState(dir)!.extra, "kept");
  assert.deepEqual(readEdgeState(dir)!.forceReclaims, [{ root: "/x", at: "t" }]);
});

test("损坏的 edge.json 返回 null 而不是抛异常", () => {
  const dir = tempDir();
  fs.writeFileSync(edgeStateFile(dir), "{broken");
  assert.equal(readEdgeState(dir), null);
  assert.equal(readEdgeJob(dir), null);
  fs.writeFileSync(edgeStateFile(dir), JSON.stringify({ job: { jobId: 1 } }));
  assert.equal(readEdgeJob(dir), null);
});

test("兼容扁平（无 job 包装）的 edge.json", () => {
  const dir = tempDir();
  writeEdgeState(dir, { ...job(), jobId: "flat" });
  assert.equal(readEdgeJob(dir)?.jobId, "flat");
});

test("edge.log 追加时脱敏，tail 默认截取末尾并按行限制", () => {
  const dir = tempDir();
  appendEdgeLog(dir, `first ${COOKIE} https://user:pw@host/x\n`, SECRETS);
  for (let i = 0; i < 100; i += 1) appendEdgeLog(dir, `line-${i}\n`, SECRETS);

  assert.equal(fs.statSync(edgeLogFile(dir)).mode & 0o777, 0o600);
  const tail = readEdgeLogTail(dir, { lines: 5 });
  assert.ok(tail);
  assert.ok(!tail!.includes(COOKIE));
  assert.ok(!tail!.includes("user:pw"));
  const lines = tail!.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[4], "line-99");
});

test("readEdgeJobWithLog 附带脱敏日志尾", () => {
  const dir = tempDir();
  writeEdgeJob(dir, job());
  appendEdgeLog(dir, `boot ${COOKIE}\n`, SECRETS);
  const result = readEdgeJobWithLog(dir);
  assert.ok(result);
  assert.ok(result!.logTail);
  assert.ok(!result!.logTail!.includes(COOKIE));
});

test("epoch 秒转换为 ISO", () => {
  assert.equal(epochSecondsToIso(1_700_000_000), new Date(1_700_000_000_000).toISOString());
  assert.equal(epochSecondsToIso(null), null);
  assert.equal(epochSecondsToIso(undefined), null);
  assert.equal(epochSecondsToIso(Number.NaN), null);
  assert.deepEqual(opsMetaTimes({ startedAt: 1_700_000_000, finishedAt: null }), {
    startedAt: new Date(1_700_000_000_000).toISOString(),
    finishedAt: null,
  });
});
