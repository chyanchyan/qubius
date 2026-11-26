import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EdgeActionError,
  applyEdge,
  cleanupEdgeBackups,
  readEdgeJobForApi,
  reclaimEdge,
  redactApiText,
  restoreEdge,
  runEdgeJob,
  type EdgeActionDeps,
  type EdgeOpsFns,
} from "./actions.js";
import { sha256Hex } from "./canonical.js";
import type { CommandRunner, CommandSpec } from "./cli.js";
import { desiredSites } from "./desired.js";
import type { EdgeJobRequest } from "./job-runner.js";
import {
  computePlanHash,
  edgeEnvSnapshot,
  edgePlanFile,
  writePlan,
  type StoredEdgePlan,
} from "./plan.js";
import { NATIVE_RENDER_VERSION } from "./provider.js";
import { parseRegistryText, upsertManagedSites } from "./registry.js";
import type { NativeApplyResult } from "./native-apply.js";
import type { RemoteResult } from "./remote.js";
import { renderVpsBlock, spliceManaged } from "./render.js";
import { loadEdgeSecrets } from "./secrets.js";
import {
  edgeLogFile,
  edgeStateFile,
  isoNow,
  readEdgeJob,
  readEdgeState,
  writeEdgeJob,
  type EdgeJob,
} from "./state.js";
import type { EdgePaths, EdgeRole, EdgeSecrets, OpsLockResult } from "./types.js";
import { deriveDeployForm } from "../deploy.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "registry");

interface Fixture {
  base: string;
  configDir: string;
  registryPath: string;
  env: NodeJS.ProcessEnv;
  paths: EdgePaths;
  plan: StoredEdgePlan;
  secrets: EdgeSecrets;
  oldRaw: string;
  expected: string;
  oldSha: string;
  expectedSha: string;
}

function remoteResult(overrides: Partial<RemoteResult> = {}): RemoteResult {
  return {
    ok: true,
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    argv: [],
    ...overrides,
  };
}

function setup(options: { provider?: "cli" | "native" } = {}): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "edge-actions-"));
  const configDir = path.join(base, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const registryPath = path.join(configDir, "edgectl.yaml");
  fs.copyFileSync(path.join(FIXTURE_DIR, "edgectl.yaml"), registryPath);
  fs.copyFileSync(path.join(FIXTURE_DIR, ".env"), path.join(configDir, ".env"));
  const BIN = path.join(base, "edgectl");
  fs.writeFileSync(BIN, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(BIN, 0o755);

  const env: NodeJS.ProcessEnv = {
    HOME: base,
    QUBIUS_CONFIG_DIR: configDir,
    QUBIUS_PUBLIC_HOST: "code.example.com",
    QUBIUS_PRIMARY_PORT: "8787",
    QUBIUS_SECONDARY_PORT: "8788",
    QUBIUS_START_PRIMARY: "1",
    QUBIUS_START_SECONDARY: "0",
    QUBIUS_EDGECTL_CONFIG: registryPath,
    QUBIUS_EDGE_PROVIDER: "cli",
    QUBIUS_EDGECTL_BIN: BIN,
    PATH: process.env.PATH ?? "",
  };
  const paths: EdgePaths = {
    provider: "cli",
    resolvedProvider: "cli",
    configPath: registryPath,
    configSource: "envfile-qubius",
    binPath: BIN,
    binSource: "env",
    disabled: false,
    errors: [],
  };

  const registryText = fs.readFileSync(registryPath, "utf8");
  const registry = parseRegistryText(registryText, registryPath);
  const secrets = loadEdgeSecrets({ registry, env });
  const form = deriveDeployForm(env, "primary").form;
  const desired = desiredSites(form, "primary").sites;
  const candidateText = upsertManagedSites(registryPath, desired, { write: false }).text;
  const candidateRegistry = parseRegistryText(candidateText, registryPath);
  const oldRaw = renderVpsBlock(registry, secrets);
  const expected = spliceManaged(oldRaw, renderVpsBlock(candidateRegistry, secrets));
  const createdAt = "2026-01-02T03:04:05.000Z";
  const planId = "plan-1";
  const envSnapshot = edgeEnvSnapshot(env, "primary");
  const edgectl = { bin: BIN, version: "0.1.0", source: "env" };
  const provider = options.provider ?? "cli";
  const hashFields = {
    provider,
    registryPath,
    registrySha: sha256Hex(registryText),
    candidateSha: sha256Hex(candidateText),
    desired,
    remoteRawSha: sha256Hex(oldRaw),
    expectedRemoteSha: sha256Hex(expected),
    dryRunStdoutSha: null,
    caddyVersion: null,
    envSnapshot,
    edgectl,
    nativeRenderVersion: NATIVE_RENDER_VERSION,
    secretsSha: secrets.secretsSha,
    createdAt,
    planId,
  };
  const plan: StoredEdgePlan = {
    planId,
    planHash: computePlanHash(hashFields),
    createdAt,
    role: "primary",
    provider,
    registryPath,
    registrySha: hashFields.registrySha,
    candidateSha: hashFields.candidateSha,
    candidateBytes: candidateText,
    desired,
    disabledRoles: [],
    remoteRawSha: hashFields.remoteRawSha,
    expectedRemoteSha: hashFields.expectedRemoteSha,
    expectedRemoteContent: expected,
    dryRunStdoutSha: null,
    caddyVersion: null,
    registryDiff: "注册表无变化\n",
    remoteDiff: "远端有变化\n",
    warnings: [],
    errors: [],
    blocking: [],
    requiresConfirmExisting: false,
    envSnapshot,
    edgectl,
    nativeRenderVersion: NATIVE_RENDER_VERSION,
    secretsSha: secrets.secretsSha,
    appliable: true,
  };
  writePlan(configDir, plan, secrets);

  return {
    base,
    configDir,
    registryPath,
    env,
    paths,
    plan,
    secrets,
    oldRaw,
    expected,
    oldSha: sha256Hex(oldRaw),
    expectedSha: sha256Hex(expected),
  };
}

interface FakeRemoteOptions {
  /** 每次 readRemoteFile 的返回值（内容），按调用顺序；不足时重复最后一个。 */
  reads: string[];
  validateCandidate?: boolean;
  live?: boolean;
  reload?: boolean;
  /** 按调用顺序覆盖 reload/live 结果（用于重试测试）。 */
  reloadResults?: boolean[];
  liveResults?: boolean[];
  write?: boolean;
}

function fakeRemote(options: FakeRemoteOptions) {
  const calls = {
    reads: 0,
    validateCandidate: 0,
    live: 0,
    reload: 0,
    writes: [] as string[],
  };
  let index = 0;
  const read = (): { content: string; sha: string; result: ReturnType<typeof remoteResult> } => {
    const content = options.reads[Math.min(index, options.reads.length - 1)] ?? "";
    index += 1;
    calls.reads += 1;
    return { content, sha: sha256Hex(content), result: remoteResult() };
  };
  return {
    calls,
    fns: {
      readRemoteFile: () => read(),
      caddyVersion: () => ({ version: null, result: remoteResult() }),
      caddyValidateCandidate: () => {
        calls.validateCandidate += 1;
        return {
          result: remoteResult(
            options.validateCandidate === false
              ? { ok: false, code: 1, stderr: "bad config" }
              : {},
          ),
          candidate: "/tmp/x",
          candidateDir: "/tmp",
          fallback: false,
        };
      },
      caddyValidateLive: () => {
        const index = calls.live;
        calls.live += 1;
        const ok = options.liveResults?.[index] ?? options.live !== false;
        return remoteResult(ok ? {} : { ok: false, code: 1, stderr: "live bad" });
      },
      caddyReload: () => {
        const index = calls.reload;
        calls.reload += 1;
        const ok = options.reloadResults?.[index] ?? options.reload !== false;
        return remoteResult(ok ? {} : { ok: false, code: 1, stderr: "reload bad" });
      },
      writeRemoteFileInPlace: (_registry: unknown, content: string) => {
        calls.writes.push(content);
        return remoteResult(
          options.write === false ? { ok: false, code: 1, stderr: "write bad" } : {},
        );
      },
    },
  };
}

function baseDeps(
  fixture: Fixture,
  options: {
    runner?: CommandRunner;
    remote?: ReturnType<typeof fakeRemote>["fns"];
    nativeApplyFn?: EdgeActionDeps["nativeApplyFn"];
    reloadOnlyFn?: EdgeActionDeps["reloadOnlyFn"];
  } = {},
): EdgeActionDeps {
  return {
    repoRoot: fixture.base,
    env: fixture.env,
    configDir: fixture.configDir,
    paths: fixture.paths,
    runner: options.runner ?? cliRunner(),
    remote: options.remote,
    nativeApplyFn: options.nativeApplyFn,
    reloadOnlyFn: options.reloadOnlyFn,
  };
}

function cliRunner(
  overrides: { validate?: boolean; apply?: boolean } = {},
): CommandRunner & { calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  const runner: CommandRunner & { calls: CommandSpec[] } = Object.assign(
    (spec: CommandSpec) => {
      calls.push(spec);
      if (spec.args.includes("--version")) {
        return { status: 0, stdout: "edgectl 0.1.0\n", stderr: "", signal: null };
      }
      if (spec.args[0] === "validate") {
        return overrides.validate === false
          ? { status: 1, stdout: "", stderr: "invalid", signal: null }
          : { status: 0, stdout: "ok\n", stderr: "", signal: null };
      }
      if (spec.args[0] === "apply-vps") {
        return overrides.apply === false
          ? { status: 1, stdout: "", stderr: "apply failed", signal: null }
          : { status: 0, stdout: "applied\n", stderr: "", signal: null };
      }
      return { status: 0, stdout: "", stderr: "", signal: null };
    },
    { calls },
  );
  return runner;
}

function requestFor(fixture: Fixture): EdgeJobRequest {
  return {
    version: 1,
    kind: "apply",
    jobId: "job-1",
    token: "tok-1",
    createdAt: isoNow(),
    confirmDomain: "code.example.com",
    planHash: fixture.plan.planHash,
  };
}

test("apply 成功：写注册表、远端校验/应用、清理 plan/request/备份", async () => {
  const fixture = setup();
  const remote = fakeRemote({ reads: [fixture.oldRaw, fixture.oldRaw, fixture.expected] });
  const runner = cliRunner();
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner, remote: remote.fns }),
  );
  assert.equal(job.state, "success");
  assertSecondPrecision(job.startedAt);
  assertSecondPrecision(job.finishedAt);
  assert.match(job.message, /已应用/);
  assert.equal(remote.calls.reads, 3);
  assert.ok(runner.calls.some((spec) => spec.args[0] === "apply-vps"));
  assert.equal(remote.calls.validateCandidate, 1);
  // 注册表写入了期望域名。
  assert.match(fs.readFileSync(fixture.registryPath, "utf8"), /code\.example\.com/);
  assert.equal(fs.existsSync(edgePlanFile(fixture.configDir)), false);
  assert.equal(fs.existsSync(path.join(fixture.configDir, "edge-request.json")), false);
  assert.equal(
    fs.existsSync(path.join(fixture.configDir, "edge-backup-job-1.Caddyfile")),
    false,
  );
  assert.equal(readEdgeJob(fixture.configDir)?.state, "success");
  // edge.json 顶层记录 provider / planHash（保留其它键）。
  const state = readEdgeState(fixture.configDir);
  assert.equal(state?.provider, "cli");
  assert.equal(state?.planHash, fixture.plan.planHash);
});

test("apply 失败且远端仍为 old：failed，不覆盖", async () => {
  const fixture = setup();
  const remote = fakeRemote({ reads: [fixture.oldRaw, fixture.oldRaw, fixture.oldRaw] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner: cliRunner({ apply: false }), remote: remote.fns }),
  );
  assert.equal(job.state, "failed");
  assert.match(job.message, /远端未发生变化|保持原状/);
  assert.equal(
    fs.existsSync(path.join(fixture.configDir, "edge-unknown-job-1.Caddyfile")),
    false,
  );
  // 失败保留 request/plan 供人工重试。
  assert.equal(fs.existsSync(edgePlanFile(fixture.configDir)), true);
});

test("apply 失败但远端已是 expected：validate+reload 一次后成功", async () => {
  const fixture = setup();
  const remote = fakeRemote({
    reads: [fixture.oldRaw, fixture.oldRaw, fixture.expected],
  });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner: cliRunner({ apply: false }), remote: remote.fns }),
  );
  assert.equal(job.state, "success");
  assert.match(job.message, /激活/);
  assert.equal(remote.calls.live, 1);
  assert.equal(remote.calls.reload, 1);
});

test("apply 预检已是 expected：跳过 apply-vps，validate+reload", async () => {
  const fixture = setup();
  const remote = fakeRemote({ reads: [fixture.expected] });
  const runner = cliRunner();
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner, remote: remote.fns }),
  );
  assert.equal(job.state, "success");
  assert.match(job.message, /已是目标内容/);
  assert.equal(remote.calls.reload, 1);
  assert.equal(runner.calls.some((spec) => spec.args[0] === "apply-vps"), false);
});

test("初始 expected、期间回退为 old：切换回 write 并执行 apply-vps", async () => {
  const fixture = setup();
  const remote = fakeRemote({
    reads: [fixture.expected, fixture.oldRaw, fixture.expected],
  });
  const runner = cliRunner();
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner, remote: remote.fns }),
  );
  assert.equal(job.state, "success");
  assertSecondPrecision(job.startedAt);
  assertSecondPrecision(job.finishedAt);
  assert.match(job.message, /已应用/);
  assert.equal(
    runner.calls.filter((spec) => spec.args[0] === "apply-vps").length,
    1,
  );
  assert.equal(remote.calls.reads, 3);
});

test("already 分支：reload 失败后重试一次成功", async () => {
  const fixture = setup();
  const remote = fakeRemote({
    reads: [fixture.expected],
    reloadResults: [false, true],
  });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { remote: remote.fns }),
  );
  assert.equal(job.state, "success");
  assert.equal(remote.calls.live, 2);
  assert.equal(remote.calls.reload, 2);
});

test("written-not-active：reload 失败后重试一次成功", async () => {
  const fixture = setup();
  const remote = fakeRemote({
    reads: [fixture.oldRaw, fixture.oldRaw, fixture.expected],
    reloadResults: [false, true],
  });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner: cliRunner({ apply: false }), remote: remote.fns }),
  );
  assert.equal(job.state, "success");
  assert.match(job.message, /激活/);
  assert.equal(remote.calls.reload, 2);
});

test("validate/自检期间远端被改：不覆盖、保存 unknown、失败", async () => {
  const fixture = setup();
  const changed = "# changed during self-check\n";
  // 第一次（初始）old；第二次（apply 前紧邻复核）已被外部改成 unknown。
  const remote = fakeRemote({ reads: [fixture.oldRaw, changed] });
  const runner = cliRunner();
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner, remote: remote.fns }),
  );
  assert.equal(job.state, "failed");
  assert.equal(runner.calls.some((spec) => spec.args[0] === "apply-vps"), false);
  const file = path.join(fixture.configDir, "edge-unknown-job-1.Caddyfile");
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, "utf8"), changed);
  // 远端未被覆盖，本地注册表回滚到计划原文。
  assert.equal(remote.calls.writes.length, 0);
  assert.equal(fs.readFileSync(fixture.registryPath, "utf8"), fs.readFileSync(
    path.join(FIXTURE_DIR, "edgectl.yaml"),
    "utf8",
  ));
});

test("apply 失败且远端未知：保存 unknown 文件并停止", async () => {
  const fixture = setup();
  const unknown = "# someone else changed this\n";
  const remote = fakeRemote({ reads: [fixture.oldRaw, fixture.oldRaw, unknown] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { runner: cliRunner({ apply: false }), remote: remote.fns }),
  );
  assert.equal(job.state, "failed");
  const file = path.join(fixture.configDir, "edge-unknown-job-1.Caddyfile");
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, "utf8"), unknown);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(job.message, /unknown|未知/);
});

function nativeResult(overrides: Partial<NativeApplyResult> = {}): NativeApplyResult {
  return {
    outcome: "success",
    remoteSha: null,
    backupPath: null,
    message: "native ok",
    code: "ok",
    ...overrides,
  };
}

test("native apply：success 直接成功，不调用 reloadOnly", async () => {
  const fixture = setup({ provider: "native" });
  const remote = fakeRemote({ reads: [fixture.oldRaw] });
  let seen: { candidateBytes?: string; expected?: string } = {};
  let reloadCalls = 0;
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async (input) => {
        seen = { candidateBytes: input.candidateBytes, expected: input.expectedRemoteSha };
        return nativeResult({ remoteSha: fixture.expectedSha });
      },
      reloadOnlyFn: async () => {
        reloadCalls += 1;
        return nativeResult();
      },
    }),
  );
  assert.equal(job.state, "success");
  assert.equal(job.message, "native ok");
  assert.equal(seen.candidateBytes, fixture.plan.candidateBytes);
  assert.equal(seen.expected, fixture.plan.expectedRemoteSha);
  assert.equal(reloadCalls, 0);
});

test("native apply：writtenNotActive → reloadOnly 重试成功", async () => {
  const fixture = setup({ provider: "native" });
  const remote = fakeRemote({ reads: [fixture.oldRaw] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async () =>
        nativeResult({ outcome: "writtenNotActive", message: "未生效", code: "reload-failed" }),
      reloadOnlyFn: async () => nativeResult({ message: "reload retry ok" }),
    }),
  );
  assert.equal(job.state, "success");
  assert.equal(job.message, "reload retry ok");
});

test("native apply：writtenNotActive 且重试失败 → failed", async () => {
  const fixture = setup({ provider: "native" });
  const remote = fakeRemote({ reads: [fixture.oldRaw] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async () =>
        nativeResult({ outcome: "writtenNotActive", message: "未生效", code: "reload-failed" }),
      reloadOnlyFn: async () =>
        nativeResult({ outcome: "failed", message: "reload still failed", code: "reload-failed" }),
    }),
  );
  assert.equal(job.state, "failed");
  assert.match(job.message, /reload 重试仍失败/);
  // 远端仍是 expected：不产生 unknown 快照。
  assert.equal(
    fs.existsSync(path.join(fixture.configDir, "edge-unknown-job-1.Caddyfile")),
    false,
  );
});

test("native apply：writtenNotActive 重试失败且远端漂移 → 保存现场", async () => {
  const fixture = setup({ provider: "native" });
  const drifted = "# drifted after write\n";
  const remote = fakeRemote({ reads: [fixture.oldRaw, drifted] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async () =>
        nativeResult({ outcome: "writtenNotActive", message: "未生效", code: "reload-failed" }),
      reloadOnlyFn: async () =>
        nativeResult({
          outcome: "failed",
          message: "remote changed",
          code: "remote-changed",
          remoteSha: "d".repeat(64),
        }),
    }),
  );
  assert.equal(job.state, "failed");
  const file = path.join(fixture.configDir, "edge-unknown-job-1.Caddyfile");
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, "utf8"), drifted);
  const lastFailure = readEdgeState(fixture.configDir)?.lastFailure as
    | Record<string, unknown>
    | undefined;
  assert.equal(lastFailure?.remoteSha, sha256Hex(drifted));
  assert.equal(lastFailure?.unknown, "edge-unknown-job-1.Caddyfile");
});

test("native apply：unknown → failed 并保存现场", async () => {
  const fixture = setup({ provider: "native" });
  // 第一次是入口复核（old），第二次是 unknown 现场快照。
  const remote = fakeRemote({ reads: [fixture.oldRaw, "# unknown remote\n"] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async () =>
        nativeResult({ outcome: "unknown", message: "结果未知", code: "unknown" }),
    }),
  );
  assert.equal(job.state, "failed");
  assert.match(job.message, /未知|人工/);
  assert.equal(
    fs.existsSync(path.join(fixture.configDir, "edge-unknown-job-1.Caddyfile")),
    true,
  );
  const lastFailure = readEdgeState(fixture.configDir)?.lastFailure as
    | Record<string, unknown>
    | undefined;
  assert.equal(lastFailure?.jobId, "job-1");
  assert.equal(lastFailure?.unknown, "edge-unknown-job-1.Caddyfile");
});

test("native apply：restored → failed（未生效）", async () => {
  const fixture = setup({ provider: "native" });
  const remote = fakeRemote({ reads: [fixture.oldRaw] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async () =>
        nativeResult({ outcome: "restored", message: "已恢复", code: "restored" }),
    }),
  );
  assert.equal(job.state, "failed");
  assert.match(job.message, /未生效|恢复/);
  // 远端未写成功（restored）：本地注册表必须回滚到原文。
  assert.equal(
    fs.readFileSync(fixture.registryPath, "utf8"),
    fs.readFileSync(path.join(FIXTURE_DIR, "edgectl.yaml"), "utf8"),
  );
  // restored 不需要“恢复它等于什么都不做”的 unknown 快照。
  assert.equal(
    fs.existsSync(path.join(fixture.configDir, "edge-unknown-job-1.Caddyfile")),
    false,
  );
});

test("native apply：failed（remote-changed/candidate-invalid）回滚本地注册表", async () => {
  const fixture = setup({ provider: "native" });
  const remote = fakeRemote({ reads: [fixture.oldRaw] });
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async () =>
        nativeResult({
          outcome: "failed",
          message: "远端在期间被修改",
          code: "remote-changed-during-apply",
          remoteSha: "c".repeat(64),
        }),
    }),
  );
  assert.equal(job.state, "failed");
  assert.equal(
    fs.readFileSync(fixture.registryPath, "utf8"),
    fs.readFileSync(path.join(FIXTURE_DIR, "edgectl.yaml"), "utf8"),
  );
});

test("native apply：变更计划但远端已 expected → reload 成功", async () => {
  const fixture = setup({ provider: "native" });
  const remote = fakeRemote({ reads: [fixture.expected] });
  let applyCalls = 0;
  let reloadCalls = 0;
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, {
      remote: remote.fns,
      nativeApplyFn: async () => {
        applyCalls += 1;
        return nativeResult({ outcome: "failed", message: "remote changed" });
      },
      reloadOnlyFn: async () => {
        reloadCalls += 1;
        return nativeResult({ message: "already + reload ok" });
      },
    }),
  );
  assert.equal(job.state, "success");
  assert.equal(job.message, "already + reload ok");
  assert.equal(applyCalls, 0);
  assert.equal(reloadCalls, 1);
  // 远端已是目标内容：本地注册表写成候选配置。
  assert.match(fs.readFileSync(fixture.registryPath, "utf8"), /code\.example\.com/);
});

test("restore：校验失败不写远端", async () => {
  const fixture = setup();
  const backupName = "edge-backup-old.Caddyfile";
  fs.writeFileSync(path.join(fixture.configDir, backupName), fixture.oldRaw, { mode: 0o600 });
  const remote = fakeRemote({ reads: [fixture.oldRaw], validateCandidate: false });
  const request: EdgeJobRequest = {
    version: 1,
    kind: "restore",
    jobId: "job-r1",
    token: "tok-r1",
    createdAt: isoNow(),
    confirmDomain: "code.example.com",
    backup: backupName,
    remoteSha: fixture.oldSha,
  };
  const job = await runEdgeJob(
    fixture.configDir,
    request,
    baseDeps(fixture, { runner: cliRunner(), remote: remote.fns }),
  );
  assert.equal(job.state, "failed");
  assert.equal(remote.calls.writes.length, 0);
  const lastFailure = readEdgeState(fixture.configDir)?.lastFailure as
    | Record<string, unknown>
    | undefined;
  assert.equal(lastFailure?.backup, backupName);
  assert.equal(lastFailure?.backupSha, sha256Hex(fixture.oldRaw));
  assert.equal(lastFailure?.remoteSha, fixture.oldSha);
});

test("restore：首次 reload 失败则回写原内容，二次失败写最终失败状态", async () => {
  const fixture = setup();
  const backupName = "edge-backup-old.Caddyfile";
  const backupContent = `${fixture.oldRaw}\n# backup marker\n`;
  fs.writeFileSync(path.join(fixture.configDir, backupName), backupContent, { mode: 0o600 });
  const remote = fakeRemote({
    reads: [fixture.oldRaw],
    validateCandidate: true,
    live: true,
    reload: false,
  });
  const request: EdgeJobRequest = {
    version: 1,
    kind: "restore",
    jobId: "job-r2",
    token: "tok-r2",
    createdAt: isoNow(),
    confirmDomain: "code.example.com",
    backup: backupName,
    remoteSha: fixture.oldSha,
  };
  const job = await runEdgeJob(
    fixture.configDir,
    request,
    baseDeps(fixture, { runner: cliRunner(), remote: remote.fns }),
  );
  assert.equal(job.state, "failed");
  // 第一次写备份内容，第二次回写原内容。
  assert.equal(remote.calls.writes.length, 2);
  assert.equal(remote.calls.writes[0], backupContent);
  assert.equal(remote.calls.writes[1], fixture.oldRaw);
  assert.equal(remote.calls.reload, 2);
  assert.equal(
    fs.existsSync(path.join(fixture.configDir, "edge-unknown-job-r2.Caddyfile")),
    true,
  );
});

test("作业失败信息脱敏后才落盘", async () => {
  const fixture = setup();
  const secret = fixture.secrets.cookieSecret;
  const failingRemote = {
    readRemoteFile: () => {
      throw new Error(`远端爆炸 ${secret}`);
    },
    caddyVersion: () => ({ version: null, result: remoteResult() }),
    caddyValidateCandidate: () => ({
      result: remoteResult(),
      candidate: "",
      candidateDir: "",
      fallback: false,
    }),
    caddyValidateLive: () => remoteResult(),
    caddyReload: () => remoteResult(),
    writeRemoteFileInPlace: () => remoteResult(),
  };
  const job = await runEdgeJob(
    fixture.configDir,
    requestFor(fixture),
    baseDeps(fixture, { remote: failingRemote }),
  );
  assert.equal(job.state, "failed");
  const stored = fs.readFileSync(edgeStateFile(fixture.configDir), "utf8");
  assert.ok(!stored.includes(secret));
  assert.match(stored, /<redacted>/);
});

function opsResult(overrides: Partial<OpsLockResult> = {}): OpsLockResult {
  return { ok: true, code: "ok", ...overrides };
}

/** 与 server/src/job-state.ts 的秒精度契约一致：不允许毫秒。 */
const SECOND_PRECISION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function assertSecondPrecision(value: string | null | undefined): void {
  assert.equal(typeof value, "string");
  assert.match(value as string, SECOND_PRECISION_RE);
}

const FIXED_NOW = () => new Date("2026-01-02T03:04:05.678Z");

test("reclaim HTTP 动作：快速 202 并 spawn detached 回收进程", () => {
  const fixture = setup();
  const spawns: Array<{ command?: string; args?: string[]; env: NodeJS.ProcessEnv }> = [];
  const deps: EdgeActionDeps = {
    ...baseDeps(fixture),
    ops: {
      status: () => opsResult({ lockFree: true, metaStatus: "missing" }),
    },
    randomId: () => "job-reclaim-1",
    spawnJob: (options) => {
      spawns.push(options);
      return { pid: 1 };
    },
  };
  const result = reclaimEdge(deps, { confirm: "RECLAIM", jobId: "job-x" });
  assert.deepEqual(result, { ok: true });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.command, process.execPath);
  assert.match(spawns[0]!.args?.[0] ?? "", /server\/dist\/edge-job\.js$/);
  const request = JSON.parse(
    fs.readFileSync(path.join(fixture.configDir, "edge-request.json"), "utf8"),
  );
  assert.equal(request.kind, "reclaim");
  assert.equal(request.reclaimJobId, "job-x");
  // spawn 后立即写 pid，避免首次 status 轮询误判 failed。
  const job = readEdgeJob(fixture.configDir);
  assert.equal(job?.state, "running");
  assert.equal(job?.pid, 1);
  assertSecondPrecision(job?.startedAt);
  assert.equal(job?.finishedAt, null);
});

test("apply HTTP 动作：初始 running 与 spawn 失败时间戳为秒精度", async () => {
  const fixture = setup();
  let initial: EdgeJob | null = null;
  const deps: EdgeActionDeps = {
    ...baseDeps(fixture),
    randomId: () => "job-apply-ts",
    ops: { claim: () => opsResult(), clear: () => opsResult() },
    spawnJob: () => {
      initial = readEdgeJob(fixture.configDir);
      throw new Error("spawn boom");
    },
  };
  await assert.rejects(
    () => applyEdge(deps, {
      planHash: fixture.plan.planHash,
      confirmDomain: "code.example.com",
    }),
    /无法启动 edge 任务/,
  );
  assert.ok(initial);
  assertSecondPrecision((initial as EdgeJob).startedAt);
  assert.equal((initial as EdgeJob).finishedAt, null);

  const failed = readEdgeJob(fixture.configDir);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.step, "spawn");
  assertSecondPrecision(failed?.startedAt);
  assertSecondPrecision(failed?.finishedAt);
});

test("restore HTTP 动作：初始 running 时间戳为秒精度", async () => {
  const fixture = setup();
  const backup = "edge-backup-ts.Caddyfile";
  fs.writeFileSync(path.join(fixture.configDir, backup), "caddy");
  let initial: EdgeJob | null = null;
  const deps: EdgeActionDeps = {
    ...baseDeps(fixture),
    randomId: () => "job-restore-ts",
    ops: { claim: () => opsResult(), clear: () => opsResult(), status: () => opsResult() },
    spawnJob: () => {
      initial = readEdgeJob(fixture.configDir);
      return { pid: 7 };
    },
  };
  const result = await restoreEdge(deps, {
    backup,
    remoteSha: fixture.oldSha,
    confirmDomain: "code.example.com",
  });
  assert.deepEqual(result, { ok: true, jobId: "job-restore-ts" });
  assert.ok(initial);
  assert.equal((initial as EdgeJob).kind, "restore");
  assertSecondPrecision((initial as EdgeJob).startedAt);
  assert.equal((initial as EdgeJob).finishedAt, null);
});

test("reclaim HTTP 动作：spawn 失败写秒精度时间戳", () => {
  const fixture = setup();
  const deps: EdgeActionDeps = {
    ...baseDeps(fixture),
    randomId: () => "job-reclaim-fail",
    ops: { status: () => opsResult({ lockFree: true, metaStatus: "missing" }) },
    spawnJob: () => {
      throw new Error("spawn boom");
    },
  };
  assert.throws(() => reclaimEdge(deps, { confirm: "RECLAIM" }), /无法启动回收任务/);
  const job = readEdgeJob(fixture.configDir);
  assert.equal(job?.state, "failed");
  assert.equal(job?.step, "spawn");
  assertSecondPrecision(job?.startedAt);
  assertSecondPrecision(job?.finishedAt);
});

test("作业被判定中断时 finishedAt 为秒精度且尊重 now 注入", () => {
  const fixture = setup();
  writeEdgeJob(fixture.configDir, {
    jobId: "job-stale",
    state: "running",
    kind: "apply",
    step: "apply",
    message: "运行中",
    pid: 424242,
    startedAt: "2026-01-02T03:04:05Z",
    finishedAt: null,
  });
  const job = readEdgeJobForApi({
    ...baseDeps(fixture),
    isAlive: () => false,
    now: FIXED_NOW,
  });
  assert.equal(job?.state, "failed");
  assert.equal(job?.finishedAt, "2026-01-02T03:04:05Z");
});

test("registry/.env 改动后 readEdgeJobForApi 重新加载 secrets 并脱敏新值", () => {
  const fixture = setup();
  writeEdgeJob(fixture.configDir, {
    jobId: "job-secret-cache",
    state: "success",
    kind: "apply",
    step: "apply",
    message: "完成",
    pid: null,
    startedAt: "2026-01-02T03:04:05Z",
    finishedAt: "2026-01-02T03:04:06Z",
  });
  const envFile = path.join(fixture.configDir, ".env");
  const oldCookie = "fedcba9876543210fedcba9876543210";
  fs.appendFileSync(edgeLogFile(fixture.configDir), `first ${oldCookie}\n`);
  const first = readEdgeJobForApi(baseDeps(fixture));
  assert.ok(first?.logTail);
  assert.ok(!first!.logTail!.includes(oldCookie));

  // 同尺寸替换 .env：只能靠 mtimeMs 判断变化，强制 utimes 保证可观察。
  const newCookie = "0123456789abcdef0123456789abcdef";
  const before = fs.statSync(envFile);
  fs.writeFileSync(
    envFile,
    fs.readFileSync(envFile, "utf8").replace(oldCookie, newCookie),
  );
  fs.utimesSync(envFile, before.atime, new Date(before.mtimeMs + 5_000));
  fs.appendFileSync(edgeLogFile(fixture.configDir), `second ${newCookie}\n`);
  const second = readEdgeJobForApi(baseDeps(fixture));
  assert.ok(second?.logTail);
  assert.ok(second!.logTail!.includes("second"));
  assert.ok(!second!.logTail!.includes(newCookie));
});

test("只轮换 secrets、不追加日志时日志尾仍按新密钥重新脱敏", () => {
  const fixture = setup();
  writeEdgeJob(fixture.configDir, {
    jobId: "job-secret-rotate",
    state: "success",
    kind: "apply",
    step: "apply",
    message: "完成",
    pid: null,
    startedAt: "2026-01-02T03:04:05Z",
    finishedAt: "2026-01-02T03:04:06Z",
  });
  const envFile = path.join(fixture.configDir, ".env");
  const oldCookie = "fedcba9876543210fedcba9876543210";
  fs.appendFileSync(edgeLogFile(fixture.configDir), `first ${oldCookie}\n`);
  const first = readEdgeJobForApi(baseDeps(fixture));
  assert.ok(first?.logTail);
  assert.ok(!first!.logTail!.includes(oldCookie));

  // 只改 .env，不追加日志。新密钥不包含旧值，因此重算后旧值会露出；
  // 若仍复用旧缓存则会继续显示 <redacted>，以此证明缓存按 secrets 版本失效。
  const newCookie = "0123456789abcdef0123456789abcdef";
  const before = fs.statSync(envFile);
  fs.writeFileSync(
    envFile,
    fs.readFileSync(envFile, "utf8").replace(oldCookie, newCookie),
  );
  fs.utimesSync(envFile, before.atime, new Date(before.mtimeMs + 5_000));
  const second = readEdgeJobForApi(baseDeps(fixture));
  assert.ok(second?.logTail);
  assert.ok(second!.logTail!.includes(oldCookie));
});

test("reclaim job：先 cleanup 再 forceReclaim，成功写 edge.json", async () => {
  const fixture = setup();
  const calls: string[] = [];
  const ops: Partial<EdgeOpsFns> = {
    cleanup: () => {
      calls.push("cleanup");
      return opsResult({ cleanedPids: [], remainingPids: [] });
    },
    forceReclaim: () => {
      calls.push("forceReclaim");
      return opsResult({ forceReclaimed: true, cleanedPids: [123] });
    },
  };
  const deps: EdgeActionDeps = { ...baseDeps(fixture), ops };
  const job = await runEdgeJob(
    fixture.configDir,
    {
      version: 1,
      kind: "reclaim",
      jobId: "job-r",
      createdAt: isoNow(),
      reclaimJobId: "old-job",
    },
    deps,
  );
  assert.equal(job.state, "success");
  assert.equal(job.kind, "reclaim");
  assertSecondPrecision(job.startedAt);
  assertSecondPrecision(job.finishedAt);
  assert.deepEqual(calls, ["cleanup", "forceReclaim"]);
  assert.equal(readEdgeJob(fixture.configDir)?.kind, "reclaim");
});

test("reclaim job：仍有残留 → failed + remainingPids", async () => {
  const fixture = setup();
  const ops: Partial<EdgeOpsFns> = {
    cleanup: () => opsResult(),
    forceReclaim: () =>
      opsResult({ ok: false, code: "residual", remainingPids: [42] }),
  };
  const deps: EdgeActionDeps = { ...baseDeps(fixture), ops };
  const job = await runEdgeJob(
    fixture.configDir,
    { version: 1, kind: "reclaim", jobId: "job-r2", createdAt: isoNow() },
    deps,
  );
  assert.equal(job.state, "failed");
  assert.deepEqual(job.remainingPids, [42]);
});

test("redactApiText：configPath=null 时兜底把绝对路径降为 basename", () => {
  const deps: EdgeActionDeps = {
    repoRoot: "/srv/qubius-repo",
    env: { HOME: "/home/someone" },
    configDir: "/var/lib/qubius",
    paths: {
      provider: null,
      resolvedProvider: null,
      configPath: null,
      configSource: null,
      binPath: null,
      binSource: null,
      disabled: true,
      errors: ["无法读取 /opt/secret/edgectl.yaml"],
    },
  };
  assert.equal(
    redactApiText(deps, "失败：/opt/secret/edgectl.yaml 不存在"),
    "失败：edgectl.yaml 不存在",
  );
  assert.equal(
    redactApiText(deps, "repo=/srv/qubius-repo/deploy"),
    "repo=<repoRoot>/deploy",
  );
});

test("cleanupEdgeBackups：backup/unknown 共用 5 份保留策略", () => {
  const fixture = setup();
  const now = Date.now();
  for (let i = 0; i < 8; i += 1) {
    const prefix = i % 2 === 0 ? "edge-backup" : "edge-unknown";
    const file = path.join(fixture.configDir, `${prefix}-${i}.Caddyfile`);
    fs.writeFileSync(file, `# ${i}\n`, { mode: 0o600 });
    const time = new Date(now - (8 - i) * 1000);
    fs.utimesSync(file, time, time);
  }
  // 本次请求正在使用的 backup 永不清理（即使它最旧）。
  const removed = cleanupEdgeBackups(fixture.configDir, {
    max: 5,
    exclude: ["edge-backup-0.Caddyfile"],
  });
  assert.equal(removed.length, 2);
  assert.equal(
    fs.existsSync(path.join(fixture.configDir, "edge-backup-0.Caddyfile")),
    true,
  );
  const left = fs
    .readdirSync(fixture.configDir)
    .filter((name) => /^edge-(?:backup|unknown)-/.test(name));
  assert.equal(left.length, 6);
  assert.ok(left.includes("edge-backup-0.Caddyfile"));
});
