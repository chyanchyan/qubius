import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandRunner } from "./cli.js";
import { resolveEdgeEnv } from "./envfile.js";
import {
  buildPlan,
  deletePlan,
  edgeEnvSnapshot,
  edgePlanFile,
  readPlan,
  verifyPlan,
  type BuildPlanOptions,
  type StoredEdgePlan,
} from "./plan.js";
import { nativeProvider } from "./provider.js";
import { readRegistry } from "./registry.js";
import { renderVpsBlock } from "./render.js";
import { loadEdgeSecrets } from "./secrets.js";
import { type EdgePaths, type EdgeRegistry, type EdgeSecrets } from "./types.js";

const HASH = "$2a$14$FakeSaltValue123456789FakeHashValue1234567890ABCDEFGH";
const COOKIE = "fedcba9876543210fedcba9876543210";

const REGISTRY_TEXT = [
  "version: 1",
  "edge:",
  "  vps:",
  "    ssh: ubuntu@example.test",
  "    caddyfile: /opt/example/Caddyfile",
  "sites:",
  "  - name: app",
  "    domains: [app.example.com]",
  "    env: prod",
  "    upstream: http://127.0.0.1:9000",
  "    auth: none",
  "    sse: true",
  "",
].join("\n");

interface Fixture {
  dir: string;
  env: NodeJS.ProcessEnv;
  paths: EdgePaths;
  registry: EdgeRegistry;
  secrets: EdgeSecrets;
  remote: string;
}

function makeFixture(withSecrets = true): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-plan-"));
  const registryPath = path.join(dir, "edgectl.yaml");
  fs.writeFileSync(registryPath, REGISTRY_TEXT);
  if (withSecrets) {
    fs.writeFileSync(
      path.join(dir, ".env"),
      `EDGECTL_DEV_PASSWORD_HASH=${HASH}\nEDGECTL_DEV_COOKIE_SECRET=${COOKIE}\n`,
    );
  }
  const env: NodeJS.ProcessEnv = {
    HOME: os.tmpdir(),
    QUBIUS_CONFIG_DIR: dir,
    QUBIUS_EDGECTL_CONFIG: registryPath,
    QUBIUS_EDGE_PROVIDER: "native",
    QUBIUS_PUBLIC_HOST: "qubius.example.com",
    QUBIUS_START_PRIMARY: "1",
    QUBIUS_START_SECONDARY: "0",
    QUBIUS_PRIMARY_PORT: "8789",
    QUBIUS_SECONDARY_PORT: "8790",
  };
  const paths = resolveEdgeEnv(env);
  const registry = readRegistry(registryPath);
  const secrets = withSecrets
    ? loadEdgeSecrets({ registry, env })
    : ({} as EdgeSecrets);
  return {
    dir,
    env,
    paths,
    registry,
    secrets,
    remote: renderVpsBlock(registry, secrets),
  };
}

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const FIXED_ID = "plan-fixed-id";

function buildFixturePlan(
  fixture: Fixture,
  overrides: Partial<BuildPlanOptions> = {},
): Promise<StoredEdgePlan> {
  return buildPlan(
    { role: "primary" },
    {
      env: fixture.env,
      paths: fixture.paths,
      registry: fixture.registry,
      registryText: REGISTRY_TEXT,
      secrets: fixture.secrets,
      provider: nativeProvider,
      configDir: fixture.dir,
      persist: false,
      now: FIXED_NOW,
      planId: FIXED_ID,
      remoteContent: fixture.remote,
      ...overrides,
    },
  );
}

test("planHash 稳定；env 变化会改变 hash", async () => {
  const fixture = makeFixture();
  const first = await buildFixturePlan(fixture);
  const second = await buildFixturePlan(fixture);
  assert.equal(first.planHash, second.planHash);

  const changed = await buildFixturePlan(fixture, {
    env: { ...fixture.env, QUBIUS_PUBLIC_HOST: "other.example.com" },
  });
  assert.notEqual(first.planHash, changed.planHash);

  const caddy = await buildFixturePlan(fixture, { caddyVersion: "2.8.1" });
  assert.notEqual(first.planHash, caddy.planHash);
});

test("desired 只生成启用的角色并带停用 warning", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture);
  assert.deepEqual(plan.desired.map((site) => site.name), ["qubius"]);
  assert.ok(plan.warnings.some((value) => value.includes("副实例未启用")));
  assert.deepEqual(plan.disabledRoles, ["secondary"]);
  assert.equal(plan.appliable, true);
});

test("通配域名（TLS/DNS-01）只产生 warning，不生成 desired", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture, {
    env: { ...fixture.env, QUBIUS_PUBLIC_HOST: "*.example.com" },
  });
  assert.equal(plan.desired.length, 0);
  assert.ok(plan.warnings.some((value) => value.includes("通配")));
});

test("envSnapshot 覆盖 edge 相关键", async () => {
  const fixture = makeFixture();
  const snapshot = edgeEnvSnapshot(fixture.env, "primary");
  assert.equal(snapshot.deployConfigDir, fixture.dir);
  assert.equal(snapshot.configDir, fixture.dir);
  assert.equal(snapshot.publicHost, "qubius.example.com");
  assert.equal(snapshot.publicHostSecondary, "");
  assert.equal(snapshot.primaryPort, "8789");
  assert.equal(snapshot.secondaryPort, "8790");
  assert.equal(snapshot.startPrimary, "1");
  assert.equal(snapshot.startSecondary, "0");
  assert.equal(snapshot.edgectlConfig, fixture.registry.source);
  assert.equal(snapshot.edgectlBin, "");
  assert.equal(snapshot.edgeProvider, "native");
  assert.equal(snapshot.resolvedProvider, "native");
  assert.equal(snapshot.role, "primary");
});

test("configDir/env 缺失时 plan 读取 repo/deploy/env，与 view 快照一致", async () => {
  const fixture = makeFixture();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "edge-plan-repo-"));
  fs.mkdirSync(path.join(repoRoot, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "deploy", "env"), [
    "QUBIUS_PUBLIC_HOST=repo.example.com",
    "QUBIUS_START_PRIMARY=1",
    "QUBIUS_PRIMARY_PORT=8999",
    "",
  ].join("\n"));

  // 去掉进程 env 里的同名键，确保这些值只能来自 repo/deploy/env。
  const env = { ...fixture.env };
  delete env.QUBIUS_PUBLIC_HOST;
  delete env.QUBIUS_PRIMARY_PORT;

  const plan = await buildFixturePlan(fixture, { env, repoRoot });
  assert.deepEqual(plan.desired.map((site) => site.domains), [["repo.example.com"]]);
  assert.equal(plan.desired[0]?.upstream, "http://127.0.0.1:8999");

  // edge view / stale 复检用的快照必须与 plan 完全一致。
  const snapshot = edgeEnvSnapshot(env, "primary", repoRoot);
  assert.deepEqual(snapshot, plan.envSnapshot);
  assert.equal(snapshot.publicHost, "repo.example.com");

  const withRepoRoot = verifyPlan(plan, {
    env,
    repoRoot,
    registryText: REGISTRY_TEXT,
    secrets: fixture.secrets,
    remoteRawSha: plan.remoteRawSha,
    caddyVersion: plan.caddyVersion,
  });
  assert.equal(withRepoRoot.stale.some((reason) => reason.code === "env-changed"), false);

  // 不传 repoRoot 会落到另一份 env，说明透传是必要的。
  const withoutRepoRoot = verifyPlan(plan, {
    env,
    registryText: REGISTRY_TEXT,
    secrets: fixture.secrets,
    remoteRawSha: plan.remoteRawSha,
    caddyVersion: plan.caddyVersion,
  });
  assert.equal(withoutRepoRoot.stale.some((reason) => reason.code === "env-changed"), true);
});

test("计划文件 0600 原子写且不含明文 secrets", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture, { persist: true });
  const file = edgePlanFile(fixture.dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(HASH));
  assert.ok(!text.includes(COOKIE));
  assert.ok(text.includes("<redacted>"));
  // diff / 期望内容不带 VPS 用户或 IP（candidateBytes 是注册表原文，允许保留）。
  assert.ok(!/ubuntu@|203\.0\.113/.test(plan.remoteDiff));
  assert.ok(!/ubuntu@|203\.0\.113/.test(plan.registryDiff));
  assert.ok(!/ubuntu@|203\.0\.113/.test(plan.expectedRemoteContent));

  const loaded = readPlan(fixture.dir);
  assert.ok(loaded);
  assert.equal(loaded!.planHash, plan.planHash);
  assert.equal(loaded!.candidateBytes, plan.candidateBytes);
});

test("readPlan 不存在/损坏返回 null；deletePlan 不报错", () => {
  const fixture = makeFixture();
  assert.equal(readPlan(fixture.dir), null);
  fs.writeFileSync(edgePlanFile(fixture.dir), "{not json");
  assert.equal(readPlan(fixture.dir), null);
  fs.writeFileSync(edgePlanFile(fixture.dir), JSON.stringify({ planHash: 1 }));
  assert.equal(readPlan(fixture.dir), null);
  fs.writeFileSync(edgePlanFile(fixture.dir), "{}");
  deletePlan(fixture.dir);
  assert.equal(fs.existsSync(edgePlanFile(fixture.dir)), false);
  deletePlan(fixture.dir); // 幂等
});

test("verifyPlan：纯内存校验 hash/provider/版本/候选内容", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture);
  assert.deepEqual(verifyPlan(plan, { recheck: false }), { ok: true, stale: [] });

  const codes = (value: StoredEdgePlan, options = {}) =>
    verifyPlan(value, { recheck: false, ...options }).stale.map((item) => item.code);

  assert.ok(codes({ ...plan, planHash: "deadbeef" }).includes("hash-mismatch"));
  assert.ok(codes(plan, { planHash: "other" }).includes("plan-mismatch"));
  assert.ok(codes(plan, { provider: "cli" }).includes("provider-mismatch"));
  assert.ok(
    codes(plan, { nativeRenderVersion: "999" }).includes("version-mismatch"),
  );
  assert.ok(codes({ ...plan, candidateBytes: "changed" }).includes("candidate-changed"));
  assert.ok(
    codes(plan, { edgectl: { bin: "/x", version: "9", source: "env" } }).includes(
      "edgectl-changed",
    ),
  );
});

test("caddyVersion 纳入 plan 快照并参与 recheck", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture, { caddyVersion: "2.8.1" });
  assert.equal(plan.caddyVersion, "2.8.1");
  const base = {
    env: fixture.env,
    secrets: fixture.secrets,
    registryText: REGISTRY_TEXT,
    remoteRawSha: plan.remoteRawSha,
  };
  assert.ok(
    verifyPlan(plan, base).stale.some((item) => item.code === "caddy-unchecked"),
  );
  assert.ok(
    verifyPlan(plan, { ...base, caddyVersion: "2.7.6" }).stale.some(
      (item) => item.code === "caddy-version-changed",
    ),
  );
  assert.deepEqual(verifyPlan(plan, { ...base, caddyVersion: "2.8.1" }), {
    ok: true,
    stale: [],
  });
});

test("verifyPlan recheck 默认开启；缺 remoteRawSha 判 stale", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture);
  const base = {
    env: fixture.env,
    secrets: fixture.secrets,
    registryText: REGISTRY_TEXT,
  };
  const unchecked = verifyPlan(plan, base);
  assert.equal(unchecked.ok, false);
  assert.ok(unchecked.stale.some((item) => item.code === "remote-unchecked"));

  assert.deepEqual(
    verifyPlan(plan, { ...base, remoteRawSha: plan.remoteRawSha }),
    { ok: true, stale: [] },
  );
});

test("verifyPlan recheck：注册表/env/密钥/远端变化分别报告", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture);
  const codes = (options: Parameters<typeof verifyPlan>[1]) =>
    verifyPlan(plan, options).stale.map((item) => item.code);

  assert.ok(
    codes({
      recheck: true,
      env: fixture.env,
      secrets: fixture.secrets,
      registryText: `${REGISTRY_TEXT}# changed\n`,
    }).includes("registry-changed"),
  );
  assert.ok(
    codes({
      recheck: true,
      env: { ...fixture.env, QUBIUS_PUBLIC_HOST: "other.example.com" },
      secrets: fixture.secrets,
      registryText: REGISTRY_TEXT,
    }).includes("env-changed"),
  );
  assert.ok(
    codes({
      recheck: true,
      env: fixture.env,
      secrets: { ...fixture.secrets, secretsSha: "different" },
      registryText: REGISTRY_TEXT,
    }).includes("secrets-changed"),
  );
  assert.ok(
    codes({
      recheck: true,
      env: fixture.env,
      secrets: fixture.secrets,
      registryText: REGISTRY_TEXT,
      remoteRawSha: "different",
    }).includes("remote-changed"),
  );
});

test("远端不可用：计划不可应用且错误脱敏", async () => {
  const fixture = makeFixture();
  const throwing: CommandRunner = () => {
    throw new Error("ssh https://user:pw@vps failed");
  };
  const plan = await buildFixturePlan(fixture, {
    remoteContent: undefined,
    runner: throwing,
  });
  assert.equal(plan.appliable, false);
  assert.ok(plan.remoteUnavailable);
  assert.ok(!plan.remoteUnavailable!.includes("user:pw"));
  assert.equal(plan.remoteRawSha, null);
});

test("缺少 secrets 降级：不可应用，但 warnings 给出原因", async () => {
  const fixture = makeFixture(false);
  const plan = await buildPlan(
    { role: "primary" },
    {
      env: { ...fixture.env },
      paths: fixture.paths,
      registry: fixture.registry,
      registryText: REGISTRY_TEXT,
      provider: nativeProvider,
      persist: false,
      remoteContent: "",
    },
  );
  assert.equal(plan.appliable, false);
  assert.ok(plan.blocking.includes("secrets-missing"));
  assert.equal(plan.errors.length, 0);
  assert.ok(plan.warnings.some((value) => value.includes("缺少 dev 认证密钥")));
  assert.ok(plan.warnings.some((value) => value.includes("阻断：secrets-missing")));
});

test("非 owned 变化只要求 confirmExisting，不置 appliable=false", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture, {
    remoteContent: renderVpsBlock({ ...fixture.registry, sites: [] }, fixture.secrets),
  });
  assert.equal(plan.requiresConfirmExisting, true);
  assert.ok(plan.blocking.includes("non-owned-changed"));
  assert.equal(plan.appliable, true);
  assert.ok(plan.warnings.some((value) => value.includes("阻断：non-owned-changed")));
});

test("errors/blocking 汇总进 warnings（带前缀）", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture, {
    remoteContent: `qubius.example.com {\n\trespond "conflict"\n}\n`,
  });
  assert.ok(plan.errors.length > 0);
  assert.equal(plan.appliable, false);
  assert.ok(plan.warnings.some((value) => value.startsWith("错误：")));
  assert.ok(plan.warnings.some((value) => value.startsWith("阻断：")));
});

test("远端 diff 头部为通用标签", async () => {
  const fixture = makeFixture();
  const plan = await buildFixturePlan(fixture);
  assert.ok(plan.remoteDiff.startsWith("--- 远端 Caddyfile\n+++ 候选 Caddyfile\n"));
  assert.ok(!plan.remoteDiff.includes("ubuntu@"));
});
