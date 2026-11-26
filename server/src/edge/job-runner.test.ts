import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultSpawnJob,
  edgeRequestFile,
  readEdgeRequest,
  validateEdgeRequest,
  verifyRequestOwnership,
  writeEdgeRequest,
  type EdgeJobRequest,
} from "./job-runner.js";
import { readEdgeJob, writeEdgeJob } from "./state.js";
import { main as edgeJobMain } from "../edge-job.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-job-runner-"));
}

const REQUEST: EdgeJobRequest = {
  version: 1,
  kind: "apply",
  jobId: "job-1",
  token: "token-1",
  createdAt: "2026-01-02T03:04:05.000Z",
  confirmDomain: "code.example.com",
  planHash: "hash-1",
};

test("edge-request.json 原子写 0600，可读回", () => {
  const dir = tmp();
  writeEdgeRequest(dir, REQUEST);
  const file = edgeRequestFile(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readEdgeRequest(dir), REQUEST);
  // 重复写覆盖旧内容。
  writeEdgeRequest(dir, { ...REQUEST, confirmExisting: true });
  assert.equal(readEdgeRequest(dir)?.confirmExisting, true);
});

test("readEdgeRequest：损坏/非法返回 null", () => {
  const dir = tmp();
  fs.writeFileSync(edgeRequestFile(dir), "{broken");
  assert.equal(readEdgeRequest(dir), null);
  fs.writeFileSync(
    edgeRequestFile(dir),
    JSON.stringify({ ...REQUEST, jobId: "../escape" }),
  );
  assert.equal(readEdgeRequest(dir), null);
  fs.writeFileSync(edgeRequestFile(dir), JSON.stringify({ ...REQUEST, kind: "nope" }));
  assert.equal(readEdgeRequest(dir), null);
});

test("validateEdgeRequest：restore 必须带 backup/remoteSha", () => {
  const restore = validateEdgeRequest({
    ...REQUEST,
    kind: "restore",
    planHash: undefined,
    backup: "edge-backup-1.Caddyfile",
    remoteSha: "abc",
  });
  assert.ok(restore);
  assert.equal(restore!.kind, "restore");
  assert.equal(validateEdgeRequest({ ...REQUEST, kind: "restore" }), null);
});

test("validateEdgeRequest：reclaim 不要求 token", () => {
  const reclaim = validateEdgeRequest({
    version: 1,
    kind: "reclaim",
    jobId: "job-r",
    createdAt: "2026-01-02T00:00:00.000Z",
    reclaimJobId: "old-job",
  });
  assert.ok(reclaim);
  assert.equal(reclaim!.kind, "reclaim");
  assert.equal(reclaim!.reclaimJobId, "old-job");
  assert.equal(
    validateEdgeRequest({
      version: 1,
      kind: "reclaim",
      jobId: "job-r",
      createdAt: "t",
      reclaimJobId: "../bad",
    }),
    null,
  );
});

test("spawn error：写 edge.json failed", async () => {
  const dir = tmp();
  defaultSpawnJob({
    command: "/nonexistent-qubius-binary",
    args: [],
    cwd: dir,
    logFile: path.join(dir, "edge.log"),
    env: {
      QUBIUS_EDGE_CONFIG_DIR: dir,
      QUBIUS_EDGE_JOB_ID: "spawn-fail",
      QUBIUS_EDGE_KIND: "apply",
    },
  });
  const start = Date.now();
  for (;;) {
    const job = readEdgeJob(dir);
    if (job?.state === "failed") {
      assert.match(job.message, /启动失败/);
      assert.equal(job.jobId, "spawn-fail");
      // 与 job-state.ts 的秒精度契约一致（不能带毫秒）。
      assert.match(job.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(job.finishedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      break;
    }
    if (Date.now() - start > 3000) throw new Error("等待 spawn error 写状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("verifyRequestOwnership：jobId/kind 不匹配时拒绝执行", () => {
  const env = { QUBIUS_EDGE_JOB_ID: REQUEST.jobId, QUBIUS_EDGE_KIND: REQUEST.kind };
  assert.deepEqual(verifyRequestOwnership(REQUEST, env), { ok: true });
  const wrongJob = verifyRequestOwnership({ ...REQUEST, jobId: "job-b" }, env);
  assert.equal(wrongJob.ok, false);
  assert.match(wrongJob.ok === false ? wrongJob.message : "", /jobId/);
  const wrongKind = verifyRequestOwnership({ ...REQUEST, kind: "restore" }, env);
  assert.equal(wrongKind.ok, false);
  assert.match(wrongKind.ok === false ? wrongKind.message : "", /类型/);
});

test("edge-job.sh：node 启动失败时写 edge.json failed", () => {
  const dir = tmp();
  const root = path.resolve(import.meta.dirname, "../../..");
  const proc = spawnSync("bash", [path.join(root, "deploy", "edge-job.sh")], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      QUBIUS_OPS_ROOT: dir,
      QUBIUS_OPS_TOKEN: "tok",
      QUBIUS_OPS_JOB: "job-shell",
      QUBIUS_EDGE_CONFIG_DIR: dir,
      QUBIUS_EDGE_REPO_ROOT: root,
      QUBIUS_EDGE_KIND: "apply",
      QUBIUS_NODE_BIN: "/nonexistent-qubius-node",
    },
  });
  assert.notEqual(proc.status, 0, proc.stderr);
  const job = readEdgeJob(dir);
  assert.equal(job?.state, "failed");
  assert.equal(job?.jobId, "job-shell");
});

test("edge-job.sh：保留 node 已写入的详细终态（不覆盖为通用 failed）", () => {
  const dir = tmp();
  const root = path.resolve(import.meta.dirname, "../../..");
  writeEdgeJob(dir, {
    jobId: "job-shell",
    state: "failed",
    kind: "apply",
    step: "validate",
    message: "edgectl validate 失败的详细信息",
    pid: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
  });
  const proc = spawnSync("bash", [path.join(root, "deploy", "edge-job.sh")], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      QUBIUS_OPS_ROOT: dir,
      QUBIUS_OPS_TOKEN: "tok",
      QUBIUS_OPS_JOB: "job-shell",
      QUBIUS_EDGE_CONFIG_DIR: dir,
      QUBIUS_EDGE_REPO_ROOT: root,
      QUBIUS_EDGE_KIND: "apply",
      QUBIUS_NODE_BIN: "/nonexistent-qubius-node",
    },
  });
  assert.notEqual(proc.status, 0, proc.stderr);
  assert.equal(
    readEdgeJob(dir)?.message,
    "edgectl validate 失败的详细信息",
  );
});

test("edge-job 入口：request 被其他作业覆盖时拒绝执行（不跑 plan）", async () => {
  const dir = tmp();
  writeEdgeRequest(dir, { ...REQUEST, jobId: "job-from-apply" });
  // 模拟 reclaim 抢跑了共享的 edge-request.json：入口的 env jobId 不一致。
  const code = await edgeJobMain({
    HOME: dir,
    PATH: process.env.PATH ?? "",
    QUBIUS_CONFIG_DIR: dir,
    QUBIUS_EDGE_CONFIG_DIR: dir,
    QUBIUS_EDGE_JOB_ID: "job-from-reclaim",
    QUBIUS_EDGE_KIND: "reclaim",
  });
  assert.equal(code, 2);
  // 没有执行 apply（不会写 edge.json 作业）。
  assert.equal(readEdgeJob(dir), null);
});

test("deploy-job.sh：缺少 ops 标记时拒绝启动；锁被占用时 exit 3", () => {
  const dir = tmp();
  const root = path.resolve(import.meta.dirname, "../../..");
  const script = path.join(root, "deploy", "deploy-job.sh");
  const missing = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, QUBIUS_DEPLOY_STATUS: path.join(dir, "s.json"), QUBIUS_DEPLOY_LOG: path.join(dir, "l.log") },
  });
  assert.notEqual(missing.status, 0);

  const wrapper = [
    'exec 7<>"$OPS_ROOT/ops.lock"',
    "flock -n 7",
    'bash "$SCRIPT"',
    'echo "RC:$?"',
  ].join("\n");
  const busy = spawnSync("bash", ["-c", wrapper], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      SCRIPT: script,
      OPS_ROOT: dir,
      QUBIUS_DEPLOY_STATUS: path.join(dir, "s.json"),
      QUBIUS_DEPLOY_LOG: path.join(dir, "l.log"),
      QUBIUS_OPS_ROOT: dir,
      QUBIUS_OPS_TOKEN: "t",
      QUBIUS_OPS_JOB: "j",
      QUBIUS_DEPLOY_JOB_ID: "j",
      QUBIUS_DEPLOY_REPO_ROOT: root,
    },
  });
  assert.match(busy.stdout, /RC:3/);
});

test("edge-job.sh：request jobId 不匹配时拒绝执行并写 failed 终态", () => {
  const dir = tmp();
  const root = path.resolve(import.meta.dirname, "../../..");
  writeEdgeRequest(dir, { ...REQUEST, jobId: "job-from-apply" });
  const proc = spawnSync("bash", [path.join(root, "deploy", "edge-job.sh")], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      QUBIUS_OPS_ROOT: dir,
      QUBIUS_OPS_TOKEN: "tok",
      QUBIUS_OPS_JOB: "job-from-reclaim",
      QUBIUS_EDGE_CONFIG_DIR: dir,
      QUBIUS_EDGE_REPO_ROOT: root,
      QUBIUS_EDGE_JOB_ID: "job-from-reclaim",
      QUBIUS_EDGE_KIND: "reclaim",
    },
  });
  assert.notEqual(proc.status, 0, proc.stderr);
  assert.equal(readEdgeJob(dir)?.state, "failed");
  // 不属于自己的请求不能被删除。
  assert.ok(readEdgeRequest(dir));
});

test("deploy 脚本通过 bash -n", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  for (const name of ["deploy/deploy-job.sh", "deploy/edge-job.sh"]) {
    const file = path.join(root, name);
    const proc = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(proc.status, 0, `${name}: ${proc.stderr}`);
  }
});
