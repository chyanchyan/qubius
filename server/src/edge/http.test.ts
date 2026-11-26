import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AppConfig } from "../config.js";
import { deriveDeployForm } from "../deploy.js";
import { createAppServer } from "../http.js";
import { Runtime } from "../runtime.js";
import type { StoredSettings } from "../settings.js";
import { Store } from "../store.js";
import type { Effort } from "../types.js";
import {
  runEdgeJob,
  type EdgeActionDeps,
  type EdgeOpsFns,
} from "./actions.js";
import { sha256Hex } from "./canonical.js";
import type { CommandRunner, CommandSpec } from "./cli.js";
import { desiredSites } from "./desired.js";
import type { EdgeJobRequest, SpawnJobOptions } from "./job-runner.js";
import {
  computePlanHash,
  edgeEnvSnapshot,
  writePlan,
  type StoredEdgePlan,
} from "./plan.js";
import { NATIVE_RENDER_VERSION } from "./provider.js";
import { parseRegistryText, upsertManagedSites } from "./registry.js";
import type { RemoteResult } from "./remote.js";
import { renderVpsBlock, spliceManaged } from "./render.js";
import { loadEdgeSecrets } from "./secrets.js";
import { writeEdgeJob, writeEdgeState } from "./state.js";
import type { EdgePaths, EdgeSecrets } from "./types.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "registry");

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

interface EdgeFixture {
  base: string;
  configDir: string;
  registryPath: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  paths: EdgePaths;
  plan: StoredEdgePlan;
  secrets: EdgeSecrets;
  oldRaw: string;
  expected: string;
}

interface SetupOptions {
  requiresConfirmExisting?: boolean;
  provider?: "cli" | "native";
  appliable?: boolean;
  /** 只启用副实例（co-qubius），用于确认域名测试。 */
  secondaryOnly?: boolean;
}

function setupEdge(options: SetupOptions = {}): EdgeFixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "edge-http-"));
  const configDir = path.join(base, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const registryPath = path.join(configDir, "edgectl.yaml");
  fs.copyFileSync(path.join(FIXTURE_DIR, "edgectl.yaml"), registryPath);
  fs.copyFileSync(path.join(FIXTURE_DIR, ".env"), path.join(configDir, ".env"));
  const bin = path.join(base, "edgectl");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(bin, 0o755);

  const env: NodeJS.ProcessEnv = {
    HOME: base,
    QUBIUS_CONFIG_DIR: configDir,
    QUBIUS_PUBLIC_HOST: options.secondaryOnly ? "" : "code.example.com",
    QUBIUS_PUBLIC_HOST_SECONDARY: options.secondaryOnly ? "co.example.com" : "",
    QUBIUS_PRIMARY_PORT: "8787",
    QUBIUS_SECONDARY_PORT: "8788",
    QUBIUS_START_PRIMARY: options.secondaryOnly ? "0" : "1",
    QUBIUS_START_SECONDARY: options.secondaryOnly ? "1" : "0",
    QUBIUS_EDGECTL_CONFIG: registryPath,
    QUBIUS_EDGE_PROVIDER: "cli",
    QUBIUS_EDGECTL_BIN: bin,
    PATH: process.env.PATH ?? "",
  };
  const paths: EdgePaths = {
    provider: "cli",
    resolvedProvider: "cli",
    configPath: registryPath,
    configSource: "envfile-qubius",
    binPath: bin,
    binSource: "env",
    disabled: false,
    errors: [],
  };

  const registryText = fs.readFileSync(registryPath, "utf8");
  const registry = parseRegistryText(registryText, registryPath);
  const secrets = loadEdgeSecrets({ registry, env });
  const desired = desiredSites(deriveDeployForm(env, "primary").form, "primary").sites;
  const candidateText = upsertManagedSites(registryPath, desired, { write: false }).text;
  const candidateRegistry = parseRegistryText(candidateText, registryPath);
  const oldRaw = renderVpsBlock(registry, secrets);
  const expected = spliceManaged(oldRaw, renderVpsBlock(candidateRegistry, secrets));
  const createdAt = "2026-01-02T03:04:05.000Z";
  const planId = "plan-http-1";
  const provider = options.provider ?? "cli";
  const edgectl = { bin, version: "0.1.0", source: "env" };
  const envSnapshot = edgeEnvSnapshot(env, "primary");
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
    registryDiff: "注册表无变更\n",
    remoteDiff: "远端无变化\n",
    warnings: [],
    errors: [],
    blocking: [],
    requiresConfirmExisting: options.requiresConfirmExisting ?? false,
    envSnapshot,
    edgectl,
    nativeRenderVersion: NATIVE_RENDER_VERSION,
    secretsSha: secrets.secretsSha,
    appliable: options.appliable ?? true,
  };
  writePlan(configDir, plan, secrets);
  return { base, configDir, registryPath, bin, env, paths, plan, secrets, oldRaw, expected };
}

function cliRunner(): CommandRunner {
  return (spec: CommandSpec) => {
    if (spec.args.includes("--version")) {
      return { status: 0, stdout: "edgectl 0.1.0\n", stderr: "", signal: null };
    }
    return { status: 0, stdout: "", stderr: "", signal: null };
  };
}

function gateRemote(fixture: EdgeFixture) {
  return {
    readRemoteFile: () => ({
      content: fixture.oldRaw,
      sha: sha256Hex(fixture.oldRaw),
      result: remoteResult(),
    }),
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
}

function ops(overrides: Partial<EdgeOpsFns> = {}): Partial<EdgeOpsFns> {
  return {
    status: () => ({ ok: true, code: "ok", lockFree: true, remainingPids: [] }),
    claim: () => ({ ok: true, code: "ok", state: "pending" }),
    clear: () => ({ ok: true, code: "ok", cleared: true }),
    cleanup: () => ({ ok: true, code: "ok" }),
    forceReclaim: () => ({ ok: true, code: "ok", forceReclaimed: true }),
    ...overrides,
  };
}

interface Harness {
  url: string;
  base: string;
  configDir: string;
  close: () => Promise<void>;
}

async function startHarness(
  base: string,
  configDir: string,
  edge: Partial<EdgeActionDeps>,
): Promise<Harness> {
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: 1,
    configDir: base,
    role: "primary",
    projects: [],
  };
  const settings = {
    current: { effort: "high" as Effort, providers: [], maxConcurrent: 4 } satisfies StoredSettings,
  };
  const store = new Store(dataDir);
  const runtime = new Runtime(store, {
    maxConcurrent: 1,
    fake: true,
    credential: () => ({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }),
    permission: () => "acceptEdits",
    secrets: () => [],
  });
  const server = createAppServer({
    config,
    store,
    runtime,
    webDist: path.join(base, "web"),
    settings,
    permissions: { current: {} },
    repoRoot: base,
    edge: { repoRoot: base, configDir, ...edge },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    base,
    configDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.shutdown().catch(() => undefined);
      await store.flush().catch(() => undefined);
      fs.rmSync(base, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    },
  };
}

async function call<T = Record<string, unknown>>(
  harness: Harness,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${harness.url}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T;
  return { status: response.status, data };
}

function depsFor(
  fixture: EdgeFixture,
  overrides: Partial<EdgeActionDeps> = {},
): Partial<EdgeActionDeps> {
  return {
    repoRoot: fixture.base,
    env: fixture.env,
    configDir: fixture.configDir,
    paths: fixture.paths,
    runner: cliRunner(),
    remote: gateRemote(fixture),
    ops: ops(),
    ...overrides,
  };
}

test("GET /api/edge：provider/registry(仅 basename)/desired/canPlan", async () => {
  const fixture = setupEdge();
  const harness = await startHarness(fixture.base, fixture.configDir, depsFor(fixture));
  try {
    const result = await call<Record<string, any>>(harness, "GET", "/api/edge");
    assert.equal(result.status, 200);
    assert.equal(result.data.enabled, true);
    assert.equal(result.data.provider.resolved, "cli");
    assert.equal(result.data.provider.available, true);
    assert.equal(result.data.registry.name, "edgectl.yaml");
    assert.equal(result.data.registry.drift, false);
    assert.equal(JSON.stringify(result.data.registry).includes(fixture.configDir), false);
    assert.equal(result.data.desired[0].name, "qubius");
    assert.deepEqual(result.data.desired[0].domains, ["code.example.com"]);
    assert.equal(result.data.canPlan, true);
    assert.equal(result.data.lastJob, null);
  } finally {
    await harness.close();
  }
});

test("GET /api/edge：返回 lastFailure 供 restore 预填且不泄露路径", async () => {
  const fixture = setupEdge();
  fs.writeFileSync(path.join(fixture.configDir, "edge-backup-old.Caddyfile"), "# backup\n");
  fs.writeFileSync(
    path.join(fixture.configDir, "edge-unknown-job-fail.Caddyfile"),
    "# unknown\n",
  );
  writeEdgeState(fixture.configDir, {
    lastFailure: {
      jobId: "job-fail",
      remoteSha: "a".repeat(64),
      backup: "edge-backup-old.Caddyfile",
      unknown: "edge-unknown-job-fail.Caddyfile",
      backupSha: "b".repeat(64),
      at: "2026-01-02T00:00:00.000Z",
    },
  });
  const harness = await startHarness(fixture.base, fixture.configDir, depsFor(fixture));
  try {
    const result = await call<Record<string, any>>(harness, "GET", "/api/edge");
    assert.equal(result.status, 200);
    assert.equal(result.data.lastFailure.jobId, "job-fail");
    assert.equal(result.data.lastFailure.remoteSha, "a".repeat(64));
    assert.equal(result.data.lastFailure.backup, "edge-backup-old.Caddyfile");
    assert.equal(result.data.lastFailure.unknown, "edge-unknown-job-fail.Caddyfile");
    assert.equal(result.data.lastFailure.backupSha, "b".repeat(64));
    assert.equal(JSON.stringify(result.data).includes(fixture.base), false);
  } finally {
    await harness.close();
  }
});

test("GET /api/edge：lastFailure 指向的文件不存在时不返回失效字段", async () => {
  const fixture = setupEdge();
  writeEdgeState(fixture.configDir, {
    lastFailure: {
      jobId: "job-gone",
      remoteSha: "a".repeat(64),
      backup: "edge-backup-gone.Caddyfile",
      unknown: "edge-unknown-gone.Caddyfile",
      backupSha: "b".repeat(64),
    },
  });
  const harness = await startHarness(fixture.base, fixture.configDir, depsFor(fixture));
  try {
    const result = await call<Record<string, any>>(harness, "GET", "/api/edge");
    assert.equal(result.status, 200);
    assert.equal(result.data.lastFailure.jobId, "job-gone");
    assert.equal(result.data.lastFailure.remoteSha, "a".repeat(64));
    assert.equal("backup" in result.data.lastFailure, false);
    assert.equal("unknown" in result.data.lastFailure, false);
    assert.equal("backupSha" in result.data.lastFailure, false);
  } finally {
    await harness.close();
  }
});

test("GET /api/edge：disabled 时 enabled/canPlan=false 且有 hint", async () => {
  const fixture = setupEdge();
  const disabledPaths: EdgePaths = {
    ...fixture.paths,
    resolvedProvider: null,
    provider: null,
    disabled: true,
    errors: ["未配置 edgectl 配置路径"],
  };
  const harness = await startHarness(
    fixture.base,
    fixture.configDir,
    depsFor(fixture, { paths: disabledPaths }),
  );
  try {
    const result = await call<Record<string, any>>(harness, "GET", "/api/edge");
    assert.equal(result.status, 200);
    assert.equal(result.data.enabled, false);
    assert.equal(result.data.canPlan, false);
    assert.equal(result.data.provider.available, false);
    assert.equal(result.data.provider.resolved, null);
    assert.match(result.data.planHint, /未配置/);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/plan：契约字段与 requiresForceReclaim", async () => {
  const fixture = setupEdge();
  let seenRepoRoot: string | undefined;
  const harness = await startHarness(
    fixture.base,
    fixture.configDir,
    depsFor(fixture, {
      planRunner: async (options) => {
        seenRepoRoot = options.repoRoot;
        return fixture.plan;
      },
      ops: ops({
        status: () => ({
          ok: true,
          code: "ok",
          lockFree: true,
          remainingPids: [4242],
        }),
      }),
    }),
  );
  try {
    const result = await call<Record<string, any>>(harness, "POST", "/api/edge/plan", {});
    // plan 子进程必须拿到仓库根目录，才能解析 <repo>/deploy/env。
    assert.equal(seenRepoRoot, fixture.base);
    assert.equal(result.status, 200);
    assert.equal(result.data.planHash, fixture.plan.planHash);
    assert.equal(result.data.provider, "cli");
    assert.deepEqual(result.data.desired, fixture.plan.desired);
    assert.equal(typeof result.data.registryDiff, "string");
    assert.equal(typeof result.data.remoteDiff, "string");
    assert.deepEqual(result.data.warnings, []);
    assert.equal(result.data.requiresConfirmExisting, false);
    assert.equal(result.data.requiresForceReclaim, true);
    assert.equal(result.data.appliable, true);
    assert.equal("remoteUnavailable" in result.data, false);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/plan：硬阻断时 appliable=false", async () => {
  const fixture = setupEdge({ appliable: false });
  const harness = await startHarness(fixture.base, fixture.configDir, depsFor(fixture, {
    planRunner: async () => fixture.plan,
  }));
  try {
    const result = await call<Record<string, any>>(harness, "POST", "/api/edge/plan", {});
    assert.equal(result.status, 200);
    assert.equal(result.data.appliable, false);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/plan：超时 504，子进程失败 503", async () => {
  const fixture = setupEdge();
  const timeout = await startHarness(fixture.base, fixture.configDir, depsFor(fixture, {
    planRunner: async () => {
      throw new Error("生成计划失败：超时");
    },
  }));
  try {
    const result = await call<{ error: string }>(timeout, "POST", "/api/edge/plan", {});
    assert.equal(result.status, 504);
  } finally {
    await timeout.close();
  }

  const fixture2 = setupEdge();
  const failed = await startHarness(fixture2.base, fixture2.configDir, depsFor(fixture2, {
    planRunner: async () => {
      throw new Error("boom");
    },
  }));
  try {
    const result = await call<{ error: string }>(failed, "POST", "/api/edge/plan", {});
    assert.equal(result.status, 503);
  } finally {
    await failed.close();
  }
});

test("POST /api/edge/plan：disabled 返回 400", async () => {
  const fixture = setupEdge();
  const disabledPaths: EdgePaths = {
    ...fixture.paths,
    resolvedProvider: null,
    provider: null,
    disabled: true,
    errors: ["未配置"],
  };
  const harness = await startHarness(
    fixture.base,
    fixture.configDir,
    depsFor(fixture, { paths: disabledPaths }),
  );
  try {
    const result = await call<{ error: string }>(harness, "POST", "/api/edge/plan", {});
    assert.equal(result.status, 400);
    assert.match(result.data.error, /公网入口未启用/);
  } finally {
    await harness.close();
  }
});

function applyBody(fixture: EdgeFixture, overrides: Record<string, unknown> = {}) {
  return {
    planHash: fixture.plan.planHash,
    confirmDomain: "code.example.com",
    ...overrides,
  };
}

function applyDeps(
  fixture: EdgeFixture,
  overrides: Partial<EdgeActionDeps> = {},
): { deps: Partial<EdgeActionDeps>; spawns: SpawnJobOptions[] } {
  const spawns: SpawnJobOptions[] = [];
  return {
    spawns,
    deps: depsFor(fixture, {
      randomId: () => "job-apply-1",
      spawnJob: (options) => {
        spawns.push(options);
        return { pid: 12345 };
      },
      ...overrides,
    }),
  };
}

test("POST /api/edge/apply：202 + jobId，spawn detached", async () => {
  const fixture = setupEdge();
  const { deps, spawns } = applyDeps(fixture);
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const result = await call<{ ok: boolean; jobId: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture),
    );
    assert.equal(result.status, 202);
    assert.deepEqual(result.data, { ok: true, jobId: "job-apply-1" });
    assert.equal(spawns.length, 1);
    assert.match(spawns[0]!.script ?? "", /deploy\/edge-job\.sh$/);
    assert.equal(spawns[0]!.env.QUBIUS_OPS_JOB, "job-apply-1");
    assert.equal(spawns[0]!.env.QUBIUS_EDGE_CONFIG_DIR, fixture.configDir);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/apply：300/400/409 各错误码", async () => {
  const fixture = setupEdge();
  const { deps } = applyDeps(fixture);
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const missing = await call<{ error: string }>(harness, "POST", "/api/edge/apply", {});
    assert.equal(missing.status, 400);

    const stale = await call<{ error: string; code: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture, { planHash: "nope" }),
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "stale");

    const domain = await call<{ error: string; code: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture, { confirmDomain: "wrong.example.com" }),
    );
    assert.equal(domain.status, 409);
    assert.equal(domain.data.code, "conflict");
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/apply：本地注册表已变化 → 409 stale，不 spawn", async () => {
  const fixture = setupEdge();
  fs.appendFileSync(fixture.registryPath, "\n# drifted\n");
  const { deps, spawns } = applyDeps(fixture);
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const result = await call<{ code: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture),
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "stale");
    assert.equal(spawns.length, 0);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/apply：仅副实例时允许用 co-qubius 域名确认", async () => {
  const fixture = setupEdge({ secondaryOnly: true });
  const { deps, spawns } = applyDeps(fixture);
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const result = await call<{ ok: boolean; jobId: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      { planHash: fixture.plan.planHash, confirmDomain: "co.example.com" },
    );
    assert.equal(result.status, 202);
    assert.equal(spawns.length, 1);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/apply：requiresConfirmExisting 缺 confirmExisting → 409 conflict", async () => {
  const fixture = setupEdge({ requiresConfirmExisting: true });
  const { deps } = applyDeps(fixture);
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const result = await call<{ error: string; code: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture),
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "conflict");

    const ok = await call<{ ok: boolean }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture, { confirmExisting: true }),
    );
    assert.equal(ok.status, 202);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/apply：native 可接线并快速 202", async () => {
  const fixture = setupEdge({ provider: "native" });
  const { deps, spawns } = applyDeps(fixture);
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const result = await call<{ ok: boolean; jobId: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture),
    );
    assert.equal(result.status, 202);
    assert.equal(spawns.length, 1);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/apply：ops busy/residual 映射", async () => {
  const fixture = setupEdge();
  const busyDeps = applyDeps(fixture, {
    ops: ops({
      claim: () => ({ ok: false, code: "busy", reason: "pending" }),
      status: () => ({ ok: true, code: "ok", metaKind: "edge" }),
    }),
  });
  const harness = await startHarness(fixture.base, fixture.configDir, busyDeps.deps);
  try {
    const result = await call<{ error: string; code: string; kind?: string }>(
      harness,
      "POST",
      "/api/edge/apply",
      applyBody(fixture),
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "busy");
    assert.equal(result.data.kind, "edge");
    assert.equal(busyDeps.spawns.length, 0);
  } finally {
    await harness.close();
  }

  const fixture2 = setupEdge();
  const residualDeps = applyDeps(fixture2, {
    ops: ops({
      claim: () => ({ ok: false, code: "residual", remainingPids: [99] }),
    }),
  });
  const harness2 = await startHarness(fixture2.base, fixture2.configDir, residualDeps.deps);
  try {
    const result = await call<{ code: string; remainingPids: number[] }>(
      harness2,
      "POST",
      "/api/edge/apply",
      applyBody(fixture2),
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "residual");
    assert.deepEqual(result.data.remainingPids, [99]);
  } finally {
    await harness2.close();
  }

  // pending 宽限期内即使 ops-lock 报 residual，也应按 busy 处理（job 正在启动）。
  const fixture3 = setupEdge();
  const pendingResidual = applyDeps(fixture3, {
    ops: ops({
      claim: () => ({ ok: false, code: "residual", remainingPids: [7] }),
      status: () => ({
        ok: true,
        code: "ok",
        lockFree: true,
        metaStatus: "complete",
        metaState: "pending",
        metaKind: "apply",
        metaAgeSeconds: 1,
        remainingPids: [],
      }),
    }),
  });
  const harness3 = await startHarness(fixture3.base, fixture3.configDir, pendingResidual.deps);
  try {
    const result = await call<{ code: string; kind?: string }>(
      harness3,
      "POST",
      "/api/edge/apply",
      applyBody(fixture3),
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "busy");
    assert.equal(result.data.kind, "apply");
  } finally {
    await harness3.close();
  }
});

test("GET /api/edge/status：返回 edge 作业", async () => {
  const fixture = setupEdge();
  writeEdgeJob(fixture.configDir, {
    jobId: "job-9",
    state: "running",
    kind: "apply",
    step: "apply",
    message: "执行中",
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  });
  const harness = await startHarness(fixture.base, fixture.configDir, depsFor(fixture));
  try {
    const result = await call<{ job: { jobId: string; state: string } | null }>(
      harness,
      "GET",
      "/api/edge/status",
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.job?.jobId, "job-9");
    assert.equal(result.data.job?.state, "running");
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/restore：202 快速返回；未知备份 404；remoteSha 格式 400", async () => {
  const fixture = setupEdge();
  const backup = "edge-backup-old.Caddyfile";
  fs.writeFileSync(path.join(fixture.configDir, backup), fixture.oldRaw, { mode: 0o600 });
  const { deps, spawns } = applyDeps(fixture);
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const body = {
      backup,
      remoteSha: sha256Hex(fixture.oldRaw),
      confirmDomain: "code.example.com",
    };
    const unknown = await call<{ error: string }>(harness, "POST", "/api/edge/restore", {
      ...body,
      backup: "edge-backup-missing.Caddyfile",
    });
    assert.equal(unknown.status, 404);

    const badSha = await call<{ error: string }>(harness, "POST", "/api/edge/restore", {
      ...body,
      remoteSha: "deadbeef",
    });
    assert.equal(badSha.status, 400);

    const missingRemoteSha = await call<{ error: string }>(
      harness,
      "POST",
      "/api/edge/restore",
      { backup, confirmDomain: "code.example.com" },
    );
    assert.equal(missingRemoteSha.status, 400);

    // 远端 sha 校验在 detached job 内完成；HTTP 只做本地快速校验后 202。
    const ok = await call<{ ok: boolean; jobId: string }>(
      harness,
      "POST",
      "/api/edge/restore",
      body,
    );
    assert.equal(ok.status, 202);
    assert.equal(spawns.length, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(fixture.configDir, "edge-request.json"), "utf8"),
    ) as EdgeJobRequest;
    assert.equal(request.kind, "restore");
    assert.equal(request.backup, backup);
  } finally {
    await harness.close();
  }
});

test("GET /api/edge：注册表不存在时不泄露绝对路径", async () => {
  const fixture = setupEdge();
  fs.unlinkSync(fixture.registryPath);
  const harness = await startHarness(fixture.base, fixture.configDir, depsFor(fixture, {
    ops: ops({ status: () => ({ ok: true, code: "ok", lockFree: true, remainingPids: [] }) }),
  }));
  try {
    const result = await call<Record<string, any>>(harness, "GET", "/api/edge");
    assert.equal(result.status, 200);
    const body = JSON.stringify(result.data);
    assert.equal(body.includes(fixture.base), false);
    assert.match(body, /edgectl\.yaml|<configDir>/);
  } finally {
    await harness.close();
  }
});

test("status 归一化：running 但 pid 已死 / pid 为空且锁空闲 → failed", async () => {
  const fixture = setupEdge();
  writeEdgeJob(fixture.configDir, {
    jobId: "dead-pid",
    state: "running",
    kind: "apply",
    step: "apply",
    message: "执行中",
    pid: 2_000_000_000,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  });
  const harness = await startHarness(fixture.base, fixture.configDir, depsFor(fixture, {
    ops: ops({ status: () => ({ ok: true, code: "ok", lockFree: true, remainingPids: [] }) }),
  }));
  try {
    const result = await call<{ job: { state: string; message: string } | null }>(
      harness,
      "GET",
      "/api/edge/status",
    );
    assert.equal(result.data.job?.state, "failed");
    assert.match(result.data.job?.message ?? "", /中断/);
  } finally {
    await harness.close();
  }

  const fixture2 = setupEdge();
  writeEdgeJob(fixture2.configDir, {
    jobId: "no-pid",
    state: "running",
    kind: "apply",
    step: "prepare",
    message: "启动中",
    pid: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  });
  const harness2 = await startHarness(fixture2.base, fixture2.configDir, depsFor(fixture2, {
    ops: ops({ status: () => ({ ok: true, code: "ok", lockFree: true, remainingPids: [] }) }),
  }));
  try {
    const result = await call<{ job: { state: string; message: string } | null }>(
      harness2,
      "GET",
      "/api/edge/status",
    );
    assert.equal(result.data.job?.state, "failed");
    assert.match(result.data.job?.message ?? "", /未启动|中断/);
  } finally {
    await harness2.close();
  }
});

test("reclaim 后 GET/status 不泄露绝对路径，日志不写 root", async () => {
  const fixture = setupEdge();
  const deps = applyDeps(fixture, {
    ops: ops({
      cleanup: () => ({ ok: true, code: "ok" }),
      forceReclaim: () => ({ ok: true, code: "ok", forceReclaimed: true }),
    }),
  });
  await runEdgeJob(
    fixture.configDir,
    { version: 1, kind: "reclaim", jobId: "job-r", createdAt: "2026-01-02T00:00:00.000Z" },
    { repoRoot: fixture.base, env: fixture.env, configDir: fixture.configDir, paths: fixture.paths, ...deps.deps },
  );
  const harness = await startHarness(fixture.base, fixture.configDir, deps.deps);
  try {
    const status = await call<Record<string, any>>(harness, "GET", "/api/edge/status");
    const view = await call<Record<string, any>>(harness, "GET", "/api/edge");
    assert.equal(status.data.job?.kind, "reclaim");
    assert.equal(status.data.job?.state, "success");
    assert.equal(JSON.stringify(status.data).includes(fixture.base), false);
    assert.equal(JSON.stringify(view.data).includes(fixture.base), false);
    const log = fs.readFileSync(path.join(fixture.configDir, "edge.log"), "utf8");
    assert.equal(log.includes(fixture.base), false);
  } finally {
    await harness.close();
  }
});

test("POST /api/edge/reclaim：202 + spawn；活跃锁 409 busy；短语错误 400", async () => {
  const fixture = setupEdge();
  const { deps, spawns } = applyDeps(fixture, {
    ops: ops({
      status: () => ({ ok: true, code: "ok", lockFree: true, metaStatus: "missing" }),
    }),
  });
  const harness = await startHarness(fixture.base, fixture.configDir, deps);
  try {
    const result = await call<{ ok: boolean }>(harness, "POST", "/api/edge/reclaim", {
      confirm: "RECLAIM",
    });
    assert.equal(result.status, 202);
    assert.deepEqual(result.data, { ok: true });
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0]!.command, process.execPath);
    const request = JSON.parse(
      fs.readFileSync(path.join(fixture.configDir, "edge-request.json"), "utf8"),
    ) as EdgeJobRequest;
    assert.equal(request.kind, "reclaim");

    const bad = await call<{ error: string }>(harness, "POST", "/api/edge/reclaim", {
      confirm: "nope",
    });
    assert.equal(bad.status, 400);
  } finally {
    await harness.close();
  }

  const fixture2 = setupEdge();
  const busyDeps = applyDeps(fixture2, {
    ops: ops({
      status: () => ({ ok: true, code: "ok", lockFree: false, metaKind: "apply" }),
    }),
  });
  const harness2 = await startHarness(fixture2.base, fixture2.configDir, busyDeps.deps);
  try {
    const result = await call<{ code: string; kind?: string }>(
      harness2,
      "POST",
      "/api/edge/reclaim",
      { confirm: "RECLAIM" },
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "busy");
    assert.equal(result.data.kind, "apply");
  } finally {
    await harness2.close();
  }

  // pending claim（flock 已释放）也必须视为 busy，避免覆盖 apply/restore 请求。
  const fixture3 = setupEdge();
  const pendingDeps = applyDeps(fixture3, {
    ops: ops({
      status: () => ({
        ok: true,
        code: "ok",
        lockFree: true,
        metaStatus: "complete",
        metaState: "pending",
        metaKind: "apply",
        metaAgeSeconds: 1,
      }),
    }),
  });
  const harness3 = await startHarness(fixture3.base, fixture3.configDir, pendingDeps.deps);
  try {
    const result = await call<{ code: string; kind?: string }>(
      harness3,
      "POST",
      "/api/edge/reclaim",
      { confirm: "RECLAIM" },
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "busy");
    assert.equal(result.data.kind, "apply");
    assert.equal(pendingDeps.spawns.length, 0);
  } finally {
    await harness3.close();
  }
});
